# Todoist

**URL:** https://todoist.com/

## Access Methods (in priority order)

### 1. MCP Server (Preferred)
**Package**: `@doist/todoist-ai` (Official from Doist)
**Auth**: API token from Todoist Settings > Integrations > Developer
**Tools**: Create/read/update/delete tasks, manage projects, sections, labels, comments
- If MCP is configured, use `mcp__todoist__*` tools directly
- No DOM parsing, no snapshots, no stale refs — pure structured API

### 2. REST API v1 (Fallback)
**IMPORTANT**: REST v2 is DEPRECATED (returns 410 Gone as of Feb 2026). Use v1:
```bash
# Get all tasks (paginated, returns {results, next_cursor})
curl -s -H "Authorization: Bearer $TODOIST_API_TOKEN" https://api.todoist.com/api/v1/tasks

# Create a task
curl -s -X POST -H "Authorization: Bearer $TODOIST_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"Task name","due_string":"today"}' https://api.todoist.com/api/v1/tasks

# Complete a task
curl -s -X POST -H "Authorization: Bearer $TODOIST_API_TOKEN" https://api.todoist.com/api/v1/tasks/{id}/close
```

### 3. Playwright Browser (Last Resort)
Only if MCP and API are both unavailable:
1. Navigate to `https://todoist.com/app/today`
2. Snapshot with filename param, grep for task refs
3. Use click/type for interactions

## Notes
- Todoist web app is an SPA — wait for content to load after navigation
- The app URL is `https://todoist.com/app/` (not just `todoist.com`)
