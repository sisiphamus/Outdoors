// Message quota — daily allowance that grows with verified referrals.
// 30 messages on first day, then 10/day base + 10/day per verified referral.
// Referrals verified by sending an invite email and checking for bounces.
import { config, saveConfig } from './config.js';

const FIRST_DAY_ALLOWANCE = 30;
const DAILY_BASE = 10;
const DAILY_PER_REFERRAL = 10;
const BOUNCE_CHECK_DELAY_MS = 45000; // 45 seconds

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isFirstDay() {
  if (!config.firstUseDate) {
    config.firstUseDate = today();
    saveConfig(config);
  }
  return config.firstUseDate === today();
}

export function getDailyQuota() {
  const referrals = (config.referrals || []).length;
  if (isFirstDay()) return FIRST_DAY_ALLOWANCE;
  return DAILY_BASE + (DAILY_PER_REFERRAL * referrals);
}

function getTodayCount() {
  if (config.dailyCountDate !== today()) {
    config.dailyCountDate = today();
    config.dailyCount = 0;
    saveConfig(config);
  }
  return config.dailyCount || 0;
}

export function hasQuota() {
  return getTodayCount() < getDailyQuota();
}

export function incrementMessageCount() {
  if (config.dailyCountDate !== today()) {
    config.dailyCountDate = today();
    config.dailyCount = 0;
  }
  config.dailyCount = (config.dailyCount || 0) + 1;
  config.messageCount = (config.messageCount || 0) + 1;
  saveConfig(config);
}

// Start referral — validate email, send invite, then check for bounce after 45s.
// executePrompt: function to run a Codex prompt (for sending email + checking bounce)
// replyFn: function to send a message back to the user after verification
export function startReferral(email, executePrompt, replyFn) {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith('@rice.edu')) {
    return { ok: false, error: 'Must be a @rice.edu email address.' };
  }
  if (!config.referrals) config.referrals = [];
  if (config.referrals.includes(normalized)) {
    return { ok: false, error: 'That email has already been referred.' };
  }
  if (!config.pendingReferrals) config.pendingReferrals = [];
  if (config.pendingReferrals.includes(normalized)) {
    return { ok: false, error: 'Verification in progress for that email.' };
  }

  // Send invite email
  const emailPrompt = `Send an email to ${normalized} with subject "You've been invited to Outdoors" and body "Hey! Someone shared Outdoors with you — a personal AI assistant that works through WhatsApp.\n\nGet started at tryoutdoors.com\n\nOutdoors can send emails, manage your calendar, build websites, research topics, and more — all from your phone.". Use Gmail MCP tools. Send it now, do not ask questions.`;
  executePrompt(emailPrompt, { processKey: 'system:refer', onProgress: () => {} }).catch(() => {});

  // Add to pending
  config.pendingReferrals.push(normalized);
  saveConfig(config);

  // After 45s, check for bounce
  setTimeout(async () => {
    try {
      const bounceCheckPrompt = `Search Gmail for emails from mailer-daemon@googlemail.com received in the last 2 minutes. Check if any mention "${normalized}" as an undeliverable address. Respond with ONLY the word "BOUNCED" if you find a delivery failure for that address, or ONLY the word "DELIVERED" if no bounce was found. Do not include any other text.`;
      const result = await executePrompt(bounceCheckPrompt, { processKey: 'system:bounce-check', onProgress: () => {} });
      const response = (result.response || '').trim().toUpperCase();
      const bounced = response.includes('BOUNCED');

      // Remove from pending
      config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== normalized);

      if (bounced) {
        saveConfig(config);
        replyFn(`The email ${normalized} doesn't exist — referral not counted.`);
      } else {
        if (!config.referrals.includes(normalized)) {
          config.referrals.push(normalized);
        }
        saveConfig(config);
        const status = getQuotaStatus();
        replyFn(`Verified! ${normalized} confirmed. Your daily limit is now ${status.dailyQuota} messages (${status.remaining} remaining today).`);
      }
    } catch {
      // On error, give benefit of the doubt
      config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== normalized);
      if (!config.referrals.includes(normalized)) {
        config.referrals.push(normalized);
      }
      saveConfig(config);
    }
  }, BOUNCE_CHECK_DELAY_MS);

  return { ok: true, pending: true };
}

export function getQuotaStatus() {
  const dailyQuota = getDailyQuota();
  const usedToday = getTodayCount();
  return {
    usedToday,
    dailyQuota,
    remaining: Math.max(0, dailyQuota - usedToday),
    referrals: (config.referrals || []).length,
    lifetimeTotal: config.messageCount || 0,
  };
}
