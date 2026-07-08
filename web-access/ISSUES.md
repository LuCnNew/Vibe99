# ISSUES — Vibe99 Web Access（已知结构弱点）

> **BLUF**：以下为本系统在当前项目范围内**无法彻底解决、但终须处理**的结构性弱点。区别于 BACKLOG（可选特性）。

### 1. 网关进程崩溃 / 主机重启 = 会话全丢

- **Impact**：出差期间机器重启或网关崩溃，会丢失所有 agent / 长命令会话。
- **Constraints**：Phase 1–2 不引入 tmux 承载（ADR-002）。
- **Future Direction**：tmux/screen 承载（ADR-002 选项 B）+ systemd 托管 + 重启恢复布局。

### 2. 多写入者输入冲突（终端单流本质）

- **Impact**：多客户端并发敲键会互相冲突，可能向 shell/agent 注入错误命令。
- **Constraints**：ADR-003 修订为自由写入；这是单用户场景下的低摩擦取舍。
- **Future Direction**：如果未来引入多用户或协作场景，再启用 claim / focus-claim 仲裁与接管提示。

### 3. 网页暴露 = 主机 shell 暴露（高价值目标）

- **Impact**：令牌泄露即获得主机 shell 访问。
- **Constraints**：单用户、VPN 内访问（ADR-004）。
- **Future Direction**：mTLS / 按人凭证 + 审计日志 + 速率限制。

### 4. scrollback 内存增长

- **Impact**：长会话 / 多 pane 下内存占用持续上升。
- **Constraints**：需在内存保留 scrollback 以支持重连回放。
- **Future Direction**：分 pane scrollback 上限 + 可选落盘。

### 5. 浏览器键盘 / 输入法边界

- **Impact**：某些组合键 / IME 在浏览器内行为与原生桌面有差异。
- **Constraints**：WebFrontend 依赖浏览器输入事件。
- **Future Direction**：已知组合键映射表 + 兼容回退。
