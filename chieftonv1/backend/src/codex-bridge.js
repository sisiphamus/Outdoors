import * as chieftonv4 from '../../../chieftonv4/index.js';

export function executeCodexPrompt(prompt, options) {
  return chieftonv4.executeCodexPrompt(prompt, options);
}

export function killProcess(key) {
  return chieftonv4.killProcess(key);
}

export function hasActiveProcess(key) {
  return chieftonv4.hasActiveProcess(key);
}

export function codeAgentOptions(baseOptions, modelOverride) {
  return chieftonv4.codeAgentOptions(baseOptions, modelOverride);
}

export function employeeAgentOptions(employeeName, baseOptions, modelOverride) {
  return chieftonv4.employeeAgentOptions(employeeName, baseOptions, modelOverride);
}

export function getEmployeeMode(employeeName) {
  return chieftonv4.getEmployeeMode(employeeName);
}

export function setProcessChangeListener(fn) {
  return chieftonv4.setProcessChangeListener(fn);
}

export function setProcessActivityListener(fn) {
  return chieftonv4.setProcessActivityListener(fn);
}

export function getActiveProcessSummary() {
  return chieftonv4.getActiveProcessSummary();
}

export function getClarificationState(key) {
  return chieftonv4.getClarificationState(key);
}

export function clearClarificationState(key) {
  return chieftonv4.clearClarificationState(key);
}
