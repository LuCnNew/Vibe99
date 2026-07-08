# SPEC — SessionManager

> **BLUF**：SessionManager 拥有持久终端会话（pty）的生命周期与 I/O，与会话是否有客户端连接**无关**。它是"存在哪些会话、各自在输出什么"的唯一真相源。

## Rationale

URD 保证"会话存续"——终端任务在本机持续运行，与客户端连接无关；ADR-002 将所有权定在本模块。它是整个系统满足"断开重连回到同一个活会话"的核心。

## Scope

**拥有**：pty 的 spawn/resize/write/kill、每会话 scrollback 缓冲、会话注册表、查看者的 attach/detach。
**委托**：写入策略 → ConcurrencyCoordinator（当前自由写入）；网络传输 → RealtimeGateway；设置持久化 → WorkspacePersistence。

## Operational Envelope

- 并发会话数上限：`[TBD: budget，建议先 ≥ 16]`。
- 每会话 scrollback 设上限（按行数/字节）并做尾部截断驱逐。
- shell 选择复用现有逻辑（`getShellLaunchConfigs`）；cwd 校验后回退到家目录。
- 客户端断开不影响会话；**进程崩溃 = 会话丢失**（ADR-002 已对用户透明）。

## Behavioral Contract

- 会话在宿主进程运行期间持续存活并产出输出，与附着客户端数无关（0 个也活）。
- 客户端（重新）附着时，收到该会话已保留的 scrollback。
- 关闭最后一个客户端**不会**杀死会话。
- 仅显式 destroy（用户动作）才杀掉 pty 并移除会话。
- resize 生效（强制最小 cols/rows 下限）。

## Structural Contract

- `createSession({ cwd, cols, rows, shell? }) → sessionId`
- `destroySession(sessionId)`
- `write(sessionId, data)` —— 由 Gateway/ConcurrencyCoordinator 按 ADR-003 写入策略调用
- `resize(sessionId, cols, rows)`
- `attach(sessionId, viewer) → subscription`；subscription 产出 `{ data, exit }`
- `detach(sessionId, viewer)`
- `listSessions() → [{ sessionId, title, alive, cols, rows }]`
- 事件：`'data'(sessionId, data)`、`'exit'(sessionId, exitCode)`

> 改造自现有 `electron/main.js` 的 `terminalSessions` 与 `pty.onData/onExit`；复用 `electron/pty.js`（node-pty 加载器）。

> **Phase 2 更新（多客户端）**：作为**布局真相源**——create/destroy 触发 `layout` 广播给全部客户端；支持向指定客户端发送某 pane 的 scrollback（连接即回放全部 pane）；`resize` 接受外部计算的最小尺寸（ADR-005，由 Gateway 算 min 后调用）。
