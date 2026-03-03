# Canvas (Rice University)

**URL:** https://canvas.rice.edu/

## Access Methods (in priority order)

### 1. Canvas MCP Server (Preferred)
**Package**: `mcp-canvas-lms` (54 tools)
**Auth**: Personal access token from Canvas > Account > Settings > New Access Token
- If configured, use `mcp__canvas__*` tools directly
- Full access to courses, assignments, grades, announcements, modules

### 2. REST API (Direct)
Canvas has a comprehensive REST API. Use with personal access token or browser session cookies.

**Key Endpoints:**
| Purpose | Endpoint |
|---------|----------|
| To-do items | `/api/v1/users/self/todo?per_page=50` |
| Upcoming events | `/api/v1/users/self/upcoming_events?per_page=50` |
| Active courses | `/api/v1/courses?enrollment_state=active&per_page=50` |
| Course assignments | `/api/v1/courses/{id}/assignments?per_page=50` |
| Course announcements | `/api/v1/courses/{id}/discussion_topics?only_announcements=true` |
| Dashboard cards | `/api/v1/dashboard/dashboard_cards` |

```bash
# With API token
curl -s -H "Authorization: Bearer $CANVAS_TOKEN" "https://canvas.rice.edu/api/v1/users/self/todo?per_page=50"
```

### 3. Playwright Browser + API (Fallback)
Navigate to Canvas first to establish auth session, then hit API endpoints via `browser_evaluate`:
```javascript
() => fetch('/api/v1/users/self/todo?per_page=50').then(r => r.json())
```
This returns clean JSON without DOM parsing.

## Notes
- University: Rice University
- Known course: BUSI 365 (startup/product class)
- API responses include course names, due dates (ISO 8601), assignment descriptions (HTML), submission status
- Dashboard To Do widget is unreliable for scraping — always prefer API
