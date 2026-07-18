import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { WebglAddon } from '../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';

function createUnavailableBridge() {
  const fail = () => {
    throw new Error('Electron preload bridge is unavailable');
  };

  return {
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'linux',
    defaultCwd: '.',
    defaultTabTitle: '.',
    createTerminal: fail,
    subscribeTerminal: () => Promise.resolve({ reset: false, fromSeq: 0, toSeq: 0 }),
    unsubscribeTerminal: () => Promise.resolve({}),
    writeTerminal: fail,
    resizeTerminal: fail,
    destroyTerminal: fail,
    closeWindow: fail,
    readClipboardText: () => Promise.reject(new Error('Clipboard bridge is unavailable')),
    writeClipboardText: fail,
    getClipboardSnapshot: () => ({ text: '', hasImage: false }),
    openExternalUrl: fail,
    showContextMenu: fail,
    loadSettings: () => Promise.resolve({}),
    saveSettings: () => Promise.resolve({}),
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
    onMenuAction: () => () => {},
    onTerminalResyncRequired: () => () => {},
    onConnectionChange: () => () => {},
  };
}

const bridge = window.vibe99 ?? createUnavailableBridge();
const isWebTransport = Boolean(window.__VIBE99_BOOT__);
const utf8Encoder = new TextEncoder();

const accentPalette = [
  '#ff6b57',
  '#ff9f1c',
  '#ffd166',
  '#06d6a0',
  '#118ab2',
  '#9b5de5',
  '#ef476f',
  '#7bd389',
  '#5cc8ff',
  '#f4a261',
];

function accentForPaneId(paneId) {
  const n = parseInt(String(paneId || '').replace(/\D/g, ''), 10);
  return accentPalette[Number.isFinite(n) && n > 0 ? (n - 1) % accentPalette.length : 0];
}

function paneFromServer(sp) {
  const id = sp.paneId || sp.id;
  return {
    id,
    title: sp.title ?? null,
    terminalTitle: sp.title || sp.cwd || bridge.defaultTabTitle,
    cwd: sp.cwd || bridge.defaultCwd,
    accent: accentForPaneId(id),
  };
}

const bootLayout = (() => {
  const raw = window.__VIBE99_BOOT__ && Array.isArray(window.__VIBE99_BOOT__.panes)
    ? window.__VIBE99_BOOT__.panes
    : null;
  return raw && raw.length ? raw.map(paneFromServer) : null;
})();

const initialPanes = bootLayout && bootLayout.length
  ? bootLayout
  : [
      { id: 'p1', title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: accentPalette[0] },
      { id: 'p2', title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: accentPalette[1] },
      { id: 'p3', title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: accentPalette[2] },
    ];

let panes = initialPanes.map((pane) => ({ ...pane }));
let focusedPaneId = panes[0].id;
let nextPaneNumber = panes.reduce((max, p) => {
  const n = parseInt(String(p.id).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? Math.max(max, n) : max;
}, 0) + 1;
const pendingLocalAdds = new Set();
const connectedClients = [];
for (const p of panes) {
  pendingLocalAdds.add(p.id);
  window.setTimeout(() => pendingLocalAdds.delete(p.id), 3000);
}
let renamingPaneId = null;
let dragState = null;
let dragFrameId = null;
let isNavigationMode = false;
let pendingTabFocus = null;

const paneNodeMap = new Map();
const WINDOW_RESIZE_DEBOUNCE_MS = 150;
const TERMINAL_RESIZE_DEBOUNCE_MS = 120;

const stageEl = document.getElementById('stage');
const tabsListEl = document.getElementById('tabs-list');
const statusLabelEl = document.getElementById('status-label');
const statusHintEl = document.getElementById('status-hint');
const addPaneButtonEl = document.getElementById('tabs-add');
const settingsButtonEl = document.getElementById('tabs-settings');
const settingsPanelEl = document.getElementById('settings-panel');
const fontSizeInputEl = document.getElementById('font-size-input');
const paneWidthRangeEl = document.getElementById('pane-width-range');
const paneWidthInputEl = document.getElementById('pane-width-input');
const paneWidthValueEl = document.getElementById('pane-width-value');
const paneOpacityRangeEl = document.getElementById('pane-opacity-range');
const paneOpacityInputEl = document.getElementById('pane-opacity-input');
const paneOpacityValueEl = document.getElementById('pane-opacity-value');

const settings = {
  fontSize: 13,
  paneOpacity: 0.8,
  paneWidth: 720,
};
let pendingSettingsSave = null;
let windowResizeTimer = null;
let pendingLayoutPayload = null;
let pendingLayoutFrame = null;

const removeTerminalDataListener = bridge.onTerminalData(({ paneId, data, byteLength }) => {
  const node = paneNodeMap.get(paneId);
  if (node) {
    writeTerminalData(node, {
      data,
      byteLength: Number.isFinite(byteLength)
        ? byteLength
        : utf8Encoder.encode(data).byteLength,
    });
  }
});

const removeTerminalExitListener = bridge.onTerminalExit(({ paneId, exitCode }) => {
  const node = paneNodeMap.get(paneId);
  if (!node) {
    return;
  }

  node.sessionReady = false;
  node.terminal.writeln('');
  node.terminal.writeln(`\x1b[38;5;244m[process exited with code ${exitCode}]\x1b[0m`);

  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) {
    return;
  }

  if (panes.length === 1) {
    if (isWebTransport) {
      unsubscribePane(node);
      disableWebgl(node);
      if (node.resizeTimer !== null) window.clearTimeout(node.resizeTimer);
      node.sessionReady = false;
      disposeTerminalNode(node);
      node.terminal.dispose();
      node.root.remove();
      paneNodeMap.delete(paneId);
      panes = [];
      focusedPaneId = null;
      render(false);
    } else {
      void bridge.closeWindow().catch(reportError);
    }
    return;
  }

  closePane(paneIndex, { destroyTerminal: false });
});

