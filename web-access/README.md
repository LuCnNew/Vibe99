# Vibe99 Web Access

Vibe99 Web Access 把 Vibe99 的多 pane 终端工作区放到浏览器里，并让终端任务在浏览器断开后继续运行。
你可以在本机打开 `127.0.0.1:<port>`，也可以在 VPN 或局域网内从另一台设备打开 `<HOST_IP>:<port>`。

先说边界：Web Access 能接续的是**在这个网页工作区里启动的任务**，因为这些任务由 Web Access 服务持有。
它不能接管系统里任意已经运行的终端，也不能自动接管旧 Electron 桌面应用已经启动的私有 pty 会话。

## 读者

- **使用者**：按步骤 setup，先在本机网页工作区启动任务，再从远程浏览器接续。
- **运维者**：把服务做成常驻进程，保护 token，排查网络和鉴权问题。
- **开发者**：在用户流程清楚后，再读架构、ADR 和模块 SPEC。

## 你会得到什么

- 在浏览器里使用 Vibe99 的多 pane 终端 UI。
- 只要 `web-access` 服务还在运行，pty 会话就继续活着。
- 关闭浏览器、刷新页面、网络断开或换设备后，可以重新接上同一组 pane。
- 重新连接时会回放该 pane 的 scrollback，不是空白屏幕。
- 多个浏览器客户端可以同时连接；输出会广播给所有客户端。
- 输入策略是自由写入：任一已连接客户端都可以向任一 pane 输入。

## 前置条件

这些都在运行终端任务的主机上准备。

- Ubuntu 22.04 或更新版本。Ubuntu 20.04 不支持。
- Node 22。推荐用 `nvm` 安装。
- npm 能访问 registry；如果安装依赖失败，先配置 npm registry / proxy。
- 已 clone 本仓库；下面用 `<repo>` 表示你的仓库根目录。
- Vibe99 根项目依赖已安装，因为 Web Access 会复用：
  - `<repo>/src/renderer.js`
  - `<repo>/src/styles.css`
  - `<repo>/node_modules/@xterm/**`
  - `<repo>/node_modules/@homebridge/node-pty-prebuilt-multiarch`
- 如果要远程访问，远程设备需要能通过 VPN 或局域网访问 `<HOST_IP>:<port>`。
- 主机防火墙需要放行 Web Access 端口；默认端口是 `7777`。

## 第一次 Setup

以下命令都在主机上执行。

### 推荐：根目录一键 setup

1. 进入仓库根目录并使用 Node 22。

`nvm` 是 Node 版本管理器；Node 22 装好后会自带 npm，通常不用单独安装 npm。
如果还没有 `nvm`，先按 nvm 官方 README 安装：<https://github.com/nvm-sh/nvm#installing-and-updating>。

```bash
cd <repo>
nvm install 22
nvm use 22
node -v
npm -v
```

如果 `npm -v` 没有输出，重新打开终端，或者再运行一次 `nvm use 22`。

如果 npm 下载慢或失败，先按你的网络环境配置 registry，例如：

```bash
npm config set registry https://registry.npmmirror.com
```

2. 安装根项目依赖、安装 Web Access 依赖、生成配置并检查环境。

```bash
npm run setup:web
```

如果配置已经存在，脚本不会覆盖。需要重建配置时运行：

```bash
npm run setup:web -- --force
```

### 手动 setup

如果不用一键脚本，可以手动执行：

```bash
cd <repo>
nvm use 22
npm ci
cd web-access
npm ci
npm run setup
npm run doctor
```

脚本会写入 `~/.config/vibe99-web/config.json`，并打印 token 和本机访问 URL。保存打印出来的 token。
这个 token 等同于打开主机 shell 的权限，不要发给不可信的人。

如果配置已经存在，`npm run setup` 不会覆盖。需要重建配置时运行：

```bash
npm run setup -- --force
```

### 启动服务

在仓库根目录运行：

```bash
npm run start:web
```

保持这个进程运行。看到类似下面的日志就说明服务已经启动：

```text
[info] listening host=0.0.0.0 port=7777
```

