# SPEC — RealtimeGateway

> **BLUF**：浏览器客户端接入的网络边缘——负责连接生命周期、鉴权握手、以及客户端与 SessionManager/ConcurrencyCoordinator 之间的报文复用与路由。

## Rationale

HLD 跨边界决策：单一持久实时通道；鉴权在边缘统一进行。本模块是"网页可达"的入口与协议边界。

## Scope

**拥有**：WebFrontend 静态资源的 HTTP 托管、实时连接的 accept/生命周期、报文封装与路由、鉴权强制（校验委托 AuthN）。
**委托**：会话操作 → SessionManager；并发仲裁 → ConcurrencyCoordinator；鉴权判定 → AuthN。

## Operational Envelope

- 并发连接上限：`[TBD]`；每客户端标签页一个连接。
- 单报文大小上限 + 慢客户端背压。
- 监听单一端口；本机经 `127.0.0.1:<port>`、远程经 VPN `10.8.0.154:<port>` 接入；默认不公网暴露（**绑定接口与端口由配置文件提供**）。

## Behavioral Contract

- 握手阶段拒绝未鉴权连接。
- 把客户端请求（create/write/resize/destroy/list/attach/settings）路由到对应模块。
- 把会话事件（data/exit/claim-changed/layout）回送到发起方及广播客户端。
- 单个客户端断开不影响任何会话。

## Structural Contract

- `listen({ host, port, staticAssets })`
- host/port/bind 来源：**配置文件**（部署参数集中配置，与 AuthN 令牌同源）。
- 连接事件：`'connect'(conn)`、`'disconnect'(conn)`、`'message'(conn, msg)`
- 出站：`send(conn, msg)`、`broadcast(paneId, msg)`
- 报文封装镜像遗留 `window.vibe99` 操作：
  - 请求：`{ op: 'terminal-create' | 'terminal-write' | 'terminal-resize' | 'terminal-destroy' | 'settings-load' | 'settings-save' | 'attach' | 'list' | 'claim' | 'release', payload }`
  - 事件：`{ type: 'terminal-data' | 'terminal-exit' | 'claim-changed' | 'layout', payload }`

> 传输：WebSocket；终端数据用二进制帧。

> **Phase 2 更新（多客户端）**：持有**客户端集合**（非单个）；输出/`layout`/`clients` 广播给全部客户端；新连接发送 `hello`+完整 `layout`+每 pane 的 scrollback；移除"新连接踢旧的"；心跳 ping 检测死连接；**尺寸协调**——跟踪每客户端最近 cols×rows，取 min 调 SessionManager.resize（ADR-005）；定期/事件推送 `clients`（id/名称/地址）供状态栏显示（ADR-003 自由写入）。
