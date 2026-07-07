# HANDOFF — Vibe99 Web Access

> **BLUF**：这是一个让 Vibe99 终端工作区在**浏览器**里打开的访问层——本机 `127.0.0.1:<port>`、VPN 远程 `10.8.0.154:<port>`。终端会话**持久存活**（关浏览器不灭），支持**多客户端同时连接**，刷新/重连后回到同一组窗口（含手动加的 pane）与历史输出。面向接手这个功能的同事。

---

## 1. 它是什么

把 Vibe99（Electron 桌面终端工作区）改造成"网页可达 + 会话持久 + 多客户端"：

- 浏览器输入网址即可打开 Vibe99 的多 pane、focus-first 工作区（**无需在访问端装客户端**）。
- 终端会话（pty）由常驻服务拥有，**与客户端连接解耦**——关掉浏览器、出差换设备，正在跑的 agent/长命令继续活着，重连即接续。
- 多客户端可同时连接（本机 + 远程），输出实时同步，状态栏显示谁在线。
- bearer 令牌鉴权；默认走 VPN，不公网暴露。

> 原生 Vibe99 桌面应用仍是可选的本地客户端；本访问层与 Vibe99 源码**分开存放**，只**只读复用**其前端资源与 node-pty。

---

## 2. 前置条件

- **Node 22**（匹配 Vibe99 `.nvmrc`；用 nvm：`nvm use 22`）。
- **Vibe99 项目树已就位并装好依赖**：本服务**复用** Vibe99 的前端资源（`src/renderer.js`〔本分支已并入 layout 驱动改动〕、`styles.css`、`node_modules/@xterm/**` 只读复用）和 node-pty（`@homebridge/node-pty-prebuilt-multiarch` 的 prebuilt）。即 `staticRoot`（默认 `/mnt/FAST/Vibe99`）里得有 `src/renderer.js` 和已 `npm ci` 过的 `node_modules`。
  - 注意：本项目 `package.json` **不含 node-pty**——它从 Vibe99 的 node_modules 加载（避免 GitHub prebuilt 下载不稳）。所以 Vibe99 那边必须先装好。
- 可达性：本机 `127.0.0.1`、VPN `10.8.0.154` 能到这台主机。

---

## 3. 快速开始

```bash
cd /mnt/FAST/Vibe99/web-access
nvm use 22
npm ci                         # 只装 ws + sirv（纯 JS，很快）

# 生成带强令牌的配置
TOKEN=$(openssl rand -hex 24)
mkdir -p ~/.config/vibe99-web
node -e '
  const fs=require("fs"), os=require("os"), path=require("path");
  fs.writeFileSync(
    path.join(os.homedir(),".config","vibe99-web","config.json"),
    JSON.stringify({
      port:7777, host:"0.0.0.0", token:process.argv[1],
      staticRoot:"/mnt/FAST/Vibe99",
      defaultCwd:os.homedir(), defaultTabTitle:"Vibe99",
      scrollbackCapBytes:524288, maxSessions:16,
      settingsFile:path.join(os.homedir(),".config","vibe99-web","settings.json")
    }, null, 2));
  console.log("token:", process.argv[1]);
' "$TOKEN"

# 启动
VIBE99_WEB_CONFIG=~/.config/vibe99-web/config.json node server/index.js
# 看到 [info] listening host=0.0.0.0 port=7777 即成功
```

浏览器打开（把 `<TOKEN>` 换成上面打印的）：
- 本机：`http://127.0.0.1:7777/?token=<TOKEN>&name=desk`
- 远程（VPN）：`http://10.8.0.154:7777/?token=<TOKEN>&name=travel`

> `&name=` 是可选项，用于在状态栏区分客户端（会存 localStorage）。不带则用服务端分配的 id。

---

## 4. 使用要点

