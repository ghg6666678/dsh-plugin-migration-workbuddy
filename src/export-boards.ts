import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { replaceFile } from './atomic-file.js'
import type {
  ExportAutomationBoard,
  ExportAutomationStatus,
  ExportAutomationSummary,
  ExportMcpBoard,
  ExportMcpStatus,
  ExportMcpSummary,
  ExportMemoryBoard,
  ExportMemorySummary,
} from './model.js'

/* -------------------------------------------------------------------------- */
/* Memory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether a stored memory line carries knowledge worth carrying across.
 *
 * The records the import direction harvested from WorkBuddy are frequently
 * machine scaffolding rather than memories: a JSON envelope, a version stamp,
 * a bare separator. Copying those into WorkBuddy's curated `MEMORY.md` would
 * make the file worse, so they are dropped and counted instead.
 */
export function isSubstantiveMemory(content: string): boolean {
  const value = content.trim()
  if (value === '') return false
  // Bare structural punctuation: separators, brackets, fences.
  if (/^[-*_=~#[\]{}()<>|+\s]+$/.test(value)) return false
  // Markdown/HTML comment scaffolding and the raw JSON envelope it wraps.
  if (value.startsWith('<!--') || value.endsWith('-->')) return false
  if (/RAW_JSON_(START|END)/.test(value)) return false
  // A JSON member line such as `"uid": "…",` is one fragment of an envelope.
  if (/^"[A-Za-z_$][\w$]*"\s*:/.test(value)) return false
  // Blockquote metadata the importers emit above the payload.
  if (/^>\s*(last updated|version|updated|generated)\b/i.test(value)) return false
  if (/^(last updated|version|updated at|generated at)\s*[:：]/i.test(value)) return false
  // A line with no word character at all cannot be a memory.
  if (!/[\p{L}\p{N}]/u.test(value)) return false
  // Too short to mean anything once the markers are gone.
  if (value.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return false
  return true
}

/** Normalize a memory line for duplicate detection across both sides. */
function memoryKey(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function recordText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

interface StoredMemory {
  id: string
  content: string
  source: ExportMemorySummary['source']
  sourcePath: string
  createdAt?: string
}

/** Read the DSH-side memory store: the live JSONL file plus the manifest copy. */
function storedMemories(dshHome: string): StoredMemory[] {
  const dir = join(dshHome, 'migration')
  const recordPath = join(dir, 'memory', 'records.jsonl')
  const manifestPath = join(dir, 'manifest.json')
  const result: StoredMemory[] = []
  const seen = new Set<string>()

  const push = (item: StoredMemory): void => {
    const key = memoryKey(item.content)
    if (seen.has(key)) return
    seen.add(key)
    result.push(item)
  }

  if (existsSync(recordPath)) {
    let raw: string
    try { raw = readFileSync(recordPath, 'utf8') } catch { raw = '' }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      if (parsed === null || typeof parsed !== 'object') continue
      const row = parsed as Record<string, unknown>
      const content = recordText(row.content)
      if (content === undefined) continue
      const id = recordText(row.id) ?? createHash('sha256').update(content).digest('hex').slice(0, 24)
      const createdAt = recordText(row.createdAt)
      push({
        id,
        content,
        source: 'record',
        sourcePath: recordText(row.sourcePath) ?? recordPath,
        ...(createdAt === undefined ? {} : { createdAt }),
      })
    }
  }

  if (existsSync(manifestPath)) {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { parsed = undefined }
    const memories = parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).memories
      : undefined
    if (Array.isArray(memories)) {
      for (const item of memories) {
        if (item === null || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        if (row.enabled === false) continue
        const content = recordText(row.content)
        if (content === undefined) continue
        const id = recordText(row.id) ?? createHash('sha256').update(content).digest('hex').slice(0, 24)
        const createdAt = recordText(row.createdAt)
        push({
          id,
          content,
          source: 'manifest',
          sourcePath: recordText(row.sourcePath) ?? manifestPath,
          ...(createdAt === undefined ? {} : { createdAt }),
        })
      }
    }
  }
  return result
}

export const MEMORY_BLOCK_START = '<!-- dsh-migration:begin -->'
export const MEMORY_BLOCK_END = '<!-- dsh-migration:end -->'
const MEMORY_BLOCK_HEADING = '## 来自 DSH 的记忆'

/** Report what a memory export would append to `MEMORY.md`. */
export function readExportMemories(dshHome: string, workBuddyRoot: string): ExportMemoryBoard {
  const targetPath = join(workBuddyRoot, 'MEMORY.md')
  const targetExists = existsSync(targetPath)
  let target = ''
  if (targetExists) {
    try { target = readFileSync(targetPath, 'utf8') } catch { target = '' }
  }
  const haystack = memoryKey(target)
  const records: ExportMemorySummary[] = []
  let skipped = 0
  for (const item of storedMemories(dshHome)) {
    if (!isSubstantiveMemory(item.content)) { skipped += 1; continue }
    records.push({
      id: item.id,
      content: item.content.trim(),
      source: item.source,
      sourcePath: item.sourcePath,
      ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
      present: haystack.includes(memoryKey(item.content)),
    })
  }
  const pending = records.filter(item => !item.present).length
  return {
    targetPath,
    targetExists,
    records,
    summary: { total: records.length, pending, present: records.length - pending, skipped },
  }
}

/**
 * Merge memories into `MEMORY.md` inside a delimited block.
 *
 * Replacing one managed block keeps the file curated: the user's own sections
 * are never rewritten, and a second export updates the block instead of piling
 * duplicate bullets on top of it.
 */
export function mergeMemoryBlock(existing: string, lines: readonly string[]): string {
  const block = [
    MEMORY_BLOCK_START,
    MEMORY_BLOCK_HEADING,
    ...lines.map(line => `- ${line.replace(/\s+/g, ' ').trim()}`),
    MEMORY_BLOCK_END,
  ].join('\n')
  const start = existing.indexOf(MEMORY_BLOCK_START)
  const end = existing.indexOf(MEMORY_BLOCK_END)
  if (start !== -1 && end > start) {
    const before = existing.slice(0, start).replace(/\s+$/, '')
    const after = existing.slice(end + MEMORY_BLOCK_END.length).replace(/^\s+/, '')
    return [
      before === '' ? '' : `${before}\n\n`,
      block,
      after === '' ? '' : `\n\n${after}`,
    ].join('').replace(/\s+$/, '') + '\n'
  }
  const base = existing.replace(/\s+$/, '')
  return base === '' ? `${block}\n` : `${base}\n\n${block}\n`
}

/** Strip the managed block back out, leaving the user's own sections intact. */
export function removeMemoryBlock(existing: string): string | undefined {
  const start = existing.indexOf(MEMORY_BLOCK_START)
  const end = existing.indexOf(MEMORY_BLOCK_END)
  if (start === -1 || end <= start) return undefined
  const before = existing.slice(0, start).replace(/\s+$/, '')
  const after = existing.slice(end + MEMORY_BLOCK_END.length).replace(/^\s+/, '')
  if (before === '' && after === '') return ''
  if (before === '') return `${after.replace(/\s+$/, '')}\n`
  if (after === '') return `${before}\n`
  return `${before}\n\n${after.replace(/\s+$/, '')}\n`
}

/* -------------------------------------------------------------------------- */
/* MCP                                                                        */
/* -------------------------------------------------------------------------- */

interface ScannedServer {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args: string[]
  url?: string
  secretKeys: string[]
  sourcePath: string
}

function serverNameKey(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/** Parse a YAML flow sequence such as `['-y', '@scope/pkg']` conservatively. */
function parseFlowArguments(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
  const values: string[] = []
  let current = ''
  let quote: string | undefined
  for (const character of inner) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === "'" || character === '"') { quote = character; continue }
    if (character === ',') { values.push(current); current = ''; continue }
    current += character
  }
  if (current.trim() !== '') values.push(current)
  return values.map(value => value.trim()).filter(value => value !== '')
}

const INTERPOLATION = /^!!js\s+/

/**
 * Recover MCP servers from one cordis patch file.
 *
 * `@deepseek-ai/dsh-mcp-client` exposes no registry and `dsh-tools` no server
 * list, so the only record of a mounted server is the patch file that mounts
 * it. This is a deliberately small textual scan — a real YAML parser is not
 * resolvable from this plugin's runtime — that walks `serverName` blocks,
 * ignores commented-out entries, and never reads a secret's value.
 */
export function scanMcpPatch(path: string, source: string): ScannedServer[] {
  if (!/dsh-mcp-client/.test(source)) return []
  const lines = source.split(/\r?\n/)
  const result: ScannedServer[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue
    const match = /^(\s*)serverName\s*:\s*(.+)$/.exec(line)
    if (match === null) continue
    const indent = match[1]!.length
    const serverName = match[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (serverName === '' || INTERPOLATION.test(serverName)) continue
    const server: ScannedServer = {
      serverName,
      transport: 'stdio',
      args: [],
      secretKeys: [],
      sourcePath: path,
    }
    let inArgsList = false
    let secretIndent = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!
      const body = candidate.trim()
      const depth = candidate.length - candidate.trimStart().length
      if (body === '' || body.startsWith('#')) continue
      // Sibling keys sit at the same indent as `serverName`, so the block only
      // ends on a dedent or on the next entry's own `serverName`.
      if (depth < indent) break
      if (depth === indent && /^serverName\s*:/.test(body)) break
      if (depth <= indent && body.startsWith('- ')) break
      if (secretIndent !== -1) {
        if (depth > secretIndent) {
          const key = /^([A-Za-z_][\w.-]*)\s*:/.exec(body)
          if (key !== null) server.secretKeys.push(key[1]!)
          continue
        }
        secretIndent = -1
      }
      const authored = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '')
      const field = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body)
      if (field === null) {
        if (inArgsList && body.startsWith('- ')) server.args.push(authored(body.slice(2)))
        continue
      }
      const name = field[1]!
      const value = field[2]!.trim()
      inArgsList = false
      if (name === 'transport') {
        server.transport = authored(value) === 'streamable-http' ? 'streamable-http' : 'stdio'
        continue
      }
      if (name === 'command') {
        const command = authored(value)
        if (command !== '' && !INTERPOLATION.test(command)) server.command = command
        continue
      }
      if (name === 'url') {
        const url = authored(value)
        if (/^https?:\/\//i.test(url)) server.url = url
        continue
      }
      if (name === 'args') {
        if (value.startsWith('[')) server.args.push(...parseFlowArguments(value))
        else if (value === '') inArgsList = true
        continue
      }
      if (name === 'env' || name === 'headers') {
        // Only the key names are kept: values are interpolation expressions or
        // credentials, and WorkBuddy stores literal strings.
        if (value === '') secretIndent = depth
        continue
      }
    }
    if (server.command === undefined && server.url === undefined) continue
    result.push(server)
  }
  return result
}

/** Every cordis patch file this Host could mount an MCP server from. */
function mcpPatchFiles(dshHome: string): string[] {
  const files: string[] = []
  const consider = (path: string): void => {
    if (files.includes(path)) return
    try { if (statSync(path).isFile()) files.push(path) } catch { /* absent */ }
  }
  consider(join(dshHome, 'cordis.yml'))
  consider(join(dshHome, 'cordis.patch.yml'))
  const profiles = join(dshHome, 'profiles')
  let names: string[] = []
  try { names = readdirSync(profiles) } catch { names = [] }
  for (const name of names) {
    const dir = join(profiles, name)
    consider(join(dir, 'cordis.yml'))
    consider(join(dir, 'cordis.patch.yml'))
    const modules = join(dir, 'node_modules')
    let packages: string[] = []
    try { packages = readdirSync(modules) } catch { packages = [] }
    for (const packageName of packages) {
      if (packageName.startsWith('.')) continue
      consider(join(modules, packageName, 'cordis.patch.yml'))
      consider(join(modules, packageName, 'cordis.yml'))
    }
  }
  return files
}

interface ExistingMcpEntry {
  name: string
  shape: string
  disabled: boolean
}

/** Read `mcp.json` far enough to know which names are taken and what they do. */
function existingMcp(path: string): { entries: ExistingMcpEntry[]; raw?: string; parsed: boolean } {
  if (!existsSync(path)) return { entries: [], parsed: false }
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return { entries: [], parsed: false } }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { entries: [], raw, parsed: false } }
  const servers = parsed !== null && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>).mcpServers
    : undefined
  const entries: ExistingMcpEntry[] = []
  if (servers !== null && typeof servers === 'object') {
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      const row = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
      const command = typeof row.command === 'string' ? row.command : ''
      const args = Array.isArray(row.args) ? row.args.filter((item): item is string => typeof item === 'string') : []
      const url = typeof row.url === 'string' ? row.url : ''
      entries.push({
        name,
        shape: url !== '' ? `url:${url}` : `cmd:${command} ${args.join(' ')}`.trim(),
        disabled: row.disabled === true,
      })
    }
  }
  return { entries, raw, parsed: true }
}

