# SPEC — ConcurrencyCoordinator

> **BLUF**：Phase 2 起，输入资格采用**自由写入**（ADR-003 修订）——本模块退化为**恒放行**；多客户端尺寸协调（ADR-005）不在本模块，归 Gateway。

## Rationale

ADR-003 修订为自由写入（单用户场景，任一客户端可输入）。原 claim 仲裁不再需要；本模块保留为放行层，便于将来多用户时替换为真实仲裁。

## Scope

**拥有**：无（放行）。
**委托**：尺寸协调 → Gateway（见 ADR-005）；实际 pty 写入 → SessionManager。

## Operational Envelope

- 单用户、单工作站（URD）。

## Behavioral Contract

- `canWrite` 恒为 true（任一已连接客户端可向任一 pane 输入）。
- 不做 claim/release 仲裁。

## Structural Contract

- `canWrite(_paneId, _clientId) → true`
- `claim / release / currentWriter`：保留接口，恒放行/空操作（为 Phase 后续替换预留）。

> **Phase 2 注**：尺寸协调（min-attached）由 Gateway 计算并调用 SessionManager.resize，不在本模块。
