# Gmail

## Access Methods (in priority order)

### 1. Google Workspace MCP (Preferred)
**Package**: `taylorwilsdon/google_workspace_mcp`
**Auth**: OAuth 2.0 via Google Cloud Console
**Covers**: Gmail + Calendar + Drive + Docs in one server
- If configured, use `mcp__google-workspace__*` tools
- Structured API access, no DOM parsing needed

### 2. Playwright Browser (Use when MCP tools aren't in your environment)
Playwright connects via CDP to the user's already-running Edge. **The user is already logged in — no authentication needed.** Just navigate and interact:

**Compose Email — Optimal Flow:**
1. `browser_navigate` → `mail.google.com/mail/u/N/#inbox?compose=new`
2. `browser_snapshot` with `filename` param → save to temp file
3. `Grep` the snapshot for `To recipients|Subject|Message Body|Send` → get all refs
4. `browser_type` → To (type name, wait for autocomplete, select contact), Subject, Body
5. `browser_click` → Send button ref
6. Clean up: delete the snapshot file

**Key patterns:**
- Navigate output always overflows — immediately snapshot to file, grep for refs
- Compose dialog: `textbox "To recipients"`, `textbox "Subject"`, `textbox "Message Body"`, `button "Send"`
- `browser_type` with `fill` auto-focuses — skip click-then-type
- Refs are stable within a compose session
- **Resolve contacts by name**: Type name in To field → Gmail autocomplete suggests matches → click contact

**Multiple accounts:**
- `/u/0/` (first account), `/u/1/` (second), etc.
- School email: at253@rice.edu | Personal: towneradamm@gmail.com
- Default to school email unless personal is specified

**Gmail's accessibility tree is enormous.** Always use `filename` param on snapshots, then Grep for specific refs.
