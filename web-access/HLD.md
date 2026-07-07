# HLD — Vibe99 Web Access

> **BLUF**：本设计把"网页可达、会话持久、多客户端并发"的实现拆成一组边界清晰的模块——终端会话由一个**与客户端解耦的常驻层**拥有；一个**网关**把浏览器客户端接入；一个**并发协调器**保证多客户端一致；**前端**在浏览器里渲染既有工作区；外加**访问控制**与**布局持久化**。本文只给系统结构与模块边界，不给方法签名或内部 schema。

## System Context

- **主机**：Linux 工作站，运行用户的 shell 与 agentic-coding 任务；是 Vibe99 工作区与终端会话的"家"。
- **网络**：网关监听单一端口；本机经 `127.0.0.1:<port>`、远程经 VPN `10.8.0.154:<port>` 接入；默认不公网暴露。
- **客户端**：本机浏览器、远程浏览器（出差设备）；以及（遗留）现有 Vibe99 桌面应用。
- **外围**：操作系统进程与 shell 环境、用户既有的终端任务。

## API Surface

用户/客户端通过一个 `Workspace` 门面交互。概念操作：

- 连接 / 断开
- 列出当前会话与 pane 布局
- 附着到某 pane（查看输出、获得输入资格）
- 创建 / 关闭 / 调整 pane
- 发送输入、调整尺寸
- 加载 / 保存工作区设置

事件（系统 → 客户端）：pane 输出数据、pane 退出、布局变更、输入资格变更。

> 不定义具体方法签名与报文结构——见各 Module SPEC。

## Module Boundary Map

1. **SessionManager** — 拥有持久终端会话（pty）的生命周期；与客户端连接解耦；保留 scrollback；允许多客户端附着。
2. **ConcurrencyCoordinator** — 多客户端并发控制：输出广播、输入资格仲裁、视图状态同步。
3. **RealtimeGateway** — 网络/接入边缘：客户端连接生命周期、接入鉴权、客户端与 SessionManager/Coordinator 之间的复用。
4. **AuthN** — 访问控制：仅可信网络/凭据可到达工作区。
5. **WorkspacePersistence** — 保存/恢复 pane 布局、会话元数据与设置。
6. **WebFrontend** — 浏览器内渲染 Vibe99 工作区（多 pane、focus-first、xterm 终端），经 Gateway 交互。
7. **LegacyDesktopClient**（隔离的遗留边界）— 现有 Vibe99 Electron 桌面应用，作为同一工作区的另一客户端被隔离保留/逐步替代。

## Cross-Boundary Decisions

- **会话归属**：终端会话归 SessionManager 拥有，其存活与任何客户端连接无关。
- **传输**：客户端与系统之间维持单一持久实时通道；所有 pane 的数据/事件/输入复用此通道。
- **广播**：一个 pane 的输出对全部附着客户端广播；输入按 ConcurrencyCoordinator 仲裁。
- **鉴权位置**：在 Gateway 边缘统一鉴权，内部模块信任"已鉴权连接"。
- **布局真相源**：pane 布局与设置以 SessionManager + WorkspacePersistence 为权威，前端为视图。

## Integration Logic (Brownfield)

现有 Vibe99 的两部分被**提取并以适配器隔离**接入，避免大爆炸式重写：

- **现有渲染层**（`src/renderer.js` 工作区 + `electron/preload.js` 的 `window.vibe99` 契约）→ 提取为 **WebFrontend**，把"传输"从桌面专属通道改为**可插拔传输**（先实现实时通道适配器，使现有渲染逻辑尽量复用）。
- **现有主进程 PTY 逻辑**（`electron/main.js` 的 `terminalSessions` 管理）→ 提取为 **SessionManager**，并把"PTY 生命周期 = 窗口生命周期"解耦为"PTY 生命周期 = 会话生命周期"。
- **现有 Electron 外壳** → 作为 **LegacyDesktopClient**，通过同一传输接入同一 SessionManager（隔离、可独立淘汰）。
- 剪贴板、右键菜单、外链打开等桌面能力，在前端用浏览器等价能力替代。

## Implementation Roadmap

- **Phase 1 — 持久会话 + 单客户端网页接入**：提取 SessionManager（PTY 解耦、存活独立）、最小 RealtimeGateway、WebFrontend 单端附着；先达成"浏览器打开 = 看到并接续本机会话"。
- **Phase 2 — 多客户端并发与接续**：ConcurrencyCoordinator（广播 + 输入仲裁）、scrollback 回放、本地 + 远程同时使用。
- **Phase 3 — 加固与韧性**：AuthN 强化、WorkspacePersistence（布局/设置恢复）、断线重连、可观测性；为"主机重启恢复"预留演进。
