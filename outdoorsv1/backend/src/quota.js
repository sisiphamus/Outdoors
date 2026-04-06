// Message quota: daily allowance that grows with verified referrals.
// 20 messages on first day, then 10/day base + 10/day per verified referral.
// Each referral also grants +20 bonus messages on the day it's made.
import { config, saveConfig } from './config.js';

const FIRST_DAY_ALLOWANCE = 20;
const DAILY_BASE = 10;
const DAILY_PER_REFERRAL = 10;
const REFERRAL_BONUS = 20;
const BOUNCE_CHECK_DELAY_MS = 45000;
const REFERRAL_API = 'https://outdoors-referral.outdoors-rice.workers.dev';

// Referral state: jid -> { stage, senderName, friendName, friendLast, email, customMessage }
// Stages: 'firstname' -> 'lastname' -> 'email' -> 'message' -> 'confirm' -> done
const referralState = new Map();

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
  const base = isFirstDay() ? FIRST_DAY_ALLOWANCE : DAILY_BASE + (DAILY_PER_REFERRAL * referrals);
  const bonus = config.referralBonusDate === today() ? (config.referralBonus || 0) : 0;
  return base + bonus;
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
  // Dev override: if downloadKey is ADMIN-DEV, unlimited
  if (config.downloadKey === 'ADMIN-DEV') return true;
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

function isAlreadyReferred(email) {
  if (!config.referrals) return false;
  const normalized = email.trim().toLowerCase();
  return config.referrals.includes(normalized);
}

function isSelfEmail(email) {
  const normalized = email.trim().toLowerCase();
  const own = (config.googleEmail || '').toLowerCase();
  if (!own) return false;
  if (normalized === own) return true;
  // Both @rice.edu: check if the prefix matches (as610 vs antony.saleh)
  if (normalized.endsWith('@rice.edu') && own.endsWith('@rice.edu')) {
    const ownPrefix = own.split('@')[0].replace(/[._]/g, '').toLowerCase();
    const refPrefix = normalized.split('@')[0].replace(/[._]/g, '').toLowerCase();
    if (ownPrefix === refPrefix) return true;
  }
  return false;
}

// Start referral flow
export function startReferralFlow(jid, senderName) {
  referralState.set(jid, { stage: 'firstname', senderName });
  return { ok: true, prompt: "What's their first name?" };
}

export function getReferralState(jid) {
  return referralState.get(jid) || null;
}

export function cancelReferralFlow(jid) {
  referralState.delete(jid);
}

