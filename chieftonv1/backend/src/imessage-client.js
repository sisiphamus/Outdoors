/**
 * iMessage transport client for macOS.
 *
 * Sends messages via AppleScript (Messages.app) and receives by polling
 * the local iMessage SQLite database (~Library/Messages/chat.db).
 *
 * Exports the same interface as whatsapp-client.js so messaging-client.js
 * can swap between transports transparently.
 *
 * Requirements:
 *   - macOS with Messages.app signed in to an Apple ID
 *   - Full Disk Access granted to the Electron app (for chat.db)
 *   - Automation permission for Messages.app
 */

import { execFile, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';

import { config, saveConfig } from './config.js';
import { handleMessage } from './message-handler.js';
import { isOnboardingNeeded, handleOnboardingMessage } from './onboarding.js';
import { addToLogIndex, nextLogNumber } from './index.js';
import { extractImages } from './transport-utils.js';
import { formatChieftonResponse } from './wa-formatter.js';
import { recordTask, postPerMessageLog } from './telemetry.js';
import { hasQuota, incrementMessageCount, getQuotaStatus, startReferralFlow, getReferralState, processReferralReply } from './quota.js';
import { closeSession } from '../../../chieftonv4/session/session-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', 'bot', 'logs');

// ── State ────────────────────────────────────────────────────────────────────

let io = null;
let bufferPush = null;
let connectionStatus = 'disconnected';
let pollTimer = null;
let lastSeenRowId = 0;    // tracks the last ROWID we've processed from chat.db
let db = null;             // better-sqlite3 instance
const processedGuids = new Set();   // dedup incoming messages
const MAX_PROCESSED_GUIDS = 2000;
const botSentTexts = new Set();     // track texts we sent to avoid echo
const MAX_BOT_SENT = 500;

// The phone number or email the user interacts with (their own handle).
// In iMessage the "group" concept doesn't apply the same way — messages
// go to/from a specific handle (phone/email). We store the configured
// chat partner handle in config.imessageHandle.

// ── Logging ──────────────────────────────────────────────────────────────────

function emitLog(type, data) {
  const entry = { type, data, timestamp: new Date().toISOString() };
  bufferPush?.(entry);
  io?.emit('log', entry);
  if (data?.processKey) {
    io?.emit('devlog', { type, data, processKey: data.processKey, timestamp: entry.timestamp });
  }
  if (type !== 'qr') {
    console.log(`[${type}]`, JSON.stringify(data));
  }
}

// ── AppleScript helpers ──────────────────────────────────────────────────────

/**
 * Run an AppleScript string via osascript. Returns stdout.
 */
function runAppleScript(script, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`AppleScript error: ${err.message}${stderr ? ` — ${stderr}` : ''}`));
      resolve(stdout.trim());
    });
  });
}

/**
 * Send a text message to a handle (phone number or email) via Messages.app.
 */
async function sendText(handle, text) {
  // Escape backslashes and double-quotes for AppleScript string
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script =
    `tell application "Messages"\n` +
    `  set targetService to 1st account whose service type = iMessage\n` +
    `  set targetBuddy to participant "${handle}" of targetService\n` +
    `  send "${escaped}" to targetBuddy\n` +
    `end tell`;
  await runAppleScript(script, 30000);
}

/**
 * Send an image (file path) to a handle via Messages.app.
 */
async function sendImage(handle, filePath) {
  const posixPath = filePath.replace(/\\/g, '/');
  const script =
    `tell application "Messages"\n` +
    `  set targetService to 1st account whose service type = iMessage\n` +
    `  set targetBuddy to participant "${handle}" of targetService\n` +
    `  send POSIX file "${posixPath}" to targetBuddy\n` +
    `end tell`;
  await runAppleScript(script, 30000);
}

/**
 * Check if Messages.app is running and signed in.
 */
async function checkMessagesApp() {
  try {
    const result = await runAppleScript(
      'tell application "System Events" to return (name of processes) contains "Messages"'
    );
    return result === 'true';
  } catch {
    return false;
  }
}

// ── SQLite polling (incoming messages) ───────────────────────────────────────

const CHAT_DB_PATH = join(process.env.HOME || '', 'Library', 'Messages', 'chat.db');

/**
 * Open the iMessage database (read-only).
 */
function openDatabase() {
  if (!existsSync(CHAT_DB_PATH)) {
    throw new Error(`iMessage database not found at ${CHAT_DB_PATH}. Is Messages.app set up?`);
  }
  // Open read-only — we never write to Apple's database
  return new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
}

