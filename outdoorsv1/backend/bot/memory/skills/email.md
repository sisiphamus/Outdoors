# Email Drafting Skills

## Format: Always Use HTML

When creating email drafts via `draft_gmail_message` or `create_draft`, ALWAYS use `body_format="html"`.

Plain text (`text/plain`) causes Gmail to wrap lines at a fixed character width, inserting hard line breaks mid-paragraph. This makes emails look broken.

### Correct approach:
```
body_format="html"
body="Hi Dr. Smith,<br><br>First paragraph here.<br><br>Second paragraph here.<br><br>Best,<br>Name"
```

### Wrong approach:
```
body_format="plain"  (or omitting body_format, since default is plain)
body="Hi Dr. Smith,\n\nFirst paragraph..."
```

## Style Notes
- Use `<br><br>` between paragraphs (not `<p>` tags, which add extra spacing in Gmail)
- Use `<br>` for single line breaks (like in sign-offs)
- No em dashes ever
