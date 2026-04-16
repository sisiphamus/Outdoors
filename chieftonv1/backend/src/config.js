import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

const defaults = {
  port: 3847,
  allowedNumbers: [],
  allowAllNumbers: false,
  codexCommand: 'codex',
  codexArgs: ['exec'],
  maxResponseLength: 4000,
  messageTimeout: 120000,
  rateLimitPerMinute: 10,
  workingDirectory: process.cwd(),
  codeCodexArgs: ['exec'],
  codeWorkingDirectory: process.cwd(),
  prefix: '!chiefton ',
  messageCount: 0,
  referrals: [],
  authDir: join(__dirname, '..', 'auth_state'),
  chieftonGroupJid: '',
};

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      const cfg = { ...defaults, ...file };
      // Migrate: rename triggers → automations (backwards-compatible)
      if (cfg.triggers && !cfg.automations) {
        cfg.automations = cfg.triggers;
        delete cfg.triggers;
      }
      return cfg;
    } catch {
      return { ...defaults };
    }
  }
  return { ...defaults };
}

function saveConfig(config) {
  const toSave = { ...config };
  delete toSave.authDir;
  const tmpPath = CONFIG_PATH + `.tmp.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(toSave, null, 2));
  renameSync(tmpPath, CONFIG_PATH);
}

const config = loadConfig();

export { config, saveConfig, loadConfig };
