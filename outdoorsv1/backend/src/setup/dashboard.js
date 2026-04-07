// ============================================================
// Outdoors Dashboard — Renderer (view-only live activity feed)
// Connects to backend via Socket.IO for live activity feed
// Uses Electron IPC for memory file operations
// ============================================================

let socket = null;
let currentMemoryFile = null;
let memoryDirty = false;

const REFERRAL_API = 'https://outdoors-referral.towneradamm.workers.dev';

// Invite share button
document.getElementById('btn-share-invite')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-share-invite');
  const originalText = btn.textContent;
  btn.textContent = 'Loading...';
  btn.disabled = true;

  try {
    // Use google email or downloadKey as userId
    let userId = null;
    if (window.electronAPI?.getFullConfig) {
      const cfg = await window.electronAPI.getFullConfig();
      userId = cfg.googleEmail || cfg.downloadKey || 'user-' + Date.now();
    }
    if (!userId) userId = 'user-' + Date.now();

    const res = await fetch(REFERRAL_API + '/api/create-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json();

    if (data.inviteCode) {
      await navigator.clipboard.writeText(data.inviteCode);
      btn.textContent = data.inviteCode + ' (copied!)';
      btn.disabled = false;
      // Show the code in the chat feed
      const feed = document.getElementById('feed');
      const entry = document.createElement('div');
      entry.className = 'feed-entry feed-msg feed-msg-assistant';
      entry.innerHTML = '<div class="msg-bubble" style="text-align:center;">' +
        '<div style="font-size:11px;opacity:0.6;margin-bottom:6px;">Your invite code</div>' +
        '<div style="font-size:22px;font-weight:700;letter-spacing:2px;font-family:monospace;margin-bottom:8px;">' + data.inviteCode + '</div>' +
        '<div style="font-size:11px;opacity:0.6;">Copied to clipboard — share it with a friend!</div>' +
        '</div>';
      feed.appendChild(entry);
      feed.scrollTop = feed.scrollHeight;
      setTimeout(() => { btn.textContent = 'Invite Code'; }, 3000);
    } else {
      btn.textContent = data.error || 'Error';
      setTimeout(() => { btn.textContent = 'Invite Code'; btn.disabled = false; }, 2000);
    }
  } catch (err) {
    btn.textContent = 'Offline';
    setTimeout(() => { btn.textContent = 'Invite Code'; btn.disabled = false; }, 2000);
  }
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  const backendUrl = await window.electronAPI.getBackendUrl();
  loadSocketIO(backendUrl);
  setupTitlebar();
  setupSettings();
  initOnboardingBar();
  initCodexAuthCheck();
});

// ---------------------------------------------------------------------------
// Socket.IO Connection
// ---------------------------------------------------------------------------

function loadSocketIO(backendUrl) {
  const script = document.createElement('script');
  script.src = backendUrl + '/socket.io/socket.io.js';
  script.onload = () => connectSocket(backendUrl);
  script.onerror = () => {
    setStatus('offline', 'Backend unreachable');
    setTimeout(() => {
      script.remove();
      loadSocketIO(backendUrl);
    }, 3000);
  };
  document.head.appendChild(script);
}

function connectSocket(backendUrl) {
  socket = io(backendUrl);

  socket.on('connect', () => setStatus('connected', 'Connected'));
  socket.on('disconnect', () => setStatus('offline', 'Disconnected'));

  // Primary event stream: `log` captures ALL activity (WhatsApp + web)
  socket.on('log', (entry) => handleLogEntry(entry));

  // Replay buffered history on connect
  socket.on('log_history', (entries) => {
    if (Array.isArray(entries) && entries.length > 0) {
      if (entries.some(e => e.type === 'incoming')) clearWelcome();
      entries.slice(-50).forEach(entry => handleLogEntry(entry, true));
    }
  });

  socket.on('chat_response', (data) => {
    removeAllSpinners();
    addAssistantMessage(typeof data === 'string' ? data : data.response);
  });

  socket.on('chat_error', (data) => {
    removeAllSpinners();
    addFeedEntry('error', data.error || 'Unknown error');
  });

  socket.on('process_status', (processes) => {
    if (processes && Object.keys(processes).length > 0) {
      setStatus('connected', 'Working (' + Object.keys(processes).length + ' active)');
    } else {
      setStatus('connected', 'Connected');
    }
  });
}

// ---------------------------------------------------------------------------
// Chat Input — send messages directly from the dashboard
// ---------------------------------------------------------------------------

const DASHBOARD_WINDOW_ID = 'dashboard-' + Math.random().toString(36).slice(2, 8);

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = (input.value || '').trim();
  if (!text || !socket) return;

  input.value = '';
  clearWelcome();

  // Show the user's message in the feed
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-msg feed-msg-user';
  entry.innerHTML = '<div class="msg-bubble">' + esc(text) + '</div>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;

  // Send to backend via the existing web_message channel
  socket.emit('web_message', { text, windowId: DASHBOARD_WINDOW_ID });
}

document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);
document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// ---------------------------------------------------------------------------
// Log Entry Handler
// ---------------------------------------------------------------------------

function getConvLabel(data) {
  const pk = data?.processKey || '';
  const m = pk.match(/:conv:(\d+)/);
  return m ? '#' + m[1] : '';
}

// Dev vs Simple log mode
let devMode = false;
document.getElementById('btn-log-mode')?.addEventListener('click', () => {
  devMode = !devMode;
  const btn = document.getElementById('btn-log-mode');
  if (btn) btn.textContent = devMode ? 'Dev' : 'Simple';
  // Toggle visibility of dev-only entries
  document.getElementById('feed')?.classList.toggle('show-dev', devMode);
});