const removeMenuActionListener = bridge.onMenuAction(({ action, paneId }) => {
  try {
    handleMenuAction(action, paneId);
  } catch (error) {
    reportError(error);
  }
});

function reconcileLayout(layout) {
  if (!layout || !Array.isArray(layout.panes)) return;
  const serverById = new Map(layout.panes.map((sp) => [sp.paneId || sp.id, sp]));
  const serverIds = new Set(serverById.keys());
  for (const id of serverIds) pendingLocalAdds.delete(id);

  for (const [id, sp] of serverById) {
    if (!panes.find((p) => p.id === id)) {
      panes = [...panes, paneFromServer(sp)];
    }
  }
  panes = panes.filter((p) => serverIds.has(p.id) || pendingLocalAdds.has(p.id));

  nextPaneNumber = panes.reduce((max, p) => {
    const n = parseInt(String(p.id).replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0) + 1;

  if (!panes.find((p) => p.id === focusedPaneId)) {
    focusedPaneId = panes[0]?.id ?? null;
  }
  // New nodes fit themselves; existing terminals do not need a full refit just
  // because another client added or removed a pane.
  render(false);
}

function renderClients() {
  const el = document.getElementById('status-clients');
  if (!el) return;
  el.textContent = connectedClients.length
    ? 'clients: ' + connectedClients.map((c) => c.name || c.id).join(', ')
    : '';
}

const removeLayoutListener = bridge.onLayout?.((layout) => {
  pendingLayoutPayload = layout;
  if (pendingLayoutFrame !== null) return;
  pendingLayoutFrame = requestAnimationFrame(() => {
    pendingLayoutFrame = null;
    const nextLayout = pendingLayoutPayload;
    pendingLayoutPayload = null;
    try {
      reconcileLayout(nextLayout);
    } catch (error) {
      reportError(error);
    }
  });
});
const removeClientsListener = bridge.onClients?.((payload) => {
  connectedClients.length = 0;
  if (payload && Array.isArray(payload.clients)) connectedClients.push(...payload.clients);
  renderClients();
});
const removeResyncListener = bridge.onTerminalResyncRequired?.(({ paneId }) => {
  const node = paneNodeMap.get(paneId);
  if (!node) return;
  node.subscribed = false;
  node.subscriptionToken += 1;
  if (!document.hidden) {
    subscribePane(node);
  }
});
const removeConnectionListener = bridge.onConnectionChange?.(({ connected }) => {
  if (!isWebTransport) return;
  for (const node of paneNodeMap.values()) {
    node.subscribed = false;
    node.subscriptionToken += 1;
    node.sessionReady = false;
  }
  if (connected) {
    for (const node of paneNodeMap.values()) {
      void initializePaneTerminal(node).then(() => {
        // If the socket reopened while an older create request was still being
        // rejected, the call above may have joined that stale initialization.
        // Retry once after its lock clears.
        if (!node.disposed && !node.sessionReady) void initializePaneTerminal(node);
      });
    }
  }
});

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  statusLabelEl.textContent = `Error: ${message}`;
  statusHintEl.textContent = '';
  console.error(error);
}

function getPreviewWidth(stageWidth, count) {
  if (count <= 1) {
    return 0;
  }

  if (stageWidth >= settings.paneWidth * count) {
    return settings.paneWidth;
  }

  return (stageWidth - settings.paneWidth) / (count - 1);
}

function getPaneLabel(pane) {
  return pane?.title ?? pane?.terminalTitle ?? '';
}

function applySettings() {
  document.documentElement.style.setProperty('--app-font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--pane-opacity', settings.paneOpacity.toFixed(2));
  document.documentElement.style.setProperty('--pane-width', `${settings.paneWidth}px`);
  fontSizeInputEl.value = String(settings.fontSize);
  paneWidthRangeEl.value = String(settings.paneWidth);
  paneWidthInputEl.value = String(settings.paneWidth);
  paneWidthValueEl.textContent = `${settings.paneWidth}px`;
  paneOpacityRangeEl.value = settings.paneOpacity.toFixed(2);
  paneOpacityInputEl.value = settings.paneOpacity.toFixed(2);
  paneOpacityValueEl.textContent = settings.paneOpacity.toFixed(2);
}

function applyPersistedSettings(nextSettings) {
  if (!nextSettings || typeof nextSettings !== 'object') {
    return;
  }

  const uiSettings =
    nextSettings && typeof nextSettings.ui === 'object' && nextSettings.ui !== null
      ? nextSettings.ui
      : nextSettings;

  if (Number.isFinite(uiSettings.fontSize)) {
    settings.fontSize = uiSettings.fontSize;
  }

  if (Number.isFinite(uiSettings.paneOpacity)) {
    settings.paneOpacity = uiSettings.paneOpacity;
  }

  if (Number.isFinite(uiSettings.paneWidth)) {
    settings.paneWidth = uiSettings.paneWidth;
  }
}

function scheduleSettingsSave() {
  if (pendingSettingsSave !== null) {
    window.clearTimeout(pendingSettingsSave);
  }

  pendingSettingsSave = window.setTimeout(() => {
    pendingSettingsSave = null;
    void bridge.saveSettings({ version: 1, ui: settings }).catch(reportError);
  }, 150);
}

function flushSettingsSave() {
  if (pendingSettingsSave !== null) {
    window.clearTimeout(pendingSettingsSave);
    pendingSettingsSave = null;
    void bridge.saveSettings({ version: 1, ui: settings }).catch(reportError);
  }
}

function createTerminalTheme(accent) {
  return {
    background: '#11111100',
    foreground: '#d9d4c7',
    cursor: accent,
    cursorAccent: '#111111',
    selectionBackground: `${accent}44`,
    black: '#111111',
    red: '#ff6b57',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d9d4c7',
    brightBlack: '#5a6374',
    brightRed: '#ff8578',
    brightGreen: '#b0d98b',
    brightYellow: '#f0d58a',
    brightBlue: '#7eb7ff',
    brightMagenta: '#d9a5e8',
    brightCyan: '#7fd8e6',
    brightWhite: '#ffffff',
  };
}

function isLinkOpenModifierPressed(event) {
  return event.ctrlKey || (bridge.platform === 'darwin' && event.metaKey);
}

function handleTerminalLinkActivation(event, uri) {
  if (!isLinkOpenModifierPressed(event)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void bridge.openExternalUrl(uri).catch(reportError);
}

function getFocusedIndex() {
  const focusedIndex = panes.findIndex((pane) => pane.id === focusedPaneId);
  if (focusedIndex !== -1) {
    return focusedIndex;
  }

  focusedPaneId = panes[0]?.id ?? null;
  return panes.length > 0 ? 0 : -1;
}

function getPaneLeft(index, previewWidth, focusedIndex) {
  if (previewWidth >= settings.paneWidth) {
    return index * settings.paneWidth;
  }

  const focusedLeft = focusedIndex * previewWidth;

  if (index < focusedIndex) {
    return index * previewWidth;
  }

  if (index === focusedIndex) {
    return focusedLeft;
  }

  return focusedLeft + settings.paneWidth + (index - focusedIndex - 1) * previewWidth;
}

function createTab(pane, index, focusedIndex) {
  const tab = document.createElement('div');
  tab.className = `tab${index === focusedIndex ? ' is-focused' : ''}`;
  tab.style.setProperty('--pane-accent', pane.accent);
  tab.dataset.paneId = pane.id;
  tab.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void showTabContextMenu(pane.id, event);
  });

  const tabMain = document.createElement('button');
  tabMain.type = 'button';
  tabMain.className = 'tab-main';
  tabMain.setAttribute('aria-pressed', String(index === focusedIndex));
  tabMain.addEventListener('pointerdown', (event) => {
    beginTabDrag(index, event);
  });
  tabMain.addEventListener('dblclick', (event) => {
    event.preventDefault();
    beginRenamePane(index);
  });

  const swatch = document.createElement('span');
  swatch.className = 'tab-swatch';

  let label;
  if (renamingPaneId === pane.id) {
    label = document.createElement('input');
    label.className = 'tab-input';
    label.type = 'text';
    label.value = getPaneLabel(pane);
    label.setAttribute('aria-label', `Rename tab ${pane.id}`);
    label.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    label.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    label.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        commitRenamePane(pane.id, label.value);
      }

      if (event.key === 'Escape') {
        cancelRenamePane();
      }
    });
    label.addEventListener('blur', () => {
      commitRenamePane(pane.id, label.value);
    });
    queueMicrotask(() => {
      label.focus();
      label.select();
    });
  } else {
    label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = getPaneLabel(pane);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.textContent = 'x';
  close.setAttribute('aria-label', `Close tab ${pane.id}`);
  close.disabled = panes.length === 1;
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    closePane(index);
  });

  tabMain.append(swatch, label);
  tab.append(tabMain, close);
  return tab;
}