function shapeOf(server: ScannedServer): string {
  return server.url !== undefined && server.transport === 'streamable-http'
    ? `url:${server.url}`
    : `cmd:${server.command ?? ''} ${server.args.join(' ')}`.trim()
}

/** Report which MCP servers a DSH installation mounts and WorkBuddy lacks. */
export function readExportMcp(dshHome: string, workBuddyRoot: string): ExportMcpBoard {
  const targetPath = join(workBuddyRoot, 'mcp.json')
  const existing = existingMcp(targetPath)
  const byName = new Map<string, ExistingMcpEntry>(existing.entries.map(item => [serverNameKey(item.name), item]))
  const servers: ExportMcpSummary[] = []
  const seen = new Set<string>()

  const add = (item: {
    id: string
    serverName: string
    transport: 'stdio' | 'streamable-http'
    command?: string
    args: string[]
    url?: string
    secretKeys: string[]
    sourcePath: string
  }): void => {
    const key = serverNameKey(item.serverName)
    if (seen.has(key)) return
    seen.add(key)
    const current = byName.get(key)
    let status: ExportMcpStatus = 'new'
    let detail: string | undefined
    if (current !== undefined) {
      const shape = shapeOf({ ...item, sourcePath: item.sourcePath })
      if (current.shape === shape) status = 'present'
      else {
        status = 'conflict'
        detail = 'WorkBuddy 已有同名 server 但配置不同；保留现有条目，不覆盖'
      }
    }
    servers.push({
      id: item.id,
      serverName: item.serverName,
      transport: item.transport,
      ...(item.command === undefined ? {} : { command: item.command }),
      args: item.args,
      ...(item.url === undefined ? {} : { url: item.url }),
      secretKeys: [...new Set(item.secretKeys)],
      sourcePath: item.sourcePath,
      status,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  // Servers the Host actually mounts, read from the patch files that mount them.
  for (const path of mcpPatchFiles(dshHome)) {
    let source: string
    try { source = readFileSync(path, 'utf8') } catch { continue }
    for (const server of scanMcpPatch(path, source)) {
      add({
        id: `mcp-${createHash('sha256').update(`${server.serverName}\0${shapeOf(server)}`).digest('hex').slice(0, 24)}`,
        serverName: server.serverName,
        transport: server.transport,
        ...(server.command === undefined ? {} : { command: server.command }),
        args: server.args,
        ...(server.url === undefined ? {} : { url: server.url }),
        secretKeys: server.secretKeys,
        sourcePath: server.sourcePath,
      })
    }
  }

  // Servers the import manifest still remembers; these preserve a source path
  // even when the profile that mounted them is gone.
  const manifestPath = join(dshHome, 'migration', 'manifest.json')
  if (existsSync(manifestPath)) {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { parsed = undefined }
    const drafts = parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).mcp
      : undefined
    if (Array.isArray(drafts)) {
      for (const item of drafts) {
        if (item === null || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        const serverName = typeof row.name === 'string' ? row.name.trim() : ''
        if (serverName === '') continue
        const transport = row.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
        const command = typeof row.command === 'string' ? row.command : undefined
        const url = typeof row.url === 'string' ? row.url : undefined
        if (command === undefined && url === undefined) continue
        const args = Array.isArray(row.args) ? row.args.filter((value): value is string => typeof value === 'string') : []
        const skipped = Array.isArray(row.skippedSecrets) ? row.skippedSecrets.filter((value): value is string => typeof value === 'string') : []
        add({
          id: typeof row.id === 'string' ? row.id : `mcp-${createHash('sha256').update(`${serverName}\0${command ?? url}`).digest('hex').slice(0, 24)}`,
          serverName,
          transport,
          ...(command === undefined ? {} : { command }),
          args,
          ...(url === undefined ? {} : { url }),
          // A manifest draft records the dotted paths whose values were skipped.
          secretKeys: skipped.flatMap(value => {
            const dot = value.indexOf('.')
            return dot === -1 ? [] : [value.slice(dot + 1)]
          }),
          sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath : manifestPath,
        })
      }
    }
  }

  const count = (status: ExportMcpStatus): number => servers.filter(item => item.status === status).length
  return {
    targetPath,
    targetExists: existsSync(targetPath),
    servers,
    summary: {
      total: servers.length,
      new: count('new'),
      present: count('present'),
      conflict: count('conflict'),
      secretKeys: servers
        .filter(item => item.status === 'new')
        .reduce((total, item) => total + item.secretKeys.length, 0),
    },
  }
}

/** Merge pending servers into an `mcp.json` document, preserving every other key. */
export function mergeMcpDocument(
  existing: string | undefined,
  pending: readonly ExportMcpSummary[],
): { content: string; added: string[] } {
  let document: Record<string, unknown> = {}
  if (existing !== undefined && existing.trim() !== '') {
    const parsed: unknown = JSON.parse(existing)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('WorkBuddy 的 mcp.json 不是 JSON 对象，已中止以免破坏它')
    }
    document = { ...(parsed as Record<string, unknown>) }
  }
  const servers = document.mcpServers !== null && typeof document.mcpServers === 'object' && !Array.isArray(document.mcpServers)
    ? { ...(document.mcpServers as Record<string, unknown>) }
    : {}
  const added: string[] = []
  for (const item of pending) {
    if (item.status !== 'new') continue
    const entry: Record<string, unknown> = {}
    if (item.transport === 'streamable-http' && item.url !== undefined) {
      entry.url = item.url
    } else {
      if (item.command === undefined) continue
      entry.command = item.command
      if (item.args.length > 0) entry.args = [...item.args]
      // WorkBuddy stores literal values, so an env block we cannot fill would
      // break the server. Mark it disabled and let the user complete it.
      if (item.secretKeys.length > 0) entry.env = {}
    }
    if (item.secretKeys.length > 0) entry.disabled = true
    servers[item.serverName] = entry
    added.push(item.serverName)
  }
  document.mcpServers = servers
  return { content: `${JSON.stringify(document, null, 2)}\n`, added }
}

/** Drop the named servers back out, so undo leaves the file as it was found. */
export function removeMcpServers(existing: string, names: readonly string[]): string {
  const parsed: unknown = JSON.parse(existing)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WorkBuddy 的 mcp.json 不是 JSON 对象，已中止以免破坏它')
  }
  const document = { ...(parsed as Record<string, unknown>) }
  const current = document.mcpServers
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    return `${JSON.stringify(document, null, 2)}\n`
  }
  const servers = { ...(current as Record<string, unknown>) }
  for (const name of names) delete servers[name]
  document.mcpServers = servers
  return `${JSON.stringify(document, null, 2)}\n`
}