function simplifyPhase(desc) {
  if (!desc) return null;
  const d = desc.toLowerCase();
  // Skip entirely in simple mode (too technical / noisy)
  if (d.includes('complete') && d.includes('intent')) return null;  // "Complete → intent=query formats=..."
  if (d.includes('selected:')) return null;  // "Selected: browser-preferences (always-include)..."
  if (d.includes('scores:') || d.includes('score=')) return null;  // score details
  if (d.includes('model b') || d.includes('model c') || d.includes('phase')) return null;
  if (d.includes('reviewing') && d.includes('learn')) return null;  // learner output
  if (d.includes('detecting') && d.includes('gap')) return null;
  if (d.includes('didn\'t identify gaps')) return null;
  if (d.includes('forcing knowledge')) return null;
  // Show simplified versions
  if (d.includes('classifying')) return 'Understanding your request...';
  if (d.includes('selecting') && d.includes('memory')) return 'Checking what I know...';
  if (d.includes('executing')) return 'Working on it...';
  if (d.includes('creating') && d.includes('memory')) return 'Learning something new...';
  if (d.includes('continuing conversation')) return 'Picking up where we left off...';
  if (d.includes('delegating')) return 'Handing off to a specialist...';
  if (d.includes('resumed session returned empty')) return 'Starting fresh...';
  return desc;
}

function simplifyTool(toolName) {
  const t = (toolName || '').toLowerCase();
  if (t.includes('bash') || t.includes('shell')) return 'Running a command';
  if (t.includes('read')) return 'Reading a file';
  if (t.includes('write')) return 'Writing a file';
  if (t.includes('web_search') || t.includes('websearch')) return 'Searching the web';
  if (t.includes('web_fetch') || t.includes('webfetch')) return 'Fetching a webpage';
  if (t.includes('snapshot') || t.includes('screenshot')) return 'Looking at the screen';
  if (t.includes('navigate')) return 'Opening a page';
  if (t.includes('click')) return 'Clicking something';
  if (t.includes('type') || t.includes('fill')) return 'Typing text';
  if (t.includes('evaluate') || t.includes('script')) return 'Running browser code';
  if (t.includes('gmail') || t.includes('email')) return 'Working with email';
  if (t.includes('calendar')) return 'Checking calendar';
  if (t.includes('drive') || t.includes('docs')) return 'Working with Google Drive';
  return 'Using ' + toolName;
}

function handleLogEntry(entry, isHistory) {
  if (!entry || !entry.type) return;
  // Only clear welcome on actual user activity, not status events
  if (entry.type === 'incoming') clearWelcome();

  const d = entry.data || {};
  const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : now();
  const cl = getConvLabel(d); // e.g. '#3' or ''
  const cp = cl ? `[${cl}] ` : ''; // prefix e.g. '[#3] ' or ''

  switch (entry.type) {
    case 'incoming': {
      const sender = d.sender || 'unknown';
      const prompt = d.prompt || '';
      // Skip for web messages — sendChatMessage() already added the user bubble
      if (sender === 'web') break;
      addFeedIncoming(ts, sender, prompt, cl);
      break;
    }
    case 'pipeline_phase': {
      const raw = d.description || ('Phase ' + (d.phase || '?'));
      const simple = simplifyPhase(raw);
      // Show simplified version always, raw version as dev-only
      if (simple) addFeedPhase(ts, cp + simple);
      addFeedPhase(ts, cp + raw, true); // dev-only
      break;
    }
    case 'tool_use': {
      const toolName = d.tool || 'Unknown';
      // Simplified version for simple mode
      addFeedPhase(ts, cp + simplifyTool(toolName));
      // Full detail for dev mode
      const detail = summarizeToolInput(toolName, d.input);
      addFeedTool(ts, toolName, cp + detail, !isHistory, true); // dev-only
      break;
    }
    case 'tool_result':
      removeLastSpinner();
      break;
    case 'assistant_text': {
      const text = d.text || '';
      if (text.length > 0) {
        addFeedThinking(ts, cp + text, true); // dev-only
      }
      break;
    }
    case 'delegation':
      addFeedPhase(ts, cp + 'Handing off to a specialist...');
      addFeedPhase(ts, cp + 'Delegating to ' + (d.employee || 'specialist'), true); // dev-only
      break;
    case 'cost':
      removeAllSpinners();
      break;
    case 'sent': {
      const to = d.to || '';
      // Skip for web messages — chat_response already displays the response
      if (to === 'web' || d.sender === 'web') break;
      addFeedSent(ts, to, d.responseLength || 0, d.response || '', cl);
      break;
    }
    case 'response': {
      const rLen = d.responseLength || 0;
      if (rLen > 0) addFeedEntryDev('info', cp + 'Response sent (' + rLen + ' chars)');
      break;
    }
    case 'connected':
      setStatus('connected', 'Connected');
      break;
    case 'disconnected':
      addFeedEntry('info', 'WhatsApp disconnected');
      break;
    case 'qr':
      addFeedEntry('info', 'WhatsApp QR code generated');
      break;
    case 'processing':
      addFeedEntryDev('info', cp + 'Processing request from ' + (d.sender || 'unknown') + '...');
      break;
    case 'clarification_requested':
      addFeedEntry('info', cp + 'Waiting for user input...');
      break;
    case 'error':
      addFeedEntry('error', cp + (d.message || d.error || 'Unknown error'));
      break;
    case 'received':
    case 'rate-limited':
    case 'blocked':
    case 'stderr':
    case 'runtime_stale_code_detected':
    case 'decryption_failure':
    case 'auth_reset':
      break;
    default:
      break;
  }
}

function summarizeToolInput(tool, input) {
  if (!input) return '';
  if (typeof input === 'string') return truncate(input, 120);
  switch (tool) {
    case 'Bash': return input.command ? truncate(input.command, 120) : '';
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': return input.file_path ? input.file_path + ' (edit)' : '';
    case 'Glob': return input.pattern || '';
    case 'Grep': return (input.pattern || '') + (input.path ? ' in ' + input.path : '');
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'Agent': return input.description || input.prompt ? truncate(input.description || input.prompt, 80) : '';
    case 'TodoWrite': return '';
    default:
      if (tool.startsWith('mcp__chrome__') || tool.startsWith('mcp__playwright__')) {
        return input.url || input.selector || input.expression || input.text || input.ref || '';
      }
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.length > 0) return truncate(v, 100);
      }
      return '';
  }
}

function truncate(str, max) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > max ? str.slice(0, max) + '...' : str;
}

