# Notion

## Access Methods (in priority order)

### 1. Notion MCP Server (Preferred)
**Package**: `@notionhq/notion-mcp-server` (Official)
**Auth**: Internal integration token from notion.so/my-integrations
**CRITICAL**: Each page/database must be explicitly shared with the integration. 404 errors = page not shared with integration. To fix: open the page in Notion > Share > Invite the integration.
- If configured, use `mcp__notion__*` tools for search, read, create, update

### 2. Playwright Browser (Fallback)
When MCP is not configured or pages aren't shared with integration:

**Search:** `Ctrl+P` opens quick search. Type query, results appear in listbox. Click the link to navigate.

**Navigation:** Always start from PARA (root of Adam's workspace). Drill down from there unless you have an exact URL.

**Known Pages:**
- Bible: `https://www.notion.so/Bible-2fb2c4366aa28014a3fefa446dd0a153`
- Startup hub: `https://www.notion.so/Startup-2b62c4366aa280feb6acdc21a7e63448`
- Key sections: Knowledge, Writings (Journal, LinkedIn), meetings
- Favorites: Life, OS

## Workspace
- Always use Adam's workspace, not "Null's"
- Pages are organized under a PARA system