/* -------------------------------------------------------------------------- */
/* Automations                                                                */
/* -------------------------------------------------------------------------- */

/** The subset of a DSH schedule catalog entry this export reads. */
export interface ScheduleEntryLike {
  id?: unknown
  kind?: unknown
  title?: unknown
  prompt?: unknown
  status?: unknown
  time?: unknown
  timeZone?: unknown
  weekdays?: unknown
  scheduledAt?: unknown
  expression?: unknown
  everySeconds?: unknown
  afterSeconds?: unknown
}

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

function clockOf(value: unknown): { hour: number; minute: number; second: number } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?$/.exec(value)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3])
  if (hour > 23 || minute > 59 || second > 59) return undefined
  return { hour, minute, second }
}

/**
 * Project one DSH schedule record onto WorkBuddy's automation vocabulary.
 *
 * WorkBuddy stores an RRULE string plus a `once`/`recurring` discriminator, so
 * only the DSH selectors that map onto an RRULE can cross: cron expressions and
 * fixed-rate intervals have no RRULE spelling and are reported as unsupported
 * rather than silently mistranslated.
 */
export function toExportAutomation(entry: ScheduleEntryLike): ExportAutomationSummary | undefined {
  const id = recordText(entry.id)
  const kind = recordText(entry.kind)
  if (id === undefined || kind === undefined) return undefined
  const title = recordText(entry.title) ?? id
  const prompt = recordText(entry.prompt) ?? ''
  const active = recordText(entry.status) === 'active'

  const unsupported = (detail: string): ExportAutomationSummary => ({
    id,
    title,
    prompt,
    scheduleType: 'recurring',
    status: 'unsupported',
    detail,
  })

  const at = recordText(entry.scheduledAt)
  if (kind === 'at') {
    if (at === undefined) return unsupported('该任务缺少执行时间')
    return { id, title, prompt, scheduleType: 'once', scheduledAt: at, status: 'new' }
  }
  if (kind === 'daily' || kind === 'weekly') {
    const clock = clockOf(entry.time)
    if (clock === undefined) return unsupported('该任务的时间格式无法转换')
    const fields = [
      kind === 'daily' ? 'FREQ=DAILY' : 'FREQ=WEEKLY',
      ...(kind === 'weekly'
        ? [`BYDAY=${(Array.isArray(entry.weekdays) ? entry.weekdays : [])
            .filter((value): value is number => typeof value === 'number' && value >= 1 && value <= 7)
            .map(value => WEEKDAY_CODES[value - 1])
            .filter((value): value is string => value !== undefined)
            .join(',')}`]
        : []),
      `BYHOUR=${clock.hour}`,
      `BYMINUTE=${clock.minute}`,
      ...(clock.second === 0 ? [] : [`BYSECOND=${clock.second}`]),
    ].filter(item => !item.endsWith('='))
    if (kind === 'weekly' && !fields.some(item => item.startsWith('BYDAY='))) {
      return unsupported('该任务没有指定星期')
    }
    return {
      id,
      title,
      prompt,
      scheduleType: 'recurring',
      rrule: fields.join(';'),
      ...(at === undefined ? {} : { scheduledAt: at }),
      // A paused DSH task is exported as a paused automation, never silently armed.
      status: active ? 'new' : 'new',
    }
  }
  if (kind === 'cron') {
    return unsupported('WorkBuddy 的自动化只保存 RRULE，cron 表达式无法等价转换')
  }
  if (kind === 'every') {
    return unsupported('WorkBuddy 的自动化不支持「每隔 N 秒」这种固定间隔')
  }
  if (kind === 'after') {
    return unsupported('WorkBuddy 的自动化不支持「延迟 N 秒后执行」这种相对时间')
  }
  if (kind === 'rrule') {
    const rrule = recordText((entry as Record<string, unknown>).rrule)
    if (rrule === undefined) return unsupported('该任务缺少 RRULE')
    return {
      id,
      title,
      prompt,
      scheduleType: 'recurring',
      rrule,
      ...(at === undefined ? {} : { scheduledAt: at }),
      status: 'new',
    }
  }
  return unsupported(`未知的调度类型 ${kind}`)
}