// ---------------------------------------------------------------------------
// Feed Entries
// ---------------------------------------------------------------------------

function clearWelcome() {
  const w = document.querySelector('.feed-welcome');
  if (w) w.remove();
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addFeedEntry(type, text) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  const time = now();
  if (type === 'error') entry.innerHTML = '<span class="feed-time">' + time + '</span><span class="feed-error">' + esc(text) + '</span>';
  else if (type === 'info') entry.innerHTML = '<span class="feed-time">' + time + '</span><span class="feed-info">' + esc(text) + '</span>';
  else entry.innerHTML = '<span class="feed-time">' + time + '</span><span class="feed-text">' + esc(text) + '</span>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedEntryDev(type, text) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry dev-only';
  const time = now();
  if (type === 'error') entry.innerHTML = '<span class="feed-time">' + time + '</span><span class="feed-error">' + esc(text) + '</span>';
  else entry.innerHTML = '<span class="feed-time">' + time + '</span><span class="feed-info">' + esc(text) + '</span>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedIncoming(ts, sender, prompt, convLabel) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-msg feed-msg-user';
  const label = convLabel ? '[' + convLabel + '] ' : '';
  entry.innerHTML = '<div class="msg-meta">' + esc(label + sender) + ' &middot; ' + ts + '</div>' +
    '<div class="msg-bubble">' + esc(prompt) + '</div>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedPhase(ts, description, devOnly) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry' + (devOnly ? ' dev-only' : ' simple-only');
  entry.innerHTML = '<span class="feed-phase">' + esc(description) + '</span>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedTool(ts, toolName, detail, showSpinner, devOnly) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry' + (devOnly ? ' dev-only' : '');
  const spinner = showSpinner ? '<span class="tool-spinner"></span>' : '';
  const detailHtml = detail ? '<div class="feed-tool-detail">' + esc(detail) + '</div>' : '';
  entry.innerHTML = '<div class="feed-tool">' + spinner + '<span class="tool-name">' + esc(toolName) + '</span></div>' + detailHtml;
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedThinking(ts, text, devOnly) {
  const feed = document.getElementById('feed');
  const last = feed.lastElementChild;
  if (last && last.classList.contains('feed-thinking')) {
    const span = last.querySelector('.feed-thinking-text');
    if (span) { span.textContent = truncate(text, 300); feed.scrollTop = feed.scrollHeight; return; }
  }
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-thinking' + (devOnly ? ' dev-only' : '');
  entry.innerHTML = '<span class="feed-time">' + ts + '</span><span class="feed-thinking-text">' + esc(truncate(text, 300)) + '</span>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedSent(ts, to, len, response, convLabel) {
  const feed = document.getElementById('feed');
  if (response) {
    const entry = document.createElement('div');
    entry.className = 'feed-entry feed-msg feed-msg-assistant';
    const prefix = convLabel ? '[' + convLabel + '] ' : '';
    const meta = '<div class="msg-meta dev-only">' + esc(prefix) + 'Sent to ' + esc(to.split('@')[0] || to) + ' &middot; ' + ts + '</div>';
    entry.innerHTML = meta + '<div class="msg-bubble">' + renderMsg(response) + '</div>';
    feed.appendChild(entry);
    feed.scrollTop = feed.scrollHeight;
  } else {
    const prefix = convLabel ? '[' + convLabel + '] ' : '';
    addFeedEntryDev('info', prefix + 'Sent to ' + (to.split('@')[0] || to) + ' (' + len + ' chars)');
  }
}

function addAssistantMessage(text) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-msg feed-msg-assistant';
  entry.innerHTML = '<div class="msg-bubble">' + renderMsg(text) + '</div>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function removeLastSpinner() {
  const s = document.querySelectorAll('.tool-spinner');
  if (s.length > 0) s[s.length - 1].remove();
}

function removeAllSpinners() {
  document.querySelectorAll('.tool-spinner').forEach(s => s.remove());
}

// ---------------------------------------------------------------------------
// Titlebar
// ---------------------------------------------------------------------------

let outdoorsRunning = true;

function setupTitlebar() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimizeWindow());
  document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.closeWindow());

  const powerBtn = document.getElementById('btn-power');
  if (powerBtn) {
    powerBtn.title = 'Turn off Outdoors';
    powerBtn.addEventListener('click', async () => {
      powerBtn.style.pointerEvents = 'none';
      powerBtn.style.opacity = '0.5';
      if (outdoorsRunning) {
        setStatus('offline', 'Shutting down...');
        await window.electronAPI.stopBackend();
        outdoorsRunning = false;
        powerBtn.classList.remove('on');
        powerBtn.classList.add('off');
        powerBtn.title = 'Turn on Outdoors';
        setStatus('offline', 'Stopped');
      } else {
        setStatus('', 'Starting...');
        await window.electronAPI.startBackend();
        outdoorsRunning = true;
        powerBtn.classList.remove('off');
        powerBtn.classList.add('on');
        powerBtn.title = 'Turn off Outdoors';
        setStatus('connected', 'Connected');
        const backendUrl = await window.electronAPI.getBackendUrl();
        connectSocket(backendUrl);
      }
      powerBtn.style.pointerEvents = '';
      powerBtn.style.opacity = '';
    });
  }
}

function setStatus(state, text) {
  document.querySelector('.status-dot').className = 'status-dot ' + state;
  document.getElementById('status-text').textContent = text;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function setupSettings() {
  document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-overlay') closeSettings();
  });
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
      if (tab.dataset.tab === 'outputs') loadOutputsTree();
      if (tab.dataset.tab === 'automations') loadAutomations();
      if (tab.dataset.tab === 'analytics') loadAnalytics();
    });
  });
  document.getElementById('btn-save-config').addEventListener('click', saveConfig);
  document.getElementById('btn-reconnect-wa')?.addEventListener('click', reconnectWhatsApp);
  document.getElementById('btn-save-memory').addEventListener('click', saveMemoryFile);
  document.getElementById('btn-submit-bug')?.addEventListener('click', submitBugReport);
  document.getElementById('memory-content').addEventListener('input', () => {
    memoryDirty = true;
    document.getElementById('btn-save-memory').classList.remove('hidden');
  });
}

