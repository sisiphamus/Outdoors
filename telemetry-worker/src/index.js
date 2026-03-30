// Outdoors Telemetry Worker — receives anonymous usage stats, stores in D1.
// POST /v1/report — ingest telemetry
// GET /dashboard — password-protected usage dashboard

const DASHBOARD_PASSWORD = 'outdoors-admin-2026'; // Change this

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

    // Dashboard — password protected
    if (url.pathname === '/dashboard') {
      const pw = url.searchParams.get('pw');
      if (pw !== DASHBOARD_PASSWORD) {
        return new Response('Unauthorized. Add ?pw=your-password to the URL.', { status: 401 });
      }

      try {
        const daily = await env.DB.prepare(
          'SELECT * FROM daily_summary LIMIT 90'
        ).all();

        const totals = await env.DB.prepare(
          `SELECT
            SUM(tasks) as total_tasks,
            SUM(errors) as total_errors,
            ROUND(SUM(cost_usd), 3) as total_cost,
            SUM(wa_count) as wa_tasks,
            SUM(web_count) as web_tasks,
            SUM(tool_calls) as total_tools,
            SUM(input_tokens) as total_input,
            SUM(output_tokens) as total_output,
            SUM(cache_tokens) as total_cache,
            ROUND(AVG(avg_duration_ms)) as avg_response,
            COUNT(*) as report_count
          FROM reports`
        ).first();

        const recent = await env.DB.prepare(
          'SELECT * FROM reports ORDER BY id DESC LIMIT 50'
        ).all();

        return new Response(renderDashboard(totals, daily.results, recent.results), {
          headers: { 'Content-Type': 'text/html' },
        });
      } catch (err) {
        return new Response('DB error: ' + err.message, { status: 500 });
      }
    }

    return new Response('Outdoors Telemetry', { status: 200 });
  },
};

function renderDashboard(totals, daily, recent) {
  const t = totals || {};
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
  .chart { display: flex; align-items: flex-end; gap: 3px; height: 80px; margin-bottom: 24px; }
  .bar { flex: 1; background: #4a9eff; border-radius: 2px 2px 0 0; min-width: 8px; position: relative; }
  .bar:hover { opacity: 0.8; }
  .bar-tip { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 10px; white-space: nowrap; display: none; }
  .bar:hover .bar-tip { display: block; }
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

<h2>Daily Activity</h2>
<div class="chart">
  ${(daily || []).map(d => {
    const max = Math.max(1, ...daily.map(x => x.total_tasks));
    const pct = (d.total_tasks / max) * 100;
    return `<div class="bar" style="height:${pct}%"><div class="bar-tip">${d.day}: ${d.total_tasks} tasks, $${(d.total_cost || 0).toFixed(2)}</div></div>`;
  }).join('')}
</div>

<h2>Daily Breakdown</h2>
<table>
  <tr><th>Date</th><th>Tasks</th><th>Cost</th><th>Errors</th><th>WA</th><th>Web</th><th>Avg Time</th></tr>
  ${(daily || []).map(d => `<tr>
    <td>${d.day}</td><td>${d.total_tasks}</td><td>$${(d.total_cost || 0).toFixed(2)}</td>
    <td>${d.total_errors}</td><td>${d.whatsapp_tasks}</td><td>${d.web_tasks}</td>
    <td>${d.avg_response_ms ? Math.round(d.avg_response_ms / 1000) + 's' : '—'}</td>
  </tr>`).join('')}
</table>

<h2>Recent Reports (last 50)</h2>
<table>
  <tr><th>Time</th><th>Tasks</th><th>Cost</th><th>Errors</th><th>Tools</th><th>Avg</th></tr>
  ${(recent || []).map(r => `<tr>
    <td>${r.received_at}</td><td>${r.tasks}</td><td>$${(r.cost_usd || 0).toFixed(3)}</td>
    <td>${r.errors}</td><td>${r.tool_calls}</td><td>${r.avg_duration_ms ? Math.round(r.avg_duration_ms / 1000) + 's' : '—'}</td>
  </tr>`).join('')}
</table>

</body></html>`;
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
