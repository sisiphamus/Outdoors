/**
 * Outdoors — Electron Main Process
 *
 * Thin shell that:
 * 1. Copies bundled project to writable userData on first run
 * 2. Shows setup wizard (install deps → Claude auth → WhatsApp QR)
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
  if (IS_DEV) return false; // dev mode — use real project directory directly

  // Check if workspace exists AND has the critical backend entry point.
  // If the directory exists but is incomplete (interrupted first run), re-copy.
  const backendIndex = path.join(WORKSPACE, 'outdoorsv1', 'backend', 'src', 'index.js');
  const v4Index = path.join(WORKSPACE, 'outdoorsv4', 'index.js');
  if (fs.existsSync(backendIndex) && fs.existsSync(v4Index)) {
    return false; // workspace is intact
  }

  try {
    // The bundled project is in extraResources/project/
    const bundledProject = path.join(process.resourcesPath, 'project');
    if (fs.existsSync(bundledProject)) {
      copyDirSync(bundledProject, path.join(WORKSPACE, 'outdoorsv1', 'backend'));
    }
    // outdoorsv4 pipeline (imported by backend via ../../../outdoorsv4/)
    const bundledV4 = path.join(process.resourcesPath, 'outdoorsv4');
    if (fs.existsSync(bundledV4)) {
      copyDirSync(bundledV4, path.join(WORKSPACE, 'outdoorsv4'));
    }
  } catch (err) {
    console.error('[workspace] Copy failed:', err);
  }

  // Create empty dirs that aren't bundled but the app expects
  const emptyDirs = [
    'bot/logs', 'bot/outputs', 'bot/message-queue',
    'bot/memory/preferences', 'bot/memory/sites',
    'bot/memory/short-term',
  ];
  for (const dir of emptyDirs) {
    try {
      fs.mkdirSync(path.join(BACKEND_DIR, dir), { recursive: true });
    } catch {}
  }
  return true; // first run
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
    // Read port from config, default 3457
    let port = 3457;
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (cfg.port) port = cfg.port;
      }
    } catch {}
    return `http://localhost:${port}`;
  });

  // Mark setup complete
  ipcMain.handle('complete-setup', async () => {
    fs.writeFileSync(SETUP_DONE_FLAG, new Date().toISOString());
    setupAutoLaunch();
    return { ok: true };
  });

  // Close/hide window
  ipcMain.handle('close-window', () => {
    if (mainWindow) mainWindow.hide();
  });
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
      if (!started) resolve({ ok: false, error: `Backend exited with code ${code}`, stderr: stderrOutput });
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

// ── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const isFirstRun = ensureWorkspace();
  const setupDone = fs.existsSync(SETUP_DONE_FLAG);

  setupIPC();
  createTray();

  if (!setupDone || isFirstRun) {
    // Show setup wizard
    createSetupWindow();
  } else {
    // Setup already done — start backend directly
    await startBackend();
    // Create a hidden window (can be shown from tray)
    createSetupWindow();
    mainWindow.hide();
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