async function openSettings() {
  document.getElementById('settings-overlay').classList.remove('hidden');
  await loadMemoryTree();
  await loadConfig();
}

function closeSettings() {
  if ((memoryDirty || outputsDirty) && !confirm('You have unsaved changes. Discard?')) return;
  memoryDirty = false;
  outputsDirty = false;
  document.getElementById('settings-overlay').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Memory Tree
// ---------------------------------------------------------------------------

async function loadMemoryTree() {
  const tree = document.getElementById('memory-tree');
  tree.innerHTML = '<div style="padding:14px;color:#9A8B78;font-size:13px">Loading...</div>';
  try {
    const files = await window.electronAPI.listMemoryFiles();
    tree.innerHTML = '';
    buildTree(tree, files);
  } catch {
    tree.innerHTML = '<div style="padding:14px;color:#9E4A3A;font-size:13px">Failed to load files</div>';
  }
}

function buildTree(container, items, onFileClick) {
  const clickHandler = onFileClick || openMemoryFile;
  const folders = {};
  const topFiles = [];
  items.forEach(item => {
    const parts = item.relativePath.split('/');
    if (parts.length > 1) {
      if (!folders[parts[0]]) folders[parts[0]] = [];
      folders[parts[0]].push(item);
    } else {
      topFiles.push(item);
    }
  });
  const order = ['knowledge', 'preferences', 'sites', 'skills', 'evolution'];
  const sorted = Object.keys(folders).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  for (const f of sorted) container.appendChild(buildFolder(f, folders[f], 0, clickHandler));
  topFiles.forEach(item => container.appendChild(makeFileBtn(item, 14, clickHandler)));
}

function buildFolder(name, items, depth, clickHandler) {
  const el = document.createElement('div');
  el.className = 'memory-folder';
  const label = document.createElement('div');
  label.className = 'memory-folder-label';
  label.style.paddingLeft = (14 + depth * 14) + 'px';
  label.innerHTML = '<span class="memory-folder-arrow">&#9654;</span> ' + esc(name) + '/';
  label.addEventListener('click', () => el.classList.toggle('open'));
  const children = document.createElement('div');
  children.className = 'memory-folder-children';
  const subFolders = {};
  const directFiles = [];
  items.forEach(item => {
    const after = item.relativePath.split('/').slice(1);
    if (after.length > 1) {
      const sub = after[0];
      if (!subFolders[sub]) subFolders[sub] = [];
      subFolders[sub].push(item);
    } else {
      directFiles.push(item);
    }
  });
  directFiles.forEach(item => children.appendChild(makeFileBtn(item, 28 + depth * 14, clickHandler)));
  for (const sub of Object.keys(subFolders).sort()) {
    const subItems = subFolders[sub];
    if (subItems.length === 1) {
      const btn = makeFileBtn(subItems[0], 28 + depth * 14, clickHandler);
      btn.textContent = sub + '/' + subItems[0].name;
      children.appendChild(btn);
    } else {
      children.appendChild(buildFolder(sub, subItems.map(item => ({
        ...item, relativePath: item.relativePath.split('/').slice(1).join('/')
      })), depth + 1, clickHandler));
    }
  }
  el.appendChild(label);
  el.appendChild(children);
  return el;
}

function makeFileBtn(item, paddingLeft, clickHandler) {
  const handler = clickHandler || openMemoryFile;
  const btn = document.createElement('button');
  btn.className = 'memory-file';
  btn.style.paddingLeft = paddingLeft + 'px';
  btn.textContent = item.name;
  btn.title = item.relativePath;
  btn.addEventListener('click', () => handler(item.relativePath, btn));
  return btn;
}

async function openMemoryFile(relativePath, btnEl) {
  if (memoryDirty && !confirm('Discard unsaved changes?')) return;
  document.querySelectorAll('.memory-file').forEach(f => f.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  const textarea = document.getElementById('memory-content');
  const filename = document.getElementById('memory-filename');
  const saveBtn = document.getElementById('btn-save-memory');
  filename.textContent = relativePath;
  textarea.value = 'Loading...';
  textarea.disabled = true;
  saveBtn.classList.add('hidden');
  memoryDirty = false;
  try {
    textarea.value = await window.electronAPI.readMemoryFile(relativePath);
    textarea.disabled = false;
    currentMemoryFile = relativePath;
  } catch (err) {
    textarea.value = 'Error: ' + (err.message || 'Could not load file');
  }
}

async function saveMemoryFile() {
  if (!currentMemoryFile) return;
  const saveBtn = document.getElementById('btn-save-memory');
  try {
    await window.electronAPI.saveMemoryFile(currentMemoryFile, document.getElementById('memory-content').value);
    saveBtn.textContent = 'Saved!';
    memoryDirty = false;
    setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.classList.add('hidden'); }, 1500);
  } catch (err) {
    alert('Failed to save: ' + (err.message || 'Unknown error'));
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function loadConfig() {
  try {
    const cfg = await window.electronAPI.getConfig();
    document.getElementById('cfg-rate-limit').value = cfg.rateLimitPerMinute || 10;
    document.getElementById('cfg-max-response').value = cfg.maxResponseLength || 4000;
    document.getElementById('cfg-timeout').value = cfg.messageTimeout || 300;
  } catch {}
}

async function saveConfig() {
  const data = {
    rateLimitPerMinute: parseInt(document.getElementById('cfg-rate-limit').value) || 10,
    maxResponseLength: parseInt(document.getElementById('cfg-max-response').value) || 4000,
    messageTimeout: parseInt(document.getElementById('cfg-timeout').value) || 300,
  };
  try {
    await window.electronAPI.saveConfig(data);
    const btn = document.getElementById('btn-save-config');
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.textContent = 'Save Settings'; }, 1500);
  } catch (err) {
    alert('Failed to save: ' + (err.message || 'Unknown error'));
  }
}

// ---------------------------------------------------------------------------
// WhatsApp Reconnect
// ---------------------------------------------------------------------------

