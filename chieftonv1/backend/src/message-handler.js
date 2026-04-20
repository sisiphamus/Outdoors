import { executeCodexPrompt, killProcess, hasActiveProcess, codeAgentOptions, clearClarificationState, getActiveProcessSummary } from './claude-bridge.js';
import { config } from './config.js';
import { parseMessage, resolveSession, createOrUpdateConversation, closeConversation, getConversationMode } from './conversation-manager.js';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { createRuntimeAwareProgress } from './runtime-health.js';
import { createSession, closeSession } from '../../../chieftonv4/session/session-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SHORT_TERM_DIR = join(__dirname, '..', 'bot', 'memory', 'short-term');
const CHAT_SESSIONS_PATH = join(__dirname, '..', 'bot', 'memory', 'wa-chat-sessions.json');
const LOGS_DIR = join(__dirname, '..', 'bot', 'logs');
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Get a summary of the last N conversation logs for context injection.
 * Returns a string that tells Claude what was recently done (completed tasks).
 */
function getRecentLogContext(count = 2) {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => {
        const numA = parseInt(a, 10) || 0;
        const numB = parseInt(b, 10) || 0;
        return numB - numA; // newest first
      })
      .slice(0, count);

    if (files.length === 0) return '';

    const summaries = files.map(f => {
      try {
        const data = JSON.parse(readFileSync(join(LOGS_DIR, f), 'utf-8'));
        const prompt = data.prompt || '(no prompt)';
        const response = data.response || data.result?.response || '(no response)';
        // Truncate to keep context reasonable
        const truncResponse = response.length > 500 ? response.slice(0, 500) + '...' : response;
        return `Request: ${prompt}\nCompleted response: ${truncResponse}`;
      } catch { return null; }
    }).filter(Boolean);

    if (summaries.length === 0) return '';

    return `\n\n<conversation-history>\nIMPORTANT CONTEXT: These are the user's most recent completed conversations with you. Use this to understand what they're referring to. These tasks are ALREADY DONE — do NOT re-execute them.\n\n${summaries.join('\n\n---\n\n')}\n</conversation-history>\n\n`;
  } catch { return ''; }
}

// Track active sessions per JID for conversation continuity
const chatSessions = new Map();

function loadChatSessions() {
  try {
    if (existsSync(CHAT_SESSIONS_PATH)) {
      const data = JSON.parse(readFileSync(CHAT_SESSIONS_PATH, 'utf-8'));
      for (const [key, value] of Object.entries(data)) {
        chatSessions.set(key, value);
      }
    }
  } catch {}
}

function saveChatSessions() {
  try {
    const obj = {};
    for (const [key, value] of chatSessions) {
      obj[key] = value;
    }
    const tmpPath = CHAT_SESSIONS_PATH + `.tmp.${randomBytes(4).toString('hex')}`;
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    renameSync(tmpPath, CHAT_SESSIONS_PATH);
  } catch {}
}

loadChatSessions();

const rateLimitMap = new Map();

function isRateLimited(jid) {
  const now = Date.now();
  const timestamps = rateLimitMap.get(jid) || [];
  const recent = timestamps.filter((t) => now - t < 60000);
  if (recent.length === 0) { rateLimitMap.delete(jid); }
  else { rateLimitMap.set(jid, recent); }
  return recent.length >= config.rateLimitPerMinute;
}

function recordMessage(jid) {
  const timestamps = rateLimitMap.get(jid) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(jid, timestamps);
}

function isAllowed(jid) {
  if (config.allowAllNumbers) return true;
  const number = jid.replace(/@.*/, '');
  return config.allowedNumbers.some((n) => number.includes(n.replace(/\D/g, '')));
}

function extractPrompt(text) {
  if (!text) return null;
  if (config.prefix && text.startsWith(config.prefix)) {
    return text.slice(config.prefix.length).trim();
  }
  if (!config.prefix) return text.trim();
  return null;
}

