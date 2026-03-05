---
name: notion
description: Complete Notion workspace automation via MCP. Search, create, read, update, and organize pages, databases, blocks, and comments in Adam's workspace programmatically.
---

# Notion Skill

## Overview
Notion is Adam's primary knowledge management system, organized under a PARA framework. Pepper has full programmatic access via the official Notion MCP server (`@notionhq/notion-mcp-server`). The integration is named "Pepper-Adam" and must be explicitly shared on each page/database to grant access.

## Access Priority
1. **MCP tools** (preferred) -- structured API, fast, reliable, no DOM parsing
2. **Playwright browser** (fallback) -- when pages aren't shared with the integration or MCP fails

## Configuration
- **MCP Server**: `@notionhq/notion-mcp-server` via `npx`
- **Auth**: Internal integration token in `~/.claude.json` under `OPENAPI_MCP_HEADERS`
- **API Version**: `2025-09-03` (default, auto-set by MCP)
- **Integration name**: "Pepper-Adam"
- **Workspace**: Always use Adam's workspace (not "Null's")

## Critical Rule
**Every page/database must be shared with the "Pepper-Adam" integration.** If you get a 404 error, the page is not shared. You cannot fix this via MCP -- use Playwright to open the page > Share > Invite "Pepper-Adam".

---

## Complete Tool Reference (22 Tools)

### Search & Discovery

#### `mcp__notion__API-post-search`
**Purpose**: Find pages and databases by title. This is your starting point for any Notion task.
**When to use**: Locating a page by name, finding databases, discovering content.
```
Parameters:
  query: string         -- Search text matched against titles
  filter: object        -- { "property": "object", "value": "page" | "data_source" }
  sort: object          -- { "direction": "ascending"|"descending", "timestamp": "last_edited_time" }
  page_size: int        -- Max results (default 100, max 100)
  start_cursor: string  -- Pagination cursor from previous response
```
**Agent pattern**: Always search first before assuming a page ID. Titles change; IDs don't.
```
Example: Search for a page titled "Bible"
  query: "Bible"
  filter: { "property": "object", "value": "page" }
```

---

### Pages

#### `mcp__notion__API-post-page`
**Purpose**: Create a new page under a parent page or database.
**When to use**: Creating meeting notes, journal entries, new knowledge pages, database entries.
```
Parameters:
  parent: object        -- { "page_id": "uuid" } or { "database_id": "uuid" }
  properties: object    -- Page properties (title is required for pages)
  children: array       -- Block content to add to the page body
  icon: string (JSON)   -- Optional emoji or external file icon
  cover: string (JSON)  -- Optional cover image (external URL only)
```
**Agent pattern**: To create a page with content:
```json
{
  "parent": { "page_id": "abc-123-def" },
  "properties": {
    "title": [{ "text": { "content": "My New Page" } }]
  },
  "children": [
    "{\"type\":\"paragraph\",\"paragraph\":{\"rich_text\":[{\"type\":\"text\",\"text\":{\"content\":\"First paragraph.\"}}]}}",
    "{\"type\":\"bulleted_list_item\",\"bulleted_list_item\":{\"rich_text\":[{\"type\":\"text\",\"text\":{\"content\":\"Bullet point\"}}]}}"
  ]
}
```
**IMPORTANT**: The `children` array takes JSON strings, not objects. Each child block must be a stringified JSON block object.

#### `mcp__notion__API-retrieve-a-page`
**Purpose**: Get page metadata and properties (not content).
**When to use**: Checking if a page exists, reading its properties, getting parent info.
```
Parameters:
  page_id: string            -- The page UUID
  filter_properties: string  -- Comma-separated property IDs to limit response
```
**Note**: This returns properties only, NOT the page body content. For content, use `API-get-block-children` with the page_id.

#### `mcp__notion__API-patch-page`
**Purpose**: Update page properties, icon, cover, or archive/unarchive.
**When to use**: Changing a page title, updating database entry properties, archiving pages.
```
Parameters:
  page_id: string       -- The page UUID
  properties: object    -- Property values to update (keys = property names/IDs)
  icon: object          -- { "emoji": "icon" }
  cover: object         -- { "type": "external", "external": { "url": "..." } }
  archived: boolean     -- true to archive
  in_trash: boolean     -- true to delete, false to restore
```

#### `mcp__notion__API-retrieve-a-page-property`
**Purpose**: Get a specific property value from a page.
**When to use**: Reading a single property (useful for paginated properties like rich_text or relations).
```
Parameters:
  page_id: string       -- The page UUID
  property_id: string   -- The property ID (from page schema)
  page_size: int        -- For paginated properties (default 100)
  start_cursor: string  -- Pagination cursor
```