function createPane(pane) {
  const paneEl = document.createElement('article');
  paneEl.className = 'pane';
  paneEl.style.setProperty('--pane-accent', pane.accent);
  paneEl.addEventListener('click', () => {
    focusPane(pane.id);
  });

  const shell = document.createElement('div');
  shell.className = 'pane-shell';

  const body = document.createElement('div');
  body.className = 'pane-body';

  const surface = document.createElement('div');
  surface.className = 'pane-surface';

  const terminalHost = document.createElement('div');
  terminalHost.className = 'terminal-host';
  surface.append(terminalHost);
  body.append(surface);
  shell.append(body);
  paneEl.append(shell);

  const terminal = new Terminal({
    allowTransparency: true,
    convertEol: true,
    cursorBlink: true,
    disableStdin: false,
    drawBoldTextInBrightColors: false,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: settings.fontSize,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: createTerminalTheme(pane.accent),
  });
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon(handleTerminalLinkActivation);
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.open(terminalHost);
  terminal.attachCustomKeyEventHandler((event) => {
    if (isWebPasteHotkey(event)) {
      return false;
    }

    if (!isWindowsCtrlVPasteHotkey(event)) {
      return true;
    }

    const clipboardSnapshot = getClipboardSnapshot();
    return shouldDelegateWindowsCtrlVToTerminal(clipboardSnapshot);
  });

  const node = {
    paneId: pane.id,
    cwd: pane.cwd,
    root: paneEl,
    terminalHost,
    terminal,
    fitAddon,
    sessionReady: false,
    sizeKey: '',
    needsFit: true,
    accent: pane.accent,
    resizeTimer: null,
    pendingResize: null,
    nextSeq: 0,
    subscribed: false,
    subscriptionToken: 0,
    webglAddon: null,
    webglDisabled: false,
    pendingWrites: 0,
    writeWaiters: [],
    resetBuffer: null,
    resetPromise: null,
    hasAttachedSession: false,
    initializingPromise: null,
    disposed: false,
  };

  terminalHost.addEventListener('contextmenu', (event) => {
    if (window.__VIBE99_BOOT__) {
      return;
    }

    event.preventDefault();
    focusPane(node.paneId, { focusTerminal: false });
    void showTerminalContextMenu(node, event);
  });

  terminal.onData((data) => {
    if (node.sessionReady) {
      bridge.writeTerminal({ paneId: node.paneId, data });
    }
  });

  terminal.onTitleChange((nextTitle) => {
    const trimmedTitle = nextTitle.trim();
    if (!trimmedTitle) {
      return;
    }
    panes = panes.map((entry) =>
      entry.id === pane.id ? { ...entry, terminalTitle: trimmedTitle } : entry
    );
    if (entryNeedsTabRefresh(pane.id)) {
      renderTabs();
    }
  });

  return node;
}

