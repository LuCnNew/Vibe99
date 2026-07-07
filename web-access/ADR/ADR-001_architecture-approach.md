# ADR-001 — Architecture Approach: Native Web Server vs Remote-Desktop Wrapping

> **BLUF**：决定采用"原生 web 服务端架构"——把 Vibe99 的终端会话管理提取为一个常驻服务、把既有的 web 渲染层通过实时通道送达浏览器，而不是用 noVNC/Guacamole 这类"远程桌面像素流"来包装现有应用。理由：用户要求多客户端并发、文本清晰、低带宽与原生 web 体验，而现有渲染层本就是 web 技术、可复用。

## Context

URD 要求：浏览器输入网址即可访问工作区；会话持久存活、可续；本地与远程**同时**使用；保留 Vibe99 的多 pane、focus-first 体验。现有 Vibe99 是 Electron 应用——渲染层（`src/renderer.js` + xterm.js）本就是 web 技术，主进程（`electron/main.js`）持有 pty 会话并通过 `window.vibe99` 契约与渲染层通信，但 pty 生命周期绑死在"窗口/应用"上（`before-quit` 即销毁全部会话）。

## Options Considered

- **A. 远程桌面包装（noVNC + x11vnc 共享 :1 / Guacamole / xrdp+Xvfb）**：把"正在跑的 Vibe99"以像素流送到浏览器。零代码改动；持久会话 = 活着的 X 会话。
- **B. 原生 web 服务端**：把 pty 管理提取为常驻服务（与会话绑定、与客户端解耦），把渲染层送达浏览器（实时通道）。
- **C. tmux/abduco 承载 + 逐 pane 网页终端（ttyd/gotty 风格）**：韧性最强，但丢失 Vibe99 的多 pane、focus-first 工作区体验。

## Decision

采用 **B（原生 web 服务端）**。

## Consequences

- **优点**：最佳用户体验（原生 web、文本清晰、低带宽、输入低延迟）；真正的多客户端并发；最大化复用现有渲染层与 pty 逻辑；与"深度方案"诉求一致。
- **代价**：开发量较大——需把传输从桌面专属通道改为可插拔实时通道、把 pty 生命周期从"窗口级"解耦为"会话级"、并解决 scrollback 回放、输入仲裁、鉴权。
- **取舍**：Phase 1 比方案 A 重；但方案 A 的像素流在文本清晰度、带宽、多客户端并发上均不满足 URD，方案 C 丢失核心工作区体验。详见 HLD 的 Integration Logic。
