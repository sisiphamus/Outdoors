# Email Management Commands

## Label Management Logic
- **"keep as unread"** = do NOT remove UNREAD label, leave messages unread
- **"mark as read"** = remove UNREAD label from messages
- **"next email"** = get content of the next/different message

## Common Patterns
- When user says "keep as unread - next email" = skip any label changes, just navigate to next message
- Use `batch_modify_gmail_message_labels` with `remove_label_ids: ["UNREAD"]` ONLY when explicitly asked to mark as read
- Use `get_gmail_message_content` to retrieve next email content

## Tools
- `mcp__google-workspace__batch_modify_gmail_message_labels` - for label changes
- `mcp__google-workspace__get_gmail_message_content` - for email content
- Always pass `user_google_email` from user profile