function entryNeedsTabRefresh(paneId) {
  const pane = panes.find((entry) => entry.id === paneId);
  return Boolean(pane && pane.title === null);
}

function fitTerminal(node, force = false) {
  node.terminal.options.fontSize = settings.fontSize;
  node.fitAddon.fit();

  const cols = Math.max(20, node.terminal.cols || 80);
  const rows = Math.max(8, node.terminal.rows || 24);
  const nextSizeKey = `${cols}x${rows}`;

  if (
    node.sessionReady &&
    (!isWebTransport || node.subscribed) &&
    (force || nextSizeKey !== node.sizeKey)
  ) {
    scheduleTerminalResize(node, cols, rows);
  }

  node.sizeKey = nextSizeKey;
  node.needsFit = false;
}

function scheduleTerminalResize(node, cols, rows) {
  node.pendingResize = { cols, rows };
  if (node.resizeTimer !== null) {
    window.clearTimeout(node.resizeTimer);
  }
  node.resizeTimer = window.setTimeout(() => {
    node.resizeTimer = null;
    const next = node.pendingResize;
    node.pendingResize = null;
    if (!next || !node.sessionReady) {
      return;
    }
    void bridge.resizeTerminal({
      paneId: node.paneId,
      cols: next.cols,
      rows: next.rows,
    }).catch((error) => {
      console.warn('resizeTerminal ignored:', error);
    });
  }, TERMINAL_RESIZE_DEBOUNCE_MS);
}

function enableWebgl(node) {
  if (!isWebTransport || node.webglAddon || node.webglDisabled || document.hidden) return;
  let addon = null;
  try {
    addon = new WebglAddon();
    node.webglAddon = addon;
    terminalLoadWebgl(node, addon);
  } catch (error) {
    node.webglAddon = null;
    node.webglDisabled = true;
    try { addon?.dispose(); } catch {}
    console.warn('WebGL terminal renderer unavailable; using DOM renderer:', error);
  }
}

function terminalLoadWebgl(node, addon) {
  node.terminal.loadAddon(addon);
  addon.onContextLoss(() => {
    if (node.webglAddon !== addon) return;
    node.webglAddon = null;
    node.webglDisabled = true;
    try { addon.dispose(); } catch {}
    console.warn('WebGL context lost; terminal renderer fell back to DOM');
  });
}

function disableWebgl(node) {
  const addon = node.webglAddon;
  if (!addon) return;
  node.webglAddon = null;
  try { addon.dispose(); } catch {}
}

function resolveWriteWaiters(node) {
  if (node.pendingWrites > 0) return;
  const waiters = node.writeWaiters;
  node.writeWaiters = [];
  for (const resolve of waiters) resolve();
}

function writeTerminalData(node, chunk) {
  if (node.disposed) return;
  if (node.resetBuffer !== null) {
    node.resetBuffer.push(chunk);
    return;
  }
  node.nextSeq += chunk.byteLength;
  node.pendingWrites += 1;
  node.terminal.write(chunk.data, () => {
    if (node.disposed) return;
    node.pendingWrites = Math.max(0, node.pendingWrites - 1);
    resolveWriteWaiters(node);
  });
}

function waitForTerminalWrites(node) {
  if (node.disposed || node.pendingWrites === 0) return Promise.resolve();
  return new Promise((resolve) => node.writeWaiters.push(resolve));
}

async function resetTerminalForSubscription(node, fromSeq) {
  if (node.resetPromise) await node.resetPromise;
  if (node.disposed) return;
  const promise = (async () => {
    node.resetBuffer = [];
    await waitForTerminalWrites(node);
    if (node.disposed) return;
    node.terminal.reset();
    node.nextSeq = fromSeq;
    const buffered = node.resetBuffer;
    node.resetBuffer = null;
    for (const chunk of buffered) writeTerminalData(node, chunk);
  })();
  node.resetPromise = promise;
  try {
    await promise;
  } finally {
    if (node.resetPromise === promise) node.resetPromise = null;
  }
}

function disposeTerminalNode(node) {
  node.disposed = true;
  node.resetBuffer = null;
  node.pendingWrites = 0;
  resolveWriteWaiters(node);
}

async function subscribePane(node) {
  if (!isWebTransport || !node.sessionReady || node.subscribed || document.hidden) return;
  node.subscribed = true;
  const token = ++node.subscriptionToken;
  const requestedAfterSeq = node.nextSeq;
  try {
    const result = await bridge.subscribeTerminal({
      paneId: node.paneId,
      afterSeq: node.nextSeq,
      cols: node.terminal.cols,
      rows: node.terminal.rows,
    });
    if (result.reset) {
      await resetTerminalForSubscription(node, result.fromSeq);
    } else if (node.nextSeq === requestedAfterSeq) {
      node.nextSeq = result.fromSeq;
    }
    if (token !== node.subscriptionToken || !node.subscribed) return;
  } catch (error) {
    if (token !== node.subscriptionToken) return;
    node.subscribed = false;
    console.warn(`terminal subscribe failed for ${node.paneId}:`, error);
  }
}

