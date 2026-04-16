// Smoke test — verifies the proxy path works end-to-end.
// Run with:  node src/agent/smoke-test.js
//
// Expected output: the device JWT is obtained, a tiny Claude request is
// sent through the proxy, and the response text is printed. If the proxy
// isn't deployed yet, this fails fast with a clear error.

import { getDeviceToken, invalidateDeviceToken } from './device-token.js';
import { createMessage, getQuota } from './anthropic-client.js';

async function main() {
  console.log('── Step 1: device token ──');
  invalidateDeviceToken(); // force a fresh issue for the test
  const token = await getDeviceToken();
  console.log('  token prefix:', token.slice(0, 24) + '…');

  console.log('\n── Step 2: tiny message ──');
  const resp = await createMessage({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
  });
  const text = resp.content.filter(c => c.type === 'text').map(c => c.text).join('');
  console.log('  reply:', text);
  console.log('  usage:', resp.usage);

  console.log('\n── Step 3: quota check ──');
  const q = await getQuota();
  console.log('  quota:', JSON.stringify(q, null, 2));

  console.log('\n✓ Proxy path works end-to-end.');
}

main().catch(err => {
  console.error('✗ Smoke test failed:', err.message);
  process.exit(1);
});
