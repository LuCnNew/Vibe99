# ADR-002 — Session Persistence & Lifetime Model

> **BLUF**：决定终端会话由常驻的 SessionManager 进程拥有，其生命周期与"是否有客户端连接"解耦（满足"会话存续"保证）；但 Phase 1–2 不引入 tmux/screen 承载，"主机重启后自动恢复"作为延期项（与 URD Deferred 一致）。

## Context

URD 保证“会话存续”：终端任务与本机持续运行，与是否有客户端连接无关；断开重连回到同一个活着的会话。现状是 pty 绑死在窗口上（`before-quit` → `destroyAllTerminalSessions`），关应用即全灭。（注：用户曾以 tmux 作比喻说明 attach / 持久语义，但已明确 tmux 仅为示例，不要求真实 tmux 承载。）

## Options Considered

- **A. 网关进程持有 pty**：pty 存活于常驻服务进程中，与客户端连接无关。客户端断开会话不灭；但服务进程崩溃/重启会带走会话。
- **B. tmux/screen 承载**：每个 pane 由持久复用器会话承载，网关 attach 其上。可扛服务进程重启、甚至主机重启（若 tmux 随系统重启拉起）。韧性最强。
- **C. 混合**：默认 A；对指定"重要/长跑"pane 可选启用 B。

## Decision

Phase 1–2 采用 **A（SessionManager 进程持有 pty）**，并以 WorkspacePersistence 保存布局/元数据；tmux 承载（B）与"主机重启恢复"一并延期。

## Consequences

- **优点**：最简洁地满足"客户端断开会话不灭"这一硬保证；所有权模型清晰（SessionManager 为唯一真相源）；不引入额外复用器层，降低复杂度。
- **代价**：SessionManager 进程崩溃/重启会终止在跑会话。
- **缓解**：以进程托管（systemd/supervisor）+ 重启策略保障进程可用；将"主机重启/崩溃恢复"明确列为 URD Deferred 与后续阶段（届时评估 B/C）。该取舍已在 URD 中对用户透明。
