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
- 客户端（重新）附着时，可按 byte sequence 获取仍保留的增量输出；落后超过保留窗口时重置。
- 关闭最后一个客户端**不会**杀死会话。
- 显式 destroy 会杀掉 pty 并移除会话；pty 自然退出后发送最终输出/exit 并释放会话容量。
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

> **Phase 3 更新（增量历史）**：scrollback 使用有界 chunk deque，避免每个 PTY 小块都复制完整
> Buffer；输出按短时间窗/大小合并。`getOutputSince(paneId, afterSeq)` 返回增量 chunk，超出保留
> 窗口时标记 reset。create/destroy 才改变布局，reattach 不广播 layout。
