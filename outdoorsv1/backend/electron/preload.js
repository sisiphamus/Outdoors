/**
 * Outdoors — Electron Preload Script
 *
 * Exposes IPC bridge to the setup wizard and dashboard renderers.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Dependency installation
  installSystemDeps: () => ipcRenderer.invoke('install-system-deps'),
  installNodeDeps: () => ipcRenderer.invoke('install-node-deps'),
  installClaudeCLI: () => ipcRenderer.invoke('install-claude-cli'),
  checkClaudeInstalled: () => ipcRenderer.invoke('check-claude-installed'),
  checkUvxInstalled: () => ipcRenderer.invoke('check-uvx-installed'),
  installUvx: () => ipcRenderer.invoke('install-uvx'),
  precacheWorkspaceMcp: () => ipcRenderer.invoke('precache-workspace-mcp'),
  installWhisper: () => ipcRenderer.invoke('install-whisper'),

  // Claude authentication
  checkClaudeAuth: () => ipcRenderer.invoke('check-claude-auth'),
  startClaudeAuth: () => ipcRenderer.invoke('start-claude-auth'),
  cancelAuthPoll: () => ipcRenderer.invoke('cancel-auth-poll'),

  // Browser + Google setup (merged)
  detectBrowser: () => ipcRenderer.invoke('detect-browser'),
  createAutomationProfile: (data) => ipcRenderer.invoke('create-automation-profile', data),
  closeAutomationChrome: () => ipcRenderer.invoke('close-automation-chrome'),
  checkGoogleCreds: () => ipcRenderer.invoke('check-google-creds'),
  startGoogleAuth: (services) => ipcRenderer.invoke('start-google-auth', services),
  onGoogleAuthComplete: (callback) => ipcRenderer.on('google-auth-complete', (_event, data) => callback(data)),

  // Onboarding scan
  runOnboardingScan: (services) => ipcRenderer.invoke('run-onboarding-scan', services),
  onOnboardingProgress: (callback) => ipcRenderer.on('onboarding-progress', (_event, data) => callback(data)),
  getOnboardingScanState: () => ipcRenderer.invoke('get-onboarding-scan-state'),
  onOnboardingScanState: (callback) => ipcRenderer.on('onboarding-scan-state', (_event, data) => callback(data)),
  runFilesystemIndex: () => ipcRenderer.invoke('run-filesystem-index'),

  // Backend
  startBackend: () => ipcRenderer.invoke('start-backend'),
  stopBackend: () => ipcRenderer.invoke('stop-backend'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  // Setup lifecycle
  completeSetup: () => ipcRenderer.invoke('complete-setup'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // Dashboard
  onClaudeAuthStatus: (callback) => ipcRenderer.on('claude-auth-status', (_event, data) => callback(data)),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  listMemoryFiles: () => ipcRenderer.invoke('list-memory-files'),
  readMemoryFile: (relativePath) => ipcRenderer.invoke('read-memory-file', relativePath),
  saveMemoryFile: (relativePath, content) => ipcRenderer.invoke('save-memory-file', relativePath, content),
  getConfig: () => ipcRenderer.invoke('get-full-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-full-config', data),

  // Triggers
  getTriggers: () => ipcRenderer.invoke('get-triggers'),
  saveTrigger: (trigger) => ipcRenderer.invoke('save-trigger', trigger),
  deleteTrigger: (triggerId) => ipcRenderer.invoke('delete-trigger', triggerId),
  toggleTrigger: (triggerId, enabled) => ipcRenderer.invoke('toggle-trigger', triggerId, enabled),

  // Outputs
  listOutputFiles: () => ipcRenderer.invoke('list-output-files'),
  readOutputFile: (relativePath) => ipcRenderer.invoke('read-output-file', relativePath),
  getOutputFilePath: (relativePath) => ipcRenderer.invoke('get-output-file-path', relativePath),
  saveOutputFile: (relativePath, content) => ipcRenderer.invoke('save-output-file', relativePath, content),
  deleteOutputFile: (relativePath) => ipcRenderer.invoke('delete-output-file', relativePath),
  openOutputFile: (relativePath) => ipcRenderer.invoke('open-output-file', relativePath),
});
