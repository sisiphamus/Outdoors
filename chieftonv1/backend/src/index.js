process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import QRCode from 'qrcode';
import { readdirSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { config, saveConfig, loadConfig } from './config.js';
import { startWhatsApp, setSocketIO, getStatus, getLastQR, reconnectWhatsApp } from './messaging-client.js';

import { execFile, execFileSync } from 'child_process';
import { executeCodexPrompt, killProcess, codeAgentOptions, getActiveProcessSummary, setProcessChangeListener, setProcessActivityListener, clearClarificationState } from './claude-bridge.js';
import { parseMessage, resolveSession, createOrUpdateConversation, closeConversation, listConversations, getConversationMode } from './conversation-manager.js';
import { assertRuntimeBridgeReady, createRuntimeAwareProgress, getRuntimeHealthStatus, getRuntimeStatusPayload } from './runtime-health.js';
import { extractImages } from './transport-utils.js';
import { createSession, closeSession, listActiveSessions, cleanupOrphanedSessionDirs } from '../../../chieftonv4/session/session-manager.js';
import { ensureBrowserReady } from './browser-health.js';

import { registerStartup } from './register-startup.js';
import { startAutomationScheduler, reloadAutomations } from './automation-scheduler.js';
import { recordTask, postPerMessageLog } from './telemetry.js';
import { hasQuota, incrementMessageCount, getQuotaStatus } from './quota.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHORT_TERM_DIR = join(__dirname, '..', 'bot', 'memory', 'short-term');
const LOGS_DIR = join(__dirname, '..', 'bot', 'logs');

// Read app version from the workspace's .app-version file written by Electron
// main.js (ensureWorkspace). Used as a fallback when CHIEFTON_APP_VERSION env
// var isn't set (e.g. when launching the backend directly without Electron).
function readAppVersionFile() {
  try {
    return readFileSync(join(__dirname, '..', '..', '..', '.app-version'), 'utf-8').trim();
  } catch {
    return null;
  }
}

const app = express();
const server = createServer(app);
// Generate a local auth token for CSRF protection on mutating endpoints
const LOCAL_AUTH_TOKEN = randomBytes(16).toString('hex');

const io = new Server(server, { cors: { origin: ['http://127.0.0.1:3847', 'http://localhost:3847', 'null'] } });

// Middleware: require auth token on mutating API endpoints
function requireLocalAuth(req, res, next) {
  const token = req.headers['x-local-token'];
  if (token !== LOCAL_AUTH_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: invalid or missing x-local-token' });
  }
  next();
}

// In-memory ring buffer — captures all log events so the devlog viewer
// can replay history even if it wasn't open when events occurred.
// Backed by a disk file (bot/chat-log.jsonl) so the chat feed survives
// backend restarts, app close/reopen, and auto-updates.
const LOG_BUFFER_MAX = 2000;
const logBuffer = [];
const CHAT_LOG_PATH = join(__dirname, '..', 'bot', 'chat-log.jsonl');
const CHAT_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB before rotation

// Load the tail of the persisted chat log into the ring buffer on startup so
// the dashboard sees historical events immediately after a backend restart.
function hydrateLogBufferFromDisk() {
  try {
    if (!existsSync(CHAT_LOG_PATH)) return;
    const raw = readFileSync(CHAT_LOG_PATH, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const recent = lines.slice(-LOG_BUFFER_MAX);
    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object') logBuffer.push(entry);
      } catch { /* skip malformed line */ }
    }
    if (logBuffer.length > 0) {
      console.log(`[chat-log] Restored ${logBuffer.length} event(s) from ${CHAT_LOG_PATH}`);
    }
  } catch (err) {
    console.warn(`[chat-log] Failed to hydrate ring buffer: ${err.message}`);
  }
}

// Rotate the chat log file if it exceeds CHAT_LOG_MAX_BYTES. On rotation we
// keep the most recent LOG_BUFFER_MAX entries (whatever is in memory) and
// rewrite the file to that, dropping older history. Prevents unbounded growth.
function maybeRotateChatLog() {
  try {
    if (!existsSync(CHAT_LOG_PATH)) return;
    const size = statSync(CHAT_LOG_PATH).size;
    if (size < CHAT_LOG_MAX_BYTES) return;
    const tmp = CHAT_LOG_PATH + '.rot.' + randomBytes(4).toString('hex');
    const content = logBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(tmp, content);
    renameSync(tmp, CHAT_LOG_PATH);
    console.log(`[chat-log] Rotated (was ${size} bytes, kept ${logBuffer.length} recent entries)`);
  } catch (err) {
    console.warn(`[chat-log] Rotation failed: ${err.message}`);
  }
}

