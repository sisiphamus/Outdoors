// Claude-powered model runner.
//
// Drop-in replacement for the old Codex-CLI-based model-runner.js. Same
// runModel() signature, same return shape, same onProgress event vocabulary —
// so orchestrator.js, claude-bridge.js, and everything downstream keep working
// unchanged.
//
// What's different under the hood:
//   - No Codex CLI subprocess. Requests go to the outdoors-chat Cloudflare
//     proxy via @anthropic-ai/sdk.
//   - Tools are dispatched locally in Node (via builtin-tools.js + mcp-client.js)
//     instead of inside the Codex binary.
//   - Sessions are maintained in a Node-side Map, not by Codex's thread_id.

import { randomUUID } from 'crypto';
import { createMessage } from '../../chieftonv1/backend/src/agent/anthropic-client.js';
import { register, unregister, emitActivity } from '../util/process-registry.js';
import { getBuiltinDefinitions, callBuiltinTool, isBuiltinTool } from './builtin-tools.js';
import { getMcpTools, callMcpTool, isMcpTool } from './mcp-client.js';

// Model shorthand → canonical Anthropic ID.
// Callers use "opus" / "sonnet" / "haiku"; orchestrator also passes e.g. "gpt-5.4"
// as a legacy leftover from Codex — we map those to sonnet by default.
const MODEL_MAP = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  code: 'claude-opus-4-6',

  // Legacy Codex names — map to closest Claude equivalent so old call sites don't break
  'gpt-5.4': 'claude-opus-4-6',
  'gpt-5.4-mini': 'claude-sonnet-4-6',
};

function resolveModel(shorthand) {
  if (!shorthand) return 'claude-sonnet-4-6';
  return MODEL_MAP[shorthand.toLowerCase?.()] || MODEL_MAP[shorthand] || shorthand;
}

// ── Session history (Node-side, replaces Codex thread_id) ───────────────────

const sessions = new Map(); // sessionId → { messages, updatedAt }
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h before we forget a session
const SESSION_MAX_MESSAGES = 40;

function getSessionHistory(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > SESSION_MAX_AGE_MS) {
    sessions.delete(sessionId);
    return [];
  }
  return entry.messages;
}

function saveSession(sessionId, messages) {
  // Trim to last SESSION_MAX_MESSAGES exchanges
  const trimmed = messages.slice(-SESSION_MAX_MESSAGES);
  sessions.set(sessionId, { messages: trimmed, updatedAt: Date.now() });
}

// ── Tool registry (combined builtins + MCP) ─────────────────────────────────

let toolsCache = null;
let mcpInitPromise = null;

async function getAllTools() {
  if (toolsCache) return toolsCache;

  // Pre-warm MCP on first call, share the init across concurrent callers
  if (!mcpInitPromise) {
    mcpInitPromise = getMcpTools().catch(err => {
      console.error('[claude-model-runner] MCP init failed, continuing without MCP tools:', err.message);
      return [];
    });
  }
  const mcpTools = await mcpInitPromise;

  // Strip internal _server hint before sending to Claude
  const mcpForClaude = mcpTools.map(({ _server, ...rest }) => rest);
  toolsCache = [...getBuiltinDefinitions(), ...mcpForClaude];
  return toolsCache;
}

async function dispatchTool(name, input, onProgress) {
  onProgress?.('tool_use', { tool: name, input });

  try {
    let result;
    if (isBuiltinTool(name)) {
      result = await callBuiltinTool(name, input);
    } else if (isMcpTool(name)) {
      result = await callMcpTool(name, input);
    } else {
      result = `Unknown tool: ${name}`;
    }
    onProgress?.('tool_result', { tool: name, output: String(result).slice(0, 4000) });
    return String(result);
  } catch (err) {
    const msg = `tool error: ${err.message}`;
    onProgress?.('tool_result', { tool: name, output: msg });
    return msg;
  }
}

// ── Pre-flight stub (Codex auth compat) ─────────────────────────────────────
// Chiefton uses a proxy JWT, not Codex auth. Always valid — the proxy will
// return 401 if the JWT is bad, and anthropic-client.js handles re-issue.

export function checkCodexAuthValidity() {
  return { valid: true };
}

// ── runModel ────────────────────────────────────────────────────────────────

