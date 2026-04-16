/**
 * register-startup.js
 *
 * Registers the app to start automatically at user login.
 * Windows: Task Scheduler. macOS: LaunchAgent plist.
 *
 * Task: "ChieftonV6"
 * Trigger: At logon (current user)
 * Action: node <path-to-index.js> with working directory set to this project
 */

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, '..');
const TASK_NAME = 'ChieftonV6';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout.trim());
      }
    );
  });
}

async function isRegisteredWindows() {
  try {
    const out = await ps(
      `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).TaskName`
    );
    return out === TASK_NAME;
  } catch {
    return false;
  }
}

function getMacPlistPath() {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', `com.chiefton.v6.plist`);
}

function isRegisteredMac() {
  return existsSync(getMacPlistPath());
}

export async function registerStartup() {
  // When running under Electron, auto-launch is handled by the auto-launch package
  if (process.env.ELECTRON) {
    console.log('  [Startup] Running under Electron — skipping startup registration');
    return;
  }

  if (IS_WIN) {
    try {
      if (await isRegisteredWindows()) {
        console.log(`  [Startup] Task '${TASK_NAME}' already registered ✓`);
        return;
      }

      const nodeBin = process.execPath;
      const indexJs = resolve(__dirname, 'index.js');
      const workDir = PROJECT_DIR;

      await ps(`
        $a = New-ScheduledTaskAction -Execute '${nodeBin}' -Argument '"${indexJs}"' -WorkingDirectory '${workDir}'
        $t = New-ScheduledTaskTrigger -AtLogOn
        $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
        Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Force
      `);

      console.log(`  [Startup] Registered '${TASK_NAME}' in Task Scheduler ✓`);
    } catch (err) {
      console.warn(`  [Startup] Could not register startup task: ${err.message}`);
    }
  } else if (IS_MAC) {
    try {
      if (isRegisteredMac()) {
        console.log(`  [Startup] LaunchAgent already registered ✓`);
        return;
      }

      const nodeBin = process.execPath;
      const indexJs = resolve(__dirname, 'index.js');
      const plistPath = getMacPlistPath();

      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chiefton.v6</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${indexJs}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(PROJECT_DIR, 'bot', 'logs', 'launchd-stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(PROJECT_DIR, 'bot', 'logs', 'launchd-stderr.log')}</string>
</dict>
</plist>`;

      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, plist);
      console.log(`  [Startup] Registered LaunchAgent at ${plistPath} ✓`);
    } catch (err) {
      console.warn(`  [Startup] Could not register LaunchAgent: ${err.message}`);
    }
  } else {
    console.log('  [Startup] Startup registration not supported on this platform');
  }
}
