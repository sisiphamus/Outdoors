import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const platform = require('../electron/platform');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// ── Constants ────────────────────────────────────────────────────────────────

describe('platform constants', () => {
  it('IS_MAC and IS_WIN are mutually exclusive', () => {
    assert.ok(!(platform.IS_MAC && platform.IS_WIN));
  });

  it('IS_MAC matches process.platform on darwin', { skip: !IS_MAC }, () => {
    assert.strictEqual(platform.IS_MAC, true);
    assert.strictEqual(platform.IS_WIN, false);
  });

  it('IS_WIN matches process.platform on win32', { skip: !IS_WIN }, () => {
    assert.strictEqual(platform.IS_WIN, true);
    assert.strictEqual(platform.IS_MAC, false);
  });
});

// ── Chrome Paths ─────────────────────────────────────────────────────────────

describe('getChromePaths', () => {
  it('returns non-empty array', () => {
    const paths = platform.getChromePaths();
    assert.ok(Array.isArray(paths));
    assert.ok(paths.length > 0);
  });

  it('returns Mac paths on darwin', { skip: !IS_MAC }, () => {
    const paths = platform.getChromePaths();
    assert.ok(paths.some(p => p.includes('/Applications/Google Chrome.app')));
    assert.ok(paths.every(p => !p.includes('.exe')), 'Mac paths must not contain .exe');
    assert.ok(paths.every(p => !p.includes('\\')), 'Mac paths must not contain backslashes');
  });

  it('returns Windows paths on win32', { skip: !IS_WIN }, () => {
    const paths = platform.getChromePaths();
    assert.ok(paths.some(p => p.includes('chrome.exe')));
  });
});

describe('getAutomationProfileDir', () => {
  it('returns string', () => {
    const dir = platform.getAutomationProfileDir();
    assert.strictEqual(typeof dir, 'string');
    assert.ok(dir.length > 0);
  });

  it('returns Mac path on darwin', { skip: !IS_MAC }, () => {
    const dir = platform.getAutomationProfileDir();
    assert.ok(dir.includes('Library/Application Support/Google/Chrome/AutomationProfile'));
    assert.ok(!dir.includes('\\'));
  });

  it('returns Windows path on win32', { skip: !IS_WIN }, () => {
    const dir = platform.getAutomationProfileDir();
    assert.ok(dir.includes('Google\\Chrome\\AutomationProfile') || dir.includes('Google/Chrome/AutomationProfile'));
  });
});

describe('getChromeUserDataDir', () => {
  it('returns string', () => {
    const dir = platform.getChromeUserDataDir();
    assert.strictEqual(typeof dir, 'string');
    assert.ok(dir.length > 0);
  });

  it('returns Mac path on darwin', { skip: !IS_MAC }, () => {
    const dir = platform.getChromeUserDataDir();
    assert.ok(dir.includes('Library/Application Support/Google/Chrome'));
  });
});

// ── Command Resolution ───────────────────────────────────────────────────────

describe('findCommand', () => {
  it('resolves node', () => {
    const result = platform.findCommand('node');
    assert.ok(result !== null, 'node should be findable in PATH');
    assert.ok(typeof result === 'string');
  });

  it('resolves npm', () => {
    const result = platform.findCommand('npm');
    assert.ok(result !== null, 'npm should be findable in PATH');
  });

  it('returns null for nonexistent binary', () => {
    const result = platform.findCommand('definitely_not_a_real_command_xyz_123');
    assert.strictEqual(result, null);
  });
});

describe('getCodexCmdPath', () => {
  it('returns non-empty string', () => {
    const cmd = platform.getCodexCmdPath();
    assert.strictEqual(typeof cmd, 'string');
    assert.ok(cmd.length > 0);
  });
});

describe('getUvxCandidatePaths', () => {
  it('returns non-empty array', () => {
    const paths = platform.getUvxCandidatePaths();
    assert.ok(Array.isArray(paths));
    assert.ok(paths.length > 0);
  });

  it('returns Mac paths on darwin', { skip: !IS_MAC }, () => {
    const paths = platform.getUvxCandidatePaths();
    assert.ok(
      paths.some(p => p === '/opt/homebrew/bin/uvx' || p === '/usr/local/bin/uvx'),
      'Should include Homebrew or /usr/local path'
    );
    assert.ok(paths.every(p => !p.includes('.exe')), 'Mac paths must not contain .exe');
  });

  it('returns Windows paths on win32', { skip: !IS_WIN }, () => {
    const paths = platform.getUvxCandidatePaths();
    assert.ok(paths.some(p => p.includes('.exe')), 'Windows paths should contain .exe');
  });
});

// ── Process Management ───────────────────────────────────────────────────────

describe('process management', () => {
  it('getPortProcesses returns array for unused port', () => {
    const pids = platform.getPortProcesses(59999);
    assert.ok(Array.isArray(pids));
  });

  it('findProcessByName returns boolean', async () => {
    const found = await platform.findProcessByName('node');
    assert.strictEqual(typeof found, 'boolean');
  });

  it('killProcessByPid does not throw for invalid PID', () => {
    assert.doesNotThrow(() => platform.killProcessByPid(999999));
  });
});