function unsubscribePane(node) {
  if (!isWebTransport || !node.subscribed) return;
  node.subscribed = false;
  node.subscriptionToken += 1;
  void bridge.unsubscribeTerminal({ paneId: node.paneId }).catch(() => {});
}

function syncPaneActivity() {
  for (const node of paneNodeMap.values()) {
    const pageActive = !document.hidden;
    const focused = node.paneId === focusedPaneId && pageActive;
    if (node.terminal.options.cursorBlink !== focused) {
      node.terminal.options.cursorBlink = focused;
    }
    if (pageActive) {
      void subscribePane(node);
    } else {
      unsubscribePane(node);
    }
    if (focused) {
      enableWebgl(node);
    } else {
      disableWebgl(node);
    }
  }
}

function initializePaneTerminal(node) {
  if (node.disposed) return Promise.resolve();
  if (node.initializingPromise) return node.initializingPromise;
  const promise = (async () => {
    fitTerminal(node, true);
    try {
      const result = await bridge.createTerminal({
        paneId: node.paneId,
        cols: node.terminal.cols,
        rows: node.terminal.rows,
        cwd: node.cwd,
      });
      const hadAttachedSession = node.hasAttachedSession;
      if (isWebTransport) {
        // First attachment needs the retained history. On a transport-only
        // reconnect, preserve nextSeq and request only the missing suffix. If
        // the service restarted, createTerminal returns a new PTY and the old
        // browser screen must be cleared before subscribing from sequence 0.
        if (!hadAttachedSession || !result?.reattached) {
          if (hadAttachedSession) await resetTerminalForSubscription(node, 0);
          node.nextSeq = 0;
        }
      } else {
        node.nextSeq = Number.isSafeInteger(result?.outputSeq) ? result.outputSeq : 0;
      }
      node.hasAttachedSession = true;
      node.sessionReady = true;
      fitTerminal(node, true);
      syncPaneActivity();
      updateStatus();
    } catch (error) {
      reportError(error);
    }
  })();
  node.initializingPromise = promise;
  return promise.finally(() => {
    if (node.initializingPromise === promise) node.initializingPromise = null;
  });
}

function ensurePaneNodes() {
  const activeIds = new Set(panes.map((pane) => pane.id));

  for (const [paneId, node] of paneNodeMap.entries()) {
    if (!activeIds.has(paneId)) {
      unsubscribePane(node);
      disableWebgl(node);
      if (node.resizeTimer !== null) {
        window.clearTimeout(node.resizeTimer);
      }
      disposeTerminalNode(node);
      node.terminal.dispose();
      node.root.remove();
      paneNodeMap.delete(paneId);
    }
  }

  for (const pane of panes) {
    if (!paneNodeMap.has(pane.id)) {
      const node = createPane(pane);
      paneNodeMap.set(pane.id, node);
      stageEl.append(node.root);
      requestAnimationFrame(() => {
        initializePaneTerminal(node);
      });
    }
  }
}

function createPaneData() {
  const accent = accentPalette[(nextPaneNumber - 1) % accentPalette.length];
  const focusedPane = panes[getFocusedIndex()];
  const pane = {
    id: `p${nextPaneNumber}`,
    title: null,
    terminalTitle: bridge.defaultTabTitle,
    cwd: focusedPane?.cwd || bridge.defaultCwd,
    accent,
  };

  nextPaneNumber += 1;
  return pane;
}

function focusPane(paneId, options = {}) {
  const { focusTerminal = true } = options;
  focusedPaneId = paneId;
  isNavigationMode = false;
  render();
  const node = paneNodeMap.get(paneId);
  if (node && focusTerminal) {
    requestAnimationFrame(() => {
      node.terminal.focus();
    });
  }
}

function addPane() {
  const newPane = createPaneData();
  pendingLocalAdds.add(newPane.id);
  panes = [...panes, newPane];
  focusedPaneId = newPane.id;
  render(true);
  window.setTimeout(() => pendingLocalAdds.delete(newPane.id), 3000);
}

function closePane(index, options = {}) {
  const { destroyTerminal = true } = options;

  if (panes.length === 1) {
    return;
  }

  const closingPane = panes[index];
  if (!closingPane) {
    return;
  }

  if (closingPane.id === renamingPaneId) {
    renamingPaneId = null;
  }

  if (closingPane.id === dragState?.paneId) {
    endTabDrag();
  }

  if (closingPane.id === pendingTabFocus?.paneId) {
    clearPendingTabFocus();
  }

  if (destroyTerminal) {
    bridge.destroyTerminal({ paneId: closingPane.id });
  }

  const remainingPanes = panes.filter((_, paneIndex) => paneIndex !== index);
  if (closingPane.id === focusedPaneId) {
    const fallbackIndex = Math.max(0, index - 1);
    focusedPaneId = remainingPanes[fallbackIndex]?.id ?? remainingPanes[0]?.id ?? null;
  }
  panes = remainingPanes;

  render(true);
}

function beginRenamePane(index) {
  const pane = panes[index];
  if (!pane) {
    return;
  }

  clearPendingTabFocus();
  renamingPaneId = pane.id;
  render();
}

function cancelRenamePane() {
  renamingPaneId = null;
  render();
}

function commitRenamePane(paneId, nextTitle) {
  const trimmedTitle = nextTitle.trim();
  renamingPaneId = null;

  panes = panes.map((entry) =>
    entry.id === paneId ? { ...entry, title: trimmedTitle || null } : entry
  );

  render();
}

function clearPendingTabFocus() {
  if (!pendingTabFocus) {
    return;
  }

  window.clearTimeout(pendingTabFocus.timerId);
  pendingTabFocus = null;
}

