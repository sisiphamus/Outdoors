// Message quota — daily allowance that grows with verified referrals.
// 20 messages on first day, then 10/day base + 10/day per verified referral.
// Each referral also grants +20 bonus messages on the day it's made.
// Referrals grant quota immediately; revoked if email bounces.
import { config, saveConfig } from './config.js';

const FIRST_DAY_ALLOWANCE = 20;
const DAILY_BASE = 10;
const DAILY_PER_REFERRAL = 10;
const REFERRAL_BONUS = 20;
const BOUNCE_CHECK_DELAY_MS = 45000;
const REFERRAL_API = 'https://outdoors-referral.outdoors-rice.workers.dev';

// Referral state machine: jid → { stage, senderName, friendName, email, candidates }
// Stages: 'name' → 'select' → 'confirm' → done
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

// Check if an email is already referred (handles Rice aliases)
function isAlreadyReferred(email) {
  if (!config.referrals) return false;
  const normalized = email.trim().toLowerCase();
  if (config.referrals.includes(normalized)) return true;
  // Check alias map
  const aliases = config.referralAliases || {};
  for (const [referred, alts] of Object.entries(aliases)) {
    if (referred === normalized || (alts || []).includes(normalized)) return true;
  }
  return false;
}

// Check if email is the user's own (handles aliases)
function isSelfEmail(email) {
  const normalized = email.trim().toLowerCase();
  const own = (config.googleEmail || '').toLowerCase();
  if (!own) return false;
  if (normalized === own) return true;
  // Check if both are @rice.edu — could be aliases
  if (normalized.endsWith('@rice.edu') && own.endsWith('@rice.edu')) {
    const aliases = config.referralAliases || {};
    const ownAliases = aliases[own] || [];
    if (ownAliases.includes(normalized)) return true;
  }
  return false;
}

// Start the referral flow for a JID
export function startReferralFlow(jid, senderName) {
  referralState.set(jid, { stage: 'manual', senderName });
  return { ok: true, prompt: 'What\'s their @rice.edu email? (e.g. js42@rice.edu)' };
}

// Get current referral state for a JID
export function getReferralState(jid) {
  return referralState.get(jid) || null;
}

// Cancel referral flow
export function cancelReferralFlow(jid) {
  referralState.delete(jid);
}