async function reconnectWhatsApp() {
  const btn = document.getElementById('btn-reconnect-wa');
  const qrContainer = document.getElementById('wa-qr-inline');
  const qrImg = document.getElementById('wa-qr-inline-img');

  btn.textContent = 'Disconnecting...';
  btn.disabled = true;

  try {
    const backendUrl = await window.electronAPI.getBackendUrl();
    const resp = await fetch(backendUrl + '/api/whatsapp/reconnect', { method: 'POST' });
    const result = await resp.json();

    if (result.ok) {
      btn.textContent = 'Waiting for QR code...';
      // The socket.io connection will receive the QR code event
      if (socket) {
        const onQR = (dataUrl) => {
          qrContainer.classList.remove('hidden');
          qrImg.src = dataUrl;
          btn.textContent = 'Scan the QR code below';
        };
        // Remove old listeners to prevent stacking on repeated reconnects
        socket.off('qr');
        socket.on('qr', onQR);
        const onLog = (entry) => {
          if (entry?.type === 'qr' && entry.data?.dataUrl) onQR(entry.data.dataUrl);
          if (entry?.type === 'connected') {
            qrContainer.classList.add('hidden');
            btn.textContent = 'Reconnect WhatsApp';
            btn.disabled = false;
            socket.off('log', onLog);
          }
        };
        socket.on('log', onLog);
      }
    } else {
      btn.textContent = 'Failed — try again';
      btn.disabled = false;
    }
  } catch (err) {
    btn.textContent = 'Error — try again';
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Bug Reporting
// ---------------------------------------------------------------------------

async function submitBugReport() {
  const title = document.getElementById('bug-title')?.value?.trim();
  const description = document.getElementById('bug-description')?.value?.trim();
  const severity = document.getElementById('bug-severity')?.value || 'medium';
  const status = document.getElementById('bug-status');
  const btn = document.getElementById('btn-submit-bug');

  if (!title) { if (status) status.textContent = 'Please enter a title.'; return; }
  if (!description) { if (status) status.textContent = 'Please describe the issue.'; return; }

  btn.disabled = true;
  btn.textContent = 'Submitting...';
  if (status) status.textContent = '';

  try {
    const backendUrl = await window.electronAPI.getBackendUrl();
    const resp = await fetch(backendUrl + '/api/bug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, severity }),
    });
    const result = await resp.json();

    if (result.ok) {
      if (status) status.textContent = 'Bug report submitted. Thank you!';
      document.getElementById('bug-title').value = '';
      document.getElementById('bug-description').value = '';
    } else {
      if (status) status.textContent = 'Saved locally. ' + (result.error || '');
    }
  } catch {
    if (status) status.textContent = 'Could not reach backend — report saved locally next time.';
  }

  btn.disabled = false;
  btn.textContent = 'Submit Bug Report';
}

// ---------------------------------------------------------------------------
// Outputs Tree
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.js', '.ts', '.html', '.css', '.csv',
  '.xml', '.yaml', '.yml', '.py', '.sh', '.bat', '.log', '.env',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv']);

let currentOutputFile = null;
let outputsDirty = false;

async function loadOutputsTree() {
  const tree = document.getElementById('outputs-tree');
  tree.innerHTML = '<div style="padding:14px;color:#9A8B78;font-size:13px">Loading...</div>';
  try {
    const files = await window.electronAPI.listOutputFiles();
    tree.innerHTML = '';
    if (files.length === 0) {
      tree.innerHTML = '<div style="padding:14px;color:#9A8B78;font-size:13px">No project files yet.</div>';
      return;
    }
    buildTree(tree, files, openOutputFile);
  } catch {
    tree.innerHTML = '<div style="padding:14px;color:#9E4A3A;font-size:13px">Failed to load files</div>';
  }
}

function getExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}
function isTextFile(name) { return TEXT_EXTENSIONS.has(getExtension(name)); }
function isImageFile(name) { return IMAGE_EXTENSIONS.has(getExtension(name)); }
function isVideoFile(name) { return VIDEO_EXTENSIONS.has(getExtension(name)); }

async function openOutputFile(relativePath, btnEl) {
  if (outputsDirty && !confirm('Discard unsaved changes?')) return;
  document.querySelectorAll('#outputs-tree .memory-file').forEach(f => f.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  const textarea = document.getElementById('outputs-content');
  const filename = document.getElementById('outputs-filename');
  const saveBtn = document.getElementById('btn-save-output');
  const deleteBtn = document.getElementById('btn-delete-output');
  const openBtn = document.getElementById('btn-open-output');

  filename.textContent = relativePath;
  currentOutputFile = relativePath;
  outputsDirty = false;
  saveBtn.classList.add('hidden');
  deleteBtn.classList.remove('hidden');
  openBtn.classList.remove('hidden');

  const mediaContainer = document.getElementById('outputs-media');
  const mediaImg = document.getElementById('outputs-media-img');
  const mediaVideo = document.getElementById('outputs-media-video');

  // Reset media state
  mediaContainer.classList.add('hidden');
  mediaImg.classList.add('hidden');
  mediaVideo.classList.add('hidden');
  mediaImg.src = '';
  mediaVideo.src = '';
  textarea.classList.remove('hidden');

  if (isImageFile(relativePath) || isVideoFile(relativePath)) {
    textarea.classList.add('hidden');
    mediaContainer.classList.remove('hidden');
    try {
      const filePath = await window.electronAPI.getOutputFilePath(relativePath);
      const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
      if (isImageFile(relativePath)) {
        mediaImg.src = fileUrl;
        mediaImg.classList.remove('hidden');
      } else {
        mediaVideo.src = fileUrl;
        mediaVideo.classList.remove('hidden');
      }
    } catch (err) {
      textarea.classList.remove('hidden');
      mediaContainer.classList.add('hidden');
      textarea.value = 'Error loading media: ' + (err.message || 'unknown');
      textarea.disabled = true;
    }
  } else if (isTextFile(relativePath)) {
    textarea.value = 'Loading...';
    textarea.disabled = true;
    try {
      textarea.value = await window.electronAPI.readOutputFile(relativePath);
      textarea.disabled = false;
    } catch (err) {
      textarea.value = 'Error: ' + (err.message || 'Could not load file');
    }
  } else {
    textarea.value = 'Binary file — use "Open in App" to view.';
    textarea.disabled = true;
  }
}

document.getElementById('outputs-content')?.addEventListener('input', () => {
  outputsDirty = true;
  document.getElementById('btn-save-output').classList.remove('hidden');
});

document.getElementById('btn-save-output')?.addEventListener('click', async () => {
  if (!currentOutputFile) return;
  const saveBtn = document.getElementById('btn-save-output');
  try {
    await window.electronAPI.saveOutputFile(currentOutputFile, document.getElementById('outputs-content').value);
    saveBtn.textContent = 'Saved!';
    outputsDirty = false;
    setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.classList.add('hidden'); }, 1500);
  } catch (err) {
    alert('Failed to save: ' + (err.message || 'Unknown error'));
  }
});

