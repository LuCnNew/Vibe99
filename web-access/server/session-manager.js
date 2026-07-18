import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeBinary, encodeEvent, BIN_WRITE } from './protocol.js';

const OUTPUT_BATCH_MS = 4;
const OUTPUT_BATCH_BYTES = 32 * 1024;

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
// connections. Output history is a bounded chunk deque with byte sequence
// offsets, allowing clients to unsubscribe and later catch up incrementally.
export class SessionManager {
  constructor({ pty, config, broadcast = null }) {
    this._pty = pty;
    this._config = config;
    this._broadcast = broadcast; // (frame, {paneId}?) => void ; null when no clients
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
      outputSeq: s.nextSeq,
    }));
  }

  createTerminal({ paneId, cols, rows, cwd }) {
    const existing = this._sessions.get(paneId);

    if (existing && existing.alive) {
      // Do NOT resize here: the Gateway owns pty sizing via min-size (ADR-005).
      return { paneId, reattached: true, outputSeq: existing.nextSeq };
    }

    if (existing) {
      this._destroyPty(existing);
      this._sessions.delete(paneId);
    }
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
      history: [],
      historyBytes: 0,
      nextSeq: 0,
      pendingOutput: [],
      pendingOutputBytes: 0,
      outputTimer: null,
      alive: true,
      cols: Math.max(20, cols || 80),
      rows: Math.max(8, rows || 24),
      cwd: spawnCwd,
      title: path.basename(spawnCwd) || spawnCwd,
    };
    ptyProc.onData((data) => this._onPtyData(paneId, data));
    ptyProc.onExit((exit) => this._onPtyExit(paneId, exit.exitCode));
    this._sessions.set(paneId, session);
    return { paneId, reattached: false, outputSeq: 0 };
  }

  getOutputSince(paneId, afterSeq = 0) {
    const s = this._sessions.get(paneId);
    if (!s) {
      const err = new Error(`terminal not found: ${paneId}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    // Make pending PTY output part of the same ordered snapshot.
    this._flushOutput(s);
    const earliestSeq = s.history.length ? s.history[0].seq : s.nextSeq;
    const requestedSeq = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    let reset = requestedSeq < earliestSeq || requestedSeq > s.nextSeq;
    let fromSeq = reset ? earliestSeq : requestedSeq;
    // A malformed/stale client may request the middle of a UTF-8 code point.
    // Advance to the next valid boundary and force a terminal reset.
    for (const chunk of s.history) {
      const endSeq = chunk.seq + chunk.data.length;
      if (fromSeq <= chunk.seq || fromSeq >= endSeq) continue;
      let offset = fromSeq - chunk.seq;
      while (offset < chunk.data.length && (chunk.data[offset] & 0xc0) === 0x80) offset += 1;
      const alignedSeq = chunk.seq + offset;
      if (alignedSeq !== fromSeq) {
        fromSeq = alignedSeq;
        reset = true;
      }
      break;
    }
    const chunks = [];
    for (const chunk of s.history) {
      const endSeq = chunk.seq + chunk.data.length;
      if (endSeq <= fromSeq) continue;
      const offset = Math.max(0, fromSeq - chunk.seq);
      chunks.push({ seq: chunk.seq + offset, data: chunk.data.subarray(offset) });
    }
    return { reset, fromSeq, toSeq: s.nextSeq, chunks };
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
    const buf = Buffer.from(data, 'utf8');
    if (!buf.length) return;
    s.pendingOutput.push(buf);
    s.pendingOutputBytes += buf.length;
    if (s.pendingOutputBytes >= OUTPUT_BATCH_BYTES) {
      this._flushOutput(s);
    } else if (!s.outputTimer) {
      s.outputTimer = setTimeout(() => this._flushOutput(s), OUTPUT_BATCH_MS);
    }
  }

  _onPtyExit(paneId, exitCode) {
    const s = this._sessions.get(paneId);
    if (!s) return;
    this._flushOutput(s);
    s.alive = false;
    this._sessions.delete(paneId);
    this._broadcast?.(
      encodeEvent('terminal-exit', { paneId, exitCode }),
      { paneId, ordered: true },
    );
  }

  _flushOutput(session) {
    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
      session.outputTimer = null;
    }
    if (!session.pendingOutputBytes) return;
    const data = session.pendingOutput.length === 1
      ? session.pendingOutput[0]
      : Buffer.concat(session.pendingOutput, session.pendingOutputBytes);
    session.pendingOutput = [];
    session.pendingOutputBytes = 0;
    const seq = session.nextSeq;
    session.nextSeq += data.length;
    this._appendHistory(session, seq, data);
    this._broadcast?.(encodeBinary(BIN_WRITE, session.paneId, data), { paneId: session.paneId });
  }

  _appendHistory(session, seq, data) {
    const cap = this._config.scrollbackCapBytes;
    let kept = data;
    let keptSeq = seq;
    if (kept.length > cap) {
      let start = kept.length - cap;
      while (start < kept.length && (kept[start] & 0xc0) === 0x80) start += 1;
      keptSeq += start;
      // Copy the retained tail so a tiny history window does not pin a very
      // large one-off PTY output buffer through subarray's shared backing store.
      kept = Buffer.from(kept.subarray(start));
      session.history = [];
      session.historyBytes = 0;
    }
    session.history.push({ seq: keptSeq, data: kept });
    session.historyBytes += kept.length;
    while (session.historyBytes > cap && session.history.length > 1) {
      const dropped = session.history.shift();
      session.historyBytes -= dropped.data.length;
    }
  }

  _destroyPty(session) {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    try { session.pty.kill(); } catch {}
    session.alive = false;
  }
}
