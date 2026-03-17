/**
 * Outdoors — Electron Main Process
 *
 * Thin shell that:
 * 1. Copies bundled project to writable userData on first run
 * 2. Shows setup wizard (install deps → Claude auth → Browser + Telegram)
 * 3. Spawns backend as child process
 * 4. Lives in system tray
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync, execFile } = require('child_process');

// ── Dev vs Prod ──────────────────────────────────────────────────────────────

const IS_DEV = !app.isPackaged;

// ── Paths ────────────────────────────────────────────────────────────────────

const WORKSPACE = path.join(app.getPath('userData'), 'workspace');
const BACKEND_DIR = IS_DEV
  ? path.join(__dirname, '..')
  : path.join(WORKSPACE, 'outdoorsv1', 'backend');
const SETUP_DIR = IS_DEV
  ? path.join(__dirname, '..', 'src', 'setup')
  : path.join(WORKSPACE, 'outdoorsv1', 'backend', 'src', 'setup');
const CONFIG_PATH = path.join(BACKEND_DIR, 'config.json');
const SETUP_DONE_FLAG = path.join(app.getPath('userData'), '.setup-complete');
const ICON_PATH = IS_DEV
  ? path.join(__dirname, '..', 'src', 'setup', 'icon.png')
  : path.join(process.resourcesPath, 'project', 'src', 'setup', 'icon.png');

let mainWindow = null;
let tray = null;
let backendProcess = null;
let devLogWindow = null;
let authPollTimer = null; // track auth polling so we can cancel on skip

// Read the signed-in email from Chrome AutomationProfile Preferences
function getAutomationProfileEmail() {
  try {
    const prefsPath = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile', 'Default', 'Preferences');
    if (!fs.existsSync(prefsPath)) return null;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    const accounts = prefs.account_info || [];
    if (accounts.length > 0) return accounts[0].email || null;
  } catch {}
  return null;
}

// Get the user's Google email — first from config, then from AutomationProfile
function getUserGoogleEmail() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.googleEmail) return cfg.googleEmail;
    }
  } catch {}
  return getAutomationProfileEmail();
}
let backendRestarts = 0;
const MAX_BACKEND_RESTARTS = 5;
let resolvedClaudeCmd = 'claude'; // updated after install or PATH lookup

// Resolve the claude command — caches after first successful lookup
function getClaudeCmd() {
  // Already resolved to a full path — use cached value
  if (resolvedClaudeCmd !== 'claude') return resolvedClaudeCmd;
  // Check config for saved path
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.claudeCommand && cfg.claudeCommand !== 'claude') {
        resolvedClaudeCmd = cfg.claudeCommand;
        return resolvedClaudeCmd;
      }
    }
  } catch {}
  // PATH lookup — only runs once, then cached
  try {
    const findCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const found = execSync(findCmd, { encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true }).trim();
    if (found) {
      const candidates = found.split('\n').map(l => l.trim()).filter(Boolean);
      // On Windows, prefer .cmd over POSIX shell script
      if (process.platform === 'win32') {
        const cmdVersion = candidates.find(c => c.endsWith('.cmd'));
        resolvedClaudeCmd = cmdVersion || candidates[0];
      } else {
        resolvedClaudeCmd = candidates[0];
      }
      return resolvedClaudeCmd;
    }
  } catch {}
  return 'claude';
}

// ── First-Run: Copy Project to Writable Location ────────────────────────────

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    // Skip files that shouldn't be copied
    if (entry.name === 'node_modules' || entry.name === 'auth_state' ||
        entry.name === '.env' || entry.name === 'electron' || entry.name === 'dist') {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function ensureWorkspace() {
  if (IS_DEV) return false;

  const backendIndex = path.join(WORKSPACE, 'outdoorsv1', 'backend', 'src', 'index.js');
  const v4Index = path.join(WORKSPACE, 'outdoorsv4', 'index.js');
  const versionFile = path.join(WORKSPACE, '.app-version');

  const currentVersion = app.getVersion();
  let installedVersion = '';
  try { installedVersion = fs.readFileSync(versionFile, 'utf-8').trim(); } catch {}

  const workspaceExists = fs.existsSync(backendIndex) && fs.existsSync(v4Index);
  const versionMatch = installedVersion === currentVersion;

  if (workspaceExists && versionMatch) return false;

  const isFirstRun = !workspaceExists;
  const destBackend = path.join(WORKSPACE, 'outdoorsv1', 'backend');

  // On update: back up user data, wipe workspace, copy fresh from bundle, restore user data
  // On first run: just copy fresh from bundle
  if (!isFirstRun) {
    console.log(`[workspace] Version mismatch: ${installedVersion || 'unknown'} → ${currentVersion}. Clean reinstall.`);

    // Back up user data to temp dir
    const tmpDir = path.join(app.getPath('temp'), 'outdoors-upgrade-backup');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(tmpDir, { recursive: true });

    // Files to preserve
    const keepFiles = ['config.json', '.env', '.claude.json', 'oauth-creds.json'];
    for (const file of keepFiles) {
      const src = path.join(destBackend, file);
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, path.join(tmpDir, file)); } catch {}
      }
    }

    // Directories to preserve
    const keepDirs = ['auth_state', 'bot/memory', 'bot/logs', 'bot/outputs'];
    for (const dir of keepDirs) {
      const src = path.join(destBackend, dir);
      if (fs.existsSync(src)) {
        try { copyDirSync(src, path.join(tmpDir, dir)); } catch {}
      }
    }

    // Wipe workspace
    try { fs.rmSync(WORKSPACE, { recursive: true, force: true }); } catch {}

    // Fresh copy from bundle
    try {
      const bundledProject = path.join(process.resourcesPath, 'project');
      if (fs.existsSync(bundledProject)) copyDirSync(bundledProject, destBackend);

      const bundledV4 = path.join(process.resourcesPath, 'outdoorsv4');
      if (fs.existsSync(bundledV4)) copyDirSync(bundledV4, path.join(WORKSPACE, 'outdoorsv4'));
    } catch (err) {
      console.error('[workspace] Copy failed:', err);
    }

    // Restore user data
    try {
      const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
      for (const entry of entries) {
        const src = path.join(tmpDir, entry.name);
        const dest = path.join(destBackend, entry.name);
        if (entry.isDirectory()) copyDirSync(src, dest);
        else fs.copyFileSync(src, dest);
      }
    } catch (err) {
      console.error('[workspace] Restore failed:', err);
    }

    // Clean up temp backup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    // Remove setup-done flag so wizard re-runs (npm install needed after wipe)
    try { fs.unlinkSync(SETUP_DONE_FLAG); } catch {}
  } else {
    // First run — fresh copy from bundle
    try {
      const bundledProject = path.join(process.resourcesPath, 'project');
      if (fs.existsSync(bundledProject)) copyDirSync(bundledProject, destBackend);

      const bundledV4 = path.join(process.resourcesPath, 'outdoorsv4');
      if (fs.existsSync(bundledV4)) copyDirSync(bundledV4, path.join(WORKSPACE, 'outdoorsv4'));
    } catch (err) {
      console.error('[workspace] Copy failed:', err);
    }
  }

  // Ensure required directories exist
  const emptyDirs = ['bot/logs', 'bot/outputs', 'bot/message-queue', 'bot/memory/short-term'];
  for (const dir of emptyDirs) {
    try { fs.mkdirSync(path.join(BACKEND_DIR, dir), { recursive: true }); } catch {}
  }

  // Write version file
  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.writeFileSync(versionFile, currentVersion);
  } catch {}

  return true;
}

// ── Setup Wizard Window ─────────────────────────────────────────────────────

function createSetupWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 680,
    resizable: false,
    maximizable: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#FAF6F1',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const setupHtml = path.join(SETUP_DIR, 'index.html');

  mainWindow.loadFile(setupHtml);

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

function setupIPC() {
  // Install Node dependencies in workspace
  ipcMain.handle('install-node-deps', async () => {
    // Verify package.json exists first
    const pkgJson = path.join(BACKEND_DIR, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      return { ok: false, output: 'package.json not found at ' + pkgJson };
    }
    return new Promise((resolve) => {
      const npm = spawn('npm', ['install'], {
        cwd: BACKEND_DIR,
        shell: true,
        env: { ...process.env, ELECTRON: '1' },
      });
      let output = '';
      npm.stdout.on('data', (d) => { output += d.toString(); });
      npm.stderr.on('data', (d) => { output += d.toString(); });
      npm.on('close', (code) => {
        resolve({ ok: code === 0, output });
      });
    });
  });

  // Install Claude CLI
  ipcMain.handle('install-claude-cli', async () => {
    return new Promise((resolve) => {
      const proc = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
        shell: true,
        env: process.env,
      });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => {
        // After install, find the claude command path
        let claudePath = 'claude';
        try {
          const whichCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
          const which = execSync(whichCmd, { encoding: 'utf-8', shell: true }).trim();
          if (which) claudePath = which.split('\n')[0].trim();
        } catch {}

        // Write to config
        try {
          let cfg = {};
          if (fs.existsSync(CONFIG_PATH)) {
            cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
          }
          cfg.claudeCommand = claudePath;
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        } catch {}

        resolvedClaudeCmd = claudePath;
        resolve({ ok: code === 0, output, claudePath });
      });
    });
  });

  // Check if Claude CLI is installed
  ipcMain.handle('check-claude-installed', async () => {
    try {
      const cmd = getClaudeCmd();
      const version = execSync(`"${cmd}" --version`, { encoding: 'utf-8', shell: true, timeout: 10000, windowsHide: true }).trim();
      resolvedClaudeCmd = cmd;
      return { installed: true, version };
    } catch {
      return { installed: false };
    }
  });

  // Check Claude auth status
  ipcMain.handle('check-claude-auth', async () => {
    const cmd = getClaudeCmd();
    return new Promise((resolve) => {
      execFile(cmd, ['auth', 'status'], { shell: true, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        const authed = !err && (output.includes('"loggedIn": true') || output.includes('"loggedIn":true'));
        resolve({ authenticated: authed, output });
      });
    });
  });

  // Start Claude auth — spawns claude /login which opens browser for OAuth
  ipcMain.handle('start-claude-auth', async () => {
    const cmd = getClaudeCmd();
    return new Promise((resolve) => {
      // Open claude /login in a visible terminal — user needs to press 1
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/k', 'claude', '/login'], {
          detached: true,
          stdio: 'inherit',
        }).unref();
      } else {
        spawn('open', ['-a', 'Terminal', '--args', 'claude', '/login'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      }

      // Poll auth status every 3s until authenticated or timeout
      authPollTimer = setInterval(() => {
        try {
          execFile(cmd, ['auth', 'status'], { shell: true, timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
            const out = (stdout || '') + (stderr || '');
            if (!err && (out.includes('"loggedIn": true') || out.includes('"loggedIn":true'))) {
              clearInterval(authPollTimer);
              authPollTimer = null;
              resolve({ ok: true, output: 'Authenticated.' });
            }
          });
        } catch {}
      }, 3000);

      // Timeout after 3 minutes
      setTimeout(() => {
        if (authPollTimer) {
          clearInterval(authPollTimer);
          authPollTimer = null;
        }
        resolve({ ok: false, output: 'Timed out waiting for auth.' });
      }, 180000);
    });
  });

  // Cancel auth polling (called when user skips)
  ipcMain.handle('cancel-auth-poll', () => {
    if (authPollTimer) {
      clearInterval(authPollTimer);
      authPollTimer = null;
    }
  });

  // ── Browser Setup (multi-step) ───────────────────────────────────────────

  // Step 1: Detect Chrome and list profiles
  ipcMain.handle('detect-browser', async () => {
    try {
      const CHROME_PATHS = [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];

      const exePath = CHROME_PATHS.find(p => {
        try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
      });

      if (!exePath) return { found: false, profiles: [] };

      // Read profiles from Local State
      const userDataDir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
      const localStatePath = path.join(userDataDir, 'Local State');
      let profiles = [];

      if (fs.existsSync(localStatePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
          const infoCache = data?.profile?.info_cache;
          if (infoCache && typeof infoCache === 'object') {
            profiles = Object.entries(infoCache).map(([directory, info]) => ({
              directory,
              name: info.gaia_name || info.name || directory,
              email: info.user_name || '',
            })).sort((a, b) => {
              if (a.directory === 'Default') return -1;
              if (b.directory === 'Default') return 1;
              return a.directory.localeCompare(b.directory, undefined, { numeric: true });
            });
          }
        } catch (err) {
          console.error('[browser-setup] Failed to read Local State:', err.message);
        }
      }

      return { found: true, exePath, profiles };
    } catch (err) {
      return { found: false, error: err.message, profiles: [] };
    }
  });

  // Step 2: Create automation profile from selected Chrome profile
  ipcMain.handle('create-automation-profile', async (_event, { selectedProfile, exePath }) => {
    try {
      const userDataDir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
      const automationDir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile');
      const srcDir = path.join(userDataDir, selectedProfile);
      const destDir = path.join(automationDir, 'Default');

      fs.mkdirSync(destDir, { recursive: true });
      fs.mkdirSync(path.join(destDir, 'Network'), { recursive: true });

      const PROFILE_FILES = [
        ['Network', 'Cookies'], ['Network', 'Cookies-journal'],
        ['Login Data'], ['Login Data For Account'], ['Web Data'],
        ['Preferences'], ['Secure Preferences'], ['Bookmarks'], ['History'],
      ];

      let copied = 0, failed = 0;
      for (const fileParts of PROFILE_FILES) {
        const srcPath = path.join(srcDir, ...fileParts);
        const destPath = path.join(destDir, ...fileParts);
        try {
          if (fs.existsSync(srcPath)) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(srcPath, destPath);
            copied++;
          }
        } catch { failed++; }
      }

      // Read all profiles for the preferences file
      const localStatePath = path.join(userDataDir, 'Local State');
      let allProfiles = [];
      let selectedInfo = null;
      if (fs.existsSync(localStatePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
          const infoCache = data?.profile?.info_cache || {};
          allProfiles = Object.entries(infoCache).map(([dir, info]) => ({
            directory: dir, name: info.gaia_name || info.name || dir, email: info.user_name || '',
          }));
          selectedInfo = infoCache[selectedProfile];
        } catch {}
      }

      // Write minimal Local State for AutomationProfile
      fs.writeFileSync(path.join(automationDir, 'Local State'), JSON.stringify({
        profile: { info_cache: { Default: selectedInfo || { name: 'Default' } }, profiles_order: ['Default'] },
      }, null, 2));

      // Generate full browser-preferences.md
      const seededEmail = selectedInfo?.user_name || 'unknown';
      const today = new Date().toISOString().split('T')[0];
      const profileRows = allProfiles.map(p => {
        const useFor = p.email ? (p.directory === 'Default' ? 'Personal' : p.name || p.directory) : p.directory;
        return `| ${p.directory} | ${p.email || 'No account'} | ${useFor} |`;
      }).join('\n');

      const prefsContent = `# Browser Preferences

## Browser Selection
The user's preferred browser is stored here. Outdoors does not hardcode any browser. Always use whichever browser the user has configured.

- **Preferred Browser**: Google Chrome
- **Executable Path**: \`${exePath}\`
- **CDP Port**: 9222
- **User Data Directory**: \`${automationDir}\`
- **Active Profile Directory**: \`Default\`


## Chrome 136+ CDP Limitation (IMPORTANT)
Chrome 136+ silently ignores \`--remote-debugging-port\` when using the **default user data directory**
(\`AppData\\Local\\Google\\Chrome\\User Data\`). This is a deliberate Google security change, not a bug.

**The fix**: Use a separate user data directory (\`AutomationProfile\`) dedicated to automation.
Copy the session-critical files from the Default profile once, sign into accounts in this profile,
and CDP works permanently from then on.

**Files to copy from Default profile to AutomationProfile/Default on setup:**
- \`Network/Cookies\` — login sessions
- \`Login Data\`, \`Login Data For Account\` — saved passwords
- \`Web Data\` — autofill, etc.
- \`Preferences\`, \`Secure Preferences\` — settings
- \`Bookmarks\`, \`History\`
- \`../Local State\` (one level up, in User Data root) — account list

**This machine's automation profile**: \`${automationDir}\`
Seeded from **${selectedProfile}** (${seededEmail}) on ${today}. Single profile only — no other profiles in Local State.
If sessions expire, re-copy the files above or manually sign in by launching Chrome with:
\`\`\`
chrome.exe --remote-debugging-port=9222 --user-data-dir="${automationDir}"
\`\`\`

## MCP Selection (Browser-Dependent)

| Browser | MCP Used | Tools | How it connects |
|---------|----------|-------|-----------------|
| **Google Chrome** | \`chrome-devtools-mcp\` (\`--browserUrl\`) | \`mcp__chrome__*\` | Connects via \`--browserUrl http://127.0.0.1:9222\` to AutomationProfile Chrome running on CDP port 9222. |
| **Edge / Brave / Other** | \`@playwright/mcp\` via CDP | \`mcp__playwright__*\` | Requires browser running with \`--remote-debugging-port=9222 --user-data-dir=<separate dir>\` |

**Current machine**: Preferred browser = **Google Chrome** → use \`mcp__chrome__*\` tools.

## Chrome Profiles (this machine)
| Directory | Email | Use for |
|-----------|-------|---------|
${profileRows}

**AutomationProfile** was seeded from **${selectedProfile} (${seededEmail})**.
- The automation browser has the ${seededEmail} account's saved data.
- Other accounts may need to be added manually in the AutomationProfile browser.
- If sessions expire, re-copy files or sign in manually using the launch command above.

## Auto-Launch (browser-health.js)
On startup, Outdoors checks if CDP is reachable on port 9222. If not, it auto-launches Chrome with:
- \`--remote-debugging-port=9222\`
- \`--user-data-dir=AutomationProfile\` (the separate dir — NOT the default)
- \`--profile-directory=Default\`

## How to Use
- Call \`mcp__chrome__navigate_page\` etc. — they connect to the AutomationProfile Chrome via CDP (port 9222)
- The user is signed into their accounts in AutomationProfile
- **Do NOT use \`chromium.launch()\`** — always connect via CDP to preserve sessions
- **NEVER kill and relaunch Chrome** unless you relaunch with the correct \`--user-data-dir\`

## MCP Server Configuration (.claude.json)

\`\`\`json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222", "--no-isolated", "--timeout-navigation", "10000", "--timeout-action", "5000"]
    }
  }
}
\`\`\`
`;

      const prefsDir = path.join(BACKEND_DIR, 'bot', 'memory', 'preferences');
      fs.mkdirSync(prefsDir, { recursive: true });
      fs.writeFileSync(path.join(prefsDir, 'browser-preferences.md'), prefsContent, 'utf-8');

      // Write .claude.json with MCP config
      writeMcpConfig('chrome', { mcpName: 'chrome', mcpArgs: ['chrome-devtools-mcp@latest', '--browserUrl', 'http://127.0.0.1:9222'] });

      return { ok: true, copied, failed, automationDir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Step 3: Launch Chrome with AutomationProfile on sign-in page
  ipcMain.handle('launch-automation-chrome', async (_event, exePath) => {
    try {
      const automationDir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile');
      const cdpPort = 9222;

      const args = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${automationDir}`,
        `--profile-directory=Default`,
        `--no-first-run`,
        `--no-default-browser-check`,
        `--disable-extensions-except=`,
        `--disable-background-extensions`,
        `https://accounts.google.com/`,
      ].join("','");
      const script = `Start-Process '${exePath}' -ArgumentList '${args}'`;
      execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000 }, () => {});

      // Wait for CDP to become reachable
      const http = require('http');
      await new Promise((resolve, reject) => {
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          const req = http.get(`http://localhost:${cdpPort}/json/version`, { timeout: 2000 }, (res) => {
            if (res.statusCode === 200) { clearInterval(interval); resolve(); }
            res.resume();
          });
          req.on('error', () => {});
          req.on('timeout', () => req.destroy());
          if (attempts >= 30) { clearInterval(interval); reject(new Error('CDP did not become reachable')); }
        }, 500);
      });

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Step 4: Check if user signed into AutomationProfile Chrome
  // Uses CDP to check page URLs. Sign-in is complete when the first tab
  // (which we launched on accounts.google.com) navigates to myaccount.google.com
  // or any non-sign-in page. This correctly waits for 2FA to complete.
  ipcMain.handle('check-browser-auth', async () => {
    try {
      const http = require('http');
      const pages = await new Promise((resolve) => {
        http.get('http://localhost:9222/json/list', { timeout: 3000 }, (res) => {
          let data = '';
          res.on('data', (d) => { data += d; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });

      if (pages.length === 0) return { signedIn: false, email: null };

      // Sign-in is complete when any page lands on myaccount.google.com
      // or when NO pages are on accounts.google.com anymore (user completed flow)
      const signedInPage = pages.find(p => {
        const url = (p.url || '').toLowerCase();
        return url.includes('myaccount.google.com') ||
               url.includes('google.com/webhp') ||
               url.startsWith('chrome://newtab');
      });

      if (signedInPage) {
        // Read email from Preferences
        const automationDir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile');
        const prefsPath = path.join(automationDir, 'Default', 'Preferences');
        let email = null;
        try {
          const data = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
          const accounts = data?.account_info || [];
          const account = accounts.find(a => a.email) || accounts[0];
          email = account?.email || null;
        } catch {}
        return { signedIn: true, email };
      }

      return { signedIn: false, email: null };
    } catch {
      return { signedIn: false, email: null };
    }
  });

  // Step 5: Close automation Chrome (all tabs) via CDP
  ipcMain.handle('close-automation-chrome', async () => {
    try {
      const http = require('http');
      // Get list of pages via CDP
      const pages = await new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json/list', { timeout: 3000 }, (res) => {
          let data = '';
          res.on('data', (d) => { data += d; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });

      // Close each page
      for (const page of pages) {
        if (page.id) {
          await new Promise((resolve) => {
            http.get(`http://localhost:9222/json/close/${page.id}`, { timeout: 2000 }, () => resolve())
              .on('error', () => resolve());
          });
        }
      }

      // Kill Chrome processes using AutomationProfile
      try {
        execFile('powershell.exe', ['-NoProfile', '-Command',
          "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'AutomationProfile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        ], { timeout: 5000, windowsHide: true }, () => {});
      } catch {}

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Google Account Access (workspace-mcp OAuth) ─────────────────────────

  ipcMain.handle('check-google-creds', () => {
    try {
      const credsPath = IS_DEV
        ? path.join(__dirname, '..', 'oauth-creds.json')
        : path.join(WORKSPACE, 'outdoorsv1', 'backend', 'oauth-creds.json');
      if (fs.existsSync(credsPath)) {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        return { hasCreds: !!(creds.clientId && creds.clientSecret) };
      }
    } catch {}
    return { hasCreds: false };
  });

  ipcMain.handle('start-google-auth', async (_event, services) => {
    // services is an array like ['gmail', 'calendar', 'contacts', 'drive', 'docs']
    const toolsList = services && services.length > 0 ? services : ['gmail', 'calendar', 'contacts'];
    try {
      // Read OAuth creds
      const credsPath = IS_DEV
        ? path.join(__dirname, '..', 'oauth-creds.json')
        : path.join(WORKSPACE, 'outdoorsv1', 'backend', 'oauth-creds.json');
      if (!fs.existsSync(credsPath)) {
        return { ok: false, error: 'OAuth credentials not found. Place oauth-creds.json in the backend folder.' };
      }
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      if (!creds.clientId || !creds.clientSecret) {
        return { ok: false, error: 'Invalid oauth-creds.json — missing clientId or clientSecret.' };
      }

      // Find uvx — must resolve to the actual .exe on Windows (not a shell wrapper)
      let uvxCmd = 'uvx';
      try {
        const findCmd = process.platform === 'win32' ? 'where uvx' : 'which uvx';
        const found = execSync(findCmd, { encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true }).trim();
        if (found) {
          // 'where' may return multiple lines — pick the .exe if available
          const lines = found.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          uvxCmd = lines.find(l => l.endsWith('.exe')) || lines[0];
        }
      } catch {}

      // workspace-mcp auth flow using --cli mode:
      // 1. Run start_google_auth via --cli — prints auth URL and spawns callback server on port 8000
      // 2. The Python subprocess stays alive to handle the OAuth callback
      // 3. Open the auth URL in AutomationProfile Chrome
      // 4. Poll for credential file to confirm success

      // Snapshot existing credential files
      const credsDir = path.join(process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials');
      let existingCredFiles = new Set();
      try {
        if (fs.existsSync(credsDir)) {
          existingCredFiles = new Set(fs.readdirSync(credsDir).filter(f => f.endsWith('.json')));
        }
      } catch {}

      return new Promise((resolve) => {
        const env = {
          ...process.env,
          GOOGLE_OAUTH_CLIENT_ID: creds.clientId,
          GOOGLE_OAUTH_CLIENT_SECRET: creds.clientSecret,
        };

        // ── Phase 1: Start workspace-mcp with streamable-http transport ──
        // This starts an HTTP server on port 8000 that:
        // - Accepts MCP JSON-RPC calls via HTTP POST
        // - Handles the OAuth callback at /oauth2callback
        // - Stays alive until we kill it
        const serverArgs = ['workspace-mcp', '--single-user', '--transport', 'streamable-http', '--tools', ...toolsList];

        console.log('[google-auth] Starting MCP HTTP server:', uvxCmd, serverArgs.join(' '));
        const mcpProc = spawn(uvxCmd, serverArgs, {
          env, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        mcpProc.on('error', (err) => {
          console.error('[google-auth] spawn error:', err.message);
          resolve({ ok: false, error: 'Failed to start auth: ' + err.message });
        });
        mcpProc.unref();
        mcpProc.stdin?.on('error', () => {});

        let serverReady = false;
        let urlFound = false;
        let sessionId = null;

        mcpProc.stderr?.on('data', (d) => {
          const text = d.toString();
          console.log('[google-auth:stderr]', text.trim().slice(0, 200));
          // Detect when the HTTP server is ready — check for various startup messages
          if (!serverReady && (text.includes('Uvicorn running') || text.includes('Application startup complete') || text.includes('Transport: streamable-http') || text.includes('Transport:'))) {
            serverReady = true;
            console.log('[google-auth] HTTP server detected, waiting for port 8000...');
            // Give the server a moment to actually bind the port
            setTimeout(() => {
              console.log('[google-auth] Calling doMcpAuth');
              doMcpAuth();
            }, 3000);
          }
        });
        mcpProc.stdout?.on('data', (d) => console.log('[google-auth:stdout]', d.toString().trim().slice(0, 200)));

        // Use HTTP to communicate with the MCP server
        async function doMcpAuth() {
          try {
            const http = require('http');

            // Helper to make HTTP POST requests to the MCP server
            function mcpPost(body, sid) {
              return new Promise((res, rej) => {
                const data = JSON.stringify(body);
                const headers = {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json, text/event-stream',
                  'Content-Length': Buffer.byteLength(data),
                };
                if (sid) headers['Mcp-Session-Id'] = sid;
                const req = http.request({ hostname: 'localhost', port: 8000, path: '/mcp', method: 'POST', headers }, (resp) => {
                  let responseData = '';
                  // Capture session ID from response headers
                  const respSid = resp.headers['mcp-session-id'];
                  if (respSid) sessionId = respSid;
                  resp.on('data', (chunk) => { responseData += chunk; });
                  resp.on('end', () => res(responseData));
                });
                req.on('error', rej);
                req.write(data);
                req.end();
              });
            }

            // Step 1: Initialize
            console.log('[google-auth] Sending MCP initialize via HTTP');
            await mcpPost({
              jsonrpc: '2.0', id: 1, method: 'initialize',
              params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'outdoors-setup', version: '1.0' } },
            });

            // Step 2: Initialized notification
            await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

            // Step 3: Call start_google_auth
            console.log('[google-auth] Calling start_google_auth via HTTP');
            const authResp = await mcpPost({
              jsonrpc: '2.0', id: 2, method: 'tools/call',
              params: {
                name: 'start_google_auth',
                arguments: { service_name: 'gmail', user_google_email: getUserGoogleEmail() || 'user@gmail.com' },
              },
            }, sessionId);

            // Extract auth URL from response
            const urlMatch = authResp.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"<>)\\]+)/);
            if (urlMatch) {
              urlFound = true;
              const authUrl = urlMatch[1];
              console.log('[google-auth] Got auth URL, length:', authUrl.length);

              // ── Phase 2: Open auth URL in AutomationProfile Chrome ──
              const automationDir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile');
              const CHROME_PATHS = [
                path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
              ];
              const chromeExe = CHROME_PATHS.find(p => { try { return fs.existsSync(p); } catch { return false; } });

              if (chromeExe) {
                const chromeArgs = [
                  `--remote-debugging-port=9222`,
                  `--user-data-dir=${automationDir}`,
                  `--profile-directory=Default`,
                  `--no-first-run`,
                  `--no-default-browser-check`,
                  authUrl,
                ].map(a => `'${a}'`).join(',');
                const script = `Start-Process '${chromeExe}' -ArgumentList ${chromeArgs}`;
                execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000 }, (err) => {
                  if (err) console.error('[google-auth] PowerShell error:', err.message);
                });
              } else {
                shell.openExternal(authUrl);
              }

              resolve({ ok: true, authUrl, pendingAuth: true });
            } else {
              console.error('[google-auth] No auth URL in response:', authResp.slice(0, 500));
              resolve({ ok: false, error: 'Could not get Google auth URL.' });
            }
          } catch (err) {
            console.error('[google-auth] HTTP error:', err.message);
            resolve({ ok: false, error: 'Failed to communicate with auth server: ' + err.message });
          }
        }

        // Timeout: if server doesn't start in 20 seconds, fail
        setTimeout(() => {
          if (!serverReady) {
            console.error('[google-auth] Server startup timed out');
            try { mcpProc.kill(); } catch {}
            resolve({ ok: false, error: 'Auth server failed to start.' });
          }
        }, 20000);

        // Timeout: if no URL after 35 seconds total, fail
        setTimeout(() => {
          if (!urlFound) {
            console.error('[google-auth] Timed out waiting for auth URL');
            try { mcpProc.kill(); } catch {}
            resolve({ ok: false, error: 'Timed out waiting for Google auth URL.' });
          }
        }, 35000);

        // ── Phase 3: Poll for credential file ──
        let pollCount = 0;
        const pollTimer = setInterval(() => {
          pollCount++;
          try {
            if (fs.existsSync(credsDir)) {
              const currentFiles = fs.readdirSync(credsDir).filter(f => f.endsWith('.json'));
              const newFiles = currentFiles.filter(f => !existingCredFiles.has(f));
              if (newFiles.length > 0) {
                clearInterval(pollTimer);
                // Use the AutomationProfile email if available, otherwise first new credential
                const automationEmail = getAutomationProfileEmail();
                const matchingFile = automationEmail ? newFiles.find(f => f.replace('.json', '') === automationEmail) : null;
                const selectedEmail = matchingFile ? automationEmail : newFiles[0].replace('.json', '');
                try {
                  let cfg = {};
                  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
                  cfg.googleServices = toolsList;
                  cfg.googleEmail = selectedEmail;
                  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
                } catch {}
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('google-auth-complete', { ok: true, email: selectedEmail });
                }
                return;
              }
              // Check for recently modified existing files (re-auth)
              for (const file of currentFiles) {
                try {
                  const stat = fs.statSync(path.join(credsDir, file));
                  if (Date.now() - stat.mtimeMs < 10000) {
                    clearInterval(pollTimer);
                    try {
                      let cfg = {};
                      if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
                      cfg.googleServices = toolsList;
                      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
                    } catch {}
                    if (mainWindow && !mainWindow.isDestroyed()) {
                      mainWindow.webContents.send('google-auth-complete', { ok: true, email: file.replace('.json', '') });
                    }
                    return;
                  }
                } catch {}
              }
            }
          } catch {}
          if (pollCount >= 90) { // 3 minutes
            clearInterval(pollTimer);
          }
        }, 2000);
      });
    } catch (err) {
      return { ok: false, error: 'Error: ' + err.message };
    }
  });

  // ── WhatsApp Setup (QR pairing happens automatically via backend) ────────

  // Start the backend
  ipcMain.handle('start-backend', async () => {
    if (backendProcess) return { ok: true, alreadyRunning: true };

    // Pre-check: node_modules must exist (npm install must have succeeded)
    const nodeModules = path.join(BACKEND_DIR, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
      return { ok: false, error: 'Dependencies not installed. Please restart the app to run setup again.' };
    }

    return startBackend();
  });

  // Get backend port for Socket.IO connection
  ipcMain.handle('get-backend-url', () => {
    // Read port from config, default 3847
    let port = 3847;
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (cfg.port) port = cfg.port;
      }
    } catch {}
    return `http://localhost:${port}`;
  });

  // Mark setup complete and start the backend
  ipcMain.handle('complete-setup', async () => {
    fs.writeFileSync(SETUP_DONE_FLAG, new Date().toISOString());
    setupAutoLaunch();
    // Start backend immediately after setup (don't wait for app restart)
    if (!backendProcess) {
      startBackend().then(result => {
        if (result.ok) console.log('[setup] Backend started after setup complete');
        else console.error('[setup] Backend failed to start:', result.error);
      });
    }
    return { ok: true };
  });

  // Close/hide window
  ipcMain.handle('close-window', () => {
    if (mainWindow) mainWindow.hide();
  });

  // ── Dashboard IPC ─────────────────────────────────────────────────────────

  ipcMain.handle('open-dashboard', async () => {
    createDashboardWindow();
  });

  ipcMain.handle('minimize-window', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('list-memory-files', async () => {
    const memoryDir = path.join(BACKEND_DIR, 'bot', 'memory');
    const results = [];
    function walk(dir, rel) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === 'short-term' || entry.name === 'node_modules') continue;
          walk(fullPath, relPath);
        } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
          results.push({ name: entry.name, relativePath: relPath });
        }
      }
    }
    walk(memoryDir, '');
    return results;
  });

  ipcMain.handle('read-memory-file', async (_event, relativePath) => {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Invalid path');
    return fs.readFileSync(path.join(BACKEND_DIR, 'bot', 'memory', relativePath), 'utf-8');
  });

  ipcMain.handle('save-memory-file', async (_event, relativePath, content) => {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Invalid path');
    const filePath = path.join(BACKEND_DIR, 'bot', 'memory', relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  });

  // ── Onboarding Scan (post-consent personalization) ───────────────────────

  ipcMain.handle('run-onboarding-scan', async (_event, services) => {
    try {
      const cmd = getClaudeCmd();
      const knowledgeDir = path.join(BACKEND_DIR, 'bot', 'memory', 'knowledge');
      fs.mkdirSync(knowledgeDir, { recursive: true });

      // Ensure .claude.json exists with google-workspace MCP config
      const claudeConfigPath = path.join(BACKEND_DIR, '.claude.json');
      if (!fs.existsSync(claudeConfigPath)) {
        // Build a minimal MCP config with google-workspace
        let uvxCommand = 'uvx';
        try {
          const findCmd = process.platform === 'win32' ? 'where uvx' : 'which uvx';
          const found = execSync(findCmd, { encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true }).trim();
          if (found) uvxCommand = found.split('\n')[0].trim();
        } catch {}

        const credsPath = IS_DEV
          ? path.join(__dirname, '..', 'oauth-creds.json')
          : path.join(WORKSPACE, 'outdoorsv1', 'backend', 'oauth-creds.json');
        let oauthClientId = '', oauthClientSecret = '';
        try {
          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
          oauthClientId = creds.clientId || '';
          oauthClientSecret = creds.clientSecret || '';
        } catch {}

        if (oauthClientId && oauthClientSecret) {
          const wsArgs = ['workspace-mcp', '--single-user'];
          if (services && services.length > 0) wsArgs.push('--tools', ...services);

          // Get the user's Google email from AutomationProfile
          const userEmail = getUserGoogleEmail();

          const mcpConfig = {
            mcpServers: {
              google_workspace: {
                type: 'stdio',
                command: uvxCommand,
                args: wsArgs,
                env: {
                  GOOGLE_OAUTH_CLIENT_ID: oauthClientId,
                  GOOGLE_OAUTH_CLIENT_SECRET: oauthClientSecret,
                },
              },
            },
          };
          fs.writeFileSync(claudeConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');

          // Also update mcp-bot.json in outdoorsv4 with google_workspace + email
          const v4Dir = IS_DEV
            ? path.join(__dirname, '..', '..', '..', 'outdoorsv4')
            : path.join(WORKSPACE, 'outdoorsv4');
          const botMcpPath = path.join(v4Dir, 'mcp-bot.json');
          try {
            let botMcp = {};
            if (fs.existsSync(botMcpPath)) botMcp = JSON.parse(fs.readFileSync(botMcpPath, 'utf-8'));
            if (!botMcp.mcpServers) botMcp.mcpServers = {};
            botMcp.mcpServers.google_workspace = mcpConfig.mcpServers.google_workspace;
            fs.writeFileSync(botMcpPath, JSON.stringify(botMcp, null, 2) + '\n');
          } catch {}

          // Save email to config so the bot always uses the right account
          if (userEmail) {
            try {
              let cfg = {};
              if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
              cfg.googleEmail = userEmail;
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
            } catch {}
          }
        }
      }

      // Ensure onboarding skill file exists in workspace
      const skillPath = path.join(BACKEND_DIR, 'bot', 'memory', 'skills', 'onboarding', 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        // Copy from bundle if available
        const bundledSkill = path.join(process.resourcesPath || '', 'project', 'bot', 'memory', 'skills', 'onboarding', 'SKILL.md');
        if (fs.existsSync(bundledSkill)) {
          fs.mkdirSync(path.dirname(skillPath), { recursive: true });
          fs.copyFileSync(bundledSkill, skillPath);
        }
      }

      // Read the onboarding skill file for standardized templates
      let skillContent = '';
      try {
        if (fs.existsSync(skillPath)) {
          skillContent = fs.readFileSync(skillPath, 'utf-8');
        }
      } catch {}

      const servicesList = (services || ['gmail', 'calendar', 'contacts']).join(', ');
      const today = new Date().toISOString().split('T')[0];
      const scanEmail = getUserGoogleEmail() || 'the authenticated user';

      const fullPrompt = `You are running an onboarding personalization scan for a new Outdoors user. Your goal is to use Google Workspace MCP tools (mcp__google_workspace__*) to learn about the user and fill out standardized knowledge files.

IMPORTANT: The user's Google email is: ${scanEmail}
Always pass user_google_email="${scanEmail}" when calling any Google Workspace MCP tool.
Do NOT use browser/Chrome tools — use ONLY mcp__google_workspace__* tools for reading data.

TASK: Read the skill file at bot/memory/skills/onboarding/SKILL.md — it contains the exact templates and filenames for each service. Then scan the user's data for these services: ${servicesList}.

For each service:
1. Use the appropriate mcp__google_workspace__* tools (search_gmail_messages, get_events, list_contacts, etc.)
2. Analyze the data for patterns, style, and preferences
3. Create the knowledge file at bot/memory/knowledge/<service>-profile.md using the EXACT template from the skill file
4. Fill in every field in the template with real observations — be specific, not generic
5. Always create bot/memory/knowledge/user-profile.md as a synthesis of all services

RULES:
- Only READ, never modify the user's data
- Write PATTERNS and INSIGHTS, not raw data (no full email bodies, no phone numbers, no passwords)
- Be specific: "uses casual tone, typically 2-3 short sentences, signs off with 'cheers'" beats "mixed tone"
- Replace [YYYY-MM-DD] with ${today}
- If a service has no data or fails, write "No data available" in that file and move on
- Keep each file under 60 lines

Start by reading the skill file, then scan each service systematically.`;

      // Clean env — remove CLAUDECODE to avoid nested session error
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;

      // Ensure mcp-bot.json exists in outdoorsv4 with google_workspace
      const v4Dir = IS_DEV
        ? path.join(__dirname, '..', '..', '..', 'outdoorsv4')
        : path.join(WORKSPACE, 'outdoorsv4');
      const botMcpPath = path.join(v4Dir, 'mcp-bot.json');

      // Create a scan-specific MCP config with ONLY google_workspace (no browser tools)
      const scanMcpConfigPath = path.join(app.getPath('userData'), 'scan-mcp-config.json');
      try {
        const fullConfig = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, '.claude.json'), 'utf-8'));
        const scanConfig = {
          mcpServers: {
            google_workspace: fullConfig.mcpServers?.google_workspace,
          },
        };
        fs.writeFileSync(scanMcpConfigPath, JSON.stringify(scanConfig, null, 2));
      } catch {}
      const mcpConfigPath = scanMcpConfigPath;

      const spawnArgs = [
        '--print',
        '--model', 'sonnet',
        '--dangerously-skip-permissions',
      ];

      // Pass MCP config explicitly — --print mode doesn't auto-load .claude.json
      if (fs.existsSync(mcpConfigPath)) {
        spawnArgs.push('--mcp-config', mcpConfigPath);
      } else if (fs.existsSync(botMcpPath)) {
        spawnArgs.push('--mcp-config', botMcpPath);
      }

      // Write prompt to temp file — Windows cmd.exe has ~8191 char limit,
      // and the full prompt exceeds that when passed via -p
      const promptFile = path.join(app.getPath('temp'), 'outdoors-onboarding-prompt.txt');
      fs.writeFileSync(promptFile, fullPrompt, 'utf-8');

      // Log the scan launch for debugging
      const scanLog = path.join(app.getPath('userData'), 'onboarding-scan.log');
      fs.writeFileSync(scanLog, `[${new Date().toISOString()}] Launching scan\ncmd: ${cmd}\nargs: ${JSON.stringify(spawnArgs)}\ncwd: ${BACKEND_DIR}\nmcpConfig: ${mcpConfigPath}\npromptFile: ${promptFile}\npromptLength: ${fullPrompt.length}\n`);

      return new Promise((resolve) => {
        // Use spawn with stdin piping — passing prompt via -p hits Windows 8191 char limit
        // Claude CLI reads from stdin when --print is used without -p

        const proc = spawn(cmd, spawnArgs, {
          cwd: BACKEND_DIR,
          shell: true,
          env: cleanEnv,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        try { fs.appendFileSync(scanLog, `[spawn] pid=${proc?.pid}\n`); } catch {}

        // Write prompt to stdin
        proc.stdin.on('error', () => {});
        proc.stdin.write(fullPrompt);
        proc.stdin.end();

        let stdout = '';
        let stderr = '';

        // Log all output for debugging
        const runLog = path.join(app.getPath('userData'), 'onboarding-run.log');
        try { fs.writeFileSync(runLog, `[${new Date().toISOString()}] Scan started\n`); } catch {}

        proc.stdout?.on('data', (d) => {
          stdout += d.toString();
          try { fs.appendFileSync(runLog, `[stdout] ${d.toString()}\n`); } catch {}
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('onboarding-progress', d.toString());
          }
        });
        proc.stderr?.on('data', (d) => {
          stderr += d.toString();
          try { fs.appendFileSync(runLog, `[stderr] ${d.toString().slice(0, 500)}\n`); } catch {}
        });

        proc.on('close', (code) => {
          try { fs.appendFileSync(scanLog, `[close] code=${code}\nstdout_len=${stdout.length}\nstderr_last500=${stderr.slice(-500)}\n`); } catch {}
          if (code === 0 && stdout) {
            resolve({ ok: true, summary: stdout.slice(-500) });
          } else {
            resolve({ ok: false, error: stderr.trim().slice(-300) || `Scan exited with code ${code}` });
          }
        });

        proc.on('error', (err) => {
          try { fs.appendFileSync(scanLog, `[error] ${err.message}\n`); } catch {}
          resolve({ ok: false, error: 'Failed to start scan: ' + err.message });
        });

        // Timeout after 30 minutes — scan may take a while with many services
        setTimeout(() => {
          try { proc.kill(); } catch {}
        }, 1800000);
      });

    } catch (err) {
      return { ok: false, error: 'Error: ' + err.message };
    }
  });

  ipcMain.handle('get-full-config', async () => {
    try {
      if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {}
    return {};
  });

  ipcMain.handle('save-full-config', async (_event, data) => {
    let cfg = {};
    try { if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
    Object.assign(cfg, data);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return { ok: true };
  });
}

// ── MCP Config Writer ───────────────────────────────────────────────────────

function writeMcpConfig(browserKey, browser) {
  const config = { mcpServers: {} };

  // Browser MCP
  config.mcpServers[browser.mcpName] = {
    command: 'npx',
    args: browser.mcpArgs,
  };

  // Context7 (library docs)
  config.mcpServers.context7 = {
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
  };

  // Google Workspace (centralized OAuth)
  let uvxCommand = 'uvx';
  try {
    const findCmd = process.platform === 'win32' ? 'where uvx' : 'which uvx';
    const found = execSync(findCmd, { encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true }).trim();
    if (found) uvxCommand = found.split('\n')[0].trim();
  } catch {}

  // Google Workspace OAuth creds — read from oauth-creds.json (not committed to git)
  let oauthClientId = '';
  let oauthClientSecret = '';
  try {
    const credsPath = IS_DEV
      ? path.join(__dirname, '..', 'oauth-creds.json')
      : path.join(WORKSPACE, 'outdoorsv1', 'backend', 'oauth-creds.json');
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      oauthClientId = creds.clientId || '';
      oauthClientSecret = creds.clientSecret || '';
    }
  } catch {}

  if (oauthClientId && oauthClientSecret) {
    // Read selected Google services from config
    let googleTools = [];
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (cfg.googleServices && cfg.googleServices.length > 0) {
          googleTools = cfg.googleServices;
        }
      }
    } catch {}

    const wsArgs = ['workspace-mcp', '--single-user'];
    if (googleTools.length > 0) {
      wsArgs.push('--tools', ...googleTools);
    }

    config.mcpServers.google_workspace = {
      type: 'stdio',
      command: uvxCommand,
      args: wsArgs,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: oauthClientId,
        GOOGLE_OAUTH_CLIENT_SECRET: oauthClientSecret,
      },
    };
  }

  // Write .claude.json to the backend directory (Claude CLI's project root, where CLAUDE.md lives)
  const claudeConfigDir = IS_DEV
    ? path.join(__dirname, '..')
    : path.join(WORKSPACE, 'outdoorsv1', 'backend');
  const claudeConfigPath = path.join(claudeConfigDir, '.claude.json');

  fs.mkdirSync(claudeConfigDir, { recursive: true });
  fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + '\n');

  // Also write mcp-bot.json in outdoorsv4/ — this is what the bot's runtime pipeline uses
  // (model-runner.js reads this, NOT .claude.json)
  const botMcpConfig = {
    mcpServers: {
      [browser.mcpName]: {
        command: 'npx',
        args: browser.mcpArgs,
      },
      playwright: {
        command: 'npx',
        args: ['@playwright/mcp@latest', '--cdp-endpoint', 'http://localhost:9222', '--no-isolated', '--timeout-navigation', '10000', '--timeout-action', '5000'],
      },
    },
  };

  // Add google_workspace to bot runtime config too
  if (oauthClientId && oauthClientSecret) {
    const wsArgs = ['workspace-mcp', '--single-user'];
    let googleTools = [];
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (cfg.googleServices && cfg.googleServices.length > 0) googleTools = cfg.googleServices;
      }
    } catch {}
    if (googleTools.length > 0) wsArgs.push('--tools', ...googleTools);

    botMcpConfig.mcpServers.google_workspace = {
      type: 'stdio',
      command: uvxCommand,
      args: wsArgs,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: oauthClientId,
        GOOGLE_OAUTH_CLIENT_SECRET: oauthClientSecret,
      },
    };
  }

  const v4Dir = IS_DEV
    ? path.join(__dirname, '..', '..', '..', 'outdoorsv4')
    : path.join(WORKSPACE, 'outdoorsv4');
  const botMcpPath = path.join(v4Dir, 'mcp-bot.json');
  try {
    fs.mkdirSync(v4Dir, { recursive: true });
    fs.writeFileSync(botMcpPath, JSON.stringify(botMcpConfig, null, 2) + '\n');
  } catch (err) {
    console.error('[mcp-config] Failed to write mcp-bot.json:', err.message);
  }
}

// ── Dev Log Window ──────────────────────────────────────────────────────────

function createDevLogWindow() {
  if (devLogWindow) {
    devLogWindow.show();
    devLogWindow.focus();
    return;
  }
  devLogWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Outdoors — Dev Log',
    backgroundColor: '#1a1a2e',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'devlog-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  devLogWindow.loadFile(path.join(SETUP_DIR, 'devlog.html'));
  devLogWindow.on('closed', () => { devLogWindow = null; });
}

// ── Backend Process ─────────────────────────────────────────────────────────

function startBackend() {
  return new Promise((resolve) => {
    const indexJs = path.join(BACKEND_DIR, 'src', 'index.js');
    if (!fs.existsSync(indexJs)) {
      resolve({ ok: false, error: 'Backend index.js not found at ' + indexJs });
      return;
    }

    backendProcess = spawn('node', [indexJs], {
      cwd: BACKEND_DIR,
      env: { ...process.env, ELECTRON: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let stderrOutput = '';

    const onOutput = (data) => {
      const text = data.toString();
      console.log('[backend]', text.trim());
      if (devLogWindow && !devLogWindow.isDestroyed()) {
        devLogWindow.webContents.send('devlog:stdout', text);
      }
      // Detect server started
      if (!started && (text.includes('API: http://') || text.includes('Outdoors Bot'))) {
        started = true;
        resolve({ ok: true });
      }
    };

    backendProcess.stdout.on('data', onOutput);
    backendProcess.stderr.on('data', (d) => {
      const text = d.toString().trim();
      stderrOutput += text + '\n';
      console.error('[backend:err]', text);
      if (devLogWindow && !devLogWindow.isDestroyed()) {
        devLogWindow.webContents.send('devlog:stderr', text);
      }
    });

    backendProcess.on('close', (code) => {
      console.log('[backend] exited with code', code);
      backendProcess = null;
      if (!started) {
        resolve({ ok: false, error: `Backend exited with code ${code}`, stderr: stderrOutput });
        return;
      }

      // Auto-restart if backend crashes after successful startup
      if (fs.existsSync(SETUP_DONE_FLAG) && backendRestarts < MAX_BACKEND_RESTARTS) {
        backendRestarts++;
        const delay = Math.min(3000 * backendRestarts, 15000);
        console.log(`[backend] Crashed (code ${code}). Restarting in ${delay / 1000}s (attempt ${backendRestarts}/${MAX_BACKEND_RESTARTS})...`);
        setTimeout(() => {
          startBackend().then(result => {
            if (result.ok) {
              console.log('[backend] Restarted successfully');
              backendRestarts = 0; // reset on successful restart
            } else {
              console.error('[backend] Restart failed:', result.error);
            }
          });
        }, delay);
      } else if (backendRestarts >= MAX_BACKEND_RESTARTS) {
        console.error('[backend] Max restart attempts reached. Relaunch the app to try again.');
      }
    });

    // Timeout — backend didn't start in 30s
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve({ ok: false, error: 'Backend did not start within 30 seconds', timeout: true, stderr: stderrOutput });
      }
    }, 30000);
  });
}

// ── System Tray ─────────────────────────────────────────────────────────────

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Outdoors');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Dev Log',
      click: () => createDevLogWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (backendProcess) {
          backendProcess.kill();
          backendProcess = null;
        }
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Auto Launch ─────────────────────────────────────────────────────────────

function setupAutoLaunch() {
  try {
    const AutoLaunch = require('auto-launch');
    const autoLauncher = new AutoLaunch({
      name: 'Outdoors',
      isHidden: true,
    });
    autoLauncher.isEnabled().then((enabled) => {
      if (!enabled) autoLauncher.enable();
    });
  } catch (err) {
    console.warn('[auto-launch] Could not set up:', err.message);
  }
}

// ── Dashboard Window ─────────────────────────────────────────────────────

function createDashboardWindow() {
  if (mainWindow) {
    mainWindow.setResizable(true);
    mainWindow.setMaximizable(true);
    mainWindow.setSize(940, 660);
    mainWindow.center();
    mainWindow.loadFile(path.join(SETUP_DIR, 'dashboard.html'));
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow = new BrowserWindow({
      width: 940,
      height: 660,
      resizable: true,
      maximizable: true,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#FAF6F1',
      icon: ICON_PATH,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow.loadFile(path.join(SETUP_DIR, 'dashboard.html'));
    mainWindow.on('close', (e) => {
      if (tray) { e.preventDefault(); mainWindow.hide(); }
    });
  }
}

// ── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const isFirstRun = ensureWorkspace();
  const setupDone = fs.existsSync(SETUP_DONE_FLAG);

  setupIPC();
  createTray();

  if (!setupDone || isFirstRun) {
    createSetupWindow();
  } else {
    await startBackend();
    createDashboardWindow();
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit — stay in tray
  e.preventDefault?.();
});

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});
