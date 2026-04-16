// Outdoors Chat Proxy — Cloudflare Worker
//
// Sits between the Outdoors desktop app and api.anthropic.com so the app
// never holds the real Anthropic API key. The app authenticates with a
// device JWT (issued by outdoors-referral), this worker verifies the JWT,
// enforces per-device quotas, and forwards the request with the real key.
//
// What this worker does NOT do:
//   - Log prompts or completions (privacy)
//   - Store conversation state (that's the app's job)
//   - Mutate request bodies beyond header rewriting
//
// KV keys:
//   quota:{deviceId}:{YYYY-MM-DD} → { inputTokens, outputTokens, costUsd }
//   global:{YYYY-MM-DD}           → { costUsd } — for kill-switch
//
// Secrets (set via `wrangler secret put`):
//   ANTHROPIC_API_KEY   — sk-ant-…
//   JWT_SECRET          — HMAC secret, shared with outdoors-referral
//
// Endpoints:
//   POST /v1/messages   — forwards to api.anthropic.com/v1/messages
//   GET  /v1/quota      — returns today's usage for the caller's device
//   GET  /health        — liveness probe

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Per-device daily caps (conservative starting values — widen after observing real usage)
const DAILY_INPUT_TOKEN_CAP = 2_000_000;
const DAILY_OUTPUT_TOKEN_CAP = 500_000;
const DAILY_COST_CAP_USD = 5.0;

// Global kill switch — if the whole service spends this much in a day, stop serving
const GLOBAL_DAILY_COST_CAP_USD = 200.0;

// Pricing per 1M tokens (keep in sync with Anthropic pricing page)
// Used for metering only; Anthropic bills us, not the proxy.
const PRICING = {
  'claude-opus-4-6':   { input: 15.0,  output: 75.0,  cacheRead: 1.50 },
  'claude-sonnet-4-6': { input: 3.0,   output: 15.0,  cacheRead: 0.30 },
  'claude-haiku-4-5':  { input: 1.0,   output: 5.0,   cacheRead: 0.10 },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── JWT verification (HS256) ────────────────────────────────────────────────

function base64UrlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const expectedSig = bytesToBase64Url(await hmacSha256(secret, `${headerB64}.${payloadB64}`));
  if (expectedSig !== sigB64) return null;

  try {
    const claims = JSON.parse(base64UrlDecode(payloadB64));
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
    if (!claims.deviceId || typeof claims.deviceId !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Quota tracking ──────────────────────────────────────────────────────────

async function getDeviceQuota(kv, deviceId) {
  const key = `quota:${deviceId}:${today()}`;
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

async function bumpDeviceQuota(kv, deviceId, delta) {
  const key = `quota:${deviceId}:${today()}`;
  const current = await getDeviceQuota(kv, deviceId);
  const next = {
    inputTokens: current.inputTokens + (delta.inputTokens || 0),
    outputTokens: current.outputTokens + (delta.outputTokens || 0),
    costUsd: current.costUsd + (delta.costUsd || 0),
  };
  // 48h TTL so yesterday's counters clean up automatically
  await kv.put(key, JSON.stringify(next), { expirationTtl: 60 * 60 * 48 });
  return next;
}

async function getGlobalCost(kv) {
  const raw = await kv.get(`global:${today()}`);
  return raw ? JSON.parse(raw).costUsd : 0;
}

async function bumpGlobalCost(kv, deltaUsd) {
  const key = `global:${today()}`;
  const current = await getGlobalCost(kv);
  await kv.put(key, JSON.stringify({ costUsd: current + deltaUsd }), { expirationTtl: 60 * 60 * 48 });
}

function computeCost(model, usage) {
  // Normalize model names: "claude-haiku-4-5-20251001" → "claude-haiku-4-5"
  const base = model.replace(/-\d{8}$/, '');
  const p = PRICING[base];
  if (!p) return 0; // unknown model — don't meter, but don't error either
  const input = (usage.input_tokens || 0) / 1_000_000 * p.input;
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1_000_000 * p.cacheRead;
  const output = (usage.output_tokens || 0) / 1_000_000 * p.output;
  return input + cacheRead + output;
}

// ── Streaming passthrough with metering ─────────────────────────────────────
//
// Anthropic SSE streams emit a final `message_delta` with `usage` info.
// We tee the stream: one copy goes to the client immediately, the other is
// parsed server-side to update quotas. The client sees no added latency.

function meteredStream(upstream, kv, deviceId, model) {
  const { readable, writable } = new TransformStream();
  const reader = upstream.body.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalUsage = null;

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        await writer.write(value);

        // Parse SSE frames to find the usage event
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const evt = JSON.parse(dataLine.slice(6));
            if (evt.type === 'message_delta' && evt.usage) {
              finalUsage = { ...(finalUsage || {}), ...evt.usage };
            } else if (evt.type === 'message_start' && evt.message?.usage) {
              finalUsage = { ...(finalUsage || {}), ...evt.message.usage };
            }
          } catch { /* skip malformed frames */ }
        }
      }
    } catch (err) {
      console.error('[stream] forwarding error:', err);
    } finally {
      await writer.close();
      if (finalUsage) {
        const cost = computeCost(model, finalUsage);
        await bumpDeviceQuota(kv, deviceId, {
          inputTokens: finalUsage.input_tokens || 0,
          outputTokens: finalUsage.output_tokens || 0,
          costUsd: cost,
        });
        await bumpGlobalCost(kv, cost);
      }
    }
  })();

  return readable;
}

