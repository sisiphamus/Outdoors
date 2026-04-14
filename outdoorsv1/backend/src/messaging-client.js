/**
 * Messaging transport abstraction layer.
 *
 * On macOS: uses iMessage (AppleScript + SQLite).
 * On Windows/Linux: uses WhatsApp (Baileys).
 *
 * Uses static imports and runtime selection (not top-level await) to avoid
 * deadlocking with the circular index.js ↔ whatsapp-client.js import chain.
 */

import * as waTransport from './whatsapp-client.js';
// iMessage transport is only loaded on macOS. On Windows/Linux it's not used.
// We lazy-require it to avoid any AppleScript/sqlite side effects on other OSes.
let imTransport = null;

const IS_MAC = process.platform === 'darwin';

if (IS_MAC) {
  // Dynamic import is fine here — fires asynchronously but callers on macOS
  // can tolerate a brief delay; getStatus/getLastQR fall through to whatsapp
  // shape if the iMessage module hasn't resolved yet (defensive).
  console.log('[messaging] macOS detected — using iMessage transport');
  import('./imessage-client.js').then(m => { imTransport = m; }).catch(err => {
    console.error('[messaging] iMessage transport failed to load:', err.message);
  });
} else {
  console.log('[messaging] Non-macOS detected — using WhatsApp transport');
}

function activeTransport() {
  if (IS_MAC && imTransport) return imTransport;
  return waTransport;
}

export function startWhatsApp() {
  return activeTransport().startWhatsApp();
}

export function setSocketIO(socketIO, logBufferPush) {
  return activeTransport().setSocketIO(socketIO, logBufferPush);
}

export function getStatus() {
  return activeTransport().getStatus();
}

export function getLastQR() {
  return activeTransport().getLastQR();
}

export function reconnectWhatsApp() {
  return activeTransport().reconnectWhatsApp();
}

export function sendToOutdoorsGroup(text) {
  return activeTransport().sendToOutdoorsGroup(text);
}

export function getTransportType() {
  return IS_MAC ? 'imessage' : 'whatsapp';
}
