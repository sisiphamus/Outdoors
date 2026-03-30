CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  uptime_ms INTEGER,
  tasks INTEGER,
  total_duration_ms INTEGER,
  avg_duration_ms INTEGER,
  errors INTEGER,
  wa_count INTEGER,
  web_count INTEGER,
  tool_calls INTEGER,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_tokens INTEGER
);

-- Daily rollup view for quick dashboard queries
CREATE VIEW IF NOT EXISTS daily_summary AS
SELECT
  date(received_at) as day,
  SUM(tasks) as total_tasks,
  SUM(errors) as total_errors,
  ROUND(SUM(cost_usd), 3) as total_cost,
  SUM(wa_count) as whatsapp_tasks,
  SUM(web_count) as web_tasks,
  SUM(tool_calls) as total_tool_calls,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens,
  SUM(cache_tokens) as total_cache_tokens,
  ROUND(AVG(avg_duration_ms)) as avg_response_ms
FROM reports
GROUP BY date(received_at)
ORDER BY day DESC;
