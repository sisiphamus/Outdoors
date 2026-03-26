/**
 * Outdoors — Electron Main Process
 *
 * Thin shell that:
 * 1. Copies bundled project to writable userData on first run
 * 2. Shows setup wizard (install deps → Claude auth → Browser + Telegram)
 * 3. Spawns backend as child process
 * 4. Lives in system tray
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync, execFile } = require('child_process');
const platform = require('./platform');

// ── Fix macOS PATH ──────────────────────────────────────────────────────────
// Electron apps launched from Finder get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// Homebrew, nvm, and other tools installed via shell profiles are invisible.
// Fix: read the user's login shell PATH and merge it into process.env.PATH.

function fixMacPath() {
  if (process.platform !== 'darwin') return;

  // Step 1: Always prepend known macOS tool directories unconditionally.
  // This guarantees /opt/homebrew/bin and /usr/local/bin are in PATH even if
  // the shell invocation below fails or returns an incomplete PATH.
  const knownDirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(process.env.HOME || '', '.local/bin'),
    path.join(process.env.HOME || '', '.cargo/bin'),
  ];
  const currentPath = process.env.PATH || '';
  const missing = knownDirs.filter(d => !currentPath.includes(d));
  if (missing.length > 0) {
    process.env.PATH = missing.join(':') + ':' + currentPath;
  }

  // Step 2: Also try to read the full PATH from the user's login shell.
  // This catches nvm, pyenv, and other tools configured in shell profiles.
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    const shellPath = execSync(`${userShell} -ilc 'echo $PATH'`, {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (shellPath && shellPath.length > currentPath.length) {
      // Merge: keep our prepended dirs, add any extras from shell
      const shellDirs = shellPath.split(':');
      const currentDirs = new Set(process.env.PATH.split(':'));
      const newDirs = shellDirs.filter(d => d && !currentDirs.has(d));
      if (newDirs.length > 0) {
        process.env.PATH = process.env.PATH + ':' + newDirs.join(':');
      }
      console.log('[mac] PATH merged from login shell');
    }
  } catch {
    console.log('[mac] Shell PATH read failed — using prepended known dirs');
  }

  // Step 3: Find nvm-managed Node (not a fixed path — version is in the dir name)
  try {
    const nvmDir = path.join(process.env.HOME || '', '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      if (versions.length > 0) {
        const nvmBin = path.join(nvmDir, versions[0], 'bin');
        if (!process.env.PATH.includes(nvmBin)) {
          process.env.PATH = nvmBin + ':' + process.env.PATH;
          console.log('[mac] Added nvm node:', nvmBin);
        }
      }
    }
  } catch {}

  console.log('[mac] Final PATH:', process.env.PATH);
}

fixMacPath();

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

// Onboarding scan state (shared between setup wizard and dashboard)
let onboardingScan = { running: false, progress: 0, status: '' };
let authPollTimer = null; // track auth polling so we can cancel on skip

// Read the signed-in email from Chrome AutomationProfile Preferences
function getAutomationProfileEmail() {
  try {
    const prefsPath = path.join(platform.getAutomationProfileDir(), 'Default', 'Preferences');
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
let backendStoppedByUser = false; // true when user clicks power button
let resolvedClaudeCmd = 'claude'; // updated after install or PATH lookup
let resolvedUvxCmd = null; // cached full path to uvx.exe

// Find uvx full path — checks PATH then common install locations
function findUvxPath() {
  const found = platform.findCommand('uvx');
  if (found) return found;

  const candidates = platform.getUvxCandidatePaths();
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

// Resolve the claude command — caches after first successful lookup
function getClaudeCmd() {
  if (resolvedClaudeCmd !== 'claude') return resolvedClaudeCmd;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.claudeCommand && cfg.claudeCommand !== 'claude') {
        resolvedClaudeCmd = cfg.claudeCommand;
        return resolvedClaudeCmd;
      }
    }
  } catch {}
  const found = platform.getClaudeCmdPath();
  if (found) resolvedClaudeCmd = found;
  return resolvedClaudeCmd;
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

  // Workspace files exist but version file is missing/corrupted (crash recovery)
  // Just rewrite the version file — don't wipe and reinstall
  if (workspaceExists && !versionMatch && !installedVersion) {
    console.log(`[workspace] Version file missing (likely crash). Rewriting version file, skipping reinstall.`);
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
    fs.writeFileSync(versionFile, currentVersion);
    return false;
  }

  const isFirstRun = !workspaceExists;
  const destBackend = path.join(WORKSPACE, 'outdoorsv1', 'backend');

  // On update: move user data to a safe location, wipe workspace, copy fresh, move user data back.
  // Bot data (memory, skills, outputs, logs) is NEVER deleted — it lives in a persistent
  // safe dir during the upgrade so even if the copy/restore fails, the data survives.
  // On first run: just copy fresh from bundle
  if (!isFirstRun) {
    console.log(`[workspace] Version update: ${installedVersion} → ${currentVersion}. Clean reinstall.`);

    // Kill any orphaned backend processes from the previous version that may hold
    // file locks on the workspace. The NSIS installer does this too, but this covers
    // the case where the app is auto-updating or the user launched the new version manually.
    if (backendProcess) {
      const pid = backendProcess.pid;
      try {
        if (platform.IS_WIN) {
          execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        } else {
          process.kill(-pid, 'SIGTERM');
        }
      } catch {}
      backendProcess = null;
    }
    // Also kill anything still listening on the backend port
    try {
      const cfg = fs.existsSync(path.join(destBackend, 'config.json'))
        ? JSON.parse(fs.readFileSync(path.join(destBackend, 'config.json'), 'utf-8'))
        : {};
      platform.killPort(cfg.port || 3847);
    } catch {}

    // Persistent safe dir (NOT temp — survives reboots and crash recovery)
    const safeDir = path.join(app.getPath('userData'), '.upgrade-safe');
    try { fs.rmSync(safeDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(safeDir, { recursive: true });

    // Files to preserve
    const keepFiles = ['config.json', '.env', '.claude.json', 'oauth-creds.json'];
    for (const file of keepFiles) {
      const src = path.join(destBackend, file);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(safeDir, file));
        } catch (err) {
          console.error(`[workspace] Failed to back up ${file}:`, err.message);
        }
      }
    }

    // MOVE (not copy) directories to safe location — this is atomic on same filesystem
    // and ensures data is never at risk during wipe. Includes ALL bot data.
    const keepDirs = ['auth_state', 'bot/memory', 'bot/logs', 'bot/outputs'];
    for (const dir of keepDirs) {
      const src = path.join(destBackend, dir);
      if (fs.existsSync(src)) {
        const dest = path.join(safeDir, dir);
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(src, dest);
          console.log(`[workspace] Moved ${dir} to safe location`);
        } catch (err) {
          // renameSync fails across filesystems — fall back to copy
          console.log(`[workspace] rename failed for ${dir}, falling back to copy: ${err.message}`);
          try {
            copyDirSync(src, dest);
            console.log(`[workspace] Copied ${dir} to safe location`);
          } catch (copyErr) {
            console.error(`[workspace] CRITICAL: Failed to preserve ${dir}:`, copyErr.message);
          }
        }
      }
    }

    // SAFETY CHECK: Refuse to wipe workspace if bot data is still inside
    // This prevents data loss if the move-to-safe-dir step above failed
    const botMemoryStillHere = fs.existsSync(path.join(destBackend, 'bot', 'memory', 'skills'));
    const botMemoryInSafe = fs.existsSync(path.join(safeDir, 'bot', 'memory'));
    if (botMemoryStillHere && !botMemoryInSafe) {
      console.error('[workspace] ABORT: Bot data is still in workspace and NOT in safe dir. Skipping wipe to prevent data loss.');
      // Just update the version file and return without wiping
      fs.writeFileSync(versionFile, currentVersion);
      return false;
    }

    // Wipe workspace (bot data has already been moved out)
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

    // Move user data back from safe location
    // Files first
    for (const file of keepFiles) {
      const src = path.join(safeDir, file);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(destBackend, file));
        } catch (err) {
          console.error(`[workspace] Failed to restore ${file}:`, err.message);
        }
      }
    }
    // Directories — move back
    for (const dir of keepDirs) {
      const src = path.join(safeDir, dir);
      const dest = path.join(destBackend, dir);
      if (fs.existsSync(src)) {
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          // Remove any empty dir created by bundle copy
          if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
          fs.renameSync(src, dest);
          console.log(`[workspace] Restored ${dir}`);
        } catch (err) {
          // Fall back to copy
          try {
            copyDirSync(src, dest);
            console.log(`[workspace] Restored ${dir} (via copy)`);
          } catch (copyErr) {
            console.error(`[workspace] CRITICAL: Failed to restore ${dir}:`, copyErr.message);
          }
        }
      }
    }
    console.log('[workspace] User data restored successfully');

    // Clean up safe dir ONLY if data was successfully restored
    const botRestoredOk = fs.existsSync(path.join(destBackend, 'bot', 'memory'));
    if (botRestoredOk) {
      try { fs.rmSync(safeDir, { recursive: true, force: true }); } catch {}
    } else {
      console.error('[workspace] WARNING: Bot data not found in workspace after restore. Keeping safe dir as backup:', safeDir);
    }

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

  // ── Auto-install system dependencies ────────────────────────────────────────
  // Checks for Node.js, Git, Python and installs any missing ones via winget

  function isCommandAvailable(cmd) {
    try {
      execSync(`${cmd} --version`, { encoding: 'utf-8', shell: true, timeout: 10000, windowsHide: true, stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  function wingetInstall(packageId, name) {
    return new Promise((resolve) => {
      console.log(`[deps] Installing ${name} via winget...`);
      const proc = spawn('winget', ['install', '--id', packageId, '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'], {
        shell: true,
        windowsHide: true,
        env: process.env,
      });
      let output = '';
      proc.stdout?.on('data', (d) => { output += d.toString(); });
      proc.stderr?.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => {
        console.log(`[deps] ${name} install exited with code ${code}`);
        resolve({ ok: code === 0, output });
      });
      proc.on('error', (err) => {
        console.log(`[deps] ${name} install error:`, err.message);
        resolve({ ok: false, output: err.message });
      });
    });
  }

  // Refresh PATH after installing tools so they're findable without restart
  function refreshPath() {
    if (process.platform === 'darwin') {
      fixMacPath();
      return;
    }
    try {
      // Windows: Read the machine + user PATH from the registry and merge
      const machinePath = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path', {
        encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true, stdio: 'pipe',
      }).match(/Path\s+REG_\w+\s+(.*)/)?.[1]?.trim() || '';
      const userPath = execSync('reg query "HKCU\\Environment" /v Path', {
        encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true, stdio: 'pipe',
      }).match(/Path\s+REG_\w+\s+(.*)/)?.[1]?.trim() || '';
      process.env.PATH = `${machinePath};${userPath}`;
      console.log('[deps] PATH refreshed');
    } catch (err) {
      console.log('[deps] PATH refresh failed:', err.message);
    }
  }

  // macOS: check if Homebrew is available
  function hasBrew() {
    try {
      execSync('brew --version', { encoding: 'utf-8', shell: true, timeout: 5000, stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  // macOS: install a package via Homebrew
  function brewInstall(formula, name) {
    return new Promise((resolve) => {
      console.log(`[deps] Installing ${name} via brew...`);
      const proc = spawn('brew', ['install', formula], {
        shell: true,
        env: process.env,
      });
      let output = '';
      proc.stdout?.on('data', (d) => { output += d.toString(); });
      proc.stderr?.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => {
        console.log(`[deps] ${name} brew install exited with code ${code}`);
        resolve({ ok: code === 0, output });
      });
      proc.on('error', (err) => {
        console.log(`[deps] ${name} brew install error:`, err.message);
        resolve({ ok: false, output: err.message });
      });
    });
  }

  // macOS: install Node.js via official .pkg installer (fallback when no Homebrew)
  function macInstallNodePkg() {
    return new Promise((resolve) => {
      console.log('[deps] Installing Node.js via official macOS .pkg...');
      const tmpPkg = path.join(app.getPath('temp'), 'node-lts.pkg');
      const pkgUrl = 'https://nodejs.org/dist/v22.16.0/node-v22.16.0.pkg';

      // Download the .pkg
      const curl = spawn('curl', ['-L', '-o', tmpPkg, pkgUrl], { timeout: 300000 });
      let dlOutput = '';
      curl.stderr?.on('data', (d) => { dlOutput += d.toString(); });
      curl.on('close', (dlCode) => {
        if (dlCode !== 0) {
          console.log('[deps] Node.js .pkg download failed:', dlOutput);
          resolve({ ok: false, output: 'Download failed' });
          return;
        }

        // Install the .pkg (requires admin — will prompt for password via macOS GUI)
        const installer = spawn('sudo', ['installer', '-pkg', tmpPkg, '-target', '/'], {
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        let instOutput = '';
        installer.stdout?.on('data', (d) => { instOutput += d.toString(); });
        installer.stderr?.on('data', (d) => { instOutput += d.toString(); });
        installer.on('close', (instCode) => {
          // Clean up
          try { fs.unlinkSync(tmpPkg); } catch {}
          console.log(`[deps] Node.js .pkg install exited with code ${instCode}`);
          resolve({ ok: instCode === 0, output: instOutput });
        });
        installer.on('error', (err) => {
          try { fs.unlinkSync(tmpPkg); } catch {}
          resolve({ ok: false, output: err.message });
        });
      });
      curl.on('error', (err) => {
        resolve({ ok: false, output: err.message });
      });
    });
  }

  ipcMain.handle('install-system-deps', async () => {
    const IS_WIN = process.platform === 'win32';
    const IS_MAC = process.platform === 'darwin';
    const results = { node: 'skip', git: 'skip', python: 'skip' };

    // Check package manager availability
    let hasWinget = false;
    let hasBrw = false;
    if (IS_WIN) {
      try {
        execSync('winget --version', { encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true, stdio: 'pipe' });
        hasWinget = true;
      } catch {}
    } else if (IS_MAC) {
      hasBrw = hasBrew();
    }

    // Node.js
    if (!isCommandAvailable('node')) {
      if (hasWinget) {
        const r = await wingetInstall('OpenJS.NodeJS.LTS', 'Node.js');
        results.node = r.ok ? 'installed' : 'failed';
        if (r.ok) refreshPath();
      } else if (IS_MAC) {
        // Try Homebrew first, fall back to official .pkg
        let r;
        if (hasBrw) {
          r = await brewInstall('node', 'Node.js');
        }
        if (!r?.ok) {
          r = await macInstallNodePkg();
        }
        results.node = r.ok ? 'installed' : 'failed';
        if (r.ok) refreshPath();
      } else {
        results.node = 'missing';
      }
    } else {
      results.node = 'ok';
    }

    // Git
    if (!isCommandAvailable('git')) {
      if (hasWinget) {
        const r = await wingetInstall('Git.Git', 'Git');
        results.git = r.ok ? 'installed' : 'failed';
        if (r.ok) refreshPath();
      } else if (IS_MAC && hasBrw) {
        const r = await brewInstall('git', 'Git');
        results.git = r.ok ? 'installed' : 'failed';
        if (r.ok) refreshPath();
      } else {
        // macOS includes git via Xcode CLT; if missing, prompt user
        results.git = 'missing';
      }
    } else {
      results.git = 'ok';
    }

    // Python
    if (!isCommandAvailable('python') && !isCommandAvailable('python3')) {
      if (hasWinget) {
        const r = await wingetInstall('Python.Python.3.13', 'Python');
        results.python = r.ok ? 'installed' : 'failed';
        if (r.ok) refreshPath();
      } else if (IS_MAC && hasBrw) {
        const r = await brewInstall('python@3.13', 'Python');
        results.python = r.ok ? 'installed' : 'failed';
        if (r.ok) refreshPath();
      } else {
        results.python = 'missing';
      }
    } else {
      results.python = 'ok';
    }

    const allOk = Object.values(results).every(v => v === 'ok' || v === 'installed' || v === 'skip');
    const missing = Object.entries(results).filter(([, v]) => v === 'missing' || v === 'failed').map(([k]) => k);
    return { ok: allOk, results, missing };
  });

  // Install Node dependencies in workspace
  ipcMain.handle('install-node-deps', async () => {
    // Verify package.json exists first
    const pkgJson = path.join(BACKEND_DIR, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      return { ok: false, output: 'package.json not found at ' + pkgJson };
    }

    // Check if npm is available
    try {
      execSync('npm --version', { encoding: 'utf-8', shell: true, timeout: 10000, windowsHide: true });
    } catch {
      return { ok: false, output: 'npm_not_found', error: 'Node.js is not installed. Please install Node.js from https://nodejs.org and restart Outdoors.' };
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
      npm.on('error', (err) => {
        resolve({ ok: false, output: err.message, error: 'Failed to run npm: ' + err.message });
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

  // Check if uvx is installed
  ipcMain.handle('check-uvx-installed', async () => {
    const found = findUvxPath();
    if (found) {
      resolvedUvxCmd = found;
      return { installed: true };
    }
    return { installed: false };
  });

  // Install uvx (via pip install uv)
  ipcMain.handle('install-uvx', async () => {
    return new Promise((resolve) => {
      // Try pip first, then pip3, then python -m pip
      const commands = [
        { cmd: 'pip', args: ['install', 'uv'] },
        { cmd: 'pip3', args: ['install', 'uv'] },
        { cmd: 'python', args: ['-m', 'pip', 'install', 'uv'] },
        { cmd: 'python3', args: ['-m', 'pip', 'install', 'uv'] },
      ];

      let tried = 0;
      function tryNext() {
        if (tried >= commands.length) {
          resolve({ ok: false, error: 'Could not install uv. Please run "pip install uv" manually.' });
          return;
        }
        const { cmd, args } = commands[tried++];
        const proc = spawn(cmd, args, { shell: true, env: process.env, windowsHide: true });
        let output = '';
        proc.stdout?.on('data', (d) => { output += d.toString(); });
        proc.stderr?.on('data', (d) => { output += d.toString(); });
        proc.on('error', () => tryNext());
        proc.on('close', (code) => {
          if (code === 0) {
            // Cache the path after successful install
            resolvedUvxCmd = findUvxPath();
            resolve({ ok: true });
          } else {
            tryNext();
          }
        });
      }
      tryNext();
    });
  });

  // Pre-download workspace-mcp so it's cached for the auth step
  ipcMain.handle('precache-workspace-mcp', async () => {
    const uvx = resolvedUvxCmd || findUvxPath();
    if (!uvx) return { ok: false };
    return new Promise((resolve) => {
      const proc = spawn(uvx, ['workspace-mcp', '--help'], {
        shell: true, windowsHide: true, timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.on('close', () => resolve({ ok: true }));
      proc.on('error', () => resolve({ ok: false }));
      // Timeout after 2 minutes
      setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: true }); }, 120000);
    });
  });

  // Install whisper.cpp and base model in background (for voice message transcription)
  ipcMain.handle('install-whisper', async () => {
    const IS_WIN = process.platform === 'win32';
    const whisperDir = IS_WIN
      ? path.join(process.env.LOCALAPPDATA || '', 'whisper-cpp')
      : path.join(process.env.HOME || '', '.local', 'share', 'whisper-cpp');
    const modelDir = path.join(whisperDir, 'models');
    const modelPath = path.join(modelDir, 'ggml-base.bin');
    const whisperBin = IS_WIN
      ? path.join(whisperDir, 'whisper-cli.exe')
      : path.join(whisperDir, 'whisper-cli');

    // Skip if already installed
    if (fs.existsSync(whisperBin) && fs.existsSync(modelPath)) {
      return { ok: true, cached: true };
    }

    fs.mkdirSync(modelDir, { recursive: true });

    // Download model if missing
    if (!fs.existsSync(modelPath)) {
      const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
      try {
        await new Promise((resolve, reject) => {
          const cmd = IS_WIN ? 'curl' : 'curl';
          execFile(cmd, ['-L', '-o', modelPath, modelUrl], {
            shell: IS_WIN, timeout: 300000, windowsHide: true
          }, (err) => err ? reject(err) : resolve());
        });
      } catch (err) {
        return { ok: false, error: 'Failed to download whisper model: ' + err.message };
      }
    }

    // Download whisper binary if missing
    if (!fs.existsSync(whisperBin)) {
      if (IS_WIN) {
        // Download pre-built Windows binary
        const zipUrl = 'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-cli-bin-x64.zip';
        const zipPath = path.join(whisperDir, 'whisper.zip');
        try {
          await new Promise((resolve, reject) => {
            execFile('curl', ['-L', '-o', zipPath, zipUrl], {
              shell: true, timeout: 300000, windowsHide: true
            }, (err) => err ? reject(err) : resolve());
          });
          // Extract zip
          await new Promise((resolve, reject) => {
            execFile('powershell.exe', ['-NoProfile', '-Command',
              `Expand-Archive -Path '${zipPath}' -DestinationPath '${whisperDir}' -Force`],
              { timeout: 30000, windowsHide: true },
              (err) => err ? reject(err) : resolve());
          });
          // Clean up zip
          try { fs.unlinkSync(zipPath); } catch {}
        } catch (err) {
          return { ok: false, error: 'Failed to download whisper binary: ' + err.message };
        }
      } else {
        // macOS: build from source or use brew
        try {
          await new Promise((resolve, reject) => {
            execFile('brew', ['install', 'whisper-cpp'], {
              timeout: 300000
            }, (err) => err ? reject(err) : resolve());
          });
        } catch {
          return { ok: false, error: 'Install whisper.cpp via: brew install whisper-cpp' };
        }
      }
    }

    // Also check for ffmpeg (needed for audio conversion)
    return new Promise((resolve) => {
      execFile('ffmpeg', ['-version'], { shell: IS_WIN, timeout: 5000, windowsHide: true }, (err) => {
        resolve({ ok: true, ffmpeg: !err });
      });
    });
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
      const termProc = platform.openTerminalWithCommand('claude', ['/login']);
      if (termProc) termProc.unref();

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
      const exePath = platform.findChrome();

      if (!exePath) return { found: false, profiles: [] };

      // Read profiles from Local State
      const userDataDir = platform.getChromeUserDataDir();
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
      const userDataDir = platform.getChromeUserDataDir();
      const automationDir = platform.getAutomationProfileDir();
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
      const automationDir = platform.getAutomationProfileDir();
      const cdpPort = 9222;

      const chromeArgs = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${automationDir}`,
        `--profile-directory=Default`,
        `--no-first-run`,
        `--no-default-browser-check`,
        `--disable-extensions-except=`,
        `--disable-background-extensions`,
        `https://mail.google.com/`,
      ];
      await platform.launchChrome(exePath, chromeArgs);

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
  // Uses CDP to check page URLs. Sign-in is complete ONLY when a page
  // lands on a known post-login URL. This is a blacklist approach — we only
  // trigger on definitive "signed in" destinations, so any SSO/2FA/SAML
  // flow can take as long as it needs without false positives.
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

      // Only check actual pages — not iframes, service workers, or background pages
      // (Gmail embeds iframes and service workers with mail.google.com URLs that are always present)
      const realPages = pages.filter(p => p.type === 'page');

      // Sign-in is complete when a top-level page is on mail.google.com
      const signedInPage = realPages.find(p => {
        const url = (p.url || '').toLowerCase();
        return url.includes('mail.google.com');
      });

      if (signedInPage) {
        // Read email from Preferences
        const automationDir = platform.getAutomationProfileDir();
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

  // Helper: close Chrome tabs on localhost:8000 (the auth callback page) via CDP
  function closeAuthTab() {
    const http = require('http');
    http.get('http://localhost:9222/json/list', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const pages = JSON.parse(data);
          for (const page of pages) {
            if (page.url && page.url.includes('localhost:8000')) {
              http.get(`http://localhost:9222/json/close/${page.id}`, { timeout: 3000 }, () => {});
            }
          }
        } catch {}
      });
    }).on('error', () => {});
  }

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
      platform.killProcessByName(platform.IS_WIN ? 'chrome.exe' : 'Google Chrome', 'AutomationProfile');

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

      // Use cached uvx path, or try to find it now, or fall back to python -m uv tool run
      let uvxCmd = resolvedUvxCmd || findUvxPath();
      let useUvx = !!uvxCmd;
      if (!uvxCmd) {
        // Fallback: use python -m uv tool run instead of uvx
        uvxCmd = process.platform === 'win32' ? 'python' : 'python3';
      }
      resolvedUvxCmd = uvxCmd;

      // workspace-mcp auth flow using --cli mode:
      // 1. Run start_google_auth via --cli — prints auth URL and spawns callback server on port 8000
      // 2. The Python subprocess stays alive to handle the OAuth callback
      // 3. Open the auth URL in AutomationProfile Chrome
      // 4. Poll for credential file to confirm success

      // Clear Google credentials before auth to prevent cross-account leaks.
      // On first setup: wipe all (prevents stale Claude CLI tokens from other accounts).
      // On re-auth (config already has a googleEmail): only clear the target account
      // so we don't nuke other valid accounts when adding a second one.
      const credsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials');
      try {
        if (fs.existsSync(credsDir)) {
          let cfg = {};
          try { if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
          const isReAuth = !!cfg.googleEmail;
          if (isReAuth) {
            // Re-auth: only clear the specific account being authorized
            const targetEmail = getUserGoogleEmail();
            if (targetEmail) {
              const targetFile = path.join(credsDir, `${targetEmail}.json`);
              if (fs.existsSync(targetFile)) {
                try { fs.unlinkSync(targetFile); } catch {}
                console.log(`[google-auth] Cleared credentials for ${targetEmail} to force fresh sign-in`);
              }
            }
          } else {
            // First setup: clear everything to prevent stale tokens from Claude CLI
            for (const file of fs.readdirSync(credsDir)) {
              try { fs.unlinkSync(path.join(credsDir, file)); } catch {}
            }
            console.log('[google-auth] First setup — cleared all existing credentials');
          }
        }
      } catch {}
      let existingCredFiles = new Set();

      return new Promise((resolve) => {
        const env = {
          ...process.env,
          GOOGLE_OAUTH_CLIENT_ID: creds.clientId,
          GOOGLE_OAUTH_CLIENT_SECRET: creds.clientSecret,
        };

        // Kill anything already on port 8000 before starting auth server
        platform.killPort(8000);

        // ── Phase 1: Start workspace-mcp with streamable-http transport ──
        // This starts an HTTP server on port 8000 that:
        // - Accepts MCP JSON-RPC calls via HTTP POST
        // - Handles the OAuth callback at /oauth2callback
        // - Stays alive until we kill it
        const serverArgs = useUvx
          ? ['workspace-mcp', '--transport', 'streamable-http', '--tools', ...toolsList]
          : ['-m', 'uv', 'tool', 'run', 'workspace-mcp', '--transport', 'streamable-http', '--tools', ...toolsList];

        console.log('[google-auth] Starting MCP HTTP server:', uvxCmd, serverArgs.join(' '));
        const mcpProc = spawn(uvxCmd, serverArgs, {
          env, windowsHide: true, shell: true,
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

        let stderrLog = '';
        mcpProc.stderr?.on('data', (d) => {
          const text = d.toString();
          stderrLog += text;
          console.log('[google-auth:stderr]', text.trim().slice(0, 200));
        });
        mcpProc.stdout?.on('data', (d) => console.log('[google-auth:stdout]', d.toString().trim().slice(0, 200)));

        mcpProc.on('close', (code) => {
          console.log('[google-auth] process exited with code:', code);
          if (!serverReady) {
            const debugInfo = `uvxCmd=${uvxCmd}, useUvx=${useUvx}, code=${code}, stderr=${stderrLog.slice(-300)}`;
            console.error('[google-auth] Process died before server ready:', debugInfo);
            // Write debug log for user to share
            try { fs.writeFileSync(path.join(app.getPath('userData'), 'google-auth-error.log'), `${new Date().toISOString()}\n${debugInfo}\n`); } catch {}
            resolve({ ok: false, error: `Auth server crashed (code ${code}). Debug: ${stderrLog.slice(-200) || 'no output'}` });
          }
        });

        // Poll port 8000 until the server is ready (more reliable than stderr parsing)
        const http = require('http');
        let pollAttempts = 0;
        const portPoll = setInterval(() => {
          pollAttempts++;
          if (pollAttempts > 120) { // 60 seconds — first run downloads workspace-mcp package
            clearInterval(portPoll);
            if (!serverReady) {
              console.error('[google-auth] Server never bound to port 8000');
              try { mcpProc.kill(); } catch {}
              resolve({ ok: false, error: 'Auth server failed to start.' });
            }
            return;
          }
          const req = http.get('http://localhost:8000/mcp', { timeout: 1000 }, (res) => {
            res.resume();
            if (!serverReady) {
              serverReady = true;
              clearInterval(portPoll);
              console.log('[google-auth] Port 8000 ready, calling doMcpAuth');
              doMcpAuth();
            }
          });
          req.on('error', () => {}); // not ready yet
          req.on('timeout', () => req.destroy());
        }, 500);

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

              // ── Phase 2: Open auth URL ──
              // On macOS, launchChrome with --args is unreliable when Chrome is already
              // running (args are silently discarded). The OAuth flow just needs any
              // browser to complete login and redirect to localhost:8000.
              if (process.platform === 'darwin') {
                console.log('[google-auth] macOS: opening auth URL in default browser');
                shell.openExternal(authUrl);
              } else {
                const automationDir = platform.getAutomationProfileDir();
                const chromeExe = platform.findChrome();

                if (chromeExe) {
                  const chromeArgs = [
                    `--remote-debugging-port=9222`,
                    `--user-data-dir=${automationDir}`,
                    `--profile-directory=Default`,
                    `--no-first-run`,
                    `--no-default-browser-check`,
                    authUrl,
                  ];
                  platform.launchChrome(chromeExe, chromeArgs).catch(err => {
                    console.error('[google-auth] Chrome launch error, falling back to default browser:', err.message);
                    shell.openExternal(authUrl);
                  });
                } else {
                  console.log('[google-auth] Chrome not found, opening in default browser');
                  shell.openExternal(authUrl);
                }
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

                // Validate that the new credential has a unique refresh token
                // (prevents workspace-mcp from writing the same token under a different filename)
                try {
                  const newCredPath = path.join(credsDir, `${selectedEmail}.json`);
                  const newCred = JSON.parse(fs.readFileSync(newCredPath, 'utf-8'));
                  const otherFiles = fs.readdirSync(credsDir).filter(f => f.endsWith('.json') && f !== `${selectedEmail}.json`);
                  for (const otherFile of otherFiles) {
                    try {
                      const otherCred = JSON.parse(fs.readFileSync(path.join(credsDir, otherFile), 'utf-8'));
                      if (otherCred.refresh_token && otherCred.refresh_token === newCred.refresh_token) {
                        console.warn(`[google-auth] WARNING: ${selectedEmail} has the same refresh_token as ${otherFile} — tokens may be crossed. Removing duplicate.`);
                        fs.unlinkSync(newCredPath);
                      }
                    } catch {}
                  }
                } catch {}

                try {
                  let cfg = {};
                  if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
                  cfg.googleServices = toolsList;
                  cfg.googleEmail = selectedEmail;
                  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
                } catch {}
                // Kill the auth server — it's no longer needed and blocks port 8000
                try { mcpProc.kill(); } catch {}
                // Close the localhost:8000 Chrome tab so user doesn't see the ugly success page
                closeAuthTab();
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
                    const reAuthEmail = file.replace('.json', '');
                    try {
                      let cfg = {};
                      if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
                      cfg.googleServices = toolsList;
                      cfg.googleEmail = reAuthEmail;
                      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
                    } catch {}
                    try { mcpProc.kill(); } catch {}
                    closeAuthTab();
                    if (mainWindow && !mainWindow.isDestroyed()) {
                      mainWindow.webContents.send('google-auth-complete', { ok: true, email: reAuthEmail });
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
  ipcMain.handle('stop-backend', async () => {
    backendStoppedByUser = true;
    if (backendProcess) {
      const pid = backendProcess.pid;
      try {
        if (platform.IS_WIN) {
          // Kill entire process tree on Windows
          execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        } else {
          process.kill(-pid, 'SIGTERM');
        }
      } catch {}
      backendProcess = null;
      // Also kill any Chrome automation instances
      platform.killProcessByName(platform.IS_WIN ? 'chrome.exe' : 'Google Chrome', 'AutomationProfile');
      return { ok: true };
    }
    return { ok: true, alreadyStopped: true };
  });

  ipcMain.handle('start-backend', async () => {
    backendStoppedByUser = false;
    if (backendProcess) return { ok: true, alreadyRunning: true };

    // Pre-check: node_modules must exist (npm install must have succeeded)
    const nodeModules = path.join(BACKEND_DIR, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
      return { ok: false, error: 'Dependencies not installed. Please restart the app to run setup again.' };
    }

    return startBackend();
  });

  // Reconnect WhatsApp (delete auth_state + restart)
  ipcMain.handle('reconnect-whatsapp', async () => {
    try {
      let port = 3847;
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
          if (cfg.port) port = cfg.port;
        }
      } catch {}
      const res = await fetch(`http://127.0.0.1:${port}/api/whatsapp/reconnect`, { method: 'POST' });
      return await res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }
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

  // ── Output Files (bot/outputs) ────────────────────────────────────────────

  ipcMain.handle('list-output-files', async () => {
    const outputDir = path.join(BACKEND_DIR, 'bot', 'outputs');
    const results = [];
    function walk(dir, rel) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          walk(fullPath, relPath);
        } else {
          try {
            const stat = fs.statSync(fullPath);
            results.push({ name: entry.name, relativePath: relPath, size: stat.size, modified: stat.mtimeMs });
          } catch {
            results.push({ name: entry.name, relativePath: relPath, size: 0, modified: 0 });
          }
        }
      }
    }
    walk(outputDir, '');
    return results;
  });

  ipcMain.handle('read-output-file', async (_event, relativePath) => {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Invalid path');
    return fs.readFileSync(path.join(BACKEND_DIR, 'bot', 'outputs', relativePath), 'utf-8');
  });

  ipcMain.handle('get-output-file-path', async (_event, relativePath) => {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Invalid path');
    return path.join(BACKEND_DIR, 'bot', 'outputs', relativePath);
  });

  ipcMain.handle('save-output-file', async (_event, relativePath, content) => {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Invalid path');
    const filePath = path.join(BACKEND_DIR, 'bot', 'outputs', relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  });

  ipcMain.handle('delete-output-file', async (_event, relativePath) => {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Invalid path');
    const filePath = path.join(BACKEND_DIR, 'bot', 'outputs', relativePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      // Clean up empty parent directories
      let dir = path.dirname(filePath);
      const outputRoot = path.join(BACKEND_DIR, 'bot', 'outputs');
      while (dir !== outputRoot && dir.startsWith(outputRoot)) {
        try {
          const entries = fs.readdirSync(dir);
          if (entries.length === 0) { fs.rmdirSync(dir); dir = path.dirname(dir); }
          else break;
        } catch { break; }
      }
    }
    return { ok: true };
  });

  ipcMain.handle('open-output-file', async (_event, relativePath) => {
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) throw new Error('Invalid path');
    const filePath = path.join(BACKEND_DIR, 'bot', 'outputs', relativePath);
    if (fs.existsSync(filePath)) {
      await shell.openPath(filePath);
    }
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
          const uvxIsReal = uvxCommand && uvxCommand !== 'uvx' && fs.existsSync(uvxCommand);
          const wsCmd = uvxIsReal ? uvxCommand : (process.platform === 'win32' ? 'python' : 'python3');
          const wsArgs = uvxIsReal
            ? ['workspace-mcp']
            : ['-m', 'uv', 'tool', 'run', 'workspace-mcp'];
          if (services && services.length > 0) wsArgs.push('--tools', ...services);

          // Get the user's Google email from AutomationProfile
          const userEmail = getUserGoogleEmail();

          const mcpConfig = {
            mcpServers: {
              google_workspace: {
                type: 'stdio',
                command: wsCmd,
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

DEPTH — GO DEEP, NOT SHALLOW:
This scan should be THOROUGH. Shallow profiles are useless. Specific instructions:
- Gmail: Read at least 50 SENT emails spanning the last 3 months (use in:sent newer_than:3m). Also read 20 RECEIVED emails to understand communication dynamics. Search across categories.
- Calendar: Scan last 4 weeks + next 4 weeks. Check recurring events over a longer window.
- Contacts: Scan top 200 or all contacts. Cross-reference with Gmail frequent recipients.
- Drive: Go 3 levels deep. Search for files modified in the last 30 days.
- Docs: Read 10-15 recent Google Docs across different types (notes, essays, reports, project docs).

CRITICAL — WRITING VOICE:
The writing-voice.md file is the MOST IMPORTANT output of this scan. It enables the assistant to write like the user instead of sounding like a robot. To create it:
- Read at least 50 SENT emails spanning 3+ months (use search_gmail_messages with in:sent newer_than:3m, then get_gmail_messages_content_batch)
- Include emails to different types of recipients (professional, personal, casual, family)
- Analyze email THREADS to see how tone shifts through a conversation
- Extract ACTUAL phrases and sentence patterns the user uses — not generic descriptions
- Extract subject line patterns (how they title emails)
- Focus on what makes this person's writing DISTINCTIVE from generic email
- Include 8-12 real anonymized example phrasings (replace names with [Name], topics with [Topic])
- Note how their voice shifts between contexts (professional vs personal vs quick reply vs thread)

RULES:
- Only READ, never modify the user's data
- Write PATTERNS and INSIGHTS, not raw data (no full email bodies, no phone numbers, no passwords)
- Be specific: "uses casual tone, typically 2-3 short sentences, signs off with 'cheers'" beats "mixed tone"
- Replace [YYYY-MM-DD] with ${today}
- If a service has no data or fails, write "No data available" in that file and move on
- Keep each file under 80 lines (except writing-voice.md which can be up to 100 lines)

Start by reading the skill file, then scan each service systematically.`;

      // Clean env — remove CLAUDECODE to avoid nested session error
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;

      // Ensure mcp-bot.json exists in outdoorsv4 with google_workspace
      const v4Dir = IS_DEV
        ? path.join(__dirname, '..', '..', '..', 'outdoorsv4')
        : path.join(WORKSPACE, 'outdoorsv4');
      const botMcpPath = path.join(v4Dir, 'mcp-bot.json');

      // Use the full .claude.json as MCP config — same config that worked before
      const mcpConfigPath = path.join(BACKEND_DIR, '.claude.json');

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

        onboardingScan = { running: true, progress: 5, status: 'Starting scan...' };
        const broadcastScanProgress = () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('onboarding-progress', onboardingScan.status);
            mainWindow.webContents.send('onboarding-scan-state', { ...onboardingScan });
          }
        };
        broadcastScanProgress();

        // Estimate progress from service keywords in stdout
        const serviceOrder = services || [];
        let lastServiceIdx = 0;
        const totalServices = serviceOrder.length || 1;

        proc.stdout?.on('data', (d) => {
          stdout += d.toString();
          try { fs.appendFileSync(runLog, `[stdout] ${d.toString()}\n`); } catch {}

          // Estimate progress from service mentions
          const chunk = d.toString().toLowerCase();
          for (let i = lastServiceIdx; i < serviceOrder.length; i++) {
            if (chunk.includes(serviceOrder[i])) {
              lastServiceIdx = i + 1;
              onboardingScan.progress = Math.min(90, Math.round((lastServiceIdx / totalServices) * 85) + 5);
              onboardingScan.status = `Scanning ${serviceOrder[i]}...`;
              break;
            }
          }
          // Slow tick if no service keyword found
          if (onboardingScan.progress < 85) {
            onboardingScan.progress = Math.min(85, onboardingScan.progress + 1);
          }
          broadcastScanProgress();
        });
        proc.stderr?.on('data', (d) => {
          stderr += d.toString();
          try { fs.appendFileSync(runLog, `[stderr] ${d.toString().slice(0, 500)}\n`); } catch {}
        });

        proc.on('close', (code) => {
          try { fs.appendFileSync(scanLog, `[close] code=${code}\nstdout_len=${stdout.length}\nstderr_last500=${stderr.slice(-500)}\n`); } catch {}
          onboardingScan = { running: false, progress: 100, status: code === 0 ? 'Complete' : 'Failed' };
          broadcastScanProgress();
          // Auto-run filesystem index after successful scan (in case user skipped the wizard page)
          if (code === 0) {
            runFilesystemIndex().catch(() => {});
          }
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

        // Timeout after 45 minutes — deep scan reads 50+ emails and 10+ docs
        setTimeout(() => {
          try { proc.kill(); } catch {}
        }, 2700000);
      });

    } catch (err) {
      return { ok: false, error: 'Error: ' + err.message };
    }
  });

  // Query onboarding scan state (used by dashboard after setup wizard skips)
  ipcMain.handle('get-onboarding-scan-state', () => ({ ...onboardingScan }));

  // ── Filesystem Index (local scan, no Claude) ──────────────────────────────

  async function runFilesystemIndex() {
    try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
      const IS_WIN = process.platform === 'win32';
      const IS_MAC = process.platform === 'darwin';

      const SKIP_DIRS = new Set([
        'node_modules', '.git', '__pycache__', '.cache', '.vscode',
        '.idea', 'dist', 'build', '.next', '.nuxt', 'vendor',
        'AppData', '$Recycle.Bin', 'System Volume Information',
      ]);

      // Candidate directories to scan
      const candidates = [
        path.join(home, 'Desktop'),
        path.join(home, 'Documents'),
        path.join(home, 'Downloads'),
        path.join(home, 'Pictures'),
        IS_WIN ? path.join(home, 'Videos') : IS_MAC ? path.join(home, 'Movies') : null,
        path.join(home, 'Music'),
        path.join(home, 'Code'),
        path.join(home, 'Projects'),
        path.join(home, 'repos'),
        IS_MAC ? path.join(home, 'Developer') : null,
        path.join(home, 'OneDrive'),
        path.join(home, 'OneDrive - Personal'),
        path.join(home, 'Google Drive'),
        path.join(home, 'Dropbox'),
        IS_WIN ? path.join(home, 'source', 'repos') : null,
      ].filter(Boolean);

      function scanDir(dir, maxDepth, currentDepth = 0) {
        const result = { path: dir, folders: [], files: 0, extCounts: {} };
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
            if (entry.isDirectory()) {
              result.folders.push(entry.name);
              if (currentDepth < maxDepth) {
                const sub = scanDir(path.join(dir, entry.name), maxDepth, currentDepth + 1);
                result.files += sub.files;
                for (const [ext, count] of Object.entries(sub.extCounts)) {
                  result.extCounts[ext] = (result.extCounts[ext] || 0) + count;
                }
              }
            } else {
              result.files++;
              const dot = entry.name.lastIndexOf('.');
              if (dot > 0) {
                const ext = entry.name.slice(dot).toLowerCase();
                result.extCounts[ext] = (result.extCounts[ext] || 0) + 1;
              }
            }
          }
        } catch {}
        return result;
      }

      function detectProjectType(dir) {
        const markers = [
          ['package.json', 'Node.js'],
          ['requirements.txt', 'Python'],
          ['Pipfile', 'Python'],
          ['pyproject.toml', 'Python'],
          ['Cargo.toml', 'Rust'],
          ['go.mod', 'Go'],
          ['pom.xml', 'Java/Maven'],
          ['build.gradle', 'Java/Gradle'],
          ['Gemfile', 'Ruby'],
          ['composer.json', 'PHP'],
          ['.sln', 'C#/.NET'],
        ];
        for (const [file, lang] of markers) {
          try {
            if (fs.existsSync(path.join(dir, file))) return lang;
          } catch {}
        }
        return null;
      }

      const sections = [];
      const projects = [];
      const cloudSync = [];

      for (const dir of candidates) {
        if (!fs.existsSync(dir)) continue;
        const scan = scanDir(dir, 2);
        const topExts = Object.entries(scan.extCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([ext, count]) => `${count} ${ext}`)
          .join(', ');

        sections.push(`| ${dir} | ${scan.files} files, ${scan.folders.length} folders | ${topExts || 'empty'} |`);

        // Check for project directories (folders with package.json, etc.)
        if (['Code', 'Projects', 'repos', 'source', 'Developer'].some(k => dir.includes(k))) {
          for (const folder of scan.folders) {
            const projectDir = path.join(dir, folder);
            const type = detectProjectType(projectDir);
            if (type) {
              const subScan = scanDir(projectDir, 1);
              const exts = Object.entries(subScan.extCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([ext, count]) => `${count} ${ext}`)
                .join(', ');
              projects.push(`- ${projectDir} — ${type} (${exts || 'no files'})`);
            }
          }
        }

        // Detect cloud sync
        if (dir.includes('OneDrive')) cloudSync.push(`- OneDrive: ${dir}`);
        if (dir.includes('Google Drive')) cloudSync.push(`- Google Drive: ${dir}`);
        if (dir.includes('Dropbox')) cloudSync.push(`- Dropbox: ${dir}`);
      }

      const today = new Date().toISOString().split('T')[0];
      const content = `# Filesystem Index

## Key Directories
| Path | Contents | Notable |
|------|----------|---------|
${sections.join('\n')}

${projects.length > 0 ? `## Project Directories\n${projects.join('\n')}` : '## Project Directories\nNo project directories detected.'}

${cloudSync.length > 0 ? `## Cloud Sync\n${cloudSync.join('\n')}` : '## Cloud Sync\nNo cloud sync folders detected.'}

Updated: ${today}
`;

      const knowledgeDir = path.join(BACKEND_DIR, 'bot', 'memory', 'knowledge');
      fs.mkdirSync(knowledgeDir, { recursive: true });
      fs.writeFileSync(path.join(knowledgeDir, 'filesystem-index.md'), content, 'utf-8');

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  ipcMain.handle('run-filesystem-index', () => runFilesystemIndex());

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

  // ── Trigger CRUD ────────────────────────────────────────────────────────────

  function readConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {}
    return {};
  }

  function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }

  async function notifyBackendTriggersChanged() {
    try {
      const cfg = readConfig();
      const port = cfg.port || 3847;
      const http = require('http');
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/triggers/reload', method: 'POST' });
      req.on('error', () => {});
      req.end();
    } catch {}
  }

  ipcMain.handle('get-triggers', async () => {
    const cfg = readConfig();
    return cfg.triggers || [];
  });

  ipcMain.handle('save-trigger', async (_event, trigger) => {
    const cfg = readConfig();
    if (!cfg.triggers) cfg.triggers = [];
    const idx = cfg.triggers.findIndex(t => t.id === trigger.id);
    if (idx >= 0) {
      cfg.triggers[idx] = trigger;
    } else {
      cfg.triggers.push(trigger);
    }
    writeConfig(cfg);
    await notifyBackendTriggersChanged();
    return { ok: true };
  });

  ipcMain.handle('delete-trigger', async (_event, triggerId) => {
    const cfg = readConfig();
    if (!cfg.triggers) return { ok: true };
    cfg.triggers = cfg.triggers.filter(t => t.id !== triggerId);
    writeConfig(cfg);
    await notifyBackendTriggersChanged();
    return { ok: true };
  });

  ipcMain.handle('toggle-trigger', async (_event, triggerId, enabled) => {
    const cfg = readConfig();
    if (!cfg.triggers) return { ok: false };
    const trigger = cfg.triggers.find(t => t.id === triggerId);
    if (!trigger) return { ok: false };
    trigger.enabled = enabled;
    writeConfig(cfg);
    await notifyBackendTriggersChanged();
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
  let uvxCommand = resolvedUvxCmd || findUvxPath() || 'uvx';

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
    // Read selected Google services from config, filtered by what's actually authorized
    let googleTools = [];
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (cfg.googleServices && cfg.googleServices.length > 0) {
          googleTools = cfg.googleServices;
        }
      }
    } catch {}
    // Filter to only services with valid scopes in the credential
    // Without this, workspace-mcp demands re-auth for missing scopes
    try {
      const credDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials');
      if (fs.existsSync(credDir)) {
        const credFiles = fs.readdirSync(credDir).filter(f => f.endsWith('.json'));
        if (credFiles.length > 0) {
          const cred = JSON.parse(fs.readFileSync(path.join(credDir, credFiles[credFiles.length - 1]), 'utf-8'));
          const scopes = (cred.scopes || []).join(' ');
          const scopeMap = { gmail:'gmail', calendar:'calendar', contacts:'contacts', drive:'drive', docs:'documents', sheets:'spreadsheets', slides:'presentations', tasks:'tasks', forms:'forms', search:'cse' };
          googleTools = googleTools.filter(svc => {
            const kw = scopeMap[svc];
            return !kw || scopes.includes(kw);
          });
        }
      }
    } catch {}

    const wsArgs = ['workspace-mcp'];
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
    // If uvxCommand is a real path to uvx.exe, use it directly
    // Otherwise fall back to python -m uv tool run
    const uvxIsReal = uvxCommand && uvxCommand !== 'uvx' && fs.existsSync(uvxCommand);
    const wsCmd = uvxIsReal ? uvxCommand : (process.platform === 'win32' ? 'python' : 'python3');
    const wsArgs = uvxIsReal
      ? ['workspace-mcp']
      : ['-m', 'uv', 'tool', 'run', 'workspace-mcp'];
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
      command: wsCmd,
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

    // Kill any stale process holding the backend port (e.g. from a previous
    // session that wasn't cleaned up, or a reinstall that didn't kill children)
    let port = 3847;
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (cfg.port) port = cfg.port;
      }
    } catch {}
    try {
      const stalePids = platform.getPortProcesses(port);
      if (stalePids.length > 0) {
        console.log(`[backend] Killing stale process(es) on port ${port}:`, stalePids);
        for (const pid of stalePids) {
          platform.killProcessByPid(pid);
        }
      }
    } catch {}

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
      // Show system notification when bot sends a response
      const sentMatch = text.match(/Sent to (.+?) \((\d+) chars\)/);
      if (sentMatch) {
        const { Notification } = require('electron');
        if (Notification.isSupported()) {
          new Notification({
            title: 'Outdoors',
            body: `Replied to ${sentMatch[1]}`,
            silent: true,
          }).show();
        }
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

      // Auto-restart if backend crashes after successful startup (but not if user stopped it)
      if (backendStoppedByUser) {
        console.log('[backend] Stopped by user — not restarting.');
      } else if (fs.existsSync(SETUP_DONE_FLAG) && backendRestarts < MAX_BACKEND_RESTARTS) {
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

function checkClaudeAuthAndNotify() {
  const cmd = getClaudeCmd();
  execFile(cmd, ['auth', 'status'], { shell: true, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
    const output = (stdout || '') + (stderr || '');
    const authed = !err && (output.includes('"loggedIn": true') || output.includes('"loggedIn":true'));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claude-auth-status', { authenticated: authed });
    }
  });
}

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

  // Check Claude auth on load and every 60 seconds
  mainWindow.webContents.once('did-finish-load', () => {
    checkClaudeAuthAndNotify();
    setInterval(checkClaudeAuthAndNotify, 60000);
  });
}

// ── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Prevent system sleep so the bot stays connected with lid closed
  powerSaveBlocker.start('prevent-app-suspension');

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
    const pid = backendProcess.pid;
    try {
      if (platform.IS_WIN) {
        // Kill entire process tree (node backend + python ML workers)
        execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
      } else {
        // Try process group kill first, then direct PID kill as fallback
        try { process.kill(-pid, 'SIGTERM'); } catch {}
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    backendProcess = null;
  }

  // Safety net: kill anything still on the backend port so next launch is clean
  let port = 3847;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.port) port = cfg.port;
    }
  } catch {}
  try { platform.killPort(port); } catch {}
});
