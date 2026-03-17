# Onboarding Personalization Scan

When onboarding a new user, scan their Google services and write standardized knowledge files to `bot/memory/knowledge/`. Each file follows a strict template below. Write PATTERNS and INSIGHTS, never raw data (no full emails, no phone numbers, no passwords).

## Output Files

All files go in `bot/memory/knowledge/` with the exact filenames and headers below.

---

### `user-profile.md`
Always created. Synthesized from all scanned services.

```markdown
# User Profile

## Identity
- **Name**: [full name from account]
- **Email**: [primary email]
- **Timezone**: [inferred from calendar/email patterns]

## Communication Style
- **Tone**: [formal / casual / mixed]
- **Language**: [primary language, any secondary]
- **Responsiveness**: [quick responder / delayed / varies]

## Work & Life
- **Occupation/Role**: [inferred from calendar, emails, drive]
- **Key projects**: [2-5 current focus areas]
- **Peak hours**: [when they're most active]
- **Interests**: [inferred from content patterns]

Updated: [YYYY-MM-DD]
```

---

### `gmail-profile.md`
Scan: `search_gmail_messages` for 20 recent SENT emails, read with `get_gmail_messages_content_batch`.

```markdown
# Gmail Profile

## Writing Style
- **Tone**: [formal / casual / mixed — with examples of phrasing]
- **Average length**: [1-2 lines / short paragraph / detailed]
- **Greeting pattern**: [e.g., "Hi [Name]," / "Hey" / none]
- **Sign-off pattern**: [e.g., "Best," / "Thanks," / "Cheers" / none]
- **Signature**: [what their email signature contains, if any]

## Email Structure
- **Typical format**: [greeting → body → sign-off / direct no-greeting / etc.]
- **Paragraph style**: [single block / broken into short paragraphs / bullet points]
- **Formality shifts**: [more formal with X, casual with Y]

## Communication Patterns
- **Frequent recipients**: [top 5-8 names/roles, NOT email addresses]
- **Common topics**: [work, personal, scheduling, etc.]
- **Peak sending hours**: [morning / afternoon / evening / late night]
- **Response style**: [inline replies / top-post / brief acknowledgments]

Updated: [YYYY-MM-DD]
```

---

### `calendar-profile.md`
Scan: `get_events` for last 2 weeks + next 2 weeks across all calendars.

```markdown
# Calendar Profile

## Schedule Patterns
- **Typical day start**: [time]
- **Typical day end**: [time]
- **Busiest days**: [e.g., Mon-Wed]
- **Free days**: [e.g., weekends / specific days]

## Event Types
- **Recurring commitments**: [classes, standups, gym, etc. — names + frequency]
- **Meeting style**: [many short meetings / few long blocks / mixed]
- **Personal vs work ratio**: [mostly work / balanced / mostly personal]

## Key Activities
- [Activity 1 — frequency and typical time]
- [Activity 2 — frequency and typical time]
- [Activity 3 — frequency and typical time]
- ...

## Planning Style
- **Advance planning**: [books things weeks ahead / day-of / mixed]
- **Calendar density**: [packed / moderate / sparse]

Updated: [YYYY-MM-DD]
```

---

### `contacts-profile.md`
Scan: `list_contacts` (top 50), `list_contact_groups`.

```markdown
# Contacts Profile

## Key People
- [Name] — [relationship: family/friend/colleague/etc.] — [context if known]
- [Name] — [relationship] — [context]
- ... (top 10-15 most relevant)

## Contact Groups
- [Group name]: [count] contacts — [what this group represents]
- ...

## Network Shape
- **Primary circles**: [family, work team, university, etc.]
- **Professional contacts**: [industry/field if apparent]
- **Geographic spread**: [local / national / international]

Updated: [YYYY-MM-DD]
```

---

### `drive-profile.md`
Scan: `list_drive_items` (root + 2 levels deep), `search_drive_files` for recent files.

```markdown
# Drive Profile

## File Organization
- **Top-level structure**: [folder names and what they represent]
- **Organization style**: [highly organized / flat / project-based / messy]
- **Naming conventions**: [any patterns in file/folder names]

## Content Types
- **Primary file types**: [docs / sheets / slides / PDFs / etc.]
- **Recent activity focus**: [what kinds of files created/modified recently]

## Current Projects
- [Project/folder 1] — [what it appears to be about]
- [Project/folder 2] — [what it appears to be about]
- ...

Updated: [YYYY-MM-DD]
```

---

### `docs-profile.md`
Scan: `search_drive_files` for 3-5 recent Google Docs, `get_doc_as_markdown`.

```markdown
# Docs Profile

## Document Types
- [Type 1: notes / essays / reports / lists / etc.] — [frequency]
- [Type 2] — [frequency]

## Writing Patterns
- **Structure preference**: [headings + sections / free-form / bullet-heavy]
- **Length tendency**: [brief notes / medium / long-form]
- **Topics**: [what they write about]

## Formatting
- **Heading usage**: [yes/no, how many levels]
- **Lists vs prose**: [preference]
- **Bold/italic usage**: [heavy / light / none]

Updated: [YYYY-MM-DD]
```

---

### `sheets-profile.md`
Scan: `list_spreadsheets` (5 recent), `get_spreadsheet_info`, `read_sheet_values` (headers only).

```markdown
# Sheets Profile

## What They Track
- [Spreadsheet 1 topic] — [what data, how organized]
- [Spreadsheet 2 topic] — [what data, how organized]

## Data Patterns
- **Complexity level**: [simple lists / formulas / pivot tables / dashboards]
- **Update frequency**: [daily / weekly / one-off]
- **Common column types**: [dates, amounts, names, statuses, etc.]

Updated: [YYYY-MM-DD]
```

---

### `tasks-profile.md`
Scan: `list_task_lists`, `list_tasks` for each list.

```markdown
# Tasks Profile

## Task Lists
- [List name]: [count] tasks — [theme/purpose]
- ...

## Patterns
- **Task granularity**: [big goals / small actionable items / mixed]
- **Completion rate**: [most done / many overdue / balanced]
- **Due date usage**: [always sets dates / rarely / never]
- **Current priorities**: [top 3-5 active tasks/themes]

Updated: [YYYY-MM-DD]
```

---

### `slides-profile.md` (if selected)
### `forms-profile.md` (if selected)

Follow the same pattern: scan recent items, document types/topics/style, keep concise.

---

## Rules for the Scan
1. **Never store raw content** — no email bodies, no document text, no contact details beyond first name + relationship
2. **Keep each file under 60 lines**
3. **Be specific** — "uses casual tone with friends, formal with professors" is better than "mixed tone"
4. **Date everything** — add `Updated: YYYY-MM-DD` at the bottom
5. **If a service is empty or fails**, write a brief note: "No data found" and move on
6. **`user-profile.md` is always created** — it synthesizes insights across all services