#### `mcp__notion__API-move-page`
**Purpose**: Move a page to a different parent.
**When to use**: Reorganizing content, moving pages between sections.
```
Parameters:
  page_id: uuid         -- The page to move
  parent: object        -- New parent: { "type": "page_id", "page_id": "uuid" }
                           or { "type": "database_id", "database_id": "uuid" }
                           or { "type": "workspace" }
```

---

### Blocks (Page Content)

#### `mcp__notion__API-get-block-children`
**Purpose**: Read the content blocks of a page or block.
**When to use**: Reading actual page content, listing items in a toggle, reading nested blocks.
```
Parameters:
  block_id: string      -- Page ID or parent block ID
  page_size: int        -- Max blocks per request (default 100, max 100)
  start_cursor: string  -- Pagination cursor
```
**Agent pattern**: A page IS a block. Pass a page_id to get its content. For nested blocks (toggles, columns), pass the parent block's ID to get children.

#### `mcp__notion__API-patch-block-children`
**Purpose**: Append new blocks to a page or block.
**When to use**: Adding content to existing pages, appending paragraphs, lists, etc.
```
Parameters:
  block_id: string      -- Page ID or parent block ID to append to
  children: array       -- Array of block objects to append
  after: string         -- Block ID to insert after (optional, appends to end by default)
```
**Supported block types in children**:
- `paragraph`: `{ "type": "paragraph", "paragraph": { "rich_text": [{ "type": "text", "text": { "content": "..." } }] } }`
- `bulleted_list_item`: Same structure with `bulleted_list_item` key

**Limitation**: The MCP server only supports `paragraph` and `bulleted_list_item` block types in children arrays. For headings, code blocks, or other types, use Playwright as fallback.

#### `mcp__notion__API-retrieve-a-block`
**Purpose**: Get a single block's data.
**When to use**: Checking block type, reading a specific block's content.
```
Parameters:
  block_id: string      -- The block UUID
```

#### `mcp__notion__API-update-a-block`
**Purpose**: Update a block's content or archive it.
**When to use**: Editing existing text, checking/unchecking to-do items, archiving blocks.
```
Parameters:
  block_id: string      -- The block UUID
  type: object          -- Block type with updated properties (only text and checked supported)
  archived: boolean     -- true to archive (soft delete), false to restore
```
**Limitation**: Can only update `text` content and `checked` state (for to-do blocks).

#### `mcp__notion__API-delete-a-block`
**Purpose**: Permanently delete a block.
**When to use**: Removing content from a page. Irreversible.
```
Parameters:
  block_id: string      -- The block UUID
```

---

### Databases (Data Sources)

#### `mcp__notion__API-query-data-source`
**Purpose**: Query a database with filters and sorts.
**When to use**: Finding entries in a database, filtering by property values, getting sorted results.
```
Parameters:
  data_source_id: string    -- Database UUID
  filter: object            -- Filter conditions (compound or property-level)
  sorts: array              -- Array of { "property": "Name", "direction": "ascending" }
  page_size: int            -- Results per page (default 100, max 100)
  start_cursor: string      -- Pagination cursor
  filter_properties: array  -- Limit which properties are returned
  archived: boolean         -- Include archived entries
  in_trash: boolean         -- Include trashed entries
```
**Filter example**:
```json
{
  "and": [
    { "property": "Status", "select": { "equals": "In Progress" } },
    { "property": "Priority", "number": { "greater_than": 3 } }
  ]
}
```

#### `mcp__notion__API-retrieve-a-data-source`
**Purpose**: Get database schema (property definitions).
**When to use**: Understanding a database's structure before querying or creating entries.
```
Parameters:
  data_source_id: string    -- Database UUID
```

#### `mcp__notion__API-update-a-data-source`
**Purpose**: Update database title, description, or property schema.
**When to use**: Renaming databases, adding/modifying property columns.
```
Parameters:
  data_source_id: string    -- Database UUID
  title: array              -- Rich text array for new title
  description: array        -- Rich text array for description
  properties: object        -- Property schema updates
```

#### `mcp__notion__API-create-a-data-source`
**Purpose**: Create a new database inside a page.
**When to use**: Building structured data collections, task trackers, content libraries.
```
Parameters:
  parent: object            -- { "page_id": "uuid" }
  title: array              -- Rich text array for database title
  properties: object        -- Property schema definition
```
**Property types**: title, rich_text, number, select, multi_select, date, people, files, checkbox, url, email, phone_number, formula, relation, rollup, created_time, created_by, last_edited_time, last_edited_by, status

#### `mcp__notion__API-list-data-source-templates`
**Purpose**: List templates available in a database.
```
Parameters:
  data_source_id: string    -- Database UUID
  page_size: int            -- Max results
  start_cursor: string      -- Pagination cursor
```