打开本机浏览器：

```text
http://127.0.0.1:7777/?token=<TOKEN>&name=desk
```

把 `<TOKEN>` 换成 `npm run setup:web` 或 `npm run setup` 打印的 token。`name=desk` 是可选的客户端名称，会显示在状态栏里，方便区分
本机和远程浏览器。

## 在本机启动任务

1. 打开本机 URL：`http://127.0.0.1:7777/?token=<TOKEN>&name=desk`。
2. 使用默认 pane，或者点击 `+` / 按 `Ctrl+T` 新增 pane。
3. 在某个 pane 里启动长任务、agent 或命令。
4. 保持 `web-access` 服务运行。
5. 可以关闭浏览器标签页；任务所在的 pty 仍由服务持有，并继续运行。

示例：

```bash
cd <repo>
codex
```

具体跑什么命令不重要。关键规则是：任务必须从 Web Access 网页工作区的 pane 里启动。

## 从远程接续已启动任务

当本机网页工作区里已经有任务在跑时，按下面步骤从远程接续。

1. 保持主机开机，并保持 `web-access` 服务运行。
2. 让远程设备接入同一个 VPN。
3. 在远程浏览器打开：

```text
http://<HOST_IP>:7777/?token=<TOKEN>&name=travel
```

4. 如果浏览器提示无法访问，先确认主机防火墙放行了端口。最简单的 `ufw` 规则是：

```bash
sudo ufw allow 7777/tcp
```

也可以只允许 OpenVPN 网段从 `tun0` 访问，减少暴露面：

```bash
sudo ufw allow in on tun0 from 10.8.0.0/24 to any port 7777 proto tcp
```

5. 远程浏览器会从服务端拿到当前 pane 布局。
6. 已有输出会从 scrollback 回放出来。
7. 新输出会同时显示在本机浏览器和远程浏览器。
8. 你可以在远程浏览器里继续输入，接着操作同一个任务。

本机浏览器和远程浏览器是同一工作区的两个客户端。关闭任一浏览器不会停止任务；停止服务进程或重启主机
会停止当前实现里的 pty 会话。

## 多客户端和输入行为

这是用户最容易关心、也最容易误解的部分。

- **可以几个浏览器同时连接？** 当前不限制客户端数量；只要有同一个 `token`，本机、远程、多个标签页都能同时连接。
- **这是多个用户吗？** 不是。当前是“单用户、多客户端”模型：一个受信任用户，可以从多台设备接入同一工作区。
- **远程能看到本地输入吗？** 能看到终端输出流。通常 shell 会回显你本地输入的字符，所以远程也会看到你打出来的命令和后续输出。
- **本地和远程看到的是同一个 pane 吗？** 是。所有客户端连接的是服务端持有的同一组 pane 和 pty。
- **新连接会看到历史内容吗？** 会。服务端会把该 pane 的 scrollback 回放给新连接的客户端。
- **两个客户端同时打字会怎样？** 当前是自由写入，两个键盘的字节都会进入同一个 pty，可能交错成错误命令。实际使用时，同一时间只在一个设备上输入。
- **`name=desk/travel` 是身份吗？** 不是。`name` 只是状态栏显示名，用来区分客户端；真正的访问凭据是 `token`。

## 常驻运行

前台启动适合测试。日常使用建议装成 `systemd --user` 服务。

1. 安装 service 模板。

```bash
cd <repo>
mkdir -p "$HOME/.config/systemd/user"
sed \
  -e "s#__VIBE99_REPO__#$(pwd)#g" \
  -e "s#__NODE_BIN__#$(command -v node)#g" \
  web-access/deploy/vibe99-web.service > "$HOME/.config/systemd/user/vibe99-web.service"
```

2. 检查生成后的 unit。

```bash
systemctl --user edit --full vibe99-web
```

3. 启用并启动服务。

```bash
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now vibe99-web
```

4. 查看日志。

```bash
journalctl --user -u vibe99-web -f
```

## 无浏览器验证

在 `<repo>/web-access` 下运行：