function scheduleTabFocus(paneId) {
  clearPendingTabFocus();
  pendingTabFocus = {
    paneId,
    timerId: window.setTimeout(() => {
      pendingTabFocus = null;
      focusPane(paneId);
    }, 180),
  };
}

function activateTabPointerUp(paneId) {
  if (pendingTabFocus?.paneId === paneId) {
    clearPendingTabFocus();
    const paneIndex = panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) {
      beginRenamePane(paneIndex);
    }
    return;
  }

  scheduleTabFocus(paneId);
}

function beginTabDrag(index, event) {
  if (event.button !== 0 || renamingPaneId !== null) {
    return;
  }

  const pane = panes[index];
  if (!pane) {
    return;
  }

  event.preventDefault();
  dragState = {
    paneId: pane.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    currentX: event.clientX,
    dropIndex: index,
    hasMoved: false,
  };

  document.body.classList.add('is-dragging-tabs');
  window.addEventListener('pointermove', handleTabPointerMove);
  window.addEventListener('pointerup', handleTabPointerUp);
  window.addEventListener('pointercancel', handleTabPointerUp);
}

function handleTabPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  dragState.currentX = event.clientX;
  const offsetX = dragState.currentX - dragState.startX;
  const hasMoved = Math.abs(offsetX) > 4;

  if (!hasMoved && !dragState.hasMoved) {
    return;
  }

  dragState.hasMoved = true;
  dragState.dropIndex = getTabDropIndex(event.clientX);
  scheduleTabDrag();
}

function handleTabPointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const { paneId, dropIndex, hasMoved } = dragState;
  endTabDrag();

  if (!hasMoved) {
    activateTabPointerUp(paneId);
    return;
  }

  const pane = panes.find((entry) => entry.id === paneId);
  const nextPanes = panes.filter((entry) => entry.id !== paneId);
  const insertionIndex = Math.max(0, Math.min(dropIndex, nextPanes.length));
  nextPanes.splice(insertionIndex, 0, pane);
  panes = nextPanes;
  render();
}

function endTabDrag() {
  if (dragFrameId !== null) {
    cancelAnimationFrame(dragFrameId);
    dragFrameId = null;
  }
  for (const tab of tabsListEl.querySelectorAll('.tab')) {
    tab.classList.remove('is-dragging', 'insert-before');
    tab.style.transform = '';
  }
  dragState = null;
  document.body.classList.remove('is-dragging-tabs');
  window.removeEventListener('pointermove', handleTabPointerMove);
  window.removeEventListener('pointerup', handleTabPointerUp);
  window.removeEventListener('pointercancel', handleTabPointerUp);
}

function getTabDropIndex(clientX) {
  const tabs = [...tabsListEl.querySelectorAll('.tab')].filter((tab) => tab.dataset.paneId !== dragState.paneId);

  for (let slot = 0; slot < tabs.length; slot += 1) {
    const r = tabs[slot].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return slot;
  }

  return tabs.length;
}

function scheduleTabDrag() {
  if (dragFrameId !== null) return;
  dragFrameId = requestAnimationFrame(applyTabDrag);
}

function applyTabDrag() {
  dragFrameId = null;
  if (!dragState.hasMoved) return;

  const draggedTab = [...tabsListEl.querySelectorAll('.tab')].find((tab) => tab.dataset.paneId === dragState.paneId);
  const offsetX = dragState.currentX - dragState.startX;
  let slot = 0;

  for (const tab of tabsListEl.querySelectorAll('.tab')) {
    const isDragged = tab === draggedTab;
    tab.classList.toggle('is-dragging', isDragged);
    tab.style.transform = isDragged ? `translate3d(${offsetX}px, 0, 0)` : '';

    if (isDragged) {
      tab.classList.remove('insert-before');
      continue;
    }

    tab.classList.toggle('insert-before', dragState.dropIndex === slot);
    slot += 1;
  }
}

function renderTabs() {
  const focusedIndex = getFocusedIndex();
  tabsListEl.replaceChildren(...panes.map((pane, index) => createTab(pane, index, focusedIndex)));
}

function renderPanes(refit = false) {
  const stageWidth = stageEl.clientWidth;
  const stageHeight = stageEl.clientHeight;
  const previewWidth = getPreviewWidth(stageWidth, panes.length);
  const focusedIndex = getFocusedIndex();

  ensurePaneNodes();

  panes.forEach((pane, index) => {
    const node = paneNodeMap.get(pane.id);
    const left = getPaneLeft(index, previewWidth, focusedIndex);
    const isFocused = index === focusedIndex;

    node.root.classList.toggle('is-focused', isFocused);
    node.root.classList.toggle('is-navigation-target', isFocused && isNavigationMode);
    node.root.style.setProperty('--pane-accent', pane.accent);
    node.root.style.transform = `translate3d(${left}px, 0, 0)`;
    node.root.style.zIndex = String(index + 1);
    node.root.style.height = `${stageHeight}px`;

    if (node.accent !== pane.accent) {
      node.terminal.options.theme = createTerminalTheme(pane.accent);
      node.accent = pane.accent;
    }

    if (refit || node.needsFit) {
      fitTerminal(node, true);
    }
  });
}

function render(refit = false) {
  renderTabs();
  renderPanes(refit);
  syncPaneActivity();
  updateStatus();
}

function moveFocus(delta) {
  if (panes.length === 0) {
    return;
  }

  const focusedIndex = getFocusedIndex();
  const nextIndex = (focusedIndex + delta + panes.length) % panes.length;
  focusedPaneId = panes[nextIndex].id;
  render();
}

function isEditableTarget() {
  return (
    document.activeElement?.tagName === 'INPUT' ||
    document.activeElement?.classList?.contains('xterm-helper-textarea')
  );
}

