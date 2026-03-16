// ============================================================
// Outdoors Setup Wizard — Renderer
// Works in both Electron (via preload IPC) and browser (via Socket.IO)
// ============================================================

const isElectron = !!(window.electronAPI);
let currentPage = 0;
const totalPages = 7;

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
  if (currentPage === 3) runBrowserPage();
  if (currentPage === 4) runGooglePage();
  if (currentPage === 5) runTelegramPage();
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
    // Non-Electron: skip install + auth pages, go straight to browser setup
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
    return;
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

  // Step 3: Python ML deps (non-blocking)
  setInstallItemState('install-python', 'active');
  setInstallStatus('Checking Python packages...');
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

document.getElementById('btn-auth')?.addEventListener('click', async () => {
  showAuthState('auth-waiting');

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
    showAuthState('auth-needed');
    const hint = document.querySelector('#auth-needed .auth-hint');
    if (hint) hint.textContent = 'Auth timed out — try again.';
  }
});

document.getElementById('btn-skip-auth')?.addEventListener('click', () => {
  if (isElectron) window.electronAPI.cancelAuthPoll?.();
  nextPage();
});
document.getElementById('btn-skip-auth-waiting')?.addEventListener('click', () => {
  if (isElectron) window.electronAPI.cancelAuthPoll?.();
  nextPage();
});

// ---------------------------------------------------------------------------
// Page 4: Browser Setup (multi-step: detect → profile select → copy → launch → sign-in)
// ---------------------------------------------------------------------------

let browserSetupDone = false;
let detectedExePath = null;
let authPollTimer = null;

function showBrowserSection(id) {
  const sections = ['browser-detect-btn', 'browser-detecting', 'browser-not-found', 'browser-profiles',
    'browser-copying', 'browser-launching', 'browser-signin', 'browser-success', 'browser-error'];
  sections.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('hidden');
  });
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

async function runBrowserPage() {
  if (browserSetupDone) return;
  // Page is ready — buttons are wired below
}

async function handleSetupChrome() {
  if (!isElectron) return;

  showBrowserSection('browser-detecting');

  try {
    const result = await window.electronAPI.detectBrowser();

    if (!result.found) {
      showBrowserSection('browser-not-found');
      return;
    }

    detectedExePath = result.exePath;

    if (result.profiles.length <= 1) {
      // Auto-select the only profile (or Default if none)
      const selectedProfile = result.profiles.length === 1 ? result.profiles[0].directory : 'Default';
      await createAndLaunch(selectedProfile);
    } else {
      // Show profile selector dropdown
      const select = document.getElementById('profile-select');
      select.innerHTML = '';
      result.profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.directory;
        opt.textContent = p.email ? `${p.email} (${p.directory})` : `${p.name} (${p.directory})`;
        select.appendChild(opt);
      });
      showBrowserSection('browser-profiles');
    }
  } catch (err) {
    showBrowserError('Failed to detect Chrome: ' + err.message);
  }
}

async function handleConfirmProfile() {
  const select = document.getElementById('profile-select');
  const selectedProfile = select.value;
  await createAndLaunch(selectedProfile);
}

async function createAndLaunch(selectedProfile) {
  showBrowserSection('browser-copying');

  try {
    // Create automation profile
    const createResult = await window.electronAPI.createAutomationProfile({
      selectedProfile,
      exePath: detectedExePath,
    });

    if (!createResult.ok) {
      showBrowserError('Failed to create profile: ' + (createResult.error || 'unknown error'));
      return;
    }

    // Launch Chrome on sign-in page
    showBrowserSection('browser-launching');
    const launchResult = await window.electronAPI.launchAutomationChrome(detectedExePath);

    if (!launchResult.ok) {
      showBrowserError('Failed to launch Chrome: ' + (launchResult.error || 'unknown error'));
      return;
    }

    // Start polling for sign-in
    showBrowserSection('browser-signin');
    startAuthPolling();
  } catch (err) {
    showBrowserError('Error: ' + err.message);
  }
}

function startAuthPolling() {
  if (authPollTimer) clearInterval(authPollTimer);

  authPollTimer = setInterval(async () => {
    try {
      const result = await window.electronAPI.checkBrowserAuth();
      if (result.signedIn) {
        clearInterval(authPollTimer);
        authPollTimer = null;
        browserSetupDone = true;
        const emailEl = document.getElementById('browser-email');
        if (emailEl) emailEl.textContent = result.email ? `(${result.email})` : '';
        showBrowserSection('browser-success');
        await delay(1500);
        nextPage();
      }
    } catch { /* keep polling */ }
  }, 2000);
}

function showBrowserError(msg) {
  const errorText = document.getElementById('browser-error-text');
  if (errorText) errorText.textContent = msg;
  showBrowserSection('browser-error');
}

document.getElementById('btn-setup-chrome')?.addEventListener('click', handleSetupChrome);
document.getElementById('btn-confirm-profile')?.addEventListener('click', handleConfirmProfile);
document.getElementById('btn-retry-browser')?.addEventListener('click', () => {
  showBrowserSection('browser-detect-btn');
});

// ---------------------------------------------------------------------------
// Page 5: Google Account Access (workspace-mcp OAuth)
// ---------------------------------------------------------------------------

let googleSetupDone = false;

function showGoogleSection(id) {
  const sections = ['google-start', 'google-waiting', 'google-success', 'google-error', 'google-no-creds'];
  sections.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('hidden');
  });
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

