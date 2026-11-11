import { basename } from 'node:path'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'

export interface WorkBuddyInputEnvelope {
  /** The human-authored portion that should be shown as the user message. */
  text: string
  /** Safe, bounded context sections rendered by DSH's collapsible context row. */
  contextSections: ContextSnapshotSection[]
  /** Whether a generated WorkBuddy context envelope was recognized. */
  hadContext: boolean
  /** Whether a <user_query> element was present in the envelope. */
  hadQuery: boolean
  /** Non-fatal parser warnings retained in the migration loss report. */
  warnings: string[]
}

const SYSTEM_OPEN = /<system-reminder\b[^>]*>/giu
const SYSTEM_CLOSE = /<\/system-reminder\s*>/giu
const USER_QUERY = /<user_query\s*>([\s\S]*?)<\/user_query\s*>/giu

function elementBody(source: string, tag: string): string | undefined {
  const match = source.match(new RegExp(`<${tag}\\s*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'iu'))
  return match?.[1]
}

function values(source: string, pattern: RegExp, group = 1): string[] {
  return [...source.matchAll(pattern)].map(match => match[group]?.trim() ?? '').filter(Boolean)
}

function section(name: string, lines: string[]): ContextSnapshotSection | undefined {
  const text = lines.map(line => line.trim()).filter(Boolean).join('\n')
  return text === '' ? undefined : { name, text }
}

/** Extract only environment facts and file names; identity file bodies never cross the boundary. */
function summarizeSystemContext(source: string): ContextSnapshotSection[] {
  const result: ContextSnapshotSection[] = []
  const userInfo = elementBody(source, 'user_info') ?? ''
  const environment = [...userInfo.matchAll(/^\s*(OS Version|Shell|IDE Theme|Workspace Folder|Workspace)\s*:\s*(.+)$/gimu)]
    .map(match => {
      const label = match[1] ?? ''
      const value = match[2]?.trim() ?? ''
      const display = label.replace(/^OS Version$/iu, '操作系统').replace(/^Shell$/iu, 'Shell').replace(/^IDE Theme$/iu, '编辑器主题').replace(/^Workspace(?: Folder)?$/iu, '工作区')
      return `${display}: ${value}`
    })
  const environmentSection = section('运行环境', environment)
  if (environmentSection) result.push(environmentSection)

  const identityPaths = values(source, /^\s*Path\s*:\s*(\S+)\s*$/gimu)
    .map(path => basename(path))
    .filter((path, index, all) => all.indexOf(path) === index)
  const identitySection = section('身份文件', identityPaths.length > 0
    ? [`已加载 ${String(identityPaths.length)} 个身份文件: ${identityPaths.join('、')}`]
    : [])
  if (identitySection) result.push(identitySection)

  const projectLayout = elementBody(source, 'project_layout')?.trim()
  const projectSection = section('项目上下文', projectLayout ? [`项目结构快照: ${projectLayout.split(/\r?\n/u)[0]}`] : [])
  if (projectSection) result.push(projectSection)

  const additional = elementBody(source, 'additional_data') ?? ''
  const runtimeSources = additional === '' ? [source] : [additional, source]
  const runtime = [
    ...runtimeSources.flatMap(value => values(value, /<current_time\s*>([\s\S]*?)<\/current_time\s*>/giu).map(time => `当前时间: ${time}`)),
    ...runtimeSources.flatMap(value => values(value, /<connector-status\s*>([\s\S]*?)<\/connector-status\s*>/giu).map(status => `连接器: ${status}`)),
  ]
  const runtimeSection = section('运行状态', runtime)
  if (runtimeSection) result.push(runtimeSection)

  const skillsBlock = elementBody(source, 'manually_attached_skills') ?? ''
  const skills = values(skillsBlock, /^\s*name\s*:\s*(.+)$/gimu)
  const skillsSection = section('已挂载技能', skills.length > 0 ? [`技能: ${skills.join('、')}`] : [])
  if (skillsSection) result.push(skillsSection)

  return result
}

function isGeneratedContext(openTag: string, body: string): boolean {
  // WorkBuddy wraps generated prompt material in system-reminder blocks. The
  // `user-context` block carries the environment snapshot; the
  // `additional-data` block carries the clock/connector preamble that appears
  // at the top of every turn. Both are app-generated and must not be shown as
  // part of the human message.
  return /data-role\s*=\s*["'](?:user-context|additional-data)["']/iu.test(openTag)
    || /<user_info\s*>|<identity_context\s*>|<product_identity\s*>/iu.test(body)
}

/**
 * Split WorkBuddy's generated prompt envelope from the human query.
 * This is intentionally a small tag scanner rather than a broad HTML stripper:
 * only the known generated wrapper is removed, so user-authored markup survives.
 */
export function parseWorkBuddyInput(raw: string): WorkBuddyInputEnvelope {
  const warnings: string[] = []
  const contextSections: ContextSnapshotSection[] = []
  const queries: string[] = []
  const ordinary: string[] = []
  let cursor = 0
  let hadContext = false
  let hadQuery = false

  SYSTEM_OPEN.lastIndex = 0
  SYSTEM_CLOSE.lastIndex = 0
  while (true) {
    const open = SYSTEM_OPEN.exec(raw)
    if (open === null) break
    const closePattern = new RegExp(SYSTEM_CLOSE.source, 'giu')
    closePattern.lastIndex = open.index + open[0].length
    const close = closePattern.exec(raw)
    if (close === null) {
      warnings.push('unclosed system-reminder envelope; original content retained')
      break
    }
    const body = raw.slice(open.index + open[0].length, close.index)
    if (!isGeneratedContext(open[0], body)) continue
    hadContext = true
    ordinary.push(raw.slice(cursor, open.index))
    const queryMatches = [...body.matchAll(USER_QUERY)]
    if (queryMatches.length > 0) {
      hadQuery = true
      queries.push(...queryMatches.map(match => match[1]?.trim() ?? '').filter(Boolean))
    }
    contextSections.push(...summarizeSystemContext(body))
    cursor = close.index + close[0].length
    SYSTEM_OPEN.lastIndex = cursor
  }
  ordinary.push(raw.slice(cursor))

  // Handle a user_query wrapper outside a system-reminder envelope as well.
  const outside = ordinary.join('\n')
  const unwrappedOutside = outside.replace(USER_QUERY, (_whole, value: string) => {
    hadQuery = true
    return value.trim()
  })
  const text = [...queries, unwrappedOutside].map(value => value.trim()).filter(Boolean).join('\n\n').trim()
  const deduped = contextSections.filter((item, index, all) => all.findIndex(candidate => candidate.name === item.name && candidate.text === item.text) === index)
  return { text, contextSections: deduped, hadContext, hadQuery, warnings }
}
