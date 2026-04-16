# Gmail Email Scheduling Workflow

For scheduling emails in Gmail when Google Workspace MCP doesn't support scheduling:

## Two-Phase Approach
1. **Draft via MCP first** - Use `mcp__google-workspace__draft_gmail_message` to create clean, properly formatted emails
2. **Schedule via browser** - Use Chrome automation to schedule each draft

## Email Format Fix
If emails have broken line wraps, convert from plain text to HTML format when drafting. Set `body_format: "html"` in the MCP call.

## Gmail Scheduling UI Pattern
For each draft email:
1. Navigate to Gmail drafts: `https://mail.google.com/mail/u/0/#drafts`
2. Click on draft to open compose window
3. Click "More send options" (down arrow next to Send button)
4. Click "Schedule send" from dropdown menu  
5. Select desired time slot (e.g., "Tomorrow morning Mar 18, 8:00 AM")
6. Email moves from Drafts to Scheduled

## Verification
Check sidebar counts: "Scheduled: X" increases, "Drafts: X" decreases for each successful schedule.

## Why This Pattern
- MCP tools are fast/reliable for drafting but don't support scheduling
- Browser automation handles the scheduling UI that MCP can't access
- Two-phase approach leverages strengths of both methods