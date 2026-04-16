import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const platform = require('../electron/platform');

const IS_LINUX = process.platform === 'linux';

describe('Linux integration', { skip: !IS_LINUX }, () => {

  // ── System commands used by platform.js ──────────────────────────────────

  it('lsof is available (used by getPortProcesses)', () => {
    const result = execSync('which lsof', { encoding: 'utf-8' }).trim();
    assert.ok(result.includes('lsof'));
  });

  it('pgrep is available (used by findProcessByName)', () => {
    const result = execSync('which pgrep', { encoding: 'utf-8' }).trim();
    assert.ok(result.includes('pgrep'));
  });

  it('pkill is available (used by killProcessByName)', () => {
    const result = execSync('which pkill', { encoding: 'utf-8' }).trim();
    assert.ok(result.includes('pkill'));
  });

  it('curl is available (used by whisper model download)', () => {
    const result = execSync('which curl', { encoding: 'utf-8' }).trim();
    assert.ok(result.includes('curl'));
  });

  // ── PATH resolution ──────────────────────────────────────────────────────

  it('npm is in PATH', () => {
    const found = platform.findCommand('npm');
    assert.ok(found !== null, 'npm must be in PATH on Linux');
  });

  it('node is in PATH', () => {
    const found = platform.findCommand('node');
    assert.ok(found !== null, 'node must be in PATH on Linux');
  });

  // ── Chrome paths ─────────────────────────────────────────────────────────

  it('getChromePaths returns Linux paths', () => {
    const paths = platform.getChromePaths();
    assert.ok(paths.some(p => p.includes('/usr/bin/')), 'Should include /usr/bin paths');
    assert.ok(paths.every(p => !p.includes('.exe')), 'No .exe on Linux');
    assert.ok(paths.every(p => !p.includes('.app')), 'No .app on Linux');
  });

  it('getAutomationProfileDir returns Linux path', () => {
    const dir = platform.getAutomationProfileDir();
    assert.ok(dir.includes('.config/google-chrome/AutomationProfile'));
  });

  it('getChromeUserDataDir returns Linux path', () => {
    const dir = platform.getChromeUserDataDir();
    assert.ok(dir.includes('.config/google-chrome'));
  });

  // ── Filesystem operations ────────────────────────────────────────────────

  it('~/.config/autostart/ is writable (startup registration)', () => {
    const dir = join(process.env.HOME || '', '.config', 'autostart');
    mkdirSync(dir, { recursive: true });
    assert.ok(existsSync(dir));
  });

  it('workspace-style recursive copy works with Linux paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chiefton-ws-'));
    try {
      const srcRoot = join(tmp, 'resources', 'project', 'src');
      mkdirSync(srcRoot, { recursive: true });
      writeFileSync(join(srcRoot, 'index.js'), 'console.log("backend");\n');

      const dest = join(tmp, 'workspace', 'chieftonv1', 'backend', 'src');
      mkdirSync(dest, { recursive: true });
      copyFileSync(join(srcRoot, 'index.js'), join(dest, 'index.js'));

      assert.ok(existsSync(join(dest, 'index.js')));
      assert.strictEqual(readFileSync(join(dest, 'index.js'), 'utf-8'), 'console.log("backend");\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── Spawn patterns ───────────────────────────────────────────────────────

  it('spawn npm with shell:true works', async () => {
    const result = await new Promise((resolve) => {
      const proc = spawn('npm', ['--version'], { shell: true });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => resolve({ code, output }));
      proc.on('error', (err) => resolve({ code: 1, output: err.message }));
    });
    assert.strictEqual(result.code, 0, `npm --version should exit 0`);
  });

  it('spawn node with shell:false works', async () => {
    const result = await new Promise((resolve) => {
      const proc = spawn('node', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => resolve({ code, output }));
      proc.on('error', (err) => resolve({ code: 1, output: err.message }));
    });
    assert.strictEqual(result.code, 0);
  });

  // ── UVX paths ────────────────────────────────────────────────────────────

  it('getUvxCandidatePaths returns Linux paths', () => {
    const paths = platform.getUvxCandidatePaths();
    assert.ok(paths.some(p => p === '/usr/local/bin/uvx' || p.includes('.local/bin/uvx')));
    assert.ok(paths.every(p => !p.includes('.exe')));
  });
});
