/**
 * browser-health.js
 *
 * Ensures the user's preferred browser is ready for automation.
 * Cross-platform: works on Windows, macOS, and Linux.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execFile, execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = join(__dirname, '..', 'bot', 'memory', 'preferences', 'browser-preferences.md');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function readBrowserPrefs() {
  if (!existsSync(PREFS_PATH)) return {};
  const text = readFileSync(PREFS_PATH, 'utf-8');
  const prefs = {};
  const browserMatch = text.match(/\*\*Preferred Browser\*\*:\s*(.+)/);
  if (browserMatch) prefs.preferredBrowser = browserMatch[1].trim();
  const execMatch = text.match(/\*\*Executable Path\*\*:\s*`([^`]+)`/);
  if (execMatch) prefs.executablePath = execMatch[1];
  const portMatch = text.match(/\*\*CDP Port\*\*:\s*(\d+)/);
  if (portMatch) prefs.cdpPort = parseInt(portMatch[1]);
  const userDataMatch = text.match(/\*\*User Data Directory\*\*:\s*`([^`]+)`/);
  if (userDataMatch) prefs.userDataDir = userDataMatch[1];
  const profileMatch = text.match(/\*\*Active Profile Directory\*\*:\s*`([^`]+)`/);
  if (profileMatch) prefs.profileDir = profileMatch[1];
  return prefs;
}

function isChrome(preferredBrowser) {
  return !preferredBrowser || /chrome/i.test(preferredBrowser);
}

function isCdpReachable(port) {
  return new Promise((resolve) => {
    import('http').then(({ default: http }) => {
      const req = http.get(`http://localhost:${port}/json/version`, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  });
}

function getDefaultAutomationDir() {
  if (IS_WIN) {
    return join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile');
  }
  if (IS_MAC) {
    return join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome', 'AutomationProfile');
  }
  return join(process.env.HOME || '', '.config', 'google-chrome', 'AutomationProfile');
}

function getDefaultChromePaths() {
  if (IS_WIN) {
    return [
      join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (IS_MAC) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(process.env.HOME || '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'];
}

/**
 * Patches browser shortcuts to include --remote-debugging-port.
 * Windows only — macOS/Linux don't use .lnk shortcuts.
 */
function patchShortcuts(browserName, cdpPort, userDataDir) {
  if (!IS_WIN) return Promise.resolve();

  return new Promise((resolve) => {
    const args = `--remote-debugging-port=${cdpPort} --user-data-dir="${userDataDir}"`;
    const isEdge = /edge/i.test(browserName);
    const shortcutName = isEdge ? 'Microsoft Edge' : browserName;
    const script = `
$args = '${args}'
$shortcuts = @(
  "$env:USERPROFILE\\Desktop\\${shortcutName}.lnk",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\${shortcutName}.lnk",
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\${shortcutName}.lnk"
)
foreach ($path in $shortcuts) {
  if (-not (Test-Path $path)) { continue }
  try {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($path)
    $lnk.Arguments = $args
    $lnk.Save()
    Write-Host "Patched: $path"
  } catch { Write-Host "Skip (no access): $path" }
}`;
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (stdout) stdout.trim().split('\n').forEach(l => l.trim() && console.log(`  [BrowserHealth] ${l.trim()}`));
      resolve();
    });
  });
}

/** Returns true if the given process name is currently running. */
function isProcessRunning(processName) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const tasklist = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tasklist.exe`;
      execFile(tasklist, ['/FI', `IMAGENAME eq ${processName}`, '/NH'], { shell: false, windowsHide: true }, (err, stdout) => {
        resolve(!err && stdout.toLowerCase().includes(processName.toLowerCase()));
      });
    } else {
      const name = basename(processName, '.exe');
      execFile('pgrep', ['-f', name], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    }
  });
}

/**
 * Launches a browser with CDP flag.
 * Windows: PowerShell Start-Process. macOS/Linux: spawn detached.
 */
function openBrowser(executablePath, cdpPort, userDataDir, profileDir, firstRun = false) {
  return new Promise((resolve, reject) => {
    const chromeArgs = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDir}`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-extensions-except=`,
      `--disable-background-extensions`,
      ...(firstRun ? [`https://accounts.google.com/`] : []),
    ];

    if (IS_WIN) {
      const argStr = chromeArgs.join("','");
      const script = `Start-Process '${executablePath}' -ArgumentList '${argStr}'`;
      execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000, windowsHide: true }, () => {});
    } else {
      const proc = spawn(executablePath, chromeArgs, { detached: true, stdio: 'ignore' });
      proc.on('error', (err) => console.warn(`  [BrowserHealth] spawn error: ${err.message}`));
      proc.unref();
    }

    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (await isCdpReachable(cdpPort)) {
        clearInterval(interval);
        resolve();
      } else if (attempts >= 24) {
        clearInterval(interval);
        reject(new Error(`CDP did not become reachable on port ${cdpPort} after launch`));
      }
    }, 500);
  });
}

export async function ensureBrowserReady() {
  const prefs = readBrowserPrefs();
  const preferredBrowser = prefs.preferredBrowser || 'Google Chrome';

  if (isChrome(preferredBrowser)) {
    // Fall through to CDP launch logic below
  }

  const cdpPort = prefs.cdpPort || 9222;
  let executablePath = prefs.executablePath;
  const userDataDir = prefs.userDataDir || getDefaultAutomationDir();
  const profileDir = prefs.profileDir || 'Default';

  if (await isCdpReachable(cdpPort)) {
    console.log(`  [BrowserHealth] CDP reachable on port ${cdpPort} ✓`);
    return;
  }

  if (!executablePath || !existsSync(executablePath)) {
    const candidates = getDefaultChromePaths();
    const detected = candidates.find(p => existsSync(p));
    if (detected) {
      console.log(`  [BrowserHealth] Auto-detected browser: ${detected}`);
      executablePath = detected;
    } else {
      console.warn(`  [BrowserHealth] No browser found at prefs path (${executablePath}) or common locations`);
      return;
    }
  }

  await patchShortcuts(preferredBrowser, cdpPort, userDataDir);

  const processName = basename(executablePath);
  const running = await isProcessRunning(processName);
  if (running) {
    console.warn(`  [BrowserHealth] ${preferredBrowser} is running WITHOUT CDP on port ${cdpPort}.`);
    console.warn(`  [BrowserHealth] Please restart ${preferredBrowser} manually to enable CDP.`);
    return;
  }

  let firstRun = false;
  try {
    const prefsPath = join(userDataDir, profileDir, 'Preferences');
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
      firstRun = (prefs?.account_info || []).length === 0;
    } else {
      firstRun = true;
    }
  } catch { firstRun = true; }

  if (firstRun) {
    console.log(`  [BrowserHealth] First run detected — will open Google sign-in page.`);
  }

  console.log(`  [BrowserHealth] ${preferredBrowser} not running — launching with CDP flag...`);
  try {
    await openBrowser(executablePath, cdpPort, userDataDir, profileDir, firstRun);
    console.log(`  [BrowserHealth] ${preferredBrowser} launched with CDP on port ${cdpPort} ✓`);
  } catch (err) {
    console.warn(`  [BrowserHealth] Failed to launch ${preferredBrowser}: ${err.message}`);
  }
}
