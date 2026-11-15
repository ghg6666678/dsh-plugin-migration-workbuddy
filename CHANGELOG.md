# 更新日志

## v0.2.10 — 2026-11-15

**补上 v0.2.9 的一个副作用**：过滤掉空壳摘要后，少数会话失去了检查点，而它们的表面又超出模型窗口，发消息时会失败。

### 为什么必须再补一次

DSH 的自动压缩**不能分块**：`dsh-compaction-basic` 会把整个被遮蔽范围一次性发给
摘要模型（`compactPressure` → `compactRegion` → `summarizeWithLlm`，无分块、无截断）。
所以「表面大于上下文窗口」的会话根本无法被运行时压缩——这正是导入时就要写检查点
的理由。v0.2.9 把空壳摘要过滤掉后：

- `mwh2pp2a`（约 86.5 万 token）、`mwh2pp62`（约 46 万 token）失去了原来的检查点
  （它俩此前的「摘要」只有一句 `Background command … completed`），完整导入后超过
  300k 窗口，发消息会失败；
- `mwh2pr2y`（约 26.5 万 token）勉强还在窗口内，但已越过 23.4 万的压缩阈值。

### 回显摘要兜底

WorkBuddy 的 `<cb_summary>` 回显行虽然没有整理过的 `<summary>`，却以标签形式带着
**用户请求原文**与**助手当时自述的进展**：

```
<previous_user_message><user_query>…</user_query></previous_user_message>
<previous_assistant_message>…</previous_assistant_message>
```

现在当「没有整理过的摘要」且「表面超过阈值」时，会从这些回显行里按时间顺序还原出
一份请求时间线（用户请求最多 1500 字符、助手进展最多 400 字符，按首段去重、剔除后台
任务通知），作为检查点正文折叠掉旧历史。它是确定性的，不额外调用模型。

- 正文明确声明自己是「从历史回显还原」而不是 WorkBuddy 的摘要，不冒充整理结果；
- 结果里记录 `summary-digest`，说明折叠了多少条、保留多少条；
- 实测三份回显摘要的体积：用户请求约 0.7–1.1k token，助手进展约 4–14k token，
  远小于尾部预算，折叠后模型实收 4 万 token 上下；
- 只有「回显也太薄（< 400 字符实质内容）」时才退回按完整记录导入并记 `summary-missing`。

新增回归测试：一个 180 万字符、只有回显行的会话会被折叠成检查点，正文含真实请求、
不含 WorkBuddy 模板文字。


## v0.2.9 — 2026-11-15

**修复 v0.2.8 遗留的两个问题**：「已压缩」后面显示的 token 数虚高约 1.8 倍（并会让 DSH 的上下文压力计数变成负数），以及某些对话的检查点里「阶段 N」内容为空。

### 1. 「已压缩 … 1000多万 token」——这个数不是模型实际收到的量

界面里 `已压缩 N 条历史记录（约 M tokens）` 的 M 来自检查点写入的
`compaction/summary.shadowedTokenCount`，它表示**被折叠掉的那部分历史有多大**，
不是接下来要发给模型的量。以 `workbuddy-3c95e1b40d4011651e361f7b-mwh2pqjt` 为例：

- 声明值 `11,465,753`；
- 折叠后模型实际收到 **60 条消息 / 约 39,522 token**。

问题在于 v0.2.8 用「整条事件 JSON 的字符数 ÷ 3」估这个价，而 DSH 运行时用的是
另一套固定密度估算（字符 ÷ 4，再加每块 4、每条消息 4 的结构开销，tool-call 按
名字与参数分别计价）。同一段范围两种算法的比值约 **1.81 倍**，于是 632 万被写成
1146 万。

更严重的副作用：DSH 的 `contextPressure` 投影会拿**声明的** `shadowedTokenCount`
去抵减它自己重新测得的表面总量，
`surfaceTokens = 全量(6,350,754) − 声明(11,465,753) + 检查点(15,533) = −5,099,466`。
这个负值违反了运行时自己的 zod schema（要求非负），一旦缓存行变得可用，
`SessionProjectionRegistry.restore()` 就会抛 ZodError。实测有 7 个会话是负值；
之所以还没报错，只是因为它们的缓存行序号还大于日志末尾，暂时被判为不可用。

现在把运行时的估算器**按原样复刻**到 `src/tokens.ts`（不能直接依赖
`@deepseek-ai/dsh-token-meter`——安装后的插件目录里没有这个包），用同一套算法
计算 `shadowedTokenCount`、尾部预算和 `auto` 阈值。声明价与运行时自测价一致，
`surfaceTokens` 恒为非负。

### 2. 检查点里「阶段 N」的内容是空的

WorkBuddy 会写两种「记忆行」：

- `<conversation_history_summary>`：内含 `<analysis>` 与整理过的 `<summary>`，几 KB，是真正可用的状态；
- `<cb_summary>`：只有模板开场白，后面是大量 `<previous_user_message>` /
  `<previous_tool_call>` 的**原文回显**，没有 `<summary>`。

