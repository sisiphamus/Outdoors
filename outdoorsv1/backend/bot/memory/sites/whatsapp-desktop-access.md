# WhatsApp Desktop Access

## Local Access Methods (NOT Web-based)

When user wants WhatsApp data "on laptop" rather than browser:

### Method 1: Windows UIAutomation
- Target: WhatsApp PWA or desktop app installed locally
- Access chat list, recent messages, community structure
- Better than WhatsApp Web for local data access

### Method 2: Direct Database Access
- WhatsApp desktop stores data in LevelDB format
- Can extract message history, file sharing records, contact info
- Binary extraction method for comprehensive data access

### Successful Use Case
- **Task**: Find Fragile World project communications and status
- **Result**: Full community structure (3 sub-groups), recent activity (Mar 11), file sharing history, project status
- **Data extracted**: Community names, last messages, shared files list, contact activity

## Priority for WhatsApp Tasks
1. **Local desktop access** (UIAutomation + LevelDB) — comprehensive data, works offline
2. **WhatsApp Web via browser** — limited, requires active session
3. **WhatsApp Business API** — requires API setup, not for personal chats

**Key insight**: When user says "on my laptop", they want local system access, not browser automation.