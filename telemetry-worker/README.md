# Chiefton Telemetry Worker

Cloudflare Worker + D1 that receives anonymous usage telemetry from Chiefton installations.

## Setup (one-time)

```bash
cd telemetry-worker

# 1. Login to Cloudflare
npx wrangler login

# 2. Create the D1 database
npx wrangler d1 create chiefton-telemetry

# 3. Copy the database_id from the output into wrangler.toml

# 4. Initialize the schema
npx wrangler d1 execute chiefton-telemetry --file=./schema.sql

# 5. Deploy
npx wrangler deploy
```

The worker will be live at `https://chiefton-telemetry.<your-subdomain>.workers.dev`

## Update the telemetry URL

After deploying, update `TELEMETRY_URL` in `chieftonv1/backend/src/telemetry.js` to point to your worker URL:

```javascript
const TELEMETRY_URL = 'https://chiefton-telemetry.<your-subdomain>.workers.dev/v1/report';
```

## View dashboard

Go to: `https://chiefton-telemetry.<your-subdomain>.workers.dev/dashboard?pw=chiefton-admin-2026`

Change the password in `src/index.js` line 5.

## What's collected

Only anonymous counts — no content, no personal data:
- Task count, duration, avg response time
- Platform split (WhatsApp vs web)
- Tool call count, cost, token usage
- Error count
