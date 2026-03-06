# Browser Preferences

## Browser Selection
The user's preferred browser is stored here. Pepper does not hardcode any browser. Always use whichever browser the user has configured.

- **Preferred Browser**: Microsoft Edge
- **Executable Path**: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- **CDP Port**: 9222

When setting up on a new machine, ask the user which browser they prefer and update this file. Supported browsers: Microsoft Edge, Google Chrome, Firefox (CDP support varies), Brave, Arc.

## Playwright MCP Configuration
- The MCP server connects to the user's **already-running browser session** via CDP
- Config: `--cdp-endpoint http://localhost:CDP_PORT` (default: `http://localhost:9222`)
- This means: all the user's cookies, logins, and tabs are available. No fresh profile.
- The preferred browser must be running with `--remote-debugging-port=9222` for this to work

## How to Use
- Just call `mcp__playwright__browser_navigate` etc. -- they connect to the running browser instance
- The user is already logged into their services (Gmail, Canvas, Todoist, Notion, LinkedIn, etc.)
- **Do NOT launch a new browser.** The MCP server reuses the existing one.
- **NEVER ask the user to authenticate, provide passwords, or set up OAuth/API keys.** You already have their active sessions. Just navigate to the site and use it.
- If a service has no MCP or API configured, **use Playwright directly** -- the browser IS your credential.

## If Falling Back to Bash/Playwright Scripts
- Connect via CDP: `chromium.connectOverCDP('http://localhost:9222')`
- **NEVER** use `chromium.launch()` -- this creates a fresh browser without cookies
- Use the executable path listed above for the preferred browser

## Setup on New Machine
When Pepper is installed on a new computer:
1. Ask which browser the user prefers
2. Update the "Preferred Browser" and "Executable Path" fields above
3. Configure the browser to launch with `--remote-debugging-port=9222` (see the chrome-use skill for Chrome-specific setup)
4. The port flag should be added to the browser's shortcut or startup config so it launches automatically with debugging enabled
5. The flag must NOT close existing tabs -- it simply enables the debugging protocol on the running instance
