/**
 * Platform abstraction layer for Outdoors Electron app.
 * Centralizes all OS-specific operations so main.js and browser-health.js
 * can call clean helper functions instead of inline PowerShell/tasklist code.
 */

const path = require('path');
const fs = require('fs');
const { execSync, execFile, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ── Chrome Paths ─────────────────────────────────────────────────────────────

function getChromePaths() {
  if (IS_WIN) {
    return [
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (IS_MAC) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(process.env.HOME || '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
  }
  // Linux fallback
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'];
}

function findChrome() {
  const paths = getChromePaths();
  return paths.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function getAutomationProfileDir() {
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'AutomationProfile');
  }
  if (IS_MAC) {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome', 'AutomationProfile');
  }
  return path.join(process.env.HOME || '', '.config', 'google-chrome', 'AutomationProfile');
}

function getChromeUserDataDir() {
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  }
  if (IS_MAC) {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(process.env.HOME || '', '.config', 'google-chrome');
}

// ── Chrome Launch ────────────────────────────────────────────────────────────

function launchChrome(exePath, chromeArgs) {
  return new Promise((resolve, reject) => {
    if (IS_WIN) {
      // PowerShell Start-Process — proven reliable on Windows
      const argStr = chromeArgs.map(a => `'${a}'`).join(',');
      const script = `Start-Process '${exePath}' -ArgumentList ${argStr}`;
      execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000, windowsHide: true }, (err) => {
        if (err) reject(err); else resolve();
      });
    } else {
      // macOS/Linux — spawn directly, detached
      const proc = spawn(exePath, chromeArgs, {
        detached: true,
        stdio: 'ignore',
      });
      proc.on('error', reject);
      proc.unref();
      // Give Chrome a moment to start
      setTimeout(resolve, 1000);
    }
  });
}

// ── Process Management ───────────────────────────────────────────────────────

function killProcessByPid(pid) {
  try {
    if (IS_WIN) {
      execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}
}

function killProcessByName(name, filterArg) {
  try {
    if (IS_WIN) {
      if (filterArg) {
        // Kill processes matching name AND command line containing filterArg
        const script = `Get-CimInstance Win32_Process -Filter "name='${name}'" | Where-Object { $_.CommandLine -match '${filterArg}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000, windowsHide: true }, () => {});
      } else {
        execSync(`taskkill /F /IM ${name} /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
      }
    } else {
      if (filterArg) {
        execSync(`pkill -f "${name}.*${filterArg}"`, { timeout: 5000, stdio: 'ignore' });
      } else {
        execSync(`pkill -f "${name}"`, { timeout: 5000, stdio: 'ignore' });
      }
    }
  } catch {}
}

function findProcessByName(processName) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const tasklist = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tasklist.exe`;
      execFile(tasklist, ['/FI', `IMAGENAME eq ${processName}`, '/NH'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        resolve(!err && stdout && stdout.toLowerCase().includes(processName.toLowerCase()));
      });
    } else {
      const baseName = path.basename(processName, path.extname(processName));
      execFile('pgrep', ['-f', baseName], { timeout: 5000 }, (err) => {
        resolve(!err); // exit code 0 = found
      });
    }
  });
}

// ── Port Management ──────────────────────────────────────────────────────────

function getPortProcesses(port) {
  try {
    if (IS_WIN) {
      const result = execSync(
        `powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      ).trim();
      return result.split(/\r?\n/).filter(Boolean).map(Number);
    } else {
      const result = execSync(`lsof -ti :${port}`, { encoding: 'utf-8', timeout: 5000 }).trim();
      return result.split(/\n/).filter(Boolean).map(Number);
    }
  } catch {
    return [];
  }
}

function killPort(port) {
  const pids = getPortProcesses(port);
  for (const pid of pids) {
    killProcessByPid(pid);
  }
}

// ── Command Resolution ───────────────────────────────────────────────────────

function findCommand(name) {
  try {
    const cmd = IS_WIN ? `where ${name}` : `which ${name}`;
    const result = execSync(cmd, { encoding: 'utf-8', shell: true, timeout: 5000, windowsHide: true }).trim();
    if (!result) return null;
    const lines = result.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // On Windows prefer .exe over .cmd
    if (IS_WIN) {
      return lines.find(l => l.endsWith('.exe')) || lines.find(l => l.endsWith('.cmd')) || lines[0];
    }
    return lines[0];
  } catch {
    return null;
  }
}