function getPaneIndex(paneId) {
  return panes.findIndex((pane) => pane.id === paneId);
}

function getPaneNode(paneId) {
  return paneNodeMap.get(paneId) ?? null;
}

function getClipboardSnapshot() {
  return bridge.getClipboardSnapshot?.() ?? { text: '', hasImage: false };
}

function isWindowsCtrlVPasteHotkey(event) {
  return (
    bridge.platform === 'win32' &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'v'
  );
}

function isBrowserMac() {
  return navigator.platform.toLowerCase().includes('mac');
}

function isWebPasteHotkey(event) {
  return Boolean(
    window.__VIBE99_BOOT__ &&
    !event.altKey &&
    event.key.toLowerCase() === 'v' &&
    (isBrowserMac()
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey)
  );
}

function shouldDelegateWindowsCtrlVToTerminal(clipboardSnapshot) {
  return Boolean(clipboardSnapshot.hasImage && !clipboardSnapshot.text);
}

function copyTerminalSelection(paneId = focusedPaneId) {
  const node = getPaneNode(paneId);
  if (!node) {
    return false;
  }

  const selection = node.terminal.getSelection();
  if (!selection) {
    return false;
  }

  bridge.writeClipboardText(selection);
  return true;
}

function writeTextToTerminal(text, paneId = focusedPaneId) {
  const node = getPaneNode(paneId);
  if (!node?.sessionReady || !text) {
    return false;
  }

  if (bridge.platform === 'win32') {
    node.terminal.paste(text);
  } else {
    bridge.writeTerminal({ paneId: node.paneId, data: text });
  }
  return true;
}

async function pasteIntoTerminal(paneId = focusedPaneId, options = {}) {
  const text = options.clipboardSnapshot?.text ?? (await bridge.readClipboardText());
  return writeTextToTerminal(text, paneId);
}

function selectAllInTerminal(paneId = focusedPaneId) {
  const node = getPaneNode(paneId);
  if (!node) {
    return false;
  }

  node.terminal.selectAll();
  return true;
}

async function showTerminalContextMenu(node, event) {
  const clipboardSnapshot = getClipboardSnapshot();
  await bridge.showContextMenu({
    kind: 'terminal',
    paneId: node.paneId,
    hasSelection: node.terminal.hasSelection(),
    hasClipboardText: Boolean(clipboardSnapshot.text),
    hasClipboardImage: clipboardSnapshot.hasImage,
    x: event.x,
    y: event.y,
  });
}

async function showTabContextMenu(paneId, event) {
  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) {
    return;
  }

  focusedPaneId = paneId;
  render();

  await bridge.showContextMenu({
    kind: 'tab',
    paneId,
    canClose: panes.length > 1,
    x: event.x,
    y: event.y,
  });
}

function pasteImageIntoTerminal(paneId = focusedPaneId, options = {}) {
  const node = getPaneNode(paneId);
  if (!node?.sessionReady) {
    return false;
  }

  const clipboardSnapshot = options.clipboardSnapshot ?? getClipboardSnapshot();
  if (!clipboardSnapshot.hasImage) {
    return false;
  }

  bridge.writeTerminal({ paneId: node.paneId, data: '\u0016' });
  return true;
}

function handleMenuAction(action, paneId) {
  if (action === 'terminal-copy') {
    copyTerminalSelection(paneId);
    return;
  }

  if (action === 'terminal-paste') {
    void pasteIntoTerminal(paneId);
    return;
  }

  if (action === 'terminal-paste-image') {
    pasteImageIntoTerminal(paneId);
    return;
  }

  if (action === 'terminal-select-all') {
    selectAllInTerminal(paneId);
    return;
  }

  if (action === 'tab-rename') {
    const paneIndex = getPaneIndex(paneId);
    if (paneIndex !== -1) {
      beginRenamePane(paneIndex);
    }
    return;
  }

  if (action === 'tab-close') {
    const paneIndex = getPaneIndex(paneId);
    if (paneIndex !== -1) {
      closePane(paneIndex);
    }
  }
}

function blurFocusedTerminal() {
  const node = paneNodeMap.get(focusedPaneId);
  if (node) {
    node.terminal.blur();
  }
}

function enterNavigationMode() {
  if (panes.length === 0) {
    return;
  }

  isNavigationMode = true;
  blurFocusedTerminal();
  render();
}

function updateStatus() {
  const focusedPane = panes[getFocusedIndex()];

  if (isNavigationMode) {
    statusLabelEl.classList.add('is-navigation-mode');
    statusLabelEl.textContent = 'Navigation Mode';
    statusHintEl.textContent = 'Left/Right or H/L to flip; Enter to Focus';
    return;
  }

  statusLabelEl.classList.remove('is-navigation-mode');
  if (!focusedPane) {
    statusLabelEl.textContent = 'No terminals';
    statusHintEl.textContent = 'Open a new terminal to continue';
    return;
  }
  statusLabelEl.textContent = `Focused: ${getPaneLabel(focusedPane) || focusedPane.id}`;
  statusHintEl.textContent = 'Ctrl+B to enter navigation mode';
}

