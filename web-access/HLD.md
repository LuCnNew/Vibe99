# HLD — Vibe99 Web Access

> **BLUF**：本设计把"网页可达、会话持久、多客户端并发"的实现拆成一组边界清晰的模块——终端会话由一个**与客户端解耦的常驻层**拥有；一个**网关**把浏览器客户端接入；一个输入策略层处理多客户端写入；**前端**在浏览器里渲染既有工作区；外加**访问控制**与**设置持久化**。本文只给系统结构与模块边界，不给方法签名或内部 schema。

## System Context

- **主机**：Linux 工作站，运行用户的 shell 与 agentic-coding 任务；是 Vibe99 工作区与终端会话的"家"。
- **网络**：网关监听单一端口；本机经 `127.0.0.1:<port>`、远程经 VPN/LAN `<HOST_IP>:<port>` 接入；默认不公网暴露。
- **客户端**：本机浏览器、远程浏览器（出差设备）；以及（遗留）现有 Vibe99 桌面应用。
- **外围**：操作系统进程与 shell 环境、用户既有的终端任务。

## API Surface

用户/客户端通过一个 `Workspace` 门面交互。概念操作：

- 连接 / 断开
- 列出当前会话与 pane 布局
- 附着到某 pane（查看输出、发送输入）
- 创建 / 关闭 / 调整 pane
- 发送输入、调整尺寸
- 加载 / 保存工作区设置

事件（系统 → 客户端）：pane 输出数据、pane 退出、布局变更、客户端列表变更。

> 不定义具体方法签名与报文结构——见各 Module SPEC。

## Module Boundary Map

1. **SessionManager** — 拥有持久终端会话（pty）的生命周期；与客户端连接解耦；保留 scrollback；允许多客户端附着。
2. **ConcurrencyCoordinator** — 多客户端输入策略层；当前按 ADR-003 修订为自由写入，保留为未来仲裁替换点。
3. **RealtimeGateway** — 网络/接入边缘：客户端连接生命周期、接入鉴权、客户端与 SessionManager/Coordinator 之间的复用。
4. **AuthN** — 访问控制：仅可信网络/凭据可到达工作区。
5. **WorkspacePersistence** — 当前保存/恢复 UI 设置；跨重启 pane 布局恢复是后续能力。
6. **WebFrontend** — 浏览器内渲染 Vibe99 工作区（多 pane、focus-first、xterm 终端），经 Gateway 交互。
7. **LegacyDesktopClient**（隔离的遗留边界）— 现有 Vibe99 Electron 桌面应用被保留；当前网页服务不接管其私有 pty 会话，后续可逐步适配到同一传输。

## Cross-Boundary Decisions

- **会话归属**：终端会话归 SessionManager 拥有，其存活与任何客户端连接无关。
- **传输**：客户端与系统之间维持单一持久实时通道；所有 pane 的数据/事件/输入复用此通道。
- **广播**：一个 pane 的输出对全部附着客户端广播；输入按 ADR-003 修订为自由写入。
- **鉴权位置**：在 Gateway 边缘统一鉴权，内部模块信任"已鉴权连接"。
- **布局真相源**：服务进程运行期间，pane 布局以 SessionManager 为权威；UI 设置以 WorkspacePersistence 为权威；前端为视图。

## Integration Logic (Brownfield)

现有 Vibe99 的两部分被**提取并以适配器隔离**接入，避免大爆炸式重写：

- **现有渲染层**（`src/renderer.js` 工作区 + `electron/preload.js` 的 `window.vibe99` 契约）→ 提取为 **WebFrontend**，把"传输"从桌面专属通道改为**可插拔传输**（先实现实时通道适配器，使现有渲染逻辑尽量复用）。
- **现有主进程 PTY 逻辑**（`electron/main.js` 的 `terminalSessions` 管理）→ 提取为 **SessionManager**，并把"PTY 生命周期 = 窗口生命周期"解耦为"PTY 生命周期 = 会话生命周期"。
- **现有 Electron 外壳** → 作为 **LegacyDesktopClient** 隔离保留；当前实现不把 Electron 已有 pty
  自动导入网页工作区，后续可改为通过同一传输接入同一 SessionManager。
- 剪贴板、右键菜单、外链打开等桌面能力，在前端用浏览器等价能力替代。

## Implementation Roadmap

- **Phase 1 — 持久会话 + 单客户端网页接入**：提取 SessionManager（PTY 解耦、存活独立）、最小 RealtimeGateway、WebFrontend 单端附着；先达成"浏览器打开 = 看到并接续本机会话"。
- **Phase 2 — 多客户端并发与接续**：输出广播、自由写入、scrollback 回放、本地 + 远程同时使用。
- **Phase 3 — 加固与韧性**：AuthN 强化、跨重启布局恢复、断线重连、可观测性；为"主机重启恢复"预留演进。