/**
 * Get the current max ROWID in the message table (for initial baseline).
 */
function getMaxRowId(db) {
  const row = db.prepare('SELECT MAX(ROWID) as maxId FROM message').get();
  return row?.maxId || 0;
}

/**
 * Poll for new messages since lastSeenRowId.
 * Returns array of { rowid, guid, text, handle, isFromMe, date, hasAttachment }.
 */
function pollNewMessages(db, sinceRowId) {
  const stmt = db.prepare(`
    SELECT
      m.ROWID as rowid,
      m.guid,
      m.text,
      m.is_from_me as isFromMe,
      m.date as coreDataDate,
      m.cache_has_attachments as hasAttachment,
      m.associated_message_type as assocType,
      h.id as handle
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.ROWID > ?
    ORDER BY m.ROWID ASC
    LIMIT 50
  `);
  return stmt.all(sinceRowId);
}

/**
 * Convert Core Data timestamp (nanoseconds since 2001-01-01) to JS Date.
 */
function coreDataToDate(coreDataTimestamp) {
  if (!coreDataTimestamp) return new Date();
  // Core Data epoch: 2001-01-01T00:00:00Z = 978307200 seconds since Unix epoch
  // chat.db stores nanoseconds since Core Data epoch
  const CORE_DATA_EPOCH = 978307200;
  const seconds = coreDataTimestamp / 1_000_000_000;
  return new Date((seconds + CORE_DATA_EPOCH) * 1000);
}

/**
 * Get attachment file paths for a message ROWID.
 */
function getAttachments(db, messageRowId) {
  const stmt = db.prepare(`
    SELECT a.filename, a.mime_type, a.transfer_name
    FROM attachment a
    JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
  `);
  const rows = stmt.all(messageRowId);
  return rows.map(r => ({
    path: r.filename?.replace(/^~/, process.env.HOME || ''),
    mimeType: r.mime_type,
    name: r.transfer_name,
  })).filter(a => a.path);
}

// ── Per-JID send serialization ───────────────────────────────────────────────

const handleSendLock = new Map();

async function withSendLock(handle, fn) {
  const prev = handleSendLock.get(handle) || Promise.resolve();
  const current = prev.then(fn, fn);
  handleSendLock.set(handle, current);
  try {
    return await current;
  } finally {
    if (handleSendLock.get(handle) === current) handleSendLock.delete(handle);
  }
}

// ── Bounded set helpers ──────────────────────────────────────────────────────

function addProcessedGuid(guid) {
  processedGuids.add(guid);
  if (processedGuids.size > MAX_PROCESSED_GUIDS) {
    const first = processedGuids.values().next().value;
    processedGuids.delete(first);
  }
}

function addBotSentText(text) {
  // Store a hash-like fingerprint to avoid holding huge strings
  const key = text.slice(0, 100);
  botSentTexts.add(key);
  if (botSentTexts.size > MAX_BOT_SENT) {
    const first = botSentTexts.values().next().value;
    botSentTexts.delete(first);
  }
}

// ── Send with retry ──────────────────────────────────────────────────────────

