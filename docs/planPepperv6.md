# PepperV6 Merge Plan

## Source
- Repo: https://github.com/sisiphamus/PepperV6
- Commit: `ed049dc` on main
- 28 files changed across `pepperv1/` and `pepperv4/`

## Path Mapping
| PepperV6 | Chiefton |
|---|---|
| `pepperv1/` | `chieftonv1/` |
| `pepperv4/` | `chieftonv4/` |

Git merge won't work due to the directory rename. Must apply changes file-by-file.

## What Changed (Summary)

### Model A (Intent/Format Classifier) — Full Rewrite
- Old system: 6 binary labels (`text`, `picture`, `command`, `presentation`, `specificFile`, `other`)
- New system: **Dual-axis** — 5 intent labels (`query`, `action`, `create`, `converse`, `instruct`) + 5 format labels (`inline`, `file`, `image`, `slides`, `browser`)
- New hand-crafted features: question starters, action verbs, create verbs, service keywords, greeting detection
- Word + char n-gram TF-IDF + hand features (was word-only)
- 56 real training examples (up from 44), voice message seeds added
- Cross-val accuracy: 88.1%, browser F1: 0.953

### Model B (Memory Retrieval)
- `PHASE_B_MIN_THRESHOLD`: 0.08 → **0.12** (eliminates noise memories)
- `MAX_SKILL_RESULTS`: 4 → **3**
- New `SITE_TRIGGERS`: gradescope, google-docs, io-rice, slack, mcmurtry
- Contact-name detection: mentions of known names auto-inject contacts file
- "tasks"/"task list"/"google tasks" now trigger todoist site memory

### Pipeline Fixes
- `detectFailure()` false positives fixed: "can't find any unread emails" no longer triggers retry. Added `FALSE_POSITIVE_PATTERNS` and >500 char response exemption
- `NEEDS_MORE_TOOLS` double-increment bug fixed (was consuming 2/3 loop iterations)
- Site context deduplication between Phase B and `detectSiteContext()`
- Learner error logging (was silently swallowing ALL errors with empty `catch {}`)
- Learner now receives full execution trace (tool calls + results) instead of just response summary
- ML subprocess timeout: 10s → **15s** (30% of sessions were hitting fallback)
- Fallback logging added for ML model failures

### New Files
- 7 site memories: gradescope, google-docs, io-rice, slack, mcmurtry, rice-blogs, rice-edu
- 3 skills: ocr-correction, ocr-pipeline-development, website-deployment
- `build_training_data.py` and `test_inference.py` utilities
- `real_examples.json` (56 labeled training examples)
- `phase_a_v2.pkl` (retrained binary model)

---

## File-by-File Instructions

### Group 1: Copy Directly (no local conflicts)

These are new files or files with no local modifications. Copy from PepperV6 with path remapping.

| PepperV6 Source | Chiefton Destination | Notes |
|---|---|---|
| `pepperv4/ml/infer.py` | `chieftonv4/ml/infer.py` | **Full replace** — completely rewritten for dual-axis classifier + tiered retrieval |
| `pepperv4/ml/train.py` | `chieftonv4/ml/train.py` | **Full replace** — major rewrite (+519/-242 lines) |
| `pepperv4/ml/models/phase_a_v2.pkl` | `chieftonv4/ml/models/phase_a_v2.pkl` | Binary model file. Keep old `phase_a.pkl` as backup |
| `pepperv4/ml/data/real_examples.json` | `chieftonv4/ml/data/real_examples.json` | New file — 56 labeled training examples |
| `pepperv4/ml/build_training_data.py` | `chieftonv4/ml/build_training_data.py` | New utility |
| `pepperv4/ml/test_inference.py` | `chieftonv4/ml/test_inference.py` | New utility |
| `pepperv1/backend/bot/memory/sites/google-docs.md` | `chieftonv1/backend/bot/memory/sites/google-docs.md` | New site memory |
| `pepperv1/backend/bot/memory/sites/gradescope.md` | `chieftonv1/backend/bot/memory/sites/gradescope.md` | New site memory |
| `pepperv1/backend/bot/memory/sites/io-rice.md` | `chieftonv1/backend/bot/memory/sites/io-rice.md` | New site memory |
| `pepperv1/backend/bot/memory/sites/mcmurtry.md` | `chieftonv1/backend/bot/memory/sites/mcmurtry.md` | New site memory |
| `pepperv1/backend/bot/memory/sites/rice-blogs.md` | `chieftonv1/backend/bot/memory/sites/rice-blogs.md` | New site memory |
| `pepperv1/backend/bot/memory/sites/rice-edu.md` | `chieftonv1/backend/bot/memory/sites/rice-edu.md` | New site memory |
| `pepperv1/backend/bot/memory/sites/slack.md` | `chieftonv1/backend/bot/memory/sites/slack.md` | New site memory |
| `pepperv1/backend/bot/memory/sites/canvas.md` | `chieftonv1/backend/bot/memory/sites/canvas.md` | Updated existing |
| `pepperv1/backend/bot/memory/sites/gmail.md` | `chieftonv1/backend/bot/memory/sites/gmail.md` | Updated existing |
| `pepperv1/backend/bot/memory/skills/ocr-correction/` | `chieftonv1/backend/bot/memory/skills/ocr-correction/` | New skill directory |
| `pepperv1/backend/bot/memory/skills/ocr-pipeline-development/` | `chieftonv1/backend/bot/memory/skills/ocr-pipeline-development/` | New skill directory |
| `pepperv1/backend/bot/memory/skills/website-deployment/` | `chieftonv1/backend/bot/memory/skills/website-deployment/` | New skill directory |

