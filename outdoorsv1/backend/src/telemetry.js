// Anonymous usage telemetry — counts and durations only, no content.
// Sends a periodic summary to the Outdoors telemetry endpoint.
// No prompts, responses, tool inputs, file paths, or personal data are ever sent.

const TELEMETRY_URL = 'https://outdoors-telemetry.tomtuk665.workers.dev/v1/report';
const REPORT_INTERVAL_MS = 60 * 60 * 1000; // every hour
const SESSION_START = Date.now();

let stats = createEmptyStats();

function createEmptyStats() {
  return {
    tasks: 0,           // number of messages processed
    totalDurationMs: 0,  // sum of response times
    errors: 0,           // number of errors
    byPlatform: { whatsapp: 0, web: 0 },
    toolCalls: 0,        // total tool invocations
    costUsd: 0,          // total cost
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
  };
}

// Call this after each task completes
export function recordTask({ durationMs, platform, toolCount, cost, inputTokens, outputTokens, cacheTokens, hasError }) {
  stats.tasks++;
  stats.totalDurationMs += durationMs || 0;
  if (hasError) stats.errors++;
  if (platform === 'whatsapp') stats.byPlatform.whatsapp++;
  else stats.byPlatform.web++;
  stats.toolCalls += toolCount || 0;
  stats.costUsd += cost || 0;
  stats.inputTokens += inputTokens || 0;
  stats.outputTokens += outputTokens || 0;
  stats.cacheTokens += cacheTokens || 0;
}

async function sendReport() {
  if (stats.tasks === 0) return; // nothing to report

  const report = {
    v: 1,
    uptimeMs: Date.now() - SESSION_START,
    ...stats,
    avgDurationMs: stats.tasks > 0 ? Math.round(stats.totalDurationMs / stats.tasks) : 0,
  };

  // Reset for next period
  const sent = { ...stats };
  stats = createEmptyStats();

  try {
    await fetch(TELEMETRY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Silently fail — telemetry is best-effort
    // Restore stats so they're not lost
    stats.tasks += sent.tasks;
    stats.totalDurationMs += sent.totalDurationMs;
    stats.errors += sent.errors;
    stats.byPlatform.whatsapp += sent.byPlatform.whatsapp;
    stats.byPlatform.web += sent.byPlatform.web;
    stats.toolCalls += sent.toolCalls;
    stats.costUsd += sent.costUsd;
    stats.inputTokens += sent.inputTokens;
    stats.outputTokens += sent.outputTokens;
    stats.cacheTokens += sent.cacheTokens;
  }
}

// Start periodic reporting
setInterval(sendReport, REPORT_INTERVAL_MS);

// Also send on process exit
process.on('beforeExit', () => { sendReport().catch(() => {}); });
