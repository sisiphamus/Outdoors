import * as outdoorsv4 from '../../../outdoorsv4/index.js';

export function executeCodexPrompt(prompt, options) {
  return outdoorsv4.executeCodexPrompt(prompt, options);
}

export function killProcess(key) {
  return outdoorsv4.killProcess(key);
}

export function hasActiveProcess(key) {
  return outdoorsv4.hasActiveProcess(key);
}

export function codeAgentOptions(baseOptions, modelOverride) {
  return outdoorsv4.codeAgentOptions(baseOptions, modelOverride);
}

export function employeeAgentOptions(employeeName, baseOptions, modelOverride) {
  return outdoorsv4.employeeAgentOptions(employeeName, baseOptions, modelOverride);
}

export function getEmployeeMode(employeeName) {
  return outdoorsv4.getEmployeeMode(employeeName);
}

export function setProcessChangeListener(fn) {
  return outdoorsv4.setProcessChangeListener(fn);
}

export function setProcessActivityListener(fn) {
  return outdoorsv4.setProcessActivityListener(fn);
}

export function getActiveProcessSummary() {
  return outdoorsv4.getActiveProcessSummary();
}

export function getClarificationState(key) {
  return outdoorsv4.getClarificationState(key);
}

export function clearClarificationState(key) {
  return outdoorsv4.clearClarificationState(key);
}
