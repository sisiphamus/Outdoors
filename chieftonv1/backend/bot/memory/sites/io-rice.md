# iO — Rice University Timesheet

## URL
https://io.rice.edu

## What it is
Rice University timesheet/hours logging portal (Oracle Cloud). Used by student workers to log hours for each job role.

## Login
- Requires Rice NetID SSO (idp.rice.edu → Oracle Cloud)
- Password auto-fills in Chrome AutomationProfile — just click the login button
- **Duo MFA push required** — after clicking login, Duo sends a push to user's phone; wait for approval before proceeding
- Login flow: navigate → credentials auto-fill → click Login → "Logging in, please wait..." → user accepts Duo push on phone → page loads
- **If user says "I haven't received a Duo push"**: Re-click the login button to re-trigger the Duo push. Do NOT assume the session is broken.
- **Never confirm "Duo push sent" based on page state alone.** Only tell the user to check their phone after verifying the page shows a Duo challenge screen. If the page returned to the login form, the push was NOT sent.

## CDP Automation Pattern (confirmed working)
Use raw CDP WebSocket scripts (`.cjs` extension), NOT Chrome MCP tools, for the SSO login flow:

```js
// 1. Open a FRESH tab (avoid stale execution IDs from retries)
// 2. Navigate to io.rice.edu
// 3. Wait for redirect to idp.rice.edu (execution=e1s1 on fresh tab)
// 4. Check that autofill worked: read field values via JS
// 5. Click the Login button by coordinates (NOT f.submit() — bypasses autofill!)
// 6. Wait 3-4s, read URL
```

- **NEVER use `f.submit()` or `form.submit()`** — submits with empty fields, bypassing Chrome autofill
- **Always open a new tab** for SSO — retrying the same tab produces stale execution IDs ("Stale Request" error)
- **Success indicator**: URL redirects to `duosecurity.com/frame/v4/auth/prompt?sid=...` → credentials accepted, Duo push sent
- **Stale Request**: If you see this, close the tab and open a completely new one to io.rice.edu

## Workflow
1. Pull events from user's work calendars for the target date range (check user's knowledge/preferences for which GCal calendars to use)
2. Navigate to io.rice.edu (may need SSO login on first visit)
3. Enter hours for each role
4. **SAVE, do NOT submit** — submitting is an irreversible payroll action

## Timecard Entry — CDP Pattern (confirmed working)
After logging in, navigate: Time and Absences → Current Time Card → timecards/landing-page

### Table layout (pixel coordinates for CDP clicks)
- Table period: 2 weeks
- **Column layout** (each day occupies 2 × 100px columns, Start then Stop):
  - Position col: x≈152, TRC col: x≈380
  - First day of period: Start=506, Stop=606
  - Each subsequent day adds 200 to x
- **Row y-positions**: Row 1=389, Row 2=416, Row 3=443, Row 4=470, Row 5=497

### Cell editing
- **Double-click** any time cell to open the input editor (activeElement becomes INPUT)
- Use `Input.insertText` CDP command to type the time value (e.g., "1:00 PM", "2:15 PM")
- **Click away** (x+200) to commit the value — do NOT use Tab (it skips the Stop column)
- For Position cells: double-click → type to search → click the dropdown option
- Time Reporting Code auto-defaults to "Regular Hourly" when position is selected

### Save button
- Save button at approximately x=1129, y=120 (top right)
- "Time card saved" toast confirms success
- **NEVER click Submit** — that's an irreversible payroll lock