```bash
npm run smoke:session

export WS_TOKEN="$(
  node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.config/vibe99-web/config.json','utf8')).token)"
)"
npm run smoke:ws
npm run smoke:multi
```

预期结果：

- `smoke-session.js` 通过：说明 pty 创建、输出捕获、reattach 和 scrollback 回放可用。
- `smoke-ws.js` 通过：说明错误 token 会被拒绝，正确 token 能完成 create/write/read。
- `smoke-ws-multi.js` 通过：说明两个客户端能共享 layout、clients 列表、scrollback 和新增 pane。

## 背后原理

浏览器 UI 仍然是 Vibe99 的 renderer。Web Access 改掉的是传输层和终端进程的所有者。

```text
Browser
  GET /                         -> web/index.html
  GET /src/**, /node_modules/** -> 复用 Vibe99 前端资源
  WS  /ws?token=&name=          -> RealtimeGateway

RealtimeGateway
  校验 token
  维护已连接客户端列表
  广播终端输出、layout 和客户端状态
  按所有已连接客户端中的最小尺寸调整 pty

SessionManager
  持有 node-pty 进程
  浏览器断开后继续保留 pty
  为每个 pane 保存有限 scrollback
  只向重新连接的客户端回放 scrollback
```

浏览器侧的 `web/vibe99-shim.js` 暴露和 Electron preload 同形状的 `window.vibe99` API。这样
`src/renderer.js` 可以在浏览器里复用，只需要通过 WebSocket 和服务端通信。

## 当前限制

- 任务能跨浏览器断开继续运行，但不能跨服务进程退出或主机重启继续运行。
- Web Access 不能导入系统里任意已经运行的终端。
- Web Access 还不能共享旧 Electron 桌面应用里的私有 pty 会话。
- 非 HTTPS 场景下，剪贴板能力取决于浏览器权限。
- 浏览器路径不支持图片粘贴。
- 自由写入是单用户模型下的低摩擦选择；如果两个客户端同时输入，字节可能交错进入同一个终端。

## 安全注意

- 把 token 当作主机 shell 权限对待。
- 优先只在 VPN 内访问，不要把端口直接暴露到公网。
- `host: "0.0.0.0"` 会监听所有网卡；如果主机在不可信网络里，配防火墙限制来源。
- `?token=` 会进入浏览器历史记录；这是私有部署下的可接受取舍，但不要公开分享 URL。

## 故障排查

- **页面空白**：打开浏览器 devtools，确认 `/web/vibe99-shim.js` 和 `/src/renderer.js` 加载成功。
- **终端不出现**：确认 `staticRoot` 指向仓库根目录，且根项目 `node_modules` 存在。
- **Unauthorized / disconnected**：检查 URL 里的 token 和服务日志。
- **远程连不上**：检查 VPN、主机防火墙，以及服务是否监听 `0.0.0.0:7777`。如果远程设备能
  `ping <HOST_IP>`，但 `Test-NetConnection <HOST_IP> -Port 7777` 显示
  `TcpTestSucceeded : False`，通常是主机防火墙没有放行端口；可先执行
  `sudo ufw allow 7777/tcp` 验证。
- **端口占用**：修改 `config.json` 里的 `port`，或停掉旧服务。
- **远程画面被小窗口约束**：这是预期行为；多客户端连接时，pty 使用所有客户端中的最小尺寸。
- **网页粘贴无效**：先刷新页面，必要时强制刷新；网页端优先使用浏览器原生 `paste` 事件，`Ctrl+V`
  通常最稳，`Ctrl+Shift+V` 是否触发粘贴取决于浏览器和系统快捷键。

## 开发者入口

- [HANDOFF.md](HANDOFF.md)：维护者交接和运维细节。
- [HLD.md](HLD.md)：架构和模块边界。
- [ADR/](ADR/)：架构决策记录。
- [specs/](specs/)：模块契约。
- [ISSUES.md](ISSUES.md)：结构性风险和限制。
- [VERIFICATION_PLAN.md](VERIFICATION_PLAN.md)：黑盒验收检查。
