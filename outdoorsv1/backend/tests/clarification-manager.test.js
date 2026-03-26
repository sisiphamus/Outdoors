import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as clarifications from '../../../outdoorsv4/memory/clarification-manager.js';

describe('clarification-manager', () => {
  it('persists and clears pending clarification state', () => {
    clarifications.setPending('test:chat:1', {
      originalPrompt: 'Can you create a landing page',
      pendingQuestions: { questions: [{ question: 'What product?' }] },
      sessionId: 'abc',
    });

    const pending = clarifications.get('test:chat:1');
    assert.equal(pending.originalPrompt, 'Can you create a landing page');
    assert.equal(pending.answers.length, 0);
    assert.ok(pending.timestamp > 0);

    clarifications.appendAnswer('test:chat:1', 'It is for Outdoors');
    const updated = clarifications.get('test:chat:1');
    assert.equal(updated.answers.length, 1);

    const augmented = clarifications.buildAugmentedPrompt(updated);
    assert.match(augmented, /Can you create a landing page/);
    assert.match(augmented, /clarification Q&A/);
    assert.match(augmented, /It is for Outdoors/);

    clarifications.clear('test:chat:1');
    assert.equal(clarifications.get('test:chat:1'), null);
  });

  it('isolates keys', () => {
    clarifications.setPending('test:win:a', { originalPrompt: 'A', pendingQuestions: { questions: [] } });
    clarifications.setPending('test:win:b', { originalPrompt: 'B', pendingQuestions: { questions: [] } });

    assert.notEqual(clarifications.get('test:win:a'), null);
    assert.notEqual(clarifications.get('test:win:b'), null);
    assert.equal(clarifications.get('test:win:a').originalPrompt, 'A');
    assert.equal(clarifications.get('test:win:b').originalPrompt, 'B');

    clarifications.clear('test:win:a');
    clarifications.clear('test:win:b');
  });
});

describe('model-runner safety guards', () => {
  it('uses platform-aware shell setting', () => {
    const src = readFileSync(join(process.cwd(), '..', '..', 'outdoorsv4', 'pipeline', 'model-runner.js'), 'utf-8');
    // Should use shell only on Windows, not unconditionally
    assert.match(src, /shell:\s*process\.platform\s*===\s*'win32'/);
  });
});
