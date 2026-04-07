// Outdoors Telemetry Worker — receives anonymous usage stats, stores in D1.
// POST /v1/report — ingest telemetry
// GET /dashboard — password-protected usage dashboard

// Dashboard password stored as Cloudflare secret (env.DASHBOARD_PASSWORD)
// Set it with: npx wrangler secret put DASHBOARD_PASSWORD

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS for telemetry POSTs
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Ingest telemetry
    if (request.method === 'POST' && url.pathname === '/v1/report') {
      try {
        const data = await request.json();
        await env.DB.prepare(
          `INSERT INTO reports (uptime_ms, tasks, total_duration_ms, avg_duration_ms, errors, wa_count, web_count, tool_calls, cost_usd, input_tokens, output_tokens, cache_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          data.uptimeMs || 0,
          data.tasks || 0,
          data.totalDurationMs || 0,
          data.avgDurationMs || 0,
          data.errors || 0,
          data.byPlatform?.whatsapp || 0,
          data.byPlatform?.web || 0,
          data.toolCalls || 0,
          data.costUsd || 0,
          data.inputTokens || 0,
          data.outputTokens || 0,
          data.cacheTokens || 0,
        ).run();
        return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch (err) {
        return new Response('error: ' + err.message, { status: 500 });
      }
    }

    // Per-message log
    if (request.method === 'POST' && url.pathname === '/v1/message') {
      try {
        const data = await request.json();
        await env.DB.prepare(
          `INSERT INTO messages (timestamp, duration_ms, platform, cost_usd, tokens, status)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          data.timestamp || new Date().toISOString(),
          data.durationMs || 0,
          data.platform || 'unknown',
          data.costUsd || 0,
          data.tokens || 0,
          data.status || 'unknown',
        ).run();
        return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch (err) {
        return new Response('error: ' + err.message, { status: 500 });
      }
    }

    // Bug report
    if (request.method === 'POST' && url.pathname === '/v1/bug') {
      try {
        const data = await request.json();
        await env.DB.prepare(
          `INSERT INTO bug_reports (title, description, severity, platform, node_version, app_version)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          (data.title || '').slice(0, 200),
          (data.description || '').slice(0, 5000),
          data.severity || 'medium',
          data.platform || 'unknown',
          data.nodeVersion || '',
          data.appVersion || '',
        ).run();
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // Dashboard — password protected
    if (url.pathname === '/dashboard') {
      const pw = url.searchParams.get('pw');
      if (!env.DASHBOARD_PASSWORD || pw !== env.DASHBOARD_PASSWORD) {
        return new Response('Unauthorized. Add ?pw=your-password to the URL.', { status: 401 });
      }

      try {
        // Period selector — controls the chart and breakdown table.
        // Cards stay all-time totals (lifetime view).
        const period = parsePeriod(url.searchParams.get('period'));

        // Lifetime totals for the summary cards.
        const totals = await env.DB.prepare(
          `SELECT
            COUNT(*)                                                AS total_tasks,
            ROUND(SUM(cost_usd), 3)                                 AS total_cost,
            ROUND(AVG(duration_ms))                                 AS avg_response,
            SUM(CASE WHEN status = 'FAIL' THEN 1 ELSE 0 END)        AS total_errors,
            SUM(CASE WHEN platform = 'whatsapp' THEN 1 ELSE 0 END)  AS wa_tasks,
            SUM(CASE WHEN platform = 'web'      THEN 1 ELSE 0 END)  AS web_tasks,
            SUM(tokens)                                             AS total_input,
            0                                                       AS total_output,
            0                                                       AS total_cache,
            0                                                       AS total_tools,
            COUNT(*)                                                AS report_count
          FROM messages`
        ).first();

        // Period-windowed buckets for chart + breakdown.
        // 24h → hourly buckets via strftime; daily periods → date() bucket.
        const isHourly = period === '24h';
        const bucketExpr = isHourly
          ? "strftime('%Y-%m-%d %H:00', received_at)"
          : "date(received_at)";
        const whereClause =
          period === '24h' ? "WHERE received_at >= datetime('now', '-24 hours')"
          : period === '7d'  ? "WHERE received_at >= date('now', '-7 days')"
          : period === '30d' ? "WHERE received_at >= date('now', '-30 days')"
          : period === '90d' ? "WHERE received_at >= date('now', '-90 days')"
          : ""; // 'all'
        const limitClause = period === 'all' ? 'LIMIT 365' : '';

        const bucketRows = await env.DB.prepare(
          `SELECT
            ${bucketExpr}                                           AS bucket,
            COUNT(*)                                                AS total_tasks,
            ROUND(SUM(cost_usd), 3)                                 AS total_cost,
            SUM(CASE WHEN status = 'FAIL' THEN 1 ELSE 0 END)        AS total_errors,
            SUM(CASE WHEN platform = 'whatsapp' THEN 1 ELSE 0 END)  AS whatsapp_tasks,
            SUM(CASE WHEN platform = 'web'      THEN 1 ELSE 0 END)  AS web_tasks,
            ROUND(AVG(duration_ms))                                 AS avg_response_ms
          FROM messages
          ${whereClause}
          GROUP BY bucket
          ORDER BY bucket
          ${limitClause}`
        ).all();

        // Pad missing buckets with zero rows so the chart has stable layout.
        const buckets = padBuckets(bucketRows.results || [], period);

        const messages = await env.DB.prepare(
          'SELECT * FROM messages ORDER BY id DESC LIMIT 100'
        ).all().catch(() => ({ results: [] }));

        const bugs = await env.DB.prepare(
          'SELECT * FROM bug_reports ORDER BY id DESC LIMIT 50'
        ).all().catch(() => ({ results: [] }));

        return new Response(renderDashboard(totals, buckets, messages.results, bugs.results, period, pw), {
          headers: { 'Content-Type': 'text/html' },
        });
      } catch (err) {
        return new Response('DB error: ' + err.message, { status: 500 });
      }
    }

    return new Response('Outdoors Telemetry', { status: 200 });
  },
};

function renderDashboard(totals, buckets, messages, bugs, period, pw) {
  const t = totals || {};
  const isHourly = period === '24h';
  const bucketLabel = isHourly ? 'Hour' : 'Date';
  const periodTitle = {
    '24h': 'Last 24 Hours (hourly)',
    '7d':  'Last 7 Days',
    '30d': 'Last 30 Days',
    '90d': 'Last 90 Days',
    'all': 'All Time',
  }[period];
  const periodLink = (p, label) =>
    `<a class="period-link${p === period ? ' active' : ''}" href="?pw=${encodeURIComponent(pw)}&period=${p}">${label}</a>`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Outdoors Telemetry</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 24px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 20px; color: #fff; }
  h2 { font-size: 14px; margin: 20px 0 10px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; text-align: center; }
  .card-value { font-size: 28px; font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
  .card-label { font-size: 11px; color: #666; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px; border-bottom: 1px solid #333; color: #666; font-weight: 500; }
  td { padding: 8px; border-bottom: 1px solid #1a1a1a; }
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 100px; margin-bottom: 16px; padding: 4px 0; border-bottom: 1px solid #1a1a1a; }
  .bar { flex: 1; background: #4a9eff; border-radius: 2px 2px 0 0; min-width: 4px; min-height: 1px; position: relative; }
  .bar.empty { background: #1a1a1a; }
  .bar:hover { opacity: 0.8; }
  .bar-tip { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 3px 8px; border-radius: 3px; font-size: 11px; white-space: nowrap; display: none; z-index: 10; pointer-events: none; }
  .bar:hover .bar-tip { display: block; }
  .period-selector { display: flex; gap: 6px; margin: 8px 0 12px; flex-wrap: wrap; align-items: center; }
  .period-selector .period-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-right: 4px; }
  .period-link { padding: 4px 10px; border: 1px solid #333; border-radius: 4px; color: #888; text-decoration: none; font-size: 12px; font-variant-numeric: tabular-nums; }
  .period-link:hover { color: #fff; border-color: #555; }
  .period-link.active { background: #4a9eff; border-color: #4a9eff; color: #fff; }
  .chart-title { font-size: 11px; color: #555; margin-top: -8px; margin-bottom: 16px; text-align: center; font-variant-numeric: tabular-nums; }
</style>
</head><body>
<h1>Outdoors Telemetry</h1>

<div class="cards">
  <div class="card"><div class="card-value">${t.total_tasks || 0}</div><div class="card-label">Total Tasks</div></div>
  <div class="card"><div class="card-value">$${(t.total_cost || 0).toFixed(2)}</div><div class="card-label">Total Cost</div></div>
  <div class="card"><div class="card-value">${t.avg_response ? Math.round(t.avg_response / 1000) + 's' : '—'}</div><div class="card-label">Avg Response</div></div>
  <div class="card"><div class="card-value">${t.total_errors || 0}</div><div class="card-label">Errors</div></div>
  <div class="card"><div class="card-value">${t.wa_tasks || 0} / ${t.web_tasks || 0}</div><div class="card-label">WA / Web</div></div>
  <div class="card"><div class="card-value">${formatTokens((t.total_input || 0) + (t.total_output || 0))}</div><div class="card-label">Tokens</div></div>
  <div class="card"><div class="card-value">${t.total_tools || 0}</div><div class="card-label">Tool Calls</div></div>
  <div class="card"><div class="card-value">${t.report_count || 0}</div><div class="card-label">Reports</div></div>
</div>

<h2>Activity</h2>
<div class="period-selector">
  <span class="period-label">Range:</span>
  ${periodLink('24h', '24h')}
  ${periodLink('7d',  '7d')}
  ${periodLink('30d', '30d')}
  ${periodLink('90d', '90d')}
  ${periodLink('all', 'All')}
</div>
<div class="chart">
  ${(() => {
    const max = Math.max(1, ...buckets.map(x => x.total_tasks || 0));
    return buckets.map(b => {
      const tasks = b.total_tasks || 0;
      const pct = (tasks / max) * 100;
      const cls = tasks === 0 ? 'bar empty' : 'bar';
      const tipDate = isHourly ? b.bucket : b.bucket;
      return `<div class="${cls}" style="height:${Math.max(pct, 1)}%"><div class="bar-tip">${tipDate}: ${tasks} tasks, $${(b.total_cost || 0).toFixed(2)}</div></div>`;
    }).join('');
  })()}
</div>
<div class="chart-title">${periodTitle} \u00B7 ${buckets.length} ${isHourly ? 'hours' : 'days'}</div>

<h2>Breakdown</h2>
<table>
  <tr><th>${bucketLabel}</th><th>Tasks</th><th>Cost</th><th>Errors</th><th>WA</th><th>Web</th><th>Avg Time</th></tr>
  ${[...buckets].reverse().map(b => `<tr>
    <td>${b.bucket}</td><td>${b.total_tasks || 0}</td><td>$${(b.total_cost || 0).toFixed(2)}</td>
    <td>${b.total_errors || 0}</td><td>${b.whatsapp_tasks || 0}</td><td>${b.web_tasks || 0}</td>
    <td>${b.avg_response_ms ? Math.round(b.avg_response_ms / 1000) + 's' : '—'}</td>
  </tr>`).join('')}
</table>

<h2>Recent Messages (last 100)</h2>
<table>
  <tr><th>Time</th><th>Duration</th><th>Platform</th><th>Cost</th><th>Tokens</th><th>Status</th></tr>
  ${(messages || []).map(m => `<tr>
    <td>${m.timestamp || m.received_at}</td>
    <td>${m.duration_ms ? (m.duration_ms / 1000).toFixed(1) + 's' : '?'}</td>
    <td>${m.platform}</td><td>$${(m.cost_usd || 0).toFixed(3)}</td>
    <td>${formatTokens(m.tokens || 0)}</td><td>${m.status}</td>
  </tr>`).join('')}
</table>

<h2>Bug Reports</h2>
<table>
  <tr><th>Time</th><th>Severity</th><th>Title</th><th>Description</th><th>Platform</th><th>Version</th></tr>
  ${(bugs || []).map(b => `<tr>
    <td>${b.received_at}</td><td>${esc(b.severity)}</td><td>${esc(b.title)}</td>
    <td>${esc((b.description || '').slice(0, 200))}</td><td>${b.platform}</td><td>${b.app_version}</td>
  </tr>`).join('')}
</table>

</body></html>`;
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── Period selector helpers ─────────────────────────────────────────────────
// Whitelist of supported time periods. Anything else falls back to '30d'.
const PERIODS = new Set(['24h', '7d', '30d', '90d', 'all']);
function parsePeriod(raw) {
  return PERIODS.has(raw) ? raw : '30d';
}

// Generate the full set of expected bucket labels for the given period and
// merge in any rows from the DB so empty buckets show up as zeros. Times are
// computed in UTC to match SQLite's date()/datetime('now') which also use UTC.
function padBuckets(rows, period) {
  // Index DB rows by their bucket label for O(1) lookup.
  const byBucket = new Map();
  for (const r of rows) byBucket.set(r.bucket, r);

  // 'all' = whatever the DB returned, no padding (already a complete range
  // by definition for that user). Just sort ascending so the chart reads
  // left-to-right oldest → newest.
  if (period === 'all') {
    return [...rows].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
  }

  const expected = [];
  const now = new Date();
  if (period === '24h') {
    // 24 hourly buckets ending at the current hour, oldest first.
    const startMs = now.getTime() - 23 * 60 * 60 * 1000;
    const start = new Date(startMs);
    start.setUTCMinutes(0, 0, 0);
    for (let i = 0; i < 24; i++) {
      const d = new Date(start.getTime() + i * 60 * 60 * 1000);
      const label = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:00`;
      expected.push(label);
    }
  } else {
    // Daily buckets — N days ending today, oldest first.
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const label = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
      expected.push(label);
    }
  }

  return expected.map(label => byBucket.get(label) || {
    bucket: label,
    total_tasks: 0,
    total_cost: 0,
    total_errors: 0,
    whatsapp_tasks: 0,
    web_tasks: 0,
    avg_response_ms: 0,
  });
}

function pad2(n) { return String(n).padStart(2, '0'); }