let _chatLogWritesSinceRotationCheck = 0;
// Shared helper: push an event to the in-memory ring buffer AND persist to
// disk so the dashboard feed survives backend restarts. Used by every call
// site that mutates logBuffer (emitLog, the setSocketIO callback, and the
// process_activity listener — all near the bottom of this file).
function pushBufferedEvent(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  try {
    appendFileSync(CHAT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Rare: fresh-install race where the bot dir doesn't exist yet. Create
    // and retry once. Otherwise swallow — the in-memory buffer still works
    // and the dashboard still receives live events.
    try {
      mkdirSync(dirname(CHAT_LOG_PATH), { recursive: true });
      appendFileSync(CHAT_LOG_PATH, JSON.stringify(entry) + '\n');
    } catch { /* swallow */ }
  }
  if (++_chatLogWritesSinceRotationCheck >= 100) {
    _chatLogWritesSinceRotationCheck = 0;
    maybeRotateChatLog();
  }
}

function emitLog(type, data) {
  const entry = { type, data, timestamp: new Date().toISOString() };
  pushBufferedEvent(entry);
  io.emit('log', entry);
}

// Hydrate before anything else emits
hydrateLogBufferFromDisk();

app.use(express.json());
// API routes
app.get('/api/health/codex', (_req, res) => {
  try {
    const out = execFileSync('codex', ['--version'], { timeout: 10000, encoding: 'utf-8', shell: process.platform === 'win32' });
    res.json({ ok: true, version: out.trim() });
  } catch (err) {
    if (err.code === 'ENOENT' || (err.message && err.message.includes('not recognized'))) {
      res.json({ ok: false, error: 'not_found' });
    } else {
      res.json({ ok: false, error: 'unknown', detail: err.message });
    }
  }
});

app.get('/api/status', (_req, res) => {
  res.json({ status: getStatus(), ...getRuntimeStatusPayload() });
});

app.get('/api/runtime', (_req, res) => {
  res.json(getRuntimeStatusPayload());
});

app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    allowedNumbers: cfg.allowedNumbers,
    allowAllNumbers: cfg.allowAllNumbers,
    prefix: cfg.prefix,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    maxResponseLength: cfg.maxResponseLength,
    messageTimeout: cfg.messageTimeout,
  });
});

app.post('/api/config', requireLocalAuth, (req, res) => {
  const cfg = loadConfig();
  const allowed = ['allowedNumbers', 'allowAllNumbers', 'prefix', 'rateLimitPerMinute', 'maxResponseLength', 'messageTimeout'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      cfg[key] = req.body[key];
      config[key] = req.body[key];
    }
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

// Bluetooth connect endpoint — runs connect-bt.ps1 (Windows only)
app.post('/api/bluetooth/connect', (_req, res) => {
  if (process.platform !== 'win32') {
    return res.json({ ok: false, error: 'Bluetooth connect not available on this platform' });
  }
  const scriptPath = join(__dirname, '..', 'connect-bt.ps1');
  execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.log('[Bluetooth] Error:', err.message);
      return res.json({ ok: false, error: err.message, output: stdout + stderr });
    }
    console.log('[Bluetooth]', stdout);
    const success = stdout.includes('SUCCESS') || stdout.includes('Status: OK');
    res.json({ ok: success, output: stdout });
  });
});

app.get('/api/qr', async (_req, res) => {
  const qr = getLastQR();
  if (!qr) return res.status(404).send('No QR available');
  try {
    const svg = await QRCode.toString(qr, { type: 'svg', margin: 2 });
    res.type('svg').send(svg);
  } catch {
    res.status(500).send('QR generation failed');
  }
});

// --- Conversation log index (built on startup, updated incrementally) ---
let logIndex = []; // [{ filename, sessionId, conversationNumber, sender, prompt, timestamp, cost }]
let logCounter = 0;

export function nextLogNumber() {
  return logCounter++;
}

function extractAnalyticsFields(data) {
  const events = data.fullEvents || data.events || [];
  const costEvents = events.filter(e => e.type === 'cost');
  const toolEvents = events.filter(e => e.type === 'tool_use');
  const toolSummary = {};
  for (const tc of toolEvents) {
    const name = tc.tool || tc.data?.tool || 'unknown';
    toolSummary[name] = (toolSummary[name] || 0) + 1;
  }
  return {
    cost: costEvents.reduce((s, e) => s + (e.cost || e.data?.cost || 0), 0),
    inputTokens: costEvents.reduce((s, e) => s + (e.input_tokens || e.data?.input_tokens || 0), 0),
    outputTokens: costEvents.reduce((s, e) => s + (e.output_tokens || e.data?.output_tokens || 0), 0),
    cacheTokens: costEvents.reduce((s, e) => s + (e.cache_read || e.data?.cache_read || 0), 0),
    durationMs: data.durationMs || 0,
    platform: data.platform || (data.jid ? 'whatsapp' : 'web'),
    toolSummary,
    hasError: !!data.error,
  };
}