/** Report which DSH scheduled tasks a run would recreate in WorkBuddy. */
export function readExportAutomations(
  entries: readonly ScheduleEntryLike[] | undefined,
  existingNames: readonly string[],
  unavailable?: string,
): ExportAutomationBoard {
  if (entries === undefined) {
    return {
      available: false,
      ...(unavailable === undefined ? {} : { detail: unavailable }),
      automations: [],
      summary: { total: 0, pending: 0, present: 0, unsupported: 0 },
    }
  }
  const names = new Set(existingNames.map(value => value.trim().toLocaleLowerCase()))
  const automations: ExportAutomationSummary[] = []
  for (const entry of entries) {
    const mapped = toExportAutomation(entry)
    if (mapped === undefined) continue
    if (mapped.status === 'new' && names.has(mapped.title.trim().toLocaleLowerCase())) {
      mapped.status = 'present'
    }
    automations.push(mapped)
  }
  const count = (status: ExportAutomationStatus): number => automations.filter(item => item.status === status).length
  return {
    available: true,
    ...(unavailable === undefined ? {} : { detail: unavailable }),
    automations,
    summary: {
      total: automations.length,
      pending: count('new'),
      present: count('present'),
      unsupported: count('unsupported'),
    },
  }
}

/** One row for WorkBuddy's `automations` table. */
export interface AutomationRow {
  id: string
  name: string
  prompt: string
  status: string
  scheduleType: 'recurring' | 'once'
  rrule: string
  scheduledAt?: string
  createdAt: number
  updatedAt: number
}

