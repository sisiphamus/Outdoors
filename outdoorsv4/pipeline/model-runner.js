// Spawns a single Codex CLI subprocess with JSONL output parsing.
// Built from scratch using Node's child_process.spawn.

import { spawn } from 'child_process';
import { config } from '../config.js';
import { register, unregister, emitActivity } from '../util/process-registry.js';

const MODEL_MAP = {
  opus: 'gpt-5.4',
  sonnet: 'gpt-5.4-mini',
  haiku: 'gpt-5.4-mini',
};

function resolveModel(shorthand) {
  if (!shorthand) return null;
  return MODEL_MAP[shorthand.toLowerCase()] || shorthand;
}

function extractText(message) {
  if (typeof message === 'string') return message;
  if (message && Array.isArray(message.content)) {
    return message.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return String(message || '');
}

function cleanEnv() {
  const env = { ...process.env };
  // Strip Claude-specific env vars that could confuse Codex
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE')) delete env[key];
  }
  return env;
}

export function runModel({
  userPrompt,
  systemPrompt,
  model,
  codexArgs,
  // Keep claudeArgs as fallback alias for callers that haven't been updated yet
  claudeArgs,
  onProgress,
  processKey,
  timeout,
  cwd,
  resumeSessionId,
}) {
  return new Promise((resolve, reject) => {
    const cmd = config.codexCommand || 'codex';
    const effectiveArgs = codexArgs || claudeArgs || config.codexArgs || ['exec'];

    // Build the argument list for codex exec
    const args = [...effectiveArgs];

    // Ensure 'exec' is the first arg (subcommand) if not already present
    if (args[0] !== 'exec' && args[0] !== 'e') {
      args.unshift('exec');
    }

    // JSONL output for structured parsing
    args.push('--json');

    // Bypass approval prompts and sandbox for non-interactive execution
    args.push('--dangerously-bypass-approvals-and-sandbox');

    // Skip git repo check since we may run outside a repo
    args.push('--skip-git-repo-check');

    // Only use ephemeral for fire-and-forget tasks (no conversation to resume)
    if (!resumeSessionId && !processKey) {
      args.push('--ephemeral');
    }

    const resolvedModel = resolveModel(model);
    if (resolvedModel) {
      args.push('-m', resolvedModel);
    }

    let isResume = false;
    if (resumeSessionId) {
      // Pass the specific thread_id and use '-' to read follow-up prompt from stdin
      const execIdx = args.indexOf('exec');
      if (execIdx !== -1) {
        args.splice(execIdx + 1, 0, 'resume', resumeSessionId, '-');
        isResume = true;
      }
    }

    // Build the prompt: prepend system instructions if provided
    // For resumed sessions, only send the follow-up prompt (no system instructions —
    // the session already has context from the previous turn)
    let fullPrompt = '';
    if (systemPrompt && !isResume) {
      fullPrompt += `[SYSTEM INSTRUCTIONS — follow these carefully]\n${systemPrompt}\n[END SYSTEM INSTRUCTIONS]\n\n`;
    }
    if (userPrompt) {
      fullPrompt += userPrompt;
    }

    console.log(`[model-runner] cmd=${cmd} args=${JSON.stringify(args)} resume=${!!resumeSessionId} sessionId=${resumeSessionId || 'none'} prompt=${(fullPrompt || '').slice(0, 80)}`);

    // On Windows, shell: true is needed so spawn resolves .cmd wrappers (e.g. codex.cmd).
    const proc = spawn(cmd, args, {
      cwd: cwd || config.workingDirectory || process.cwd(),
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    });

    proc.stdin.on('error', () => { /* pipe closed — ignore */ });
    proc.stdout.on('error', () => { /* pipe closed — ignore */ });
    proc.stderr.on('error', () => { /* pipe closed — ignore */ });

    if (processKey) {
      register(processKey, proc, model || 'codex');
    }

    let response = '';
    let sessionId = null;
    const fullEvents = [];
    let buffer = '';
    let response_streamed = false;
    let killedForQuestion = false;
    let resolved = false;

    // Activity-based timeout: resets every time the model produces output
    // (tool calls, streamed text, turn completions). This lets long multi-turn
    // sessions survive while still killing truly stuck processes.
    const IDLE_TIMEOUT = Math.min(timeout || 1800000, 1800000); // cap at 30 min idle
    let timeoutTimer = null;
    function resetTimeout() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (IDLE_TIMEOUT > 0) {
        timeoutTimer = setTimeout(() => {
          if (!killedForQuestion) {
            onProgress?.('warning', { message: `Model idle for ${IDLE_TIMEOUT / 1000}s — killing` });
            try { proc.kill(); } catch (e) {
              process.stderr.write(`[model-runner] Failed to kill timed-out process: ${e.message}\n`);
            }
          }
        }, IDLE_TIMEOUT);
      }
    }
    resetTimeout();

    // Write prompt to stdin and close
    if (fullPrompt) {
      proc.stdin.write(fullPrompt);
    }
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        fullEvents.push(event);

        // Codex JSONL event types:
        //   thread.started  — { thread_id }
        //   turn.started    — turn begins
        //   item.completed  — { item: { id, type, text, tool_name, input, output } }
        //   turn.completed  — { usage: { input_tokens, output_tokens, cached_input_tokens } }
        switch (event.type) {
          case 'thread.started':
            if (event.thread_id) sessionId = event.thread_id;
            break;

          case 'item.completed': {
            const item = event.item;
            if (!item) break;
            resetTimeout(); // Activity detected — extend idle deadline

            if (item.type === 'agent_message' && item.text) {
              response = item.text;
              response_streamed = true;
              onProgress?.('assistant_text', { text: item.text });
            } else if (item.type === 'tool_use' || item.type === 'function_call') {
              onProgress?.('tool_use', {
                tool: item.tool_name || item.name,
                input: item.input || item.arguments,
              });
              emitActivity(processKey, 'tool_use', item.tool_name || item.name);
            } else if (item.type === 'tool_result' || item.type === 'function_call_output') {
              onProgress?.('tool_result', {
                tool: item.tool_name || item.call_id,
                output: item.output || item.text || '',
              });
            }
            break;
          }

          case 'turn.completed': {
            resetTimeout(); // Turn done — reset idle timer for potential next turn
            if (event.usage) {
              onProgress?.('cost', {
                cost: event.usage.total_cost_usd,
                duration: event.duration_ms,
                input_tokens: event.usage.input_tokens,
                output_tokens: event.usage.output_tokens,
                cache_read: event.usage.cached_input_tokens,
              });
            }
            // Resolve the promise so the caller gets the response immediately.
            // The Codex process may keep running (multi-turn), but we deliver
            // the latest response now. If more turns happen, subsequent
            // turn.completed events will be ignored (already resolved).
            // The idle timeout or natural exit handles process cleanup.
            if (response && !resolved && !killedForQuestion) {
              resolved = true;
              if (processKey) unregister(processKey);
              if (timeoutTimer) clearTimeout(timeoutTimer);
              resolve({
                response,
                sessionId,
                fullEvents,
                questionRequest: fullEvents._questionRequest || null,
              });
            }
            break;
          }

          // Handle any legacy/unknown event types gracefully
          default:
            break;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) onProgress?.('stderr', { text, model: model || 'default' });
    });

    proc.on('close', (code) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (processKey) unregister(processKey);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          fullEvents.push(event);
          if (event.type === 'item.completed' && event.item?.text) response = event.item.text;
          if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id;
        } catch {}
      }

      // Already resolved from turn.completed — nothing to do
      if (resolved) return;

      if (proc._stoppedByUser) {
        reject({ stopped: true, message: 'Process stopped by user' });
        return;
      }

      resolve({
        response,
        sessionId,
        fullEvents,
        questionRequest: fullEvents._questionRequest || null,
      });
    });

    proc.on('error', (err) => {
      if (processKey) unregister(processKey);
      reject(err);
    });
  });
}
