---
name: whatsapp-images
description: Send images (screenshots, photos, charts) to the user on WhatsApp using [IMAGE: path] markers in your response text.
---

# Sending Images on WhatsApp

## How It Works

Include `[IMAGE: /absolute/path/to/file.png]` anywhere in your response text. The transport layer automatically:
1. Extracts all `[IMAGE: path]` markers
2. Reads each file and sends it as a separate WhatsApp image message
3. Strips the markers from the visible text response

Multiple markers = multiple images, each sent as its own message. Images are sent **before** the text.

## Taking Screenshots

Use browser screenshot tools to capture what's on screen, then reference the saved path:

```
# Chrome (preferred)
mcp__chrome__take_screenshot

# Playwright fallback
mcp__playwright__browser_take_screenshot
```

After the screenshot is saved, include the path:
```
Here's what the page looks like:
[IMAGE: /path/to/screenshot.png]
```

## What You Can Send

Any image file on disk:
- Browser screenshots (PNG from screenshot tools)
- Generated charts or diagrams
- Downloaded images
- Photos from the filesystem

## When to Use

- After completing a browser task — show the user the result
- When the user asks to "see", "show me", or "send a picture/screenshot"
- When visual context would be more helpful than a text description
- After creating visual content (presentations, designs, charts)

## Format

```
[IMAGE: C:/Users/anton/path/to/image.png]
```

- Must be an **absolute path** to an existing file
- Supported formats: PNG, JPG, JPEG, GIF, WEBP
- The marker can appear anywhere in your response — inline, at the start, at the end