- **多客户端**：开多个标签/设备都带上 `?token=...&name=...`，互不踢出，输出实时同步；状态栏显示 `clients: desk, travel`。
- **输入**：自由写入（任一客户端都可输入；单用户场景不会两台设备同时敲键）。
- **持久化**：关浏览器/断网再重连，同一组 pane 与正在跑的任务仍在，历史输出（scrollback）可见。
- **加 pane**：点 `+` 或 `Ctrl/Cmd+T`；**刷新后所有 pane（含手动加的 p4+）都会回来**。
- **尺寸**：多客户端时终端取**最小尺寸**（tmux 式）——谁都不会被截断；大屏会有右侧留白（正常，不错位）。
- **右键菜单 / 复制粘贴**：浏览器内右键菜单（文本）；非 HTTPS 网络下 `navigator.clipboard` 可能受限，用右键粘贴兜底。

---

## 5. 配置（`config.json`）

| 字段 | 说明 | 默认 |
|---|---|---|
| `port` | 监听端口 | 7777 |
| `host` | 绑定地址（`0.0.0.0` = 全部接口；见 §9 安全） | 0.0.0.0 |
| `token` | bearer 令牌（≥16 字符，越随机越好） | 必填 |
| `staticRoot` | Vibe99 项目根（提供 src/ + node_modules） | /mnt/FAST/Vibe99 |
| `defaultCwd` | 新 pane 的默认工作目录 | $HOME |
| `defaultTabTitle` | 默认标签标题 | Vibe99 |
| `scrollbackCapBytes` | 每 pane scrollback 上限 | 524288（512KB） |
| `maxSessions` | 最大并发 pane 数 | 16 |
| `settingsFile` | 设置文件路径 | ~/.config/vibe99-web/settings.json |

配置路径优先级：`VIBE99_WEB_CONFIG` 环境变量 → `./config.json`。

---

## 6. 常驻部署（systemd --user，会话外也活着）

```bash
mkdir -p ~/.config/systemd/user
cp deploy/vibe99-web.service ~/.config/systemd/user/
# 按需编辑 unit 里的 Node 路径与配置路径
loginctl enable-linger $USER            # 注销后用户会话（与服务）仍活
systemctl --user daemon-reload
systemctl --user enable --now vibe99-web
journalctl --user -u vibe99-web -f       # 看日志
```

> systemd unit 里 `ExecStart` 的 node 路径默认是 nvm 的 v22.22.3；若你的 node 在别处，改 unit 或用 `$(which node)`。

---

## 7. 验证（无需浏览器）

```bash
export WS_TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.config/vibe99-web/config.json','utf8')).token)")"
node server/smoke-session.js     # 持久化核心：create→输出→再 create REATTACH 回放
node server/smoke-ws.js          # 单客户端：错 token 拒绝 + create/write 往返
node server/smoke-ws-multi.js    # 多客户端：layout/clients 广播 + scrollback 单播 + p4 同步
```

三个都 `PASS` 即服务端正常。浏览器侧行为（渲染、状态栏、尺寸、多标签同步）需在真实浏览器确认。

---

## 8. 架构速览（详见 `URD/HLD/ADR/specs`）

```
浏览器 (127.0.0.1 / 10.8.0.154)
   │  HTTP GET /            → web/index.html（网关注入 boot：platform/cwd/panes）
   │  HTTP GET /src/**, /node_modules/@xterm/**, /web/**  → 只读复用 Vibe99 资源
   │  WS  /ws?token=&name=  → RealtimeGateway（sirv + ws，同端口；边缘鉴权）
   ▼
RealtimeGateway —— 多客户端集合、广播输出/layout/clients、心跳、最小尺寸协调
   ▼
SessionManager —— 持久 pty 会话（与客户端解耦）；createTerminal 幂等（reattach 回放 scrollback，单播）
```

关键设计：
- **会话持久**：pty 归 SessionManager 拥有，客户端断开不杀；仅服务端进程退出才全灭（ADR-002）。
- **布局真相源**：服务端持有 pane 列表，客户端连接/刷新时从 boot 注入 + `layout` 事件对账（`src/renderer.js` 的 `reconcileLayout`），p4+ 因此可持久。
- **传输**：控制流文本 JSON（req/res/event，`messageId` 关联 Promise），终端数据二进制帧（`protocol.js`）。
- **垫片**：`web/vibe99-shim.js` 实现与 Electron `window.vibe99` 同形状的接口，底层走 WebSocket；经典脚本先于 renderer 模块加载。

