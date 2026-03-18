# Slack — Browser Automation Skill

Patterns for signing into Slack workspaces and managing user status/presence via the browser.

## Signing In

### Best approach: Google OAuth from slack.com/signin
1. Navigate to `https://slack.com/signin`
2. Click the **Google** sign-in button
3. Select the user's Google account from the account chooser
4. Click **Continue** on the consent screen
5. Slack shows all workspaces tied to that Google account — click the target workspace
6. If Slack tries to open the desktop app, click **"use Slack in your browser"**
7. If the browser link doesn't work, navigate directly to `https://app.slack.com/client/<TEAM_ID>`

### Why NOT to use workspace-specific sign-in pages
- Going directly to `<workspace>.slack.com` often triggers **reCAPTCHA** that blocks automation
- The magic code flow (email-based) is unreliable — CAPTCHA blocks submission
- University/org accounts using SSO (e.g., Rice, Google Workspace) redirect to identity providers that require credentials not available in the automation browser
- Google OAuth from `slack.com/signin` bypasses all of this if the Google account is already authenticated in the browser

### Workspace URL patterns
- Workspace names often use hyphens: `rice-oit.slack.com`, not `riceoit.slack.com`
- The workspace name shown in Slack UI may differ from the URL slug (e.g., "Rice - OIT" = `rice-oit`)
- If a workspace URL 404s, try variations with hyphens

## Extracting the API Token

Slack's web client stores API tokens in `localStorage`. Use this to extract them:

```js
const localConfig = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
const teams = Object.values(localConfig.teams || {});
// Each team has: { name, token (xoxc-...), id (T...) }
```

**Important:** `xoxc-` tokens require the session cookie (`d=`) to authenticate. API calls MUST include `credentials: 'include'` and be made from the same origin (use relative paths like `/api/...`).

## Setting Presence (Online/Away)

```js
// Set to active (online)
await fetch('/api/users.setPresence', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  credentials: 'include',
  body: `token=${encodeURIComponent(token)}&presence=auto`
});

// Verify presence
const res = await fetch('/api/users.getPresence', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  credentials: 'include',
  body: `token=${encodeURIComponent(token)}`
});
// Returns: { ok, presence: "active"|"away", online, auto_away, manual_away }
```

## Setting Custom Status Text

```js
const profile = JSON.stringify({
  status_text: "active",       // the text shown as status
  status_emoji: "",            // emoji like ":palm_tree:" or "" for none
  status_expiration: 0         // 0 = no expiration, or Unix timestamp
});

await fetch('/api/users.profile.set', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  credentials: 'include',
  body: `token=${encodeURIComponent(token)}&profile=${encodeURIComponent(profile)}`
});
```

## Common Pitfalls

- **`invalid_auth` error**: You're using an `xoxc-` token without session cookies. Make sure `credentials: 'include'` is set AND you're on the correct origin (use `/api/...` not `https://workspace.slack.com/api/...` from `app.slack.com`)
- **reCAPTCHA on workspace sign-in pages**: Don't fight it. Use `slack.com/signin` with Google OAuth instead.
- **"No account found" on workspace sign-in**: The email might be correct but the workspace uses a different auth method. Use Google OAuth flow instead.
- **Desktop app redirect**: After signing in, Slack may try to launch the desktop app. Always click "use Slack in your browser" or navigate directly to `app.slack.com/client/<TEAM_ID>`.
- **Profile menu not opening via click**: The user avatar button in the bottom-left can be finicky. If clicking it doesn't produce a menu, use the API approach instead of trying to navigate the UI.
- **Presence vs Status**: "Presence" is online/away (green/gray dot). "Status" is the custom text (e.g., "In a meeting", "active"). Users may mean either — clarify or set both.
