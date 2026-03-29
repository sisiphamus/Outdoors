// Spawns a single Codex CLI subprocess with JSONL output parsing.
// Built from scratch using Node's child_process.spawn.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { register, unregister, emitActivity } from '../util/process-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// mcp-bot.json lives in outdoorsv4/ — contains all MCP servers (browser + google_workspace)
const MCP_CONFIG_PATH = join(__dirname, '..', 'mcp-bot.json');

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

    if (resumeSessionId) {
      // Pass the specific thread_id to resume the correct conversation
      const execIdx = args.indexOf('exec');
      if (execIdx !== -1) {
        args.splice(execIdx + 1, 0, 'resume', resumeSessionId);
      }
    }

    // Build the prompt: prepend system instructions if provided
    let fullPrompt = '';
    if (systemPrompt) {
      fullPrompt += `[SYSTEM INSTRUCTIONS — follow these carefully]\n${systemPrompt}\n[END SYSTEM INSTRUCTIONS]\n\n`;
    }
    if (userPrompt) {
      fullPrompt += userPrompt;
    }

    // Codex exec reads prompt from stdin when '-' is passed or no prompt arg
    // We'll write the prompt via stdin for reliability (avoids arg length limits)

    // On Windows, shell: true is needed so spawn resolves .cmd wrappers (e.g. codex.cmd).
    const proc = spawn(cmd, args, {
      cwd: cwd || config.workingDirectory || process.cwd(),
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
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
    let killedAfterResult = false;

    // Enforce timeout if specified
    let timeoutTimer = null;
    if (timeout && timeout > 0) {
      timeoutTimer = setTimeout(() => {
        if (!killedAfterResult && !killedForQuestion) {
          onProgress?.('warning', { message: `Model timed out after ${timeout}ms` });
          try { proc.kill(); } catch (e) {
            process.stderr.write(`[model-runner] Failed to kill timed-out process: ${e.message}\n`);
          }
        }
      }, timeout);
    }

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
            if (event.usage) {
              onProgress?.('cost', {
                cost: event.usage.total_cost_usd,
                duration: event.duration_ms,
                input_tokens: event.usage.input_tokens,
                output_tokens: event.usage.output_tokens,
                cache_read: event.usage.cached_input_tokens,
              });
            }
            // After the turn completes, kill the process tree to prevent background
            // tasks from triggering additional model turns that waste API credits.
            if (!killedAfterResult && !killedForQuestion) {
              killedAfterResult = true;
              setTimeout(() => {
                try {
                  if (process.platform === 'win32') {
                    const taskkill = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
                    spawn(taskkill, ['/T', '/F', '/PID', String(proc.pid)], {
                      shell: false,
                      stdio: 'ignore',
                      detached: true,
                    });
                  } else {
                    process.kill(-proc.pid, 'SIGTERM');
                  }
                } catch {}
              }, 500);
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
