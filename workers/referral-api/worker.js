// Outdoors Referral System — Cloudflare Worker
// KV keys:
//   invite:{code}  → { createdBy, claimedBy, downloadKey, status, createdAt, claimedAt }
//   key:{key}       → { email, inviteCode, activated, activatedAt, createdAt }
//   user:{key}:invite → current active invite code for this user

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function randomCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (const byte of arr) result += chars[byte % chars.length];
  return result;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── POST /api/claim-invite ─────────────────────────────────
    if (path === '/api/claim-invite' && request.method === 'POST') {
      const { inviteCode, email } = await request.json();
      if (!inviteCode || !email) return json({ error: 'Missing inviteCode or email' }, 400);

      const invite = await env.KV.get(`invite:${inviteCode}`, 'json');
      if (!invite) return json({ error: 'Invalid invite code' }, 400);
      if (invite.status === 'claimed') return json({ error: 'This invite has already been used' }, 400);

      const downloadKey = randomCode(12);

      // Mark invite as claimed
      invite.status = 'claimed';
      invite.claimedBy = email;
      invite.downloadKey = downloadKey;
      invite.claimedAt = new Date().toISOString();
      await env.KV.put(`invite:${inviteCode}`, JSON.stringify(invite));

      // Create download key entry
      await env.KV.put(`key:${downloadKey}`, JSON.stringify({
        email,
        inviteCode,
        activated: false,
        createdAt: new Date().toISOString(),
      }));

      // Clear the creator's active invite pointer (it's now claimed)
      if (invite.createdBy) {
        await env.KV.delete(`user:${invite.createdBy}:invite`);
      }

      return json({ downloadKey });
    }

    // ── POST /api/validate-key ─────────────────────────────────
    if (path === '/api/validate-key' && request.method === 'POST') {
      const { downloadKey } = await request.json();
      if (!downloadKey) return json({ valid: false }, 400);

      const entry = await env.KV.get(`key:${downloadKey}`, 'json');
      if (!entry) return json({ valid: false });

      // Mark as activated (idempotent)
      if (!entry.activated) {
        entry.activated = true;
        entry.activatedAt = new Date().toISOString();
        await env.KV.put(`key:${downloadKey}`, JSON.stringify(entry));
      }

      return json({ valid: true, email: entry.email });
    }

    // ── POST /api/create-invite ────────────────────────────────
    if (path === '/api/create-invite' && request.method === 'POST') {
      const { downloadKey } = await request.json();
      if (!downloadKey) return json({ error: 'Missing downloadKey' }, 400);

      // Verify the user is activated
      const user = await env.KV.get(`key:${downloadKey}`, 'json');
      if (!user || !user.activated) return json({ error: 'Invalid or inactive key' }, 403);

      // Check if they already have an unclaimed invite
      const existingCode = await env.KV.get(`user:${downloadKey}:invite`);
      if (existingCode) {
        const existing = await env.KV.get(`invite:${existingCode}`, 'json');
        if (existing && existing.status === 'unclaimed') {
          const inviteUrl = `${env.SITE_URL}/invite/${existingCode}`;
          return json({ inviteCode: existingCode, inviteUrl });
        }
      }

      // Generate new invite
      const inviteCode = randomCode(8);
      await env.KV.put(`invite:${inviteCode}`, JSON.stringify({
        createdBy: downloadKey,
        status: 'unclaimed',
        createdAt: new Date().toISOString(),
      }));

      // Track as user's current active invite
      await env.KV.put(`user:${downloadKey}:invite`, inviteCode);

      const inviteUrl = `${env.SITE_URL}/invite/${inviteCode}`;
      return json({ inviteCode, inviteUrl });
    }

    // ── GET /api/invite-status/:code ───────────────────────────
    if (path.startsWith('/api/invite-status/') && request.method === 'GET') {
      const code = path.split('/').pop();
      const invite = await env.KV.get(`invite:${code}`, 'json');
      if (!invite) return json({ error: 'Not found' }, 404);
      return json({ status: invite.status });
    }

    // ── POST /api/admin/seed ───────────────────────────────────
    // Create initial invite codes (protected by secret)
    if (path === '/api/admin/seed' && request.method === 'POST') {
      const secret = request.headers.get('X-Admin-Secret');
      if (secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);

      const { count = 1 } = await request.json().catch(() => ({}));
      const codes = [];
      for (let i = 0; i < Math.min(count, 50); i++) {
        const code = randomCode(8);
        await env.KV.put(`invite:${code}`, JSON.stringify({
          createdBy: 'admin',
          status: 'unclaimed',
          createdAt: new Date().toISOString(),
        }));
        codes.push({ code, url: `${env.SITE_URL}/invite/${code}` });
      }
      return json({ codes });
    }

    return json({ error: 'Not found' }, 404);
  },
};
