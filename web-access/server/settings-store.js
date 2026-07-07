import fs from 'node:fs';
import path from 'node:path';

// Ported from electron/config.ts (loadConfig/saveConfig/sanitizeConfig), de-TS'd.
// Settings shape: { version: 1, ui: { fontSize, paneOpacity, paneWidth } }.

const CURRENT_CONFIG_VERSION = 1;
const DEFAULT_UI = Object.freeze({ fontSize: 13, paneOpacity: 0.8, paneWidth: 720 });

function sanitizeUi(ui) {
  const u = ui ?? {};
  const fontSize =
    typeof u.fontSize === 'number' && Number.isFinite(u.fontSize) ? u.fontSize : DEFAULT_UI.fontSize;
  const paneOpacity =
    typeof u.paneOpacity === 'number' && Number.isFinite(u.paneOpacity)
      ? u.paneOpacity
      : DEFAULT_UI.paneOpacity;
  const paneWidth =
    typeof u.paneWidth === 'number' && Number.isFinite(u.paneWidth) ? u.paneWidth : DEFAULT_UI.paneWidth;
  return {
    fontSize: Math.max(10, Math.min(24, Math.round(fontSize))),
    paneOpacity: Math.max(0.55, Math.min(1, Number(paneOpacity.toFixed(2)))),
    paneWidth: Math.max(520, Math.min(1000, Math.round(paneWidth / 10) * 10)),
  };
}

function sanitizeConfig(candidate) {
  if (candidate && typeof candidate === 'object' && candidate.version === CURRENT_CONFIG_VERSION) {
    return { version: CURRENT_CONFIG_VERSION, ui: sanitizeUi(candidate.ui) };
  }
  if (candidate && typeof candidate === 'object') {
    return { version: CURRENT_CONFIG_VERSION, ui: sanitizeUi(candidate) }; // legacy flat shape
  }
  return { version: CURRENT_CONFIG_VERSION, ui: { ...DEFAULT_UI } };
}

export class SettingsStore {
  constructor({ settingsFile }) {
    this._path = settingsFile;
  }

  load() {
    try {
      return sanitizeConfig(JSON.parse(fs.readFileSync(this._path, 'utf8')));
    } catch {
      return { version: CURRENT_CONFIG_VERSION, ui: { ...DEFAULT_UI } };
    }
  }

  save(next) {
    const sanitized = sanitizeConfig(next);
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    fs.writeFileSync(this._path, JSON.stringify(sanitized, null, 2));
    return sanitized;
  }
}
