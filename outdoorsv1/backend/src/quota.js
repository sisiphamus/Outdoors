// Message quota — daily allowance that grows with referrals.
// 30 messages on first day, then 10/day base + 5/day per referral.
import { config, saveConfig } from './config.js';

const FIRST_DAY_ALLOWANCE = 30;
const DAILY_BASE = 10;
const DAILY_PER_REFERRAL = 5;

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

export function addReferral(email) {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith('@rice.edu')) {
    return { ok: false, error: 'Must be a @rice.edu email address.' };
  }
  if (!config.referrals) config.referrals = [];
  if (config.referrals.includes(normalized)) {
    return { ok: false, error: 'That email has already been referred.' };
  }
  config.referrals.push(normalized);
  saveConfig(config);
  const status = getQuotaStatus();
  return { ok: true, remaining: status.remaining, dailyQuota: status.dailyQuota };
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
