/**
 * Chiefton — Dev Log Preload Script
 *
 * Exposes IPC bridge for the dev log renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devlogAPI', {
  onStdout: (cb) => ipcRenderer.on('devlog:stdout', (_e, data) => cb(data)),
  onStderr: (cb) => ipcRenderer.on('devlog:stderr', (_e, data) => cb(data)),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
});
