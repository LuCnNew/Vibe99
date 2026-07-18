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
- 瞬时断线后自动重连，并从已确认的 byte sequence 增量追赶全部 pane。
- 支持自由写入：任一已连接客户端都可发送输入（ADR-003 修订）。
- 展示连接中的客户端列表，帮助用户区分本地与远程浏览器。

## Structural Contract

- 暴露与遗留 `window.vibe99` 同义的概念面，由 Transport 适配器承载：
  - `createTerminal / subscribeTerminal / unsubscribeTerminal / writeTerminal / resizeTerminal / destroyTerminal`
  - `onTerminalData / onTerminalExit`
  - `loadSettings / saveSettings`
  - 剪贴板/右键/外链 → 浏览器等价能力
- **Transport 接口（可插拔）**：`send(op, payload)`；`on(type, handler)`。
  - 实现：`WebSocketTransport`（网页）、`IpcTransport`（遗留桌面，见 `SPEC_LegacyDesktopClient.md`）。
- 由现有 `src/renderer.js` + `src/index.html` + `src/styles.css` 改造而来；核心是替换传输层，
  另需以浏览器等价能力替换剪贴板/右键/外链，并加入断线重连与按 sequence 增量追赶。

> **Phase 2 更新（多客户端）**：继续复用根目录 `src/renderer.js`；`initialPanes` 改为来自服务端
> `layout`（经 boot 注入；无则回退 p1/p2/p3），并监听 `layout` 事件动态增删 pane（p4+ 在服务进程内接续与多客户端布局同步）；状态栏显示连接中的客户端列表（来自 `clients` 事件）。

> **Phase 3 更新（渲染降载）**：页面可见时全部 pane 订阅实时输出并参与尺寸报告；只有焦点
> pane 启用光标动画并优先使用 WebGL renderer，其他 pane 使用轻量 renderer 持续更新。
> 浏览器标签页隐藏时取消全部订阅，恢复可见后按 sequence 增量追赶。