function buildLogEntry(filename, data) {
  const analytics = extractAnalyticsFields(data);
  return {
    filename,
    sessionId: data.sessionId || null,
    conversationNumber: data.conversationNumber ?? null,
    sender: data.sender || 'unknown',
    prompt: (data.prompt || '').slice(0, 80),
    timestamp: data.timestamp,
    ...analytics,
  };
}

function buildLogIndex() {
  try {
    const files = readdirSync(LOGS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const num = parseInt(f, 10);
      if (!isNaN(num) && num >= logCounter) logCounter = num + 1;
    }
    logIndex = files.map(filename => {
      try {
        const data = JSON.parse(readFileSync(join(LOGS_DIR, filename), 'utf-8'));
        return buildLogEntry(filename, data);
      } catch { return null; }
    }).filter(Boolean);
  } catch { logIndex = []; }
}

export function addToLogIndex(filename, data) {
  logIndex.push(buildLogEntry(filename, data));
}

// Conversation API endpoints
app.get('/api/conversations', (_req, res) => {
  // Group logs by sessionId
  const groups = {};
  for (const entry of logIndex) {
    const key = entry.sessionId || entry.filename;
    if (!groups[key]) {
      groups[key] = {
        sessionId: entry.sessionId,
        conversationNumber: entry.conversationNumber,
        sender: entry.sender,
        firstMessage: entry.prompt,
        firstTimestamp: entry.timestamp,
        lastTimestamp: entry.timestamp,
        messageCount: 0,
        totalCost: 0,
      };
    }
    const g = groups[key];
    g.messageCount++;
    g.totalCost += entry.cost || 0;
    if (entry.conversationNumber !== null) g.conversationNumber = entry.conversationNumber;
    if (entry.timestamp > g.lastTimestamp) g.lastTimestamp = entry.timestamp;
    if (entry.timestamp < g.firstTimestamp) {
      g.firstTimestamp = entry.timestamp;
      g.firstMessage = entry.prompt;
    }
  }
  const list = Object.values(groups).sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  res.json(list);
});

app.get('/api/conversations/active', (_req, res) => {
  res.json(listConversations());
});

app.get('/api/processes', (_req, res) => {
  res.json(getActiveProcessSummary());
});

// Analytics endpoint — aggregates from in-memory logIndex
app.get('/api/analytics', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const filtered = logIndex.filter(e => e.timestamp >= cutoff);

  // Totals
  const totalMessages = filtered.length;
  const totalCost = filtered.reduce((s, e) => s + (e.cost || 0), 0);
  const totalDuration = filtered.reduce((s, e) => s + (e.durationMs || 0), 0);
  const avgDurationMs = totalMessages > 0 ? Math.round(totalDuration / totalMessages) : 0;
  const totalInputTokens = filtered.reduce((s, e) => s + (e.inputTokens || 0), 0);
  const totalOutputTokens = filtered.reduce((s, e) => s + (e.outputTokens || 0), 0);
  const totalCacheTokens = filtered.reduce((s, e) => s + (e.cacheTokens || 0), 0);
  const errorCount = filtered.filter(e => e.hasError).length;

  // Daily breakdown
  const dailyMap = {};
  for (const e of filtered) {
    const day = e.timestamp?.slice(0, 10) || 'unknown';
    if (!dailyMap[day]) dailyMap[day] = { date: day, messages: 0, cost: 0 };
    dailyMap[day].messages++;
    dailyMap[day].cost += e.cost || 0;
  }
  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // By platform
  const byPlatform = { whatsapp: 0, web: 0 };
  for (const e of filtered) byPlatform[e.platform || 'web']++;

  // Top tools
  const toolTotals = {};
  for (const e of filtered) {
    for (const [name, count] of Object.entries(e.toolSummary || {})) {
      toolTotals[name] = (toolTotals[name] || 0) + count;
    }
  }
  const topTools = Object.entries(toolTotals)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Peak hours
  const peakHours = new Array(24).fill(0);
  for (const e of filtered) {
    try { peakHours[new Date(e.timestamp).getHours()]++; } catch {}
  }

  // Top senders
  const senderMap = {};
  for (const e of filtered) {
    const name = e.sender || 'unknown';
    senderMap[name] = (senderMap[name] || 0) + 1;
  }
  const topSenders = Object.entries(senderMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  res.json({
    totals: { messages: totalMessages, cost: Math.round(totalCost * 1000) / 1000, avgDurationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheTokens: totalCacheTokens, errors: errorCount },
    daily,
    byPlatform,
    topTools,
    peakHours,
    topSenders,
  });
});

