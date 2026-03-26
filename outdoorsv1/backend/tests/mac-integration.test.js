import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const platform = require('../electron/platform');

const IS_MAC = process.platform === 'darwin';

describe('macOS integration', { skip: !IS_MAC }, () => {

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

  it('osascript is available (used by openTerminalWithCommand)', () => {
    const result = execSync('which osascript', { encoding: 'utf-8' }).trim();
    assert.ok(result.includes('osascript'));
  });

  it('curl is available (used by whisper model download)', () => {
    const result = execSync('which curl', { encoding: 'utf-8' }).trim();
    assert.ok(result.includes('curl'));
  });

  // ── PATH resolution ──────────────────────────────────────────────────────

  it('npm is in PATH (needed for install-node-deps IPC)', () => {
    const found = platform.findCommand('npm');
    assert.ok(found !== null, 'npm must be in PATH on macOS');
  });

  it('node is in PATH', () => {
    const found = platform.findCommand('node');
    assert.ok(found !== null, 'node must be in PATH on macOS');
  });

  // ── Filesystem operations ────────────────────────────────────────────────

  it('~/Library/LaunchAgents/ is writable (startup registration)', () => {
    const dir = join(process.env.HOME || '', 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    assert.ok(existsSync(dir));
  });

  it('workspace-style recursive copy works with Mac paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'outdoors-ws-'));
    try {
      // Simulate the bundle → workspace copy from ensureWorkspace()
      const srcRoot = join(tmp, 'resources', 'project', 'src');
      const srcSetup = join(tmp, 'resources', 'project', 'src', 'setup');
      const destBackend = join(tmp, 'workspace', 'outdoorsv1', 'backend');

      mkdirSync(srcSetup, { recursive: true });
      writeFileSync(join(srcRoot, 'index.js'), 'console.log("backend");\n');
      writeFileSync(join(srcSetup, 'index.html'), '<html></html>\n');

      // Copy like ensureWorkspace does
      mkdirSync(join(destBackend, 'src', 'setup'), { recursive: true });
      copyFileSync(join(srcRoot, 'index.js'), join(destBackend, 'src', 'index.js'));
      copyFileSync(join(srcSetup, 'index.html'), join(destBackend, 'src', 'setup', 'index.html'));

      assert.ok(existsSync(join(destBackend, 'src', 'index.js')));
      assert.ok(existsSync(join(destBackend, 'src', 'setup', 'index.html')));
      assert.strictEqual(readFileSync(join(destBackend, 'src', 'index.js'), 'utf-8'), 'console.log("backend");\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── Spawn patterns (matches onboarding IPC handlers) ─────────────────────

  it('spawn npm with shell:true works (install-node-deps pattern)', async () => {
    const result = await new Promise((resolve) => {
      const proc = spawn('npm', ['--version'], { shell: true });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => resolve({ code, output }));
      proc.on('error', (err) => resolve({ code: 1, output: err.message }));
    });
    assert.strictEqual(result.code, 0, `npm --version should exit 0, got output: ${result.output}`);
  });

  it('spawn node with shell:false works (backend spawn pattern)', async () => {
    const result = await new Promise((resolve) => {
      const proc = spawn('node', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => resolve({ code, output }));
      proc.on('error', (err) => resolve({ code: 1, output: err.message }));
    });
    assert.strictEqual(result.code, 0, `node --version should exit 0, got output: ${result.output}`);
  });

  it('execSync with shell:true resolves commands (check-claude-installed pattern)', () => {
    // Same pattern as check-claude-installed IPC handler
    const version = execSync('"node" --version', { encoding: 'utf-8', shell: true, timeout: 10000 }).trim();
    assert.ok(version.startsWith('v'), `Expected version string, got: ${version}`);
  });
});
