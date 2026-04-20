// Skill picker for scratch-bot creation.
// Fast, deterministic keyword-based ranker over the global skill inventory.
// Runs locally — no model call — so bot creation is near-instant.

import { getGlobalSkillInventory } from './grid-manager.js';

// Keyword → skillId boosts. Multiple matches stack. Unknown inventory entries
// are left at their baseline score so specializations mentioning rare topics
// still score the relevant skill via direct name match.
const KEYWORD_BOOSTS = [
  { re: /\b(code|coding|program|developer|engineering|debug|repo|github|script|python|javascript|typescript|rust|go|java|react|node)\b/i, boost: { coding: 6, 'browser-use': 1, 'chrome-use': 1, ui: 2 } },
  { re: /\b(research|investigate|investigating|find out|learn about|survey|analyze|compare|study)\b/i, boost: { 'project-research': 6, 'browser-use': 2, 'strategic-reasoning': 2 } },
  { re: /\b(email|gmail|inbox|draft|reply|message[s]?|send.*(to|a)\b)/i, boost: { email: 6, 'email-management': 4, 'gmail-scheduling': 2 } },
  { re: /\b(schedule|calendar|meeting|remind|book)\b/i, boost: { 'gmail-scheduling': 5, email: 2 } },
  { re: /\b(blog|article|content|write|writer|newsletter|essay|post|long.?form)\b/i, boost: { 'blog-writer': 6, 'browser-use': 1 } },
  { re: /\b(web|website|browser|navigate|scrape|web.?research|url)\b/i, boost: { 'browser-use': 4, 'chrome-use': 2 } },
  { re: /\b(slack|discord|channel|team chat)\b/i, boost: { slack: 6, 'browser-use': 2 } },
  { re: /\b(whatsapp|text|sms|photo|image|picture)\b/i, boost: { 'whatsapp-images': 4 } },
  { re: /\b(strategy|plan|think|reason|decide|framework|principle)\b/i, boost: { 'strategic-reasoning': 5 } },
  { re: /\b(design|ui|ux|interface|layout|css|visual)\b/i, boost: { ui: 5, 'browser-use': 1 } },
  { re: /\b(deploy|publish|launch|host)\b/i, boost: { 'website-deployment': 5 } },
  { re: /\b(windows|powershell|cmd|shell|file.?system|folder)\b/i, boost: { 'windows-system': 4 } },
];

/**
 * Pick skills for a scratch-bot specialization.
 * Returns up to `limit` skill IDs from the global inventory, scored by keyword match.
 *
 * @param {string} specializationText
 * @param {number} [limit=4]
 * @returns {string[]} array of skill IDs
 */
export function pickSkillsForSpecialization(specializationText, limit = 4) {
  const text = (specializationText || '').trim();
  if (!text) return [];

  const inventory = getGlobalSkillInventory();
  const inventoryIds = new Set(inventory.map(m => m.name));

  const scores = new Map();
  for (const id of inventoryIds) scores.set(id, 0);

  // Direct name mention beats keyword match
  for (const id of inventoryIds) {
    const namePattern = new RegExp('\\b' + id.replace(/-/g, '[- ]') + '\\b', 'i');
    if (namePattern.test(text)) scores.set(id, (scores.get(id) || 0) + 10);
  }

  // Keyword-based boosts
  for (const rule of KEYWORD_BOOSTS) {
    if (!rule.re.test(text)) continue;
    for (const [id, boost] of Object.entries(rule.boost)) {
      if (!inventoryIds.has(id)) continue;
      scores.set(id, (scores.get(id) || 0) + boost);
    }
  }

  // Description matching — lightweight term overlap
  const terms = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4);
  for (const entry of inventory) {
    const desc = (entry.description || '').toLowerCase();
    let match = 0;
    for (const t of terms) if (desc.includes(t)) match++;
    if (match > 0) scores.set(entry.name, (scores.get(entry.name) || 0) + match);
  }

  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  // Guarantee at least a baseline skill if nothing matched
  if (ranked.length === 0 && inventoryIds.has('strategic-reasoning')) {
    ranked.push('strategic-reasoning');
  }

  return ranked;
}
