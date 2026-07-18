// Wire protocol for the Vibe99 web transport.
//
// Control flow = text frames (UTF-8 JSON): {kind:'req'|'res'|'event', ...}.
// Terminal I/O   = binary frames (see encodeBinary/decodeBinary) to avoid
//                  per-chunk JSON parsing/escaping overhead.
//
// Binary frame layout: [1B op][2B paneIdLen (big-endian)][paneId UTF-8][data bytes]

// --- binary opcodes (first byte of a binary frame) ---
export const BIN_WRITE = 0x77; // client->server: terminal-write ; server->client: terminal-data
export const BIN_SCROLLBACK = 0x73; // server->client: reattach-scrollback replay

// --- control ops (text frames), aligned with window.vibe99 method names ---
export const OPS = {
  TERMINAL_CREATE: 'terminal-create',
  TERMINAL_SUBSCRIBE: 'terminal-subscribe',
  TERMINAL_UNSUBSCRIBE: 'terminal-unsubscribe',
  TERMINAL_RESIZE: 'terminal-resize',
  TERMINAL_DESTROY: 'terminal-destroy',
  WINDOW_CLOSE: 'window-close',
  CLIPBOARD_READ_TEXT: 'clipboard-read-text',
  CLIPBOARD_WRITE_TEXT: 'clipboard-write-text',
  CLIPBOARD_SNAPSHOT: 'clipboard-snapshot',
  OPEN_EXTERNAL_URL: 'open-external-url',
  SHOW_CONTEXT_MENU: 'show-context-menu',
  SETTINGS_LOAD: 'settings-load',
  SETTINGS_SAVE: 'settings-save',
};

// --- server->client push event types ---
export const EVENTS = {
  HELLO: 'hello',
  TERMINAL_EXIT: 'terminal-exit',
  MENU_ACTION: 'menu-action',
  LAYOUT: 'layout',
  CLIENTS: 'clients',
  TERMINAL_RESYNC_REQUIRED: 'terminal-resync-required',
};

let _seq = 0;
export function newId() {
  _seq += 1;
  return `s${_seq}`;
}

// --- text frame helpers ---
export function encodeRequest(op, payload, id) {
  return JSON.stringify({ kind: 'req', id, op, payload: payload ?? {} });
}

export function encodeResponseOk(id, result) {
  return JSON.stringify({ kind: 'res', id, ok: true, result: result ?? {} });
}

export function encodeResponseErr(id, message, code) {
  return JSON.stringify({ kind: 'res', id, ok: false, error: { message, code: code ?? 'ERROR' } });
}

export function encodeEvent(type, payload) {
  return JSON.stringify({ kind: 'event', type, payload: payload ?? {} });
}

export function decodeTextFrame(str) {
  return JSON.parse(str);
}

// --- binary frame codec ---
export function encodeBinary(op, paneId, data) {
  const paneIdBytes = Buffer.from(String(paneId), 'utf8');
  const dataBytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const buf = Buffer.allocUnsafe(1 + 2 + paneIdBytes.length + dataBytes.length);
  buf.writeUInt8(op, 0);
  buf.writeUInt16BE(paneIdBytes.length, 1);
  paneIdBytes.copy(buf, 3);
  dataBytes.copy(buf, 3 + paneIdBytes.length);
  return buf;
}

export function decodeBinary(view) {
  const buf = Buffer.isBuffer(view) ? view : Buffer.from(view);
  const op = buf.readUInt8(0);
  const paneIdLen = buf.readUInt16BE(1);
  const paneId = buf.subarray(3, 3 + paneIdLen).toString('utf8');
  const data = buf.subarray(3 + paneIdLen).toString('utf8');
  return { op, paneId, data };
}
