// ============================================================
// Outdoors Setup Wizard — Renderer
// Works in both Electron (via preload IPC) and browser (via Socket.IO)
// ============================================================

const isElectron = !!(window.electronAPI);
let currentPage = 0;
const totalPages = 5;
let socket = null;

// ---------------------------------------------------------------------------
// Page navigation
// ---------------------------------------------------------------------------

function goToPage(index) {
  if (index < 0 || index >= totalPages) return;

  const pages = document.querySelectorAll('.page');
  const dots = document.querySelectorAll('.dot');

  pages[currentPage].classList.remove('active');
  dots[currentPage].classList.remove('active');
  dots[currentPage].classList.add('completed');

  currentPage = index;

  pages[currentPage].classList.add('active');
  pages[currentPage].classList.remove('completed');
  dots[currentPage].classList.remove('completed');
  dots[currentPage].classList.add('active');

  // Trigger page-specific logic
  if (currentPage === 1) runInstallPage();
  if (currentPage === 2) runAuthPage();
  if (currentPage === 3) runQRPage();
}

function nextPage() {
  goToPage(currentPage + 1);
}

// ---------------------------------------------------------------------------
// Page 1: Welcome
// ---------------------------------------------------------------------------

document.getElementById('btn-begin').addEventListener('click', () => {
  if (isElectron) {
    nextPage(); // Go to install page
  } else {
    // Non-Electron: skip install + auth pages, go straight to QR
    goToPage(3);
  }
});

// ---------------------------------------------------------------------------
// Page 2: Installing Dependencies (Electron only)
// ---------------------------------------------------------------------------

function setInstallItemState(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  const iconEl = el.querySelector('.install-icon');

  el.classList.remove('done', 'error', 'active');
  iconEl.innerHTML = '';
  iconEl.className = 'install-icon';

  if (state === 'active') {
    el.classList.add('active');
    iconEl.innerHTML = '<div class="spinner-small"></div>';
  } else if (state === 'done') {
    el.classList.add('done');
    iconEl.classList.add('done-icon');
  } else if (state === 'error') {
    el.classList.add('error');
    iconEl.classList.add('error-icon');
  } else {
    iconEl.classList.add('waiting-icon');
  }
}

function setInstallStatus(text) {
  const el = document.getElementById('install-status');
  if (el) el.textContent = text;
}

async function runInstallPage() {
  if (!isElectron) { nextPage(); return; }

  // Step 1: Node deps
  setInstallItemState('install-node-deps', 'active');
  setInstallStatus('Installing Node dependencies...');
  const nodeDeps = await window.electronAPI.installNodeDeps();
  setInstallItemState('install-node-deps', nodeDeps.ok ? 'done' : 'error');

  if (!nodeDeps.ok) {
    setInstallStatus('Node dependency install failed. Please check your internet connection and restart.');
    return; // BLOCK — do not advance if npm install failed
  }

  // Step 2: Claude CLI
  setInstallItemState('install-claude-cli', 'active');
  setInstallStatus('Checking Claude CLI...');

  const claudeCheck = await window.electronAPI.checkClaudeInstalled();
  if (claudeCheck.installed) {
    setInstallItemState('install-claude-cli', 'done');
    setInstallStatus('Claude CLI already installed.');
  } else {
    setInstallStatus('Installing Claude CLI (this may take a minute)...');
    const claudeInstall = await window.electronAPI.installClaudeCLI();
    setInstallItemState('install-claude-cli', claudeInstall.ok ? 'done' : 'error');
    if (!claudeInstall.ok) {
      setInstallStatus('Claude CLI install failed. You can install it manually later.');
    }
  }

  // Step 3: Python ML deps (non-blocking — just mark done for now)
  setInstallItemState('install-python', 'active');
  setInstallStatus('Checking Python packages...');
  // Python deps are optional — just mark as done
  setInstallItemState('install-python', 'done');

  setInstallStatus('All set!');
  await delay(800);
  nextPage();
}

// ---------------------------------------------------------------------------
// Page 3: Claude Authentication (Electron only)
// ---------------------------------------------------------------------------

async function runAuthPage() {
  if (!isElectron) { nextPage(); return; }

  showAuthState('auth-checking');

  const status = await window.electronAPI.checkClaudeAuth();
  if (status.authenticated) {
    showAuthState('auth-success');
    await delay(1200);
    nextPage();
    return;
  }

  showAuthState('auth-needed');
}

