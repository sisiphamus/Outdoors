// ============================================================
// Outdoors Setup Wizard — Renderer
// Works in both Electron (via preload IPC) and browser (via Socket.IO)
// ============================================================

const isElectron = !!(window.electronAPI);
let currentPage = 0;
const totalPages = 7; // Key entry, welcome, deps, auth, connect, telegram, done

// Cached existing setup state — fetched once on load, used to skip configured pages
let existingSetup = null;
if (isElectron && window.electronAPI.checkExistingSetup) {
  window.electronAPI.checkExistingSetup().then(state => { existingSetup = state; }).catch(() => {});
}

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

  // Trigger page-specific logic (page 0 = key entry, page 1 = welcome)
  if (currentPage === 2) runInstallPage();
  if (currentPage === 3) runAuthPage();
  if (currentPage === 4) runConnectPage();
  if (currentPage === 5) runTelegramPage();
}

function nextPage() {
  goToPage(currentPage + 1);
}

// ---------------------------------------------------------------------------
// Page 0: Invite Key Entry
// ---------------------------------------------------------------------------

const REFERRAL_API = 'https://outdoors-referral.outdoors-rice.workers.dev';

// Skip key entry if user already has a valid key
(async () => {
  if (isElectron && window.electronAPI.getDownloadKey) {
    const existingKey = await window.electronAPI.getDownloadKey();
    if (existingKey) {
      goToPage(1); // Skip to welcome
    }
  }
})();

document.getElementById('btn-activate-key')?.addEventListener('click', async () => {
  const input = document.getElementById('download-key-input');
  const status = document.getElementById('key-status');
  const code = (input?.value || '').trim();

  if (!code) {
    if (status) { status.textContent = 'Please enter your invite code.'; status.className = 'key-status'; }
    return;
  }

  if (status) { status.textContent = 'Checking...'; status.className = 'key-status'; }

  try {
    // Try claiming the invite code
    const res = await fetch(REFERRAL_API + '/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();

    if (data.ok || data.key) {
      if (status) { status.textContent = 'Welcome to Outdoors!'; status.className = 'key-status success'; }
      if (isElectron && window.electronAPI.saveDownloadKey) {
        await window.electronAPI.saveDownloadKey(code);
      }
      setTimeout(() => goToPage(1), 500);
    } else if (data.error === 'Already used') {
      // Code was already claimed — check if this is the same user re-entering their code
      const res2 = await fetch(REFERRAL_API + '/api/validate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: code }),
      });
      const data2 = await res2.json();
      if (data2.valid) {
        if (status) { status.textContent = 'Welcome back!'; status.className = 'key-status success'; }
        if (isElectron && window.electronAPI.saveDownloadKey) {
          await window.electronAPI.saveDownloadKey(code);
        }
        setTimeout(() => goToPage(1), 500);
      } else {
        if (status) { status.textContent = 'This code has already been used by someone else.'; status.className = 'key-status'; }
      }
    } else {
      if (status) { status.textContent = data.error || 'Invalid code. Get one from someone using Outdoors.'; status.className = 'key-status'; }
    }
  } catch {
    if (status) { status.textContent = 'Could not connect. Check your internet.'; status.className = 'key-status'; }
  }
});

document.getElementById('download-key-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-activate-key')?.click();
});

// ---------------------------------------------------------------------------
// Page 1: Welcome
// ---------------------------------------------------------------------------

