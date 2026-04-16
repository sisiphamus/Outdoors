import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('codex-bridge', () => {
  it('should export executeCodexPrompt function', async () => {
    const mod = await import('../src/codex-bridge.js');
    assert.equal(typeof mod.executeCodexPrompt, 'function');
  });

  it('should export all bridge functions', async () => {
    const mod = await import('../src/codex-bridge.js');
    assert.equal(typeof mod.killProcess, 'function');
    assert.equal(typeof mod.codeAgentOptions, 'function');
    assert.equal(typeof mod.employeeAgentOptions, 'function');
    assert.equal(typeof mod.getEmployeeMode, 'function');
    assert.equal(typeof mod.getClarificationState, 'function');
    assert.equal(typeof mod.clearClarificationState, 'function');
  });
});
