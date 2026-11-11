# 更新日志

## v0.1.4 — 2026-11-11

修复「在 WorkBuddy 里已经删除的对话仍然被导入」。

两个原因：

1. `migrate()` 只读 live metadata，**导入路径上从不复查 `deletedSessionIds`**；preview 过滤过的
   删除会话仍可被显式选择或 `force` 导入。
2. `workbuddy.db` 被运行中的 WorkBuddy 锁住时，`readWorkBuddyCatalog` 静默退化成空目录，
   preview 看不到任何删除标记，把磁盘上残留的 JSONL 全当成可导入（当时的 manifest 里
   `metadataHash` 全是 `hash(null)` 可以佐证）。

修复：

- 导入路径改用完整 catalog，并在转换前跳过 `deletedSessionIds`，`force` 也不例外。
- 数据库打不开时先复制 `workbuddy.db`（含 `-wal`/`-shm`）到临时目录再读；仍然失败且文件存在时
  返回 `available: false, unavailableReason: 'unreadable'`：preview 把这些会话标为不可导入并给出
  警告，导入路径直接跳过会话（fail closed），不再在删除状态未知时猜测。
- 新增测试：删除的会话即使 `force` 也不导入；损坏的数据库报告 `unreadable`。

> 用旧版本导入过、且源端已删除的会话需要手动清理（或删除后重导）。

## v0.1.3 — 2026-11-11

修复补上 `session/end-seed` 之后暴露的第二层不兼容：

```
seed assistant/message at index N has invalid settlement fields
```

当前格式要求 `assistant/message` 的 data 带 `message` 和数组 `stream`（0.2 起把 attempt 的定时流
内嵌进结算事件）。转换器此前只写 `{turn, step, message}`；现在统一补 `stream: []`——导入的历史
没有可内嵌的实时 chunk，空数组是忠实表示。`normalizeMessageSources` 之后新增
`normalizeAssistantSettlements` 统一处理。

> 用 v0.1.1 / v0.1.2 导入过的会话不会自动变好：需要就地补 `stream: []`，或删除会话与清单条目后
> 重导。

## v0.1.2 — 2026-11-11

修复导入后的会话打不开：`stored session ... is corrupt: released v2 seeded Session lacks an
inherited end-seed marker`。

当前会话格式（v4）的物理 header 只记录 `isSeeded`，继承切点由日志里最后一条
`session/end-seed { inherited: true }` 事件推导。`sessionPersistence.create()` 只写 header，
v0.1.1 通过原始写入句柄追加 seed 事件时没有补这条标记，于是导入成功的会话在下次打开时全部
被判为损坏（标题显示「未命名」，历史加载失败），而 manifest 仍认为已导入。

v0.1.2 在写入 seed 事件的同一批里追加该标记（空会话也写），与 Session 种子构造函数的行为一致。

> 已用 v0.1.1 导入过的会话不会自动变好：需要在这些日志末尾补一条
> `{"type":"session/end-seed","seq":<事件数>,"time":<最后时间>,"data":{"inherited":true}}`。

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