document.getElementById('btn-delete-output')?.addEventListener('click', async () => {
  if (!currentOutputFile) return;
  if (!confirm('Delete ' + currentOutputFile + '?')) return;
  try {
    await window.electronAPI.deleteOutputFile(currentOutputFile);
    currentOutputFile = null;
    outputsDirty = false;
    document.getElementById('outputs-filename').textContent = 'Select a file';
    document.getElementById('outputs-content').value = '';
    document.getElementById('outputs-content').disabled = true;
    document.getElementById('btn-save-output').classList.add('hidden');
    document.getElementById('btn-delete-output').classList.add('hidden');
    document.getElementById('btn-open-output').classList.add('hidden');
    await loadOutputsTree();
  } catch (err) {
    alert('Failed to delete: ' + (err.message || 'Unknown error'));
  }
});

document.getElementById('btn-open-output')?.addEventListener('click', async () => {
  if (!currentOutputFile) return;
  try {
    await window.electronAPI.openOutputFile(currentOutputFile);
  } catch (err) {
    alert('Failed to open: ' + (err.message || 'Unknown error'));
  }
});

// Add existing files to a project
document.getElementById('btn-add-project-file')?.addEventListener('click', async () => {
  // Determine which project subfolder we're in (from current file or prompt)
  let subfolder = '';
  if (currentOutputFile) {
    const parts = currentOutputFile.split('/');
    if (parts.length > 1) subfolder = parts.slice(0, -1).join('/');
  }
  if (!subfolder) {
    subfolder = prompt('Project folder name (e.g. "job-application"):', '');
    if (!subfolder) return;
  }
  try {
    const result = await window.electronAPI.uploadToProject(subfolder);
    if (result.ok) {
      await loadOutputsTree();
      if (result.files?.length) openOutputFile(result.files[0]);
    }
  } catch (err) {
    alert('Failed to add files: ' + (err.message || 'Unknown error'));
  }
});

// Create a new text file in a project
document.getElementById('btn-new-project-file')?.addEventListener('click', async () => {
  let subfolder = '';
  if (currentOutputFile) {
    const parts = currentOutputFile.split('/');
    if (parts.length > 1) subfolder = parts.slice(0, -1).join('/');
  }
  const fileName = prompt('File name (e.g. "notes.md", "context.txt"):', 'notes.md');
  if (!fileName) return;
  if (!subfolder) {
    subfolder = prompt('Project folder name:', '');
    if (!subfolder) return;
  }
  const relativePath = subfolder + '/' + fileName;
  try {
    await window.electronAPI.createProjectFile(relativePath);
    await loadOutputsTree();
    openOutputFile(relativePath);
  } catch (err) {
    alert('Failed to create file: ' + (err.message || 'Unknown error'));
  }
});

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

let automationsCache = [];
let editingAutomationId = null;

async function loadAutomations() {
  const list = document.getElementById('automations-list');
  list.innerHTML = '<div class="automations-empty">Loading...</div>';
  showAutomationsView();
  try {
    automationsCache = await window.electronAPI.getAutomations();
    renderAutomationsList();
  } catch {
    list.innerHTML = '<div class="automations-empty">Failed to load automations</div>';
  }
}

function renderAutomationsList() {
  const list = document.getElementById('automations-list');
  list.innerHTML = '';
  if (automationsCache.length === 0) {
    list.innerHTML = '<div class="automations-empty">No automations yet. Create one to automate tasks.</div>';
    return;
  }
  for (const automation of automationsCache) {
    const card = document.createElement('div');
    card.className = 'automation-card' + (automation.enabled ? '' : ' disabled');
    card.innerHTML =
      '<label class="automation-toggle">' +
        '<input type="checkbox"' + (automation.enabled ? ' checked' : '') + '>' +
        '<span class="slider"></span>' +
      '</label>' +
      '<div class="automation-info">' +
        '<div class="automation-name">' + esc(automation.name || 'Untitled') + '</div>' +
        '<div class="automation-schedule">' + esc(formatSchedule(automation.schedule)) + '</div>' +
        '<div class="automation-prompt-preview">' + esc(truncate(automation.prompt || '', 100)) + '</div>' +
      '</div>' +
      '<div class="automation-actions">' +
        '<button class="automation-btn edit">Edit</button>' +
        '<button class="automation-btn delete">Delete</button>' +
      '</div>';
    const toggleInput = card.querySelector('input[type="checkbox"]');
    toggleInput.addEventListener('change', () => onToggleAutomation(automation.id, toggleInput.checked));
    card.querySelector('.automation-btn.edit').addEventListener('click', () => openAutomationForm(automation));
    card.querySelector('.automation-btn.delete').addEventListener('click', () => onDeleteAutomation(automation.id, automation.name));
    list.appendChild(card);
  }
}

