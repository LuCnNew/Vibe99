# SPEC — RealtimeGateway

> **BLUF**：浏览器客户端接入的网络边缘——负责连接生命周期、鉴权握手、以及客户端与 SessionManager/ConcurrencyCoordinator 之间的报文复用与路由。

## Rationale

HLD 跨边界决策：单一持久实时通道；鉴权在边缘统一进行。本模块是"网页可达"的入口与协议边界。

## Scope

**拥有**：WebFrontend 静态资源的 HTTP 托管、实时连接的 accept/生命周期、报文封装与路由、鉴权强制（校验委托 AuthN）、客户端列表广播、最小尺寸协调。
**委托**：会话操作 → SessionManager；写入策略 → ConcurrencyCoordinator；鉴权判定 → AuthN。

## Operational Envelope

- 并发连接上限：`[TBD]`；每客户端标签页一个连接。
- 单报文大小上限 + 慢客户端背压。
- 监听单一端口；本机经 `127.0.0.1:<port>`、远程经 VPN/LAN `<HOST_IP>:<port>` 接入；默认不公网暴露（**绑定接口与端口由配置文件提供**）。

## Behavioral Contract

- 握手阶段拒绝未鉴权连接。
- 把客户端请求（terminal-create/subscribe/unsubscribe/write/resize/destroy、settings、clipboard/menu 降级操作）路由到对应模块。
- 控制事件广播给全部客户端；终端数据只发送给订阅对应 pane 的客户端。
- 单个客户端断开不影响任何会话。

## Structural Contract

- `listen({ host, port, staticAssets })`
- host/port/bind 来源：**配置文件**（部署参数集中配置，与 AuthN 令牌同源）。
- 连接事件：`'connect'(conn)`、`'disconnect'(conn)`、`'message'(conn, msg)`
- 出站：`send(conn, msg)`、`broadcast(paneId, msg)`
- 报文封装镜像遗留 `window.vibe99` 操作：
  - 文本请求：`terminal-create`、`terminal-subscribe`、`terminal-unsubscribe`、`terminal-resize`、`terminal-destroy`、`settings-load`、`settings-save`
  - 文本事件：`hello`、`terminal-exit`、`layout`、`clients`、`terminal-resync-required`
  - 二进制帧：terminal write/data、reattach scrollback

> 传输：WebSocket；终端数据用二进制帧。

> **Phase 3 更新（按需订阅）**：新连接先接收 `hello`+完整 `layout`；可见页面订阅全部 pane，
> 以 byte sequence 增量追赶缺失输出。页面隐藏时退订全部 pane。发送队列有背压和硬上限，
> 慢客户端超限后收到 `terminal-resync-required`。只有订阅客户端参与该 pane 的最小尺寸协调。