旧提取器对没有 `<summary>` 的行走兜底分支：剥掉 `<previous_*>` 块后，剩下的模板
开场白与几十行空行仍超过 80 字符门槛，于是被当成摘要。多个这样的行合并后就变成
`阶段 1 / 阶段 2 …`，每段只有模板文字、没有内容。`<task-notification>` 里那句
`Background command "…" completed with exit code 0` 也被误抓成摘要。

现在只认**有 `<conversation_history_summary>` 头、有 `<summary>` 块、且去掉模板
后仍有 ≥80 字符实质内容**的行。真机上 18 个会话的比对：55 行 → 35 行，35 条真摘要
全部保留，丢掉的 20 行全是纯模板空壳（12 行）与任务完成通知（8 行），无误纳。
只有一个会话若完全没有真摘要，就不再硬造检查点，而是按完整记录导入并在结果里
注明「没有可用的压缩摘要」。

### 3. 其它

- `SURFACE_EVENT_TYPES` 补上 `developer/message`，与运行时的表面事件集合一致
  （否则覆盖该类型的 replace 会漏引用一个表面节点）。
- `MIGRATION_CONVERTER_VERSION` 升到 13，下次导入会自动重建受影响的会话。

## v0.2.8 — 2026-11-15

**修复两个 v0.2.7 引入的问题**：折叠过的对话导入后打不开，以及重复导入会产生重复对话。

### 1. 「历史加载失败：compaction checkpoint has no matching compaction/start」

v0.2.7 只写了检查点这一条消息，没有写它与压缩事务的配对。DSH 读取时会用
`source.compactionId` 去匹配一个正在打开的压缩，找不到就判定日志损坏并拒绝加载：

```
stored log is corrupt: SessionFormatError: compaction checkpoint has no matching compaction/start
```

现在导入会完整复现 DSH 自己压缩时提交的**四帧事务**，顺序与
`dsh-compaction-basic` 的 `compactSurfaceRegion` 一致：

1. `compaction/start`（`turn: null`，即手动/轮次外压缩）
2. `compaction/summary`（带 `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount`）
3. `user/message` 检查点（`surfaceOp.replace` + `sourceEventSeqs`）
4. `compaction/end`

并且整段事务必须排在 `session/end-seed` **之前**——那个标记会清空「当前打开的压缩」，
放在它后面事务就永远关不上。

检查点引用的事务帧序号也一并修正：之前引用的是被遮蔽历史的起点，导致摘要没有可解析的来源。

用 DSH 运行时的 `assertReleasedV4Relationships` 做了双向验证：四帧事务通过；
只写检查点的旧形态被拒绝，报的正是用户看到的那句错误。

### 2. 重复导入产生重复对话

`service.ts` 在「修复 / 内容变化」时会派生一个新 id
（`workbuddy-xxx-<时间戳>`），旧会话原样留着，于是侧边栏里同一个对话变成两份。

现在**原地重写同一个会话 id**：把旧会话目录移动到
`$DSH_HOME/repair-backups/reimport-<时间戳>/<分组>/<会话id>/`（移动，不是删除，
旧记录随时可恢复），再用同一个 id 重新写入。一个来源始终只有一个对话。

- 移动前的路径会记录在导入结果的 `session-replaced` 条目里；
- `findLog` 会扫描所有分组目录，所以移动（而非只在新分组写）是必须的；
- 新增回归测试：改变来源内容后 `created[1] === created[0]`。

### 3. 已有的坏记录会自动重建

`MIGRATION_CONVERTER_VERSION` 升到 **12**。已用 v11 导入的会话会被判定为「需要修复」，
下次导入时自动按新格式原地重写（同一个会话 id，旧记录备份到 `repair-backups/`）。
不需要你手动删除任何对话。

### 4. 同一个来源不再残留第二份旧记录

只修复「清单里记着的那一个 id」还不够。会话 id 是**由来源内容哈希派生**的，
所以同一个 WorkBuddy 会话在内容变长之后会得到**新的 id**，而旧 id 那份仍然留在磁盘上；
更早的版本每次修复还会再派生一个带时间戳的 id。结果是同一个对话在侧边栏里出现两三份。

现在修复时会把这个来源**用过的所有 id** 一起移走（`archiveSourceCopies`）：
当前 id、这次转换算出的新 id、以及清单里所有指向同一来源的历史 id。
它们都被**移动**（不是删除）到 `$DSH_HOME/repair-backups/reimport-<时间戳>/<分组>/<会话id>/`，
每个来源在侧边栏里只剩一个对话，旧字节随时可以移回来。

新增回归测试 `archives every stored copy of a source so one chat never splits into two`：
在磁盘上造出「同一个来源的两份记录」，重新导入后断言活目录里只剩一份，
且两份旧记录都出现在 `repair-backups/` 里。