### Group 2: Merge Carefully (both sides have changes)

#### `orchestrator.js` — `pepperv4/pipeline/orchestrator.js` → `chieftonv4/pipeline/orchestrator.js`

**Take from PepperV6:**
1. Tighter `FAILURE_PATTERNS` regexes — now require action verb after "can't" to avoid false positives
2. New `FALSE_POSITIVE_PATTERNS` array + `>500 char` response exemption in `detectFailure()`
3. `NEEDS_MORE_TOOLS` fix: change `loopCount++; if (loopCount <= MAX)` to `if (loopCount < MAX)` (don't double-increment)
4. Site context deduplication: `const selectedNames = new Set(...)` + `.filter(s => !selectedNames.has(s.name))`
5. Always call `ensureBrowserReady()` unconditionally (remove conditional check)
6. Pass `intent` to `runPhaseB(prompt, inventory, intent)`
7. Pass `fullEvents` to `learnInBackground()` + build execution trace from fullEvents
8. Learner error logging: replace `catch {}` with `catch (err) { process.stderr.write(...) }`
9. Phase A log message: `intent=${intent} formats=[${activeLabels}]`

**Keep Chiefton-only changes (NOT in PepperV6):**
- `redactSecrets()` applied to Phase D responses
- `SAFE_INSTALL_PATTERNS` whitelist validation for install commands
- `COMPLEXITY_TURNS` object + dynamic `maxTurns` based on complexity
- Screenshots directory pre-creation (`mkdirSync`)

#### `ml-runner.js` — `pepperv4/pipeline/ml-runner.js` → `chieftonv4/pipeline/ml-runner.js`

**Take from PepperV6:**
- `CALL_TIMEOUT_MS`: 10000 → **15000**
- Add `this.ready = false` to MLWorker constructor
- Detect "Ready" signal in stderr handler: `if (msg.includes('Ready')) this.ready = true`
- `runPhaseA()` fallback: return new dual-axis format (`intent: 'query'`, `intentScores: {}`, `outputLabels: { inline: true, ... }`, `_fallback: true`)
- `runPhaseB()` signature: add `intent = 'query'` parameter, pass to worker call
- Better fallback logging: `Phase A FALLBACK triggered` + prompt excerpt

**Keep Chiefton-only changes:**
- Any `allowBrowser`, `maxTurns`, or `BASE_TOOLS`/`BROWSER_TOOLS` split changes

#### `model-d.js` — `pepperv4/pipeline/prompts/model-d.js` → `chieftonv4/pipeline/prompts/model-d.js`

**Take from PepperV6:**
- Add `INTENT_DESCRIPTIONS` map (query, action, create, converse, instruct)
- Add `_renderClassification(spec)` function that formats intent + formats + complexity + domains
- Replace `## Output Specification\n${JSON.stringify(outputSpec)}` with `## Task Classification\n${_renderClassification(outputSpec)}`

**Keep Chiefton-only changes** to this file (review diff before merging).

#### `learner.js` — `pepperv4/pipeline/prompts/learner.js` → `chieftonv4/pipeline/prompts/learner.js`

**Take from PepperV6:**
- Section header: "Execution Summary" → "Final Response Summary"
- Rewritten instructions: focus on execution trace (TOOL_USE, TOOL_RESULT, ASSISTANT lines) instead of prose
- 5 new analysis points: what worked, what failed, site patterns, user preferences, reusable skills

#### `memory-manager.js` — `pepperv4/memory/memory-manager.js` → `chieftonv4/memory/memory-manager.js`

**Take from PepperV6 (+3 lines in `readFirstLine()`):**
```js
// Try "When to use" section (common in skill files)
const whenMatch = content.match(/##\s*When\s+to\s+[Uu]se\s*\n([\s\S]*?)(?=\n##|\Z)/);
if (whenMatch) return whenMatch[1].trim().split('\n')[0].slice(0, 150);
```

### Group 3: Skip

| File | Why Skip |
|---|---|
| `pepperv4/config.js` | Changes `outputDirectory` path to `pepperv1/...` — Chiefton already has correct `chieftonv1/...` equivalent |
| `pepperv1/backend/src/telegram/bot.js` | Telegram not used in Chiefton |
| `pepperv1/backend/bot/memory/skills/chrome-use/SKILL.md` | Already deleted in Chiefton (`git status` shows `D`) |
| `pepperv1/backend/bot/memory/skills/ui.md` | Minor update, review if needed |
| `pepperv1/backend/src/browser-health.js` | Review for any CDP/port changes, likely skip |

---

## Execution Steps

```bash
# 1. Clone PepperV6 to temp dir
git clone --depth 1 https://github.com/sisiphamus/PepperV6.git /tmp/pepperv6

# 2. Copy Group 1 files (new/wholesale)
cp /tmp/pepperv6/pepperv4/ml/infer.py chieftonv4/ml/infer.py
cp /tmp/pepperv6/pepperv4/ml/train.py chieftonv4/ml/train.py
cp /tmp/pepperv6/pepperv4/ml/models/phase_a_v2.pkl chieftonv4/ml/models/phase_a_v2.pkl
mkdir -p chieftonv4/ml/data
cp /tmp/pepperv6/pepperv4/ml/data/real_examples.json chieftonv4/ml/data/real_examples.json
cp /tmp/pepperv6/pepperv4/ml/build_training_data.py chieftonv4/ml/build_training_data.py
cp /tmp/pepperv6/pepperv4/ml/test_inference.py chieftonv4/ml/test_inference.py

# Copy site memories
for f in google-docs gradescope io-rice mcmurtry rice-blogs rice-edu slack canvas gmail; do
  cp /tmp/pepperv6/pepperv1/backend/bot/memory/sites/${f}.md \
     chieftonv1/backend/bot/memory/sites/${f}.md
done

# Copy new skills
for s in ocr-correction ocr-pipeline-development website-deployment; do
  cp -r /tmp/pepperv6/pepperv1/backend/bot/memory/skills/${s} \
        chieftonv1/backend/bot/memory/skills/${s}
done

# 3. Merge Group 2 files manually (see detailed instructions above)
# These need careful line-by-line merging to preserve Chiefton-only changes

# 4. Verify
python chieftonv4/ml/train.py          # Should train with 88%+ accuracy
python chieftonv4/ml/test_inference.py  # Should pass all tests

# 5. Restart bot and send a test message
# Check devlog for: "Phase A: Complete → intent=query formats=[inline]"
# Check stderr for [learner] log lines (no longer silent)
```

---

## Key Risks

1. **infer.py requires new dependencies**: `numpy` and `scipy` (for `csr_matrix`, `hstack`). Verify these are installed: `pip install numpy scipy`
2. **Model file name change**: Old code loads `phase_a.pkl`, new code loads `phase_a_v2.pkl`. Make sure `infer.py` points to `phase_a_v2.pkl` (it does in PepperV6)
3. **Orchestrator merge is the hardest**: Both sides modified heavily. Work through the 9 PepperV6 changes + 4 Chiefton-only preservations carefully
4. **Backward compat**: `_map_to_legacy_type()` in new `infer.py` maps dual-axis back to old 6-label system, so `outputType` still works for any code that reads it
