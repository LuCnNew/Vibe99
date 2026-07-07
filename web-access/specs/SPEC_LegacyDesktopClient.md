# SPEC — LegacyDesktopClient (Quarantined)

> **BLUF**：现有 Electron 应用被**隔离**为同一 SessionManager 的"又一个客户端"，经 IPC 传输适配器接入。外壳只管窗口/菜单/应用生命周期，不再持有会话生命周期，可独立演进或淘汰。

## Rationale

HLD Integration Logic（brownfield 隔离）；ADR-001 复用。把遗留外壳与新建的服务端核心解耦，控制改动爆炸半径（Boy-Scout Rule）。

## Scope

**拥有**：Electron 外壳（窗口、原生菜单、应用生命周期）**仅此**。
**委托**：经 `IpcTransport`（镜像 `WebSocketTransport` 契约）接入 SessionManager；渲染复用 WebFrontend。

## Operational Envelope

- 平台同 Vibe99 现有支持范围；每次启动一个窗口。

## Behavioral Contract

- 作为同一工作区的"桌面端面"：关闭窗口仅 detach，**不**杀会话（对比现状：`before-quit` 杀光全部）。
- 在 BrowserWindow 中加载同一 WebFrontend 渲染，经 `IpcTransport` 通信。

## Structural Contract

- 提供 `IpcTransport`，实现 Transport 接口（`send/on`），底层用 `ipcRenderer/ipcMain`。
- 移除/委托现有 `electron/main.js` 的 PTY 处理器给 SessionManager；保留：窗口/菜单/应用生命周期。
- **隔离约束**：其他模块不得依赖 Electron API；本模块是唯一接触 Electron 的地方。
