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
      clearWelcome();
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
  clearWelcome();

  const d = entry.data || {};
  const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : now();

  switch (entry.type) {
    case 'incoming': {
      const sender = d.sender || 'unknown';
      const prompt = d.prompt || '';
      addFeedIncoming(ts, sender, prompt);
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
      addFeedSent(ts, to, d.responseLength || 0);
      break;
    }
    case 'response': {
      const rLen = d.responseLength || 0;
      if (rLen > 0) addFeedEntry('info', 'Response sent (' + rLen + ' chars)');
      break;
    }
    case 'connected':
      setStatus('connected', 'WhatsApp connected');
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

function addFeedIncoming(ts, sender, prompt) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry feed-incoming';
  entry.innerHTML = '<span class="feed-time">' + ts + '</span>' +
    '<span class="feed-incoming-label">' + esc(sender) + '</span> ' +
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

function addFeedSent(ts, to, len) {
  const feed = document.getElementById('feed');
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  entry.innerHTML = '<span class="feed-time">' + ts + '</span><span class="feed-info">Sent to ' + esc(to.split('@')[0] || to) + ' (' + len + ' chars)</span>';
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

function setupTitlebar() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimizeWindow());
  document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.closeWindow());
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
    });
  });
  document.getElementById('btn-save-config').addEventListener('click', saveConfig);
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
  if (memoryDirty && !confirm('You have unsaved changes. Discard?')) return;
  memoryDirty = false;
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

function buildTree(container, items) {
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
  for (const f of sorted) container.appendChild(buildFolder(f, folders[f], 0));
  topFiles.forEach(item => container.appendChild(makeFileBtn(item, 14)));
}

function buildFolder(name, items, depth) {
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
  directFiles.forEach(item => children.appendChild(makeFileBtn(item, 28 + depth * 14)));
  for (const sub of Object.keys(subFolders).sort()) {
    const subItems = subFolders[sub];
    if (subItems.length === 1) {
      const btn = makeFileBtn(subItems[0], 28 + depth * 14);
      btn.textContent = sub + '/' + subItems[0].name;
      children.appendChild(btn);
    } else {
      children.appendChild(buildFolder(sub, subItems.map(item => ({
        ...item, relativePath: item.relativePath.split('/').slice(1).join('/')
      })), depth + 1));
    }
  }
  el.appendChild(label);
  el.appendChild(children);
  return el;
}

function makeFileBtn(item, paddingLeft) {
  const btn = document.createElement('button');
  btn.className = 'memory-file';
  btn.style.paddingLeft = paddingLeft + 'px';
  btn.textContent = item.name;
  btn.title = item.relativePath;
  btn.addEventListener('click', () => openMemoryFile(item.relativePath, btn));
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
// Helpers
// ---------------------------------------------------------------------------

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
