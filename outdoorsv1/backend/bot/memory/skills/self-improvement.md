# Self-Assessment & Improvement Log

## Self-Assessment: March 11, 2026

### What I Did Well
- **Parallel research**: Launching 5-6 research agents simultaneously for the connectors task — massive time savings
- **Source verification**: Cross-referenced claude.com connector pages with GitHub repos and official docs
- **Memory organization**: Created 3 structured files (overview, setup, use-cases) covering ~80 connectors
- **Tool adaptation**: When `evaluate_script` failed with wrong params, corrected immediately without retry loop
- **Calendar recovery**: Found and fixed duplicate event by checking other calendars after user flagged it

### Bugs I Made (and fixes)

#### Bug 1: Calendar duplicate creation
**What happened**: Created "COMP 182 Midterm 2" on primary calendar even though "Comp Midterm 2" already existed on the "Rice Courses" calendar.

**Root cause**: Searched `get_events` with keyword "midterm 182" on primary calendar only. Got 0 results. Created new event. The existing one was on a DIFFERENT calendar with a DIFFERENT name.

**Fix applied to MEMORY.md**: Before creating any calendar event:
1. Call `list_calendars` to get all calendar IDs
2. Call `get_events` with DATE RANGE on each relevant calendar (not keyword search)
3. Check ALL calendars, not just primary

#### Bug 2: Connector page scraping — partial data
**What happened**: Research agents only got 8 connectors per page when pages likely have more.

**Root cause**: WebFetch truncates content for large pages. The paginated connector list returned only the first batch visible in static HTML.

**Mitigation**: Used multiple pages and cross-referenced with search results. Acceptable for a survey task. For exact complete data, use browser JS evaluation.

#### Bug 3: ToolSearch overhead
**What happened**: Calling ToolSearch before every MCP tool use adds 1 round-trip.

**Fix**: For known tools used frequently in a session (google-workspace, chrome), batch the ToolSearch calls at session start or preload them in the first turn.

---

### Patterns I Should Use More

1. **Date-range get_events before create** — always, across ALL calendar IDs
2. **Parallel calendar + email search** — when looking for event info, search email AND check calendar simultaneously
3. **JS state access** for web apps — `window.__INITIAL_STATE__`, `window.App?.state` — 10x faster than DOM scraping
4. **Batch ToolSearch at start** — for multi-step tasks, preload all needed tools in one message

### Connector Knowledge Gained
See `memory/skills/connectors/` for full directory.

**Most impactful MCP servers to set up for {{User}} Example:**
1. Granola — query meeting notes from club/IVP/class meetings
2. Linear — if doing engineering projects
3. Sentry — for any deployed apps
4. Vercel/Netlify — for web projects
5. Canva — for graphics/presentations
6. Scholar Gateway — academic research (needs Wiley subscription)
7. Crypto.com market data — free, no setup needed

**Key insight on MCP architecture:**
- Remote MCP servers (hosted) = add URL to Claude settings, OAuth handles auth
- Local MCP servers = `npx package` in config, API key in env var
- `npx mcp-remote <URL>` = bridge for clients that only support stdio but need a remote server
- Notion/Linear/Sentry/Vercel all have hosted remote servers — easiest to connect
- Google Calendar/Drive = still need GCP project + OAuth setup (no official hosted remote MCP)

### What I'd Do Differently

For the connectors task:
- Start with `mcp__chrome__evaluate_script` to get ALL connector links at once in one JS call instead of relying on WebFetch which truncates
- Use the Chrome CDP approach to fully paginate through the directory programmatically

For the calendar task:
- First call: `list_calendars` (parallel with email search)
- Second call: `get_events` on EACH calendar for the target date
- THEN decide to create or update

---

## Session 135 Update: March 11, 2026

### What changed
- Claude connectors directory grew from ~80 to **180 connectors**
- Key new additions: Gmail, Slack, Microsoft 365, Figma, HubSpot, Stripe, Supabase, Zapier, Make, Docusign, ClickUp, Monday, PostHog, Intercom, Cloudflare, Miro, Gamma, PubMed, Consensus, Snowflake, and ~40 more
- All 180 catalogued in overview.md; 20 new SKILL.md files created
- MEMORY.md updated, use-cases.md fully expanded

### Key technique confirmed
Using `mcp__chrome__evaluate_script` with a "View more" click loop was the right approach — got all 180 connectors in one pass. WebFetch (session 134 approach) truncated and only showed ~24.

```javascript
while (viewMoreBtn) { viewMoreBtn.click(); await sleep(800); }
const items = document.querySelectorAll('a[href*="/connectors/"]');
```

Always use browser JS evaluation for paginated directory/list pages instead of WebFetch.
