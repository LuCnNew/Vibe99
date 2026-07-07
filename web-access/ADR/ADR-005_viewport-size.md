# ADR-005 — Multi-Client Viewport Size (Min-Attached)

> **BLUF**：多客户端时，pty 尺寸 = 所有已连接客户端 cols×rows 的**最小值**（tmux 默认行为），在 connect/disconnect/客户端 resize 时重算。

## Context

多客户端各自浏览器窗口大小不同，但每个 pane 的 pty 只有一个尺寸；本地 200 列、笔记本 120 列会冲突，全屏 TUI（vim/agent）会反复重绘闪烁。

## Options Considered

- **最小尺寸**（tmux 式）：pty = min(所有已连接客户端 cols×rows)
- **最后 resize 胜出**：谁最后调 resize 用谁的
- **每客户端虚拟尺寸**：各自重排输出（过于复杂，否决）

## Decision

**最小尺寸**：pty cols×rows = min over 所有已连接客户端；在客户端 connect/disconnect/resize 时重算并 resize pty。

## Consequences

- **优点**：无客户端被截断；行为可预期；重绘只在最小值变化（客户端连入/断开）时发生，远少于"最后 resize 胜出"的频繁闪烁。
- **代价**：大屏被限制到最小客户端（如笔记本）尺寸。
- **实现归属**：由 Gateway（知晓全部客户端尺寸）计算 min，调用 SessionManager.resize。