// Process user's reply in the referral flow
export async function processReferralReply(jid, text, executePrompt, replyFn, killProcessFn) {
  const state = referralState.get(jid);
  if (!state) return null;

  const trimmed = text.trim();

  // Handle cancel at any stage
  if (/^(cancel|nevermind|no|nvm)$/i.test(trimmed)) {
    referralState.delete(jid);
    return { handled: true, reply: 'Cancelled. You can invite someone anytime by saying "invite".' };
  }

  // Stage: name — user provides friend's name
  if (state.stage === 'name') {
    state.searchName = trimmed;
    state.stage = 'searching';
    referralState.set(jid, state);

    // Search Google Contacts for the name
    try {
      const searchPrompt = `Search Google Contacts for "${trimmed}" using search_contacts with user_google_email="${config.googleEmail}". Return ONLY a JSON array of objects with fields: name, email (pick the @rice.edu email if available, otherwise any email). If no results, return []. Do NOT include any other text — just the JSON array.`;
      const result = await executePrompt(searchPrompt, { processKey: 'system:refer-search', onProgress: () => {}, timeout: 30000 });
      const response = (result.response || '').trim();

      // Parse contacts from response
      let contacts = [];
      try {
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) contacts = JSON.parse(jsonMatch[0]);
      } catch {}

      // Filter to rice.edu emails only
      const riceContacts = contacts.filter(c => c.email && c.email.endsWith('@rice.edu'));

      if (riceContacts.length === 0) {
        state.stage = 'manual';
        referralState.set(jid, state);
        return { handled: true, reply: `I couldn't find "${trimmed}" in your contacts with a Rice email. What's their @rice.edu email address?` };
      }

      if (riceContacts.length === 1) {
        const contact = riceContacts[0];
        state.stage = 'confirm';
        state.friendName = contact.name;
        state.email = contact.email.toLowerCase();
        referralState.set(jid, state);

        // Validate before showing confirm
        if (isSelfEmail(state.email)) {
          referralState.delete(jid);
          return { handled: true, reply: 'That\'s your own email! Try inviting someone else.' };
        }
        if (isAlreadyReferred(state.email)) {
          referralState.delete(jid);
          return { handled: true, reply: `${contact.name} (${contact.email}) has already been referred.` };
        }

        return { handled: true, reply: `I found *${contact.name}* (${contact.email}). Send them an invite?\n\nReply *yes* to send or *cancel* to stop.` };
      }

      // Multiple results
      state.stage = 'select';
      state.candidates = riceContacts.slice(0, 5);
      referralState.set(jid, state);
      const list = state.candidates.map((c, i) => `${i + 1}. ${c.name} (${c.email})`).join('\n');
      return { handled: true, reply: `I found multiple people:\n\n${list}\n\nReply with the number, or *cancel* to stop.` };

    } catch {
      state.stage = 'manual';
      referralState.set(jid, state);
      return { handled: true, reply: `Couldn't search contacts right now. What's their @rice.edu email address?` };
    }
  }

  // Stage: select — user picks from multiple results
  if (state.stage === 'select') {
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || num > (state.candidates || []).length) {
      return { handled: true, reply: `Please reply with a number (1-${(state.candidates || []).length}) or *cancel*.` };
    }
    const contact = state.candidates[num - 1];
    state.stage = 'confirm';
    state.friendName = contact.name;
    state.email = contact.email.toLowerCase();
    referralState.set(jid, state);

    if (isSelfEmail(state.email)) {
      referralState.delete(jid);
      return { handled: true, reply: 'That\'s your own email! Try inviting someone else.' };
    }
    if (isAlreadyReferred(state.email)) {
      referralState.delete(jid);
      return { handled: true, reply: `${contact.name} (${contact.email}) has already been referred.` };
    }

    return { handled: true, reply: `Send invite to *${contact.name}* (${contact.email})?\n\nReply *yes* to send or *cancel* to stop.` };
  }

  // Stage: manual — user types email directly
  if (state.stage === 'manual') {
    const email = trimmed.toLowerCase();
    if (!email.endsWith('@rice.edu')) {
      return { handled: true, reply: 'Must be a @rice.edu email address. Try again or say *cancel*.' };
    }
    if (isSelfEmail(email)) {
      referralState.delete(jid);
      return { handled: true, reply: 'That\'s your own email! Try inviting someone else.' };
    }
    if (isAlreadyReferred(email)) {
      referralState.delete(jid);
      return { handled: true, reply: 'That email has already been referred.' };
    }

    const friendName = email.split('@')[0].replace(/[._]/g, ' ').replace(/\d+/g, '').trim();
    const capitalizedFriend = friendName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    state.stage = 'confirm';
    state.friendName = capitalizedFriend || 'there';
    state.email = email;
    referralState.set(jid, state);

    return { handled: true, reply: `Send invite to *${state.friendName}* (${email})?\n\nReply *yes* to send or *cancel* to stop.` };
  }

  // Stage: confirm — user says yes or cancel
  if (state.stage === 'confirm') {
    if (!/^(yes|y|send|confirm|ok)$/i.test(trimmed)) {
      return { handled: true, reply: 'Reply *yes* to send or *cancel* to stop.' };
    }

    const email = state.email;
    const friendName = state.friendName || 'there';
    const senderName = state.senderName || 'A friend';
    referralState.delete(jid);

    // Generate invite code via Cloudflare Worker API
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

    const emailBody = `Hey ${friendName},\n\nYou're Invited! ${senderName} has been using Outdoors and you get to be one of the first users.\n\n$100 in free usage thanks to OpenAI <3\n\nOutdoors is a personal AI assistant that works through WhatsApp — it can send emails, manage your calendar, build websites, do research, and way more.${inviteCode ? `\n\nYour invite code: ${inviteCode}` : ''}\n\nGet started: ${inviteUrl}`;

    const emailPrompt = `Send an email to ${email} with subject "You're Invited to Outdoors" and body:\n\n${emailBody}\n\nUse send_gmail_message with user_google_email="${config.googleEmail}". Send it now.`;
    executePrompt(emailPrompt, { processKey: 'system:refer', onProgress: () => {} }).catch(() => {});

    // Grant quota immediately
    if (!config.referrals) config.referrals = [];
    if (!config.referrals.includes(email)) {
      config.referrals.push(email);
    }
    if (!config.pendingReferrals) config.pendingReferrals = [];
    config.pendingReferrals.push(email);
    config.referralBonus = (config.referralBonus || 0) + REFERRAL_BONUS;
    config.referralBonusDate = today();
    saveConfig(config);

    const status = getQuotaStatus();

    // Bounce check after 45s
    setTimeout(async () => {
      try {
        const bounceCheckPrompt = `Search Gmail for emails from mailer-daemon@googlemail.com received in the last 2 minutes. Check if any mention "${email}" as an undeliverable address. Respond with ONLY the word "BOUNCED" if you find a delivery failure, or ONLY "DELIVERED" if no bounce found.`;
        const result = await executePrompt(bounceCheckPrompt, { processKey: 'system:bounce-check', onProgress: () => {} });
        const bounced = (result.response || '').trim().toUpperCase().includes('BOUNCED');

        config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== email);

        if (bounced) {
          config.referrals = (config.referrals || []).filter(e => e !== email);
          if (config.referralBonusDate === today()) {
            config.referralBonus = Math.max(0, (config.referralBonus || 0) - REFERRAL_BONUS);
          }
          saveConfig(config);
          if (killProcessFn) try { killProcessFn(); } catch {}
          replyFn(`That email (${email}) doesn't exist — the referral has been revoked. Please invite a real Rice email to get it back.`);
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
      reply: `Invite sent to ${friendName}! Your daily limit is now ${status.dailyQuota} messages (${status.remaining} remaining today). I'll verify the email in the background.`,
    };
  }

  // Stage: searching — shouldn't get here, but handle gracefully
  if (state.stage === 'searching') {
    return { handled: true, reply: 'Still looking up contacts... one moment.' };
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
