# ADR-005 — Multi-Client Viewport Size (Min-Attached)

> **BLUF**：同一 pane 有多个实时订阅客户端时，pty 尺寸 = 这些订阅者 cols×rows 的
> **最小值**（tmux 默认行为）；后台未订阅客户端不参与。

## Context

多客户端各自浏览器窗口大小不同，但每个 pane 的 pty 只有一个尺寸；本地 200 列、笔记本 120 列会冲突，全屏 TUI（vim/agent）会反复重绘闪烁。

## Options Considered

- **订阅者最小尺寸**（tmux 式）：pty = min(订阅该 pane 的客户端 cols×rows)
- **最后 resize 胜出**：谁最后调 resize 用谁的
- **每客户端虚拟尺寸**：各自重排输出（过于复杂，否决）

## Decision

**订阅者最小尺寸**：pty cols×rows = min over 订阅该 pane 的客户端；在
subscribe/unsubscribe/disconnect/resize 时重算并 resize pty。

## Consequences

- **优点**：实时观看该 pane 的客户端不会被截断；后台窗口不会持续压小 PTY；重绘只在订阅者
  集合或其最小值变化时发生。
- **代价**：多个订阅者中，大屏仍会被限制到最小客户端（如笔记本）尺寸。
- **实现归属**：由 Gateway（知晓各 pane 订阅者尺寸）计算 min，调用 SessionManager.resize。
