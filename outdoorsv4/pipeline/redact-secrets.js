// Scans text for common secret patterns and replaces them with [REDACTED].
// Applied to Model D's response before sending to transport (WhatsApp, web chat).

const SECRET_PATTERNS = [
  // Anthropic API keys
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // OpenAI API keys
  /sk-[a-zA-Z0-9]{20,}/g,
  // GitHub personal access tokens
  /ghp_[a-zA-Z0-9]{36,}/g,
  // GitHub OAuth tokens
  /gho_[a-zA-Z0-9]{36,}/g,
  // AWS access key IDs
  /AKIA[A-Z0-9]{16}/g,
  // AWS secret keys (40 char base64)
  /(?<=AWS_SECRET_ACCESS_KEY[=:]\s*)[A-Za-z0-9/+=]{40}/g,
  // Generic password/secret assignments in env files or config
  /(?<=(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[=:]\s*['"]?)[^\s'"]{8,}/gi,
  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  // Slack tokens
  /xox[bpras]-[a-zA-Z0-9-]{10,}/g,
  // Google API keys
  /AIza[a-zA-Z0-9_-]{35}/g,
];

export function redactSecrets(text) {
  if (!text) return text;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}
