# SPEC — WorkspacePersistence

> **BLUF**：当前实现只负责保存/恢复 UI 设置。pane 布局在服务进程运行期间由 SessionManager 持有；
> 跨重启恢复 pane 布局是后续能力，不属于当前已实现范围。

## Rationale

URD 要求重连后能回到当前工作区。当前实现先保证服务进程内重连恢复布局，并把 UI 设置落盘；跨重启
布局恢复需要额外存储与 pty 重新拉起策略，列入后续阶段。

## Scope

**拥有**：UI 设置的持久存储（字体大小、pane 宽度、pane 透明度）。
**委托**：服务进程内 pane 布局 → SessionManager；scrollback → SessionManager 内存；跨重启布局恢复 → deferred。

## Operational Envelope

- 写穿或周期 flush；数据量小。
- 存储损坏时回退到默认值，不阻塞启动。

## Behavioral Contract

- 浏览器刷新或断线重连时，pane 布局由仍在运行的 SessionManager 提供。
- 服务进程重启后，UI 设置恢复；pane 布局与 pty 会话不恢复。
- 设置文件损坏或缺失时回退到默认设置。

## Structural Contract

- `saveSettings(settings)` / `loadSettings()` —— 改造自现有 `config.ts` 的 `loadConfig/saveConfig`
- 存储路径：`config.settingsFile`。

## Deferred

- `saveLayout(layout)` / `loadLayout() → layout`
- 服务进程重启后按保存的 cwd 重新拉起 pane。
- scrollback 落盘。