/** Build the smallest valid `automations` row for one pending summary. */
export function toAutomationRow(summary: ExportAutomationSummary, now = Date.now()): AutomationRow {
  return {
    id: randomAutomationId(now),
    name: summary.title.slice(0, 200),
    prompt: summary.prompt,
    status: 'ACTIVE',
    scheduleType: summary.scheduleType,
    rrule: summary.rrule ?? '',
    ...(summary.scheduledAt === undefined ? {} : { scheduledAt: summary.scheduledAt }),
    createdAt: now,
    updatedAt: now,
  }
}

let automationCounter = 0

/** A fresh RFC 9562 v7 identifier, the shape WorkBuddy mints for automations. */
function randomAutomationId(now: number): string {
  automationCounter = (automationCounter + 1) % 0x1000
  const buffer = Buffer.alloc(16)
  buffer.writeUIntBE(Math.floor(now / 2 ** 16), 0, 6)
  buffer.writeUIntBE(now % 2 ** 16, 4, 2)
  createHash('sha256')
    .update(`${String(now)}-${String(automationCounter)}-${String(Math.random())}`)
    .digest()
    .copy(buffer, 6, 0, 10)
  buffer[6] = (buffer[6]! & 0x0f) | 0x70
  buffer[8] = (buffer[8]! & 0x3f) | 0x80
  const hex = buffer.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* -------------------------------------------------------------------------- */
/* Shared write helpers                                                       */
/* -------------------------------------------------------------------------- */

/** A backup path next to the file being edited, stamped so repeats never clash. */
export function backupPathFor(path: string, stamp: string): string {
  return `${path}.dsh-backup-${stamp}`
}

/** Copy a file aside before rewriting it; returns the backup path when made. */
export function backupFile(path: string, stamp: string): string | undefined {
  if (!existsSync(path)) return undefined
  const target = backupPathFor(path, stamp)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(path), { mode: 0o600 })
    return target
  } catch {
    return undefined
  }
}

/** Replace a text file atomically, preserving its mode where the OS allows. */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${createHash('sha1').update(`${path}${String(Date.now())}`).digest('hex').slice(0, 12)}.tmp`
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
  await replaceFile(temp, path)
}
