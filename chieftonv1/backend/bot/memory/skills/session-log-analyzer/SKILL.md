---
name: session_log_analyzer
description: Analyze session logs to extract cross-session patterns, failure modes, user behavior, and compounding insights. Turns raw session history into actionable self-improvement.
---

# Session Log Analyzer

## Purpose
You are the system's retrospective intelligence. You read session logs (JSONL transcripts of past interactions) and extract patterns that no single session can see. Your output is structured insights that make the system better over time.

## When To Use This Skill
- When explicitly asked to review past sessions or "look at what you've been doing"
- When asked to identify what's working and what isn't
- When asked to find patterns in user behavior or system performance
- When the system needs to self-assess capability gaps

## Session Log Format
Session logs are stored at: `~/.claude/projects/C--Users-towne-Code-Pepper2-master-bot-outputs/*.jsonl`

Each line is a JSON object with fields:
- `type`: "user" | "assistant" | "queue-operation"
- `message.role`: "user" | "assistant"
- `message.content`: The actual message or tool calls
- `sessionId`: UUID linking messages in a conversation
- `timestamp`: ISO 8601 timestamp
- `error`: Present if the session hit an error (e.g., "rate_limit")

Tool use appears as `content[].type: "tool_use"` with `name` and `input` fields.
Tool results appear as `content[].type: "tool_result"`.

## Analysis Protocol

### Step 1: Gather Scope
```bash
# Count total sessions
ls ~/.claude/projects/C--Users-towne-Code-Pepper2-master-bot-outputs/*.jsonl | wc -l

# Get date range (oldest and newest by filename sort)
ls -t ~/.claude/projects/C--Users-towne-Code-Pepper2-master-bot-outputs/*.jsonl | tail -1
ls -t ~/.claude/projects/C--Users-towne-Code-Pepper2-master-bot-outputs/*.jsonl | head -1
```

### Step 2: Extract Key Signals
For each session log, extract:

**Task Classification**
- What was the user asking for? (code, research, browser task, email, file operation, etc.)
- Was the task completed successfully?
- How many OODA cycles (tool call rounds) did it take?

**Failure Signals**
- Did the session end with an error? (`"error": "rate_limit"`, etc.)
- Did the executor emit `[NEEDS_MORE_TOOLS]`?
- Did `detectFailure()` patterns appear in the response?
- Did the session hit the 3-loop feedback limit?

**Tool Usage Patterns**
- Which tools were used most? (WebSearch, Bash, Read, Write, browser tools, etc.)
- Which tool calls failed?
- Average number of tool calls per session

**Timing**
- What time of day are requests sent? (user behavior pattern)
- How long did sessions last? (timestamp delta between first and last message)
- Are there clusters of activity?

**User Behavior**
- What topics recur? (school, startup, personal tasks, system maintenance)
- Does the user ask follow-up questions or move on?
- What's the ratio of simple vs. complex tasks?

### Step 3: Pattern Recognition
Look across sessions for:

**Recurring Failures**
- Same error appearing in multiple sessions
- Same type of task failing repeatedly
- Tools that consistently need to be installed/configured

**Capability Gaps**
- Task types that always require [NEEDS_MORE_TOOLS]
- Domains where the executor consistently struggles
- Missing knowledge that multiple sessions would have benefited from

**Improvement Trends**
- Are tasks that used to fail now succeeding? (evidence of learning working)
- Is average session length decreasing for similar tasks? (efficiency gains)
- Are new capabilities being used that didn't exist before?

**User Patterns**
- Most common request types
- Peak usage times
- Topics of sustained interest vs. one-off requests

### Step 4: Output Format
Produce a structured report:

```markdown
# Session Analysis Report
**Period**: [date range]
**Sessions Analyzed**: [count]

## Performance Summary
- Task Success Rate: X%
- Average Tool Calls Per Session: X
- Most Common Failure Mode: [description]

## Top Patterns
1. [Pattern]: [evidence from N sessions]
2. [Pattern]: [evidence from N sessions]
3. [Pattern]: [evidence from N sessions]

## Capability Gaps (Recommended New Memories)
- [gap]: Would have helped in sessions [list]
- [gap]: Would have helped in sessions [list]

## What's Working Well
- [strength]: Evidence from [sessions]

## What Needs Improvement
- [weakness]: Evidence from [sessions]
- Recommended fix: [specific action]

## User Behavior Insights
- [insight about what the user cares about]
- [insight about usage patterns]
```

### Step 5: Write Actionable Memory
After analysis, write findings to memory:
- Create/update `knowledge/session-analysis-insights.md` with cross-session patterns
- Create specific knowledge files for recurring capability gaps
- Update existing memories that analysis shows are outdated or wrong

## Constraints
- Read session logs with `Read` tool using offset/limit for large files
- Use `Grep` to search across logs efficiently (e.g., grep for "error", "NEEDS_MORE_TOOLS", specific tool names)
- Analyze at least 20 sessions for meaningful patterns (fewer is noise, not signal)
- Always report specific session IDs as evidence for claims
- Never fabricate patterns. If the data is unclear, say so.

## Efficiency
- Don't read every line of every session. Sample strategically:
  - Recent sessions (last 20) for current state
  - Oldest sessions (first 10) for baseline comparison
  - Any sessions with errors (grep for "error")
- Use `wc -l` on files to gauge session complexity before reading
