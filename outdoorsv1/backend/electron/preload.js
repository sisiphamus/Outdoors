/**
 * Outdoors — Electron Preload Script
 *
 * Exposes IPC bridge to the setup wizard and dashboard renderers.
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

  // Browser setup
  detectBrowser: () => ipcRenderer.invoke('detect-browser'),
  createAutomationProfile: (data) => ipcRenderer.invoke('create-automation-profile', data),
  launchAutomationChrome: (exePath) => ipcRenderer.invoke('launch-automation-chrome', exePath),
  checkBrowserAuth: () => ipcRenderer.invoke('check-browser-auth'),
  closeAutomationChrome: () => ipcRenderer.invoke('close-automation-chrome'),

  // Google Account Access
  checkGoogleCreds: () => ipcRenderer.invoke('check-google-creds'),
  startGoogleAuth: (services) => ipcRenderer.invoke('start-google-auth', services),
  onGoogleAuthComplete: (callback) => ipcRenderer.on('google-auth-complete', (_event, data) => callback(data)),

  // Onboarding scan
  runOnboardingScan: (services) => ipcRenderer.invoke('run-onboarding-scan', services),
  onOnboardingProgress: (callback) => ipcRenderer.on('onboarding-progress', (_event, data) => callback(data)),

  // Backend
  startBackend: () => ipcRenderer.invoke('start-backend'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  // Setup lifecycle
  completeSetup: () => ipcRenderer.invoke('complete-setup'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // Dashboard
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  listMemoryFiles: () => ipcRenderer.invoke('list-memory-files'),
  readMemoryFile: (relativePath) => ipcRenderer.invoke('read-memory-file', relativePath),
  saveMemoryFile: (relativePath, content) => ipcRenderer.invoke('save-memory-file', relativePath, content),
  getConfig: () => ipcRenderer.invoke('get-full-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-full-config', data),
});
