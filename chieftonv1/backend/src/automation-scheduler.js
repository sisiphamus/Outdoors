/**
 * Automation Scheduler — Fires scheduled and event-driven automations.
 *
 * Checks all enabled automations every 60 seconds:
 * - Time-based (interval, daily, weekly, once) — fires at the scheduled time
 * - Email-based — polls Gmail for unread emails from a specific sender
 */

import { loadConfig, saveConfig } from './config.js';
import { createSession, closeSession } from '../../../chieftonv4/session/session-manager.js';
import { sendToChieftonGroup } from './messaging-client.js';

let deps = null;
let checkInterval = null;
let automations = [];
const firingAutomations = new Set(); // In-flight guard to prevent duplicate fires

const EMAIL_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check email automations every 5 minutes

export function startAutomationScheduler(context) {
  deps = context;
  automations = loadConfig().automations || [];
  console.log(`  [Automations] Loaded ${automations.length} automation(s)`);

  // Check every 60 seconds
  checkInterval = setInterval(() => checkAutomations(), 60_000);
  // Also check immediately on startup (for missed automations)
  setTimeout(() => checkAutomations(), 5_000);
}

export function reloadAutomations() {
  automations = loadConfig().automations || [];
  console.log(`  [Automations] Reloaded — ${automations.length} automation(s)`);
}

async function checkAutomations() {
  if (!deps) return;
  const now = new Date();

  for (const automation of automations) {
    if (!automation.enabled) continue;
    if (firingAutomations.has(automation.id)) continue; // Already in-flight
    if (shouldFire(automation, now)) {
      try {
        await fireAutomation(automation, now);
      } catch (err) {
        console.error(`[Automations] Error firing "${automation.name}":`, err.message);
      }
    }
  }
}

function shouldFire(automation, now) {
  const schedule = automation.schedule;
  if (!schedule || !schedule.type) return false;

  const lastFired = automation.lastFiredAt ? new Date(automation.lastFiredAt) : null;

  switch (schedule.type) {
    case 'interval': {
      const intervalMs = (schedule.intervalMinutes || 60) * 60_000;
      if (!lastFired) return true;
      return (now.getTime() - lastFired.getTime()) >= intervalMs;
    }

    case 'daily': {
      const [hours, minutes] = (schedule.timeOfDay || '09:00').split(':').map(Number);
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

    case 'email': {
      // Poll every EMAIL_CHECK_INTERVAL_MS for new emails
      if (!schedule.fromAddress) return false;
      if (!lastFired) return true;
      return (now.getTime() - lastFired.getTime()) >= EMAIL_CHECK_INTERVAL_MS;
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

async function fireAutomation(automation, now) {
  const isEmail = automation.schedule?.type === 'email';
  console.log(`[Automations] Firing "${automation.name}"${isEmail ? ` (email from ${automation.schedule.fromAddress})` : ''}: ${automation.prompt.slice(0, 80)}`);
  firingAutomations.add(automation.id);

  const { io, emitLog, executeCodexPrompt } = deps;
  const processKey = `automation:${automation.id}`;

  // Log to dashboard feed
  emitLog('incoming', { sender: `Automation: ${automation.name}`, processKey, prompt: automation.prompt });

  // Create session
  const session = createSession(processKey, 'web');
  io.emit('session_created', { id: session.id, processKey, transport: 'automation' });

  let succeeded = false;
  try {
    const onProgress = (type, data) => {
      emitLog(type, { sender: 'automation', processKey, ...data });
    };

    // Build the prompt — for email automations, prepend the email search instruction
    let fullPrompt = automation.prompt;
    if (isEmail) {
      const fromAddr = automation.schedule.fromAddress;
      const sinceDate = automation.lastFiredAt
        ? new Date(automation.lastFiredAt).toISOString().split('T')[0]
        : new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      fullPrompt = `First, use mcp__google_workspace__search_gmail_messages to search for unread emails from "${fromAddr}" after ${sinceDate}. ` +
        `If there are NO new unread emails from that sender, respond with exactly: NO_NEW_EMAILS\n` +
        `If there ARE new unread emails, read their content, then do the following:\n\n${automation.prompt}`;
    }

    const result = await executeCodexPrompt(fullPrompt, {
      onProgress,
      processKey,
      clarificationKey: processKey,
      sessionContext: session,
    });

    const responseText = result?.response;
    const responseLen = responseText?.length || 0;

    // For email automations, check if there were no new emails
    if (isEmail && responseText && responseText.trim() === 'NO_NEW_EMAILS') {
      console.log(`[Automations] "${automation.name}" — no new emails from ${automation.schedule.fromAddress}`);
      // Still update lastFiredAt so we don't re-check immediately
      automation.lastFiredAt = now.toISOString();
      persistAutomationUpdate(automation);
      emitLog('sent', { to: `Automation: ${automation.name}`, response: '(no new emails)', responseLength: 0 });
      return;
    }

    // Send automation response to WhatsApp group
    if (responseText) {
      const sent = await sendToChieftonGroup(responseText);
      if (sent) {
        console.log(`[Automations] Sent "${automation.name}" response to WhatsApp (${responseLen} chars)`);
        succeeded = true;
      } else {
        console.error(`[Automations] Failed to send "${automation.name}" response to WhatsApp`);
      }
    }

    emitLog('sent', { to: `Automation: ${automation.name}`, response: responseText || '', responseLength: responseLen });
  } finally {
    closeSession(session.id);
    firingAutomations.delete(automation.id);
  }

  // Only update lastFiredAt on success — failed automations should retry next cycle
  if (succeeded) {
    automation.lastFiredAt = now.toISOString();
    if (automation.schedule.type === 'once') {
      automation.enabled = false;
    }
    persistAutomationUpdate(automation);
  }
}

function persistAutomationUpdate(updatedAutomation) {
  try {
    const cfg = loadConfig();
    const list = cfg.automations || [];
    const idx = list.findIndex(a => a.id === updatedAutomation.id);
    if (idx >= 0) {
      list[idx] = updatedAutomation;
    }
    cfg.automations = list;
    saveConfig(cfg);
    // Keep in-memory list in sync
    automations = list;
  } catch (err) {
    console.error('[Automations] Failed to persist update:', err.message);
  }
}