function getUvxCandidatePaths() {
  if (IS_WIN) {
    return [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'Scripts', 'uvx.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'uvx.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'uvx.exe'),
      path.join(process.env.APPDATA || '', 'Python', 'Python313', 'Scripts', 'uvx.exe'),
      path.join(process.env.APPDATA || '', 'Python', 'Python312', 'Scripts', 'uvx.exe'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'Scripts', 'uvx.exe'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'uvx.exe'),
      path.join(process.env.USERPROFILE || '', '.local', 'bin', 'uvx.exe'),
    ];
  }
  if (IS_MAC) {
    return [
      '/usr/local/bin/uvx',
      '/opt/homebrew/bin/uvx',
      path.join(process.env.HOME || '', '.local', 'bin', 'uvx'),
      path.join(process.env.HOME || '', '.cargo', 'bin', 'uvx'),
      '/usr/bin/uvx',
    ];
  }
  return [
    '/usr/local/bin/uvx',
    path.join(process.env.HOME || '', '.local', 'bin', 'uvx'),
    '/usr/bin/uvx',
  ];
}

function getClaudeCmdPath() {
  // Try finding claude in PATH
  const found = findCommand('claude');
  if (found) return found;

  // Check common install locations
  if (IS_WIN) {
    const npmGlobal = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (fs.existsSync(npmGlobal)) return npmGlobal;
  } else {
    const candidates = [
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(process.env.HOME || '', '.npm-global', 'bin', 'claude'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'claude';
}

// ── Terminal / Shell ─────────────────────────────────────────────────────────

function openTerminalWithCommand(cmd, args) {
  if (IS_WIN) {
    return spawn('cmd.exe', ['/k', cmd, ...args], {
      stdio: 'ignore',
      detached: true,
      windowsHide: false,
    });
  }
  if (IS_MAC) {
    // Use osascript to open Terminal.app with the command
    const fullCmd = [cmd, ...args].join(' ');
    const script = `tell application "Terminal" to do script "${fullCmd.replace(/"/g, '\\"')}"`;
    return spawn('osascript', ['-e', script], {
      stdio: 'ignore',
      detached: true,
    });
  }
  // Linux fallback
  return spawn('x-terminal-emulator', ['-e', cmd, ...args], {
    stdio: 'ignore',
    detached: true,
  });
}

// ── Startup Registration ─────────────────────────────────────────────────────

function registerStartup(appName, executablePath, workingDir) {
  if (IS_WIN) {
    // Windows Task Scheduler
    const script = `
      $a = New-ScheduledTaskAction -Execute '${executablePath}' -WorkingDirectory '${workingDir}'
      $t = New-ScheduledTaskTrigger -AtLogOn
      $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
      Register-ScheduledTask -TaskName '${appName}' -Action $a -Trigger $t -Settings $s -Force
    `;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true }, () => {});
  } else if (IS_MAC) {
    // macOS LaunchAgent
    const plistPath = path.join(process.env.HOME || '', 'Library', 'LaunchAgents', `com.${appName.toLowerCase()}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.${appName.toLowerCase()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executablePath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workingDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>`;
    try {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plist);
      execSync(`launchctl load "${plistPath}"`, { timeout: 5000 });
    } catch {}
  }
}

function unregisterStartup(appName) {
  if (IS_WIN) {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName '${appName}' -Confirm:$false -ErrorAction SilentlyContinue`], { timeout: 10000, windowsHide: true }, () => {});
  } else if (IS_MAC) {
    const plistPath = path.join(process.env.HOME || '', 'Library', 'LaunchAgents', `com.${appName.toLowerCase()}.plist`);
    try {
      execSync(`launchctl unload "${plistPath}"`, { timeout: 5000 });
      fs.unlinkSync(plistPath);
    } catch {}
  }
}

module.exports = {
  IS_WIN,
  IS_MAC,
  getChromePaths,
  findChrome,
  getAutomationProfileDir,
  getChromeUserDataDir,
  launchChrome,
  killProcessByPid,
  killProcessByName,
  findProcessByName,
  getPortProcesses,
  killPort,
  findCommand,
  getUvxCandidatePaths,
  getClaudeCmdPath,
  openTerminalWithCommand,
  registerStartup,
  unregisterStartup,
};
