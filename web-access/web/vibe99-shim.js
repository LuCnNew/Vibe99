// Vibe99 web transport shim. Implements the same `window.vibe99` surface the
// Electron preload exposed, but backed by a WebSocket to the persistent server
// instead of Electron IPC. Loaded as a CLASSIC script before the renderer ES
// module, so window.vibe99 exists when renderer.js reads it at module top-level.
(function () {
  'use strict';

  // Gateway injects window.__VIBE99_BOOT__ = {platform, defaultCwd, defaultTabTitle}
  // synchronously into index.html (required because renderer.js reads these at
  // module top-level, before any async WS event can arrive).
  var BOOT = window.__VIBE99_BOOT__ || { platform: 'linux', defaultCwd: '.', defaultTabTitle: 'Vibe99' };

  // Token: ?token= query (persisted) > localStorage.
  var TOKEN = new URLSearchParams(location.search).get('token') || localStorage.getItem('vibe99.token') || '';
  if (TOKEN) localStorage.setItem('vibe99.token', TOKEN);
  var NAME = new URLSearchParams(location.search).get('name') || localStorage.getItem('vibe99.name') || '';
  if (NAME) localStorage.setItem('vibe99.name', NAME);

  var subs = { data: new Set(), exit: new Set(), menu: new Set(), layout: new Set(), clients: new Set() };
  var pending = new Map(); // messageId -> {resolve, reject, op}
  var msgSeq = 0;
  var ws = null;
  var ready = false;
  var queued = []; // request senders waiting for ws open
  var reconnectTimer = null;

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var q = '';
    if (TOKEN) q += (q ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
    if (NAME) q += (q ? '&' : '?') + 'name=' + encodeURIComponent(NAME);
    return proto + '//' + location.host + '/ws' + q;
  }

  function connect() {
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      ready = true;
      var q = queued;
      queued = [];
      q.forEach(function (f) { f(); });
    };
    ws.onmessage = onFrame;
    ws.onclose = function () {
      ready = false;
      pending.forEach(function (p) { p.reject(new Error('disconnected')); });
      pending.clear();
      scheduleReconnect();
    };
    ws.onerror = function () {};
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 1000);
  }

  function onFrame(ev) {
    if (ev.data instanceof ArrayBuffer) return onBinary(ev.data);
    var f;
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f.kind === 'res') {
      var p = pending.get(f.id);
      if (p) {
        pending.delete(f.id);
        f.ok ? p.resolve(f.result) : p.reject(new Error((f.error && f.error.message) || 'error'));
      }
    } else if (f.kind === 'event') {
      if (f.type === 'hello') {
        window.vibe99.platform = f.payload.platform;
        window.vibe99.defaultCwd = f.payload.defaultCwd;
        window.vibe99.defaultTabTitle = f.payload.defaultTabTitle;
      } else if (f.type === 'terminal-exit') {
        subs.exit.forEach(function (h) { h(f.payload); });
      } else if (f.type === 'menu-action') {
        subs.menu.forEach(function (h) { h(f.payload); });
      } else if (f.type === 'layout') {
        subs.layout.forEach(function (h) { h(f.payload); });
      } else if (f.type === 'clients') {
        subs.clients.forEach(function (h) { h(f.payload); });
      }
    }
  }

  // Binary layout matches server protocol.js: [1B op][2B paneIdLen BE][paneId][data].
  function onBinary(buf) {
    var dv = new DataView(buf);
    var op = dv.getUint8(0);
    var paneIdLen = dv.getUint16(1, false); // big-endian
    var off = 3;
    var paneId = new TextDecoder().decode(new Uint8Array(buf, off, paneIdLen));
    off += paneIdLen;
    var data = new TextDecoder().decode(new Uint8Array(buf, off));
    // BIN_WRITE (0x77) and BIN_SCROLLBACK (0x73) both feed onTerminalData.
    void op;
    subs.data.forEach(function (h) { h({ paneId: paneId, data: data }); });
  }

  function sendRequest(op, payload) {
    return new Promise(function (resolve, reject) {
      msgSeq += 1;
      var id = 'c' + msgSeq;
      pending.set(id, { resolve: resolve, reject: reject, op: op });
      var fire = function () {
        ws.send(JSON.stringify({ kind: 'req', id: id, op: op, payload: payload || {} }));
        setTimeout(function () {
          if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + op)); }
        }, 15000);
      };
      if (ready) fire(); else queued.push(fire);
    });
  }

  function sendWriteBinary(paneId, data) {
    if (!ready) return Promise.resolve({});
    var idEnc = new TextEncoder().encode(String(paneId));
    var dEnc = new TextEncoder().encode(data);
    var buf = new Uint8Array(1 + 2 + idEnc.length + dEnc.length);
    buf[0] = 0x77; // BIN_WRITE
    buf[1] = (idEnc.length >> 8) & 0xff;
    buf[2] = idEnc.length & 0xff;
    buf.set(idEnc, 3);
    buf.set(dEnc, 3 + idEnc.length);
    ws.send(buf);
    return Promise.resolve({});
  }

  // --- browser-side context menu (mirrors main.js menu items) ---
  var menuEl = null;
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('mousedown', onMenuOutside, true); }
  }
  function onMenuOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  function dispatchMenu(action, paneId) {
    closeMenu();
    subs.menu.forEach(function (h) { h({ action: action, paneId: paneId }); });
  }
  function showBrowserContextMenu(payload) {
    closeMenu();
    var items = [];
    if (payload.kind === 'terminal') {
      items.push({ action: 'terminal-copy', label: 'Copy', enabled: !!payload.hasSelection });
      items.push({ action: 'terminal-paste', label: 'Paste', enabled: !!payload.hasClipboardText });
      items.push({ action: 'terminal-select-all', label: 'Select All', enabled: true });
    } else if (payload.kind === 'tab') {
      items.push({ action: 'tab-rename', label: 'Rename Tab', enabled: true });
      items.push({ action: 'tab-close', label: 'Close Tab', enabled: !!payload.canClose });
    }
    if (!items.length) return Promise.resolve({});
    menuEl = document.createElement('div');
    menuEl.style.cssText =
      'position:fixed;z-index:99999;background:#222;color:#eee;border:1px solid #444;' +
      'border-radius:4px;padding:4px 0;min-width:140px;font:13px sans-serif;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.4);left:' + (Number.isFinite(payload.x) ? payload.x : 0) + 'px;' +
      'top:' + (Number.isFinite(payload.y) ? payload.y : 0) + 'px';
    items.forEach(function (it) {
      var b = document.createElement('div');
      b.textContent = it.label;
      b.style.cssText =
        'padding:6px 16px;cursor:' + (it.enabled ? 'pointer' : 'default') + ';opacity:' + (it.enabled ? '1' : '.4');
      if (it.enabled) {
        b.onmouseenter = function () { b.style.background = '#3a3a3a'; };
        b.onmouseleave = function () { b.style.background = 'transparent'; };
        b.onclick = function (e) { e.stopPropagation(); dispatchMenu(it.action, payload.paneId); };
      }
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    setTimeout(function () { document.addEventListener('mousedown', onMenuOutside, true); }, 0);
    return Promise.resolve({});
  }

  window.vibe99 = {
    platform: BOOT.platform,
    defaultCwd: BOOT.defaultCwd,
    defaultTabTitle: BOOT.defaultTabTitle,
    createTerminal: function (p) { return sendRequest('terminal-create', p); },
    writeTerminal: function (p) { return sendWriteBinary(p.paneId, p.data); },
    resizeTerminal: function (p) { return sendRequest('terminal-resize', p); },
    destroyTerminal: function (p) { return sendRequest('terminal-destroy', p); },
    closeWindow: function () { try { window.close(); } catch (e) {} return sendRequest('window-close', {}); },
    readClipboardText: function () {
      if (navigator.clipboard && navigator.clipboard.readText) {
        return navigator.clipboard.readText().catch(function () { return ''; });
      }
      return Promise.resolve('');
    },
    writeClipboardText: function (p) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText((p && p.text) || '').catch(function () {});
      }
      return Promise.resolve({});
    },
    getClipboardSnapshot: function () { return { text: '', hasImage: false }; },
    openExternalUrl: function (p) { try { window.open(p && p.uri, '_blank', 'noopener'); } catch (e) {} return Promise.resolve({}); },
    showContextMenu: function (payload) { return showBrowserContextMenu(payload); },
    loadSettings: function () { return sendRequest('settings-load', {}); },
    saveSettings: function (p) { return sendRequest('settings-save', p); },
    onTerminalData: function (h) { subs.data.add(h); return function () { subs.data.delete(h); }; },
    onTerminalExit: function (h) { subs.exit.add(h); return function () { subs.exit.delete(h); }; },
    onMenuAction: function (h) { subs.menu.add(h); return function () { subs.menu.delete(h); }; },
    onLayout: function (h) { subs.layout.add(h); return function () { subs.layout.delete(h); }; },
    onClients: function (h) { subs.clients.add(h); return function () { subs.clients.delete(h); }; },
  };

  connect();
})();
