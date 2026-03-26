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

async function test(label, url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    const ok = res.status < 400;
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

console.log('\nServer output:');
console.log(serverOutput);
console.log('\nRunning endpoint tests:');

const base = `http://localhost:${port}`;
const results = [];
results.push(await test('Dashboard HTML', `${base}/`));
results.push(await test('Socket.IO client', `${base}/socket.io/socket.io.js`));
results.push(await test('main.js', `${base}/src/main.js`));
results.push(await test('styles.css', `${base}/src/styles.css`));
results.push(await test('/api/status', `${base}/api/status`));
results.push(await test('/api/config', `${base}/api/config`));

// QR endpoint: 404 is expected when no QR has been generated yet
const qr = await test('/api/qr', `${base}/api/qr`);
console.log(`  INFO /api/qr returns 404 when no QR scanned yet (expected)`);

// Check specific content
try {
  const status = await fetch(`${base}/api/status`).then(r => r.json());
  console.log(`\n  Connection status: ${status.status}`);
} catch {}

const html = results[0]?.text || '';
console.log(`  HTML has qr-image tag: ${html.includes('id="qr-image"')}`);
console.log(`  HTML loads socket.io: ${html.includes('socket.io.js')}`);
console.log(`  HTML loads main.js: ${html.includes('src/main.js')}`);

const mainJs = results[2]?.text || '';
console.log(`  main.js has qr handler: ${mainJs.includes("socket.on('qr'")}`);
console.log(`  main.js uses img src: ${mainJs.includes('qrImage.src')}`);

const passed = results.filter(r => r.ok).length;
console.log(`\nResults: ${passed}/${results.length} endpoints OK`);

server.kill();
process.exit(passed === results.length ? 0 : 1);