window.addEventListener(
  'keydown',
  (event) => {
    const key = event.key.toLowerCase();
    const isMac = bridge.platform === 'darwin';
    const openTabHotkey = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && key === 't'
      : event.ctrlKey && !event.metaKey && !event.altKey && key === 't';
    const enterNavigationHotkey =
      event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === 'b';
    const copyHotkey = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'c'
      : event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && key === 'c';
    const pasteHotkey = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'v'
      : event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && key === 'v';
    const windowsCtrlVPasteHotkey = isWindowsCtrlVPasteHotkey(event);
    const webPasteHotkey = isWebPasteHotkey(event);

    if (openTabHotkey) {
      event.preventDefault();
      addPane();
      return;
    }

    if (enterNavigationHotkey && document.activeElement?.tagName !== 'INPUT') {
      event.preventDefault();
      enterNavigationMode();
      return;
    }

    if (copyHotkey && document.activeElement?.tagName !== 'INPUT') {
      if (copyTerminalSelection()) {
        event.preventDefault();
      }
      return;
    }

    if ((webPasteHotkey || pasteHotkey || windowsCtrlVPasteHotkey) && document.activeElement?.tagName !== 'INPUT') {
      if (webPasteHotkey) {
        // Browser clipboard reads are often blocked on remote HTTP pages. Let
        // Chrome dispatch a native paste event with clipboardData instead.
        return;
      }

      if (window.__VIBE99_BOOT__) {
        return;
      }

      const clipboardSnapshot = getClipboardSnapshot();
      if (
        windowsCtrlVPasteHotkey &&
        shouldDelegateWindowsCtrlVToTerminal(clipboardSnapshot)
      ) {
        return;
      }

      event.preventDefault();
      void pasteIntoTerminal(undefined, windowsCtrlVPasteHotkey ? { clipboardSnapshot } : {});
      return;
    }

    if (isEditableTarget() || !isNavigationMode) {
      return;
    }

    if (event.key === 'ArrowLeft' || key === 'h') {
      event.preventDefault();
      moveFocus(-1);
      return;
    }

    if (event.key === 'ArrowRight' || key === 'l') {
      event.preventDefault();
      moveFocus(1);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      focusPane(focusedPaneId);
    }
  },
  true
);

window.addEventListener(
  'paste',
  (event) => {
    if (!window.__VIBE99_BOOT__ || document.activeElement?.tagName === 'INPUT') {
      return;
    }

    const text =
      event.clipboardData?.getData('text/plain') ||
      event.clipboardData?.getData('text') ||
      '';
    if (writeTextToTerminal(text)) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true
);

addPaneButtonEl.addEventListener('click', () => {
  try {
    addPane();
  } catch (error) {
    reportError(error);
  }
});

settingsButtonEl.addEventListener('click', (event) => {
  event.stopPropagation();
  settingsPanelEl.classList.toggle('is-hidden');
});

settingsPanelEl.addEventListener('click', (event) => {
  event.stopPropagation();
});

fontSizeInputEl.addEventListener('change', () => {
  const nextValue = Number(fontSizeInputEl.value);
  if (!Number.isFinite(nextValue)) {
    applySettings();
    return;
  }

  settings.fontSize = Math.max(10, Math.min(24, Math.round(nextValue)));
  applySettings();
  render(true);
  scheduleSettingsSave();
});

function updatePaneWidth(nextValue) {
  const parsedValue = Number(nextValue);
  if (!Number.isFinite(parsedValue)) {
    applySettings();
    return;
  }

  settings.paneWidth = Math.max(520, Math.min(1000, Math.round(parsedValue / 10) * 10));
  applySettings();
  render(true);
  scheduleSettingsSave();
}

function updatePaneOpacity(nextValue) {
  const parsedValue = Number(nextValue);
  if (!Number.isFinite(parsedValue)) {
    applySettings();
    return;
  }

  settings.paneOpacity = Math.max(0.55, Math.min(1, Number(parsedValue.toFixed(2))));
  applySettings();
  scheduleSettingsSave();
}

paneWidthRangeEl.addEventListener('input', () => {
  updatePaneWidth(paneWidthRangeEl.value);
});

paneWidthInputEl.addEventListener('change', () => {
  updatePaneWidth(paneWidthInputEl.value);
});

paneOpacityRangeEl.addEventListener('input', () => {
  updatePaneOpacity(paneOpacityRangeEl.value);
});

paneOpacityInputEl.addEventListener('change', () => {
  updatePaneOpacity(paneOpacityInputEl.value);
});

window.addEventListener('pointerdown', (event) => {
  if (
    !settingsPanelEl.classList.contains('is-hidden') &&
    !settingsPanelEl.contains(event.target) &&
    !settingsButtonEl.contains(event.target)
  ) {
    settingsPanelEl.classList.add('is-hidden');
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsPanelEl.classList.contains('is-hidden')) {
    settingsPanelEl.classList.add('is-hidden');
  }
});

window.addEventListener('resize', () => {
  if (windowResizeTimer !== null) {
    window.clearTimeout(windowResizeTimer);
  }
  windowResizeTimer = window.setTimeout(() => {
    windowResizeTimer = null;
    try {
      render(true);
    } catch (error) {
      reportError(error);
    }
  }, WINDOW_RESIZE_DEBOUNCE_MS);
});

document.addEventListener('visibilitychange', () => {
  syncPaneActivity();
  if (!document.hidden) {
    const node = paneNodeMap.get(focusedPaneId);
    if (node) requestAnimationFrame(() => fitTerminal(node, true));
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    applyPersistedSettings(await bridge.loadSettings());
    applySettings();
    render(true);
  } catch (error) {
    reportError(error);
  }
});

window.addEventListener('beforeunload', () => {
  if (windowResizeTimer !== null) {
    window.clearTimeout(windowResizeTimer);
  }
  if (pendingLayoutFrame !== null) {
    cancelAnimationFrame(pendingLayoutFrame);
  }
  flushSettingsSave();
  removeTerminalDataListener();
  removeTerminalExitListener();
  removeMenuActionListener();
  removeLayoutListener?.();
  removeClientsListener?.();
  removeResyncListener?.();
  removeConnectionListener?.();
});

window.addEventListener('error', (event) => {
  reportError(event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportError(event.reason);
});
