# SPEC — WebFrontend

> **BLUF**：浏览器内渲染的 Vibe99 工作区（多 pane、focus-first、xterm 终端），通过**可插拔传输**经实时通道与后端通信，而非 Electron IPC。

## Rationale

HLD 的 API Surface 与 WebFrontend 边界；ADR-001 复用既有渲染层。前端本就是 web 技术，只需把传输从 IPC 换成实时通道。

## Scope

**拥有**：DOM/xterm 渲染、pane/tab 布局、focus-first UX、输入路由、剪贴板/右键菜单/外链（用浏览器等价能力）。
**委托**：所有会话/并发操作经可插拔 Transport 交给 Gateway。

## Operational Envelope

- 现代常青浏览器；桌面级视口（移动端优化延期）。
- 支持常见键盘布局。

## Behavioral Contract

- 渲染与桌面应用一致的多 pane、focus-first 工作区。
- 瞬时断线后自动重连并回放 scrollback。
- 反映 claim 状态（提示本客户端当前能否输入；提供"接管"入口）。
- 仅在本客户端持有 claim 时才发送输入。

## Structural Contract

- 暴露与遗留 `window.vibe99` 同义的概念面，由 Transport 适配器承载：
  - `createTerminal / writeTerminal / resizeTerminal / destroyTerminal`
  - `onTerminalData / onTerminalExit`
  - `loadSettings / saveSettings`
  - 剪贴板/右键/外链 → 浏览器等价能力
- **Transport 接口（可插拔）**：`send(op, payload)`；`on(type, handler)`。
  - 实现：`WebSocketTransport`（网页）、`IpcTransport`（遗留桌面，见 `SPEC_LegacyDesktopClient.md`）。
- 由现有 `src/renderer.js`（1201 行）+ `src/index.html` + `src/styles.css` 改造而来；核心是替换传输层，另需以浏览器等价能力替换剪贴板/右键/外链，并加入断线重连与 scrollback 回放。

> **Phase 2 更新（多客户端）**：**fork 为 `web/renderer.js`**（不再只读复用上游）；`initialPanes` 改为来自服务端 `layout`（经 boot 注入；无则回退 p1/p2/p3），并监听 `layout` 事件动态增删 pane（p4+ 持久化与多客户端布局同步）；状态栏显示连接中的客户端列表（来自 `clients` 事件）。
