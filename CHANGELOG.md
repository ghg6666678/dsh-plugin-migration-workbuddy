# 更新日志

## v0.1.1 — 2026-11-11

适配 DSH 0.2.x（实测 `0.2.2-rc.1`）。

### 修复

- **session format v4**：转换后的消息 source 归一化（assistant 消息的 `provider`/`model`、
  context 快照的 `kind: 'plugin'`），写盘不再被 v4 的准入校验拒绝；旧宿主仍保留 v3 语义。
- **0.2 persistence 写入句柄**：改用 `create()` 返回的写入句柄，seed 前缀通过
  `inheritedEventCount` 声明，并在 `finally` 里关闭句柄；不再调用已移除的
  `sessionPersistence.append()`，会话导入不再整批失败。
- **桌面壳写入**：写路由不再要求 http `Origin`，改为 loopback peer + 精确 loopback Host +
  打包客户端标记头，Electron 桌面壳（`Origin: null` 或无 Origin）可以正常导入。
- **深色主题**：设置页改用 DSH 设计令牌（`--dsw-alias-*`、`--sys-color-divider`），
  深浅色主题下都可读。
- **交互**：卡片勾选不再冒泡触发两次；记忆/MCP 勾选使用独立处理；全选覆盖自动化卡片。
- 导入结果卡显示每条会话的错误信息，失败不再看起来像静默 no-op。

### 变更

- `package.json` 增加 `engines.dsh`（`>=0.1.2-rc.1 <0.3.0`），由 DSH 在加载/安装时校验；
  peer 依赖仍是构建期 API 钉版。
- 识别新版 WorkBuddy 会话事件：`session-meta`、`resend-fork-notice`、`credit-usage`。

## v0.1.0 — 2026-09-12

首个发布版本：WorkBuddy 会话、记忆、MCP 配置与自动化任务的只读扫描与按需导入。
