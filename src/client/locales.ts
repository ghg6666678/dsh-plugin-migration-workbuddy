export type MigrationLocaleKey = keyof MigrationLocale
export interface MigrationLocale {
  nav: string; title: string; intro: string; sourceFound: string; sourceMissing: string; refresh: string
  sessions: string; memories: string; mcp: string; automations: string; sessionsHint: string; memoriesHint: string; mcpHint: string; automationsHint: string; automationNone: string; automationOnce: string; automationPermission: string; automationLive: string
  sessionMode: string; workspaceMode: string; newItems: string; changedItems: string; repairItems: string; upToDate: string; incrementalBegin: string; lastImported: string; excluded: string
  selectAll: string; safeTitle: string; safeBody: string; preview: string; begin: string; confirmTitle: string
  confirmBody: string; cancel: string; confirm: string; working: string; done: string; failed: string
  imported: string; skipped: string; lossy: string; secrets: string; importErrors: string; archive: string; viewManifest: string
  auditTitle: string; auditClose: string; auditEmpty: string; auditSessions: string; auditMemories: string; auditMcp: string
  noData: string; loadFailed: string; runFailed: string; noSessions: string; noMemories: string
  pickerTitle: string; back: string; selectImportable: string; clear: string; confirmSelection: string
  filterAll: string; filterNew: string; filterChanged: string; filterRepair: string; filterFailed: string
  doubleClick: string; ungrouped: string; workspaceTag: string; searchPlaceholder: string; noMatch: string
  scopeSummary: string; selectedHeader: string; clearAll: string; finish: string
  settingsTitle: string; settingsLimit: string; settingsUnlimited: string; settingsContext: string; settingsSave: string
  tabImport: string; tabExport: string
  importTitle: string; importIntro: string
  exportTitle: string; exportIntro: string; exportWorkbuddyRoot: string
  exportSelectAll: string; exportBegin: string; exportRefresh: string
  exportStatusNew: string; exportStatusAhead: string; exportStatusSynced: string; exportStatusWorkbuddyAhead: string; exportStatusConflict: string; exportStatusEmpty: string; exportStatusFailed: string
  exportSummary: string; exportNothing: string; exportNoSessions: string
  exportRunningTitle: string; exportRunningBody: string; exportRunTitle: string; exportRunBody: string
  exportQuitTitle: string; exportQuitBody: string; exportQuitConfirm: string; exportQuitCancel: string
  exportWorking: string; exportDone: string; exportFailed: string
  exportRows: string; exportCreated: string; exportAppended: string; exportSkipped: string; exportPendingImport: string
  exportUndo: string; exportUndoDone: string; exportHistory: string; exportLastExported: string; exportNever: string
}
const zhBase = {
  nav: '迁移与备份', title: '把 WorkBuddy 带入 DSH', intro: '安全地带回你的会话、记忆与连接器配置，先预览、再确认，一次完成迁移。', sourceFound: '已发现 WorkBuddy 数据', sourceMissing: '未发现 WorkBuddy 数据', refresh: '重新扫描', sessions: '会话', memories: '记忆', mcp: 'MCP 配置', automations: '自动化任务', sessionsHint: '保留消息、推理、工具调用顺序与工作目录', sessionMode: '从 WorkBuddy 导入', workspaceMode: '空间模式', memoriesHint: '逐条预览、去重后存入独立记忆空间', mcpHint: '仅迁移名称、地址与传输方式，凭据需重新配置', automationsHint: '导入定时任务：提示词、排程与目标工作区（不含运行历史）', automationNone: '没有可迁移的自动化任务', automationOnce: '单次', automationPermission: '权限按 DSH 组合默认（更安全，不继承 WorkBuddy 全权限）', automationLive: '导入后规则即按计划生效，可在自动化页随时停用', selectAll: '全选可迁移内容', safeTitle: '你的数据由你掌控', safeBody: '迁移只读取本机文件。Token、Cookie、API Key 和 OAuth 凭据永远不会被复制。', preview: '正在生成预览…', begin: '开始一键迁移', confirmTitle: '确认开始迁移？', confirmBody: '这会把选中的内容写入当前项目。重复内容会自动跳过，敏感凭据不会迁移。', cancel: '取消', confirm: '确认迁移', working: '正在迁移，请稍候…', done: '迁移完成', failed: '迁移失败', imported: '已导入', skipped: '已跳过', lossy: '降级项', secrets: '敏感字段已保护', importErrors: '导入错误', archive: '归档本次导入', viewManifest: '查看审计清单', auditTitle: '迁移审计清单', auditClose: '关闭', auditEmpty: '还没有迁移记录', auditSessions: '会话记录', auditMemories: '记忆记录', auditMcp: 'MCP 配置', noData: '没有找到可迁移内容', loadFailed: '扫描失败，请稍后重试', runFailed: '迁移失败，请检查数据后重试', noSessions: '没有发现会话', noMemories: '没有发现记忆',
}
export const zh: MigrationLocale = Object.assign(zhBase, { newItems: '新增', changedItems: '变化', repairItems: '待修复', upToDate: '已是最新', incrementalBegin: '迁移新增与变化', lastImported: '最近导入', excluded: '已排除 {deleted} 条 WorkBuddy 已删除会话{missing}', pickerTitle: '选择要导入的会话', back: '返回概览', selectImportable: '全选可导入', clear: '清空', confirmSelection: '确认选择', filterAll: '全部', filterNew: '新增', filterChanged: '变化', filterRepair: '修复', filterFailed: '失败', doubleClick: '双击进入精确选择', ungrouped: '未分组', workspaceTag: '空间', searchPlaceholder: '🔍 标题 / 路径', noMatch: '没有匹配的会话', scopeSummary: '将导入 {spaces} 个空间（{spaceNames}）· {sessions} 条会话（新增 {newCount}、变化 {changedCount}、修复 {repairCount}{failed}）', selectedHeader: '已选 {selected} / {total} · 可导入 {eligible}', clearAll: '清空选择', settingsTitle: '导入设置', settingsLimit: '单文件上限', settingsUnlimited: 'MiB · 0 = 不限制（超大项目会变成很大的单个会话）', settingsContext: '上下文预算（千 token，0 = 不限制）', settingsSave: '保存', finish: '完成',
  tabImport: '导入数据', tabExport: '导出数据',
  importTitle: '从 WorkBuddy 导入到 DSH', importIntro: '把 WorkBuddy 的会话、记忆与连接器配置带进 DSH：先预览、再确认，一次完成。',
  exportTitle: '从 DSH 导出到 WorkBuddy', exportIntro: '把 DSH 的会话写回 WorkBuddy。默认只追加新增内容，不会覆盖任何已有记录。',
  exportWorkbuddyRoot: '目标目录',
  exportSelectAll: '全选待导出', exportBegin: '开始导出', exportRefresh: '重新检查',
  exportStatusNew: '待新建', exportStatusAhead: '待追加', exportStatusSynced: '已同步', exportStatusWorkbuddyAhead: 'WorkBuddy 有新内容',
  exportStatusConflict: '两边都有新内容', exportStatusEmpty: '无内容', exportStatusFailed: '读取失败',
  exportSummary: '共 {total} 个会话 · 待新建 {new} · 待追加 {ahead} · 已同步 {synced} · 需从 WorkBuddy 拉回 {workbuddyAhead} · 冲突 {conflict}',
  exportNothing: '所有会话都已同步到 WorkBuddy，没有需要导出的内容',
  exportNoSessions: '还没有可导出的会话',
  exportRunningTitle: 'WorkBuddy 仍在运行', exportRunningBody: '为避免写入冲突和数据损坏，导出前必须完全退出 WorkBuddy。请在托盘图标上选择「退出」，确认它已从任务栏消失后再回来点击导出。',
  exportRunTitle: '开始导出到 WorkBuddy？', exportRunBody: '这会把选中的会话按顺序追加到 WorkBuddy 的记录中。已存在的记录不会被覆盖或删除。',
  exportQuitTitle: '导出前请先退出 WorkBuddy', exportQuitBody: 'WorkBuddy 正在占用它自己的数据文件，此时写入可能造成会话损坏。请先确认 WorkBuddy 中所有会话都已执行完毕，然后完全退出 WorkBuddy（包括托盘图标）。',
  exportQuitConfirm: '我确认所有会话都已执行完毕，并已完全退出 WorkBuddy', exportQuitCancel: '去退出 WorkBuddy',
  exportWorking: '正在导出，请稍候…', exportDone: '导出完成', exportFailed: '导出失败',
  exportRows: '写入记录', exportCreated: '新建会话', exportAppended: '追加会话', exportSkipped: '已跳过', exportPendingImport: '这些会话在 WorkBuddy 中有更新的内容，请用「导入数据」拉回来',
  exportUndo: '撤销上一次导出', exportUndoDone: '已撤销上一次导出', exportHistory: '导出历史', exportLastExported: '最近导出', exportNever: '尚未导出过' })
