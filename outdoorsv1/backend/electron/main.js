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
      resolvedClaudeCmd = found.split('\n')[0].trim();
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

  try {
    const bundledProject = path.join(process.resourcesPath, 'project');
    const destBackend = path.join(WORKSPACE, 'outdoorsv1', 'backend');

    if (fs.existsSync(bundledProject)) {
      if (isFirstRun) {
        copyDirSync(bundledProject, destBackend);
      } else {
        // Upgrade: re-sync source code but preserve user data
        const preserveDirs = new Set(['auth_state', 'node_modules', 'bot']);
        const preserveFiles = new Set(['config.json', '.env', '.claude.json']);

        const bundledSrc = path.join(bundledProject, 'src');
        if (fs.existsSync(bundledSrc)) {
          copyDirSync(bundledSrc, path.join(destBackend, 'src'));
        }

        const topEntries = fs.readdirSync(bundledProject, { withFileTypes: true });
        for (const entry of topEntries) {
          if (preserveDirs.has(entry.name) || preserveFiles.has(entry.name)) continue;
          if (entry.name === 'src' || entry.name === 'electron' || entry.name === 'dist') continue;
          const srcPath = path.join(bundledProject, entry.name);
          const destPath = path.join(destBackend, entry.name);
          if (entry.isDirectory()) copyDirSync(srcPath, destPath);
          else fs.copyFileSync(srcPath, destPath);
        }

        const bundledClaude = path.join(bundledProject, 'CLAUDE.md');
        if (fs.existsSync(bundledClaude)) {
          fs.copyFileSync(bundledClaude, path.join(destBackend, 'CLAUDE.md'));
        }

        console.log(`[workspace] Upgraded from ${installedVersion || 'unknown'} to ${currentVersion}`);
      }
    }

    const bundledV4 = path.join(process.resourcesPath, 'outdoorsv4');
    if (fs.existsSync(bundledV4)) {
      copyDirSync(bundledV4, path.join(WORKSPACE, 'outdoorsv4'));
    }
  } catch (err) {
    console.error('[workspace] Copy failed:', err);
  }

  const emptyDirs = ['bot/logs', 'bot/outputs', 'bot/message-queue', 'bot/memory/short-term'];
  for (const dir of emptyDirs) {
    try { fs.mkdirSync(path.join(BACKEND_DIR, dir), { recursive: true }); } catch {}
  }

  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.writeFileSync(versionFile, currentVersion);
  } catch {}

  return isFirstRun;
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
  ipcMain.handle('check-browser-auth', async () => {
    try {
      const automationDir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile');
      const prefsPath = path.join(automationDir, 'Default', 'Preferences');
      if (!fs.existsSync(prefsPath)) return { signedIn: false, email: null };

      const data = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      const accounts = data?.account_info || [];
      if (accounts.length > 0) {
        const account = accounts.find(a => a.email) || accounts[0];
        return { signedIn: true, email: account?.email || 'signed in' };
      }
      return { signedIn: false, email: null };
    } catch {
      return { signedIn: false, email: null };
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
    config.mcpServers.google_workspace = {
      type: 'stdio',
      command: uvxCommand,
      args: ['workspace-mcp', '--single-user'],
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