function formatSchedule(schedule) {
  if (!schedule) return 'No schedule';
  switch (schedule.type) {
    case 'interval': {
      const mins = schedule.intervalMinutes || 60;
      if (mins >= 1440 && mins % 1440 === 0) return 'Every ' + (mins / 1440) + ' day' + (mins / 1440 > 1 ? 's' : '');
      if (mins >= 60 && mins % 60 === 0) return 'Every ' + (mins / 60) + ' hour' + (mins / 60 > 1 ? 's' : '');
      return 'Every ' + mins + ' minute' + (mins > 1 ? 's' : '');
    }
    case 'daily':
      return 'Daily at ' + formatTime(schedule.timeOfDay || '09:00');
    case 'weekly': {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return days[schedule.dayOfWeek || 0] + 's at ' + formatTime(schedule.timeOfDay || '09:00');
    }
    case 'once': {
      if (!schedule.datetime) return 'One time (no date set)';
      const d = new Date(schedule.datetime);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + formatTime(schedule.timeOfDay || d.toTimeString().slice(0, 5));
    }
    case 'email':
      return 'When email from ' + (schedule.fromAddress || '(not set)');
    default:
      return 'Unknown schedule';
  }
}

function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + suffix;
}

function showAutomationsView() {
  document.getElementById('automations-view').classList.remove('hidden');
  document.getElementById('automation-form').classList.add('hidden');
}

function showAutomationForm() {
  document.getElementById('automations-view').classList.add('hidden');
  document.getElementById('automation-form').classList.remove('hidden');
}

function openAutomationForm(automation) {
  editingAutomationId = automation ? automation.id : null;
  document.getElementById('automation-form-title').textContent = automation ? 'Edit Automation' : 'New Automation';
  document.getElementById('tf-name').value = automation ? automation.name : '';
  document.getElementById('tf-prompt').value = automation ? automation.prompt : '';

  const schedule = automation ? automation.schedule : { type: 'interval', intervalMinutes: 1440 };
  document.getElementById('tf-type').value = schedule.type || 'interval';

  // Set interval fields
  if (schedule.type === 'interval') {
    const mins = schedule.intervalMinutes || 60;
    if (mins >= 1440 && mins % 1440 === 0) {
      document.getElementById('tf-interval-value').value = mins / 1440;
      document.getElementById('tf-interval-unit').value = 'days';
    } else if (mins >= 60 && mins % 60 === 0) {
      document.getElementById('tf-interval-value').value = mins / 60;
      document.getElementById('tf-interval-unit').value = 'hours';
    } else {
      document.getElementById('tf-interval-value').value = mins;
      document.getElementById('tf-interval-unit').value = 'minutes';
    }
  } else {
    document.getElementById('tf-interval-value').value = 1;
    document.getElementById('tf-interval-unit').value = 'days';
  }

  // Set time/day fields
  document.getElementById('tf-time').value = schedule.timeOfDay || '09:00';
  document.getElementById('tf-day').value = schedule.dayOfWeek ?? 1;

  // Set datetime field
  if (schedule.datetime) {
    document.getElementById('tf-datetime').value = schedule.datetime.slice(0, 16);
  } else {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    document.getElementById('tf-datetime').value = d.toISOString().slice(0, 16);
  }

  // Set email field
  document.getElementById('tf-email-from').value = schedule.fromAddress || '';

  updateScheduleFields();
  showAutomationForm();
}

function updateScheduleFields() {
  const type = document.getElementById('tf-type').value;
  document.getElementById('tf-interval-group').classList.toggle('hidden', type !== 'interval');
  document.getElementById('tf-time-group').classList.toggle('hidden', type !== 'daily' && type !== 'weekly');
  document.getElementById('tf-day-group').classList.toggle('hidden', type !== 'weekly');
  document.getElementById('tf-datetime-group').classList.toggle('hidden', type !== 'once');
  document.getElementById('tf-email-group').classList.toggle('hidden', type !== 'email');
}

async function saveAutomationForm() {
  const name = document.getElementById('tf-name').value.trim();
  const prompt = document.getElementById('tf-prompt').value.trim();
  if (!name || !prompt) { alert('Name and prompt are required.'); return; }

  const type = document.getElementById('tf-type').value;
  const schedule = { type };

  switch (type) {
    case 'interval': {
      const val = parseInt(document.getElementById('tf-interval-value').value) || 1;
      const unit = document.getElementById('tf-interval-unit').value;
      const multiplier = unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
      schedule.intervalMinutes = val * multiplier;
      break;
    }
    case 'daily':
      schedule.timeOfDay = document.getElementById('tf-time').value;
      break;
    case 'weekly':
      schedule.dayOfWeek = parseInt(document.getElementById('tf-day').value);
      schedule.timeOfDay = document.getElementById('tf-time').value;
      break;
    case 'once':
      schedule.datetime = document.getElementById('tf-datetime').value;
      break;
    case 'email': {
      const fromAddr = document.getElementById('tf-email-from').value.trim();
      if (!fromAddr) { alert('Email address is required for email automations.'); return; }
      schedule.fromAddress = fromAddr;
      break;
    }
  }

  const automation = {
    id: editingAutomationId || ('a_' + Math.random().toString(36).slice(2, 10)),
    name,
    prompt,
    enabled: true,
    schedule,
    lastFiredAt: null,
    createdAt: new Date().toISOString(),
  };

  // Preserve existing fields when editing
  if (editingAutomationId) {
    const existing = automationsCache.find(a => a.id === editingAutomationId);
    if (existing) {
      automation.lastFiredAt = existing.lastFiredAt;
      automation.createdAt = existing.createdAt;
      automation.enabled = existing.enabled;
    }
  }

  const saveBtn = document.getElementById('btn-automation-save');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;
  try {
    await window.electronAPI.saveAutomation(automation);
    await loadAutomations();
  } catch (err) {
    alert('Failed to save: ' + (err.message || 'Unknown error'));
  } finally {
    saveBtn.textContent = 'Save Automation';
    saveBtn.disabled = false;
  }
}

async function onDeleteAutomation(id, name) {
  if (!confirm('Delete automation "' + name + '"?')) return;
  try {
    await window.electronAPI.deleteAutomation(id);
    await loadAutomations();
  } catch (err) {
    alert('Failed to delete: ' + (err.message || 'Unknown error'));
  }
}

async function onToggleAutomation(id, enabled) {
  try {
    await window.electronAPI.toggleAutomation(id, enabled);
    const a = automationsCache.find(a => a.id === id);
    if (a) a.enabled = enabled;
    renderAutomationsList();
  } catch (err) {
    alert('Failed to toggle: ' + (err.message || 'Unknown error'));
  }
}

