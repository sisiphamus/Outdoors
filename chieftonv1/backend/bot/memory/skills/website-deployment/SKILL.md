# Website Deployment Skill

## Priority Order: GitHub Pages first, then 0x0.st as fallback

**GitHub Pages is the most reliable method.** 0x0.st and catbox.moe upload successfully but links frequently don't work for recipients (broken rendering, empty content, blocked by email clients). Use GitHub Pages as the default.

## Method 1: GitHub Pages (Permanent, Reliable, Public)

**Best for permanent sites / portfolios / demos.**

```bash
# 1. Init repo in the output folder
cd <output-folder>
git init && git add . && git commit -m "<descriptive message>"

# 2. Create public repo and push (uses gh CLI, authenticated as USERNAMEEXAMPLE-meet)
gh repo create <repo-name> --public --source=. --push

# 3. Enable GitHub Pages
gh api repos/USERNAMEEXAMPLE-meet/<repo-name>/pages -X POST \
  -f "build_type=legacy" \
  -f "source[branch]=master" \
  -f "source[path]=/"

# 4. Wait ~60s, then verify build
gh api repos/USERNAMEEXAMPLE-meet/<repo-name>/pages/builds --jq '.[0] | {status, created_at}'

# 5. Verify live
curl -sI https://USERNAMEEXAMPLE-meet.github.io/<repo-name>/ | head -3
```

Result URL: `https://USERNAMEEXAMPLE-meet.github.io/<repo-name>/`

### Notes
- Build takes ~35 seconds after push (first check at 15s returned 404, second at 35s returned 200)
- Verify with `curl -s -o /dev/null -w "%{http_code}" <url>` — wait for 200
- Check `status: "built"` via API before confirming to user
- For custom domains, use `gh api repos/.../pages -X PUT -f "cname=example.com"`
- **Cannot delete** GitHub Pages repos without user confirmation (destructive action)

## Method 2: 0x0.st / catbox.moe (Fallback Only)

**WARNING: These services are unreliable for recipients.** Links may appear to upload successfully but render as broken/empty for the person you share them with. Only use if GitHub Pages is somehow unavailable.

- **0x0.st**: `curl -s -F "file=@path/to/file.html" https://0x0.st` — cannot delete uploads (405 on DELETE)
- **catbox.moe**: `curl -s -F "reqtype=fileupload" -F "fileToUpload=@file.html;type=text/html" https://catbox.moe/user/api.php` — may return Content-Length: 0

## Methods That DON'T Work (DO NOT ATTEMPT)
- **Surge.sh** — requires pre-configured auth token, interactive login
- **Vercel CLI** — requires `vercel login` first
- **Cloudflare Wrangler** — requires `wrangler login` first
- **Netlify Drop** — requires browser interaction
- **Google Apps Script web app** — Apps Script API not enabled on GCP project
- **localtunnel** — requires persistent server process
- **tmpfiles.org** — rejects HTML files
- **python/npx serve locally** — localhost only

## Sending Hosted Links via Email
- Use GitHub Pages link as the primary/only link — it's reliable and permanent
- Include **plain-text URLs** below styled buttons — some email clients strip styled links
- Styled HTML email with a big CTA button works well (gradient background, rounded, bold text)
- If sending a follow-up/correction email, keep the tone light ("lol", "I promise this one works") rather than overly formal

## Personalized Website Template Pattern

For "cheer-up" / gift websites (proven pattern from Reese & Julia sites):

### Architecture
- Single self-contained HTML file (~20-30KB)
- Inline CSS + JS (no external deps except Google Fonts)
- Dark theme (`#0a0a1a` background) with gradient accent colors
- Fonts: `Poppins` (body) + `Dancing Script` (cursive accents)

### Interactive Sections (pick 5-8)
1. **Hero** — "Hey [Name]!" with gradient shimmer animation
2. **Breathe With Me** — animated circle with 4-phase breathing guide (in/hold/out/hold)
3. **Stress Shredder** — text input that scrambles/destroys typed text with satisfying animation
4. **Compliment Machine** — 12-15 personalized compliments, confetti on each click
5. **Emergency Laugh Supply** — 6 tap-to-reveal joke cards, customized to the person
6. **Hype Button** — mash to 100, milestones with labels, massive confetti at 100
7. **Countdown Timer** — countdown to an upcoming event the person is excited about
8. **Affirmation Wall** — 15 floating pill-shaped affirmations with color classes
9. **Closing Message** — cursive font, personal reference to something specific about them

### Effects
- Floating particles background (40 particles, 6 colors)
- Sparkle cursor trail on mousemove
- Confetti bursts on interactions (burstConfetti + massConfetti functions)
- Scroll-reveal via IntersectionObserver
- Mobile responsive (`@media max-width: 600px`)

### Personalization Points
- Name in hero, compliments, jokes, hype milestone, affirmations, closing
- Reference upcoming events (from calendar)
- Inside jokes or context-specific references
- Closing message that references something real about their situation

## Site Quality Checklist
- Self-contained single HTML file (inline CSS, no external deps except Google Fonts)
- Responsive (mobile-friendly `@media` queries)
- Accessible (semantic HTML, good contrast)
- Professional fonts via Google Fonts CDN
