// Anthropic client — wraps the official SDK but routes through the
// outdoors-chat Cloudflare Worker so the app never holds the real API key.
//
// The SDK's `baseURL` is pointed at the proxy, and `apiKey` is replaced
// with the device JWT in an Authorization: Bearer header. Proxy validates
// the JWT, enforces quota, and injects the real sk-ant-… upstream.

import Anthropic from '@anthropic-ai/sdk';
import { getDeviceToken, invalidateDeviceToken } from './device-token.js';

const PROXY_URL = 'https://outdoors-chat.towneradamm.workers.dev';

// SDK requires an apiKey; we pass a placeholder and override auth headers.
// The proxy ignores x-api-key — only Authorization: Bearer is checked.
let sdkInstance = null;

function getSDK() {
  if (sdkInstance) return sdkInstance;
  sdkInstance = new Anthropic({
    apiKey: 'via-proxy', // placeholder; real auth is the JWT below
    baseURL: PROXY_URL,
    // The SDK sets x-api-key from apiKey; we strip it via defaultHeaders
    // and add Authorization instead on every request in fetchOptions.
  });
  return sdkInstance;
}

/**
 * Call Anthropic through the proxy. Handles token fetching + one automatic
 * retry on 401 (to absorb a quietly rotated/revoked token).
 *
 * @param {object} params — any valid messages.create() params (model, messages, tools, stream, etc.)
 * @returns The response (Message object for non-streaming, async iterable for streaming)
 */
export async function createMessage(params) {
  const token = await getDeviceToken();
  const sdk = getSDK();

  try {
    return await sdk.messages.create(params, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
  } catch (err) {
    if (err?.status === 401) {
      invalidateDeviceToken();
      const fresh = await getDeviceToken();
      return await sdk.messages.create(params, {
        headers: {
          'Authorization': `Bearer ${fresh}`,
        },
      });
    }
    throw err;
  }
}

/**
 * Fetch today's quota for this device. Purely informational — the proxy
 * enforces caps server-side.
 */
export async function getQuota() {
  const token = await getDeviceToken();
  const res = await fetch(PROXY_URL + '/v1/quota', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`[quota] ${res.status}`);
  return res.json();
}
