// ============================================================
// Outdoors Dashboard — Renderer (view-only live activity feed)
// Connects to backend via Socket.IO for live activity feed
// Uses Electron IPC for memory file operations
// ============================================================

let socket = null;
let currentMemoryFile = null;
let memoryDirty = false;

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
// Log Entry Handler
// ---------------------------------------------------------------------------

function handleLogEntry(entry, isHistory) {
  if (!entry || !entry.type) return;
  // Only clear welcome on actual user activity, not status events
  if (entry.type === 'incoming') clearWelcome();

  const d = entry.data || {};
  const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : now();

  switch (entry.type) {
    case 'incoming': {
      const sender = d.sender || 'unknown';
      const prompt = d.prompt || '';
      const convLabel = d.conversation != null ? `#${d.conversation}` : '';
      addFeedIncoming(ts, sender, prompt, convLabel);
      break;
    }
    case 'pipeline_phase':
      addFeedPhase(ts, d.description || ('Phase ' + (d.phase || '?')));
      break;
    case 'tool_use': {
      const toolName = d.tool || 'Unknown';
      const detail = summarizeToolInput(toolName, d.input);
      addFeedTool(ts, toolName, detail, !isHistory);
      break;
    }
    case 'tool_result':
      removeLastSpinner();
      break;
    case 'assistant_text': {
      const text = d.text || '';
      if (text.length > 0) addFeedThinking(ts, text);
      break;
    }
    case 'delegation':
      addFeedPhase(ts, 'Delegating to ' + (d.employee || 'specialist'));
      break;
    case 'cost':
      removeAllSpinners();
      break;
    case 'sent': {
      const to = d.to || '';
      addFeedSent(ts, to, d.responseLength || 0, d.response || '');
      break;
    }
    case 'response': {
      const rLen = d.responseLength || 0;
      if (rLen > 0) addFeedEntry('info', 'Response sent (' + rLen + ' chars)');
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
      addFeedEntry('info', 'Processing request from ' + (d.sender || 'unknown') + '...');
      break;
    case 'clarification_requested':
      addFeedEntry('info', 'Waiting for user input...');
      break;
    case 'error':
      addFeedEntry('error', d.message || d.error || 'Unknown error');
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

function addFeedIncoming(ts, sender, prompt, convLabel) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-incoming';
  const label = convLabel ? sender + ' [' + convLabel + ']' : sender;
  entry.innerHTML = '<span class="feed-time">' + ts + '</span>' +
    '<span class="feed-incoming-label">' + esc(label) + '</span> ' +
    '<span class="feed-incoming-text">' + esc(truncate(prompt, 200)) + '</span>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedPhase(ts, description) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  entry.innerHTML = '<span class="feed-time">' + ts + '</span><span class="feed-phase">' + esc(description) + '</span>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedTool(ts, toolName, detail, showSpinner) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  const spinner = showSpinner ? '<span class="tool-spinner"></span>' : '';
  const detailHtml = detail ? '<div class="feed-tool-detail">' + esc(detail) + '</div>' : '';
  entry.innerHTML = '<div class="feed-tool">' + spinner + '<span class="tool-name">' + esc(toolName) + '</span></div>' + detailHtml;
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedThinking(ts, text) {
  const feed = document.getElementById('feed');
  const last = feed.lastElementChild;
  if (last && last.classList.contains('feed-thinking')) {
    const span = last.querySelector('.feed-thinking-text');
    if (span) { span.textContent = truncate(text, 300); feed.scrollTop = feed.scrollHeight; return; }
  }
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-thinking';
  entry.innerHTML = '<span class="feed-time">' + ts + '</span><span class="feed-thinking-text">' + esc(truncate(text, 300)) + '</span>';
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addFeedSent(ts, to, len, response) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  let html = '<span class="feed-time">' + ts + '</span><span class="feed-info">Sent to ' + esc(to.split('@')[0] || to) + ' (' + len + ' chars)</span>';
  if (response) {
    let rendered = esc(response);
    rendered = rendered.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    rendered = rendered.replace(/`([^`]+)`/g, '<code>$1</code>');
    rendered = rendered.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html += '<div class="msg-bubble">' + rendered + '</div>';
  }
  entry.innerHTML = html;
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}

function addAssistantMessage(text) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-msg feed-msg-assistant';
  let rendered = esc(text);
  rendered = rendered.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  rendered = rendered.replace(/`([^`]+)`/g, '<code>$1</code>');
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  entry.innerHTML = '<div class="msg-bubble">' + rendered + '</div>';
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
      if (tab.dataset.tab === 'triggers') loadTriggers();
    });
  });
  document.getElementById('btn-save-config').addEventListener('click', saveConfig);
  document.getElementById('btn-reconnect-wa')?.addEventListener('click', reconnectWhatsApp);
  document.getElementById('btn-save-memory').addEventListener('click', saveMemoryFile);
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
        socket.on('qr', onQR);
        socket.on('log', (entry) => {
          if (entry?.type === 'qr' && entry.data?.dataUrl) onQR(entry.data.dataUrl);
          if (entry?.type === 'connected') {
            qrContainer.classList.add('hidden');
            btn.textContent = 'Reconnect WhatsApp';
            btn.disabled = false;
          }
        });
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
// Triggers
// ---------------------------------------------------------------------------

let triggersCache = [];
let editingTriggerId = null;

async function loadTriggers() {
  const list = document.getElementById('triggers-list');
  list.innerHTML = '<div class="triggers-empty">Loading...</div>';
  showTriggersView();
  try {
    triggersCache = await window.electronAPI.getTriggers();
    renderTriggersList();
  } catch {
    list.innerHTML = '<div class="triggers-empty">Failed to load triggers</div>';
  }
}

function renderTriggersList() {
  const list = document.getElementById('triggers-list');
  list.innerHTML = '';
  if (triggersCache.length === 0) {
    list.innerHTML = '<div class="triggers-empty">No triggers yet. Create one to automate tasks.</div>';
    return;
  }
  for (const trigger of triggersCache) {
    const card = document.createElement('div');
    card.className = 'trigger-card' + (trigger.enabled ? '' : ' disabled');
    card.innerHTML =
      '<label class="trigger-toggle">' +
        '<input type="checkbox"' + (trigger.enabled ? ' checked' : '') + '>' +
        '<span class="slider"></span>' +
      '</label>' +
      '<div class="trigger-info">' +
        '<div class="trigger-name">' + esc(trigger.name || 'Untitled') + '</div>' +
        '<div class="trigger-schedule">' + esc(formatSchedule(trigger.schedule)) + '</div>' +
        '<div class="trigger-prompt-preview">' + esc(truncate(trigger.prompt || '', 100)) + '</div>' +
      '</div>' +
      '<div class="trigger-actions">' +
        '<button class="trigger-btn edit">Edit</button>' +
        '<button class="trigger-btn delete">Delete</button>' +
      '</div>';
    const toggleInput = card.querySelector('input[type="checkbox"]');
    toggleInput.addEventListener('change', () => onToggleTrigger(trigger.id, toggleInput.checked));
    card.querySelector('.trigger-btn.edit').addEventListener('click', () => openTriggerForm(trigger));
    card.querySelector('.trigger-btn.delete').addEventListener('click', () => onDeleteTrigger(trigger.id, trigger.name));
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

function showTriggersView() {
  document.getElementById('triggers-view').classList.remove('hidden');
  document.getElementById('trigger-form').classList.add('hidden');
}

function showTriggerForm() {
  document.getElementById('triggers-view').classList.add('hidden');
  document.getElementById('trigger-form').classList.remove('hidden');
}

function openTriggerForm(trigger) {
  editingTriggerId = trigger ? trigger.id : null;
  document.getElementById('trigger-form-title').textContent = trigger ? 'Edit Trigger' : 'New Trigger';
  document.getElementById('tf-name').value = trigger ? trigger.name : '';
  document.getElementById('tf-prompt').value = trigger ? trigger.prompt : '';

  const schedule = trigger ? trigger.schedule : { type: 'interval', intervalMinutes: 1440 };
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

  updateScheduleFields();
  showTriggerForm();
}

function updateScheduleFields() {
  const type = document.getElementById('tf-type').value;
  document.getElementById('tf-interval-group').classList.toggle('hidden', type !== 'interval');
  document.getElementById('tf-time-group').classList.toggle('hidden', type !== 'daily' && type !== 'weekly');
  document.getElementById('tf-day-group').classList.toggle('hidden', type !== 'weekly');
  document.getElementById('tf-datetime-group').classList.toggle('hidden', type !== 'once');
}

async function saveTriggerForm() {
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
  }

  const trigger = {
    id: editingTriggerId || ('t_' + Math.random().toString(36).slice(2, 10)),
    name,
    prompt,
    enabled: true,
    schedule,
    lastFiredAt: null,
    createdAt: new Date().toISOString(),
  };

  // Preserve existing fields when editing
  if (editingTriggerId) {
    const existing = triggersCache.find(t => t.id === editingTriggerId);
    if (existing) {
      trigger.lastFiredAt = existing.lastFiredAt;
      trigger.createdAt = existing.createdAt;
      trigger.enabled = existing.enabled;
    }
  }

  const saveBtn = document.getElementById('btn-trigger-save');
  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;
  try {
    await window.electronAPI.saveTrigger(trigger);
    await loadTriggers();
  } catch (err) {
    alert('Failed to save: ' + (err.message || 'Unknown error'));
  } finally {
    saveBtn.textContent = 'Save Trigger';
    saveBtn.disabled = false;
  }
}

async function onDeleteTrigger(id, name) {
  if (!confirm('Delete trigger "' + name + '"?')) return;
  try {
    await window.electronAPI.deleteTrigger(id);
    await loadTriggers();
  } catch (err) {
    alert('Failed to delete: ' + (err.message || 'Unknown error'));
  }
}

async function onToggleTrigger(id, enabled) {
  try {
    await window.electronAPI.toggleTrigger(id, enabled);
    const t = triggersCache.find(t => t.id === id);
    if (t) t.enabled = enabled;
    renderTriggersList();
  } catch (err) {
    alert('Failed to toggle: ' + (err.message || 'Unknown error'));
  }
}

// Wire up trigger form events
document.getElementById('btn-add-trigger')?.addEventListener('click', () => openTriggerForm(null));
document.getElementById('btn-trigger-cancel')?.addEventListener('click', showTriggersView);
document.getElementById('btn-trigger-form-cancel')?.addEventListener('click', showTriggersView);
document.getElementById('btn-trigger-save')?.addEventListener('click', saveTriggerForm);
document.getElementById('tf-type')?.addEventListener('change', updateScheduleFields);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
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