// ── Main handler ────────────────────────────────────────────────────────────

async function handleMessages(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = await verifyJWT(token, env.JWT_SECRET);
  if (!claims) return json({ error: 'Unauthorized' }, 401);

  // Global kill switch
  const globalCost = await getGlobalCost(env.QUOTA_KV);
  if (globalCost >= GLOBAL_DAILY_COST_CAP_USD) {
    return json({ error: 'Service temporarily unavailable (daily budget reached)' }, 503);
  }

  // Per-device quota
  const quota = await getDeviceQuota(env.QUOTA_KV, claims.deviceId);
  if (quota.inputTokens >= DAILY_INPUT_TOKEN_CAP
      || quota.outputTokens >= DAILY_OUTPUT_TOKEN_CAP
      || quota.costUsd >= DAILY_COST_CAP_USD) {
    return json({
      error: 'Daily quota exceeded',
      resetsAt: `${today()}T23:59:59Z`,
      usage: quota,
    }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const model = body.model || 'claude-opus-4-6';
  const isStreaming = !!body.stream;

  const upstream = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': req.headers.get('anthropic-version') || '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    // Forward error status + body directly so the client sees what Anthropic said
    const errBody = await upstream.text();
    return new Response(errBody, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json', ...CORS },
    });
  }

  if (isStreaming) {
    return new Response(meteredStream(upstream, env.QUOTA_KV, claims.deviceId, model), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...CORS,
      },
    });
  }

  // Non-streaming: read full body, meter, return
  const respBody = await upstream.json();
  if (respBody.usage) {
    const cost = computeCost(model, respBody.usage);
    await bumpDeviceQuota(env.QUOTA_KV, claims.deviceId, {
      inputTokens: respBody.usage.input_tokens || 0,
      outputTokens: respBody.usage.output_tokens || 0,
      costUsd: cost,
    });
    await bumpGlobalCost(env.QUOTA_KV, cost);
  }
  return json(respBody);
}

async function handleQuota(req, env) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = await verifyJWT(token, env.JWT_SECRET);
  if (!claims) return json({ error: 'Unauthorized' }, 401);

  const quota = await getDeviceQuota(env.QUOTA_KV, claims.deviceId);
  return json({
    deviceId: claims.deviceId,
    date: today(),
    usage: quota,
    caps: {
      inputTokens: DAILY_INPUT_TOKEN_CAP,
      outputTokens: DAILY_OUTPUT_TOKEN_CAP,
      costUsd: DAILY_COST_CAP_USD,
    },
  });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      return handleMessages(req, env);
    }

    if (url.pathname === '/v1/quota' && req.method === 'GET') {
      return handleQuota(req, env);
    }

    return json({ error: 'Not found' }, 404);
  },
};