app.get('/api/conversations/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  const matching = logIndex.filter(e => e.sessionId === sid);
  if (!matching.length) return res.status(404).json({ error: 'Not found' });

  const messages = matching
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map(entry => {
      try {
        return JSON.parse(readFileSync(join(LOGS_DIR, entry.filename), 'utf-8'));
      } catch { return null; }
    })
    .filter(Boolean);

  res.json({
    sessionId: sid,
    conversationNumber: matching[0].conversationNumber,
    messages,
  });
});

// Session isolation API endpoints
app.get('/api/sessions', (_req, res) => {
  res.json(listActiveSessions());
});

app.delete('/api/sessions/:id', requireLocalAuth, (req, res) => {
  const id = req.params.id;
  const sessions = listActiveSessions();
  const session = sessions.find(s => s.id === id);
  if (session) {
    killProcess(session.processKey);
    closeSession(id);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Web chat session tracking
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
let webSession = { sessionId: null, lastActivity: 0 };  // fallback for non-windowed, unnumbered clients only
const socketSessions = new Map();  // Map<socketId, { sessionId, lastActivity }> — per-socket isolation for dashboard windows
const activeWebConversations = new Set();  // numbered conv numbers currently in-flight
const activeWebWindows = new Set();         // windowIds currently in-flight (unnumbered)
const activePrompts = new Map();            // Map<convNumber, { prompt, processKey }> — for mid-execution context injection

function cleanupShortTerm() {
  try {
    const files = readdirSync(SHORT_TERM_DIR);
    for (const f of files) unlinkSync(join(SHORT_TERM_DIR, f));
  } catch {}
}

function normalizeQuestionsPayload(payload) {
  if (!payload) return { questions: [] };
  if (Array.isArray(payload.questions)) return payload;
  if (Array.isArray(payload)) return { questions: payload };
  return { questions: [], raw: payload };
}

// Socket.IO
io.on('connection', async (socket) => {
  socket.emit('status', getStatus());
  socket.emit('process_status', getActiveProcessSummary());

  // Replay buffered log history so the devlog viewer shows past events
  if (logBuffer.length > 0) {
    socket.emit('log_history', logBuffer);
  }

  // Re-send last QR if one exists (handles page load after QR was generated)
  const qr = getLastQR();
  if (qr && getStatus() === 'waiting_for_qr') {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      socket.emit('qr', dataUrl);
    } catch {}
  }

  // Web chat messages — accepts string or { text, image, sessionId } object
  socket.on('web_message', async (data) => {
    let prompt, imageBase64, imageMime, clientSessionId, windowId;
    if (typeof data === 'string') {
      prompt = data;
    } else if (data && typeof data === 'object') {
      prompt = data.text || '';
      imageBase64 = data.image; // base64-encoded image data
      imageMime = data.imageMime || 'image/jpeg';
      clientSessionId = data.sessionId || null;
      windowId = data.windowId || null;
    }
    if ((!prompt || typeof prompt !== 'string' || !prompt.trim()) && !imageBase64) return;

    const trimmed = (prompt || '').trim();
    if (!trimmed && !imageBase64) return;

    // Handle /new to clear session
    if (trimmed && trimmed.toLowerCase() === '/new') {
      if (windowId) {
        socketSessions.delete(socket.id);
      } else {
        webSession = { sessionId: null, lastActivity: 0 };
      }
      clearClarificationState(`web:win:${windowId || '__no_window__'}`);
      socket.emit('chat_response', 'Session cleared. Next message starts fresh.');
      return;
    }

    // Parse message for numbered conversation prefix, stop/new commands, etc.
    // Always use parseMessage() regardless of source (dashboard, WhatsApp, etc.)
    // so numbered conversations and stop commands work consistently.
    const parsed = parseMessage(trimmed || 'What is this image?');

    // Handle new command (close a numbered conversation)
    if (parsed.command === 'new') {
      const closed = closeConversation(parsed.number);
      clearClarificationState(`web:conv:${parsed.number}`);
      socket.emit('chat_response', closed
        ? `Conversation #${parsed.number} closed.`
        : `No active conversation #${parsed.number}.`);
      return;
    }

    const windowKey = windowId || '__no_window__';

    // Handle stop command — bypass concurrency gating
    if (parsed.command === 'stop') {
      const processKey = parsed.number !== null ? `web:conv:${parsed.number}` : `web:win:${windowKey}`;
      const killed = killProcess(processKey);
      clearClarificationState(processKey);
      if (killed) {
        const label = parsed.number !== null ? `conversation #${parsed.number}` : 'current conversation';
        socket.emit('chat_response', `Stopped ${label}.`);
      } else {
        const label = parsed.number !== null ? `conversation #${parsed.number}` : 'this chat';
        socket.emit('chat_response', `Nothing running for ${label}.`);
      }
      return;
    }

    // Handle invite/refer command (web dashboard uses the same flow as WhatsApp)
    if (parsed.command === 'refer' || /^(invite|refer)\b/i.test(parsed.body || '')) {
      const { startReferralFlow, getReferralState, processReferralReply } = await import('./quota.js');
      const webJid = 'web:' + socket.id;
      const senderName = config.googleEmail?.split('@')[0]?.replace(/[._]/g, ' ') || 'A friend';
      if (!getReferralState(webJid)) {
        const r = startReferralFlow(webJid, senderName);
        socket.emit('chat_response', r.prompt);
      }
      return;
    }

    // Check if web user is in a referral flow
    {
      const { getReferralState, processReferralReply } = await import('./quota.js');
      const webJid = 'web:' + socket.id;
      if (getReferralState(webJid) && parsed.command === 'message') {
        const replyFn = (msg) => socket.emit('chat_response', msg);
        const killFn = () => {};
        const result = await processReferralReply(webJid, parsed.body, executeCodexPrompt, replyFn, killFn);
        if (result?.handled) {
          socket.emit('chat_response', result.reply);
          return;
        }
      }
    }

    // Quota check
    if (parsed.command === 'message' && !hasQuota()) {
      const status = getQuotaStatus();
      socket.emit('chat_response', `You've used your ${status.dailyQuota} messages for today! Invite a friend to get +10 messages/day.\n\nReply *invite* to send someone an invite.`);
      return;
    }

    // Mid-execution context injection: if this numbered conversation is already running,
    // kill it, combine prompts, and restart with the combined context
    if (parsed.number !== null && parsed.command === 'message' && activeWebConversations.has(parsed.number)) {
      const active = activePrompts.get(parsed.number);
      if (active) {
        killProcess(active.processKey);
        const combined = active.prompt + '\n\n[ADDITIONAL CONTEXT from user]: ' + parsed.body;
        activePrompts.delete(parsed.number);
        activeWebConversations.delete(parsed.number);
        parsed = { ...parsed, body: combined };
        const truncated = parsed.body.length > 60 ? parsed.body.slice(0, 60) + '...' : parsed.body;
        socket.emit('chat_response', `Got it — adding to the current task.`);
        emitLog('context_injected', { sender: 'web', processKey: `web:conv:${parsed.number}`, conversation: parsed.number, addition: truncated });
        // Fall through to normal execution with combined prompt
      }
    }

    // Track active conversations/windows (for cleanup gating, not blocking)
    if (parsed.number !== null) {
      activeWebConversations.add(parsed.number);
    } else {
      activeWebWindows.add(windowKey);
    }

    // Unique ID for correlating responses when multiple messages are in-flight
    const messageId = randomBytes(4).toString('hex');

    // Determine session: numbered conversations use their own isolated session from conversation-manager.
    // Dashboard windows use per-socket session tracking. Only non-windowed, unnumbered clients
    // fall back to the global webSession.
    let resumeSessionId = null;
    if (parsed.number !== null) {
      resumeSessionId = resolveSession(parsed.number);
    } else if (clientSessionId) {
      resumeSessionId = clientSessionId;
    } else if (windowId) {
      const sockSession = socketSessions.get(socket.id);
      if (sockSession && (Date.now() - sockSession.lastActivity) < SESSION_TIMEOUT_MS) {
        resumeSessionId = sockSession.sessionId;
      }
    } else if (webSession.sessionId && (Date.now() - webSession.lastActivity) < SESSION_TIMEOUT_MS) {
      resumeSessionId = webSession.sessionId;
    }

    const processKey = parsed.number !== null ? `web:conv:${parsed.number}` : `web:win:${windowKey}`;
    console.log(`[dispatch] "${(parsed.body || '').slice(0, 40)}" → processKey=${processKey} resume=${resumeSessionId || 'fresh'}`);

    // Create an isolated session for this execution (must be before image saving)
    const session = createSession(processKey, 'web');

    // Save image to disk if present (session-scoped directory)
    let finalPrompt = parsed.body;
    if (imageBase64) {
      try {
        const imageDir = session.shortTermDir;
        mkdirSync(imageDir, { recursive: true });
        const ext = imageMime.includes('png') ? 'png' : 'jpg';
        const filename = `web_${randomBytes(4).toString('hex')}.${ext}`;
        const filepath = join(imageDir, filename);
        writeFileSync(filepath, Buffer.from(imageBase64, 'base64'));
        const caption = finalPrompt || 'What is this image?';
        finalPrompt = `[The user sent an image. Read it with your Read tool at: ${filepath}]\n\n${caption}`;
      } catch (err) {
        console.log('[web:image_save_error]', err.message);
      }
    }

    // Store prompt for mid-execution context injection
    if (parsed.number !== null) {
      activePrompts.set(parsed.number, { prompt: finalPrompt, processKey });
    }

    const startTime = Date.now();
    const convoLog = { sender: 'web', prompt: finalPrompt, conversationNumber: parsed.number, resumeSessionId, timestamp: new Date().toISOString(), platform: 'web', events: [] };
    const isKnownCode = parsed.number !== null && getConversationMode(parsed.number) === 'code';
    // Track current sessionId for progress events (starts with resume or client-provided)
    let currentSessionId = resumeSessionId || clientSessionId || null;
    io.emit('session_created', { id: session.id, processKey, transport: 'web' });
    emitLog('incoming', { sender: 'web', processKey, prompt: finalPrompt, conversation: parsed.number });

    try {
      const progressWrapper = createRuntimeAwareProgress((type, data) => {
        emitLog(type, { sender: 'web', processKey, ...data });
        io.emit('devlog', { type, data, sessionId: currentSessionId, processKey });
        convoLog.events.push({ type, ...data });
        socket.emit('chat_progress', { type, data, sessionId: currentSessionId, messageId });
      });
      const onProgress = progressWrapper.onProgress;
      convoLog.runtimeFingerprint = progressWrapper.health.bootFingerprint;
      convoLog.runtimeStaleDetected = progressWrapper.health.stale;
      convoLog.runtimeChangedFiles = progressWrapper.health.changedFiles;
      if (progressWrapper.health.stale) {
        emitLog('runtime_stale_code_detected', { sender: 'web', processKey, changedFiles: progressWrapper.health.changedFiles });
      }

      let execResult;
      let didDelegate = false;
      if (isKnownCode) {
        execResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress, resumeSessionId, processKey, clarificationKey: processKey, sessionContext: session }));
      } else {
        execResult = await executeCodexPrompt(finalPrompt, { onProgress, resumeSessionId, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
        if (execResult.delegation) {
          didDelegate = true;
          emitLog('delegation', { sender: 'web', processKey, employee: 'coder', model: execResult.delegation.model });
          socket.emit('chat_progress', { type: 'delegation', data: { employee: 'coder', model: execResult.delegation.model }, sessionId: currentSessionId, messageId });
          execResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }, execResult.delegation.model));
        }
      }
      if (execResult.status === 'needs_user_input') {
        convoLog.clarificationState = {
          status: 'needs_user_input',
          questions: execResult.questions,
        };
        socket.emit('chat_questions', {
          questions: normalizeQuestionsPayload(execResult.questions),
          sessionId: currentSessionId,
          windowId,
          messageId,
        });
        emitLog('clarification_requested', { sender: 'web', processKey, conversation: parsed.number, windowId });
        return;
      }
      const { response, sessionId, fullEvents } = execResult;
      if (sessionId) currentSessionId = sessionId;

      const mode = (isKnownCode || didDelegate) ? 'code' : 'assistant';
      if (sessionId) {
        if (parsed.number !== null) {
          // Numbered conversations only update their own entry — never pollute the global
          createOrUpdateConversation(parsed.number, sessionId, parsed.body, 'web', mode);
        } else if (windowId) {
          // Dashboard windows track sessions per-socket for isolation
          socketSessions.set(socket.id, { sessionId, lastActivity: Date.now() });
        } else {
          // Non-windowed, unnumbered clients use the global fallback
          webSession = { sessionId, lastActivity: Date.now() };
        }
      }
      convoLog.response = response;
      convoLog.sessionId = sessionId;
      convoLog.fullEvents = fullEvents;
      incrementMessageCount();
      const { images: responseImages, cleanText: responseCleanText } = extractImages(response);
      socket.emit('chat_response', { response: responseCleanText, sessionId: currentSessionId, images: responseImages, messageId });
      // Persist the assistant's reply to the chat log so it survives restarts
      emitLog('sent', { to: 'web', sender: 'web', response: responseCleanText, responseLength: responseCleanText.length, processKey, conversation: parsed.number });
      io.emit('conversation_update', { sessionId, conversationNumber: parsed.number });
    } catch (err) {
      if (err.stopped) {
        // Stop handler already sent a response — just let finally clean up
      } else if (resumeSessionId) {
        // Retry without session if resume failed
        webSession = { sessionId: null, lastActivity: 0 };
        currentSessionId = null;
        try {
          const progressWrapper = createRuntimeAwareProgress((type, data) => {
            emitLog(type, { sender: 'web', processKey, ...data });
            io.emit('devlog', { type, data, sessionId: currentSessionId, processKey });
            convoLog.events.push({ type, ...data });
            socket.emit('chat_progress', { type, data, sessionId: currentSessionId, messageId });
          });
          const onProgress = progressWrapper.onProgress;
          convoLog.runtimeFingerprint = progressWrapper.health.bootFingerprint;
          convoLog.runtimeStaleDetected = progressWrapper.health.stale;
          convoLog.runtimeChangedFiles = progressWrapper.health.changedFiles;
          if (progressWrapper.health.stale) {
            emitLog('runtime_stale_code_detected', { sender: 'web', processKey, changedFiles: progressWrapper.health.changedFiles });
          }

          let execResult;
          let didDelegate = false;
          if (isKnownCode) {
            execResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }));
          } else {
            execResult = await executeCodexPrompt(finalPrompt, { onProgress, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
            if (execResult.delegation) {
              didDelegate = true;
              socket.emit('chat_progress', { type: 'delegation', data: { employee: 'coder', model: execResult.delegation.model }, sessionId: currentSessionId, messageId });
              execResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }, execResult.delegation.model));
            }
          }
          if (execResult.status === 'needs_user_input') {
            convoLog.clarificationState = {
              status: 'needs_user_input',
              questions: execResult.questions,
            };
            socket.emit('chat_questions', {
              questions: normalizeQuestionsPayload(execResult.questions),
              sessionId: currentSessionId,
              windowId,
              messageId,
            });
            emitLog('clarification_requested', { sender: 'web', processKey, conversation: parsed.number, windowId });
            return;
          }
          const { response, sessionId, fullEvents } = execResult;
          if (sessionId) currentSessionId = sessionId;

          const mode = (isKnownCode || didDelegate) ? 'code' : 'assistant';
          if (sessionId) {
            if (parsed.number !== null) {
              createOrUpdateConversation(parsed.number, sessionId, finalPrompt, 'web', mode);
            } else if (windowId) {
              socketSessions.set(socket.id, { sessionId, lastActivity: Date.now() });
            } else {
              webSession = { sessionId, lastActivity: Date.now() };
            }
          }
          convoLog.response = response;
          convoLog.sessionId = sessionId;
          convoLog.fullEvents = fullEvents;
          const { images: retryImages, cleanText: retryCleanText } = extractImages(response);
          socket.emit('chat_response', { response: retryCleanText, sessionId: currentSessionId, images: retryImages, messageId });
          emitLog('sent', { to: 'web', sender: 'web', response: retryCleanText, responseLength: retryCleanText.length, processKey, conversation: parsed.number });
        } catch (retryErr) {
          convoLog.error = retryErr.message;
          socket.emit('chat_error', { error: retryErr.message, messageId });
        }
      } else {
        convoLog.error = err.message;
        socket.emit('chat_error', { error: err.message, messageId });
      }
    } finally {
      // Release tracking for this conversation/window
      if (parsed.number !== null) {
        activeWebConversations.delete(parsed.number);
        activePrompts.delete(parsed.number);
      } else {
        activeWebWindows.delete(windowKey);
      }

      // Close the session — cleans up this session's short-term dir only
      closeSession(session.id);
      io.emit('session_closed', { id: session.id });
    }

    // Persist log + telemetry
    try {
      convoLog.durationMs = Date.now() - startTime;
      mkdirSync(LOGS_DIR, { recursive: true });
      const filename = `${nextLogNumber()}_web.json`;
      writeFileSync(join(LOGS_DIR, filename), JSON.stringify(convoLog, null, 2));
      addToLogIndex(filename, convoLog);
      // Anonymous usage telemetry (counts only, no content)
      const analytics = extractAnalyticsFields(convoLog);
      recordTask({
        durationMs: convoLog.durationMs,
        platform: 'web',
        toolCount: Object.values(analytics.toolSummary).reduce((s, n) => s + n, 0),
        cost: analytics.cost,
        inputTokens: analytics.inputTokens,
        outputTokens: analytics.outputTokens,
        cacheTokens: analytics.cacheTokens,
        hasError: !!convoLog.error,
      });
      // Per-message log (mirrors WhatsApp path so web messages also appear in dashboard)
      postPerMessageLog({
        durationMs: convoLog.durationMs,
        platform: 'web',
        costUsd: analytics.cost,
        tokens: (analytics.inputTokens || 0) + (analytics.outputTokens || 0),
        status: convoLog.error ? 'FAIL' : 'OK',
      });
    } catch {}
  });

  socket.on('disconnect', () => {
    socketSessions.delete(socket.id);
  });

  console.log('Dashboard client connected');
});

