// Device token manager.
//
// On first launch, generates a random deviceId, asks the referral worker
// for a JWT, and caches both in config.json. Auto-refreshes 7 days before
// expiry. Callers just await getDeviceToken() — all the bookkeeping is
// hidden.

import { randomUUID } from 'crypto';
import { config, saveConfig } from '../config.js';

const REFERRAL_API = 'https://outdoors-referral.towneradamm.workers.dev';
const REFRESH_BEFORE_MS = 7 * 24 * 60 * 60 * 1000; // refresh 7d before expiry

let inFlight = null;

function ensureDeviceId() {
  if (!config.deviceId) {
    config.deviceId = randomUUID();
    saveConfig(config);
  }
  return config.deviceId;
}

function tokenNeedsRefresh() {
  if (!config.deviceToken || !config.deviceTokenExpiresAt) return true;
  const expiresMs = new Date(config.deviceTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return true;
  return (expiresMs - Date.now()) < REFRESH_BEFORE_MS;
}

async function requestNewToken(deviceId) {
  const res = await fetch(REFERRAL_API + '/api/issue-device-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[device-token] issue failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.token || !data.expiresAt) {
    throw new Error('[device-token] malformed response: ' + JSON.stringify(data));
  }
  return data;
}

/**
 * Returns a valid device JWT. Caches in config.json. Refreshes if near expiry.
 * Concurrent callers share the same in-flight request.
 */
export async function getDeviceToken() {
  const deviceId = ensureDeviceId();

  if (!tokenNeedsRefresh()) {
    return config.deviceToken;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { token, expiresAt } = await requestNewToken(deviceId);
      config.deviceToken = token;
      config.deviceTokenExpiresAt = expiresAt;
      saveConfig(config);
      return token;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Clears the cached token (e.g. after a 401). Next getDeviceToken() will
 * re-issue. Does NOT reset deviceId — same device, new token.
 */
export function invalidateDeviceToken() {
  config.deviceToken = null;
  config.deviceTokenExpiresAt = null;
  saveConfig(config);
}