// Wire up automation form events
document.getElementById('btn-add-automation')?.addEventListener('click', () => openAutomationForm(null));
document.getElementById('btn-automation-cancel')?.addEventListener('click', showAutomationsView);
document.getElementById('btn-automation-form-cancel')?.addEventListener('click', showAutomationsView);
document.getElementById('btn-automation-save')?.addEventListener('click', saveAutomationForm);
document.getElementById('tf-type')?.addEventListener('change', updateScheduleFields);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function renderMsg(text) {
  let r = esc(text);
  r = r.replace(/\[IMAGE:[^\]]+\]/g, '');
  r = r.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
  r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  r = r.replace(/\n/g, '<br>');
  return r;
}

// ---------------------------------------------------------------------------
// Onboarding progress bar
// ---------------------------------------------------------------------------

function initOnboardingBar() {
  if (!window.electronAPI?.getOnboardingScanState) return;

  const container = document.getElementById('onboarding-bar-container');
  const fill = document.getElementById('onboarding-bar-fill');
  if (!container || !fill) return;

  function updateBar(state) {
    if (!state) return;
    if (state.running) {
      container.classList.remove('hidden');
      fill.style.width = state.progress + '%';
      container.title = `Onboarding scan ${state.progress}% complete`;
    } else if (state.progress >= 100) {
      fill.style.width = '100%';
      container.title = 'Onboarding scan complete';
      setTimeout(() => container.classList.add('hidden'), 2000);
    } else {
      container.classList.add('hidden');
    }
  }

  // Check initial state
  window.electronAPI.getOnboardingScanState().then(updateBar);

  // Listen for live updates
  window.electronAPI.onOnboardingScanState?.(updateBar);
}

// ---------------------------------------------------------------------------
// Codex auth check
// ---------------------------------------------------------------------------

function initCodexAuthCheck() {
  if (!window.electronAPI?.onCodexAuthStatus) return;

  const overlay = document.getElementById('auth-overlay');
  if (!overlay) return;

  window.electronAPI.onCodexAuthStatus((data) => {
    if (data.authenticated) {
      overlay.classList.add('hidden');
    } else {
      overlay.classList.remove('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

async function loadAnalytics() {
  const days = document.getElementById('analytics-days')?.value || 30;
  try {
    const url = await window.electronAPI.getBackendUrl();
    const res = await fetch(`${url}/api/analytics?days=${days}`);
    const data = await res.json();
    renderAnalytics(data);
  } catch (err) {
    console.log('Analytics load failed:', err);
  }
}

function renderAnalytics(data) {
  const t = data.totals || {};

  document.getElementById('stat-messages').textContent = t.messages || 0;
  document.getElementById('stat-cost').textContent = '$' + (t.cost || 0).toFixed(2);
  document.getElementById('stat-avg-time').textContent = t.avgDurationMs > 0 ? Math.round(t.avgDurationMs / 1000) + 's' : '—';
  document.getElementById('stat-tokens').textContent = formatTokens((t.inputTokens || 0) + (t.outputTokens || 0));
  document.getElementById('stat-errors').textContent = t.errors || 0;
  const wa = data.byPlatform?.whatsapp || 0;
  const web = data.byPlatform?.web || 0;
  document.getElementById('stat-platform').textContent = wa + ' / ' + web;

  // Daily chart
  const chart = document.getElementById('analytics-daily-chart');
  chart.innerHTML = '';
  const daily = data.daily || [];
  const maxMsg = Math.max(1, ...daily.map(d => d.messages));
  for (const day of daily) {
    const pct = (day.messages / maxMsg) * 100;
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = pct + '%';
    bar.title = day.date + ': ' + day.messages + ' msgs, $' + (day.cost || 0).toFixed(2);
    const label = document.createElement('div');
    label.className = 'chart-bar-label';
    label.textContent = day.date.slice(5);
    bar.appendChild(label);
    chart.appendChild(bar);
  }

  // Top tools
  const toolsEl = document.getElementById('analytics-top-tools');
  toolsEl.innerHTML = '';
  for (const tool of (data.topTools || []).slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.innerHTML = '<span class="tool-name">' + esc(tool.name) + '</span><span class="tool-count">' + tool.count + '</span>';
    toolsEl.appendChild(row);
  }
  if (!data.topTools?.length) toolsEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No tool data yet</div>';

  // Peak hours
  const hoursEl = document.getElementById('analytics-peak-hours');
  hoursEl.innerHTML = '';
  const hours = data.peakHours || new Array(24).fill(0);
  const maxHour = Math.max(1, ...hours);
  for (let i = 0; i < 24; i++) {
    const bar = document.createElement('div');
    bar.className = 'hour-bar';
    const pct = (hours[i] / maxHour) * 100;
    bar.style.height = pct + '%';
    bar.style.opacity = 0.2 + (hours[i] / maxHour) * 0.8;
    bar.title = i + ':00 — ' + hours[i] + ' messages';
    hoursEl.appendChild(bar);
  }

  // Top senders
  const sendersEl = document.getElementById('analytics-top-senders');
  sendersEl.innerHTML = '';
  for (const sender of (data.topSenders || []).slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'sender-row';
    row.innerHTML = '<span class="sender-name">' + esc(sender.name) + '</span><span class="sender-count">' + sender.count + '</span>';
    sendersEl.appendChild(row);
  }
  if (!data.topSenders?.length) sendersEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No sender data yet</div>';
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

document.getElementById('btn-refresh-analytics')?.addEventListener('click', loadAnalytics);
document.getElementById('analytics-days')?.addEventListener('change', loadAnalytics);

// ---------------------------------------------------------------------------
// Version label
// ---------------------------------------------------------------------------

(async () => {
  const el = document.getElementById('version-label');
  if (el && window.electronAPI?.getAppVersion) {
    try {
      const v = await window.electronAPI.getAppVersion();
      if (v) el.textContent = 'v' + v;
    } catch {}
  }
})();
