/**
 * Outdoors — Electron Preload Script
 *
 * Exposes IPC bridge to the setup wizard renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Dependency installation
  installNodeDeps: () => ipcRenderer.invoke('install-node-deps'),
  installClaudeCLI: () => ipcRenderer.invoke('install-claude-cli'),
  checkClaudeInstalled: () => ipcRenderer.invoke('check-claude-installed'),

  // Claude authentication
  checkClaudeAuth: () => ipcRenderer.invoke('check-claude-auth'),
  startClaudeAuth: () => ipcRenderer.invoke('start-claude-auth'),
  cancelAuthPoll: () => ipcRenderer.invoke('cancel-auth-poll'),

  // Backend
  startBackend: () => ipcRenderer.invoke('start-backend'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  // Setup lifecycle
  completeSetup: () => ipcRenderer.invoke('complete-setup'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
});