export async function runModel({
  userPrompt,
  systemPrompt,
  model,
  onProgress,
  processKey,
  timeout,
  cwd,
  resumeSessionId,
  // accepted for API compat, ignored (Codex leftovers):
  codexArgs,
  claudeArgs,
}) {
  const resolvedModel = resolveModel(model);
  const sessionId = resumeSessionId || randomUUID();

  // Build message history
  const history = getSessionHistory(sessionId);
  const userContent = userPrompt || '';
  const messages = [...history, { role: 'user', content: userContent }];

  // Dummy process handle for registry compatibility — the old Codex runner
  // registered a spawned child here; we register a killable marker object
  // so the dashboard's kill button still works.
  const proc = {
    kill: () => { killed = true; },
    pid: process.pid,
  };
  let killed = false;
  if (processKey) register(processKey, proc, resolvedModel);

  // Idle timeout (activity resets it). Same shape as old runner.
  const IDLE_TIMEOUT = Math.min(timeout || 1800000, 1800000);
  let idleTimer = null;
  function resetIdle(reason) {
    if (idleTimer) clearTimeout(idleTimer);
    if (IDLE_TIMEOUT > 0) {
      idleTimer = setTimeout(() => {
        killed = true;
        onProgress?.('warning', { message: `Model idle for ${IDLE_TIMEOUT / 1000}s — killing (${reason || 'no activity'})` });
      }, IDLE_TIMEOUT);
    }
  }
  resetIdle('start');

  const fullEvents = [];
  let finalResponse = '';

  try {
    const tools = await getAllTools();

    // Agent loop: keep calling until the model stops asking for tools
    const MAX_TURNS = 25;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (killed) break;

      let resp;
      try {
        resp = await createMessage({
          model: resolvedModel,
          max_tokens: 4096,
          system: systemPrompt || undefined,
          messages,
          tools,
        });
      } catch (err) {
        // Classify Anthropic / proxy errors into a human-friendly message
        // so the orchestrator + dashboard stop dumping raw JSON.
        const raw = err.message || String(err);
        let friendly;
        if (/credit balance is too low/i.test(raw) || /insufficient.*credit/i.test(raw)) {
          friendly = 'Out of Anthropic credits. Top up at console.anthropic.com/settings/billing.';
        } else if (/rate limit/i.test(raw) || /429/.test(raw)) {
          friendly = 'Anthropic rate limit hit — wait a moment and try again.';
        } else if (/401|unauthoriz|invalid.*api.*key/i.test(raw)) {
          friendly = 'Auth failed — the Cloudflare proxy could not reach Anthropic.';
        } else if (/Daily quota exceeded/i.test(raw)) {
          friendly = 'Daily proxy quota exceeded. Resets at midnight UTC.';
        } else if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(raw)) {
          friendly = 'Could not reach the Chiefton proxy. Check your internet connection.';
        } else {
          friendly = `Model call failed: ${raw.slice(0, 140)}`;
        }
        onProgress?.('error', { message: friendly });
        fullEvents.push({ type: 'error', error: friendly, raw });
        finalResponse = friendly;      // propagate upward so A→B→D retry exits cleanly
        killed = true;                  // abort inner agent loop
        break;
      }
      resetIdle('claude reply');

      // Record usage as a "cost" event (dashboard telemetry consumes this)
      if (resp.usage) {
        onProgress?.('cost', {
          input_tokens: resp.usage.input_tokens,
          output_tokens: resp.usage.output_tokens,
          cache_read: resp.usage.cache_read_input_tokens,
          // Actual $ cost is tracked on the proxy side — leave 0 here.
          cost: 0,
        });
        fullEvents.push({
          type: 'cost',
          data: {
            input_tokens: resp.usage.input_tokens || 0,
            output_tokens: resp.usage.output_tokens || 0,
            cache_read: resp.usage.cache_read_input_tokens || 0,
            cost: 0,
          },
        });
      }

      // Collect the assistant's reply (text + tool_use blocks)
      const assistantContent = resp.content || [];
      messages.push({ role: 'assistant', content: assistantContent });

      // Emit any text deltas
      for (const block of assistantContent) {
        if (block.type === 'text' && block.text) {
          finalResponse = (finalResponse ? finalResponse + '\n' : '') + block.text;
          onProgress?.('assistant_text', { text: block.text });
          fullEvents.push({ type: 'item.completed', item: { type: 'agent_message', text: block.text } });
        }
      }

      if (resp.stop_reason !== 'tool_use') break;

      // Execute every tool_use block (in parallel is tempting; do serial for
      // safety — some MCP servers can't handle concurrent calls)
      const toolResults = [];
      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;
        if (killed) break;
        emitActivity(processKey, 'tool_use', block.name);
        const output = await dispatchTool(block.name, block.input, onProgress);
        resetIdle(`tool ${block.name}`);
        fullEvents.push({
          type: 'item.completed',
          item: { type: 'tool_use', tool_name: block.name, input: block.input, output: output.slice(0, 2000) },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: String(output).slice(0, 20000),
        });
      }

      if (toolResults.length === 0) break; // safety
      messages.push({ role: 'user', content: toolResults });
    }

    fullEvents.push({ type: 'turn.completed' });
    saveSession(sessionId, messages);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (processKey) unregister(processKey);
  }

  return {
    response: finalResponse,
    sessionId,
    fullEvents,
    questionRequest: null,
  };
}