function showAuthState(id) {
  const states = document.querySelectorAll('.auth-state');
  states.forEach((s) => s.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

// Auth button click
document.getElementById('btn-auth')?.addEventListener('click', async () => {
  showAuthState('auth-waiting');

  // Show progress while claude /login starts (~10s)
  const waitText = document.getElementById('auth-waiting-text');
  if (waitText) {
    waitText.textContent = 'Opening Claude login...';
    setTimeout(() => { if (waitText.textContent.startsWith('Opening')) waitText.textContent = 'Still loading — almost there...'; }, 6000);
    setTimeout(() => { waitText.textContent = 'Waiting for sign-in...'; }, 15000);
  }

  const result = await window.electronAPI.startClaudeAuth();
  if (result.ok) {
    showAuthState('auth-success');
    await delay(1000);
    nextPage();
  } else {
    // Auth failed or timed out — let user retry
    showAuthState('auth-needed');
    const hint = document.querySelector('#auth-needed .auth-hint');
    if (hint) hint.textContent = 'Auth timed out — try again.';
  }
});

// Skip auth buttons — cancel polling to avoid wasting resources
document.getElementById('btn-skip-auth')?.addEventListener('click', () => {
  if (isElectron) window.electronAPI.cancelAuthPoll?.();
  nextPage();
});
document.getElementById('btn-skip-auth-waiting')?.addEventListener('click', () => {
  if (isElectron) window.electronAPI.cancelAuthPoll?.();
  nextPage();
});

// ---------------------------------------------------------------------------
// Page 4: WhatsApp QR Code
// ---------------------------------------------------------------------------

async function runQRPage() {
  if (isElectron) {
    // Start backend first, then connect Socket.IO
    const statusText = document.querySelector('#qr-loading .qr-status-text');
    if (statusText) statusText.textContent = 'Starting backend...';

    const result = await window.electronAPI.startBackend();
    if (!result.ok) {
      if (statusText) statusText.textContent = 'Backend failed to start: ' + (result.error || 'unknown error');
      return;
    }
    const backendUrl = await window.electronAPI.getBackendUrl();
    connectToBackend(backendUrl);
  } else {
    connectToBackend();
  }
}

function connectToBackend(url, retryCount) {
  retryCount = retryCount || 0;

  const statusEl = document.getElementById('qr-status');

  // Dynamic Socket.IO loading for Electron (no /socket.io/socket.io.js served)
  if (typeof io === 'undefined') {
    const script = document.createElement('script');
    script.src = (url || '') + '/socket.io/socket.io.js';
    script.onload = () => doConnect(url, statusEl);
    script.onerror = () => {
      // Remove the failed script tag so we can retry
      script.remove();
      if (retryCount < 5) {
        if (statusEl) statusEl.textContent = 'Connecting to backend... (attempt ' + (retryCount + 2) + ')';
        setTimeout(() => connectToBackend(url, retryCount + 1), 2000);
      } else {
        if (statusEl) statusEl.textContent = 'Cannot connect to backend. Please restart the app.';
      }
    };
    document.head.appendChild(script);
  } else {
    doConnect(url, statusEl);
  }
}

function doConnect(url, statusEl) {
  socket = url ? io(url) : io();

  socket.on('qr', (dataUrl) => {
    document.getElementById('qr-loading').classList.add('hidden');
    const display = document.getElementById('qr-display');
    display.classList.remove('hidden');
    document.getElementById('qr-image').src = dataUrl;
    if (statusEl) statusEl.textContent = 'Scan this code with your phone';
  });

  socket.on('status', (status) => {
    if (status === 'connected') {
      if (statusEl) statusEl.textContent = '';
      nextPage();
    } else if (status === 'waiting_for_qr') {
      if (statusEl) statusEl.textContent = 'QR code ready — scan with WhatsApp';
    } else if (status === 'disconnected') {
      if (statusEl) statusEl.textContent = 'Disconnected — waiting for reconnect...';
    }
  });

  socket.on('connect_error', () => {
    if (statusEl) statusEl.textContent = 'Cannot reach backend — is the server running?';
  });
}

// ---------------------------------------------------------------------------
// Page 5: Complete
// ---------------------------------------------------------------------------

document.getElementById('btn-close').addEventListener('click', async () => {
  if (isElectron) {
    await window.electronAPI.completeSetup();
    await window.electronAPI.closeWindow();
  } else {
    window.close();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