async function sendWithRetry(handle, text, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sendText(handle, text);
      addBotSentText(text);
      return;
    } catch (err) {
      console.log(`[imessage:send] attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

async function sendImageWithRetry(handle, filePath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sendImage(handle, filePath);
      return;
    } catch (err) {
      console.log(`[imessage:send_image] attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// ── Core: start / poll loop ──────────────────────────────────────────────────

async function startIMessage() {
  console.log('[iMessage] Starting iMessage transport...');

  // Verify macOS
  if (process.platform !== 'darwin') {
    throw new Error('iMessage transport is only available on macOS');
  }

  // Check Messages.app
  const messagesRunning = await checkMessagesApp();
  if (!messagesRunning) {
    console.log('[iMessage] Messages.app not running — attempting to launch...');
    try {
      await runAppleScript('tell application "Messages" to activate');
      // Wait a moment for it to start
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.log('[iMessage] Failed to launch Messages.app:', err.message);
    }
  }

  // Open the database
  try {
    db = openDatabase();
    console.log('[iMessage] Opened chat.db successfully');
  } catch (err) {
    console.error('[iMessage] Failed to open chat.db:', err.message);
    console.error('[iMessage] Grant Full Disk Access to this app in System Settings > Privacy & Security');
    connectionStatus = 'error';
    io?.emit('status', connectionStatus);
    emitLog('imessage_error', { message: `Cannot access iMessage database: ${err.message}` });
    return;
  }

  // Set baseline — only process messages that arrive AFTER we start
  lastSeenRowId = getMaxRowId(db);
  console.log(`[iMessage] Baseline ROWID: ${lastSeenRowId}`);

  connectionStatus = 'connected';
  io?.emit('status', connectionStatus);
  emitLog('connected', { message: 'iMessage transport connected', platform: 'imessage' });

  // Start polling for new messages
  const POLL_INTERVAL_MS = 2000; // 2 seconds
  pollTimer = setInterval(() => pollAndProcess(), POLL_INTERVAL_MS);

  console.log('[iMessage] Polling for incoming messages every 2s');
}

/**
 * Poll for new messages and process each one.
 */
async function pollAndProcess() {
  if (!db || connectionStatus !== 'connected') return;

  let newMessages;
  try {
    newMessages = pollNewMessages(db, lastSeenRowId);
  } catch (err) {
    // Database might be temporarily locked by Messages.app
    if (err.message.includes('database is locked')) {
      return; // Will retry on next poll
    }
    console.error('[iMessage:poll] Error polling messages:', err.message);
    return;
  }

  for (const msg of newMessages) {
    // Always advance the cursor
    if (msg.rowid > lastSeenRowId) {
      lastSeenRowId = msg.rowid;
    }

    // Skip messages from us
    if (msg.isFromMe) continue;

    // Skip non-text messages with no text (tapbacks, read receipts, etc.)
    // associated_message_type != 0 means it's a tapback/reaction
    if (msg.assocType && msg.assocType !== 0) continue;

    // Skip if no text content
    if (!msg.text || !msg.text.trim()) continue;

    // Dedup by GUID
    if (processedGuids.has(msg.guid)) continue;
    addProcessedGuid(msg.guid);

    // Skip messages that are echoes of what we sent
    if (botSentTexts.has(msg.text.slice(0, 100))) continue;

    // Skip messages older than 30 seconds (stale on startup edge cases)
    const msgDate = coreDataToDate(msg.coreDataDate);
    if (Date.now() - msgDate.getTime() > 30_000) continue;

    // Process this message
    const handle = msg.handle;
    if (!handle) continue;

    console.log(`[iMessage] New message from ${handle}: ${msg.text.slice(0, 80)}...`);
    emitLog('incoming', { sender: handle, prompt: msg.text.slice(0, 200), handle });

    // Process async — don't block the poll loop
    processIncomingMessage(handle, msg.text, msg).catch(err => {
      console.error('[iMessage] Message handler error:', err);
    });
  }
}

/**
 * Process a single incoming iMessage. Mirrors the whatsapp-client.js IIFE logic.
 */
async function processIncomingMessage(handle, text, rawMsg) {
  const jid = `imessage:${handle}`;

  // --- Onboarding check ---
  if (isOnboardingNeeded()) {
    emitLog('onboarding_message', { jid, text: text.slice(0, 200) });
    try {
      const onboardingResult = await handleOnboardingMessage(text, `imsg:${handle}`);
      if (onboardingResult.response) {
        const formatted = formatChieftonResponse(onboardingResult.response);
        await sendWithRetry(handle, formatted);
      }
      if (onboardingResult.done) {
        emitLog('onboarding_complete', { jid, message: 'User profile created' });
        const commandsText = `you can run multiple conversations at once:\n\n` +
          `- start a convo: *1 email my friend about friday*\n` +
          `- reply to it: *1 tell them I'll be late*\n` +
          `- start another: *2 research for my econ project*\n` +
          `- pause one: *1 pause*\n` +
          `- done with one: *1 new*`;
        await sendWithRetry(handle, formatChieftonResponse(commandsText));
      }
    } catch (err) {
      console.log('[onboarding_error]', err.message);
      emitLog('onboarding_error', { jid, error: err.message });
    }
    return;
  }

  // --- Referral flow ---
  const refState = getReferralState(jid);
  if (refState) {
    if (refState.stage === 'name') {
      await sendWithRetry(handle, formatChieftonResponse('Looking up contacts...'));
    }
    const { executeCodexPrompt } = await import('./codex-bridge.js');
    const replyFn = async (m) => await sendWithRetry(handle, formatChieftonResponse(m));
    const killFn = () => { try { const { killProcess } = require('./codex-bridge.js'); killProcess(`imsg:chat:${handle}`); } catch {} };
    const result = await processReferralReply(jid, text, executeCodexPrompt, replyFn, killFn);
    if (result?.handled) {
      await sendWithRetry(handle, formatChieftonResponse(result.reply));
      return;
    }
  }

  // Invite/refer trigger
  if (/^(invite|refer)\b/i.test(text)) {
    const senderName = config.googleEmail?.split('@')[0]?.replace(/[._]/g, ' ') || 'A friend';
    const emailMatch = text.match(/(?:invite|refer)\s+(\S+@\S+)/i);
    if (emailMatch) {
      const { executeCodexPrompt } = await import('./codex-bridge.js');
      startReferralFlow(jid, senderName);
      const state = getReferralState(jid);
      if (state) { state.stage = 'manual'; }
      const replyFn = async (m) => await sendWithRetry(handle, formatChieftonResponse(m));
      const result = await processReferralReply(jid, emailMatch[1], executeCodexPrompt, replyFn);
      if (result?.handled) {
        await sendWithRetry(handle, formatChieftonResponse(result.reply));
      }
      return;
    }
    const refResult = startReferralFlow(jid, senderName);
    await sendWithRetry(handle, formatChieftonResponse(refResult.prompt));
    return;
  }

  // --- Quota check ---
  if (!hasQuota()) {
    const status = getQuotaStatus();
    const reply = `You've used your ${status.dailyQuota} messages for today! Invite a friend to get +10 messages/day.\n\nReply *invite* to send someone an invite.`;
    await sendWithRetry(handle, formatChieftonResponse(reply));
    return;
  }

  // --- Process with Claude ---
  const _startMs = Date.now();

  // Build a fake message object that handleMessage expects.
  // handleMessage reads: message.key.remoteJid, message.key.fromMe, message.key.id,
  // message.message.conversation, message.pushName, message.message.imageMessage, etc.
  const fakeMsg = {
    key: {
      remoteJid: jid,
      fromMe: false,
      id: rawMsg.guid || randomBytes(8).toString('hex'),
    },
    message: {
      conversation: text,
    },
    pushName: handle,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };

  // Check for image attachments
  if (rawMsg.hasAttachment && db) {
    const attachments = getAttachments(db, rawMsg.rowid);
    const imageAttachment = attachments.find(a => a.mimeType?.startsWith('image/'));
    if (imageAttachment && existsSync(imageAttachment.path)) {
      fakeMsg.message.imageMessage = {
        _localPath: imageAttachment.path,   // Custom field — message-handler won't use Baileys download
        mimetype: imageAttachment.mimeType,
        caption: text,
      };
    }
  }

  let result;
  try {
    result = await handleMessage(fakeMsg, emitLog);
    if (result) result.durationMs = Date.now() - _startMs;
  } catch (handlerErr) {
    if (!handlerErr.stopped) {
      console.error('[iMessage] handleMessage threw:', handlerErr);
      emitLog('handler_crash', { jid, error: handlerErr.message });
      try {
        await sendWithRetry(handle, formatChieftonResponse('Something went wrong processing your message. Please try again.'));
      } catch {}
    }
    return;
  }

  if (!result) {
    console.log(`[iMessage:ignored] handleMessage returned null for ${rawMsg.guid}`);
    return;
  }

  if (!result.response) {
    try {
      await sendWithRetry(handle, formatChieftonResponse('I processed your message but the response was empty. Try again?'));
    } catch {}
    if (result.internalSessionId) closeSession(result.internalSessionId);
    return;
  }

  // Send the response, serialized per handle
  await withSendLock(handle, async () => {
    let sendSucceeded = false;
    try {
      const { images, cleanText } = extractImages(result.response);

      // Send images first
      for (const imagePath of images) {
        try {
          await sendImageWithRetry(handle, imagePath);
        } catch (imgErr) {
          emitLog('send_image_error', { to: handle, path: imagePath, error: imgErr.message });
        }
      }

      // Send text with Chiefton formatting
      if (cleanText) {
        const labeledText = result.conversationNumber != null
          ? `#${result.conversationNumber}\n${cleanText}`
          : cleanText;
        const formatted = formatChieftonResponse(labeledText);
        // iMessage doesn't have a strict char limit like WhatsApp, but split very long messages
        for (let i = 0; i < formatted.length; i += 10000) {
          const chunk = formatted.slice(i, i + 10000);
          await sendWithRetry(handle, chunk);
        }
      }

      if (!cleanText && images.length === 0) {
        emitLog('empty_response', { to: handle, rawLength: result.response.length });
        await sendWithRetry(handle, formatChieftonResponse('I processed your message but had nothing to say. Try rephrasing?'));
      }

      sendSucceeded = true;
      incrementMessageCount();
      console.log(`[iMessage] Sent to ${handle} (${result.response.length} chars)`);
      emitLog('sent', { to: handle, responseLength: result.response.length, imageCount: images.length });
    } catch (err) {
      emitLog('send_error', { to: handle, error: err.message });
      // Last-resort: raw text, no formatting
      try {
        await sendWithRetry(handle, result.response.slice(0, 10000));
        sendSucceeded = true;
        emitLog('sent_fallback', { to: handle, responseLength: result.response.length });
      } catch (retryErr) {
        emitLog('send_error_final', { to: handle, error: retryErr.message });
      }
    } finally {
      if (result.internalSessionId) {
        closeSession(result.internalSessionId);
      }
    }

    // Persist conversation log
    try {
      mkdirSync(LOGS_DIR, { recursive: true });
      const filename = `${nextLogNumber()}_imessage.json`;
      const convoLog = {
        sender: handle,
        prompt: result.prompt,
        jid,
        conversationNumber: result.conversationNumber ?? null,
        sessionId: result.sessionId || null,
        timestamp: new Date().toISOString(),
        platform: 'imessage',
        durationMs: result.durationMs || 0,
        fullEvents: result.fullEvents || [],
        response: result.response,
        sendSucceeded,
      };
      writeFileSync(join(LOGS_DIR, filename), JSON.stringify(convoLog, null, 2));
      addToLogIndex(filename, convoLog);
      const costEvents = (convoLog.fullEvents || []).filter(e => e.type === 'cost');
      const toolEvents = (convoLog.fullEvents || []).filter(e => e.type === 'tool_use');
      recordTask({
        durationMs: convoLog.durationMs || 0,
        platform: 'imessage',
        toolCount: toolEvents.length,
        cost: costEvents.reduce((s, e) => s + (e.cost || e.data?.cost || 0), 0),
        inputTokens: costEvents.reduce((s, e) => s + (e.input_tokens || e.data?.input_tokens || 0), 0),
        outputTokens: costEvents.reduce((s, e) => s + (e.output_tokens || e.data?.output_tokens || 0), 0),
        cacheTokens: costEvents.reduce((s, e) => s + (e.cache_read || e.data?.cache_read || 0), 0),
        hasError: !convoLog.sendSucceeded,
      });
      io?.emit('conversation_update', { sessionId: result.sessionId, conversationNumber: result.conversationNumber });
      postPerMessageLog({
        durationMs: convoLog.durationMs || 0,
        platform: 'imessage',
        costUsd: costEvents.reduce((s, e) => s + (e.cost || e.data?.cost || 0), 0),
        tokens: costEvents.reduce((s, e) => s + (e.input_tokens || 0) + (e.output_tokens || 0), 0),
        status: convoLog.sendSucceeded ? 'OK' : 'FAIL',
        timestamp: convoLog.timestamp,
      });
    } catch (e) {
      console.log('[imessage:log_write_error]', e.message);
    }
  });
}

// ── Exported interface (mirrors whatsapp-client.js) ──────────────────────────

function setSocketIO(socketIO, logBufferPush) {
  io = socketIO;
  bufferPush = logBufferPush || null;
}

function getStatus() {
  return connectionStatus;
}

function getLastQR() {
  // iMessage doesn't use QR codes — return null
  return null;
}

async function reconnectIMessage() {
  // Close existing polling
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (db) { try { db.close(); } catch {} db = null; }
  connectionStatus = 'disconnected';
  io?.emit('status', connectionStatus);

  // Small delay then restart
  await new Promise(r => setTimeout(r, 1000));
  await startIMessage();
  return { ok: true };
}

/**
 * Send a text message to the user via iMessage.
 * Used by trigger/automation schedulers — equivalent to sendToChieftonGroup.
 */
async function sendToChieftonGroup(text) {
  const handle = config.imessageHandle;
  if (!handle) {
    console.log('[iMessage] Cannot send — no imessageHandle configured');
    return null;
  }
  if (connectionStatus !== 'connected') {
    console.log('[iMessage] Not connected — waiting up to 30s...');
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (connectionStatus === 'connected') break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (connectionStatus !== 'connected') {
      console.error('[iMessage] Still not connected after 30s — trigger response lost');
      return null;
    }
  }
  const formatted = formatChieftonResponse(text);
  try {
    await sendWithRetry(handle, formatted);
    return { ok: true };
  } catch (err) {
    console.error('[iMessage] Trigger send failed:', err.message);
    return null;
  }
}

// Export with the same names as whatsapp-client.js
export {
  startIMessage as startWhatsApp,
  setSocketIO,
  getStatus,
  getLastQR,
  reconnectIMessage as reconnectWhatsApp,
  sendToChieftonGroup,
};
