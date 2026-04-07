// Outdoors Invite System — Cloudflare Worker
// Pure text-code flow: user A generates an 8-char code in their app,
// shares it with user B by any channel, user B enters it on first
// launch of their Outdoors install. Each code is single-use.
//
// This worker intentionally has NO coupling to the marketing website.
// It does not return download URLs or landing-page links — just codes.
//
// KV keys:
//   invite:{code}         → { createdBy, status, createdAt, claimedAt }
//   key:{code}            → { inviteCode, createdAt } — for validate-key replay
//   user:{userId}:invite  → the unclaimed code this user currently holds
//
// Endpoints:
//   POST /api/create-invite  — existing user asks for a code to share
//   POST /api/claim          — new user enters a code on first launch
//   POST /api/validate-key   — app re-validates saved key on startup
//   POST /api/admin/seed     — admin-only bulk code generation

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

    // ── GET / — Health check / plain landing (no invite gate) ──
    // Kept as a simple confirmation the worker is alive. Not linked from
    // the app or the website; only visible to anyone poking at the URL.
    if (path === '/' || path === '') {
      return new Response(
        'Outdoors invite API. Endpoints: /api/create-invite /api/claim /api/validate-key',
        { headers: { 'Content-Type': 'text/plain', ...CORS } }
      );
    }

    // ── POST /api/create-invite — existing user asks for a shareable code ─
    if (path === '/api/create-invite' && request.method === 'POST') {
      const { userId } = await request.json().catch(() => ({}));
      if (!userId) return json({ error: 'Missing userId' }, 400);

      // Reuse any outstanding unclaimed code for this user instead of
      // creating duplicates every click. If the pointer's stale (target
      // invite gone or already claimed), fall through and generate fresh.
      const existingCode = await env.KV.get(`user:${userId}:invite`);
      if (existingCode) {
        const existing = await env.KV.get(`invite:${existingCode}`, 'json');
        if (existing && existing.status === 'unclaimed') {
          return json({ inviteCode: existingCode });
        }
      }

      const code = randomCode(8);
      await env.KV.put(`invite:${code}`, JSON.stringify({
        createdBy: userId,
        status: 'unclaimed',
        createdAt: new Date().toISOString(),
      }));
      await env.KV.put(`user:${userId}:invite`, code);

      return json({ inviteCode: code });
    }

    // ── POST /api/admin/seed — bulk code generation, admin only ─
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
        codes.push(code);
      }
      return json({ codes });
    }

    // ── POST /api/claim — new user enters a code on first launch ─
    // Marks the invite as consumed and registers the same string as a
    // validate-key entry so the app can re-verify on subsequent launches.
    if (path === '/api/claim' && request.method === 'POST') {
      const { code } = await request.json().catch(() => ({}));
      if (!code) return json({ error: 'Missing code' }, 400);

      const invite = await env.KV.get(`invite:${code}`, 'json');
      if (!invite) return json({ error: 'Invalid code' }, 404);
      if (invite.status === 'claimed') {
        return json({ error: 'Already used' }, 409);
      }

      invite.status = 'claimed';
      invite.claimedAt = new Date().toISOString();
      await env.KV.put(`invite:${code}`, JSON.stringify(invite));

      // The invite code itself is the user's persistent key after claim.
      await env.KV.put(`key:${code}`, JSON.stringify({
        inviteCode: code,
        createdAt: new Date().toISOString(),
      }));

      if (invite.createdBy && invite.createdBy !== 'admin') {
        await env.KV.delete(`user:${invite.createdBy}:invite`);
      }

      return json({ ok: true });
    }

    // ── POST /api/validate-key — app re-verifies a saved key on startup ─
    if (path === '/api/validate-key' && request.method === 'POST') {
      const { key } = await request.json().catch(() => ({}));
      if (!key) return json({ valid: false });

      // Admin master key — always valid, for developer use
      if (key === 'ADMIN-MASTER-KEY') return json({ valid: true });

      const entry = await env.KV.get(`key:${key}`, 'json');
      return json({ valid: !!entry });
    }

    return json({ error: 'Not found' }, 404);
  },
};
