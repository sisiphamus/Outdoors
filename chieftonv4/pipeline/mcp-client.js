// MCP client — spawns stdio MCP servers, speaks JSON-RPC, exposes each
// server's tools as Anthropic-shape tool definitions.
//
// Codex used to handle this internally. Now that we drive the model loop
// ourselves, we need a minimal MCP client that can:
//   - Spawn `npx some-mcp-server` as a subprocess
//   - Initialize the JSON-RPC session
//   - Call tools/list to discover what's available
//   - Call tools/call to dispatch tool_use from Claude
//
// One subprocess per server, reused across agent turns. Pre-warmed at
// pipeline startup so the first request doesn't eat a 30s boot lag.

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_CONFIG_PATH = join(__dirname, '..', 'mcp-bot.json');

const servers = new Map(); // name → { proc, nextId, pending, toolNames }

function loadMcpConfig() {
  if (!existsSync(MCP_CONFIG_PATH)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error('[mcp-client] Failed to parse mcp-bot.json:', err.message);
    return { mcpServers: {} };
  }
}

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────

function writeRpc(proc, obj) {
  const line = JSON.stringify(obj) + '\n';
  try { proc.stdin.write(line); } catch (err) {
    console.error('[mcp-client] stdin write failed:', err.message);
  }
}

function attachStdout(srv) {
  let buf = '';
  srv.proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (msg.id != null && srv.pending.has(msg.id)) {
        const { resolve, reject } = srv.pending.get(msg.id);
        srv.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
        else resolve(msg.result);
      }
      // notifications (msg.method, no id) — ignore for now
    }
  });
  srv.proc.stderr.on('data', (chunk) => {
    // MCP servers log to stderr; keep quiet unless debugging
    const text = chunk.toString().trim();
    if (text && process.env.CHIEFTON_DEBUG_MCP) {
      console.log(`[mcp:${srv.name}:stderr]`, text);
    }
  });
  srv.proc.on('exit', (code) => {
    console.log(`[mcp-client] ${srv.name} exited (${code})`);
    servers.delete(srv.name);
  });
}

function callMethod(srv, method, params, timeoutMs = 60000) {
  const id = srv.nextId++;
  let timerHandle = null;
  const promise = new Promise((resolve, reject) => {
    srv.pending.set(id, { resolve, reject });
    timerHandle = setTimeout(() => {
      if (srv.pending.has(id)) {
        srv.pending.delete(id);
        reject(new Error(`MCP ${srv.name}.${method} timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
  // Swallow unhandled rejections — callers use .catch/try/catch explicitly,
  // but a stray timer can still fire after a race. This keeps the process alive.
  promise.catch(() => {});
  promise.finally(() => { if (timerHandle) clearTimeout(timerHandle); });
  writeRpc(srv.proc, { jsonrpc: '2.0', id, method, params: params || {} });
  return promise;
}

// ── Server lifecycle ────────────────────────────────────────────────────────

async function startServer(name, spec) {
  if (servers.has(name)) return servers.get(name);

  console.log(`[mcp-client] starting ${name}: ${spec.command} ${(spec.args || []).join(' ')}`);
  const proc = spawn(spec.command, spec.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // npx wrappers on Windows
    env: { ...process.env, ...(spec.env || {}) },
    windowsHide: true,
  });

  const srv = {
    name,
    proc,
    nextId: 1,
    pending: new Map(),
    toolNames: new Set(),
  };
  servers.set(name, srv);
  attachStdout(srv);

  // MCP handshake
  try {
    await callMethod(srv, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'chiefton', version: '1.0' },
    }, 30000);
    writeRpc(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch (err) {
    console.error(`[mcp-client] ${name} init failed:`, err.message);
    try { proc.kill(); } catch {}
    servers.delete(name);
    throw err;
  }

  return srv;
}

async function listToolsFor(srv) {
  const result = await callMethod(srv, 'tools/list', {}, 15000);
  const tools = (result?.tools || []).map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
  srv.toolNames = new Set(tools.map(t => t.name));
  return tools;
}

// ── Public API ──────────────────────────────────────────────────────────────

let cachedTools = null; // [{ name, description, input_schema, _server }]

/**
 * Start all configured MCP servers and return their combined tool list
 * in Anthropic-compatible format. Cached after the first call.
 */
export async function getMcpTools() {
  if (cachedTools) return cachedTools;

  const config = loadMcpConfig();
  const allTools = [];
  const entries = Object.entries(config.mcpServers || {});

  for (const [name, spec] of entries) {
    try {
      const srv = await startServer(name, spec);
      const tools = await listToolsFor(srv);
      for (const t of tools) {
        allTools.push({
          name: t.name,
          description: `[${name}] ${t.description}`,
          input_schema: t.input_schema,
          _server: name, // internal routing hint; stripped before sending to Claude
        });
      }
      console.log(`[mcp-client] ${name}: ${tools.length} tools registered`);
    } catch (err) {
      console.error(`[mcp-client] Failed to register ${name}:`, err.message);
    }
  }

  cachedTools = allTools;
  return allTools;
}

/**
 * Dispatch a tool call. Returns the textual result (or a JSON-stringified
 * structured result) the model can read.
 */
export async function callMcpTool(toolName, input) {
  if (!cachedTools) await getMcpTools();

  const tool = cachedTools.find(t => t.name === toolName);
  if (!tool) throw new Error(`Unknown MCP tool: ${toolName}`);

  const srv = servers.get(tool._server);
  if (!srv) throw new Error(`MCP server ${tool._server} not running`);

  const result = await callMethod(srv, 'tools/call', {
    name: toolName,
    arguments: input || {},
  }, 120000);

  // MCP results are { content: [{ type: 'text', text }, ...], isError? }
  if (!result) return '';
  if (result.isError) {
    const msg = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return `[mcp error] ${msg || 'unknown error'}`;
  }
  const parts = (result.content || []).map(c => {
    if (c.type === 'text') return c.text;
    if (c.type === 'image') return '[image content]';
    return JSON.stringify(c);
  });
  return parts.join('\n') || '(empty result)';
}

export function isMcpTool(name) {
  return cachedTools?.some(t => t.name === name) || false;
}

/**
 * Shut down all running MCP servers. Called on process exit.
 */
export function shutdownMcp() {
  for (const [name, srv] of servers) {
    try { srv.proc.kill(); } catch {}
    servers.delete(name);
  }
  cachedTools = null;
}

// Kill children cleanly on backend exit
process.on('beforeExit', shutdownMcp);
process.on('SIGTERM', () => { shutdownMcp(); process.exit(0); });
process.on('SIGINT', () => { shutdownMcp(); process.exit(0); });