---

## 9. 安全注意

- **令牌即 shell 访问**：浏览器访问 ≈ 在主机上开终端。令牌泄露 = 主机 shell。务必用强随机令牌、走 VPN、不外传。
- **`host: 0.0.0.0` 暴露面**：默认绑定所有接口（含非 VPN 的 LAN）。令牌鉴权兜底，但建议用防火墙把该端口限制到 VPN 接口/loopback（纵深防御）。
- **令牌在 URL**：`?token=` 会进浏览器历史。可接受于私有部署；未来可用 WebSocket 子协议传递以减少暴露。
- **非 HTTPS**：`http://10.8.0.154` 非安全上下文，`navigator.clipboard` 可能受限（右键粘贴兜底），且流量不加密（依赖 VPN 加密）。

---

## 10. 已知限制

- 主机重启 / 服务进程崩溃 = 会话丢失（ADR-002；tmux 承载是后续）。
- 非 HTTPS 下剪贴板文本可能受限；**图片粘贴不支持**。
- 两客户端**同一瞬间**点 `+` 可能撞到同一个新 pane id（单用户罕见）。
- 单用户设计；多用户/团队协作（账号、隔离）在 BACKLOG。

---

## 11. 文件地图

```
server/
  index.js            入口（组装 + 优雅关闭）
  config.js           配置加载/校验
  auth.js             bearer 令牌校验（timingSafeEqual）
  gateway.js          HTTP(sirv)+WS、多客户端、广播、心跳、最小尺寸、boot 注入
  session-manager.js  持久 pty 会话、幂等 createTerminal、scrollback、广播
  pty-loader.js       从 Vibe99 的 node_modules 加载 node-pty
  settings-store.js   设置持久（移植自 Vibe99 config.ts）
  protocol.js         报文/二进制帧编解码、op/event 常量
  concurrency.js      并发桩（自由写入；Phase 2）
  logger.js           日志 + token 脱敏
  smoke-*.js          服务端冒烟测试
web/
  index.html          薄入口（boot 注入位 + 垫片 + renderer 模块）
  vibe99-shim.js      window.vibe99 的 WebSocket 实现（重连、剪贴板/菜单降级）
（renderer 不在此处——已并回 Vibe99 根 src/renderer.js，见下）
deploy/
  vibe99-web.service  systemd --user 模板
ADR/ specs/ URD.md HLD.md README.md BACKLOG.md ISSUES.md VERIFICATION_PLAN.md references/
                      Spec-Driven SDLC 规范文档
（本分支另修改了 Vibe99 根的 src/renderer.js：layout 驱动 + 客户端状态栏；桌面端与网页端共用同一份。）
```

---

## 12. 故障排查

| 现象 | 排查 |
|---|---|
| 浏览器空白 / 报错 | 开发者工具控制台；确认 `window.vibe99` 已由垫片注入；查 `journalctl --user -u vibe99-web` |
| 终端不出现 | 确认 `staticRoot` 指向装好依赖的 Vibe99 树；`curl http://127.0.0.1:7777/src/renderer.js` 应返回 JS |
| 连不上 / 401 | URL 里 `token` 是否正确；服务是否监听；VPN 是否通 |
| `EADDRINUSE` | 端口被占（改 `port` 或停旧实例） |
| pane 闪退/消失 | 确认跑的是最新代码（renderer 的 `pendingLocalAdds` 修复） |
| 尺寸错位 | 多客户端取最小尺寸，大屏留白属正常；若全屏 TUI 错乱，确认所有客户端都上报了尺寸（聚焦该 pane 触发 refit） |

---

## 13. 下一步（见 BACKLOG / 各 ADR）

- 主机重启自动恢复（tmux/screen 承载）—— ADR-002 选项 B。
- HTTPS / 自签证书（解锁剪贴板、加密）。
- WebSocket 子协议传 token（减少 URL 暴露）。
- 防火墙规则限制端口暴露面。
- 多用户/团队协作。

---
*本工程遵循 Spec-Driven SDLC 标准（见 `README.md`）。*
