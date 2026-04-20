// Grid manager — CRUD for the bot grid.
// Each bot is a slot in grid-config.json with its own per-bot directory under
// outdoorsv1/backend/bot/bots/<botId>/ holding specialization.md, memory/, session.json.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = join(__dirname, '..', 'bot');
const BOTS_DIR = join(BOT_ROOT, 'bots');
const GRID_CONFIG_PATH = join(BOT_ROOT, 'grid-config.json');
const GLOBAL_MEMORY_ROOT = join(BOT_ROOT, 'memory');

export const GRID_SIZE = 8;

const DEFAULT_TEMPLATES = {
  coder: {
    name: 'Coder',
    emoji: '👨‍💻',
    color: '#5b8def',
    specialization:
      'You help with software engineering: writing, debugging, and reviewing code. ' +
      'Default to clean, idiomatic solutions; ask the user clarifying questions before writing if requirements are ambiguous.',
    skillIds: ['coding', 'browser-use', 'chrome-use', 'ui'],
  },
  researcher: {
    name: 'Researcher',
    emoji: '🔎',
    color: '#22b07d',
    specialization:
      'You help with deep web research and project investigation. ' +
      'Verify claims with multiple sources, cite where you got things, and structure findings clearly.',
    skillIds: ['project-research', 'browser-use', 'strategic-reasoning'],
  },
  email: {
    name: 'Email assistant',
    emoji: '✉️',
    color: '#e0a82e',
    specialization:
      'You help draft, schedule, and manage Gmail. ' +
      'Match the user\'s writing voice. Confirm recipients and content before sending.',
    skillIds: ['email', 'email-management', 'gmail-scheduling'],
  },
  writer: {
    name: 'Writer',
    emoji: '✍️',
    color: '#d05a8c',
    specialization:
      'You help write blogs and long-form content. ' +
      'Engaging, well-researched, no em-dashes, get to the point quickly.',
    skillIds: ['blog-writer', 'browser-use'],
  },
};

export function listTemplates() {
  return Object.entries(DEFAULT_TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name,
    emoji: t.emoji,
    color: t.color,
    skillIds: t.skillIds,
  }));
}

function emptyGrid() {
  const slots = [];
  for (let i = 0; i < GRID_SIZE; i++) slots.push({ slotIndex: i, botId: null });
  return {
    version: 1,
    gridSize: GRID_SIZE,
    activeBotId: null,
    defaultTransportBotId: null,
    slots,
  };
}

function ensureBotsDir() {
  if (!existsSync(BOTS_DIR)) mkdirSync(BOTS_DIR, { recursive: true });
}