#### `mcp__notion__API-retrieve-a-database`
**Purpose**: Get legacy database info (use `retrieve-a-data-source` instead for newer API).
```
Parameters:
  database_id: string       -- Database UUID
```

---

### Comments

#### `mcp__notion__API-retrieve-a-comment`
**Purpose**: Get all comments on a page or block.
**When to use**: Reading discussion threads, checking for feedback.
```
Parameters:
  block_id: string      -- Page ID or block ID
  page_size: int        -- Max results (max 100)
  start_cursor: string  -- Pagination cursor
```

#### `mcp__notion__API-create-a-comment`
**Purpose**: Add a comment to a page.
**When to use**: Leaving notes, feedback, or status updates on pages.
```
Parameters:
  parent: object        -- { "page_id": "uuid" }
  rich_text: array      -- [{ "text": { "content": "Comment text" } }]
```

---

### Users

#### `mcp__notion__API-get-self`
**Purpose**: Get the bot user (Pepper-Adam integration) info.
**When to use**: Verifying the integration is working, getting the bot's user ID.
```
Parameters: none
```

#### `mcp__notion__API-get-users`
**Purpose**: List all users in the workspace.
**When to use**: Finding user IDs for @mentions or people properties.
```
Parameters:
  page_size: int        -- Max results (default 100)
  start_cursor: string  -- Pagination cursor
```

#### `mcp__notion__API-get-user`
**Purpose**: Get a specific user by ID.
```
Parameters:
  user_id: uuid         -- The user's UUID
```

---

## Common Agent Workflows

### 1. Find and Read a Page
```
1. mcp__notion__API-post-search  (query: "page name")
2. Extract page_id from results
3. mcp__notion__API-get-block-children  (block_id: page_id)
4. For nested blocks, recursively call get-block-children on blocks with has_children: true
```

### 2. Create a Page with Content
```
1. mcp__notion__API-post-search  (find parent page)
2. mcp__notion__API-post-page  (parent: { page_id: ... }, properties: { title: ... }, children: [...])
```

### 3. Add Content to an Existing Page
```
1. mcp__notion__API-post-search  (find the page)
2. mcp__notion__API-patch-block-children  (block_id: page_id, children: [...])
```

### 4. Query a Database
```
1. mcp__notion__API-post-search  (filter: { property: "object", value: "data_source" })
2. mcp__notion__API-retrieve-a-data-source  (get schema)
3. mcp__notion__API-query-data-source  (apply filters/sorts)
```

### 5. Update a Database Entry
```
1. Query the database to find the entry
2. mcp__notion__API-patch-page  (page_id: entry_id, properties: { ... })
```

---

## Rich Text Format
All text content in Notion uses rich_text arrays:
```json
[
  {
    "type": "text",
    "text": {
      "content": "Plain text here",
      "link": null
    }
  }
]
```
For links:
```json
[
  {
    "type": "text",
    "text": {
      "content": "Click here",
      "link": { "url": "https://example.com" }
    }
  }
]
```

## Known Workspace Pages
- **Bible**: `2fb2c4366aa28014a3fefa446dd0a153`
- **Startup hub**: `2b62c4366aa280feb6acdc21a7e63448`
- **Key sections**: Knowledge, Writings (Journal, LinkedIn), Meetings
- **Favorites**: Life, OS
- **Organization**: PARA system (Projects, Areas, Resources, Archives)

## Gotchas & Lessons Learned
1. **404 = not shared**: The most common error. The page exists but the integration can't see it.
2. **Children are JSON strings**: When creating pages, the `children` array takes stringified JSON, not raw objects.
3. **Block types limited**: MCP only supports `paragraph` and `bulleted_list_item` in write operations. For headings, code, tables, use Playwright.
4. **Page content != page properties**: `retrieve-a-page` gives properties; `get-block-children` gives content.
5. **Pagination**: All list endpoints max at 100 items. Use `start_cursor` from the response's `next_cursor` to paginate.
6. **IDs are UUIDs**: Always use the full UUID format with dashes (e.g., `2fb2c436-6aa2-8014-a3fe-fa446dd0a153`).
7. **Notion-Version header**: Auto-set to `2025-09-03` by the MCP server. Don't override unless necessary.
8. **Data source = database**: The newer API calls databases "data sources". Both terms refer to the same thing.

## Playwright Fallback Patterns
When MCP can't do it (pages not shared, advanced block types, UI-only features):

- **Quick search**: `Ctrl+P` > type query > click result
- **Navigate to page**: Direct URL `https://www.notion.so/Page-Name-{id}`
- **AI features**: `/meet` for AI Meeting Notes, Notion AI sidebar
- **Share with integration**: Page > Share > Invite "Pepper-Adam"
- **Always start from PARA**: Root of Adam's workspace for navigation
