// Drop-in replacement for chieftonv1/backend/src/claude-bridge.js
// Adds chieftonv4 support via CHIEFTON_V4_ENABLED env var.
// Copy this to chieftonv1/backend/src/claude-bridge.js when ready to switch.
//
// Defaults:
//   - CHIEFTON_V4_ENABLED=true  → uses chieftonv4
//   - CHIEFTON_V3_ENABLED=true  → uses chieftonv3
//   - Neither                 → uses chieftonv3 (safe default)

import * as chieftonv2 from '../../../chieftonv2/index.js';
import * as chieftonv3 from '../../../chieftonv3/index.js';
import * as chieftonv4 from '../../../chieftonv4/index.js';

function useV4() {
  const raw = String(process.env.CHIEFTON_V4_ENABLED || '').trim().toLowerCase();
  if (!raw) return false;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function useV3() {
  const raw = String(process.env.CHIEFTON_V3_ENABLED || '').trim().toLowerCase();
  if (!raw) return true;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function bridge() {
  if (useV4()) return chieftonv4;
  return useV3() ? chieftonv3 : chieftonv2;
}

export function executeClaudePrompt(prompt, options) {
  return bridge().executeClaudePrompt(prompt, options);
}

export function killProcess(key) {
  return bridge().killProcess(key);
}

export function codeAgentOptions(baseOptions, modelOverride) {
  return bridge().codeAgentOptions(baseOptions, modelOverride);
}

export function employeeAgentOptions(employeeName, baseOptions, modelOverride) {
  return bridge().employeeAgentOptions(employeeName, baseOptions, modelOverride);
}

export function getEmployeeMode(employeeName) {
  return bridge().getEmployeeMode(employeeName);
}

export function setProcessChangeListener(fn) {
  return bridge().setProcessChangeListener(fn);
}

export function setProcessActivityListener(fn) {
  return bridge().setProcessActivityListener(fn);
}

export function getActiveProcessSummary() {
  return bridge().getActiveProcessSummary();
}

export function getClarificationState(key) {
  return bridge().getClarificationState(key);
}

export function clearClarificationState(key) {
  return bridge().clearClarificationState(key);
}
