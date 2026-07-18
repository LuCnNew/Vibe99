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
  BIN_SCROLLBACK,
  encodeBinary,
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
const BULK_CHUNK_BYTES = 64 * 1024;
const BULK_BUFFER_HIGH_WATER = 256 * 1024;
const BULK_RETRY_MS = 10;
const BULK_QUEUE_MAX_BYTES = 4 * 1024 * 1024;

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function setLongCacheHeaders(res) {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}

const PUBLIC_NODE_MODULE_PREFIXES = [
  '/node_modules/@xterm/xterm/',
  '/node_modules/@xterm/addon-fit/',
  '/node_modules/@xterm/addon-web-links/',
  '/node_modules/@xterm/addon-webgl/',
];

function isPublicNodeModulePath(pathname) {
  const normalized = pathname.replace(/\\/g, '/');
  return PUBLIC_NODE_MODULE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return jsMime;
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function resolveStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\0')) return null;
  const rootPath = path.resolve(root);
  const filePath = path.resolve(rootPath, decoded.replace(/^\/+/, ''));
  if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) return null;
  return filePath;
}

export class RealtimeGateway {
  constructor({ config, auth, sessions, settings, concurrency }) {
    this._config = config;
    this._auth = auth;
    this._sessions = sessions;
    this._settings = settings;
    this._concurrency = concurrency;
    this._clients = new Map(); // id -> client state, including a FIFO bulk-data queue
    this._nextClientId = 1;
    this._server = null;
    this._wss = null;
    this._heartbeat = null;
    this._paneMinSizes = new Map();
    // SessionManager broadcasts live output / exit to all clients.
    this._sessions.setBroadcastSink((frame, meta) => this._broadcast(frame, meta));
  }

  listen() {
    const serveStatic = sirv(this._config.staticRoot, {
      dev: false,
      single: false,
      setHeaders: (res, pathname) => {
        setLongCacheHeaders(res);
        if (pathname.endsWith('.mjs') || pathname.endsWith('.js')) {
          res.setHeader('Content-Type', jsMime);
        }
      },
    });

    const handler = (req, res) => {
      const pathname = (req.url || '/').split('?')[0];
      if (pathname === '/' || pathname === '/index.html') return this._serveIndex(res);
      if (pathname === '/web/vibe99-shim.js') return this._serveFile(res, SHIM_PATH, jsMime);
      if (isPublicNodeModulePath(pathname)) return serveStatic(req, res);
      if (pathname.startsWith('/src/')) return this._serveProjectStatic(res, pathname);
      res.statusCode = 404;
      res.end('not found');
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
      const data = fs.readFileSync(filePath);
      res.setHeader('Content-Type', mime);
      setNoStoreHeaders(res);
      res.setHeader('Content-Length', data.byteLength);
      res.end(data);
    } catch (e) {
      res.statusCode = 500;
      res.end('read error: ' + e.message);
    }
  }

