import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  port: 7777,
  host: '0.0.0.0',
  staticRoot: '/mnt/FAST/Vibe99',
  defaultCwd: os.homedir(),
  defaultTabTitle: 'Vibe99',
  scrollbackCapBytes: 524288,
  maxSessions: 16,
  settingsFile: path.join(os.homedir(), '.config', 'vibe99-web', 'settings.json'),
};

export function loadConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read config at ${configPath}: ${e.message}`);
  }

  const cfg = { ...DEFAULTS, ...raw };

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error('config.port must be an integer in [1,65535]');
  }
  if (typeof cfg.host !== 'string' || cfg.host.length === 0) {
    throw new Error('config.host must be a non-empty string');
  }
  if (typeof cfg.token !== 'string' || cfg.token.length < 8) {
    throw new Error('config.token must be a string of at least 8 characters');
  }
  if (cfg.token.length < 16) {
    console.warn(`[warn] config.token is short (${cfg.token.length} chars); use >= 16`);
  }

  // staticRoot must be the Vibe99 project root (we reuse src/renderer.js + node_modules).
  const rendererPath = path.join(cfg.staticRoot, 'src', 'renderer.js');
  if (!fs.existsSync(rendererPath)) {
    throw new Error(
      `config.staticRoot invalid: ${rendererPath} not found. Set staticRoot to the Vibe99 project root.`,
    );
  }

  if (!Number.isFinite(cfg.scrollbackCapBytes) || cfg.scrollbackCapBytes < 1024) {
    throw new Error('config.scrollbackCapBytes must be a number >= 1024');
  }
  if (!Number.isInteger(cfg.maxSessions) || cfg.maxSessions < 1) {
    throw new Error('config.maxSessions must be a positive integer');
  }

  return cfg;
}
