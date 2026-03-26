import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'src', 'index.js');

// Read port from config (same as the server does)
let port = 3847;
try {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));
  if (cfg.port) port = cfg.port;
} catch {
  // No config.json — use default from config.js
}

console.log(`Starting server (expecting port ${port})...`);
const server = spawn('node', [serverPath], {
  cwd: join(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (d) => { serverOutput += d.toString(); });
server.stderr.on('data', (d) => { serverOutput += d.toString(); });

async function test(label, url, expect404 = false) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    const ok = expect404 ? res.status === 404 : res.status < 400;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label} (HTTP ${res.status}, ${text.length} bytes)`);
    return { ok, status: res.status, length: text.length, text };
  } catch (e) {
    console.log(`  FAIL ${label}: ${e.message}`);
    return { ok: false };
  }
}

// Wait for server to signal readiness (looks for "API: http://" in output)
function waitForReady(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Server startup timed out')), timeoutMs);
    const check = setInterval(() => {
      if (serverOutput.includes('API: http://') || serverOutput.includes('Outdoors Bot')) {
        clearInterval(check);
        clearTimeout(deadline);
        // Small extra delay for Express to be fully ready
        setTimeout(resolve, 500);
      }
    }, 200);
    server.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(deadline);
      reject(new Error(`Server exited with code ${code}`));
    });
  });
}

try {
  await waitForReady();
} catch (err) {
  console.error('\nServer failed to start:', err.message);
  console.error('\nServer output:', serverOutput);
  server.kill();
  process.exit(1);
}

console.log('\nServer started successfully.');
console.log('\nRunning endpoint tests:');

const base = `http://localhost:${port}`;
const results = [];

// Core API endpoints (these are what matter for backend health)
results.push(await test('Socket.IO client', `${base}/socket.io/socket.io.js`));
results.push(await test('/api/status', `${base}/api/status`));
results.push(await test('/api/config', `${base}/api/config`));

// QR endpoint: 404 is expected when no QR has been generated yet
results.push(await test('/api/qr (404 expected)', `${base}/api/qr`, true));

// Verify API response content
try {
  const status = await fetch(`${base}/api/status`).then(r => r.json());
  console.log(`\n  Connection status: ${status.status}`);
  console.log(`  Has WhatsApp status: ${!!status.status}`);
} catch (err) {
  console.log(`\n  Failed to parse /api/status: ${err.message}`);
}

try {
  const cfg = await fetch(`${base}/api/config`).then(r => r.json());
  console.log(`  Config has port: ${!!cfg.port}`);
} catch (err) {
  console.log(`  Failed to parse /api/config: ${err.message}`);
}

const passed = results.filter(r => r.ok).length;
console.log(`\nResults: ${passed}/${results.length} endpoints OK`);

server.kill();
process.exit(passed === results.length ? 0 : 1);