  _serveProjectStatic(res, pathname) {
    const filePath = resolveStaticPath(this._config.staticRoot, pathname);
    if (!filePath) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      const realRoot = fs.realpathSync(this._config.staticRoot);
      const realFile = fs.realpathSync(filePath);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const stats = fs.statSync(realFile);
      if (!stats.isFile()) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const data = fs.readFileSync(realFile);
      res.setHeader('Content-Type', contentTypeForPath(realFile));
      res.setHeader('Content-Length', data.byteLength);
      res.setHeader('Last-Modified', stats.mtime.toUTCString());
      setNoStoreHeaders(res);
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
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

  _extractProtocolVersion(req) {
    const q = (req.url || '').split('?')[1];
    if (!q) return 1;
    return Number(new URLSearchParams(q).get('protocol')) === 2 ? 2 : 1;
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
    const client = {
      ws,
      id,
      name,
      addr: remote,
      connectedAt: Date.now(),
      sizes: new Map(),
      pongPending: false,
      protocolVersion: this._extractProtocolVersion(req),
      subscriptions: new Map(),
      bulkQueue: [],
      bulkBytes: 0,
      bulkScheduled: false,
      bulkTimer: null,
    };
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
    const affectedPaneIds = [...client.sizes.keys()];
    this._clients.delete(client.id);
    if (client.bulkTimer) clearTimeout(client.bulkTimer);
    client.bulkTimer = null;
    client.bulkQueue.length = 0;
    client.bulkBytes = 0;
    logger.info(`client disconnected id=${client.id} (total=${this._clients.size}) (sessions kept alive)`);
    this._recomputeMinAll(affectedPaneIds); // this client's sizes leave the min pool
    this._broadcastClients();
  }

  _sendTo(client, frame) {
    if (client.ws.readyState !== 1) return;
    if (typeof frame === 'string') client.ws.send(frame);
    else client.ws.send(frame, { binary: true });
  }

  _broadcast(frame, meta = null) {
    for (const c of this._clients.values()) {
      if (Buffer.isBuffer(frame)) {
        const paneId = meta?.paneId;
        if (c.protocolVersion < 2 || (paneId && c.subscriptions.has(paneId))) {
          this._enqueueBulk(c, frame, paneId, c.subscriptions.get(paneId) ?? null);
        }
      } else if (
        meta?.ordered &&
        (c.protocolVersion < 2 || c.subscriptions.has(meta.paneId))
      ) {
        this._enqueueBulk(
          c,
          frame,
          meta.paneId,
          null,
          false,
          true,
        );
      }
      else this._sendTo(c, frame);
    }
  }

  _enqueueBulk(
    client,
    frame,
    paneId = null,
    generation = null,
    binary = true,
    protectedEntry = false,
  ) {
    if (client.ws.readyState !== 1) return;
    const frameBytes = Buffer.isBuffer(frame) ? frame.length : Buffer.byteLength(frame);
    if (client.bulkBytes + frameBytes > BULK_QUEUE_MAX_BYTES) {
      if (protectedEntry) {
        this._dropBulkPane(client, paneId);
        if (client.bulkBytes + frameBytes > BULK_QUEUE_MAX_BYTES) {
          this._sendTo(client, frame);
          return;
        }
      } else if (paneId && client.protocolVersion >= 2) {
        this._dropBulkPane(client, paneId);
        client.subscriptions.delete(paneId);
        client.sizes.delete(paneId);
        this._recomputeMin(paneId);
        this._sendTo(client, encodeEvent(EVENTS.TERMINAL_RESYNC_REQUIRED, { paneId }));
      } else {
        try { client.ws.close(4410, 'slow consumer'); } catch {}
      }
      if (!protectedEntry) return;
    }
    client.bulkQueue.push({ frame, frameBytes, paneId, generation, binary, protectedEntry });
    client.bulkBytes += frameBytes;
    this._scheduleBulkDrain(client);
  }

  _dropBulkPane(client, paneId) {
    const kept = [];
    let bytes = 0;
    for (const entry of client.bulkQueue) {
      if (entry.paneId === paneId && !entry.protectedEntry) continue;
      kept.push(entry);
      bytes += entry.frameBytes;
    }
    client.bulkQueue = kept;
    client.bulkBytes = bytes;
  }

  _scheduleBulkDrain(client, delay = 0) {
    if (client.bulkScheduled || client.ws.readyState !== 1) return;
    client.bulkScheduled = true;
    const run = () => {
      client.bulkScheduled = false;
      client.bulkTimer = null;
      this._drainBulk(client);
    };
    if (delay > 0) client.bulkTimer = setTimeout(run, delay);
    else setImmediate(run);
  }

  _drainBulk(client) {
    if (client.ws.readyState !== 1) {
      client.bulkQueue.length = 0;
      client.bulkBytes = 0;
      return;
    }
    if (!client.bulkQueue.length) return;
    if (client.ws.bufferedAmount > BULK_BUFFER_HIGH_WATER) {
      this._scheduleBulkDrain(client, BULK_RETRY_MS);
      return;
    }
    const entry = client.bulkQueue.shift();
    client.bulkBytes -= entry.frameBytes;
    if (
      entry.paneId &&
      client.protocolVersion >= 2 &&
      !entry.protectedEntry &&
      client.subscriptions.get(entry.paneId) !== entry.generation
    ) {
      this._scheduleBulkDrain(client);
      return;
    }
    if (entry.binary) client.ws.send(entry.frame, { binary: true });
    else client.ws.send(entry.frame);
    // Yield after every chunk so newly arrived control requests can jump ahead
    // of queued terminal history while binary terminal data remains FIFO.
    this._scheduleBulkDrain(client);
  }

  _enqueueHistory(client, paneId, chunks, generation = null) {
    for (const historyChunk of chunks) {
      const data = historyChunk.data;
      let start = 0;
      while (start < data.length) {
        let end = Math.min(start + BULK_CHUNK_BYTES, data.length);
        // Browser frames are decoded independently, so don't split UTF-8 code
        // points across chunks.
        if (end < data.length) {
          while (end > start && (data[end] & 0xc0) === 0x80) end -= 1;
        }
        if (end === start) end = Math.min(start + BULK_CHUNK_BYTES, data.length);
        this._enqueueBulk(
          client,
          encodeBinary(BIN_SCROLLBACK, paneId, data.subarray(start, end)),
          paneId,
          generation,
        );
        start = end;
      }
    }
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
          const result = this._sessions.createTerminal(payload);
          reply(encodeResponseOk(id, result));
          if (client.protocolVersion < 2) {
            const snapshot = this._sessions.getOutputSince(payload.paneId, 0);
            this._enqueueHistory(client, payload.paneId, snapshot.chunks);
            this._recordSize(client, payload.paneId, payload.cols, payload.rows);
          }
          if (!result.reattached) this._broadcastLayout();
          break;
        }
        case OPS.TERMINAL_SUBSCRIBE: {
          const paneId = payload.paneId;
          const snapshot = this._sessions.getOutputSince(paneId, payload.afterSeq);
          const generation = (client.subscriptions.get(paneId) || 0) + 1;
          client.subscriptions.set(paneId, generation);
          this._recordSize(client, paneId, payload.cols, payload.rows);
          reply(encodeResponseOk(id, {
            paneId,
            reset: snapshot.reset,
            fromSeq: snapshot.fromSeq,
            toSeq: snapshot.toSeq,
          }));
          this._enqueueHistory(client, paneId, snapshot.chunks, generation);
          break;
        }
        case OPS.TERMINAL_UNSUBSCRIBE: {
          const paneId = payload.paneId;
          client.subscriptions.delete(paneId);
          this._dropBulkPane(client, paneId);
          client.sizes.delete(paneId);
          this._recomputeMin(paneId);
          reply(encodeResponseOk(id, {}));
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
          for (const c of this._clients.values()) {
            c.subscriptions.delete(payload.paneId);
            this._dropBulkPane(c, payload.paneId);
            c.sizes.delete(payload.paneId);
          }
          this._paneMinSizes.delete(payload.paneId);
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
    const next = { cols: Math.max(20, cols | 0), rows: Math.max(8, rows | 0) };
    const prev = client.sizes.get(paneId);
    const changed = !prev || prev.cols !== next.cols || prev.rows !== next.rows;
    client.sizes.set(paneId, next);
    if (changed) {
      logger.info(`resize report client=${client.id} name=${client.name} pane=${paneId} size=${next.cols}x${next.rows}`);
    }
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
    if (minC !== null) {
      const nextKey = `${minC}x${minR}`;
      const prevKey = this._paneMinSizes.get(paneId);
      if (prevKey !== nextKey) {
        logger.info(`resize min pane=${paneId} ${prevKey || 'none'} -> ${nextKey} clients=${this._describePaneSizes(paneId)}`);
        this._paneMinSizes.set(paneId, nextKey);
      }
      this._sessions.resize(paneId, minC, minR);
    }
  }

  _describePaneSizes(paneId) {
    const parts = [];
    for (const c of this._clients.values()) {
      const s = c.sizes.get(paneId);
      if (s) parts.push(`${c.name}/${c.id}=${s.cols}x${s.rows}`);
    }
    return parts.join(',');
  }

  _recomputeMinAll(extraPaneIds = []) {
    const paneIds = new Set(extraPaneIds);
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