function formatQuestionsForText(questionsPayload) {
  const questions = Array.isArray(questionsPayload?.questions) ? questionsPayload.questions : [];
  if (!questions.length) {
    return 'I need a bit more detail before I continue. Please reply with the missing details.';
  }
  const lines = ['I need a few details before I continue:'];
  for (let i = 0; i < questions.length; i++) {
    lines.push(`${i + 1}. ${questions[i].question || 'Please clarify'}`);
    if (questions[i].options?.length) {
      for (const opt of questions[i].options) {
        lines.push(`   • ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
      }
    }
  }
  lines.push('Reply with your answer(s), and I will continue.');
  return lines.join('\n');
}

/**
 * Downloads an image from a WhatsApp message and saves it to short-term memory.
 * Returns the file path or null.
 */
async function downloadWhatsAppImage(message, imageDir) {
  const imageMsg = message.message?.imageMessage || message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
  if (!imageMsg) return null;

  const dir = imageDir || SHORT_TERM_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    const stream = await downloadContentFromMessage(imageMsg, 'image');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const ext = (imageMsg.mimetype || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const filename = `wa_${randomBytes(4).toString('hex')}.${ext}`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, buffer);
    return filepath;
  } catch (err) {
    console.log('[whatsapp:image_download_error]', err.message);
    return null;
  }
}

/**
 * Downloads a voice/audio message and saves it.
 */
async function downloadWhatsAppAudio(message, audioDir) {
  const audioMsg = message.message?.audioMessage;
  if (!audioMsg) return null;

  const dir = audioDir || SHORT_TERM_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    const stream = await downloadContentFromMessage(audioMsg, 'audio');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const filename = `wa_voice_${randomBytes(4).toString('hex')}.ogg`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, buffer);
    return filepath;
  } catch (err) {
    console.log('[whatsapp:audio_download_error]', err.message);
    return null;
  }
}

/**
 * Downloads a video message and saves it.
 */
async function downloadWhatsAppVideo(message, videoDir) {
  const videoMsg = message.message?.videoMessage;
  if (!videoMsg) return null;

  const dir = videoDir || SHORT_TERM_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    const stream = await downloadContentFromMessage(videoMsg, 'video');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const filename = `wa_video_${randomBytes(4).toString('hex')}.mp4`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, buffer);
    return filepath;
  } catch (err) {
    console.log('[whatsapp:video_download_error]', err.message);
    return null;
  }
}

/**
 * Transcribe audio using whisper.cpp.
 * Returns the transcribed text or null.
 */
async function transcribeAudio(audioPath) {
  // Find whisper binary — check common install locations
  const IS_WIN = process.platform === 'win32';
  const whisperName = IS_WIN ? 'whisper-cli.exe' : 'whisper-cli';
  const candidatePaths = IS_WIN ? [
    join(process.env.LOCALAPPDATA || '', 'whisper-cpp', whisperName),
    join(process.env.PROGRAMFILES || '', 'whisper-cpp', whisperName),
    join(__dirname, '..', 'bin', whisperName),
  ] : [
    '/usr/local/bin/whisper-cli',
    join(process.env.HOME || '', '.local', 'bin', whisperName),
    join(__dirname, '..', 'bin', whisperName),
  ];

  let whisperBin = null;
  for (const p of candidatePaths) {
    if (existsSync(p)) { whisperBin = p; break; }
  }

  // Fallback: try PATH
  if (!whisperBin) whisperBin = whisperName;

  // Find model file
  const modelDir = IS_WIN
    ? join(process.env.LOCALAPPDATA || '', 'whisper-cpp', 'models')
    : join(process.env.HOME || '', '.local', 'share', 'whisper-cpp', 'models');
  const modelPath = join(modelDir, 'ggml-base.bin');

  if (!existsSync(modelPath)) {
    console.log('[whisper] Model not found at', modelPath);
    return null;
  }

  // Convert ogg to wav first (whisper.cpp needs wav)
  const wavPath = audioPath.replace(/\.ogg$/, '.wav');

  // Try ffmpeg for conversion
  try {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-i', audioPath, '-ar', '16000', '-ac', '1', '-y', wavPath],
        { timeout: 15000, shell: IS_WIN },
        (err) => err ? reject(err) : resolve());
    });
  } catch {
    // Try without ffmpeg — whisper.cpp might handle ogg directly on some builds
    // If not, we can't transcribe
    console.log('[whisper] ffmpeg not available for audio conversion');
    return null;
  }

  return new Promise((resolve) => {
    execFile(whisperBin, ['-m', modelPath, '-f', wavPath, '--no-timestamps', '-otxt'],
      { timeout: 60000, shell: IS_WIN },
      (err, stdout) => {
        if (err) {
          console.log('[whisper:error]', err.message);
          resolve(null);
          return;
        }
        // whisper-cli outputs to stdout or creates a .txt file
        const txtPath = wavPath + '.txt';
        let text = stdout?.trim();
        if (!text && existsSync(txtPath)) {
          text = readFileSync(txtPath, 'utf-8').trim();
        }
        resolve(text || null);
      });
  });
}

/**
 * Processes an incoming WhatsApp message.
 * Returns { response, sender, prompt } or null if the message should be ignored.
 */
export async function handleMessage(message, emitLog) {
  const jid = message.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return null;

  // Extract text from various message types
  const text =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    message.message?.videoMessage?.caption ||
    null;

  // Check for media attachments
  const hasImage = !!(message.message?.imageMessage);
  const hasAudio = !!(message.message?.audioMessage);
  const hasVideo = !!(message.message?.videoMessage);

  // Need either text or media
  if (!text && !hasImage && !hasAudio && !hasVideo) return null;

  // Self-messages and group messages bypass the prefix requirement
  const isSelfMessage = !!message.key.fromMe;
  const isGroup = jid.endsWith('@g.us');
  let prompt;
  if (isSelfMessage || isGroup) {
    prompt = (text || (hasImage ? 'What is this image?' : null))?.trim() || null;
    // Still strip prefix if present
    if (prompt && config.prefix && prompt.startsWith(config.prefix)) {
      prompt = prompt.slice(config.prefix.length).trim();
    }
  } else {
    prompt = extractPrompt(text || (hasImage ? 'What is this image?' : null));
  }
  if (!prompt) return null;

  const sender = message.pushName || jid.replace(/@.*/, '');
  emitLog?.('incoming', { sender, prompt, jid });

  // Validate sender: always allow messages from the Chiefton group,
  // check participant JID for other groups, sender JID for DMs
  const isChieftonGroup = isGroup && config.chieftonGroupJid && jid === config.chieftonGroupJid;
  const senderJid = isGroup ? (message.key.participant || jid) : jid;
  if (!isSelfMessage && !isChieftonGroup && !isAllowed(senderJid)) {
    emitLog?.('blocked', { sender, jid: senderJid, reason: 'not in allowed list' });
    return null;
  }

  if (isRateLimited(jid)) {
    emitLog?.('rate-limited', { sender, jid });
    return { response: 'Rate limited. Please wait a moment.', sender, prompt, jid };
  }

  recordMessage(jid);

  // Parse for numbered conversation prefix
  const parsed = parseMessage(prompt);

  // Handle new command (close a numbered conversation)
  if (parsed.command === 'new') {
    const closed = closeConversation(parsed.number);
    clearClarificationState(`wa:conv:${parsed.number}`);
    const response = closed
      ? `Conversation #${parsed.number} closed.`
      : `No active conversation #${parsed.number}.`;
    return { response, sender, prompt, jid };
  }

  // Handle stop command
  if (parsed.command === 'stop') {
    const processKey = parsed.number !== null ? `wa:conv:${parsed.number}` : `wa:chat:${jid}`;
    const killed = killProcess(processKey);
    clearClarificationState(processKey);
    if (killed) {
      const label = parsed.number !== null ? `conversation #${parsed.number}` : 'current conversation';
      return { response: `Stopped ${label}.`, sender, prompt, jid };
    } else {
      const label = parsed.number !== null ? `conversation #${parsed.number}` : 'this chat';
      return { response: `Nothing running for ${label}.`, sender, prompt, jid };
    }
  }

  // Handle pause command (same as stop, friendlier message)
  if (parsed.command === 'pause') {
    let killed = false;
    if (parsed.number !== null) {
      killed = killProcess(`wa:conv:${parsed.number}`);
      clearClarificationState(`wa:conv:${parsed.number}`);
    } else {
      // Kill all active processes for this chat (numbered + unnumbered)
      const { numbered, unnumbered } = getActiveProcessSummary();
      for (const item of numbered) {
        killProcess(`wa:conv:${item.number}`);
        clearClarificationState(`wa:conv:${item.number}`);
        killed = true;
      }
      killed = killProcess(`wa:chat:${jid}`) || killed;
      clearClarificationState(`wa:chat:${jid}`);
    }
    const label = parsed.number !== null ? `Conversation #${parsed.number}` : 'All conversations';
    return { response: `${label} paused.${killed ? '' : ' (nothing was running)'}`, sender, prompt, jid };
  }

  // Handle status command (show active processes)
  if (parsed.command === 'status') {
    const { numbered, unnumbered } = getActiveProcessSummary();
    if (numbered.length === 0 && unnumbered.length === 0) {
      return { response: 'No active conversations.', sender, prompt, jid };
    }
    const lines = [];
    for (const item of numbered) {
      const elapsed = Math.round((Date.now() - item.startedAt) / 1000);
      lines.push(`#${item.number} — ${item.label || 'untitled'} (${elapsed}s)`);
    }
    for (const item of unnumbered) {
      const elapsed = Math.round((Date.now() - item.startedAt) / 1000);
      lines.push(`${item.label || item.key} (${elapsed}s)`);
    }
    return { response: lines.join('\n'), sender, prompt, jid };
  }

  // Every message starts a fresh Claude process. No session resumption.
  // The bot has access to logs/memory/skills to understand past context if needed,
  // but never inherits a live Claude session (which causes double-actions like re-sending emails).
  // Numbered conversations are the only exception — they explicitly opt into continuation.
  let resumeSessionId = null;
  if (parsed.number !== null) {
    resumeSessionId = resolveSession(parsed.number);
  }
  const processKey = parsed.number !== null ? `wa:conv:${parsed.number}` : `wa:chat:${jid}`;

  // If this numbered conversation already has a process running, kill it first.
  // Without this, the second process overwrites the first in the registry,
  // orphaning the first process (unreachable by stop/pause).
  if (parsed.number !== null && hasActiveProcess(processKey)) {
    emitLog?.('killing_duplicate', { sender, processKey, conversation: parsed.number, reason: 'new message for same conversation' });
    killProcess(processKey);
  }

  emitLog?.('received', { sender, prompt: parsed.body, conversation: parsed.number, processKey });
  emitLog?.('processing', { sender, prompt: parsed.body, conversation: parsed.number, resuming: resumeSessionId, processKey });

  // Create isolated session for this execution
  const session = createSession(processKey, 'whatsapp');

  // Download and process media attachments
  let finalPrompt = parsed.body;

  if (hasAudio) {
    const audioPath = await downloadWhatsAppAudio(message, session.shortTermDir);
    if (audioPath) {
      emitLog?.('voice', { sender, path: audioPath });
      const transcript = await transcribeAudio(audioPath);
      if (transcript) {
        finalPrompt = `<user_voice_transcript>${transcript}</user_voice_transcript>${finalPrompt ? `\n\n${finalPrompt}` : ''}`;
        emitLog?.('transcription', { sender, text: transcript.slice(0, 100) });
      } else {
        finalPrompt = `[The user sent a voice message but transcription failed. The audio file is at: ${audioPath}]\n\n${finalPrompt || 'Voice message'}`;
      }
    }
  }

  if (hasVideo) {
    const videoPath = await downloadWhatsAppVideo(message, session.shortTermDir);
    if (videoPath) {
      emitLog?.('video', { sender, path: videoPath });
      // Extract audio from video for transcription
      const audioFromVideo = videoPath.replace(/\.mp4$/, '_audio.ogg');
      try {
        await new Promise((resolve, reject) => {
          execFile('ffmpeg', ['-i', videoPath, '-vn', '-acodec', 'libopus', '-y', audioFromVideo],
            { timeout: 30000, shell: process.platform === 'win32' },
            (err) => err ? reject(err) : resolve());
        });
        const transcript = await transcribeAudio(audioFromVideo);
        if (transcript) {
          finalPrompt = `[The user sent a video.]\n<user_voice_transcript>${transcript}</user_voice_transcript>\n[Video file at: ${videoPath}]\n\n${finalPrompt || ''}`;
        } else {
          finalPrompt = `[The user sent a video at: ${videoPath}]\n\n${finalPrompt || 'Video message'}`;
        }
      } catch {
        finalPrompt = `[The user sent a video at: ${videoPath}]\n\n${finalPrompt || 'Video message'}`;
      }
    }
  }

  if (hasImage) {
    const imagePath = await downloadWhatsAppImage(message, session.shortTermDir);
    if (imagePath) {
      finalPrompt = `[The user sent an image. Read it with your Read tool at: ${imagePath}]\n\n${finalPrompt}`;
      emitLog?.('image', { sender, path: imagePath });
    }
  }

  // Inject last 3 completed conversation logs as context (but not for numbered conversations
  // which have their own session continuity). Appended AFTER the user message so Claude
  // sees the user's request first, then the context.
  if (parsed.number === null) {
    const recentContext = getRecentLogContext(3);
    if (recentContext) {
      finalPrompt = finalPrompt + recentContext;
    }
  }

  const isKnownCode = parsed.number !== null && getConversationMode(parsed.number) === 'code';
  const progressWrapper = createRuntimeAwareProgress((type, data) => emitLog?.(type, { sender, processKey, ...data }));
  const onProgress = progressWrapper.onProgress;
  if (progressWrapper.health.stale) {
    emitLog?.('runtime_stale_code_detected', { sender, jid, changedFiles: progressWrapper.health.changedFiles });
  }

  try {
    let execResult;
    let didDelegate = false;
    if (isKnownCode) {
      execResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress, resumeSessionId, processKey, clarificationKey: processKey, sessionContext: session }));
    } else {
      execResult = await executeCodexPrompt(finalPrompt, { onProgress, resumeSessionId, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
      if (execResult.delegation) {
        didDelegate = true;
        emitLog?.('delegation', { sender, employee: 'coder', model: execResult.delegation.model });
        execResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }, execResult.delegation.model));
      }
    }
    if (execResult.status === 'needs_user_input') {
      const response = formatQuestionsForText(execResult.questions);
      return { response, sender, prompt: parsed.body, jid, sessionId: execResult.sessionId, fullEvents: execResult.fullEvents, conversationNumber: parsed.number, internalSessionId: session.id };
    }

    // Auth expired — Codex token needs to be refreshed. Tell the user
    // clearly and don't waste time retrying with the same dead token.
    if (execResult.status === 'auth_expired') {
      emitLog?.('auth_expired', { sender, message: execResult.response });
      return { response: execResult.response, sender, prompt: parsed.body, jid, conversationNumber: parsed.number, internalSessionId: session.id };
    }

    let response = execResult.response;

    // If Codex process died without producing a response (e.g. mid-task quota switch),
    // retry once with a fresh session — the new session will use credits from the start.
    if (!response || !response.trim()) {
      console.log('[message-handler] Codex returned empty response — retrying once...');
      emitLog?.('empty_retry', { sender, reason: 'empty response from Codex' });
      await new Promise(r => setTimeout(r, 3000));
      try {
        const retryResult = await executeCodexPrompt(finalPrompt, { onProgress, processKey, clarificationKey: processKey, detectDelegation: !isKnownCode, sessionContext: session });
        execResult = retryResult;
        response = retryResult.response;
      } catch (retryErr) {
        console.error('[message-handler] Empty-response retry failed:', retryErr.message);
      }
    }

    // If Claude returned an API error as response text, retry up to 2 times
    let apiRetries = 0;
    while (response && /^API Error:|"type"\s*:\s*"error"|"api_error"|Internal server error/i.test(response) && apiRetries < 2) {
      apiRetries++;
      console.log(`[message-handler] Claude returned API error, retrying (${apiRetries}/2)...`);
      emitLog?.('api_retry', { sender, attempt: apiRetries, error: response.slice(0, 100) });
      await new Promise(r => setTimeout(r, 3000 * apiRetries));
      try {
        const retryResult = await executeCodexPrompt(finalPrompt, { onProgress, processKey, clarificationKey: processKey, detectDelegation: !isKnownCode, sessionContext: session });
        execResult = retryResult;
        response = retryResult.response;
      } catch (retryErr) {
        console.error(`[message-handler] API retry ${apiRetries} failed:`, retryErr.message);
      }
    }

    const mode = (isKnownCode || didDelegate) ? 'code' : 'assistant';
    if (execResult.sessionId) {
      if (parsed.number !== null) {
        createOrUpdateConversation(parsed.number, execResult.sessionId, parsed.body, 'whatsapp', mode);
      }
      chatSessions.set(jid, { sessionId: execResult.sessionId, lastActivity: Date.now() });
      saveChatSessions();
    }

    emitLog?.('response', { sender, prompt: parsed.body, responseLength: response.length });
    return {
      response,
      sender,
      prompt: parsed.body,
      jid,
      sessionId: execResult.sessionId,
      fullEvents: execResult.fullEvents,
      conversationNumber: parsed.number,
      internalSessionId: session.id,
      runtimeFingerprint: progressWrapper.health.bootFingerprint,
      runtimeStaleDetected: progressWrapper.health.stale,
      runtimeChangedFiles: progressWrapper.health.changedFiles,
    };
  } catch (err) {
    if (err.stopped) {
      throw err; // Re-throw so whatsapp-client skips the error fallback
    }
    // If resume failed, retry with a fresh session
    if (resumeSessionId) {
      emitLog?.('resume_failed', { sender, error: err.message, fallback: 'fresh session' });
      chatSessions.delete(jid);
      saveChatSessions();
      try {
        const retryProgressWrapper = createRuntimeAwareProgress((type, data) => emitLog?.(type, { sender, processKey, ...data }));
        const retryOnProgress = retryProgressWrapper.onProgress;
        let retryResult;
        let didRetryDelegate = false;
        if (isKnownCode) {
          retryResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress: retryOnProgress, processKey, clarificationKey: processKey, sessionContext: session }));
        } else {
          retryResult = await executeCodexPrompt(finalPrompt, { onProgress: retryOnProgress, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
          if (retryResult.delegation) {
            didRetryDelegate = true;
            retryResult = await executeCodexPrompt(finalPrompt, codeAgentOptions({ onProgress: retryOnProgress, processKey, clarificationKey: processKey, sessionContext: session }, retryResult.delegation.model));
          }
        }
        if (retryResult.status === 'needs_user_input') {
          const response = formatQuestionsForText(retryResult.questions);
          return { response, sender, prompt: parsed.body, jid, sessionId: retryResult.sessionId, fullEvents: retryResult.fullEvents, conversationNumber: parsed.number, internalSessionId: session.id };
        }
        const mode = (isKnownCode || didRetryDelegate) ? 'code' : 'assistant';
        if (retryResult.sessionId) {
          if (parsed.number !== null) {
            createOrUpdateConversation(parsed.number, retryResult.sessionId, parsed.body, 'whatsapp', mode);
          }
          chatSessions.set(jid, { sessionId: retryResult.sessionId, lastActivity: Date.now() });
          saveChatSessions();
        }
        return {
          response: retryResult.response,
          sender,
          prompt: parsed.body,
          jid,
          sessionId: retryResult.sessionId,
          fullEvents: retryResult.fullEvents,
          conversationNumber: parsed.number,
          internalSessionId: session.id,
          runtimeFingerprint: retryProgressWrapper.health.bootFingerprint,
          runtimeStaleDetected: retryProgressWrapper.health.stale,
          runtimeChangedFiles: retryProgressWrapper.health.changedFiles,
        };
      } catch (retryErr) {
        console.error('[message-handler] Retry failed:', retryErr);
        emitLog?.('error', { sender, prompt: parsed.body, error: retryErr.message });
        return { response: 'Something went wrong — check server logs for details.', sender, prompt: parsed.body, jid, internalSessionId: session.id };
      }
    }
    console.error('[message-handler] Execution failed:', err);
    emitLog?.('error', { sender, prompt: parsed.body, error: err.message });
    return {
      response: 'Something went wrong — check server logs for details.',
      sender,
      prompt: parsed.body,
      jid,
      internalSessionId: session.id,
      runtimeFingerprint: progressWrapper.health.bootFingerprint,
      runtimeStaleDetected: progressWrapper.health.stale,
      runtimeChangedFiles: progressWrapper.health.changedFiles,
    };
  } finally {
    // Session cleanup is deferred to the caller (whatsapp-client.js) so that
    // image files in shortTermDir survive until after they've been read and sent.
    // The caller cleans up via result.internalSessionId.
    // Fallback: cleanupStaleSessions() catches any stragglers every 5 minutes.
  }
}

export { isAllowed, isRateLimited, extractPrompt, recordMessage };
