// Message quota: daily allowance that grows with verified referrals.
// 20 messages on first day, then 10/day base + 10/day per verified referral.
import { config, saveConfig } from './config.js';
import { sendEmail, checkBounce, searchDirectory } from './gmail-api.js';

const FIRST_DAY_ALLOWANCE = 20;
const DAILY_BASE = 10;
const DAILY_PER_REFERRAL = 10;
const REFERRAL_BONUS = 20;
const BOUNCE_CHECK_DELAY_MS = 45000;
const REFERRAL_API = 'https://outdoors-referral.towneradamm.workers.dev';
// Direct GitHub Release download links — kept in the email body so recipients
// can install without needing any website landing page or invite-gated URL.
const DOWNLOAD_URL_WINDOWS = 'https://github.com/sisiphamus/Outdoors/releases/latest/download/Outdoors-Setup.exe';
const DOWNLOAD_URL_MAC = 'https://github.com/sisiphamus/Outdoors/releases/latest/download/Outdoors.dmg';

// Referral state: jid -> { stage, senderName, friendName, friendLast, email, customMessage }
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
  return config.referrals.includes(email.trim().toLowerCase());
}

function isSelfEmail(email) {
  const normalized = email.trim().toLowerCase();
  const own = (config.googleEmail || '').toLowerCase();
  if (!own) return false;
  if (normalized === own) return true;
  if (normalized.endsWith('@rice.edu') && own.endsWith('@rice.edu')) {
    const ownPrefix = own.split('@')[0].replace(/[._]/g, '').toLowerCase();
    const refPrefix = normalized.split('@')[0].replace(/[._]/g, '').toLowerCase();
    if (ownPrefix === refPrefix) return true;
  }
  return false;
}

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

