import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { WebSocketServer } from 'ws';
import {
  OPS,
  EVENTS,
  BIN_WRITE,
  encodeResponseOk,
  encodeResponseErr,
  encodeEvent,
  decodeTextFrame,
  decodeBinary,
} from './protocol.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const INDEX_HTML_PATH = path.join(WEB_DIR, 'index.html');
const SHIM_PATH = path.join(WEB_DIR, 'vibe99-shim.js');

const UNAUTH_CODE = 4401;
const jsMime = 'text/javascript; charset=utf-8';
const HEARTBEAT_MS = 30000;

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export class RealtimeGateway {
  constructor({ config, auth, sessions, settings, concurrency }) {
    this._config = config;
    this._auth = auth;
    this._sessions = sessions;
    this._settings = settings;
    this._concurrency = concurrency;
    this._clients = new Map(); // id -> { ws, id, name, addr, connectedAt, sizes:Map, pongPending }
    this._nextClientId = 1;
    this._server = null;
    this._wss = null;
    this._heartbeat = null;
    // SessionManager broadcasts live output / exit to all clients.
    this._sessions.setBroadcastSink((frame) => this._broadcast(frame));
  }

  listen() {
    const serveStatic = sirv(this._config.staticRoot, {
      dev: false,
      single: false,
      setHeaders: (res, pathname) => {
        setNoStoreHeaders(res);
        if (pathname.endsWith('.mjs') || pathname.endsWith('.js')) {
          res.setHeader('Content-Type', jsMime);
        }
      },
    });

    const handler = (req, res) => {
      const pathname = (req.url || '/').split('?')[0];
      if (pathname === '/' || pathname === '/index.html') return this._serveIndex(res);
      if (pathname === '/web/vibe99-shim.js') return this._serveFile(res, SHIM_PATH, jsMime);
      serveStatic(req, res);
    };

    this._server = http.createServer(handler);
    this._wss = new WebSocketServer({ server: this._server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
    this._wss.on('connection', (ws, req) => this._handleConnection(ws, req));
    this._wss.on('error', (e) => logger.error('ws server error:', e.message));

    this._server.listen(this._config.port, this._config.host, () => {
      logger.info(
        `listening host=${this._config.host} port=${this._config.port} (ws=/ws, static=${this._config.staticRoot})`,
      );
    });
    this._heartbeat = setInterval(() => this._tickHeartbeat(), HEARTBEAT_MS);
  }

  close() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    try { this._wss?.close(); } catch {}
    try { this._server?.close(); } catch {}
  }

  // --- static ---
  _serveIndex(res) {
    let html;
    try {
      html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    } catch (e) {
      res.statusCode = 500;
      res.end('index.html missing: ' + e.message);
      return;
    }
    const boot = {
      platform: process.platform,
      defaultCwd: this._config.defaultCwd,
      defaultTabTitle: this._config.defaultTabTitle,
      panes: this._sessions.listSessions(), // server is the layout source of truth
    };
    const bootScript = `<script>window.__VIBE99_BOOT__ = ${JSON.stringify(boot)};</script>`;
    html = html.replace('<!-- @VIBE99_BOOT@ -->', bootScript);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    setNoStoreHeaders(res);
    res.end(html);
  }

  _serveFile(res, filePath, mime) {
    try {
      res.setHeader('Content-Type', mime);
      setNoStoreHeaders(res);
      res.end(fs.readFileSync(filePath));
    } catch (e) {
      res.statusCode = 500;
      res.end('read error: ' + e.message);
    }
  }

  _extractToken(req) {
    const proto = req.headers['sec-websocket-protocol'];
    if (typeof proto === 'string' && proto.length > 0 && !proto.includes(',')) return proto.trim();
    const authz = req.headers['authorization'];
    if (typeof authz === 'string' && authz.toLowerCase().startsWith('bearer ')) return authz.slice(7).trim();
    const q = (req.url || '').split('?')[1];
    if (q) return new URLSearchParams(q).get('token');
    return null;
  }

  _extractName(req) {
    const q = (req.url || '').split('?')[1];
    if (q) {
      const name = new URLSearchParams(q).get('name');
      if (name) return name.slice(0, 40);
    }
    return null;
  }

  // --- connection lifecycle ---
  _handleConnection(ws, req) {
    const remote = req.socket.remoteAddress;
    const token = this._extractToken(req);
    if (!token || !this._auth.check(token)) {
      logger.warn(`auth-failed remote=${remote}`);
      try { ws.close(UNAUTH_CODE, 'unauthorized'); } catch {}
      return;
    }

    const id = `c${this._nextClientId++}`;
    const name = this._extractName(req) || id;
    const client = { ws, id, name, addr: remote, connectedAt: Date.now(), sizes: new Map(), pongPending: false };
    this._clients.set(id, client);
    logger.info(`client connected id=${id} name=${name} remote=${remote} (total=${this._clients.size})`);

    this._sendTo(client, encodeEvent(EVENTS.HELLO, {
      platform: process.platform,
      defaultCwd: this._config.defaultCwd,
      defaultTabTitle: this._config.defaultTabTitle,
    }));
    this._sendTo(client, encodeEvent(EVENTS.LAYOUT, { panes: this._sessions.listSessions() }));
    this._broadcastClients();

    ws.on('message', (msg, isBinary) => this._onMessage(client, msg, isBinary));
    ws.on('close', () => this._handleDisconnect(client));
    ws.on('error', () => {});
    ws.on('pong', () => { client.pongPending = false; });
  }

  _handleDisconnect(client) {
    this._clients.delete(client.id);
    logger.info(`client disconnected id=${client.id} (total=${this._clients.size}) (sessions kept alive)`);
    this._recomputeMinAll(); // this client's sizes leave the min pool
    this._broadcastClients();
  }

  _sendTo(client, frame) {
    if (client.ws.readyState !== 1) return;
    if (typeof frame === 'string') client.ws.send(frame);
    else client.ws.send(frame, { binary: true });
  }

  _broadcast(frame) {
    for (const c of this._clients.values()) this._sendTo(c, frame);
  }

  _broadcastClients() {
    const list = [...this._clients.values()].map((c) => ({ id: c.id, name: c.name, addr: c.addr }));
    this._broadcast(encodeEvent(EVENTS.CLIENTS, { clients: list }));
  }

  _broadcastLayout() {
    this._broadcast(encodeEvent(EVENTS.LAYOUT, { panes: this._sessions.listSessions() }));
  }

  // --- inbound ---
  _onMessage(client, msg, isBinary) {
    if (isBinary) {
      let parsed;
      try { parsed = decodeBinary(msg); } catch { return; }
      if (parsed.op === BIN_WRITE && this._concurrency.canWrite(parsed.paneId, client.id)) {
        this._sessions.write(parsed.paneId, parsed.data); // free-write (ADR-003 revised)
      }
      return;
    }

    let frame;
    try { frame = decodeTextFrame(msg.toString('utf8')); } catch { return; }
    if (!frame || frame.kind !== 'req') return;
    const { id, op, payload } = frame;
    const reply = (s) => this._sendTo(client, s);

    try {
      switch (op) {
        case OPS.TERMINAL_CREATE: {
          // reattach scrollback is UNICAST to this client (not broadcast).
          const r = this._sessions.createTerminal(payload, (f) => this._sendTo(client, f));
          reply(encodeResponseOk(id, r));
          this._recordSize(client, payload.paneId, payload.cols, payload.rows); // feed min-size from create-time dims
          this._broadcastLayout();
          break;
        }
        case OPS.TERMINAL_RESIZE: {
          reply(encodeResponseOk(id, {}));
          setImmediate(() => {
            try {
              this._recordSize(client, payload.paneId, payload.cols, payload.rows); // min-size applied inside
            } catch (e) {
              logger.warn(`resize failed client=${client.id} pane=${payload.paneId}: ${e.message}`);
            }
          });
          break;
        }
        case OPS.TERMINAL_DESTROY:
          this._sessions.destroy(payload.paneId);
          reply(encodeResponseOk(id, {}));
          this._broadcastLayout();
          break;
        case OPS.SETTINGS_LOAD:
          reply(encodeResponseOk(id, this._settings.load()));
          break;
        case OPS.SETTINGS_SAVE:
          reply(encodeResponseOk(id, this._settings.save(payload)));
          break;
        case OPS.CLIPBOARD_READ_TEXT:
          reply(encodeResponseOk(id, { text: '' }));
          break;
        case OPS.CLIPBOARD_SNAPSHOT:
          reply(encodeResponseOk(id, { text: '', hasImage: false }));
          break;
        case OPS.CLIPBOARD_WRITE_TEXT:
        case OPS.OPEN_EXTERNAL_URL:
        case OPS.SHOW_CONTEXT_MENU:
        case OPS.WINDOW_CLOSE:
          reply(encodeResponseOk(id, {}));
          break;
        default:
          reply(encodeResponseErr(id, `unknown op: ${op}`, 'UNKNOWN_OP'));
      }
    } catch (e) {
      reply(encodeResponseErr(id, e.message, e.code || 'ERROR'));
    }
  }

  // --- min-size reconciliation (ADR-005) ---
  _recordSize(client, paneId, cols, rows) {
    if (!paneId || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    client.sizes.set(paneId, { cols: Math.max(20, cols | 0), rows: Math.max(8, rows | 0) });
    this._recomputeMin(paneId);
  }

  _recomputeMin(paneId) {
    let minC = null;
    let minR = null;
    for (const c of this._clients.values()) {
      const s = c.sizes.get(paneId);
      if (!s) continue;
      minC = minC === null ? s.cols : Math.min(minC, s.cols);
      minR = minR === null ? s.rows : Math.min(minR, s.rows);
    }
    if (minC !== null) this._sessions.resize(paneId, minC, minR);
  }

  _recomputeMinAll() {
    const paneIds = new Set();
    for (const c of this._clients.values()) for (const pid of c.sizes.keys()) paneIds.add(pid);
    for (const pid of paneIds) this._recomputeMin(pid);
  }

  _tickHeartbeat() {
    for (const c of this._clients.values()) {
      if (c.pongPending) {
        try { c.ws.terminate(); } catch {} // dead connection
        continue;
      }
      c.pongPending = true;
      try { c.ws.ping(); } catch {}
    }
  }
}
