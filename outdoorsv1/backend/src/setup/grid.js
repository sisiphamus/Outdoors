/* Bot grid UI — renders 8 tiles, handles zoom (pinch/wheel+ctrl) to expand a
 * tile into the chat view, drag-to-reorder via the tile's grip handle, and
 * edit/delete through a context menu. Persists everything via the `grid:*`
 * socket events exposed by index.js. */

(function () {
  'use strict';

  // Wait for DOM + dashboard socket init to finish.
  document.addEventListener('DOMContentLoaded', function () {
    // dashboard.js owns the socket connection and exposes it on window.__socket
    // (we patch dashboard.js separately to expose it). We poll briefly if it
    // isn't available yet.
    let socket = null;
    function ensureSocket(cb) {
      if (window.__socket) return cb(window.__socket);
      let tries = 0;
      const t = setInterval(function () {
        tries++;
        if (window.__socket) { clearInterval(t); cb(window.__socket); return; }
        if (tries > 40) { clearInterval(t); console.warn('[grid] Socket not available after 2s, grid will reconnect on event'); }
      }, 50);
    }

    ensureSocket(function (s) { socket = s; init(); });

    // State
    let grid = null;
    let templates = [];
    let currentBotId = null;        // bot currently zoomed-in (chat panel open)
    let modalMode = null;           // 'create' | 'edit'
    let modalSlotIndex = null;      // for create
    let modalBotId = null;          // for edit
    let dragFromIdx = null;
    let contextMenuBotId = null;

    // DOM refs
    const main = document.getElementById('main-content');
    const tilesEl = document.getElementById('grid-tiles');
    const chatPanel = document.getElementById('chat-panel');
    const backBtn = document.getElementById('btn-chat-back');
    const chatNameEl = document.getElementById('chat-panel-name');
    const chatEmojiEl = document.getElementById('chat-panel-emoji');
    const chatProjectEl = document.getElementById('chat-panel-project');
    const modal = document.getElementById('bot-modal');
    const modalTitle = document.getElementById('bot-modal-title');
    const modalSubmit = document.getElementById('bot-modal-submit');
    const modalCancel = document.getElementById('bot-modal-cancel');
    const modalClose = document.getElementById('bot-modal-close');
    const modalTabsEl = document.getElementById('bot-modal-tabs');
    const templateGrid = document.getElementById('template-grid');
    const scratchName = document.getElementById('scratch-name');
    const scratchEmoji = document.getElementById('scratch-emoji');
    const scratchProject = document.getElementById('scratch-project');
    const scratchSpec = document.getElementById('scratch-spec');
    const scratchHint = document.getElementById('scratch-hint');
    const ctxMenu = document.getElementById('bot-context-menu');

    let selectedTemplateId = null;
    let activeTab = 'templates';

    function init() {
      socket.emit('grid:load', function (resp) {
        if (resp?.ok) {
          grid = resp.grid;
          templates = resp.templates || [];
          renderTemplates();
          renderGrid();
        } else {
          console.error('[grid] Failed to load grid:', resp?.error);
        }
      });

      socket.on('grid:updated', function (payload) {
        if (payload?.grid) {
          grid = payload.grid;
          renderGrid();
        }
      });

      // Zoom gestures + keyboard
      attachZoomGestures();
      attachKeyboard();
      attachModal();
      attachContextMenu();
      attachBack();
    }

    // ── Rendering ────────────────────────────────────────────────────────

    function renderGrid() {
      if (!grid) return;
      tilesEl.innerHTML = '';
      for (const slot of [...grid.slots].sort((a, b) => a.slotIndex - b.slotIndex)) {
        tilesEl.appendChild(renderTile(slot));
      }
    }

    function renderTile(slot) {
      const tile = document.createElement('div');
      tile.dataset.slotIndex = String(slot.slotIndex);
      if (!slot.botId) {
        tile.className = 'bot-tile empty';
        tile.innerHTML = '<div class="empty-plus">+</div><div>Add bot</div>';
        tile.addEventListener('click', function () { openCreateModal(slot.slotIndex); });
        return tile;
      }

      tile.className = 'bot-tile';
      tile.dataset.botId = slot.botId;
      if (slot.color) tile.style.borderColor = hexToRgba(slot.color, 0.25);
      if (grid.activeBotId === slot.botId) tile.classList.add('active');

      tile.innerHTML =
        '<div class="bot-tile-emoji">' + escapeHtml(slot.emoji || '🤖') + '</div>' +
        '<div class="bot-tile-indicator"></div>' +
        '<button class="bot-tile-handle" title="Drag to reorder" aria-label="Drag handle">' +
          '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">' +
            '<circle cx="3" cy="3" r="1"/><circle cx="9" cy="3" r="1"/>' +
            '<circle cx="3" cy="6" r="1"/><circle cx="9" cy="6" r="1"/>' +
            '<circle cx="3" cy="9" r="1"/><circle cx="9" cy="9" r="1"/>' +
          '</svg>' +
        '</button>' +
        '<h3 class="bot-tile-name">' + escapeHtml(slot.name || 'Bot') + '</h3>' +
        '<div class="bot-tile-project">' + escapeHtml(slot.project || '') + '</div>';

      tile.addEventListener('click', function (e) {
        if (e.target.closest('.bot-tile-handle')) return; // drag, not click
        zoomIntoBot(slot.botId);
      });
      tile.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openContextMenu(slot.botId, e.clientX, e.clientY);
      });

      // Drag handle
      const handle = tile.querySelector('.bot-tile-handle');
      handle.draggable = true;
      handle.addEventListener('dragstart', function (e) {
        dragFromIdx = slot.slotIndex;
        tile.classList.add('drag-origin');
        try { e.dataTransfer.setData('text/plain', String(slot.slotIndex)); } catch {}
        e.dataTransfer.effectAllowed = 'move';
      });
      handle.addEventListener('dragend', function () {
        tile.classList.remove('drag-origin');
        dragFromIdx = null;
        tilesEl.querySelectorAll('.drop-target').forEach(function (el) { el.classList.remove('drop-target'); });
      });
      // Every tile is a drop target
      tile.addEventListener('dragover', function (e) {
        if (dragFromIdx !== null && dragFromIdx !== slot.slotIndex) {
          e.preventDefault();
          tile.classList.add('drop-target');
        }
      });
      tile.addEventListener('dragleave', function () { tile.classList.remove('drop-target'); });
      tile.addEventListener('drop', function (e) {
        e.preventDefault();
        tile.classList.remove('drop-target');
        if (dragFromIdx === null || dragFromIdx === slot.slotIndex) return;
        socket.emit('grid:move', { fromIdx: dragFromIdx, toIdx: slot.slotIndex }, function (resp) {
          if (!resp?.ok) console.warn('[grid] Move failed:', resp?.error);
        });
      });

      return tile;
    }

    function renderTemplates() {
      if (!templateGrid) return;
      templateGrid.innerHTML = '';
      for (const tpl of templates) {
        const card = document.createElement('button');
        card.className = 'template-card';
        card.dataset.templateId = tpl.id;
        card.innerHTML =
          '<div class="template-card-emoji">' + escapeHtml(tpl.emoji) + '</div>' +
          '<div class="template-card-name">' + escapeHtml(tpl.name) + '</div>' +
          '<div class="template-card-skills">Skills: ' + (tpl.skillIds || []).map(escapeHtml).join(', ') + '</div>';
        card.addEventListener('click', function () {
          selectedTemplateId = tpl.id;
          templateGrid.querySelectorAll('.template-card').forEach(function (c) { c.classList.toggle('selected', c === card); });
          updateSubmitDisabled();
        });
        templateGrid.appendChild(card);
      }
    }

    // ── Modal: create / edit bot ────────────────────────────────────────

    function openCreateModal(slotIndex) {
      modalMode = 'create';
      modalSlotIndex = slotIndex;
      modalBotId = null;
      selectedTemplateId = null;
      activeTab = 'templates';

      modalTitle.textContent = 'Add a bot';
      modalSubmit.textContent = 'Create bot';
      setModalTab('templates');
      templateGrid.querySelectorAll('.template-card').forEach(function (c) { c.classList.remove('selected'); });
      scratchName.value = '';
      scratchEmoji.value = '🤖';
      scratchProject.value = '';
      scratchSpec.value = '';
      scratchHint.textContent = '';
      updateSubmitDisabled();
      modal.classList.remove('hidden');
      setTimeout(function () { (activeTab === 'templates' ? templateGrid : scratchName).focus?.(); }, 30);
    }

    function openEditModal(botId) {
      const slot = grid.slots.find(function (s) { return s.botId === botId; });
      if (!slot) return;
      modalMode = 'edit';
      modalBotId = botId;
      modalSlotIndex = slot.slotIndex;
      activeTab = 'scratch';

      modalTitle.textContent = 'Edit bot';
      modalSubmit.textContent = 'Save';
      setModalTab('scratch');
      scratchName.value = slot.name || '';
      scratchEmoji.value = slot.emoji || '🤖';
      scratchProject.value = slot.project || '';
      // Fetch specialization text — grid-manager exposes it via grid-config? No — it's on disk only.
      // For simplicity we ask the user to re-describe if they want to change the specialization.
      scratchSpec.value = '';
      scratchSpec.placeholder = 'Leave blank to keep the current specialization, or type new text to replace it.';
      scratchHint.textContent = '';
      updateSubmitDisabled();
      modal.classList.remove('hidden');
    }

    function closeModal() {
      modal.classList.add('hidden');
      modalMode = null;
      modalSlotIndex = null;
      modalBotId = null;
      selectedTemplateId = null;
    }

    function setModalTab(tab) {
      activeTab = tab;
      modalTabsEl.querySelectorAll('.bot-modal-tab').forEach(function (el) {
        el.classList.toggle('active', el.dataset.botTab === tab);
      });
      modal.querySelectorAll('.bot-modal-pane').forEach(function (el) {
        el.classList.toggle('active', el.dataset.botPane === tab);
      });
      updateSubmitDisabled();
    }

    function updateSubmitDisabled() {
      if (modalMode === 'edit') {
        modalSubmit.disabled = false;
        return;
      }
      if (activeTab === 'templates') {
        modalSubmit.disabled = !selectedTemplateId;
      } else {
        const hasName = scratchName.value.trim().length > 0;
        const hasSpec = scratchSpec.value.trim().length > 0;
        modalSubmit.disabled = !(hasName && hasSpec);
      }
    }

    function submitModal() {
      if (modalMode === 'create') {
        if (activeTab === 'templates') {
          if (!selectedTemplateId) return;
          socket.emit('grid:create', {
            slotIndex: modalSlotIndex,
            templateId: selectedTemplateId,
          }, function (resp) {
            if (!resp?.ok) {
              scratchHint.textContent = 'Create failed: ' + (resp?.error || 'unknown');
              return;
            }
            closeModal();
          });
        } else {
          const spec = scratchSpec.value.trim();
          const name = scratchName.value.trim();
          if (!spec || !name) return;
          scratchHint.textContent = 'Picking skills…';
          modalSubmit.disabled = true;
          socket.emit('grid:create', {
            slotIndex: modalSlotIndex,
            name: name,
            emoji: scratchEmoji.value.trim() || '🤖',
            project: scratchProject.value.trim(),
            specializationText: spec,
          }, function (resp) {
            if (!resp?.ok) {
              scratchHint.textContent = 'Create failed: ' + (resp?.error || 'unknown');
              modalSubmit.disabled = false;
              return;
            }
            closeModal();
          });
        }
      } else if (modalMode === 'edit') {
        const patch = {};
        if (scratchName.value.trim()) patch.name = scratchName.value.trim();
        if (scratchEmoji.value.trim()) patch.emoji = scratchEmoji.value.trim();
        patch.project = scratchProject.value.trim();
        const newSpec = scratchSpec.value.trim();
        if (newSpec) patch.specializationText = newSpec;
        socket.emit('grid:edit', { botId: modalBotId, patch: patch }, function (resp) {
          if (!resp?.ok) {
            scratchHint.textContent = 'Save failed: ' + (resp?.error || 'unknown');
            return;
          }
          closeModal();
        });
      }
    }

    function attachModal() {
      modalTabsEl.addEventListener('click', function (e) {
        const tab = e.target.closest('.bot-modal-tab');
        if (!tab) return;
        setModalTab(tab.dataset.botTab);
      });
      modalCancel.addEventListener('click', closeModal);
      modalClose.addEventListener('click', closeModal);
      modalSubmit.addEventListener('click', submitModal);
      [scratchName, scratchSpec, scratchEmoji, scratchProject].forEach(function (el) {
        el.addEventListener('input', updateSubmitDisabled);
      });
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeModal();
      });
    }

    // ── Context menu (right-click on a filled tile) ─────────────────────

    function openContextMenu(botId, x, y) {
      contextMenuBotId = botId;
      ctxMenu.style.left = x + 'px';
      ctxMenu.style.top = y + 'px';
      ctxMenu.classList.remove('hidden');
      // Close on next outside click
      setTimeout(function () {
        document.addEventListener('click', closeContextMenuOnce, { once: true });
        document.addEventListener('contextmenu', closeContextMenuOnce, { once: true });
      }, 0);
    }
    function closeContextMenuOnce() { ctxMenu.classList.add('hidden'); contextMenuBotId = null; }
    function attachContextMenu() {
      ctxMenu.addEventListener('click', function (e) {
        const item = e.target.closest('.bot-context-item');
        if (!item || !contextMenuBotId) return;
        const action = item.dataset.contextAction;
        const botId = contextMenuBotId;
        closeContextMenuOnce();
        if (action === 'edit') {
          openEditModal(botId);
        } else if (action === 'delete') {
          if (!confirm('Delete this bot? Its memory will be removed.')) return;
          socket.emit('grid:delete', { botId: botId }, function (resp) {
            if (!resp?.ok) alert('Delete failed: ' + (resp?.error || 'unknown'));
            if (currentBotId === botId) zoomOutToGrid();
          });
        }
      });
    }

    // ── Zoom in / out ───────────────────────────────────────────────────

    function zoomIntoBot(botId) {
      const slot = grid.slots.find(function (s) { return s.botId === botId; });
      if (!slot) return;
      currentBotId = botId;
      chatNameEl.textContent = slot.name || 'Bot';
      chatEmojiEl.textContent = slot.emoji || '🤖';
      chatProjectEl.textContent = slot.project || '';
      chatPanel.setAttribute('aria-hidden', 'false');
      main.classList.remove('grid-mode');
      main.classList.add('chat-mode');
      socket.emit('grid:setActive', { botId: botId });
      // Expose the active bot so dashboard.js's sendChatMessage can pick it up
      window.__activeBotId = botId;
      try { window.dispatchEvent(new CustomEvent('grid:activeBotChanged', { detail: { botId: botId } })); } catch {}
    }

    function zoomOutToGrid() {
      currentBotId = null;
      window.__activeBotId = null;
      main.classList.remove('chat-mode');
      main.classList.add('grid-mode');
      chatPanel.setAttribute('aria-hidden', 'true');
      try { window.dispatchEvent(new CustomEvent('grid:activeBotChanged', { detail: { botId: null } })); } catch {}
    }

    function attachBack() {
      backBtn.addEventListener('click', zoomOutToGrid);
    }

    function attachKeyboard() {
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          if (!modal.classList.contains('hidden')) { closeModal(); return; }
          if (currentBotId) { zoomOutToGrid(); return; }
        }
      });
    }

    // Pinch (touch) + Ctrl+wheel (trackpad) zoom:
    //   zoom in over a tile → zoom into that bot
    //   zoom out while in chat mode → return to grid
    function attachZoomGestures() {
      // Trackpad pinch comes through as wheel events with e.ctrlKey on Win/Mac.
      main.addEventListener('wheel', function (e) {
        if (!e.ctrlKey) return; // regular scroll, let chat panel handle it
        e.preventDefault();
        if (main.classList.contains('chat-mode')) {
          // Zoom-out gesture → leave chat back to grid
          if (e.deltaY > 0) zoomOutToGrid();
        } else {
          // Zoom-in gesture → open the tile under the cursor if any
          if (e.deltaY < 0) {
            const tile = document.elementFromPoint(e.clientX, e.clientY)?.closest('.bot-tile');
            if (tile && tile.dataset.botId) zoomIntoBot(tile.dataset.botId);
          }
        }
      }, { passive: false });

      // Touch: two-finger pinch
      let pinchStartDist = null;
      let pinchStartTile = null;
      main.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 2) return;
        const [a, b] = [e.touches[0], e.touches[1]];
        pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const mx = (a.clientX + b.clientX) / 2;
        const my = (a.clientY + b.clientY) / 2;
        const tile = document.elementFromPoint(mx, my)?.closest('.bot-tile');
        pinchStartTile = (tile && tile.dataset.botId) || null;
      }, { passive: true });
      main.addEventListener('touchmove', function (e) {
        if (e.touches.length !== 2 || pinchStartDist == null) return;
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const delta = dist - pinchStartDist;
        if (main.classList.contains('chat-mode')) {
          if (delta < -40) { zoomOutToGrid(); pinchStartDist = null; }
        } else {
          if (delta > 40 && pinchStartTile) { zoomIntoBot(pinchStartTile); pinchStartDist = null; }
        }
      }, { passive: true });
      main.addEventListener('touchend', function () { pinchStartDist = null; pinchStartTile = null; });
    }

    // ── Utils ───────────────────────────────────────────────────────────

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function hexToRgba(hex, alpha) {
      if (!hex || hex[0] !== '#') return 'rgba(255,255,255,' + alpha + ')';
      const h = hex.slice(1);
      const n = parseInt(h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h, 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
  });
})();
