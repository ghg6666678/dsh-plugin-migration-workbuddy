# 更新日志

## v0.3.0 — 2026-11-11

在「迁移与备份」设置页增加「导入设置」：

- 直接设置**单文件上限（MiB，0 = 不限制）**，保存后立即重新扫描并刷新预览；
- 值持久化在 `$DSH_HOME/migration/settings.json`，优先于 profile 里的插件配置（`maxFileBytes`）；
- 新增 `GET/POST /api/migration/workbuddy/settings`，与其它写路由一样要求 loopback + 客户端标记头。

## v0.2.0 — 2026-11-11

取消单文件大小上限，并改为流式解析：

- `maxFileBytes` 默认 `0` = **不限制**（正数仍可手动设上限）；不再有 100 MiB 的硬上限。
- 转换器不再把整个 JSONL `readFile` 进内存，而是逐行流式读取，同时计算 SHA-256；数百 MB 的项目
  也不会因内存峰值或 V8 字符串上限而失败。
- 超过 64 MiB 的文件会在预览警告里提示「转换可能较慢」，但仍会照常导入。

注意：超大项目会对应一个很大的 DSH 会话，打开、搜索、滚动都会明显变慢——这是会话本身的成本，
不是导入阶段的限制。

## v0.1.9 — 2026-11-11

修复会话模式导入的落点：新版 WorkBuddy 会在每一行里带上绝对 `cwd`，旧逻辑优先使用它，
于是会话被写进 WorkBuddy 项目路径，而 workspace 注册仍然指向「会话模式」。

现在 `metadata.mode === 'session'` 时 `header.cwd` 固定为 `$DSH_HOME/workspaces/session-mode`，
与已导入的会话保持一致；workspace 模式仍使用对话里的权威 `cwd`。

## v0.1.8 — 2026-11-11

继续清理 WorkBuddy 生成内容在会话里的显示：

- `<task-notification>`（后台任务完成通知）以及随附的自动指令段落 → 折叠为「后台任务」上下文，
  不再作为一条用户消息出现；
- `<cb_summary>` / `<conversation_history_summary>`（工作记忆压缩摘要）→
  「历史压缩摘要 / 历史摘要」上下文；单块超过 2 万字时截断并标注原始长度；
- `<message_quote>` → 「引用消息」上下文，引用原文不再以 XML 出现在正文，剩余的人工输入才是消息正文。

13 个已导入会话已就地重写（会话 id 不变），宿主加载校验 13/13 通过。

## v0.1.7 — 2026-11-11

修复导入消息开头残留 WorkBuddy 生成头的问题：

```
<system-reminder data-role="additional-data">
<current_time>Wednesday, November 4, 2026 at 09:45:11 GMT+8</current_time>
</system-reminder>
```

输入解析器只识别 `data-role="user-context"` 的 reminder；`additional-data`（每轮开头的时间/连接器
前导）此前被当成用户正文保留。现在两类生成块都会剥离：`<current_time>`/连接器状态归入「运行状态」
上下文摘要，消息正文只保留 `<user_query>` 里的人工输入。

13 个已导入会话已就地重写（会话 id 不变），并全部通过宿主加载校验。

## v0.1.6 — 2026-11-11

修复「工具调用没有结果就结束 step」导致的加载失败：

```
step/end leaves unresolved tool call call_...
```

WorkBuddy 可能把下一条用户消息写在工具结果之前。旧转换器一遇到用户消息就关闭 turn，
于是那个 step 带着未解析的工具调用结束，严格校验直接判为损坏。

- 用户行遇到未完成调用时先暂存，等结果到达后再开新 turn；
- 若确实没有结果，在 `step/end` 之前补一条错误结果（严格校验要求 step 结束时无未解析调用）；
- 迟到的重复结果按 `duplicate-tool-result` 丢弃，不再补一条新的调用。

`converterVersion` 保持 9，已有导入不会被要求重导；受影响的 3 个会话已就地重写修复。

## v0.1.5 — 2026-11-11

修复导入会话把「一次工具调用 + 一条工具结果」当成一轮对话的问题。

WorkBuddy 的 JSONL 是逐行事件（`message` / `reasoning` / `function_call` /
`function_call_result`），旧转换器给每一行都开一个 turn：一次用户请求会被拆成几十个 DSH
turn，工具调用与结果也各自成为独立回合，DSH 无法识别它们属于同一次请求。

现在按 DSH 的真实结构重组：

- 一条用户消息 = 一个 turn；
- 每个助手回合 = 一个 step：`assistant/message`（reasoning / text / tool-call 块）、该步的
  `tool/call` 事件、以及对应的 `tool/result` 事件都在同一个 step；
- 并行工具调用共享一个 step；拿到结果后的下一条助手消息进入下一个 step；
- 没有结果的调用在收尾时补一条错误结果，孤立结果补一条合成调用。

同时把默认 `toolMode` 从 `narrative` 改为 `transcript`，让 DSH 原生识别工具调用/结果
（`narrative` 拍平为文本的能力仍保留，可显式启用）。

`converterVersion` 升到 9：旧导入会在预览里显示为「修复」，重新导入即可应用新分组。

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
