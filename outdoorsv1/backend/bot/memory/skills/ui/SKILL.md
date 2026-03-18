# UI Development Skill

## Implementation
- create a descriptive plan and description for the UI components and styling - goinng into detail
- Deploy sub agents to create the UI components, styling, and structure based on the design system - do not create the entire website by yourself
- If the user specifies don't ask questions, make decision decisions that align with the vibe of the app, keeping rules, and focusing on creating high quality compelling UI components and styling
- The design should be something that could apear on awwwards, communicating a clear messae distinctively feeling curated
- Create the app in a subfolder with the name of the app - repeat include all elements of the app in a subfolder with name of the app

## Must Do
- Review laws of UX to refresh yourself on good design principles and practices - https://lawsofux.com/
- YOU must review some of the websites on https://louispaquet.com/ to get a sense of good design and layout

## Refining Questions
- Clarify vibe, general look, structure, colors, and user flow through the site/app
- Ask about specific components needed (buttons, forms, cards, etc.)
- clarify typography
- Ask mulltiple layers of questions, no less than 10

## Removing Vibe Coded Look
- YOU CANNOT USE ICONS OR EMOJIS IN THE DESIGN
- Ask refining questions about the site layout, do not assume a top bar, sidebar, or any specific layout - ask user about the desired layout and structure of the site/app
- Do not use basic templates but instead create a custom design based on the user's needs and the design system they are using - ask user about their design system and specific visual elements to use
- Create use basic buttons, forms, cards, and other components but do not use any pre-made templates or designs - create custom components based on the design system and user preferences; If you add a 2x3 card grid with basic edges you will be murdered
- Do not use basic color schemes but instead create a custom color palette based on the design system and user preferences - ask user about their color preferences and the design system they are using
- Use clear compelling design
- USE IMAGES - find clean images from the web and use them when building websites


## Single-File Gift Websites (Email Delivery)
When asked to create a personalized/fun website for someone:
- Build as a **single self-contained HTML file** — all CSS and JS inline, no external deps except CDN fonts (Google Fonts via `@import`)
- Save to `bot/outputs/<descriptive-folder>/index.html`
- Send via `mcp__google-workspace__send_gmail_message` with `attachments` array: `{ path, filename, mime_type: "text/html" }`
- Rename attachment to something friendly (e.g. `for-reese.html`) — recipient downloads and opens in browser
- Good interactive elements: confetti bursts, sparkle cursor trail, floating particles, tap-to-reveal cards, button with milestone counters, animated gradient text, scroll-reveal sections
- Personalize with recipient's name in headings, jokes, and compliments
- Keep the email body minimal: "Open the attached file in your browser. Trust me."

## Error Prevention

### Tailwind v4 + Next.js Fonts Rules
  - **Never define circular CSS variable references** in `@theme` blocks (e.g., `--font-serif: var(--font-serif)` is broken — it          resolves to nothing)
  - When using `next/font/google` with CSS variable mode (`variable: "--font-serif"`), do NOT re-register those same variables in
  `@theme inline`. Next.js injects them on the `<body>` element — `@theme` would override them.
  - Instead, define explicit utility rules in CSS: `.font-serif { font-family: var(--font-serif), Georgia, serif; }`
  - **Do not add a universal `*` reset** — Tailwind v4 includes its own preflight. Adding `* { margin: 0; padding: 0; }` conflicts with
  Tailwind's utility classes.
  - After writing `globals.css`, always verify the dev server renders fonts correctly before moving on to components.
  - You hate using em dashes in copy

  Layout Flow Rules

  - Never use position: absolute or position: fixed for content that the user is meant to read — removed elements leave empty space in the parent. Use flex or grid so all content contributes to layout sizing.
  - Never force section height with viewport units (vh, svh, dvh) — let content determine height. Use padding for spacing. Viewport-based heights create empty gaps when content is smaller than the forced size.

  Content Density Rules

  - Mock/placeholder data must look like real data — lists need 5+ items, charts need labeled axes, tables need enough rows to feel populated. Sparse data looks like a broken wireframe.
  - Every section must carry visual weight — if a section is mostly empty space around a headline and one small element, it needs more content or a stronger background treatment
  - After building any page, check each section: if you removed the heading and there's nothing substantial left, the section is too empty