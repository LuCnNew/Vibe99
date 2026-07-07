# REF01 — Vibe99 现有代码库勘察

> **Subject**：现有 Vibe99（NekoApocalypse v0.4.5，Electron）的架构勘察——为 web 改造提供事实基线。
> **Source**：`/mnt/FAST/Vibe99` 代码库（`electron/main.js`、`electron/preload.js`、`electron/pty.js`、`src/renderer.js`、`package.json`），2026-07-07 勘察。

## Content

**定位**

Electron "interaction proof of concept"；多 pane、focus-first 终端工作区；前端 xterm.js，后端 node-pty。

**主进程（`electron/main.js`，370 行）**

- `terminalSessions: Map<paneId, { pty, webContentsId }>`。
- IPC 处理器：`vibe99:terminal-create / write / resize / destroy`、`window-close`、`settings-load / save`、`show-context-menu`。
- `pty.onData` → `webContents.send('vibe99:terminal-data')`；`pty.onExit` → `'vibe99:terminal-exit'`。
- `before-quit` → `destroyAllTerminalSessions()`（pty 生命周期绑死窗口/应用）。
- shell 选择 `getShellLaunchConfigs`（SHELL/zsh/bash/sh）；cwd 校验后回退到家目录。

**preload（`electron/preload.js`）——传输契约**

`contextBridge` 暴露 `window.vibe99`：`createTerminal / writeTerminal / resizeTerminal / destroyTerminal / closeWindow / readClipboardText / writeClipboardText / getClipboardSnapshot / openExternalUrl / showContextMenu / loadSettings / saveSettings / onTerminalData / onTerminalExit / onMenuAction`。

**pty（`electron/pty.js`）**

node-pty 加载器（`@homebridge/node-pty-prebuilt-multiarch`）。

**渲染层**

`src/renderer.js`（1201 行）+ `src/index.html`（59）+ `src/styles.css`（378）；pane / tab / focus + xterm。

**设置**

`electron/config.ts`（`loadConfig / saveConfig`，含 `fontSize` 等）；存于 userData `settings.json`。

**勘察结论（事实，非决策）**

渲染层为 web 技术、可直接复用；主进程 PTY 管理可提取为常驻服务；`window.vibe99` 契约是天然的服务/客户端边界，改 web 时把 IPC 传输替换为实时通道即可。