async function runGooglePage() {
  if (googleSetupDone) return;
  if (!isElectron) { nextPage(); return; }

  // Check if oauth-creds.json exists
  const credsCheck = await window.electronAPI.checkGoogleCreds();
  if (!credsCheck.hasCreds) {
    showGoogleSection('google-no-creds');
    return;
  }

  // Creds exist — show the sign-in button
  showGoogleSection('google-start');
}

async function handleGoogleAuth() {
  if (!isElectron) return;

  showGoogleSection('google-waiting');
  document.getElementById('google-waiting-text').textContent = 'Starting Google sign-in...';

  try {
    const result = await window.electronAPI.startGoogleAuth();

    if (result.ok) {
      googleSetupDone = true;
      const emailEl = document.getElementById('google-email');
      if (emailEl && result.email) emailEl.textContent = `(${result.email})`;
      showGoogleSection('google-success');
      await delay(1500);
      nextPage();
    } else {
      const errorText = document.getElementById('google-error-text');
      if (errorText) errorText.textContent = result.error || 'Google sign-in failed.';
      showGoogleSection('google-error');
    }
  } catch (err) {
    const errorText = document.getElementById('google-error-text');
    if (errorText) errorText.textContent = 'Error: ' + err.message;
    showGoogleSection('google-error');
  }
}

document.getElementById('btn-google-auth')?.addEventListener('click', handleGoogleAuth);
document.getElementById('btn-retry-google')?.addEventListener('click', () => {
  showGoogleSection('google-start');
});
document.getElementById('btn-skip-google')?.addEventListener('click', () => nextPage());
document.getElementById('btn-skip-google-waiting')?.addEventListener('click', () => nextPage());
document.getElementById('btn-skip-google-error')?.addEventListener('click', () => nextPage());
document.getElementById('btn-skip-google-nocreds')?.addEventListener('click', () => nextPage());

// ---------------------------------------------------------------------------
// Page 6: WhatsApp Setup (starts backend, shows QR code inline)
// ---------------------------------------------------------------------------

let waSocket = null;
let waConnected = false;
let waSocketRetries = 0;

document.getElementById('btn-retry-wa')?.addEventListener('click', () => {
  waSocketRetries = 0;
  runTelegramPage();
});

async function runTelegramPage() {
  if (waConnected) return;

  showWaSection('wa-starting');
  setWaStartingText('Starting backend...');

  if (!isElectron) { nextPage(); return; }

  // Start the backend
  const result = await window.electronAPI.startBackend();
  if (!result.ok && !result.alreadyRunning) {
    document.getElementById('wa-error-text').textContent =
      'Backend failed to start: ' + (result.error || 'unknown error');
    showWaSection('wa-error');
    return;
  }

  setWaStartingText('Connecting to backend...');

  // Connect to backend via Socket.IO to receive QR code
  const backendUrl = await window.electronAPI.getBackendUrl();
  loadWaSocketIO(backendUrl);
}

function setWaStartingText(text) {
  const el = document.getElementById('wa-starting-text');
  if (el) el.textContent = text;
}

function loadWaSocketIO(backendUrl) {
  if (typeof io !== 'undefined') {
    connectWaSocket(backendUrl);
    return;
  }

  // Remove any previous failed script tags
  const old = document.querySelector('script[data-socketio]');
  if (old) old.remove();

  const script = document.createElement('script');
  script.setAttribute('data-socketio', '1');
  script.src = backendUrl + '/socket.io/socket.io.js';
  script.onload = () => connectWaSocket(backendUrl);
  script.onerror = () => {
    waSocketRetries++;
    if (waSocketRetries > 15) {
      document.getElementById('wa-error-text').textContent =
        'Could not connect to backend. It may still be starting up.';
      showWaSection('wa-error');
      return;
    }
    setWaStartingText('Waiting for backend to be ready... (' + waSocketRetries + ')');
    script.remove();
    setTimeout(() => loadWaSocketIO(backendUrl), 2000);
  };
  document.head.appendChild(script);
}

function connectWaSocket(backendUrl) {
  if (waSocket) {
    try { waSocket.disconnect(); } catch {}
  }

  setWaStartingText('Waiting for WhatsApp QR code...');

  waSocket = io(backendUrl, { reconnection: true, reconnectionDelay: 2000 });

  waSocket.on('qr', (dataUrl) => {
    const img = document.getElementById('wa-qr-img');
    if (img) img.src = dataUrl;
    showWaSection('wa-qr');
  });

  waSocket.on('log', (entry) => {
    if (!entry) return;
    if (entry.type === 'connected') {
      onWaConnected();
    }
    // QR can also come as a log event
    if (entry.type === 'qr' && entry.data?.dataUrl) {
      const img = document.getElementById('wa-qr-img');
      if (img) img.src = entry.data.dataUrl;
      showWaSection('wa-qr');
    }
  });

  waSocket.on('connect', () => {
    setWaStartingText('Connected to backend. Generating QR code...');
  });

  waSocket.on('connect_error', () => {
    setWaStartingText('Waiting for backend...');
  });
}

async function onWaConnected() {
  waConnected = true;
  showWaSection('wa-connected');
  await delay(1500);
  nextPage();
}

function showWaSection(id) {
  const sections = ['wa-starting', 'wa-qr', 'wa-connected', 'wa-error'];
  sections.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('hidden');
  });
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Page 6: Complete
// ---------------------------------------------------------------------------

document.getElementById('btn-close').addEventListener('click', async () => {
  if (isElectron) {
    await window.electronAPI.completeSetup();
    await window.electronAPI.openDashboard();
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