document.getElementById('btn-begin')?.addEventListener('click', () => {
  if (isElectron) {
    nextPage();
  } else {
    goToPage(4);
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

  // Skip if dependencies already installed (e.g. re-running wizard after update with preserved node_modules)
  if (existingSetup && existingSetup.nodeModules) {
    setInstallStatus('Dependencies already installed.');
    await delay(600);
    nextPage();
    return;
  }

  // Step 0: Install system dependencies (Node, Git, Python) if missing
  setInstallItemState('install-system-deps', 'active');
  setInstallStatus('Checking system tools...');
  const sysDeps = await window.electronAPI.installSystemDeps();

  if (!sysDeps.ok) {
    setInstallItemState('install-system-deps', 'error');
    const missing = sysDeps.missing || [];
    const names = missing.map(d => ({ node: 'Node.js', git: 'Git', python: 'Python' }[d] || d));
    setInstallStatus('Could not install: ' + names.join(', ') + '. Please install manually and restart Outdoors.');
    return;
  }

  // Show what happened
  const installed = Object.entries(sysDeps.results || {}).filter(([, v]) => v === 'installed').map(([k]) => k);
  if (installed.length > 0) {
    setInstallStatus('Installed ' + installed.join(', ') + '. Continuing setup...');
  }
  setInstallItemState('install-system-deps', 'done');

  // Step 1: npm install
  setInstallItemState('install-node-deps', 'active');
  setInstallStatus('Installing Node dependencies...');
  const nodeDeps = await window.electronAPI.installNodeDeps();
  setInstallItemState('install-node-deps', nodeDeps.ok ? 'done' : 'error');

  if (!nodeDeps.ok) {
    setInstallStatus('Node dependency install failed: ' + (nodeDeps.error || nodeDeps.output || 'unknown error'));
    return;
  }

  setInstallItemState('install-codex-cli', 'active');
  setInstallStatus('Checking Codex CLI...');

  const codexCheck = await window.electronAPI.checkCodexInstalled();
  if (codexCheck.installed) {
    setInstallItemState('install-codex-cli', 'done');
    setInstallStatus('Codex CLI already installed.');
  } else {
    setInstallStatus('Installing Codex CLI (this may take a minute)...');
    const codexInstall = await window.electronAPI.installCodexCLI();
    setInstallItemState('install-codex-cli', codexInstall.ok ? 'done' : 'error');
    if (!codexInstall.ok) {
      setInstallStatus('Codex CLI install failed. You can install it manually later.');
    }
  }

  setInstallItemState('install-python', 'active');
  setInstallStatus('Checking Python packages...');

  // Install uvx + pre-cache workspace-mcp silently
  const uvxCheck = await window.electronAPI.checkUvxInstalled();
  if (!uvxCheck.installed) {
    await window.electronAPI.installUvx();
  }
  // Pre-download workspace-mcp so the auth step doesn't have to wait
  await window.electronAPI.precacheWorkspaceMcp();

  // Install ML dependencies (numpy, scipy) for the local classifier
  if (window.electronAPI.installMlDeps) {
    await window.electronAPI.installMlDeps().catch(() => {});
  }

  // Download whisper.cpp + model in background (for voice message transcription)
  window.electronAPI.installWhisper().catch(() => {});

  setInstallItemState('install-python', 'done');

  setInstallStatus('All set!');
  await delay(800);
  nextPage();
}

// ---------------------------------------------------------------------------
// Page 3: Codex Authentication (Electron only)
// ---------------------------------------------------------------------------

async function runAuthPage() {
  if (!isElectron) { nextPage(); return; }

  showAuthState('auth-checking');

  const status = await window.electronAPI.checkCodexAuth();
  if (status.authenticated) {
    showAuthState('auth-success');
    await delay(1200);
    nextPage();
    return;
  }

  // Show student / non-student choice
  showAuthState('auth-choice');
}

function showAuthState(id) {
  const states = document.querySelectorAll('.auth-state');
  states.forEach((s) => s.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

// Student path — show student signup page
document.getElementById('btn-student')?.addEventListener('click', () => {
  showAuthState('auth-student-signup');
});

// Non-student path — go straight to sign in
document.getElementById('btn-non-student')?.addEventListener('click', () => {
  showAuthState('auth-signup');
});

// Open Codex student signup page in browser
document.getElementById('btn-codex-signup')?.addEventListener('click', () => {
  window.electronAPI.openExternal('https://chatgpt.com/codex/offers/students');
});

// Sign in to Codex (from any path)
async function doCodexLogin() {
  showAuthState('auth-waiting');

  const waitText = document.getElementById('auth-waiting-text');
  if (waitText) {
    waitText.textContent = 'Opening Codex login...';
    setTimeout(() => { if (waitText.textContent.startsWith('Opening')) waitText.textContent = 'Still loading — almost there...'; }, 6000);
    setTimeout(() => { waitText.textContent = 'Waiting for sign-in...'; }, 15000);
  }

  const result = await window.electronAPI.startCodexAuth();
  if (result.ok) {
    showAuthState('auth-success');
    await delay(1000);
    nextPage();
  } else {
    showAuthState('auth-needed');
    const hint = document.querySelector('#auth-needed .auth-hint');
    if (hint) hint.textContent = 'Auth timed out — try again.';
  }
}

document.getElementById('btn-auth')?.addEventListener('click', doCodexLogin);
document.getElementById('btn-auth-direct')?.addEventListener('click', doCodexLogin);
document.getElementById('btn-auth-retry')?.addEventListener('click', doCodexLogin);

document.getElementById('btn-skip-auth')?.addEventListener('click', () => {
  if (isElectron) window.electronAPI.cancelAuthPoll?.();
  nextPage();
});
document.getElementById('btn-skip-auth-waiting')?.addEventListener('click', () => {
  if (isElectron) window.electronAPI.cancelAuthPoll?.();
  nextPage();
});

// ---------------------------------------------------------------------------
// Page 4: Connect (Browser + Google merged into one step)
// ---------------------------------------------------------------------------

let connectDone = false;
let detectedExePath = null;
let selectedGoogleServices = [];

function showConnectSection(id) {
  const sections = [
    'connect-start', 'connect-detecting', 'connect-not-found',
    'connect-profiles', 'connect-services', 'connect-copying',
    'connect-waiting', 'connect-success', 'connect-error',
    'connect-onboarding', 'connect-no-creds',
  ];
  sections.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('hidden');
  });
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function getSelectedServices() {
  const always = ['gmail', 'calendar', 'contacts'];
  const checked = Array.from(document.querySelectorAll('#connect-services input[type="checkbox"]:checked'))
    .map(el => el.value);
  return [...new Set([...always, ...checked])];
}

async function runConnectPage() {
  if (connectDone) return;
  if (!isElectron) { nextPage(); return; }

  // Skip if AutomationProfile and Google creds already exist (update scenario)
  if (existingSetup && existingSetup.automationProfile && existingSetup.googleCreds) {
    connectDone = true;
    showConnectSection('connect-success');
    const emailEl = document.getElementById('connect-email');
    if (emailEl) emailEl.textContent = '(already configured)';
    // Regenerate MCP config in background (may have been wiped by update)
    window.electronAPI.regenerateMcpConfig?.().catch(() => {});
    await delay(1000);
    nextPage();
    return;
  }

  // Check if oauth-creds.json exists — still set up Chrome even without it
  const credsCheck = await window.electronAPI.checkGoogleCreds();
  if (!credsCheck.hasCreds) {
    // No Google OAuth creds, but still detect Chrome for browser automation
    showConnectSection('connect-start');
    // Flag so after Chrome setup we skip Google auth and go to next page
    window._skipGoogleAuth = true;
    return;
  }

  window._skipGoogleAuth = false;
  showConnectSection('connect-start');
}

// Step 1: Detect Chrome
async function handleDetectChrome() {
  if (!isElectron) return;
  showConnectSection('connect-detecting');

  try {
    const result = await window.electronAPI.detectBrowser();
    if (!result.found) {
      showConnectSection('connect-not-found');
      return;
    }

    detectedExePath = result.exePath;

    if (result.profiles.length <= 1) {
      const selectedProfile = result.profiles.length === 1 ? result.profiles[0].directory : 'Default';
      await handleProfileSelected(selectedProfile);
    } else {
      const select = document.getElementById('profile-select');
      select.innerHTML = '';
      result.profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.directory;
        opt.textContent = p.email ? `${p.email} (${p.directory})` : `${p.name} (${p.directory})`;
        select.appendChild(opt);
      });
      showConnectSection('connect-profiles');
    }
  } catch (err) {
    showConnectError('Failed to detect Chrome: ' + err.message);
  }
}

// Step 2: After profile selected, show service selection
async function handleProfileSelected(selectedProfile) {
  showConnectSection('connect-copying');

  try {
    const createResult = await window.electronAPI.createAutomationProfile({
      selectedProfile,
      exePath: detectedExePath,
    });

    if (!createResult.ok) {
      showConnectError('Failed to create profile: ' + (createResult.error || 'unknown error'));
      return;
    }

    // Store the selected profile for later
    window._selectedProfile = selectedProfile;

    // If no Google OAuth creds, skip service selection and go to next page
    if (window._skipGoogleAuth) {
      connectDone = true;
      // Still write MCP config so Chrome tools are registered
      window.electronAPI.regenerateMcpConfig?.().catch(() => {});
      showConnectSection('connect-success');
      const emailEl = document.getElementById('connect-email');
      if (emailEl) emailEl.textContent = '(Chrome ready, Google skipped)';
      await delay(1000);
      nextPage();
      return;
    }

    // Show service selection
    showConnectSection('connect-services');
  } catch (err) {
    showConnectError('Error: ' + err.message);
  }
}

// Step 3: Services selected → start auth flow
async function handleStartAuth() {
  selectedGoogleServices = getSelectedServices();
  showConnectSection('connect-waiting');
  const waitText = document.getElementById('connect-waiting-text');

  if (waitText) waitText.textContent = 'Setting up Google sign-in... This may take a few seconds.';

  try {
    // This will: start auth server, get URL, open in AutomationProfile Chrome
    const result = await window.electronAPI.startGoogleAuth(selectedGoogleServices);

    if (result.ok && result.pendingAuth) {
      if (waitText) waitText.textContent = 'Sign in and grant permissions in the Chrome window...';

      // Wait for credential file to appear (polled by main process)
      const authDone = await new Promise((resolve) => {
        window.electronAPI.onGoogleAuthComplete((data) => {
          resolve(data);
        });
        setTimeout(() => resolve({ ok: false, error: 'Sign-in timed out.' }), 180000);
      });

      if (authDone.ok) {
        connectDone = true;
        const emailEl = document.getElementById('connect-email');
        if (emailEl && authDone.email) emailEl.textContent = `(${authDone.email})`;
        showConnectSection('connect-success');

        // Close the automation Chrome
        try { await window.electronAPI.closeAutomationChrome(); } catch {}

        await delay(1500);

        // Run onboarding scan in background — don't block the wizard
        runOnboardingScan();

        nextPage();
      } else {
        showConnectError(authDone.error || 'Google sign-in failed.');
      }
    } else if (result.ok) {
      connectDone = true;
      const emailEl = document.getElementById('connect-email');
      if (emailEl && result.email) emailEl.textContent = `(${result.email})`;
      showConnectSection('connect-success');
      try { await window.electronAPI.closeAutomationChrome(); } catch {}
      await delay(1500);
      runOnboardingScan();
      nextPage();
    } else {
      showConnectError(result.error || 'Could not get Google auth URL.');
    }
  } catch (err) {
    showConnectError('Error: ' + err.message);
  }
}

function showConnectError(msg) {
  const errorText = document.getElementById('connect-error-text');
  if (errorText) errorText.textContent = msg;
  showConnectSection('connect-error');
}

// Wire up buttons
document.getElementById('btn-setup-chrome')?.addEventListener('click', handleDetectChrome);
document.getElementById('btn-confirm-profile')?.addEventListener('click', () => {
  const select = document.getElementById('profile-select');
  handleProfileSelected(select.value);
});
document.getElementById('btn-start-auth')?.addEventListener('click', handleStartAuth);
document.getElementById('btn-retry-connect')?.addEventListener('click', () => {
  showConnectSection('connect-start');
});
document.getElementById('btn-skip-connect')?.addEventListener('click', () => nextPage());
document.getElementById('btn-skip-connect-waiting')?.addEventListener('click', () => nextPage());
document.getElementById('btn-skip-connect-error')?.addEventListener('click', () => nextPage());
document.getElementById('btn-skip-connect-nocreds')?.addEventListener('click', () => nextPage());
document.getElementById('btn-skip-onboarding')?.addEventListener('click', () => nextPage());

// ---------------------------------------------------------------------------
// Onboarding personalization scan
// ---------------------------------------------------------------------------

let onboardingSkipped = false;

async function runOnboardingScan() {
  if (!isElectron || selectedGoogleServices.length === 0) return;

  // Runs in background — no UI updates needed since the wizard has already
  // advanced to the next page. User doesn't need to watch personalization.
  try {
    const result = await window.electronAPI.runOnboardingScan(selectedGoogleServices);
    if (result.ok) {
      try { await window.electronAPI.runFilesystemIndex(); } catch {}
    }
    console.log('[onboarding] Background scan complete:', result.ok ? 'success' : 'partial');
  } catch (err) {
    console.log('[onboarding] Background scan error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Page 5: WhatsApp Setup
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

  const result = await window.electronAPI.startBackend();
  if (!result.ok && !result.alreadyRunning) {
    document.getElementById('wa-error-text').textContent =
      'Backend failed to start: ' + (result.error || 'unknown error');
    showWaSection('wa-error');
    return;
  }

  setWaStartingText('Connecting to backend...');

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
