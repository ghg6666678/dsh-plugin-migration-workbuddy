# 更新日志

## v0.4.11 — 2026-11-16

**修复「导出面板不能取消勾选」**。两个独立缺陷：

1. 会话行的 checkbox 是 `onChange={() => undefined}` + `onClick={stopPropagation}`，**点方框本身
   完全不改状态**，只有点行内文字才切一下；现在 checkbox 的 `onChange` 与行 `onClick` 都接到
   `toggleSession`，并加了 `aria-label`。
2. 预览刷新（手动刷新、导出完成后的自动刷新）会把选择重新算一遍，旧逻辑
   `kept.length > 0 ? kept : writable` 把「一个都不选」当成「还没决定」，又全选回去 —— 表现就是
   「取消勾选后一刷新又回来了」。现在把选择协调抽成纯函数 `reconcileSelection`：
   **未手动编辑前**采用预览默认全选；**一旦编辑过**（含全选按钮），显式选择（包括空选择）
   就保留，只丢弃已不再需要写入的行。

记忆 / MCP / 自动化三个板同样受益（刷新不再吞掉显式空选择）。新增单测覆盖切换、默认全选、
空选择保持、部分选择清理。

顺带修掉 UX 审查发现的一处不一致：`status=new` 但 `pendingRows=0` 的新建空会话此前在列表里
可勾选，却被导出服务跳过，导致「勾了却不能点开始导出」；现在这类行不再提供勾选。导出方向
的数据写入逻辑未改动。

## v0.4.10 — 2026-11-16

**修复「会话文件在，但侧边栏列表里看不到」**。

侧边栏按工作区展示，成员列表是 `storages/workspace.json` 里的 `sessionIds`。实测
`workbuddy-3c95e1b40d4011651e361f7b-mwh2pqjt` 的日志（36,019 条事件、seq 连续、压缩事务四帧
配对）完全正常，但那个工作区只有 17 项 —— 它不在里面，所以不显示。

成因：原地重写会先把旧目录挪走，运行时随即把这个「日志已不存在」的 id 从成员列表里剪掉；
写回之后没有任何一步把它加回去。插件里原先那句「dsh >= 0.2 已移除 `attachSession`」的假设
也是错的 —— 运行时自己创建/派生会话时就在用 `workspace.attachSession(sessionId)`。

现在：

1. 解析到的工作区对象如果没有 `attachSession`（拿到的是纯数据形态），会再用注册表
   `get(id)` 取一次带方法的记录；
2. 挂载后**回读成员列表校验**，不再信任「调用没抛错就等于加上了」；
3. 校验失败会写入 `workspace-attach-failed`，直接说明「会话已写入但未加入工作区列表，
   侧边栏可能看不到」，而不是静默放过。

## v0.4.9 — 2026-11-16

**修复「重新导入后大项目从侧边栏消失」**（同「仅导入」线的 v0.2.11）。

原地重写必须先挪走旧目录（`create()` 拒绝已存在的 id），原实现在写入失败时只记一条错误，
旧目录留在 `repair-backups/`、侧边栏里的对话却没了。实测：`逆向分析完美校园app并精简功能`
（约 6.4M token）两次导入都 `importedSessions: 0, errors: 1`，会话目录被移走；单独重试即
成功，说明失败与「该会话当时仍被运行中的 DSH 打开」相关。

现在：

1. **写入失败自动回滚**，已归档目录移回原位，会话不消失；未能还原的连同备份路径写进错误；
2. **移动失败在写入前中止**，旧字节留在原处，不会再撞「已存在」；
3. **错误信息可操作**：命中 `already exists` / `pending` 时提示先关掉该会话或重启 Harness。

导出方向未改动。

## v0.4.8 — 2026-11-15

把「仅导入」0.2.x 线上的导入侧修复同步回带导出功能的本线（导出方向未改动）。

### 1. 「已压缩 … 1000 多万 token」：这个数是折叠掉的量，且此前虚高 1.8 倍

`compaction/summary.shadowedTokenCount` 用「整条事件 JSON 字符数 ÷ 3」估价，而 DSH 运行时
用的是字符 ÷ 4 再叠加每块 4 / 每条消息 4 的结构开销。同一段范围两种算法差约 1.81 倍，
于是 632 万被写成 1146 万；更严重的是 DSH 的 `contextPressure` 投影会拿声明值去抵减它自己
重新测得的表面总量，得到负数（实测 −5,099,466），违反运行时 zod 约束，缓存行一旦可用
`restore()` 就会抛错。

现在按原样复刻运行时的估算器（新增 `src/tokens.ts`；不能直接依赖
`@deepseek-ai/dsh-token-meter`，安装后的插件目录里没有这个包），用同一套算法计算
`shadowedTokenCount`、尾部预算与 `auto` 阈值。实测 18 个会话的声明价与运行时自测价
完全一致，`surfaceTokens` 恒为非负。

### 2. 检查点里「阶段 N」内容为空

WorkBuddy 的 `<cb_summary>` 只是模板开场白 + `<previous_*>` 原文回显，没有整理过的
`<summary>`。旧提取器对这类行走兜底，剥掉回显块后只剩模板与空行、却超过 80 字符门槛，
于是被当成摘要；`<task-notification>` 的「Background command … completed」也被误抓。

