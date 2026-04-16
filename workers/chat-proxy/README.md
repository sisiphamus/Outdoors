# chiefton-chat

Cloudflare Worker that proxies Chiefton app → Anthropic API. Holds the real `sk-ant-…` key so the desktop app never does.

## Setup (one time)

```bash
cd workers/chat-proxy
npx wrangler login

# Create the KV namespace for quota tracking
npx wrangler kv namespace create chiefton-chat-quota
# Paste the returned id into wrangler.toml under [[kv_namespaces]]

# Set secrets (shared JWT_SECRET must match the one in chiefton-referral)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put JWT_SECRET
```

The same `JWT_SECRET` must be set on `chiefton-referral` (the token issuer) — the proxy uses it to verify tokens the referral worker signs.

```bash
cd ../referral-api
npx wrangler secret put JWT_SECRET   # use the exact same value
```

## Deploy

```bash
cd workers/chat-proxy
npx wrangler deploy
```

Default URL: `https://chiefton-chat.<your-subdomain>.workers.dev`. The app points at `chiefton-chat.towneradamm.workers.dev`; if that changes, update `PROXY_URL` in [anthropic-client.js](../../chieftonv1/backend/src/agent/anthropic-client.js).

## Test

```bash
# Health check — no auth needed
curl https://chiefton-chat.towneradamm.workers.dev/health

# From the backend: full pipeline
cd chieftonv1/backend
node src/agent/smoke-test.js
```

## Endpoints

| Method | Path          | Auth          | Purpose                                        |
|--------|---------------|---------------|------------------------------------------------|
| GET    | /health       | none          | Liveness probe                                 |
| POST   | /v1/messages  | Bearer JWT    | Proxies to api.anthropic.com/v1/messages       |
| GET    | /v1/quota     | Bearer JWT    | Returns today's usage for the caller's device  |

## Quota model

- Per-device daily caps: 2M input tokens, 500K output tokens, $5 cost
- Global daily kill switch: $200 total spend triggers 503 for 24h
- Caps live at the top of [worker.js](./worker.js) — tune with real data

## Privacy

The worker does **not** log prompt or completion content. It logs:
- Quota counters (token counts + cost, keyed by deviceId)
- Errors from forwarding (status code only)

Nothing user-content-related lands in Cloudflare logs.