setSocketIO(io, (entry) => {
  // Callback given to whatsapp-client's emitLog so WA events land in the
  // shared ring buffer AND get persisted to disk for post-restart replay.
  pushBufferedEvent(entry);
});
setProcessChangeListener(() => io.emit('process_status', getActiveProcessSummary()));
setProcessActivityListener((processKey, type, summary) => {
  const entry = { type: 'process_activity', data: { processKey, type: type, summary }, timestamp: new Date().toISOString() };
  pushBufferedEvent(entry);
  io.emit('process_activity', { processKey, type, summary });
});

// Build log index before starting
buildLogIndex();
console.log(`  [Logs] Indexed ${logIndex.length} conversation logs`);

// Clean up orphaned session directories from previous crashes
cleanupOrphanedSessionDirs();
console.log('  [Sessions] Cleaned up orphaned session directories');
assertRuntimeBridgeReady();
const runtimeHealth = getRuntimeHealthStatus();
console.log(`  [Runtime] PID ${runtimeHealth.bootFingerprint.pid} started ${runtimeHealth.bootFingerprint.processStartTime}`);
console.log(`  [Runtime] git=${runtimeHealth.bootFingerprint.gitCommit || 'unknown'} stale=${runtimeHealth.stale}`);
if (runtimeHealth.stale) {
  console.log(`  [Runtime] changed files: ${runtimeHealth.changedFiles.map(f => f.path).join(', ')}`);
}

