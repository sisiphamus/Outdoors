# Creating Skills

When you need to create a new skill for a task type that doesn't have one yet:

1. **Create a folder** in `bot/memory/skills/<skill-name>/`
2. **Write a `SKILL.md`** with:
   - A one-line description of what this skill covers
   - Key patterns, techniques, and decision frameworks
   - Common pitfalls and how to avoid them
   - Tool preferences and workflow steps
3. **Keep it actionable** — patterns, not tutorials. The skill should make you faster next time.
4. **Add knowledge subfiles** if the skill has domain-specific reference data (e.g., `knowledge/facts.md`)

Skills should be general enough to reuse across sessions but specific enough to be genuinely helpful.
