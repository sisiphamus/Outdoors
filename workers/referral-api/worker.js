// Outdoors Invite System — Cloudflare Worker
// The download page IS the gate. No invite link = no download.
// Each code is single-use. Once someone downloads, the code is burned.
//
// KV keys:
//   invite:{code} → { createdBy, status, createdAt, claimedAt, claimedBy }

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

// GitHub Release download URLs — update these when new versions are published
const DOWNLOADS = {
  windows: 'https://github.com/sisiphamus/Outdoors/releases/latest/download/Outdoors-Setup.exe',
  mac: 'https://github.com/sisiphamus/Outdoors/releases/latest/download/Outdoors.dmg',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── GET / — Landing page (no invite) ───────────────────────
    if (path === '/' || path === '') {
      return new Response(renderNoInvitePage(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // ── POST /api/create-invite — App generates an invite link ─
    if (path === '/api/create-invite' && request.method === 'POST') {
      const { userId } = await request.json().catch(() => ({}));
      if (!userId) return json({ error: 'Missing userId' }, 400);

      // Check if user already has an unclaimed invite
      const existingCode = await env.KV.get(`user:${userId}:invite`);
      if (existingCode) {
        const existing = await env.KV.get(`invite:${existingCode}`, 'json');
        if (existing && existing.status === 'unclaimed') {
          return json({ inviteCode: existingCode, inviteUrl: `${env.SITE_URL}/${existingCode}` });
        }
      }

      // Generate new invite
      const code = randomCode(8);
      await env.KV.put(`invite:${code}`, JSON.stringify({
        createdBy: userId,
        status: 'unclaimed',
        createdAt: new Date().toISOString(),
      }));
      await env.KV.put(`user:${userId}:invite`, code);

      return json({ inviteCode: code, inviteUrl: `${env.SITE_URL}/${code}` });
    }

    // ── POST /api/admin/seed — Create invite codes (admin only) ─
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
        codes.push({ code, url: `${env.SITE_URL}/${code}` });
      }
      return json({ codes });
    }

    // ── POST /api/claim — Claim invite, generate key, mark as used ─
    if (path === '/api/claim' && request.method === 'POST') {
      const { code } = await request.json().catch(() => ({}));
      if (!code) return json({ error: 'Missing code' }, 400);

      const invite = await env.KV.get(`invite:${code}`, 'json');
      if (!invite) return json({ error: 'Invalid code' }, 404);
      if (invite.status === 'claimed') {
        // Already claimed — return existing key if stored
        return json({ error: 'Already used', key: invite.key || null });
      }

      // Mark as claimed — the invite code itself becomes the user's key
      invite.status = 'claimed';
      invite.claimedAt = new Date().toISOString();
      await env.KV.put(`invite:${code}`, JSON.stringify(invite));

      // Store the code as a valid key (so validate-key works for app re-validation)
      await env.KV.put(`key:${code}`, JSON.stringify({
        inviteCode: code,
        createdAt: new Date().toISOString(),
      }));

      // Clear creator's active invite pointer
      if (invite.createdBy && invite.createdBy !== 'admin') {
        await env.KV.delete(`user:${invite.createdBy}:invite`);
      }

      return json({ ok: true });
    }

    // ── POST /api/validate-key — App checks key on startup ─
    if (path === '/api/validate-key' && request.method === 'POST') {
      const { key } = await request.json().catch(() => ({}));
      if (!key) return json({ valid: false });

      // Admin master key always valid
      if (key === 'ADMIN-MASTER-KEY') return json({ valid: true });

      const entry = await env.KV.get(`key:${key}`, 'json');
      return json({ valid: !!entry });
    }

    // ── GET /:code — Invite page (the main gate) ──────────────
    const code = path.slice(1); // remove leading /
    if (code && !code.includes('/')) {
      const invite = await env.KV.get(`invite:${code}`, 'json');

      if (!invite) {
        return new Response(renderNoInvitePage(), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      if (invite.status === 'claimed') {
        return new Response(renderUsedPage(), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // Claim the invite and generate key on page load (server-side)
      const key = randomCode(12);
      invite.status = 'claimed';
      invite.claimedAt = new Date().toISOString();
      invite.key = key;
      await env.KV.put(`invite:${code}`, JSON.stringify(invite));
      await env.KV.put(`key:${key}`, JSON.stringify({ inviteCode: code, createdAt: new Date().toISOString() }));
      if (invite.createdBy && invite.createdBy !== 'admin') {
        await env.KV.delete(`user:${invite.createdBy}:invite`);
      }

      return new Response(renderDownloadPage(key), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ── HTML Pages ─────────────────────────────────────────────────

function renderNoInvitePage() {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Outdoors</title>
${pageStyles()}
</head><body>
<div class="container">
  <h1>Outdoors</h1>
  <p class="subtitle">Your personal AI assistant</p>
  <div class="card">
    <h2>You need an invite</h2>
    <p>Outdoors is invite-only right now. Find someone who already has it and ask them to share their invite link with you.</p>
  </div>
  <p class="footer">$100 in free usage thanks to OpenAI</p>
</div>
</body></html>`;
}

function renderUsedPage() {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Outdoors — Invite Used</title>
${pageStyles()}
</head><body>
<div class="container">
  <h1>Outdoors</h1>
  <p class="subtitle">Your personal AI assistant</p>
  <div class="card">
    <h2>This invite has been used</h2>
    <p>Each invite link can only be used once. Ask your friend to generate a new one from their Outdoors app.</p>
  </div>
</div>
</body></html>`;
}

function renderDownloadPage(key) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Outdoors — You're Invited!</title>
${pageStyles()}
</head><body>
<div class="container">
  <h1>Outdoors</h1>
  <p class="subtitle">Your personal AI assistant</p>
  <div class="card">
    <h2>You're Invited!</h2>
    <p>Someone shared Outdoors with you. You're one of the first users.</p>
    <p style="margin:16px 0;font-size:14px;color:#888;">$100 in free usage thanks to OpenAI &#x2764;</p>

    <div style="background:#111;border:1px solid #333;border-radius:8px;padding:20px;text-align:center;margin:20px 0">
      <p style="color:#888;font-size:13px;margin-bottom:8px">Your invite key (enter this in the app after installing):</p>
      <p id="key-display" style="font-size:24px;font-weight:700;letter-spacing:2px;color:#fff;font-family:monospace;user-select:all">${key}</p>
      <button id="copy-btn" style="margin-top:12px;padding:8px 20px;background:#fff;color:#000;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer">Copy Key</button>
    </div>

    <div class="downloads">
      <a href="${DOWNLOADS.windows}" class="dl-btn">Download for Windows</a>
      <a href="${DOWNLOADS.mac}" class="dl-btn dl-secondary">Download for Mac</a>
    </div>
    <p class="hint">After installing, open Outdoors and paste your key to get started.</p>
  </div>
</div>
<script>
document.getElementById('copy-btn').addEventListener('click', function() {
  navigator.clipboard.writeText('${key}');
  this.textContent = 'Copied!';
  setTimeout(() => this.textContent = 'Copy Key', 2000);
});
</script>
</body></html>`;
}

function pageStyles() {
  return `<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .container { max-width: 480px; padding: 40px 24px; text-align: center; }
  h1 { font-size: 36px; font-weight: 700; color: #fff; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 16px; margin-bottom: 32px; }
  .card { background: #141414; border: 1px solid #222; border-radius: 16px; padding: 32px 24px; margin-bottom: 24px; }
  .card h2 { font-size: 22px; color: #fff; margin-bottom: 12px; }
  .card p { color: #999; font-size: 15px; line-height: 1.6; }
  .downloads { display: flex; flex-direction: column; gap: 12px; margin: 24px 0; }
  .dl-btn { display: block; padding: 14px 24px; background: #fff; color: #000; text-decoration: none; border-radius: 10px; font-size: 16px; font-weight: 600; transition: transform 0.15s, opacity 0.15s; }
  .dl-btn:hover { transform: scale(1.02); opacity: 0.9; }
  .dl-secondary { background: #222; color: #fff; }
  .hint { font-size: 13px; color: #555; margin-top: 16px; }
  .footer { color: #444; font-size: 13px; }
</style>`;
}
