// Direct Gmail API helper: send emails and search directory without Codex.
// Uses the OAuth credentials from ~/.google_workspace_mcp/credentials/

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import https from 'https';

const CREDS_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.google_workspace_mcp', 'credentials');

function getCredentials(email) {
  const credPath = join(CREDS_DIR, `${email}.json`);
  if (existsSync(credPath)) return JSON.parse(readFileSync(credPath, 'utf-8'));
  // Try any credential file
  if (existsSync(CREDS_DIR)) {
    const files = readdirSync(CREDS_DIR).filter(f => f.endsWith('.json'));
    if (files.length > 0) return JSON.parse(readFileSync(join(CREDS_DIR, files[0]), 'utf-8'));
  }
  return null;
}

function refreshToken(creds) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error(parsed.error_description || 'Token refresh failed'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function apiRequest(method, url, token, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = { Authorization: `Bearer ${token}` };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(parsed, { method, headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

// Send an email via Gmail API (no Codex needed)
export async function sendEmail({ from, to, subject, body }) {
  const creds = getCredentials(from);
  if (!creds) throw new Error('No credentials found for ' + from);
  const token = await refreshToken(creds);

  // Build RFC 2822 message
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=UTF-8`,
    '',
    body,
  ].join('\r\n');

  // Base64url encode
  const encoded = Buffer.from(message).toString('base64url');

  const result = await apiRequest('POST',
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
    token,
    JSON.stringify({ raw: encoded })
  );

  if (result.status === 200) return { ok: true, messageId: result.data.id };
  throw new Error(`Gmail API error ${result.status}: ${JSON.stringify(result.data)}`);
}

// Search for bounce notifications
export async function checkBounce(from, recipientEmail) {
  const creds = getCredentials(from);
  if (!creds) return false;
  const token = await refreshToken(creds);

  const query = encodeURIComponent(`from:mailer-daemon@googlemail.com newer_than:5m ${recipientEmail}`);
  const result = await apiRequest('GET',
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=1`,
    token
  );

  return result.status === 200 && (result.data.resultSizeEstimate || 0) > 0;
}

// Search Rice directory (Other Contacts) for a person
export async function searchDirectory(from, query) {
  const creds = getCredentials(from);
  if (!creds) return [];
  const token = await refreshToken(creds);

  const q = encodeURIComponent(query);
  const result = await apiRequest('GET',
    `https://people.googleapis.com/v1/otherContacts:search?query=${q}&readMask=names,emailAddresses&pageSize=5`,
    token
  );

  if (result.status !== 200) return [];
  const results = result.data.results || [];
  return results.map(r => {
    const person = r.person || {};
    const name = person.names?.[0]?.displayName || '';
    const email = person.emailAddresses?.[0]?.value || '';
    return { name, email };
  }).filter(c => c.email);
}