现在只认 `<conversation_history_summary>` 头 + `<summary>` 块 + 去掉模板后 ≥80 字符实质
内容的行。真机 18 个会话比对：55 行 → 35 行，35 条真摘要全部保留，丢弃的 20 行全是纯模板
空壳（12）与任务完成通知（8）。

### 3. 超大会话失去检查点后仍可继续

DSH 的自动压缩不能分块，表面大于上下文窗口时无法压缩。若某会话没有整理过的摘要、表面
又超过阈值，现在会从 `<cb_summary>` 回显里按时间顺序还原一份请求时间线作检查点正文
（确定性提取，不额外调用模型），并记 `summary-digest` 说明来源。

### 4. 重复导入不再产生重复对话

`service.ts` 原先在「修复 / 内容变化」时派生 `${id}-${时间戳}` 新 id，旧会话原样留着，
同一来源在侧边栏变成两份。现在原地重写同一 id，旧目录移动到
`$DSH_HOME/repair-backups/reimport-<时间戳>/`，并把同一来源的其它副本一并归档。

### 5. 其它

- `SURFACE_EVENT_TYPES` 补上 `developer/message`，与运行时表面事件集合一致；
- `MIGRATION_CONVERTER_VERSION` 升到 14，下次导入会自动重建受影响的会话；
- 全量测试 204 项通过（含导出方向 19+15+31+23+6 项）。

## v0.4.2 — 2026-11-11

修复「重新点导入会把全部会话归档、并生成重复副本」：

- 判定「已导入 / 有变化」时不再比较 `metadataHash`。旧版导入器的元数据哈希算法与当前版本不同，
  导致所有历史会话被误判为「变化」，重新导入时旧副本被归档、又生成一批带后缀的新副本；
- 现在只有**源文件内容哈希变化**或 `toolMode` 改变才算「变化」；标题/目录等元数据漂移不再触发重导；
- 已撤销这次误导入：恢复 14 个原会话、删除 14 个重复副本（已备份）、保留 2 个此前遗漏的新会话，
  工作区共 16 个会话、归档列表清空。

## v0.4.1 — 2026-11-11

修复「导入大项目（带摘要注入）后会话损坏」：

- 裁剪时注入的历史摘要沿用了已废弃的 `source.kind = 'plugin'`，v4 宿主加载时报
  `format v4 message requires a producer-owned source kind`；
- 注入消息现在在 v4 宿主使用 `workbuddy-migration`（旧宿主仍用 `plugin`）；
- 14 个导入会话已重新生成，扫描确认所有消息的 `source.kind` 均是 producer-owned。

## v0.4.0 — 2026-11-11

导入会话改放到独立工作区「从WorkBuddy导入的对话」：

- 新导入写入 `$DSH_HOME/workspaces/workbuddy-imported`，工作区显示名「从WorkBuddy导入的对话」；
- 已有的 14 个导入会话已原地迁移：header `cwd`、日志目录、迁移清单、workspace 注册表一起更新；
- 原「会话模式」工作区只保留非导入会话。

## v0.3.3 — 2026-11-11

按 WorkBuddy 自己的压缩方式保留长期记忆：

- 摘要不再截断到 2 万字：WorkBuddy 的 `cb_summary` 常有 20–50 万字，它本身就是模型的长期记忆；
- 裁剪历史时优先保留最后一份「历史压缩摘要」：即使它落在被裁区间，也会作为上下文消息重新注入到
  种子开头（system head 之后），再按剩余预算保留最近 turn；
- 「完美校园」项目现在 = **32.9 万字的 WorkBuddy 压缩摘要 + 最近 6 轮**，整段约 36.6 万 token，
  在 105 万窗口内继续对话。

## v0.3.2 — 2026-11-11

导入时按上下文预算裁剪历史，修复「续聊超过模型上下文」：

- 新增 `maxContextTokens`（默认 `500000`，`0` = 不裁剪）；设置页「导入设置」可直接改。
- 转换后按保守估算（3 字符/token）计算；超出预算时从最早的 turn 开始丢弃，只保留最近轮次，
  并重排 turn 编号、补回受保护的 system head。
- 导入审计新增 `context-trimmed`，注明丢弃了多少轮。

已把那个约 400 万 token 的项目就地重写为最近 7 个 turn（约 28 万 token），14/14 会话加载校验通过。
被裁掉的历史不会进入 DSH 会话（WorkBuddy 源文件不受影响）。

## v0.3.1 — 2026-11-11

修复「导入会话继续对话时报 tool_use 错误、重启后判损坏」：

1. **工具调用块位置**：assistant/message 里若 `tool-call` 之后还有文本块，Anthropic 风格的
   provider 会报 `tool_use ids were found without tool_result blocks immediately after`。
   转换器现在把 tool-call 块一律排到消息末尾（推理/文本在前）。
2. **system head**：种子会话缺少 `system/message` 作为首个 surface 事件。续聊时运行时会追加自己的
   system/message，而格式要求它必须挂在受保护的 first surface head 上，否则重启后报
   `system/message requires a protected first surface head`。转换器现在在第一个 step 开头写入一条
   `system/message`（role system / source system-prompt）。

14 个已导入会话已就地重写（会话 id 不变），宿主加载校验 14/14 通过。

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