// Process user reply in referral flow
export async function processReferralReply(jid, text, executePrompt, replyFn, killProcessFn) {
  const state = referralState.get(jid);
  if (!state) return null;
  const trimmed = text.trim();

  // Cancel at any stage
  if (/^(cancel|nevermind|no|nvm|stop)$/i.test(trimmed)) {
    referralState.delete(jid);
    return { handled: true, reply: 'Cancelled. You can invite someone anytime by saying "invite".' };
  }

  // Stage: firstname
  if (state.stage === 'firstname') {
    state.friendName = trimmed;
    state.stage = 'lastname';
    referralState.set(jid, state);
    return { handled: true, reply: "What's their last name?" };
  }

  // Stage: lastname
  if (state.stage === 'lastname') {
    state.friendLast = trimmed;
    state.stage = 'email';
    referralState.set(jid, state);
    return { handled: true, reply: `What's ${state.friendName}'s @rice.edu email?` };
  }

  // Stage: email
  if (state.stage === 'email') {
    const email = trimmed.toLowerCase();
    if (!email.endsWith('@rice.edu')) {
      return { handled: true, reply: 'Must be a @rice.edu email. Try again or say *cancel*.' };
    }
    if (isSelfEmail(email)) {
      referralState.delete(jid);
      return { handled: true, reply: "That's your own email! Try inviting someone else." };
    }
    if (isAlreadyReferred(email)) {
      referralState.delete(jid);
      return { handled: true, reply: 'That email has already been referred.' };
    }
    state.email = email;
    state.stage = 'message';
    referralState.set(jid, state);
    return { handled: true, reply: `Want to add a personal message to ${state.friendName}? Type it out, or say *send* to use the default invite.` };
  }

  // Stage: message
  if (state.stage === 'message') {
    state.customMessage = /^send$/i.test(trimmed) ? '' : trimmed;
    state.stage = 'confirm';
    referralState.set(jid, state);

    const preview = state.customMessage
      ? `Send invite to *${state.friendName} ${state.friendLast}* (${state.email}) with your message?\n\nReply *yes* to send or *cancel* to stop.`
      : `Send invite to *${state.friendName} ${state.friendLast}* (${state.email})?\n\nReply *yes* to send or *cancel* to stop.`;
    return { handled: true, reply: preview };
  }

  // Stage: confirm
  if (state.stage === 'confirm') {
    if (!/^(yes|y|send|confirm|ok)$/i.test(trimmed)) {
      return { handled: true, reply: 'Reply *yes* to send or *cancel* to stop.' };
    }

    const { email, friendName, friendLast, senderName, customMessage } = state;
    referralState.delete(jid);

    // Generate invite code
    let inviteCode = '';
    let inviteUrl = 'https://tryoutdoors-rice.pages.dev';
    try {
      const resp = await fetch(REFERRAL_API + '/api/create-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: config.googleEmail || 'user-' + Date.now() }),
      });
      const data = await resp.json();
      if (data.inviteCode) {
        inviteCode = data.inviteCode;
        inviteUrl = data.inviteUrl || inviteUrl;
      }
    } catch {}

    // Build email and send via Codex (fire-and-forget in background)
    const personalNote = customMessage ? `\n\n${senderName} says: "${customMessage}"` : '';
    const emailBody = `Hey ${friendName},\n\nYou're Invited! ${senderName} has been using Outdoors and you get to be one of the first users.\n\n$100 in free usage thanks to OpenAI <3${personalNote}\n\nOutdoors is a personal AI assistant that works through WhatsApp. It can send emails, manage your calendar, build websites, do research, and way more.${inviteCode ? `\n\nYour invite code: ${inviteCode}` : ''}\n\nGet started: ${inviteUrl}`;

    const emailPrompt = `Send an email to ${email} with subject "You're Invited to Outdoors" and body:\n\n${emailBody}\n\nUse send_gmail_message with user_google_email="${config.googleEmail}". Send it now.`;
    executePrompt(emailPrompt, { processKey: 'system:refer', onProgress: () => {} }).catch(() => {});

    // Grant quota immediately
    if (!config.referrals) config.referrals = [];
    if (!config.referrals.includes(email)) config.referrals.push(email);
    if (!config.pendingReferrals) config.pendingReferrals = [];
    config.pendingReferrals.push(email);
    config.referralBonus = (config.referralBonus || 0) + REFERRAL_BONUS;
    config.referralBonusDate = today();
    saveConfig(config);

    const status = getQuotaStatus();

    // Bounce check after 45s
    setTimeout(async () => {
      try {
        const bouncePrompt = `Search Gmail for emails from mailer-daemon@googlemail.com received in the last 2 minutes. Check if any mention "${email}" as an undeliverable address. Respond with ONLY "BOUNCED" or "DELIVERED".`;
        const result = await executePrompt(bouncePrompt, { processKey: 'system:bounce-check', onProgress: () => {} });
        const bounced = (result.response || '').toUpperCase().includes('BOUNCED');
        config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== email);
        if (bounced) {
          config.referrals = (config.referrals || []).filter(e => e !== email);
          if (config.referralBonusDate === today()) {
            config.referralBonus = Math.max(0, (config.referralBonus || 0) - REFERRAL_BONUS);
          }
          saveConfig(config);
          if (killProcessFn) try { killProcessFn(); } catch {}
          replyFn(`That email (${email}) doesn't exist. The referral has been revoked. Try a real Rice email to get it back.`);
        } else {
          saveConfig(config);
        }
      } catch {
        config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== email);
        saveConfig(config);
      }
    }, BOUNCE_CHECK_DELAY_MS);

    return {
      handled: true,
      reply: `Invite being sent to ${friendName} ${friendLast}! Your daily limit is now ${status.dailyQuota} messages (${status.remaining} remaining today).`,
    };
  }

  return null;
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
