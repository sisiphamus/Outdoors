import * as _baileys from '@whiskeysockets/baileys';
// Handle both default export (<=6.7.16 where default=makeWASocket) and named export (newer)
const makeWASocket = _baileys.default || _baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestWaWebVersion, Browsers } = _baileys;
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config, saveConfig } from './config.js';
import { handleMessage } from './message-handler.js';
import { isOnboardingNeeded, handleOnboardingMessage } from './onboarding.js';
import { addToLogIndex, nextLogNumber } from './index.js';
import { extractImages } from './transport-utils.js';
import { formatOutdoorsResponse } from './wa-formatter.js';
import { recordTask } from './telemetry.js';
import { hasQuota, incrementMessageCount, initReferral, sendReferral, getPendingReferralEmail, getQuotaStatus } from './quota.js';
import { closeSession } from '../../../outdoorsv4/session/session-manager.js';

// Per-JID send serialization — ensures one response's images+text
// finish sending before the next response starts sending.
const jidSendLock = new Map();

async function withSendLock(jid, fn) {
  const prev = jidSendLock.get(jid) || Promise.resolve();
  const current = prev.then(fn, fn);
  jidSendLock.set(jid, current);
  try {
    return await current;
  } finally {
    if (jidSendLock.get(jid) === current) jidSendLock.delete(jid);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', 'bot', 'logs');
const QUEUE_DIR = join(__dirname, '..', 'bot', 'message-queue');
mkdirSync(QUEUE_DIR, { recursive: true });

function enqueueMessage(msg) {
  const file = join(QUEUE_DIR, `${msg.key.id}.json`);
  writeFileSync(file, JSON.stringify({ msg, enqueuedAt: Date.now() }));
}

function dequeueMessage(msgId) {
  try { unlinkSync(join(QUEUE_DIR, `${msgId}.json`)); } catch (err) {
    console.warn(`[wa:dequeue] Failed to delete ${msgId}.json: ${err.message}`);
  }
}

function getPendingMessages() {
  try {
    return readdirSync(QUEUE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(join(QUEUE_DIR, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  } catch { return []; }
}

const logger = pino({ level: 'warn' });

async function sendOnboardingWelcome(sock, groupJid) {
  try {
    const msg = formatOutdoorsResponse(
      `Hey I'm Outdoors 🌲\n\n` +
      `When you see 🌱🌿🌳 on your message, that means I'm thinking.\n\n` +
      `Answer these so I can do my job better — everything stays on your device and can be changed later:\n\n` +
      `🌿 What's your name?\n` +
      `🌿 Student or working? (school, class of ____, major — or where you work)\n` +
      `🌿 Personal email + school/work email\n` +
      `🌿 Browser (Chrome, Edge, Brave, Arc)\n` +
      `🌿 Outdoor vibe — beaches, mountains, forests, desert, or city? (sets your emoji aesthetic)`
    );
    const sent = await sock.sendMessage(groupJid, { text: msg });
    if (sent?.key?.id) {
      addBotSentId(sent.key.id);
      storeMessage(sent.key.id, sent.message);
    }
  } catch (err) {
    console.log('[WhatsApp] Failed to send onboarding welcome:', err.message);
    await sock.sendMessage(groupJid, { text: 'Outdoors is ready! Send a message here to get started.' }).catch(() => {});
  }
}

async function createOutdoorsGroup(sock, emitLog) {
  try {
    const group = await sock.groupCreate('Outdoors 🌲🏔️', []);
    const groupJid = group.id;
    config.outdoorsGroupJid = groupJid;
    saveConfig(config);
    console.log(`[WhatsApp] Created Outdoors group: ${groupJid}`);
    emitLog('group_created', { groupJid, message: 'Outdoors group created — open it in WhatsApp to start chatting' });

    await sock.groupUpdateDescription(groupJid, 'Send messages here to chat with Outdoors.').catch(() => {});

    // Set group profile picture
    try {
      const iconPath = join(__dirname, 'setup', 'icon.png');
      const iconBuffer = readFileSync(iconPath);
      await sock.updateProfilePicture(groupJid, iconBuffer);
      console.log('[WhatsApp] Set group profile picture');
    } catch (err) {
      console.log('[WhatsApp] Failed to set group picture:', err.message);
    }

    // Send welcome message
    if (isOnboardingNeeded()) {
      await sendOnboardingWelcome(sock, groupJid);
    } else {
      try {
        const welcome = formatOutdoorsResponse(
          `Hello! I'm Outdoors 🌲\n\n` +
          `I'm your personal assistant — I live right here in this chat.\n` +
          `Send me a message and I'll get to work. When you see 🌱🌿🌳 on your message, that means I'm thinking.\n\n` +
          `You can run multiple conversations at once:\n` +
          `*1 email my friend about friday*\n` +
          `*2 research for my econ project*\n\n` +
          `That's it. No apps to open, no windows to manage.`
        );
        const sent = await sock.sendMessage(groupJid, { text: welcome });
        if (sent?.key?.id) {
          addBotSentId(sent.key.id);
          storeMessage(sent.key.id, sent.message);
        }
      } catch (err) {
        console.log('[WhatsApp] Failed to send welcome:', err.message);
      }
    }
  } catch (err) {
    console.log('[WhatsApp] Failed to create Outdoors group:', err.message);
    emitLog('group_create_error', { error: err.message });
  }
}

let sock = null;
let io = null;
let connectionStatus = 'disconnected';
let lastQR = null;
let reconnectAttempt = 0;
let manualReconnecting = false; // prevents close handler from auto-reconnecting during manual reconnect
const MAX_RECONNECT_ATTEMPTS = 10;
let healthCheckTimer = null;
let healthCheckFailures = 0; // consecutive failures before forcing reconnect
const HEALTH_CHECK_FAIL_THRESHOLD = 2; // require 2 consecutive failures
let stabilityTimer = null; // full backoff reset after connection proves stable
const seenTimestampKeys = new Set();
const MAX_SEEN_TS_KEYS = 10000;

// Track message IDs sent by the bot to prevent infinite loops
const botSentIds = new Set();
const MAX_BOT_SENT_IDS = 500;

// Bounded add helpers — evict oldest entries when Sets exceed max size
function addBotSentId(id) {
  botSentIds.add(id);
  if (botSentIds.size > MAX_BOT_SENT_IDS) {
    const first = botSentIds.values().next().value;
    botSentIds.delete(first);
  }
}
function addSeenTsKey(key) {
  seenTimestampKeys.add(key);
  if (seenTimestampKeys.size > MAX_SEEN_TS_KEYS) {
    const first = seenTimestampKeys.values().next().value;
    seenTimestampKeys.delete(first);
  }
}
const processedMsgIds = new Set(); // dedup incoming messages
// Track message IDs currently being processed to deduplicate Baileys' multiple upsert events
const processingIds = new Set();
// Store sent messages for getMessage callback (needed for sender key retries).
// Module-scoped so it survives reconnects — Baileys needs prior messages to retry
// sender-key distribution, and a fresh Map on reconnect causes silent decryption failures.
const messageStore = new Map();
const MAX_STORE_SIZE = 5000;

function storeMessage(id, message) {
  messageStore.set(id, message);
  if (messageStore.size > MAX_STORE_SIZE) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
  }
}

let bufferPush = null;

function setSocketIO(socketIO, logBufferPush) {
  io = socketIO;
  bufferPush = logBufferPush || null;
}

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

function getStatus() {
  return connectionStatus;
}

async function startWhatsApp() {
  // Close any existing socket before creating a new one to prevent duplicates
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
  if (stabilityTimer) { clearTimeout(stabilityTimer); stabilityTimer = null; }
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(undefined); } catch {}
    sock = null;
  }

  mkdirSync(config.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  let version;
  try {
    const versionTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('version fetch timeout')), 10_000)
    );
    const result = await Promise.race([fetchLatestWaWebVersion({}), versionTimeout]);
    version = result.version;
    console.log(`Using WhatsApp Web version: ${version.join('.')}`);
  } catch {
    version = [2, 3000, 1033498124];
    console.log(`Using fallback WhatsApp Web version: ${version.join('.')}`);
  }

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    browser: Browsers.windows('Chrome'),
    logger,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 45_000,
    retryRequestDelayMs: 500,
    connectTimeoutMs: 30_000,
    getMessage: async (key) => {
      const stored = messageStore.get(key.id);
      return stored || undefined;
    },
  });

  sock.ev.on('creds.update', async () => {
    try { await saveCreds(); }
    catch (err) { console.log('[wa] Failed to save creds:', err.message); }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'waiting_for_qr';
      lastQR = qr;

      QRCode.toString(qr, { type: 'terminal', small: true }, (err, str) => {
        if (!err) console.log('\n' + str);
      });

      QRCode.toDataURL(qr, { width: 280, margin: 2 }, (err, dataUrl) => {
        if (!err) {
          io?.emit('qr', dataUrl);
        }
      });

      io?.emit('status', connectionStatus);
      emitLog('qr', { message: 'QR code generated - scan with WhatsApp' });
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
      if (stabilityTimer) { clearTimeout(stabilityTimer); stabilityTimer = null; }
      io?.emit('status', connectionStatus);

      // Skip auto-reconnect if manual reconnect is in progress (it will call startWhatsApp itself)
      if (manualReconnecting) {
        console.log('[WhatsApp] Manual reconnect in progress — skipping auto-reconnect');
        return;
      }

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      emitLog('disconnected', { statusCode, willReconnect: shouldReconnect });

      if (shouldReconnect && reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempt++;
        const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempt - 1), 30000);
        console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(startWhatsApp, delay);
      } else if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        console.log('Max reconnection attempts reached. Will retry in 5 minutes.');
        emitLog('max_retries', { message: 'Max reconnection attempts reached — retrying in 5m' });
        // Cool-off retry: reset and try again after 5 minutes instead of dying
        setTimeout(() => {
          reconnectAttempt = 0;
          startWhatsApp();
        }, 5 * 60 * 1000);
      } else {
        console.log('Logged out. Delete auth_state folder and restart to re-authenticate.');
        emitLog('logged_out', { message: 'Scan QR code again to reconnect' });
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      // Partially reduce backoff immediately; fully reset only after 60s of stable connection.
      // Prevents thrashing when the connection is flaky (connects then drops within seconds).
      reconnectAttempt = Math.max(0, reconnectAttempt - 2);
      if (stabilityTimer) clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(() => { reconnectAttempt = 0; }, 60_000);
      // Only clear seenTimestampKeys (Baileys may re-emit with new wrapper IDs).
      // Do NOT clear processedMsgIds — it's the final dedup gate that prevents
      // old messages from being reprocessed after reconnect.
      // processingIds is cleared so interrupted handlers don't permanently block a message ID.
      seenTimestampKeys.clear();
      processingIds.clear();
      io?.emit('status', connectionStatus);
      emitLog('connected', { message: 'WhatsApp connected successfully' });
      console.log('WhatsApp connected!');
      console.log('[wa] Connected as:', JSON.stringify(sock.user));

      // Zombie connection watchdog — detect when the socket is functionally dead
      // but Baileys hasn't fired 'close'. Sends a lightweight presence update every
      // 30 seconds. Requires 2 consecutive failures before killing the connection
      // to avoid unnecessary reconnects on transient network blips.
      if (healthCheckTimer) clearInterval(healthCheckTimer);
      healthCheckFailures = 0;
      healthCheckTimer = setInterval(async () => {
        if (connectionStatus !== 'connected' || !sock) return;
        try {
          const hcTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('health check timeout')), 5_000)
          );
          await Promise.race([
            sock.sendPresenceUpdate('available'),
            hcTimeout,
          ]);
          healthCheckFailures = 0; // Reset on success
        } catch (err) {
          healthCheckFailures++;
          console.log(`[wa:health] Check failed (${healthCheckFailures}/${HEALTH_CHECK_FAIL_THRESHOLD}): ${err.message}`);
          if (healthCheckFailures >= HEALTH_CHECK_FAIL_THRESHOLD) {
            console.log(`[wa:health] Zombie connection detected after ${healthCheckFailures} consecutive failures. Forcing close.`);
            emitLog('zombie_disconnect', { message: `Health check failed ${healthCheckFailures}x: ${err.message}` });
            healthCheckFailures = 0;
            // Only close the socket — the close handler will handle reconnection
            try { sock.end(new Error('Zombie connection')); } catch {}
          }
        }
      }, 30_000); // every 30 seconds (staggered from 45s keepalive)

      // Drain any recent messages left in queue from a previous crash
      // Discard messages older than 5 minutes — they're stale
      // Skip messages already processed — they're leftover files from before dequeue ran
      const pending = getPendingMessages();
      if (pending.length > 0) {
        const MAX_QUEUE_AGE_MS = 5 * 60 * 1000;
        const now = Date.now();
        let drained = 0;
        for (const entry of pending) {
          const msgId = entry.msg.key.id;
          const age = now - (entry.enqueuedAt || 0);
          if (age > MAX_QUEUE_AGE_MS) {
            console.log(`[queue] Discarding stale message (${Math.round(age / 1000)}s old)`);
            dequeueMessage(msgId);
            continue;
          }
          if (processedMsgIds.has(msgId)) {
            console.log(`[queue] Removing already-processed message ${msgId} from queue`);
            dequeueMessage(msgId);
            continue;
          }
          drained++;
          sock.ev.emit('messages.upsert', { messages: [entry.msg], type: 'notify' });
        }
        if (drained > 0) console.log(`[queue] Drained ${drained} pending message(s)`);
      }

      if (!config.outdoorsGroupJid) {
        // Search for the most recently active Outdoors group, or create a new one
        (async () => {
          try {
            const groups = await sock.groupFetchAllParticipating();
            const outdoorsGroups = Object.values(groups)
              .filter(g => g.subject && g.subject.toLowerCase().includes('outdoors'))
              .sort((a, b) => {
                // Sort by most recent activity (descending) — use creation time as fallback
                const aTime = a.conversationTimestamp || a.creation || 0;
                const bTime = b.conversationTimestamp || b.creation || 0;
                return bTime - aTime;
              });
            if (outdoorsGroups.length > 0) {
              const outdoorsGroup = outdoorsGroups[0]; // most recently active
              config.outdoorsGroupJid = outdoorsGroup.id;
              saveConfig(config);
              console.log(`[WhatsApp] Found ${outdoorsGroups.length} Outdoors group(s), using most recent: ${outdoorsGroup.id} ("${outdoorsGroup.subject}")`);
              emitLog('group_found', { groupJid: outdoorsGroup.id, subject: outdoorsGroup.subject });
            } else {
              createOutdoorsGroup(sock, emitLog);
            }
          } catch (err) {
            console.log('[WhatsApp] Failed to search for existing groups:', err.message);
            createOutdoorsGroup(sock, emitLog);
          }
        })();
      } else {
        // Group already configured — just log and send welcome if needed
        console.log(`[WhatsApp] Using existing Outdoors group: ${config.outdoorsGroupJid}`);
        (async () => {
          try {
            if (isOnboardingNeeded()) {
              await sendOnboardingWelcome(sock, config.outdoorsGroupJid);
            }
          } catch (err) {
            console.log('[WhatsApp] Onboarding check failed:', err.message);
          }
        })();
      }
    }
  });

  sock.ev.on('messages.upsert', (upsert) => {
    if (upsert.type !== 'notify') return;  // Only process real-time messages
    const messages = upsert.messages || [];
    for (const msg of messages) {
      const msgId = msg.key.id;

      if (botSentIds.has(msgId)) {
        botSentIds.delete(msgId);
        continue;
      }

      // JID+timestamp dedup: same message has same ts regardless of wrapper or ID
      const ts = (msg.messageTimestamp?.low || msg.messageTimestamp || 0);
      const tsKey = `${msg.key.remoteJid}:${ts}`;
      if (seenTimestampKeys.has(tsKey)) {
        console.log(`[wa:dedup-ts] Skipping duplicate ${msgId} (ts=${ts})`);
        continue;
      }
      addSeenTsKey(tsKey);

      if (processingIds.has(msgId)) {
        console.log(`[wa:dedup] Skipping already-processing message ${msgId}`);
        continue;
      }
      processingIds.add(msgId);

      // Skip system/protocol messages (group created, participant added, etc.)
      // These legitimately have no .message body — they use messageStubType instead.
      if (msg.messageStubType) {
        continue;
      }

      // Skip status updates / delivery receipts with no message content
      if (!msg.message) {
        console.log(`[wa:skip] No message content for ${msgId} from ${msg.key.remoteJid} (likely decryption failure)`);
        emitLog('decryption_failure', { jid: msg.key.remoteJid, msgId });
        // Notify the user so they know to resend (fire-and-forget since we're in a sync loop)
        const failJid = msg.key.remoteJid;
        if (failJid && failJid !== 'status@broadcast') {
          sock.sendMessage(failJid, { text: '\u26a0\ufe0f Couldn\'t read that message (decryption issue). Please send it again.' }).catch(() => {});
        }
        continue;
      }

      // Deduplicate — skip if we've already processed this message ID
      if (processedMsgIds.has(msgId)) {
        dequeueMessage(msgId); // clean up stale queue file if it exists
        continue;
      }
      processedMsgIds.add(msgId);
      // Keep the set from growing forever — prune old entries (keep last 1000)
      if (processedMsgIds.size > 2000) {
        const arr = [...processedMsgIds];
        processedMsgIds.clear();
        arr.slice(-1000).forEach(id => processedMsgIds.add(id));
      }

      // Store incoming messages so getMessage can fulfill group retry requests
      if (msg.message) storeMessage(msgId, msg.message);

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid?.endsWith('@g.us');

      // Only accept messages from the Outdoors group — ignore DMs and other groups
      if (config.outdoorsGroupJid) {
        if (remoteJid !== config.outdoorsGroupJid) {
          continue; // Not the Outdoors group — skip silently
        }
      } else {
        // No group configured yet — skip everything until group is created
        continue;
      }

      // Skip messages sent by us UNLESS it's a group (solo group for self-messaging)
      if (msg.key.fromMe && !isGroup) {
        continue;
      }

      // Persist to queue before processing — survives crashes
      enqueueMessage(msg);

      // Fire off each message concurrently — each spawns its own Claude instance
      (async () => {
        const jid = msg.key.remoteJid;
        // Capture socket reference at message start — survives reconnects that replace module-level `sock`
        const msgSock = sock;
        // (fire-and-forget body — .catch() added at bottom)

        // Retry helper: attempts to send a WhatsApp message up to 3 times.
        // If disconnected, waits up to 60s for reconnection before retrying.
        async function sendWithRetry(jid, content, opts, retries = 3) {
          for (let attempt = 1; attempt <= retries; attempt++) {
            // Wait for reconnection if socket is dead
            if (!sock || connectionStatus !== 'connected') {
              console.log(`[wa:send] Disconnected — waiting up to 60s for reconnect before attempt ${attempt}...`);
              const start = Date.now();
              while (Date.now() - start < 60_000) {
                if (sock && connectionStatus === 'connected') break;
                await new Promise(r => setTimeout(r, 2000));
              }
              if (!sock || connectionStatus !== 'connected') {
                throw new Error('Still disconnected after 60s — response lost');
              }
            }
            try {
              const sent = await sock.sendMessage(jid, content, opts);
              return sent;
            } catch (err) {
              console.log(`[wa:send] attempt ${attempt}/${retries} failed:`, err.message);
              if (attempt === retries) throw err;
              await new Promise(r => setTimeout(r, 1000 * attempt));
            }
          }
        }

        // Cycle 🌱🌿🌳🪾🍃 reaction while processing
        const growEmojis = ['🌱', '🌿', '🌳', '🪾', '🍃'];
        let growIdx = 0;
        let reactInFlight = false;
        let reactFails = 0;
        const pulseInterval = setInterval(async () => {
          if (reactInFlight || connectionStatus !== 'connected') return;
          if (reactFails >= 3) {
            reactFails = 0; // reset and retry next tick instead of dying permanently
            return;
          }
          reactInFlight = true;
          try {
            growIdx = (growIdx + 1) % growEmojis.length;
            await msgSock.sendMessage(jid, { react: { key: msg.key, text: growEmojis[growIdx] } });
            reactFails = 0; // reset on success
          } catch (err) {
            reactFails++;
            console.log(`[react] shuffle failed (${reactFails}/3):`, err.message);
            if (reactFails === 1) {
              io?.emit('log', { type: 'react_degraded', data: { jid, msgId }, timestamp: new Date().toISOString() });
            }
          } finally {
            reactInFlight = false;
          }
        }, 3000);

        try {
          try {
            if (connectionStatus === 'connected') {
              await msgSock.sendMessage(jid, { react: { key: msg.key, text: '🌱' } });
              console.log('[react] 🌱 sent');
            }
          } catch (reactErr) {
            console.log(`[react] Initial 🌱 failed (non-fatal): ${reactErr.message}`);
          }

          // --- Onboarding check ---
          if (isOnboardingNeeded()) {
            const text =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              null;
            if (text) {
              emitLog('onboarding_message', { jid, text: text.slice(0, 200) });
              try {
                const onboardingResult = await handleOnboardingMessage(text, `wa:${jid}`);
                if (onboardingResult.response) {
                  const formatted = formatOutdoorsResponse(onboardingResult.response);
                  const quoteOpts = { quoted: msg };
                  for (let i = 0; i < formatted.length; i += 4000) {
                    const chunk = formatted.slice(i, i + 4000);
                    const sent = await sendWithRetry(jid, { text: chunk }, quoteOpts);
                    if (sent?.key?.id) {
                      addBotSentId(sent.key.id);
                      storeMessage(sent.key.id, sent.message);
                    }
                  }
                }
                emitLog('onboarding_response', { jid, responseLength: onboardingResult.response?.length || 0 });
                if (onboardingResult.done) {
                  emitLog('onboarding_complete', { jid, message: 'User profile created' });
                  // Send parallel session commands guide
                  const commandsText = `you can run multiple conversations at once:\n\n` +
                    `- start a convo: *1 email my friend about friday*\n` +
                    `- reply to it: *1 tell them I'll be late*\n` +
                    `- start another: *2 research for my econ project*\n` +
                    `- pause one: *1 pause*\n` +
                    `- done with one: *1 new*`;
                  const commandsMsg = formatOutdoorsResponse(commandsText);
                  const cmdSent = await sendWithRetry(jid, { text: commandsMsg });
                  if (cmdSent?.key?.id) {
                    addBotSentId(cmdSent.key.id);
                    storeMessage(cmdSent.key.id, cmdSent.message);
                  }

                }
              } catch (err) {
                console.log('[onboarding_error] Full:', err);
                emitLog('onboarding_error', { jid, error: err.message });
              }
              return;
            }
          }

          // Check for refer command
          const msgText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          const referMatch = msgText.match(/^refer\s+(\S+@\S+)/i);
          if (referMatch) {
            const senderName = msg.pushName || config.googleEmail?.split('@')[0]?.replace(/[._]/g, ' ') || 'A friend';
            const refResult = initReferral(referMatch[1], senderName);
            const reply = refResult.needsCustomization ? refResult.prompt : refResult.error;
            const sent = await sendWithRetry(jid, { text: formatOutdoorsResponse(reply) });
            if (sent?.key?.id) { addBotSentId(sent.key.id); storeMessage(sent.key.id, sent.message); }
            return;
          }

          // Check if user is replying to a pending referral customization
          const pendingEmail = getPendingReferralEmail();
          if (pendingEmail && !msgText.match(/^\d+\s/) && !msgText.match(/^(stop|new|status|refer)/i)) {
            const { executeCodexPrompt } = await import('./codex-bridge.js');
            const replyFn = async (m) => {
              const s = await sendWithRetry(jid, { text: formatOutdoorsResponse(m) });
              if (s?.key?.id) { addBotSentId(s.key.id); storeMessage(s.key.id, s.message); }
            };
            const refResult = sendReferral(pendingEmail, msgText, executeCodexPrompt, replyFn);
            const reply = refResult.ok
              ? `Invite sent! Your daily limit is now ${refResult.dailyQuota} messages (${refResult.remaining} remaining today). You can keep using Outdoors — I'll verify the email in the background.`
              : refResult.error;
            const sent = await sendWithRetry(jid, { text: formatOutdoorsResponse(reply) });
            if (sent?.key?.id) { addBotSentId(sent.key.id); storeMessage(sent.key.id, sent.message); }
            return;
          }

          // Quota check
          if (!hasQuota()) {
            const status = getQuotaStatus();
            const reply = `You've used your ${status.dailyQuota} messages for today! Share Outdoors with a friend to get +10 messages/day:\n\nrefer friend@rice.edu`;
            const sent = await sendWithRetry(jid, { text: formatOutdoorsResponse(reply) });
            if (sent?.key?.id) { addBotSentId(sent.key.id); storeMessage(sent.key.id, sent.message); }
            return;
          }

          var result = await handleMessage(msg, emitLog);
        } catch (handlerErr) {
          // handleMessage threw unexpectedly — send error to user instead of silently dropping
          if (!handlerErr.stopped) {
            console.error('[WhatsApp] handleMessage threw:', handlerErr);
            emitLog('handler_crash', { jid, error: handlerErr.message });
            try {
              const errorMsg = formatOutdoorsResponse(`Something went wrong processing your message. Please try again.`);
              const sent = await sendWithRetry(jid, { text: errorMsg }, { quoted: msg });
              if (sent?.key?.id) {
                addBotSentId(sent.key.id);
                storeMessage(sent.key.id, sent.message);
              }
            } catch {}
          }
          return;
        } finally {
          clearInterval(pulseInterval);
          dequeueMessage(msgId);
          if (connectionStatus === 'connected' && msgSock === sock) {
            msgSock.sendMessage(jid, { react: { key: msg.key, text: '' } })
              .then(() => console.log('[react] removed'))
              .catch(e => console.log('[react] remove failed:', e.message));
          }
          processingIds.delete(msgId);
        }

        if (!result) {
          // null means handleMessage intentionally ignored this message (no text/media, protocol msg, etc.)
          // Don't send an error — just log and move on
          console.log(`[wa:ignored] handleMessage returned null for ${msgId} from ${jid} (not a user message)`);
        } else if (result && !result.response) {
          try {
            const fallback = formatOutdoorsResponse('I processed your message but the response was empty. Try again?');
            const sent = await sendWithRetry(result.jid, { text: fallback }, { quoted: msg });
            if (sent?.key?.id) { addBotSentId(sent.key.id); storeMessage(sent.key.id, sent.message); }
          } catch {}
          // Clean up session for no-response path (send block cleanup won't run)
          if (result.internalSessionId) closeSession(result.internalSessionId);
        }

        if (result && result.response) {
          // Serialize sends per-JID so one response's images+text finish
          // before the next response starts — prevents interleaving.
          await withSendLock(result.jid, async () => {
            let sendSucceeded = false;
            try {
              const { images, cleanText } = extractImages(result.response);
              const quoteOpts = { quoted: msg };
              // Send each image with conversation number caption
              const caption = result.conversationNumber != null
                ? `*#${result.conversationNumber}*`
                : undefined;
              for (const imagePath of images) {
                try {
                  const imageData = readFileSync(imagePath);
                  const imgSent = await sendWithRetry(result.jid, { image: imageData, caption }, quoteOpts);
                  if (imgSent?.key?.id) {
                    addBotSentId(imgSent.key.id);
                    storeMessage(imgSent.key.id, imgSent.message);
                  }
                } catch (imgErr) {
                  emitLog('send_image_error', { to: result.sender, path: imagePath, error: imgErr.message });
                }
              }
              // Send text in chunks (~4000 chars each) with Outdoors formatting
              if (cleanText) {
                const labeledText = result.conversationNumber != null
                  ? `*#${result.conversationNumber}*\n${cleanText}`
                  : cleanText;
                const formatted = formatOutdoorsResponse(labeledText);
                for (let i = 0; i < formatted.length; i += 4000) {
                  const chunk = formatted.slice(i, i + 4000);
                  const sent = await sendWithRetry(result.jid, { text: chunk }, quoteOpts);
                  console.log('[wa:send] result:', JSON.stringify(sent?.key));
                  if (sent?.key?.id) {
                    addBotSentId(sent.key.id);
                    storeMessage(sent.key.id, sent.message);
                  }
                }
              }
              if (!cleanText && images.length === 0) {
                // Response existed but was empty after processing — notify user
                emitLog('empty_response', { to: result.sender, rawLength: result.response.length });
                const fallback = formatOutdoorsResponse(`I processed your message but had nothing to say. Try rephrasing?`);
                const sent = await sendWithRetry(result.jid, { text: fallback }, quoteOpts);
                if (sent?.key?.id) {
                  addBotSentId(sent.key.id);
                  storeMessage(sent.key.id, sent.message);
                }
              }
              sendSucceeded = true;
              incrementMessageCount();
              console.log(`Sent to ${result.sender} (${result.response.length} chars)`);
              emitLog('sent', { to: result.sender, response: result.response, responseLength: result.response.length, imageCount: images.length });
            } catch (err) {
              emitLog('send_error', { to: result.sender, error: err.message });
              // Last-resort: retry raw text without quoting or formatting
              try {
                const sent = await sendWithRetry(result.jid, { text: result.response.slice(0, 4000) });
                if (sent?.key?.id) { addBotSentId(sent.key.id); storeMessage(sent.key.id, sent.message); }
                sendSucceeded = true;
                emitLog('sent_fallback', { to: result.sender, responseLength: result.response.length });
              } catch (retryErr) {
                emitLog('send_error_final', { to: result.sender, error: retryErr.message });
              }
            } finally {
              // Clean up session now that all image files have been read and sent
              if (result.internalSessionId) {
                closeSession(result.internalSessionId);
              }
            }

            // Persist conversation log
            try {
              mkdirSync(LOGS_DIR, { recursive: true });
              const filename = `${nextLogNumber()}_${result.sender}.json`;
              const convoLog = {
                sender: result.sender,
                prompt: result.prompt,
                jid: result.jid,
                conversationNumber: result.conversationNumber ?? null,
                sessionId: result.sessionId || null,
                timestamp: new Date().toISOString(),
                fullEvents: result.fullEvents || [],
                response: result.response,
                sendSucceeded,
                runtimeFingerprint: result.runtimeFingerprint || null,
                runtimeStaleDetected: !!result.runtimeStaleDetected,
                runtimeChangedFiles: result.runtimeChangedFiles || [],
              };
              writeFileSync(join(LOGS_DIR, filename), JSON.stringify(convoLog, null, 2));
              addToLogIndex(filename, convoLog);
              // Anonymous usage telemetry (counts only, no content)
              const costEvents = (convoLog.fullEvents || []).filter(e => e.type === 'cost');
              const toolEvents = (convoLog.fullEvents || []).filter(e => e.type === 'tool_use');
              recordTask({
                durationMs: convoLog.durationMs || 0,
                platform: 'whatsapp',
                toolCount: toolEvents.length,
                cost: costEvents.reduce((s, e) => s + (e.cost || e.data?.cost || 0), 0),
                inputTokens: costEvents.reduce((s, e) => s + (e.input_tokens || e.data?.input_tokens || 0), 0),
                outputTokens: costEvents.reduce((s, e) => s + (e.output_tokens || e.data?.output_tokens || 0), 0),
                cacheTokens: costEvents.reduce((s, e) => s + (e.cache_read || e.data?.cache_read || 0), 0),
                hasError: !convoLog.sendSucceeded,
              });
              io?.emit('conversation_update', { sessionId: result.sessionId, conversationNumber: result.conversationNumber });
            } catch (e) {
              console.log('[whatsapp:log_write_error]', e.message);
            }
          });
        }
      })().catch(err => console.error('[WhatsApp] Message handler error:', err));
    }
  });

  return sock;
}

