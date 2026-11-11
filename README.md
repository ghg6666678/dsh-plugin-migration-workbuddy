# dsh-plugin-migration-workbuddy

把 WorkBuddy 的会话、记忆、MCP 配置与自动化任务迁移进 DSH。

插件开箱可用，在设置页提供 **扫描 → 预览 → 明确确认 → 导入 → 审计清单** 的完整闭环；
打开页面只做本机**只读**扫描，不会复制、移动或修改任何 WorkBuddy 数据。

## 兼容性

本分支适配 DSH **0.2.x**（实测 `0.2.2-rc.1`），最低版本写在 `package.json` 的 `engines.dsh`
（`>=0.1.2-rc.1 <0.3.0`），由 DSH 加载时校验，不需要逐版本豁免。

相对 v0.1.0，v0.1.1 修掉了在当前客户端上的四处不兼容：

- 会话消息按 **session format v4** 归一化（assistant 消息的 source、context 快照的 `kind`），
  否则每次 append 都被拒；
- 通过 **0.2 的 persistence 写入句柄**落盘（`create()` 返回 handle，seed 前缀用
  `inheritedEventCount` 声明），不再调用已移除的 `sessionPersistence.append()`；
- 写路由接受 **Electron 桌面壳**的请求（`Origin: null` 或无 Origin）：loopback peer +
  精确 loopback Host + 打包客户端的标记头，跨站页面依旧无法伪造；
- 设置页改用 DSH **设计令牌**，深色主题下不再是一块亮白卡片。

另外补上了新版 WorkBuddy 会话事件的识别（`session-meta`、`resend-fork-notice`、`credit-usage`），
并修了会话/自动化卡片勾选与「全选」的交互。

## 安装

本包自带 `cordis.patch.yml`，并通过 `dsh.bundle.patch` 声明自己是 profile bundle：`dsh plugin add`
会把它**同时**装成依赖和 profile 层，不需要手写组合行。

### 推荐：从 Release 的 tarball 安装（一条命令，无需构建授权）

```bash
dsh plugin --profile <name> add \
  https://github.com/ghg6666678/dsh-plugin-migration-workbuddy/releases/download/v0.1.1/dsh-plugin-migration-workbuddy-0.1.1.tgz
```

tgz 里已经是构建好的 `lib/`，装完即用：实测**一条命令、约 3 秒、退出码 0**，不需要任何
`allowBuilds` 授权，版本也被 URL 锁死。

### 从 GitHub 按 tag 安装（需要构建授权）

```bash
dsh plugin --profile <name> add github:ghg6666678/dsh-plugin-migration-workbuddy#v0.1.1
```

git 安装取的是**源码而不是构建产物**，所以本包提供 `prepare` 脚本，由 pnpm 在安装后自动从
`src/` 构建出 `lib/`。pnpm ≥10 默认拒绝执行它：**第一次 `add` 必定失败**，并在错误里打印一条可
直接复制的授权键。把 `allowBuilds:` 连同那条键写进该 profile 的 `pnpm-workspace.yaml`，再重跑
同一条 `add`：

```yaml
# $DSH_HOME/profiles/<name>/pnpm-workspace.yaml
allowBuilds:
  dsh-plugin-migration-workbuddy@https://codeload.github.com/ghg6666678/dsh-plugin-migration-workbuddy/tar.gz/<commit-sha>: true
```

实测两点坑：

- **必须用 pnpm 打印的那条完整键**。只写包名 `dsh-plugin-migration-workbuddy: true` **不生效**，
  还会继续报同一个错。
- 键里带解析出的 tarball 地址和 commit SHA，所以它顺带起了**版本锁定**的作用；如果哪次打印出来的键
  跟上一次不同（git 解析方式变了），用最新那条。
- 另外，pnpm ≥10 会在临时目录里给 git 依赖再跑一次 `pnpm install`。如果 `pnpm` 不在 PATH 上
  （只装了 DSH 自带运行时、平时靠 corepack 的机器就是这样），这一步会报
  `ERR_PNPM_PREPARE_PACKAGE` 和 `'pnpm' 不是内部或外部命令`。先 `npm i -g pnpm`（或
  `corepack enable`）再重试；不想动环境就直接用上面的 Release tarball。

这条授权等于**允许该包在安装时在你机器上执行代码**（在任何沙箱之外）。只对你信任源码的包这么做，
并固定到 tag 或 commit。

### 从本地检出安装

```bash
dsh plugin --profile <name> add /绝对路径/dsh-plugin-migration-workbuddy
```

### 自己打 tarball / 发布到 registry

```bash
pnpm pack     # 产出 dsh-plugin-migration-workbuddy-0.1.1.tgz（会自动跑 prepare，含 lib/）
dsh plugin --profile <name> add ./dsh-plugin-migration-workbuddy-0.1.1.tgz

# 发布到 registry 之后（需先把 package.json 的 private 改为 false 并定许可证）
dsh plugin --profile <name> add dsh-plugin-migration-workbuddy
```

### 关闭

在你自己的 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里按 id 覆盖即可：

```yaml
- id: migration-workbuddy
  disabled: true
```

