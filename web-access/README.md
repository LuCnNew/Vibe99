# README — Vibe99 Web Access（规范导航）

> **BLUF**：这是 "Vibe99 Web Access" 工程的规范目录——把 Vibe99 的多窗口终端工作区做成可在浏览器打开（本机 `127.0.0.1:<port>`、远程 VPN `10.8.0.154:<port>`），并支持持久会话与多客户端并发。本 README 仅作**导航地图**，不重复各文档内容。

## Rationale

本规范集按 Spec-Driven SDLC 的不可变梯度（问题 → 架构 → 决策 → 模块 → 运维），分层定义"Vibe99 如何变为网页可达、会话持久、多客户端并发"。每层只写给一类读者、只含该阶段可知的信息。

## Navigation Map

| 文档 | 读者 | 内容 |
|---|---|---|
| `URD.md` | 用户 | 需求（问题空间） |
| `HLD.md` | 架构师 | 高层设计、模块边界 |
| `ADR/` | 评审者 | 架构决策记录 |
| `specs/` | 开发者 | 模块契约 |
| `BACKLOG.md` | 规划者 | 延期特性 |
| `ISSUES.md` | 维护者 | 已知结构弱点 |
| `VERIFICATION_PLAN.md` | QA | 验证计划 |
| `references/` | 调研者 | 调研材料（非规范性） |

**ADR 索引**

- `ADR-001` 整体路线：原生 web 服务端 vs 远程桌面包装
- `ADR-002` 会话持久化与生命周期模型
- `ADR-003` 多客户端输入策略（**修订：自由写入**）
- `ADR-004` 访问控制模型
- `ADR-005` 多客户端视口尺寸（最小尺寸）

**Module SPEC 索引**

`SessionManager` · `ConcurrencyCoordinator` · `RealtimeGateway` · `AuthN` · `WorkspacePersistence` · `WebFrontend` · `LegacyDesktopClient`

**建议阅读顺序**：URD → HLD → ADR → SPECs。

## Viral Clause

本目录的所有规范文档遵循 **Spec-Driven SDLC** 标准（canonical：`spec_driven_sdlc.md`；中文阅读指南：`spec_driven_sdlc_cn.md`）。任何基于本规范的派生工作应沿用该标准，并在其 README 中引用本标准。