function getLastQR() {
  return lastQR;
}

async function reconnectWhatsApp() {
  // Prevent the close handler from auto-reconnecting while we do a manual reconnect
  manualReconnecting = true;

  // Close existing connection and wipe auth state to force new QR
  if (sock) {
    try { sock.end(new Error('User requested reconnect')); } catch {}
    sock = null;
  }
  connectionStatus = 'disconnected';
  lastQR = null;
  reconnectAttempt = 0;

  // Wipe auth state to force fresh QR code
  const authDir = join(__dirname, '..', config.authDir || 'auth_state');
  try {
    const { rmSync } = await import('fs');
    rmSync(authDir, { recursive: true, force: true });
    console.log('[WhatsApp] Wiped auth state for reconnect');
  } catch {}

  // Clear saved group JID so it searches for existing group on reconnect
  config.outdoorsGroupJid = '';
  saveConfig(config);

  // Small delay to let the close event fire and be ignored
  await new Promise(r => setTimeout(r, 500));
  manualReconnecting = false;

  // Restart
  await startWhatsApp();
  return { ok: true };
}

/**
 * Send a text message to the Outdoors WhatsApp group.
 * Used by trigger scheduler to deliver trigger responses.
 * Retries up to 3 times, waits for reconnect if disconnected.
 */
async function sendToOutdoorsGroup(text) {
  const groupJid = config.outdoorsGroupJid;
  if (!groupJid) {
    console.log('[WhatsApp] Cannot send — no Outdoors group configured');
    return null;
  }
  if (!sock || connectionStatus !== 'connected') {
    // Wait up to 30 seconds for reconnection
    console.log('[WhatsApp] Disconnected — waiting up to 30s for reconnect before sending trigger response...');
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (sock && connectionStatus === 'connected') break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!sock || connectionStatus !== 'connected') {
      console.error('[WhatsApp] Still disconnected after 30s — trigger response lost');
      return null;
    }
  }
  const formatted = formatOutdoorsResponse(text);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sent = await sock.sendMessage(groupJid, { text: formatted });
      if (sent?.key?.id) {
        addBotSentId(sent.key.id);
        storeMessage(sent.key.id, sent.message);
      }
      return sent;
    } catch (err) {
      console.log(`[WhatsApp] Trigger send attempt ${attempt}/3 failed:`, err.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

export { startWhatsApp, setSocketIO, getStatus, getLastQR, reconnectWhatsApp, sendToOutdoorsGroup };
