# Vibe99 Web Access

Vibe99 Web Access 是一个浏览器里的多 pane 终端工作区。你在主机上启动服务后，可以在本机浏览器打开，也可以从
VPN / 局域网里的另一台电脑继续访问同一组终端任务。

它适合这样的工作流：

- 在一台 Linux 主机上运行 coding agent、长命令或后台任务。
- 任务从网页终端里启动后，即使浏览器关闭，pty 会话仍由服务端持有。
- 回到本机、换到笔记本、刷新页面或断线重连后，可以接回同一组 pane 和历史输出。
- 多个浏览器可以同时连接；输出会同步显示，但同一时间最好只在一个客户端输入。

> 这个仓库仍保留原 Vibe99 Electron 桌面应用，但当前推荐入口是 Web Access。

## Requirements

在运行终端任务的主机上准备：

- Ubuntu 22.04 或更新版本。Ubuntu 20.04 不支持。
- Node.js 22。推荐用 `nvm` 安装。
- Git。
- npm 能访问 registry，用来安装 Electron、xterm 和 node-pty 依赖。
- 如果要远程访问，笔记本需要能通过 VPN 或局域网访问主机 IP。

`nvm`、Node、npm 的关系：

- `nvm` 是 Node 版本管理器，用来安装和切换 Node。
- Node.js 是运行 JavaScript 的环境。
- `npm` 是 Node 的包管理器。用 `nvm install 22` 安装 Node 22 时，npm 会一起装好，通常不用单独安装 npm。

如果还没有 `nvm`，先按 nvm 官方 README 安装：<https://github.com/nvm-sh/nvm#installing-and-updating>。
安装后重新打开终端，或执行它提示的 `source ...` 命令。

然后安装 Node 22：

```bash
nvm install 22
nvm use 22
node -v
npm -v
```

如果 `npm -v` 没有输出，通常是 Node 还没激活。重新打开终端，或者再运行一次 `nvm use 22`。

如果 `npm ci` 下载慢或失败，先配置你自己的 npm registry / proxy，再运行 setup。示例：

```bash
npm config set registry https://registry.npmmirror.com
npm config get registry
```

## Quick Start

1. Clone 仓库。

```bash
git clone git@github.com:LuCnNew/Vibe99.git
cd Vibe99
```

2. 一键安装 Web Access 依赖并生成配置。

```bash
npm run setup:web
```

这个命令会：

- 检查当前 Node 是否是 22。
- 安装根项目依赖。
- 安装 `web-access` 服务依赖。
- 生成 `~/.config/vibe99-web/config.json`。
- 生成一个强随机 token。
- 运行环境检查。

如果配置已经存在，脚本不会覆盖。需要重建配置时：

```bash
npm run setup:web -- --force
```

3. 启动 Web Access 服务。

```bash
npm run start:web
```

看到类似日志即表示启动成功：

```text
[info] listening host=0.0.0.0 port=7777
```

4. 在主机浏览器打开本机 URL。

`npm run setup:web` 会打印本机 URL，形如：

```text
http://127.0.0.1:7777/?token=<TOKEN>&name=desk
```

把 `<TOKEN>` 换成 setup 打印出来的 token。这个 token 等同于主机 shell 访问权限，不要公开分享。

## Remote Access

远程电脑访问时，把 URL 里的 `127.0.0.1` 换成主机在 VPN 或局域网里的 IP：

```text
http://<HOST_IP>:7777/?token=<TOKEN>&name=laptop
```

查主机 IP 的常用命令：

```bash
ip -br addr
hostname -I
```

如果你使用 OpenVPN，远程地址通常是主机的 `tun0` 地址，例如 `10.8.0.x`。`10.8.0.x` 只是示例，
请以你机器上的实际地址为准。

远程打不开时，先确认防火墙放行服务端口：

```bash
sudo ufw allow 7777/tcp
```

更收敛的 OpenVPN 规则：

```bash
sudo ufw allow in on tun0 from 10.8.0.0/24 to any port 7777 proto tcp
```

Windows 笔记本可以用 PowerShell 测试：

```powershell
Test-NetConnection <HOST_IP> -Port 7777
```

如果 `PingSucceeded` 是 `True`，但 `TcpTestSucceeded` 是 `False`，通常是主机防火墙没有放行端口。

## How To Use

1. 先在本机或远程浏览器打开 Web Access URL。
2. 在网页终端的 pane 里启动你的任务，例如 `codex`、长时间编译、脚本或 shell 命令。
3. 保持 `npm run start:web` 这个服务进程运行。
4. 关闭浏览器不会停止任务。
5. 重新打开同一个 URL，会接回服务端持有的 pane 和 scrollback。

多客户端行为：

- 同一个 token 可以让多个浏览器或多个标签页同时连接。
- 远程看到的是同一个 pty 输出流；本地输入的命令通常也会被 shell 回显给远程。
- `name=desk` / `name=laptop` 只是状态栏显示名，不是登录身份。
- 两个客户端同时输入时，字节会进入同一个 pty，可能交错成错误命令。

## Manual Setup

如果你不想用一键脚本，可以手动执行：

```bash
git clone git@github.com:LuCnNew/Vibe99.git
cd Vibe99
nvm use 22
npm ci
cd web-access
npm ci
npm run setup
npm run doctor
npm run start:web
```

## Useful Commands

从仓库根目录运行：

```bash
npm run setup:web     # 安装依赖并生成 Web Access 配置
npm run doctor:web    # 检查 Node、依赖、node-pty、配置和端口
npm run start:web     # 启动浏览器访问服务
npm start             # 启动原 Electron 桌面应用
```

## Architecture

Web Access 复用 Vibe99 的前端终端 UI，但把终端进程所有权放到服务端：

```text
Browser
  HTTP GET /src/**              -> 复用 Vibe99 前端资源
  WebSocket /ws?token=&name=    -> 连接 Web Access Gateway

Web Access Gateway
  校验 token
  维护在线客户端列表
  广播终端输出、pane layout 和 client 状态

SessionManager
  持有 node-pty 进程
  浏览器断开后继续保留 pty
  新客户端连接时回放 scrollback
```

更详细的设计、限制和排障见 [web-access/README.md](web-access/README.md)。

## Current Limits

- 任务必须从 Web Access 网页终端里启动；它不能接管系统里任意已经运行的终端。
- 当前是单用户、多客户端模型，没有多账号隔离。
- 服务进程退出或主机重启后，当前 pty 会话会丢失。
- HTTP 非安全上下文下，浏览器剪贴板能力可能受限制；右键粘贴通常可作为兜底。

## Desktop App

原 Electron 桌面版本仍可本地运行：

```bash
npm install
npm start
```

桌面版和 Web Access 目前不共享已经启动的私有 pty 会话。

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