装好后重启 DSH，设置页会出现「迁移与备份」。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后插件完全不扫描磁盘 |
| `maxFileBytes` | `10485760` | 单个源文件上限（1 KiB – 100 MiB） |
| `maxFiles` | `5000` | 单次扫描文件数上限 |
| `toolMode` | `transcript` | `transcript` 保留完整工具协议：一个用户请求 = 一个 turn，每轮助手回复 = 一个 step，工具调用与结果留在同一个 step 里，DSH 能正确识别输入/输出；`narrative` 把工具调用/结果拍平为文本，导入历史不带工具协议 |
| `automationModelId` | `''` | 迁移的自动化规则写死的模型 id；空 = 用部署默认模型 |
| `automationModelAllowlist` | `[]` | 允许原样透传的模型 id；其余按 `automationModelId` 改写并记 `automation-model-remapped` |

源目录取 `$WORKBUDDY_HOME`，否则 `~/.workbuddy`；目标取 `$DSH_HOME`，否则 `~/.dsh`。

## 迁移内容

- **会话**：JSONL 消息、推理、工具调用/结果转换为 DSH `SessionEvent`；按源文件 SHA-256
  幂等，重复导入自动跳过，只有内容或元数据变化才替换。
  工具调用同时写入模型可见的 assistant `tool-call` block 与审计事件；孤立调用/结果生成可继续
  对话的合成配对并记录降级原因；同一 `callId` 被源端重复写入时按 callId 去重（每 call 至多一个
  tool-call block 与一条 tool/result），避免 `Duplicate tool output`。导入会话以 seed 前缀落盘
  （`isSeeded` + 精确 `inheritedEventCount`），运行时不会把导入历史重放为 live。
  只读 `workbuddy.db` 的 `sessions.is_playground` 区分空间模式与会话模式：空间模式按记录里的
  权威 `cwd` 建立真实工作区；会话模式统一进入 `$DSH_HOME/workspaces/session-mode`（显示名
  “会话模式”）。标题优先 `custom_title`/`title` 并写成合法的 `session/title` 事件，避免导入后
  退回首条消息当名字。
  源端删除受尊重：`sessions.deleted_at` 非空的会话整体跳过，不再因为磁盘上还留着 `.jsonl` 而
  复活；工作区目录已不存在的会话同样跳过（已删除的工作区不重建），预览状态行显示「已排除 N 条」。
  目录扫描本身不判断删除，判断来自 `workbuddy.db`。
- **按需导入**：会话卡单击 = 快速全选/全不选可导入项，双击 = 进入精确选择。精确选择按
  「空间（工作区）× 会话」二级选择：左栏空间列表（组勾选、状态计数），右栏该空间会话明细
  （状态筛选、标题/路径搜索、逐条勾选、降级计数 tooltip）；未分组会话仅可按条选择。
  服务端 `sessionKeys`/`workspaceIds` 过滤在转换前执行，未知选择项计入审计 loss
  （`unknown-selection-key`），不影响其他导入。
- **记忆**：解析 Markdown/JSON 候选，逐条去重后存入 `$DSH_HOME/migration/memory/`；
  不写 `AGENTS.md`，也不自动拼进全局 system prompt。
- **MCP**：只保留名称、URL、transport、command/args。token、cookie、API key、OAuth 与
  credential 文件永不迁移，凭据需要在部署侧重新配置。
- **自动化任务**：读 `workbuddy.db` 的 `automations` 表，RRULE 子集转 cron，支持按规则选择与
  manifest 幂等；运行历史与运行时状态不迁移。模型改写见上表：源端模型词表
  （`auto`/`fast-model`/`glm-*`/`kimi-*` …）在别的部署上通常不存在，直接透传会让规则在运行时以
  「未知模型」失败。规则形状写契约要求的 `target: { mode: 'new-session', workspaceId }`。

### 自动化通道是可选的

规则落库通过部署注册的通道完成（服务名 `automationImport`；部分部署还会注册一个兼容通道名）。
**没有通道也能用**：预览照常列出自动化草稿，但标记为不可导入；显式导入时跳过并记
`automation-channel-unavailable`，不会让整批迁移失败。会话、记忆、MCP 不受影响。

## 安全边界

- 所有扫描只读；路由只接受 **loopback peer + 精确 loopback Host** 的请求，写操作还要求打包客户端的
  标记头 —— Electron 桌面壳没有正常的 http Origin，跨站页面也无法伪造这两个条件。
- 预览返回的路径经过 `sanitizePathForPreview` 脱敏，凭据类字段在解析阶段就被剔除。
- 附件、分支、原始 system prompt、旧版 SQLite 完整恢复尚未支持。DSH 没有通用物理删除接口，
  因此撤销语义是**归档 + 清单审计**。

## 开发

```bash
pnpm install
pnpm run build       # tsdown(Host ESM + Client CJS) + tsc 声明
pnpm run typecheck
pnpm run test
pnpm run check       # 三者串跑
```

产物在 `lib/`：Host 面 `lib/index.js`，Client 面 `lib/client.js`（`window.__ModuleLoader__`
自注册，id = 包名）。

`prepare` 是安装时入口（pnpm 在 git 安装后自动调用），内容与 `build` 同一条链、只是不先清目录；
它只用本包自己的 devDependencies，不依赖任何 monorepo 上下文，因此从 git 装也能构建成功。

## 说明

本包由一份早期的 WorkBuddy 迁移实现整理而来，并按独立插件重新命名与拆分：插件 id、设置项 id、
文案与 CSS 前缀统一到本包自己的命名空间；路由为 `/api/migration/workbuddy/*`；目标 home 跟随
DSH 的 `$DSH_HOME`（默认 `~/.dsh`）；自动化规则落库从必需依赖改为可选通道（见上）。

许可证尚未确定（`package.json` 目前是 `UNLICENSED` + `private: true`）；对外发布前需要先定许可证
并把 `private` 改为 `false`。