export function loadGrid() {
  ensureBotsDir();
  if (!existsSync(GRID_CONFIG_PATH)) {
    const fresh = emptyGrid();
    writeFileSync(GRID_CONFIG_PATH, JSON.stringify(fresh, null, 2), 'utf-8');
    return fresh;
  }
  try {
    const raw = readFileSync(GRID_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Backfill any missing slots up to GRID_SIZE
    if (!Array.isArray(parsed.slots)) parsed.slots = [];
    while (parsed.slots.length < GRID_SIZE) {
      parsed.slots.push({ slotIndex: parsed.slots.length, botId: null });
    }
    parsed.gridSize = GRID_SIZE;
    if (parsed.activeBotId === undefined) parsed.activeBotId = null;
    if (parsed.defaultTransportBotId === undefined) parsed.defaultTransportBotId = null;
    return parsed;
  } catch {
    const fresh = emptyGrid();
    writeFileSync(GRID_CONFIG_PATH, JSON.stringify(fresh, null, 2), 'utf-8');
    return fresh;
  }
}

export function saveGrid(grid) {
  ensureBotsDir();
  writeFileSync(GRID_CONFIG_PATH, JSON.stringify(grid, null, 2), 'utf-8');
}

function newBotId() {
  return 'bot-' + randomBytes(3).toString('hex');
}

export function getBot(botId) {
  if (!botId) return null;
  const grid = loadGrid();
  const slot = grid.slots.find(s => s.botId === botId);
  return slot && slot.botId ? slot : null;
}

export function getBotDir(botId) {
  return join(BOTS_DIR, botId);
}

export function getBotMemoryRoot(botId) {
  return join(getBotDir(botId), 'memory');
}

export function getBotSessionPath(botId) {
  return join(getBotDir(botId), 'session.json');
}

export function getBotSpecializationPath(botId) {
  return join(getBotDir(botId), 'specialization.md');
}

export function readBotSpecialization(botId) {
  const p = getBotSpecializationPath(botId);
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

export function loadBotSession(botId) {
  const p = getBotSessionPath(botId);
  if (!existsSync(p)) return { claudeSessionId: null, lastActivity: 0, transcript: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return { claudeSessionId: null, lastActivity: 0, transcript: [] };
  }
}

export function saveBotSession(botId, sessionData) {
  ensureBotsDir();
  const dir = getBotDir(botId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getBotSessionPath(botId), JSON.stringify(sessionData, null, 2), 'utf-8');
}

export function setBotClaudeSessionId(botId, claudeSessionId) {
  if (!botId || !claudeSessionId) return;
  const data = loadBotSession(botId);
  data.claudeSessionId = claudeSessionId;
  data.lastActivity = Date.now();
  saveBotSession(botId, data);
}

export function clearBotClaudeSession(botId) {
  if (!botId) return;
  const data = loadBotSession(botId);
  data.claudeSessionId = null;
  data.lastActivity = Date.now();
  saveBotSession(botId, data);
}

function scaffoldBotDir(botId, specializationText) {
  const dir = getBotDir(botId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'memory', 'skills'), { recursive: true });
  mkdirSync(join(dir, 'memory', 'knowledge'), { recursive: true });
  mkdirSync(join(dir, 'memory', 'sites'), { recursive: true });
  writeFileSync(join(dir, 'specialization.md'), specializationText || '', 'utf-8');
  writeFileSync(
    join(dir, 'memory', 'memory-index.md'),
    '# Memory Index\n\n_This bot has no learned memory yet. The learner will populate this as the bot is used._\n',
    'utf-8'
  );
  writeFileSync(
    getBotSessionPath(botId),
    JSON.stringify({ claudeSessionId: null, lastActivity: 0, transcript: [] }, null, 2),
    'utf-8'
  );
}

/**
 * Create a bot in a slot. Two paths:
 *   - templateId: use one of DEFAULT_TEMPLATES (skips Model B, uses preselected skills)
 *   - specializationText: free-text; pickSkillsForSpecialization() must have been called first
 *     and the result passed in via `skillIds` (we don't run Model B inline to avoid blocking).
 *
 * @param {number} slotIndex
 * @param {object} opts
 *   @param {string} [opts.templateId]
 *   @param {string} [opts.name]
 *   @param {string} [opts.project]
 *   @param {string} [opts.emoji]
 *   @param {string} [opts.color]
 *   @param {string} [opts.specializationText]   // for scratch
 *   @param {string[]} [opts.skillIds]           // for scratch (resolved by Model B), or override for templates
 */
export function createBotInSlot(slotIndex, opts = {}) {
  const grid = loadGrid();
  const slot = grid.slots.find(s => s.slotIndex === slotIndex);
  if (!slot) throw new Error(`Invalid slotIndex: ${slotIndex}`);
  if (slot.botId) throw new Error(`Slot ${slotIndex} is already occupied`);

  const botId = newBotId();
  let name, emoji, color, specializationText, skillIds, templateId;

  if (opts.templateId && DEFAULT_TEMPLATES[opts.templateId]) {
    const tpl = DEFAULT_TEMPLATES[opts.templateId];
    templateId = opts.templateId;
    name = opts.name || tpl.name;
    emoji = opts.emoji || tpl.emoji;
    color = opts.color || tpl.color;
    specializationText = opts.specializationText || tpl.specialization;
    skillIds = Array.isArray(opts.skillIds) && opts.skillIds.length
      ? opts.skillIds
      : tpl.skillIds.slice();
  } else {
    templateId = null;
    name = opts.name || 'New bot';
    emoji = opts.emoji || '🤖';
    color = opts.color || '#888888';
    specializationText = opts.specializationText || '';
    skillIds = Array.isArray(opts.skillIds) ? opts.skillIds.slice() : [];
  }

  scaffoldBotDir(botId, specializationText);

  const now = new Date().toISOString();
  const filledSlot = {
    slotIndex,
    botId,
    name,
    project: opts.project || '',
    emoji,
    color,
    templateId,
    skillIds,
    createdAt: now,
    updatedAt: now,
  };
  grid.slots[grid.slots.findIndex(s => s.slotIndex === slotIndex)] = filledSlot;

  // First filled slot becomes the active + transport-default
  if (!grid.activeBotId) grid.activeBotId = botId;
  if (slotIndex === 0 || !grid.defaultTransportBotId) grid.defaultTransportBotId = botId;

  saveGrid(grid);
  return filledSlot;
}

export function editBot(botId, patch) {
  const grid = loadGrid();
  const idx = grid.slots.findIndex(s => s.botId === botId);
  if (idx === -1) throw new Error(`Unknown bot: ${botId}`);
  const slot = grid.slots[idx];

  const next = { ...slot };
  if (typeof patch.name === 'string') next.name = patch.name;
  if (typeof patch.project === 'string') next.project = patch.project;
  if (typeof patch.emoji === 'string') next.emoji = patch.emoji;
  if (typeof patch.color === 'string') next.color = patch.color;
  if (Array.isArray(patch.skillIds)) next.skillIds = patch.skillIds;
  next.updatedAt = new Date().toISOString();
  grid.slots[idx] = next;

  if (typeof patch.specializationText === 'string') {
    const dir = getBotDir(botId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(getBotSpecializationPath(botId), patch.specializationText, 'utf-8');
  }

  saveGrid(grid);
  return next;
}

export function deleteBot(botId) {
  const grid = loadGrid();
  const idx = grid.slots.findIndex(s => s.botId === botId);
  if (idx === -1) return false;
  const slotIndex = grid.slots[idx].slotIndex;

  // Remove from disk — guard against path traversal
  const dir = getBotDir(botId);
  const root = resolve(BOTS_DIR);
  const resolvedDir = resolve(dir);
  if (resolvedDir.startsWith(root + '\\') || resolvedDir.startsWith(root + '/')) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  grid.slots[idx] = { slotIndex, botId: null };
  if (grid.activeBotId === botId) {
    const nextActive = grid.slots.find(s => s.botId);
    grid.activeBotId = nextActive ? nextActive.botId : null;
  }
  if (grid.defaultTransportBotId === botId) {
    grid.defaultTransportBotId = grid.slots[0]?.botId || null;
  }
  saveGrid(grid);
  return true;
}

export function moveBot(fromIdx, toIdx) {
  const grid = loadGrid();
  const a = grid.slots.find(s => s.slotIndex === fromIdx);
  const b = grid.slots.find(s => s.slotIndex === toIdx);
  if (!a || !b) return false;
  const aCopy = { ...a, slotIndex: toIdx };
  const bCopy = { ...b, slotIndex: fromIdx };
  const ai = grid.slots.findIndex(s => s.slotIndex === fromIdx);
  const bi = grid.slots.findIndex(s => s.slotIndex === toIdx);
  grid.slots[bi] = aCopy;
  grid.slots[ai] = bCopy;
  // Slot 0's bot is the transport default
  grid.defaultTransportBotId = grid.slots.find(s => s.slotIndex === 0)?.botId || null;
  saveGrid(grid);
  return true;
}

export function setActiveBot(botId) {
  const grid = loadGrid();
  if (botId && !grid.slots.find(s => s.botId === botId)) return false;
  grid.activeBotId = botId || null;
  saveGrid(grid);
  return true;
}

export function getActiveBotId() {
  return loadGrid().activeBotId || null;
}

export function getDefaultTransportBotId() {
  return loadGrid().defaultTransportBotId || null;
}

/**
 * Build the per-bot Model D context: shared user-profile + bot's specialization +
 * the bot's frozen skill list, with bot-scoped memory taking priority over global.
 *
 * Returns an array of { name, category, content } compatible with model-d.js
 * `memoryContents` input.
 */
export function buildBotMemoryContents(botId) {
  if (!botId) return [];
  const slot = getBot(botId);
  if (!slot) return [];

  const out = [];

  // Always: user profile (shared, scraped during onboarding)
  const userProfile = join(GLOBAL_MEMORY_ROOT, 'preferences', 'user-profile.md');
  if (existsSync(userProfile)) {
    try {
      out.push({
        name: 'user-profile',
        category: 'preference',
        content: readFileSync(userProfile, 'utf-8'),
      });
    } catch {}
  }

  // Always: browser preferences (so Model D picks the right MCP toolset)
  const browserPrefs = join(GLOBAL_MEMORY_ROOT, 'preferences', 'browser-preferences.md');
  if (existsSync(browserPrefs)) {
    try {
      out.push({
        name: 'browser-preferences',
        category: 'preference',
        content: readFileSync(browserPrefs, 'utf-8'),
      });
    } catch {}
  }

  // Bot's specialization, surfaced as a top-priority skill
  const specPath = getBotSpecializationPath(botId);
  if (existsSync(specPath)) {
    try {
      const spec = readFileSync(specPath, 'utf-8').trim();
      if (spec) {
        out.push({
          name: `${slot.name || 'this-bot'}-specialization`,
          category: 'skill',
          content: spec,
        });
      }
    } catch {}
  }

  // Bot's frozen skill list, resolved against bot-scoped memory first, falling
  // back to global memory when the bot hasn't yet learned its own version.
  const botSkillsDir = join(getBotMemoryRoot(botId), 'skills');
  const globalSkillsDir = join(GLOBAL_MEMORY_ROOT, 'skills');
  for (const id of slot.skillIds || []) {
    const botPath = join(botSkillsDir, id, 'SKILL.md');
    const globalPath = join(globalSkillsDir, id, 'SKILL.md');
    const altGlobalPath = join(globalSkillsDir, id + '.md'); // some skills are flat .md files
    let chosen = null;
    if (existsSync(botPath)) chosen = botPath;
    else if (existsSync(globalPath)) chosen = globalPath;
    else if (existsSync(altGlobalPath)) chosen = altGlobalPath;
    if (!chosen) continue;
    try {
      out.push({
        name: id,
        category: 'skill',
        content: readFileSync(chosen, 'utf-8'),
      });
    } catch {}
  }

  return out;
}

/**
 * Return inventory for Model B at bot-creation time — the global skill set
 * (so a scratch bot can pick from everything available).
 */
export function getGlobalSkillInventory() {
  const out = [];
  const skillsDir = join(GLOBAL_MEMORY_ROOT, 'skills');
  if (!existsSync(skillsDir)) return out;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      if (existsSync(skillFile)) {
        out.push({
          name: entry.name,
          category: 'skill',
          description: firstDescription(skillFile),
        });
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({
        name: entry.name.replace('.md', ''),
        category: 'skill',
        description: firstDescription(join(skillsDir, entry.name)),
      });
    }
  }
  return out;
}

function firstDescription(filepath) {
  try {
    const content = readFileSync(filepath, 'utf-8');
    const desc = content.match(/^---[\s\S]*?description:\s*(.+)/m);
    if (desc) return desc[1].trim();
    const heading = content.match(/^#\s+(.+)/m);
    if (heading) return heading[1].trim();
    return '';
  } catch {
    return '';
  }
}
