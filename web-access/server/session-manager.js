import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeBinary, encodeEvent, BIN_WRITE, BIN_SCROLLBACK } from './protocol.js';

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Ported from electron/main.js getShellLaunchConfigs (66-92).
function getShellLaunchConfigs() {
  if (process.platform === 'win32') {
    return [
      { shell: process.env.VIBE99_WINDOWS_SHELL, args: [] },
      { shell: 'powershell.exe', args: [] },
      { shell: 'pwsh.exe', args: [] },
      { shell: process.env.ComSpec, args: [] },
      { shell: 'cmd.exe', args: [] },
    ].filter((c) => typeof c.shell === 'string' && c.shell.length > 0);
  }
  const candidates = [];
  if (process.env.SHELL && path.isAbsolute(process.env.SHELL)) candidates.push(process.env.SHELL);
  if (process.platform === 'darwin') candidates.push('/bin/zsh', '/bin/bash', '/bin/sh');
  else candidates.push('/bin/bash', '/bin/sh');
  return [...new Set(candidates)].filter(isExecutableFile).map((shell) => ({ shell, args: ['-il'] }));
}

// Ported from electron/main.js getSpawnWorkingDirectory (94-104).
function getSpawnWorkingDirectory(cwd, fallback) {
  const preferred = cwd || fallback || os.homedir();
  try {
    if (fs.statSync(preferred).isDirectory()) return preferred;
  } catch {}
  return os.homedir();
}

// SessionManager owns persistent terminal sessions (ptys), independent of client
// connections. createTerminal is IDEMPOTENT (reattach + replay scrollback, no
// respawn). Phase 2: layout is the source of truth; live output is BROADCAST to
// all clients; reattach scrollback is UNICAST to the requesting client only
// (so other already-connected clients don't get a duplicate replay).
export class SessionManager {
  constructor({ pty, config, broadcast = null }) {
    this._pty = pty;
    this._config = config;
    this._broadcast = broadcast; // (frame: string|Buffer) => void ; null when no clients
    this._sessions = new Map(); // paneId -> Session
  }

  setBroadcastSink(broadcast) {
    this._broadcast = broadcast;
  }

  listSessions() {
    return [...this._sessions.values()].map((s) => ({
      paneId: s.paneId,
      alive: s.alive,
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd,
      title: s.title,
    }));
  }

  // unicast: optional (frame)=>void to the requesting client; used so reattach
  // scrollback is sent only to that client. Falls back to broadcast if absent.
  createTerminal({ paneId, cols, rows, cwd }, unicast = null) {
    const existing = this._sessions.get(paneId);

    if (existing && existing.alive) {
      // Do NOT resize here: the Gateway owns pty sizing via min-size (ADR-005).
      // Just replay scrollback to the requesting client (unicast).
      const sink = unicast || ((f) => this._broadcast?.(f));
      if (existing.scrollback.length) {
        sink(encodeBinary(BIN_SCROLLBACK, paneId, existing.scrollback.toString('utf8')));
      }
      return { paneId, reattached: true };
    }

    if (existing) this._destroyPty(existing);
    if (this._sessions.size >= this._config.maxSessions) {
      const err = new Error(`maxSessions (${this._config.maxSessions}) reached`);
      err.code = 'MAX_SESSIONS';
      throw err;
    }

    const spawnCwd = getSpawnWorkingDirectory(cwd, this._config.defaultCwd);
    const shellConfigs = getShellLaunchConfigs();
    let ptyProc = null;
    let lastError;
    for (const { shell, args } of shellConfigs) {
      try {
        ptyProc = this._pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: Math.max(20, cols || 80),
          rows: Math.max(8, rows || 24),
          cwd: spawnCwd,
          env: { ...process.env, COLORTERM: 'truecolor', TERM: 'xterm-256color' },
        });
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!ptyProc) throw lastError ?? new Error(`No executable shell found for cwd ${spawnCwd}`);

    const session = {
      paneId,
      pty: ptyProc,
      scrollback: Buffer.alloc(0),
      alive: true,
      cols: Math.max(20, cols || 80),
      rows: Math.max(8, rows || 24),
      cwd: spawnCwd,
      title: path.basename(spawnCwd) || spawnCwd,
    };
    ptyProc.onData((data) => this._onPtyData(paneId, data));
    ptyProc.onExit((exit) => this._onPtyExit(paneId, exit.exitCode));
    this._sessions.set(paneId, session);
    return { paneId, reattached: false };
  }

  write(paneId, data) {
    const s = this._sessions.get(paneId);
    if (s && s.alive) {
      try { s.pty.write(data); } catch {}
    }
  }

  resize(paneId, cols, rows) {
    const s = this._sessions.get(paneId);
    if (s && s.alive) {
      const c = Math.max(20, cols || s.cols);
      const r = Math.max(8, rows || s.rows);
      try { s.pty.resize(c, r); } catch {}
      s.cols = c;
      s.rows = r;
    }
  }

  destroy(paneId) {
    const s = this._sessions.get(paneId);
    if (!s) return;
    this._destroyPty(s);
    this._sessions.delete(paneId);
  }

  destroyAll() {
    for (const s of this._sessions.values()) this._destroyPty(s);
    this._sessions.clear();
  }

  _onPtyData(paneId, data) {
    const s = this._sessions.get(paneId);
    if (!s) return;
    this._appendScrollback(s, data);
    this._broadcast?.(encodeBinary(BIN_WRITE, paneId, data));
  }

  _onPtyExit(paneId, exitCode) {
    const s = this._sessions.get(paneId);
    if (!s) return;
    s.alive = false;
    this._broadcast?.(encodeEvent('terminal-exit', { paneId, exitCode }));
  }

  _appendScrollback(session, data) {
    const buf = Buffer.concat([session.scrollback, Buffer.from(data, 'utf8')]);
    const cap = this._config.scrollbackCapBytes;
    if (buf.length > cap) {
      const drop = Math.min(buf.length - cap + Math.floor(cap * 0.1), buf.length);
      session.scrollback = buf.subarray(drop);
    } else {
      session.scrollback = buf;
    }
  }

  _destroyPty(session) {
    try { session.pty.kill(); } catch {}
    session.alive = false;
  }
}