// Auth token endpoint — Electron main process fetches this once on startup
// Safe because the server only binds to 127.0.0.1
app.get('/api/auth-token', (_req, res) => {
  res.json({ token: LOCAL_AUTH_TOKEN });
});

// Start
server.listen(config.port, '127.0.0.1', async () => {
  console.log(`\n  Chiefton Bot`);
  console.log(`  API: http://localhost:${config.port}\n`);

  try {
    // Register app to start automatically at Windows login (idempotent)
    await registerStartup();

    // Ensure browser is running with CDP for Playwright tasks
    await ensureBrowserReady();

    // Start WhatsApp bridge
    console.log('  [WhatsApp] Starting...');
    startWhatsApp();

    // Start automation scheduler
    startAutomationScheduler({ io, emitLog, executeCodexPrompt, config, saveConfig, loadConfig });
  } catch (err) {
    console.error('[startup] Failed:', err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${config.port} is already in use — another instance may be running. Exiting.`);
    process.exit(1);
  }
  console.error('[FATAL] Server error:', err);
  process.exit(1);
});

// Automation reload endpoint — called by Electron main after config changes
app.post('/api/automations/reload', requireLocalAuth, (_req, res) => {
  reloadAutomations();
  res.json({ ok: true });
});

// Bug report endpoint
app.post('/api/bug-report', express.json(), async (req, res) => {
  const { title, description, severity } = req.body || {};
  if (!title || !description) return res.status(400).json({ ok: false, error: 'Title and description required.' });

  const report = {
    title,
    description,
    severity: severity || 'medium',
    timestamp: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    appVersion: process.env.CHIEFTON_APP_VERSION || config.appVersion || readAppVersionFile() || 'unknown',
    googleEmail: config.googleEmail || 'unknown',
  };

  // Save locally
  const reportsDir = join(__dirname, '..', 'bot', 'logs', 'bug-reports');
  try {
    mkdirSync(reportsDir, { recursive: true });
    const filename = `${Date.now()}-${severity}.json`;
    writeFileSync(join(reportsDir, filename), JSON.stringify(report, null, 2));
  } catch {}

  // POST to Cloudflare telemetry worker (instant, no Codex needed)
  try {
    const https = await import('https');
    const body = JSON.stringify(report);
    const url = new URL('https://chiefton-telemetry.towneradamm.workers.dev/v1/bug');
    const req = https.default.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, () => {});
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch {}

  res.json({ ok: true });
});

app.post('/api/whatsapp/reconnect', async (_req, res) => {
  try {
    const result = await reconnectWhatsApp();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