const enBase = {
  nav: 'Migration & backup', title: 'Bring WorkBuddy into DSH', intro: 'Bring your sessions, memories, and connector drafts home — preview first, confirm once, and migrate safely.', sourceFound: 'WorkBuddy data found', sourceMissing: 'WorkBuddy data not found', refresh: 'Scan again', sessions: 'Sessions', memories: 'Memories', mcp: 'MCP configs', automations: 'Automation tasks', sessionsHint: 'Preserve messages, reasoning, tool order, and working directories', sessionMode: 'WorkBuddy imports', workspaceMode: 'workspace mode', memoriesHint: 'Preview each item, deduplicate, and keep it in a private memory space', mcpHint: 'Only names, URLs, and transports move; credentials are reconfigured', automationsHint: 'Import scheduled tasks: prompts, schedules, and target workspaces (no run history)', automationNone: 'No migratable automation tasks', automationOnce: 'once', automationPermission: 'Permissions follow the DSH composition default (safer; WorkBuddy full access is not carried over)', automationLive: 'Imported rules take effect on schedule; disable them anytime in the automation page', selectAll: 'Select all available data', safeTitle: 'You stay in control', safeBody: 'Migration reads local files only. Tokens, cookies, API keys, and OAuth credentials are never copied.', preview: 'Building preview…', begin: 'Start one-click migration', confirmTitle: 'Start migration?', confirmBody: 'Selected data will be written into this project. Duplicates are skipped and secrets stay behind.', cancel: 'Cancel', confirm: 'Confirm migration', working: 'Migrating, please wait…', done: 'Migration complete', failed: 'Migration failed', imported: 'Imported', skipped: 'Skipped', lossy: 'Lossy fields', secrets: 'Secrets protected', importErrors: 'Import errors', archive: 'Archive this import', viewManifest: 'View audit manifest', auditTitle: 'Migration audit manifest', auditClose: 'Close', auditEmpty: 'No migration records yet', auditSessions: 'Session records', auditMemories: 'Memory records', auditMcp: 'MCP configs', noData: 'No migratable data found', loadFailed: 'Scan failed, please retry', runFailed: 'Migration failed, check the source and retry', noSessions: 'No sessions found', noMemories: 'No memories found',
}
export const en: MigrationLocale = Object.assign(enBase, { newItems: 'New', changedItems: 'Changed', repairItems: 'Repair', upToDate: 'Up to date', incrementalBegin: 'Migrate new and changed', lastImported: 'Last imported', excluded: 'Excluded {deleted} session(s) deleted in WorkBuddy{missing}', pickerTitle: 'Select sessions to import', back: 'Back to overview', selectImportable: 'Select all importable', clear: 'Clear', confirmSelection: 'Confirm selection', filterAll: 'All', filterNew: 'New', filterChanged: 'Changed', filterRepair: 'Repair', filterFailed: 'Failed', doubleClick: 'Double-click for precise selection', ungrouped: 'Ungrouped', workspaceTag: 'workspace', searchPlaceholder: '🔍 title / path', noMatch: 'No matching sessions', scopeSummary: 'Will import {spaces} workspace(s) ({spaceNames}) · {sessions} session(s) ({newCount} new, {changedCount} changed, {repairCount} repaired{failed})', selectedHeader: 'Selected {selected} / {total} · {eligible} importable', clearAll: 'Clear selection', settingsTitle: 'Import settings', settingsLimit: 'Max file size', settingsUnlimited: 'MiB · 0 = unlimited (a huge project becomes one very large session)', settingsContext: 'Context budget (k tokens, 0 = unlimited)', settingsSave: 'Save', finish: 'Done',
  tabImport: 'Import data', tabExport: 'Export data',
  importTitle: 'Import from WorkBuddy into DSH', importIntro: 'Bring WorkBuddy sessions, memories, and connector drafts into DSH — preview first, confirm once.',
  exportTitle: 'Export from DSH into WorkBuddy', exportIntro: 'Write DSH sessions back into WorkBuddy. New content is appended only; nothing existing is overwritten.',
  exportWorkbuddyRoot: 'Target folder',
  exportSelectAll: 'Select all pending', exportBegin: 'Start export', exportRefresh: 'Check again',
  exportStatusNew: 'New', exportStatusAhead: 'To append', exportStatusSynced: 'Synced', exportStatusWorkbuddyAhead: 'WorkBuddy moved on',
  exportStatusConflict: 'Both sides changed', exportStatusEmpty: 'Nothing to export', exportStatusFailed: 'Unreadable',
  exportSummary: '{total} session(s) · {new} new · {ahead} to append · {synced} synced · {workbuddyAhead} need importing back · {conflict} conflicted',
  exportNothing: 'Every session is already in WorkBuddy; nothing to export',
  exportNoSessions: 'No sessions to export yet',
  exportRunningTitle: 'WorkBuddy is still running', exportRunningBody: 'To avoid a write conflict or a damaged transcript, WorkBuddy must be closed before exporting. Quit it from the tray icon, wait until it leaves the taskbar, then come back and start the export.',
  exportRunTitle: 'Export into WorkBuddy?', exportRunBody: 'Selected sessions are appended to their WorkBuddy transcripts in order. Existing records are never overwritten or deleted.',
  exportQuitTitle: 'Quit WorkBuddy before exporting', exportQuitBody: 'WorkBuddy is holding its own data files open; writing into them now can corrupt a session. First confirm every conversation in WorkBuddy has finished running, then quit WorkBuddy completely — including its tray icon.',
  exportQuitConfirm: 'All conversations are finished and WorkBuddy is fully quit', exportQuitCancel: 'Let me quit WorkBuddy',
  exportWorking: 'Exporting, please wait…', exportDone: 'Export complete', exportFailed: 'Export failed',
  exportRows: 'Rows written', exportCreated: 'New sessions', exportAppended: 'Appended', exportSkipped: 'Skipped', exportPendingImport: 'These sessions have newer content in WorkBuddy; bring it back with "Import data"',
  exportUndo: 'Undo last export', exportUndoDone: 'Last export undone', exportHistory: 'Export history', exportLastExported: 'Last exported', exportNever: 'Never exported' })
