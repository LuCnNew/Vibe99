# SPEC — AuthN

> **BLUF**：校验连接是否被授权（VPN 内的 bearer 令牌），告知 Gateway 接受或拒绝。是"访问受控"保证的执行点。

## Rationale

ADR-004 在"仅 VPN 可达"之上叠加共享 bearer 令牌；URD 保证"访问受控"。本模块负责令牌的校验与轮换。

## Scope

**拥有**：令牌校验、令牌签发/轮换、令牌存储（哈希）。
**委托**：网络层限制（VPN 绑定）属部署/运维配置，不在代码逻辑内。

## Operational Envelope

- 常数时间比较；令牌以哈希存储。
- 支持无代码改动的轮换。
- 令牌可在握手阶段经 URL query 或 header 传递。

## Behavioral Contract

- 无有效令牌的连接被拒绝。
- 被泄露的令牌可被轮换而无需改动代码。
- 令牌校验失败不影响已建立的会话（仅拒绝新连接）。

## Structural Contract

- `verify(token) → boolean`
- `issueToken() → token` / `rotateToken() → token`
- 令牌来源：配置文件 / 环境变量（路径 `[TBD]`）。
