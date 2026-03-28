/**
 * Trigger Scheduler — Fires scheduled prompts into the bot pipeline.
 *
 * Checks all enabled triggers every 60 seconds and executes matching ones
 * through the same executeClaudePrompt pipeline used by web messages.
 */

import { loadConfig, saveConfig } from './config.js';
import { createSession, closeSession } from '../../../outdoorsv4/session/session-manager.js';
import { sendToOutdoorsGroup } from './whatsapp-client.js';

let deps = null;
let checkInterval = null;
let triggers = [];

export function startTriggerScheduler(context) {
  deps = context;
  triggers = loadConfig().triggers || [];
  console.log(`  [Triggers] Loaded ${triggers.length} trigger(s)`);

  // Check every 60 seconds
  checkInterval = setInterval(() => checkTriggers(), 60_000);
  // Also check immediately on startup (for missed triggers)
  setTimeout(() => checkTriggers(), 5_000);
}

export function reloadTriggers() {
  triggers = loadConfig().triggers || [];
  console.log(`  [Triggers] Reloaded — ${triggers.length} trigger(s)`);
}

async function checkTriggers() {
  if (!deps) return;
  const now = new Date();

  for (const trigger of triggers) {
    if (!trigger.enabled) continue;
    if (shouldFire(trigger, now)) {
      try {
        await fireTrigger(trigger, now);
      } catch (err) {
        console.error(`[Triggers] Error firing "${trigger.name}":`, err.message);
      }
    }
  }
}

function shouldFire(trigger, now) {
  const schedule = trigger.schedule;
  if (!schedule || !schedule.type) return false;

  const lastFired = trigger.lastFiredAt ? new Date(trigger.lastFiredAt) : null;

  switch (schedule.type) {
    case 'interval': {
      const intervalMs = (schedule.intervalMinutes || 60) * 60_000;
      if (!lastFired) return true;
      return (now.getTime() - lastFired.getTime()) >= intervalMs;
    }

    case 'daily': {
      const [hours, minutes] = (schedule.timeOfDay || '09:00').split(':').map(Number);
      // Fire if we're at or past the scheduled time today and haven't fired today yet
      if (lastFired && isSameDay(lastFired, now)) return false;
      const todayTarget = new Date(now);
      todayTarget.setHours(hours, minutes, 0, 0);
      return now >= todayTarget;
    }

    case 'weekly': {
      const targetDay = schedule.dayOfWeek ?? 1; // 0=Sun..6=Sat
      const [hours, minutes] = (schedule.timeOfDay || '09:00').split(':').map(Number);
      if (now.getDay() !== targetDay) return false;
      if (lastFired && isSameDay(lastFired, now)) return false;
      const todayTarget = new Date(now);
      todayTarget.setHours(hours, minutes, 0, 0);
      return now >= todayTarget;
    }

    case 'once': {
      if (lastFired) return false;
      const target = new Date(schedule.datetime);
      return now >= target;
    }

    default:
      return false;
  }
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

async function fireTrigger(trigger, now) {
  console.log(`[Triggers] Firing "${trigger.name}": ${trigger.prompt.slice(0, 80)}`);

  const { io, emitLog, executeCodexPrompt } = deps;
  const processKey = `trigger:${trigger.id}`;

  // Log to dashboard feed
  emitLog('incoming', { sender: `Trigger: ${trigger.name}`, processKey, prompt: trigger.prompt });

  // Create session
  const session = createSession(processKey, 'web');
  io.emit('session_created', { id: session.id, processKey, transport: 'trigger' });

  let succeeded = false;
  try {
    const onProgress = (type, data) => {
      emitLog(type, { sender: 'trigger', processKey, ...data });
    };

    const result = await executeCodexPrompt(trigger.prompt, {
      onProgress,
      processKey,
      clarificationKey: processKey,
      sessionContext: session,
    });

    const responseText = result?.response;
    const responseLen = responseText?.length || 0;

    // Send trigger response to WhatsApp group
    if (responseText) {
      const sent = await sendToOutdoorsGroup(responseText);
      if (sent) {
        console.log(`[Triggers] Sent "${trigger.name}" response to WhatsApp (${responseLen} chars)`);
        succeeded = true;
      } else {
        console.error(`[Triggers] Failed to send "${trigger.name}" response to WhatsApp`);
      }
    }

    emitLog('sent', { to: `Trigger: ${trigger.name}`, response: responseText || '', responseLength: responseLen });
  } finally {
    closeSession(session.id);
  }

  // Only update lastFiredAt on success — failed triggers should retry next cycle
  if (succeeded) {
    trigger.lastFiredAt = now.toISOString();
    if (trigger.schedule.type === 'once') {
      trigger.enabled = false;
    }
    persistTriggerUpdate(trigger);
  }
}

function persistTriggerUpdate(updatedTrigger) {
  try {
    const cfg = loadConfig();
    const list = cfg.triggers || [];
    const idx = list.findIndex(t => t.id === updatedTrigger.id);
    if (idx >= 0) {
      list[idx] = updatedTrigger;
    }
    cfg.triggers = list;
    saveConfig(cfg);
    // Keep in-memory list in sync
    triggers = list;
  } catch (err) {
    console.error('[Triggers] Failed to persist update:', err.message);
  }
}