### 5. 测试

`tests/converter.spec.ts` 与 `tests/service.spec.ts` 改为断言四帧事务、
事务帧引用、`turn: null`、以及「事务在 `session/end-seed` 之前」；
全套 112 个测试通过。

用 DSH 运行时的 `assertReleasedV4Relationships` 复核了磁盘上的真实数据：
18 个会话**全部通过**，并且作为反向对照，同一批备份里的 8 份 v11 日志**全部被拒**
（`replacement sourceEventSeqs omit a shadowed surface node`）——
说明校验器确实在跑这条规则，而不是放行一切。

## v0.2.7 — 2026-11-15

**导入后可以直接继续对话**：把 WorkBuddy 自己生成的压缩摘要折叠成 DSH 的检查点（checkpoint），
超大项目不再「只能看、不能继续」。

在此之前，一个 1170 万 token 的项目导入后在你发第一句话时必然失败：DSH 在 300K 窗口的 80%
（168928 token）触发压缩，但压缩本身要求模型先**收到**这段历史——历史本身就超出了窗口，
请求根本到不了上游。WorkBuddy 早就为这类会话写过压缩摘要，只是 DSH 不认识它的格式。

- 新增 `summaryMode`：`auto`（默认）/ `always` / `never`，界面在「导入设置」里可选；
- `auto` 只在**真的无法继续**时才介入（超过 20 万 token）：小项目照样逐条导入，
  模型看到的就是你看到的；超大项目才折成「摘要 + 最近内容」；
- 摘要不是另找模型重写，而是直接复用 WorkBuddy 已生成的 `<summary>` 段，
  按时间合并去重（WorkBuddy 每次压缩都重写一份、DSH 要求合并，这正是它体积失控的原因），
  正文里丢掉 `<analysis>` 与重复内嵌的 `<previous_tool_call>`；
- 产出的消息与 DSH 自己写入的检查点**逐字段一致**：`user/message`、
  `source.kind = "compact-checkpoint"`、非 append 的 `surfaceOp`（`replace`）、
  以及覆盖每一个被遮蔽节点的 `sourceEventSeqs`；因此折叠由 DSH 自己的 surface 校验通过，
  而不是绕过它；
- **完整对话记录全部保留**：折叠只影响「模型能看到的表面」，被折叠的事件仍在日志里，
  随时可以阅读原始过程；
- 实测 87.9 MB / 35029 事件的真实会话：surface 从 11,580,722 token 降到 **88,071 token**
  （0.62%），检查点正文 62,083 字符 ≈ **20,694 token**，合并 14 份摘要；
- `MIGRATION_CONVERTER_VERSION` 升到 11。

同时修正配置默认值 `maxContextTokens` 仍为 500000 的残留（`0` = 不裁剪），
避免全新安装时又走上「按预算裁剪历史」的老路。

## v0.2.6 — 2026-11-15

修复「导入后聊天记录只剩几条」：**导入默认完整保留全部对话，不再按上下文预算裁剪**。

根因是裁剪默认开启：设置里填了 325（千 token）后，导入按 `325000 × 3 = 975000` 字符的硬上限，
只保留最近若干轮，把更早的轮次丢掉并替换成一段摘要。一条 87.9 MB / 21659 行的会话因此只剩 28 轮。

- `maxContextTokens` 默认值从 `500000` 改为 **`0`（不裁剪）**，界面默认也显示 0；
  `0` 已在文案里表示「不限制」，行为与文案现在一致；
- 裁剪改为**严格手动开启**：只有你显式填入非 0 预算才会裁剪；
- 需要裁剪时，导入结果的 loss 记录会明确写出丢了多少轮，并提示「把预算设为 0 即可导入整段对话」；
- `MIGRATION_CONVERTER_VERSION` 升到 10，已导入会话在下次导入时按新规则自动重建为完整版
  （旧副本保持可见，不归档、不隐藏、不删除）。

同时修复「导入的超长对话一发就报 400 万 token 超出上下文、自动压缩救不回来」：

DSH 自带上下文压缩（`dsh-compaction-basic`，400K 模型在 268928 token 触发），但它只能在
**工具调用与结果配对平衡**处切分历史。WorkBuddy 重试时会重放同一个 `callId`，导入器只对
call 去重、没对 result 去重，于是同一条结果被写入两次，表面平衡变成 `-5`、并在 409 处变为负值，
压缩引擎找不到安全切点，整段历史被原样发出去而超限。

- 修复后同一源文件现为 6623 个 call 对 6623 个 result、全程平衡不为负；
- 新增回归测试锁定「重放同一 callId 只产生一个 result」。

**恢复已截断的对话**：源文件都还在，把预算设为 0 后重新导入即可得到完整版
（本轮已把本机 `maxContextTokens` 置 0，并清掉一条误标的 `archived` / `supersededBy` 记录）。

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
