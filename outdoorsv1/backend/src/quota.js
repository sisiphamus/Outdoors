// Message quota — daily allowance that grows with referrals.
// 30 messages on first day, then 10/day base + 10/day per verified referral.
// Referrals require email verification (6-digit code sent via Gmail).
import { config, saveConfig } from './config.js';
import { randomInt } from 'crypto';

const FIRST_DAY_ALLOWANCE = 30;
const DAILY_BASE = 10;
const DAILY_PER_REFERRAL = 10;

// Pending verification codes: { email: { code, expires } }
const pendingVerifications = new Map();

function today() {
  return new Date().toISOString().slice(0, 10); // "2026-03-29"
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
    // New day — reset counter
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
  config.messageCount = (config.messageCount || 0) + 1; // lifetime total
  saveConfig(config);
}

// Step 1: Start referral — validate email, generate code, return it for sending
export function startReferral(email) {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith('@rice.edu')) {
    return { ok: false, error: 'Must be a @rice.edu email address.' };
  }
  if (!config.referrals) config.referrals = [];
  if (config.referrals.includes(normalized)) {
    return { ok: false, error: 'That email has already been referred.' };
  }
  const code = String(randomInt(100000, 999999));
  pendingVerifications.set(normalized, { code, expires: Date.now() + 10 * 60 * 1000 }); // 10 min
  return { ok: true, needsVerification: true, email: normalized, code };
}

// Step 2: Verify code — if correct, add to referrals
export function verifyReferral(codeInput) {
  const trimmed = String(codeInput).trim();
  for (const [email, entry] of pendingVerifications) {
    if (entry.code === trimmed) {
      if (Date.now() > entry.expires) {
        pendingVerifications.delete(email);
        return { ok: false, error: 'Code expired. Send the refer command again.' };
      }
      pendingVerifications.delete(email);
      if (!config.referrals) config.referrals = [];
      if (!config.referrals.includes(email)) {
        config.referrals.push(email);
        saveConfig(config);
      }
      const status = getQuotaStatus();
      return { ok: true, email, remaining: status.remaining, dailyQuota: status.dailyQuota };
    }
  }
  return { ok: false, error: 'Invalid code. Check the email and try again.' };
}

export function hasPendingVerification() {
  // Clean expired
  for (const [email, entry] of pendingVerifications) {
    if (Date.now() > entry.expires) pendingVerifications.delete(email);
  }
  return pendingVerifications.size > 0;
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
