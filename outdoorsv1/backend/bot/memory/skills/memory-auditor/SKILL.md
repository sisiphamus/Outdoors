---
name: memory_auditor
description: Audit the quality, accuracy, and usefulness of all memory files. Find duplicates, contradictions, outdated info, and gaps. Prune what's dead weight, strengthen what matters.
---

# Memory Auditor

## Purpose
You are the system's quality control for its own knowledge. You read every memory file, evaluate its quality, check for problems, and produce specific recommendations for improvement. You are the difference between a memory system that rots and one that compounds.

## When To Use This Skill
- When explicitly asked to review or audit memories
- When asked "what do you know" or "check your knowledge"
- When the system seems to be using outdated or incorrect information
- Periodically (every ~50 sessions) as preventive maintenance

## Memory Locations
All memories live in: `pepperv1/backend/bot/memory/`

```
skills/{name}/SKILL.md     - Domain expertise (how to do work)
knowledge/{topic}.md       - Reference facts, frameworks, research
preferences/{topic}.md     - User-specific context
sites/{site}.md            - Website interaction patterns
```

## Audit Protocol

### Step 1: Full Inventory
Read every memory file. For each one, record:
- **Name and category**
- **Size** (line count, rough word count)
- **Last substantive topic** (what's it actually about?)
- **Freshness signal** (does it reference dates? tools that may have changed?)

```bash
# Quick inventory with sizes
find pepperv1/backend/bot/memory -name "*.md" -exec wc -l {} \;
```

### Step 2: Quality Checks
For each memory file, evaluate:

**Accuracy Check**
- Are stated facts still true? (tool versions, URLs, API endpoints)
- Do instructions still work? (commands, configuration steps)
- Are there claims that contradict other memory files?

**Relevance Check**
- Has this memory been useful in recent sessions? (cross-reference with session logs if available)
- Is this about a one-off problem that's been solved and won't recur?
- Does this address a recurring need?

**Completeness Check**
- Are there obvious gaps in the coverage?
- Does the memory reference external resources that should be internalized?
- Are there "TODO" or placeholder sections?

**Duplication Check**
- Does this overlap significantly with another memory file?
- Are the same instructions repeated across multiple files?
- Could two files be merged without losing information?

**Consistency Check**
- Do preferences conflict with each other?
- Do site instructions match current site behavior?
- Do skills reference tools or workflows that have changed?

**Defeatist Language Check (CRITICAL)**
- Does ANY memory file contain instructions to "inform the user the tools aren't available"?
- Does any file say "if X fails, tell the user..."?
- Does any file teach the executor to give up?
- These MUST be flagged and rewritten. The executor operates under a strict "never give up" policy.

### Step 3: Scoring
Rate each memory file:

| Score | Meaning | Action |
|-------|---------|--------|
| A | Accurate, relevant, well-written, actively useful | Keep as-is |
| B | Mostly good, minor issues | Fix issues |
| C | Partially useful, needs significant updates | Rewrite |
| D | Outdated, inaccurate, or rarely useful | Archive or delete |
| F | Actively harmful (teaches bad patterns, contradicts policy) | Delete immediately |

### Step 4: Gap Analysis
After reviewing everything that exists, identify what's MISSING:

**Coverage Gaps**
- What task types does the user request that have no relevant skill?
- What websites does the user interact with that have no site memory?
- What recurring problems have no knowledge file?

**Depth Gaps**
- Which skills are too shallow to be useful?
- Which knowledge files state conclusions without explaining the reasoning?
- Which site memories are missing common workflows?

**Cross-Reference Gaps**
- Which memories should reference each other but don't?
- Are there natural groupings that should be explicitly linked?

### Step 5: Output Format

```markdown
# Memory Audit Report
**Date**: [date]
**Total Files**: [count]
**Total Size**: [approximate words]

## Scores Summary
| Grade | Count | Files |
|-------|-------|-------|
| A     | X     | [list] |
| B     | X     | [list] |
| C     | X     | [list] |
| D     | X     | [list] |
| F     | X     | [list] |

## Critical Issues (Fix Immediately)
1. [file]: [problem] -> [specific fix]
2. [file]: [problem] -> [specific fix]

## Duplications to Merge
- [file1] + [file2]: [what overlaps, recommended merge]

## Outdated Information
- [file]: [what's outdated] -> [what it should say]

## Defeatist Language Found
- [file]: Line "[quote]" -> Rewrite to: "[replacement]"

## Missing Memories (Recommended Additions)
- [name] (category): [what it should contain and why]

## Memories to Delete
- [file]: [why it's dead weight]

## Improvement Suggestions
1. [suggestion with specific action]
2. [suggestion with specific action]
```

### Step 6: Execute Fixes
After producing the report, **actually make the changes**:
- Delete F-rated files
- Rewrite defeatist language
- Merge duplicates
- Update outdated facts
- Create the most critical missing memories (top 3 max per audit)

## Quality Standards for Memory Files

A good memory file:
- **Starts with the most important information** (no long preambles)
- **Contains actionable instructions** (not just descriptions)
- **Has specific examples** (commands, URLs, exact steps)
- **Is concise** (under 200 lines unless it's a comprehensive skill)
- **Doesn't duplicate** information available elsewhere
- **Reinforces the "never give up" policy** for any executor-facing content
- **Has been verified** against reality (tested commands, confirmed URLs)

A bad memory file:
- Starts with a definition nobody needs
- Contains vague advice ("consider using..." instead of "use X because Y")
- Has no examples or specific commands
- Is over 300 lines of unfocused content
- Duplicates 80% of another file
- Teaches the executor to give up or apologize
- Contains information that was never verified