export async function processReferralReply(jid, text, executePrompt, replyFn, killProcessFn) {
  const state = referralState.get(jid);
  if (!state) return null;
  const trimmed = text.trim();

  if (/^(cancel|nevermind|no|nvm|stop)$/i.test(trimmed)) {
    referralState.delete(jid);
    return { handled: true, reply: 'Cancelled. You can invite someone anytime by saying "invite".' };
  }

  // Stage: firstname
  if (state.stage === 'firstname') {
    state.friendName = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
    state.stage = 'lastname';
    referralState.set(jid, state);
    return { handled: true, reply: "What's their last name?" };
  }

  // Stage: lastname -> auto-generate email, validate, fallback to contact search
  if (state.stage === 'lastname') {
    state.friendLast = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
    const guessedEmail = `${state.friendName.toLowerCase()}.${state.friendLast.toLowerCase()}@rice.edu`;

    if (isSelfEmail(guessedEmail)) {
      referralState.delete(jid);
      return { handled: true, reply: "That's you! Try inviting someone else." };
    }
    if (isAlreadyReferred(guessedEmail)) {
      referralState.delete(jid);
      return { handled: true, reply: `${state.friendName} ${state.friendLast} has already been referred.` };
    }

    // Try the guessed email first, then verify via bounce check later
    // If the name format is unusual (e.g. hyphenated), the bounce check will catch it
    state.email = guessedEmail;
    state.stage = 'message';
    referralState.set(jid, state);
    return {
      handled: true,
      reply: `I'll send to *${guessedEmail}*. If that's wrong, say *cancel* and try again.\n\nWant to add a personal message to ${state.friendName}? Type it out, or say *send* to use the default.`,
    };
  }

  // Stage: message
  if (state.stage === 'message') {
    state.customMessage = /^send$/i.test(trimmed) ? '' : trimmed;
    state.stage = 'confirm';
    referralState.set(jid, state);

    // Build email preview
    const personalNote = state.customMessage ? `\n\n${state.senderName} says: "${state.customMessage}"` : '';
    const preview = `Here's what will be sent to *${state.friendName} ${state.friendLast}* (${state.email}):\n\n`
      + `Subject: You're Invited to Outdoors\n\n`
      + `Hey ${state.friendName},\n\n`
      + `You're Invited! ${state.senderName} has been using Outdoors and you get to be one of the first users.\n\n`
      + `$100 in free usage thanks to OpenAI <3${personalNote}\n\n`
      + `Outdoors is a personal AI assistant that works through WhatsApp. It can send emails, manage your calendar, build websites, do research, and way more.\n\n`
      + `[invite code + download link will be included]\n\n`
      + `Reply *yes* to send or *cancel* to stop.`;

    return { handled: true, reply: preview };
  }

  // Stage: confirm
  if (state.stage === 'confirm') {
    if (!/^(yes|y|send|confirm|ok)$/i.test(trimmed)) {
      return { handled: true, reply: 'Reply *yes* to send or *cancel* to stop.' };
    }

    const { email, friendName, friendLast, senderName, customMessage } = state;
    referralState.delete(jid);

    // Generate invite code — text-only, no landing-page URL
    let inviteCode = '';
    try {
      const resp = await fetch(REFERRAL_API + '/api/create-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: config.googleEmail || 'user-' + Date.now() }),
      });
      const data = await resp.json();
      if (data.inviteCode) inviteCode = data.inviteCode;
    } catch {}

    // Send email directly via Gmail API (instant, no Codex needed).
    // Email contains the code + direct GitHub Release download links.
    // No website landing page is involved — the recipient just downloads
    // and enters the code when the app asks for it on first launch.
    const personalNote = customMessage ? `\n\n${senderName} says: "${customMessage}"` : '';
    const codeBlock = inviteCode
      ? `\n\nYour invite code: ${inviteCode}\n\nDownload Outdoors:\n• Windows: ${DOWNLOAD_URL_WINDOWS}\n• Mac: ${DOWNLOAD_URL_MAC}\n\nAfter installing, open Outdoors and enter your invite code when prompted.`
      : `\n\n(Invite code generation failed — ask ${senderName} to send you a code directly.)`;
    const emailBody = `Hey ${friendName},\n\nYou're Invited! ${senderName} has been using Outdoors and you get to be one of the first users.\n\n$100 in free usage thanks to OpenAI <3${personalNote}\n\nOutdoors is a personal AI assistant that works through WhatsApp. It can send emails, manage your calendar, build websites, do research, and way more.${codeBlock}`;
    sendEmail({
      from: config.googleEmail,
      to: email,
      subject: "You're Invited to Outdoors",
      body: emailBody,
    }).catch(err => console.log('[referral] Email send failed:', err.message));

    // Grant quota immediately
    if (!config.referrals) config.referrals = [];
    if (!config.referrals.includes(email)) config.referrals.push(email);
    if (!config.pendingReferrals) config.pendingReferrals = [];
    config.pendingReferrals.push(email);
    config.referralBonus = (config.referralBonus || 0) + REFERRAL_BONUS;
    config.referralBonusDate = today();
    saveConfig(config);

    const status = getQuotaStatus();

    // Bounce check after 45s (direct Gmail API, no Codex)
    setTimeout(async () => {
      try {
        const bounced = await checkBounce(config.googleEmail, email);
        config.pendingReferrals = (config.pendingReferrals || []).filter(e => e !== email);
        if (bounced) {
          // Try looking up correct email via Rice directory (Other Contacts)
          let foundEmail = null;
          try {
            const dirResults = await searchDirectory(config.googleEmail, `${friendName} ${friendLast}`);
            const riceMatch = dirResults.find(c => c.email.endsWith('@rice.edu') && c.email !== email);
            if (riceMatch) foundEmail = riceMatch.email.toLowerCase();
          } catch {}

          if (foundEmail && !isAlreadyReferred(foundEmail) && !isSelfEmail(foundEmail)) {
            // Found correct email, resend
            config.referrals = (config.referrals || []).filter(e => e !== email);
            config.referrals.push(foundEmail);
            saveConfig(config);
            sendEmail({
              from: config.googleEmail, to: foundEmail,
              subject: "You're Invited to Outdoors", body: emailBody,
            }).catch(() => {});
            replyFn(`${email} bounced, but I found ${foundEmail} in the Rice directory. Resending the invite there!`);
          } else {
            config.referrals = (config.referrals || []).filter(e => e !== email);
            if (config.referralBonusDate === today()) {
              config.referralBonus = Math.max(0, (config.referralBonus || 0) - REFERRAL_BONUS);
            }
            saveConfig(config);
            if (killProcessFn) try { killProcessFn(); } catch {}
            replyFn(`That email (${email}) bounced. The referral has been revoked. Try again with the correct email.`);
          }
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
      reply: `Invite being sent to ${friendName} ${friendLast}! Your daily limit is now ${status.dailyQuota} messages (${status.remaining} remaining today).\nChecking if all goes well in the background.`,
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
