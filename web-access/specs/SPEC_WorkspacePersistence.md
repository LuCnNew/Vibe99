# SPEC — WorkspacePersistence

> **BLUF**：跨重启保存/恢复 pane 布局、会话元数据与设置，使重连/重启后能还原工作区结构与设置（进程级活状态不还原，见 ADR-002）。

## Rationale

URD"接续不丢内容/布局"；重连应恢复布局；设置需连续（替代现有 settings.json 行为）。

## Scope

**拥有**：工作区布局（tab/pane 结构、标题、cwd）与设置的持久存储。
**委托**：scrollback 的保留在 SessionManager 内存中；scrollback 本身的落盘 `[TBD/deferred]`。

## Operational Envelope

- 写穿或周期 flush；数据量小。
- 存储损坏时回退到默认值，不阻塞启动。

## Behavioral Contract

- 重启/重连后恢复上次保存的布局（会话在保存的 cwd 内作为**新 pty** 重新拉起；活进程状态不还原——ADR-002）。
- 设置跨重启持久（替代现有 `settings.json` 行为）。

## Structural Contract

- `saveLayout(layout)` / `loadLayout() → layout`
- `saveSettings(settings)` / `loadSettings()` —— 改造自现有 `config.ts` 的 `loadConfig/saveConfig`
- 存储路径：userData 等价目录下 `[TBD]`。
