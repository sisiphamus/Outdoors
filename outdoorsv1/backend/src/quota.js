// Message quota — 40 messages per referral. Persists to config.json.
import { config, saveConfig } from './config.js';

const MESSAGES_PER_REFERRAL = 40;

export function getQuota() {
  const referrals = config.referrals || [];
  return MESSAGES_PER_REFERRAL * (1 + referrals.length);
}

export function getMessageCount() {
  return config.messageCount || 0;
}

export function hasQuota() {
  return getMessageCount() < getQuota();
}

export function incrementMessageCount() {
  config.messageCount = (config.messageCount || 0) + 1;
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
  const remaining = getQuota() - getMessageCount();
  return { ok: true, remaining };
}

export function getQuotaStatus() {
  return {
    used: getMessageCount(),
    total: getQuota(),
    remaining: Math.max(0, getQuota() - getMessageCount()),
    referrals: (config.referrals || []).length,
  };
}
