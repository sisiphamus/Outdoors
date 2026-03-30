// Message quota — daily allowance that grows with verified referrals.
// 30 messages on first day, then 10/day base + 10/day per verified referral.
// Referrals grant quota immediately; revoked if email bounces.
import { config, saveConfig } from './config.js';

const FIRST_DAY_ALLOWANCE = 30;
const DAILY_BASE = 10;
const DAILY_PER_REFERRAL = 10;
const BOUNCE_CHECK_DELAY_MS = 45000;

// Pending referral customization: email → { stage, senderName }
const pendingCustomization = new Map();

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

// Step 1: User sends "refer friend@rice.edu" — validate and ask for customization
export function initReferral(email, senderName) {
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
    return { ok: false, error: 'Already sending an invite to that email.' };
  }

  // Extract friend's name from email (before @)
  const friendName = normalized.split('@')[0].replace(/[._]/g, ' ').replace(/\d+/g, '').trim();
  const friendFirst = friendName.split(' ')[0];
  const capitalizedFriend = friendFirst.charAt(0).toUpperCase() + friendFirst.slice(1);

  pendingCustomization.set(normalized, { senderName, friendName: capitalizedFriend });

  return {
    ok: true,
    needsCustomization: true,
    email: normalized,
    friendName: capitalizedFriend,
    prompt: `Want to add a personal message to ${capitalizedFriend}? Reply with your message, or just say "send" to use the default invite.`,
  };
}

// Step 2: User replies with custom message or "send" — send the email and grant quota immediately
export function sendReferral(email, customMessage, executePrompt, replyFn, killProcessFn) {
  const normalized = email.trim().toLowerCase();
  const pending = pendingCustomization.get(normalized);
  if (!pending) return { ok: false, error: 'No pending referral for that email.' };
  pendingCustomization.delete(normalized);

  const senderName = pending.senderName || 'A friend';
  const friendName = pending.friendName || 'there';
  const isDefault = !customMessage || customMessage.toLowerCase() === 'send';

  const personalNote = isDefault
    ? ''
    : `\n\n${senderName} says: "${customMessage}"`;

  const emailBody = `Hey ${friendName},\n\nYou're Invited! ${senderName} has been using Outdoors and you get to be one of the first users.\n\n$100 in free usage thanks to OpenAI <3${personalNote}\n\nOutdoors is a personal AI assistant that works through WhatsApp — it can send emails, manage your calendar, build websites, do research, and way more.\n\nGet started: tryoutdoors-rice.pages.dev`;

  const emailPrompt = `Send an email to ${normalized} with subject "You're Invited to Outdoors" and body:\n\n${emailBody}\n\nUse Gmail MCP tools. Send it now.`;
  executePrompt(emailPrompt, { processKey: 'system:refer', onProgress: () => {} }).catch(() => {});

  // Grant quota immediately
  if (!config.referrals) config.referrals = [];
  if (!config.referrals.includes(normalized)) {
    config.referrals.push(normalized);
  }
  if (!config.pendingReferrals) config.pendingReferrals = [];
  config.pendingReferrals.push(normalized);
  saveConfig(config);

  const status = getQuotaStatus();

  // After 45s, check for bounce — revoke if fake
  setTimeout(async () => {
    try {
      const bounceCheckPrompt = `Search Gmail for emails from mailer-daemon@googlemail.com received in the last 2 minutes. Check if any mention "${normalized}" as an undeliverable address. Respond with ONLY the word "BOUNCED" if you find a delivery failure, or ONLY "DELIVERED" if no bounce found.`;
      const result = await executePrompt(bounceCheckPrompt, { processKey: 'system:bounce-check', onProgress: () => {} });
      const bounced = (result.response || '').trim().toUpperCase().includes('BOUNCED');

      config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== normalized);

      if (bounced) {
        // Revoke the referral
        config.referrals = (config.referrals || []).filter(e => e !== normalized);
        saveConfig(config);
        // Kill any running task and notify
        if (killProcessFn) {
          try { killProcessFn(); } catch {}
        }
        replyFn(`That email (${normalized}) doesn't exist — the referral has been revoked and your daily limit has been reduced. Please refer a real Rice email to get it back.`);
      } else {
        // Confirmed — just clean up pending
        saveConfig(config);
      }
    } catch {
      // On error, keep the referral (benefit of the doubt)
      config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== normalized);
      saveConfig(config);
    }
  }, BOUNCE_CHECK_DELAY_MS);

  return { ok: true, remaining: status.remaining, dailyQuota: status.dailyQuota };
}

// Check if there's a pending customization waiting for user reply
export function getPendingReferralEmail() {
  if (pendingCustomization.size === 0) return null;
  // Return the most recently added email
  const entries = [...pendingCustomization.keys()];
  return entries[entries.length - 1];
}

export function cancelPendingReferral(email) {
  pendingCustomization.delete(email);
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
