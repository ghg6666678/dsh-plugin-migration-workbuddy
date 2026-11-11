import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { replaceFile } from './atomic-file.js'
import {
  buildWorkBuddyRows,
  catalogPath,
  exportWindow,
  normalizeWorkBuddyPath,
  seedWatermark,
  serializeRows,
  sessionRowPath,
  workBuddySessionPath,
} from './exporter.js'
import type { ExportPreview, ExportResult, ExportSessionStatus, ExportSessionSummary } from './model.js'
import { WORKBUDDY_EXPORT_FORMAT_VERSION } from './model.js'
import { detectWorkBuddy, workBuddyRoot, type WorkBuddyActivity } from './workbuddy-process.js'

/**
 * DSH -> WorkBuddy export.
 *
 * Import is batch-shaped: it reads a finished WorkBuddy transcript and writes a
 * new DSH session. Export is not, because both apps keep appending to the same
 * conversation. It is therefore an append-only sync with a per-session
 * watermark:
 *
 * - `lastSyncedEventSeq` records the highest DSH event already written.
 * - The first export of an imported session starts *after* its inherited seed,
 *   so history WorkBuddy already owns is never written back twice.
 * - Before appending, the transcript's own tail row id is compared with the one
 *   this plugin wrote last time. A different id means the user continued the
 *   conversation in WorkBuddy, so the file is no longer ours to append to.
 *
 * Nothing is deleted or rewritten: a failed append is rolled back by truncating
 * the file to its pre-append length, and an explicit undo does the same.
 */

/** What one batch did to one catalog row / workspace row, for undo. */
interface DbEffect {
  sessionInserted: boolean
  previousUpdatedAt?: number
  previousLastActivityAt?: number
  workspaceInserted: boolean
  workspacePath?: string
}

/** Journal state of one DSH session before the batch touched it. */
interface PriorEntry {
  existed: boolean
  lastSyncedEventSeq?: number
  lastSyncedAt?: string
  lastRowId?: string
  rowsExported?: number
  created?: boolean
}

interface BatchSessionRecord {
  dshSessionId: string
  workbuddySessionId: string
  transcriptPath: string
  bytesBefore: number
  createdFile: boolean
  rows: number
  lastEventSeq: number
  lastRowId: string
  db: DbEffect
  prior: PriorEntry
}

interface ExportBatchRecord {
  id: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed' | 'undone'
  exitConfirmed: boolean
  activity: string[]
  sessions: BatchSessionRecord[]
  dbBackup?: string
  error?: string
}

interface ExportJournalEntry {
  dshSessionId: string
  workbuddySessionId: string
  transcriptPath: string
  cwd?: string
  title?: string
  /** Highest DSH event sequence already present in the WorkBuddy transcript. */
  lastSyncedEventSeq: number
  lastSyncedAt?: string
  /** Chain head this plugin last wrote; the anchor for conflict detection. */
  lastRowId?: string
  rowsExported?: number
  /** True when this plugin created the transcript file. */
  created: boolean
}

interface ExportJournal {
  version: number
  updatedAt: string
  sessions: ExportJournalEntry[]
  batches: ExportBatchRecord[]
}

/** Values one WorkBuddy `sessions` row needs. */
export interface SessionRow {
  id: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  lastActivityAt: number
}

/** Columns copied from the user's own most recent session row. */
export interface SessionTemplate {
  userId: string
  isPlayground: number
  transport: string
  model?: string
  permissionMode?: string
  thoughtLevel?: string
  sourceMode?: string
  mode?: string
  useSandboxCli?: number
  pluginContextJson?: string
  expertSelection?: string
}

/** The subset of `workbuddy.db` the exporter touches. */
export interface ExportDatabase {
  template(): SessionTemplate
  sessionExists(id: string): boolean
  activity(id: string): { updated_at?: number; last_activity_at?: number }
  insertSession(row: SessionRow, template: SessionTemplate): void
  updateActivity(id: string, updatedAt: number, lastActivityAt: number): void
  deleteSession(id: string): void
  workspaceExists(path: string): boolean
  touchWorkspace(path: string, at: number): void
  deleteWorkspace(path: string): void
  close(): void
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

const DEFAULT_TEMPLATE: SessionTemplate = { userId: 'local', isPlayground: 1, transport: 'local' }

/**
 * Open the catalog read-write.
 *
 * Only reachable after {@link detectWorkBuddy} reports the app is gone: SQLite
 * in WAL mode tolerates a second writer, but WorkBuddy's own connection would
 * then be holding a stale view of a table it rewrites on every message.
 */
export function openExportDatabase(root: string): ExportDatabase {
  const db = new DatabaseSync(join(root, 'workbuddy.db'))
  const columns = new Set<string>()
  try {
    for (const row of db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name?: unknown }>) {
      const name = text(row.name)
      if (name !== undefined) columns.add(name)
    }
  } catch { /* the first write reports the real problem */ }

  return {
    template(): SessionTemplate {
      let row: Record<string, unknown> | undefined
      try {
        row = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1').get() as Record<string, unknown> | undefined
      } catch { return DEFAULT_TEMPLATE }
      if (row === undefined) return DEFAULT_TEMPLATE
      const model = text(row.model)
      const permissionMode = text(row.permission_mode)
      const thoughtLevel = text(row.thought_level)
      const sourceMode = text(row.source_mode)
      const mode = text(row.mode)
      const useSandboxCli = integer(row.use_sandbox_cli)
      const pluginContextJson = text(row.plugin_context_json)
      const expertSelection = text(row.last_user_prompt_expert_selection)
      return {
        userId: text(row.user_id) ?? DEFAULT_TEMPLATE.userId,
        isPlayground: integer(row.is_playground) ?? DEFAULT_TEMPLATE.isPlayground,
        transport: text(row.transport) ?? DEFAULT_TEMPLATE.transport,
        ...(model === undefined ? {} : { model }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(thoughtLevel === undefined ? {} : { thoughtLevel }),
        ...(sourceMode === undefined ? {} : { sourceMode }),
        ...(mode === undefined ? {} : { mode }),
        ...(useSandboxCli === undefined ? {} : { useSandboxCli }),
        ...(pluginContextJson === undefined ? {} : { pluginContextJson }),
        ...(expertSelection === undefined ? {} : { expertSelection }),
      }
    },
    sessionExists(id: string): boolean {
      try { return db.prepare('SELECT 1 AS present FROM sessions WHERE id = ?').get(id) !== undefined } catch { return false }
    },
    activity(id: string) {
      try {
        const row = db.prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
        if (row === undefined) return {}
        const updatedAt = integer(row.updated_at)
        const lastActivityAt = integer(row.last_activity_at)
        return {
          ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
          ...(lastActivityAt === undefined ? {} : { last_activity_at: lastActivityAt }),
        }
      } catch { return {} }
    },
    insertSession(row: SessionRow, template: SessionTemplate): void {
      const values: Record<string, unknown> = {
        id: row.id,
        cwd: sessionRowPath(row.cwd),
        user_id: template.userId,
        title: row.title ?? null,
        status: 'completed',
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        last_activity_at: row.lastActivityAt,
        is_playground: template.isPlayground,
        transport: template.transport,
        unread: 0,
      }
      const optional: Array<[string, unknown]> = [
        ['source_mode', template.sourceMode],
        ['mode', template.mode],
        ['model', template.model],
        ['permission_mode', template.permissionMode],
        ['use_sandbox_cli', template.useSandboxCli],
        ['thought_level', template.thoughtLevel],
        ['plugin_context_json', template.pluginContextJson],
        ['last_user_prompt_expert_selection', template.expertSelection],
      ]
      for (const [name, value] of optional) {
        // A deployment's schema may lag this list; only write known columns.
        if (value !== undefined && columns.has(name)) values[name] = value
      }
      const names = Object.keys(values)
      const sql = `INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
      db.prepare(sql).run(...names.map(name => values[name] as string | number | null))
    },
    updateActivity(id: string, updatedAt: number, lastActivityAt: number): void {
      db.prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?').run(updatedAt, lastActivityAt, id)
    },
    deleteSession(id: string): void {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    },
    workspaceExists(path: string): boolean {
      try { return db.prepare('SELECT 1 AS present FROM workspaces WHERE path = ?').get(path) !== undefined } catch { return false }
    },
    touchWorkspace(path: string, at: number): void {
      db.prepare('INSERT INTO workspaces (path, last_opened_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at').run(path, at)
    },
    deleteWorkspace(path: string): void {
      try { db.prepare('DELETE FROM workspaces WHERE path = ?').run(path) } catch { /* table may be absent */ }
    },
    close(): void {
      try { db.close() } catch { /* best effort */ }
    },
  }
}

/** Last bytes of a file, decoded; a leading partial line is dropped. */
function readTail(path: string, maxBytes: number): { content: string; size: number } {
  const size = statSync(path).size
  const length = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try { readSync(fd, buffer, 0, length, size - length) } finally { closeSync(fd) }
  let content = buffer.toString('utf8')
  if (length < size) {
    const newline = content.indexOf('\n')
    content = newline === -1 ? '' : content.slice(newline + 1)
  }
  return { content, size }
}

interface TailInfo {
  lastRowId?: string
  lastTimestamp?: number
  cwd?: string
  endsWithNewline: boolean
}

/** Only what an append needs: chain head, clock and the trailing newline state. */
function tailInfo(path: string): TailInfo {
  const { content } = readTail(path, 262_144)
  let lastRowId: string | undefined
  let lastTimestamp: number | undefined
  let cwd: string | undefined
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { continue }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const row = parsed as Record<string, unknown>
    if (typeof row.id === 'string') lastRowId = row.id
    if (typeof row.timestamp === 'number') lastTimestamp = lastTimestamp === undefined ? row.timestamp : Math.max(lastTimestamp, row.timestamp)
    if (cwd === undefined) cwd = text(row.cwd)
  }
  return {
    ...(lastRowId === undefined ? {} : { lastRowId }),
    ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
    ...(cwd === undefined ? {} : { cwd }),
    endsWithNewline: content.endsWith('\n'),
  }
}

function emptyJournal(): ExportJournal {
  return { version: 1, updatedAt: new Date().toISOString(), sessions: [], batches: [] }
}

function loadJournal(path: string): ExportJournal {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExportJournal>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      updatedAt: text(parsed.updatedAt) ?? new Date().toISOString(),
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      batches: Array.isArray(parsed.batches) ? parsed.batches : [],
    }
  } catch {
    return emptyJournal()
  }
}

/**
 * `session/title` is a plugin-merged event type rather than a core one, so it is
 * narrowed structurally here instead of through the event union.
 */
function titleEventOf(event: { type: string; data?: unknown }): string | undefined {
  if (event.type !== 'session/title') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  return text((data as Record<string, unknown>).title)
}

/** Title recorded on the session, falling back to its first human message. */
function titleOf(events: readonly SessionEvent[]): string | undefined {
  let title: string | undefined
  let firstUser: string | undefined
  for (const event of events) {
    const found = titleEventOf(event as unknown as { type: string; data?: unknown })
    if (found !== undefined) {
      title = found
      continue
    }
    if (event.type !== 'user/message' || firstUser !== undefined) continue
    const data = event.data as unknown as Record<string, unknown>
    const source = data.source as Record<string, unknown> | undefined
    if (source?.kind !== 'user') continue
    const blocks = Array.isArray(data.content) ? data.content : []
    const joined = blocks
      .map(block => (block !== null && typeof block === 'object' ? text((block as Record<string, unknown>).text) : undefined))
      .filter((value): value is string => value !== undefined)
      .join(' ')
      .trim()
    if (joined !== '') firstUser = joined.slice(0, 80)
  }
  const chosen = title ?? firstUser
  return chosen === undefined || chosen === '' ? undefined : chosen
}

/** Deterministic WorkBuddy id for a DSH session, stable across previews. */
function placeholderId(dshSessionId: string): string {
  return `pending:${createHash('sha1').update(dshSessionId).digest('hex').slice(0, 12)}`
}

export interface ExportServiceOptions {
  /** WorkBuddy data directory; defaults to `$WORKBUDDY_HOME` or `~/.workbuddy`. */
  root?: string
  /** DSH home; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Override for tests; defaults to scanning WorkBuddy's named pipes. */
  activity?: () => WorkBuddyActivity
  /** Override for tests; defaults to a real SQLite connection. */
  openDatabase?: (root: string) => ExportDatabase
}

/** Everything one session needs, computed without writing. */
interface Plan {
  summary: ExportSessionSummary
  header: SessionHeader
  entry?: ExportJournalEntry
  events: readonly SessionEvent[]
  createNew: boolean
  workbuddySessionId: string
  transcriptPath: string
  cwd: string
  title?: string
  /** Rows the next export would write; empty when nothing is pending. */
  rows: ReturnType<typeof buildWorkBuddyRows>['rows']
  lastEventSeq: number
  endsWithNewline: boolean
}

export class ExportService {
  readonly journalPath: string
  readonly backupDir: string
  readonly root: string
  private journal?: ExportJournal
  private cache: { at: number; plans: Plan[] } | undefined

  constructor(
    private readonly persistence: SessionPersistence,
    private readonly options: ExportServiceOptions = {},
  ) {
    const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    this.root = options.root ?? workBuddyRoot()
    this.journalPath = join(dshHome, 'migration', 'export.json')
    this.backupDir = join(dshHome, 'migration', 'export-backups')
  }

  private activity(): WorkBuddyActivity {
    return (this.options.activity ?? detectWorkBuddy)()
  }

  private state(): ExportJournal {
    this.journal ??= loadJournal(this.journalPath)
    return this.journal
  }

  private async persist(journal: ExportJournal): Promise<void> {
    journal.updatedAt = new Date().toISOString()
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 })
    const temp = `${this.journalPath}.${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 12)}.tmp`
    writeFileSync(temp, JSON.stringify(journal, null, 2), { encoding: 'utf8', mode: 0o600 })
    await replaceFile(temp, this.journalPath)
    this.journal = journal
  }

  /** Import manifest, used to append into the transcript a session came from. */
  private importMappings(): Map<string, { sourceSessionId: string; sourcePath: string }> {
    const path = join(dirname(this.journalPath), 'manifest.json')
    const result = new Map<string, { sourceSessionId: string; sourcePath: string }>()
    let parsed: { sessions?: unknown }
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: unknown }
    } catch { return result }
    if (!Array.isArray(parsed.sessions)) return result
    for (const item of parsed.sessions) {
      if (item === null || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (row.archived === true || row.supersededBy !== undefined) continue
      const target = text(row.targetSessionId)
      const source = text(row.sourceSessionId) ?? text(row.sourceKey)
      const sourcePath = text(row.sourcePath)
      if (target === undefined || source === undefined || sourcePath === undefined) continue
      if (!result.has(target)) result.set(target, { sourceSessionId: source, sourcePath })
    }
    return result
  }

  /** Resolve target, status and pending rows for one DSH session. */
  private plan(
    header: SessionHeader,
    events: readonly SessionEvent[],
    journal: ExportJournal,
    mappings: Map<string, { sourceSessionId: string; sourcePath: string }>,
  ): Plan {
    const dshSessionId = String(header.id)
    const entry = journal.sessions.find(item => item.dshSessionId === dshSessionId)
    const title = titleOf(events)
    const startSeq = entry !== undefined ? entry.lastSyncedEventSeq + 1 : seedWatermark(events)
    const window = exportWindow(events, startSeq)

    let workbuddySessionId = entry?.workbuddySessionId
    let transcriptPath = entry?.transcriptPath
    let cwd = entry?.cwd ?? text(header.cwd)
    let createNew = false
    let status: ExportSessionStatus = window.events.length === 0 ? 'empty' : 'new'
    let detail: string | undefined

    if (workbuddySessionId === undefined || transcriptPath === undefined) {
      const mapping = mappings.get(dshSessionId)
      if (mapping !== undefined) {
        workbuddySessionId = mapping.sourceSessionId
        transcriptPath = mapping.sourcePath
        status = window.events.length === 0 ? 'synced' : 'ahead'
      }
    }

    if (workbuddySessionId !== undefined && transcriptPath !== undefined) {
      if (!existsSync(transcriptPath)) {
        // The transcript is gone: WorkBuddy was cleaned up or the session was
        // deleted there. A new session is the only way to keep the DSH side.
        createNew = true
        status = window.events.length === 0 ? 'synced' : 'new'
        detail = 'WorkBuddy 中已找不到该会话文件，将新建一个会话'
      } else {
        const tail = tailInfo(transcriptPath)
        cwd ??= tail.cwd === undefined ? undefined : normalizeWorkBuddyPath(tail.cwd)
        // `lastRowId` is the row this plugin wrote last. If the file no longer
        // ends there, someone else appended after us.
        const movedInWorkBuddy = entry?.lastRowId !== undefined && tail.lastRowId !== entry.lastRowId
        if (movedInWorkBuddy && window.events.length === 0) {
          // Only WorkBuddy moved on: appending nothing would silently ignore the
          // newer WorkBuddy turn, so send the user to the import panel instead.
          status = 'workbuddy-ahead'
          detail = '该会话在此次导出后又在 WorkBuddy 中继续过，DSH 这边没有新内容；请用「导入数据」把新的部分带回来'
        } else if (movedInWorkBuddy) {
          // Both sides moved on: a new session keeps each history intact.
          createNew = true
          status = 'conflict'
          detail = '该会话在此次导出后又在 WorkBuddy 中继续过；为保留两边的记录，将新建一个 WorkBuddy 会话'
        } else if (window.events.length === 0) {
          status = 'synced'
        } else {
          status = 'ahead'
        }
      }
    }

    if (createNew) {
      workbuddySessionId = undefined
      transcriptPath = undefined
    }

    const resolvedCwd = cwd ?? text(header.cwd) ?? homedir()
    const buildOptions = createNew || workbuddySessionId === undefined
      ? {
          sessionId: workbuddySessionId ?? placeholderId(dshSessionId),
          cwd: resolvedCwd,
          ...(title === undefined ? {} : {}),
          bootstrap: { ...(title === undefined ? {} : { title }), createdAt: Number(header.createdAt) },
        }
      : {
          sessionId: workbuddySessionId,
          cwd: resolvedCwd,
          ...((): { chainFrom?: string; chainTime?: number } => {
            if (transcriptPath === undefined) return {}
            const tail = tailInfo(transcriptPath)
            return {
              ...(tail.lastRowId === undefined ? {} : { chainFrom: tail.lastRowId }),
              ...(tail.lastTimestamp === undefined ? {} : { chainTime: tail.lastTimestamp }),
            }
          })(),
        }

    const batch = window.events.length === 0
      ? undefined
      : buildWorkBuddyRows(window.events, buildOptions)

    const endsWithNewline = transcriptPath !== undefined && existsSync(transcriptPath)
      ? tailInfo(transcriptPath).endsWithNewline
      : false

    const summary: ExportSessionSummary = {
      id: dshSessionId,
      ...(title === undefined ? {} : { title }),
      createdAt: Number(header.createdAt),
      cwd: normalizeWorkBuddyPath(resolvedCwd),
      eventCount: events.length,
      startSeq,
      lastSyncedEventSeq: startSeq - 1,
      pendingEvents: batch?.exportedEvents ?? 0,
      pendingRows: batch?.rows.length ?? 0,
      status,
      workbuddySessionId: workbuddySessionId ?? '（将新建）',
      transcriptPath: transcriptPath ?? workBuddySessionPath(this.root, resolvedCwd, workbuddySessionId ?? placeholderId(dshSessionId)),
      ...(entry?.lastSyncedAt === undefined ? {} : { lastSyncedAt: entry.lastSyncedAt }),
      ...(detail === undefined ? {} : { detail }),
    }

    return {
      summary,
      header,
      ...(entry === undefined ? {} : { entry }),
      events,
      createNew: createNew || workbuddySessionId === undefined,
      workbuddySessionId: workbuddySessionId ?? '',
      transcriptPath: transcriptPath ?? '',
      cwd: resolvedCwd,
      ...(title === undefined ? {} : { title }),
      rows: batch?.rows ?? [],
      lastEventSeq: batch?.lastEventSeq ?? startSeq - 1,
      endsWithNewline,
    }
  }

  /** Read every exportable DSH session and report what a run would write. */
  async preview(options: { refresh?: boolean } = {}): Promise<ExportPreview> {
    const activity = this.activity()
    if (options.refresh !== true && this.cache !== undefined && Date.now() - this.cache.at < 15_000) {
      return this.view(this.cache.plans, activity)
    }
    const journal = this.state()
    const mappings = this.importMappings()
    const headers = (await this.persistence.list()).filter(header => header.parentSession === undefined)
    const plans: Plan[] = []
    for (const header of headers) {
      try {
        const inspection = await this.persistence.inspect(header.id)
        plans.push(this.plan(header, inspection.events, journal, mappings))
      } catch (cause) {
        plans.push({
          summary: {
            id: String(header.id),
            createdAt: Number(header.createdAt),
            eventCount: 0,
            startSeq: 0,
            lastSyncedEventSeq: -1,
            pendingEvents: 0,
            pendingRows: 0,
            status: 'failed',
            workbuddySessionId: '（不可用）',
            transcriptPath: '',
            detail: cause instanceof Error ? cause.message : String(cause),
          },
          header,
          events: [],
          createNew: false,
          workbuddySessionId: '',
          transcriptPath: '',
          cwd: text(header.cwd) ?? homedir(),
          rows: [],
          lastEventSeq: -1,
          endsWithNewline: true,
        })
      }
    }
    plans.sort((left, right) => right.summary.createdAt - left.summary.createdAt)
    this.cache = { at: Date.now(), plans }
    return this.view(plans, activity)
  }

  private view(plans: readonly Plan[], activity: WorkBuddyActivity): ExportPreview {
    const sessions = plans.map(item => item.summary)
    const count = (status: ExportSessionStatus): number => sessions.filter(item => item.status === status).length
    const stamps = this.state().sessions
      .map(item => item.lastSyncedAt)
      .filter((value): value is string => value !== undefined)
      .sort()
    const lastExportedAt = stamps.at(-1)
    return {
      exportFormatVersion: WORKBUDDY_EXPORT_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      workbuddyRoot: this.root,
      activity,
      sessions,
      summary: {
        total: sessions.length,
        new: count('new'),
        ahead: count('ahead'),
        synced: count('synced'),
        workbuddyAhead: count('workbuddy-ahead'),
        conflict: count('conflict'),
        empty: count('empty'),
        failed: count('failed'),
        pendingRows: sessions.reduce((total, item) => total + item.pendingRows, 0),
        ...(lastExportedAt === undefined ? {} : { lastExportedAt }),
        lastSyncedSessions: this.state().sessions.length,
      },
    }
  }

  /** Copy the catalog aside before the first mutation of a batch. */
  private backupCatalog(stamp: string): string | undefined {
    const source = join(this.root, 'workbuddy.db')
    if (!existsSync(source)) return undefined
    const target = join(this.backupDir, stamp)
    try {
      mkdirSync(target, { recursive: true, mode: 0o700 })
      for (const suffix of ['', '-wal', '-shm']) {
        const from = `${source}${suffix}`
        if (existsSync(from)) copyFileSync(from, join(target, `workbuddy.db${suffix}`))
      }
      return target
    } catch {
      return undefined
    }
  }

  /** Refuse to touch WorkBuddy unless the app is provably gone and confirmed. */
  private guard(action: string, exitConfirmed: boolean | undefined): WorkBuddyActivity {
    const activity = this.activity()
    if (activity.running) {
      throw new ExportBlockedError(
        `检测到 WorkBuddy 仍在运行。请先确认所有会话都已执行完毕，然后从托盘完全退出 WorkBuddy，再${action}。`,
        activity,
      )
    }
    if (!activity.observed) {
      throw new ExportBlockedError(`无法确认 WorkBuddy 是否已完全退出，已中止${action}。请退出 WorkBuddy 后重试。`, activity)
    }
    if (exitConfirmed !== true) {
      throw new ExportBlockedError(`请先确认 WorkBuddy 中所有会话都已执行完毕，并已完全退出 WorkBuddy，再${action}。`, activity)
    }
    return activity
  }

  /**
   * Append everything DSH holds that WorkBuddy does not.
   *
   * `mode: 'new-session'` forces a fresh WorkBuddy conversation, which is the
   * lossless option for a conflict: the WorkBuddy-side history stays where it
   * is and the DSH-side history continues in a session of its own.
   */
  async run(input: {
    sessionIds?: string[]
    mode?: 'auto' | 'new-session'
    exitConfirmed?: boolean
    refresh?: boolean
  }): Promise<ExportResult> {
    const activity = this.guard('导出', input.exitConfirmed)
    const journal = this.state()
    const wanted = input.sessionIds === undefined ? undefined : new Set(input.sessionIds)
    if (wanted !== undefined && wanted.size === 0) throw new Error('未选择任何会话')

    await this.preview(input.refresh === true ? { refresh: true } : {})
    const plans = this.cache?.plans ?? []
    const batch: ExportBatchRecord = {
      id: `export-${Date.now().toString(36)}-${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 6)}`,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitConfirmed: true,
      activity: activity.evidence,
      sessions: [],
    }
    const result: ExportResult = {
      exportFormatVersion: WORKBUDDY_EXPORT_FORMAT_VERSION,
      finishedAt: '',
      exportedSessions: 0,
      skippedSessions: 0,
      createdSessions: 0,
      appendedSessions: 0,
      rows: 0,
      sessions: [],
      errors: [],
      pendingImport: [],
    }

    let database: ExportDatabase | undefined
    try {
      for (const plan of plans) {
        const dshSessionId = plan.summary.id
        if (wanted !== undefined && !wanted.has(dshSessionId)) continue
        if (plan.summary.status === 'failed') {
          result.skippedSessions += 1
          continue
        }
        const forceNew = input.mode === 'new-session' && plan.summary.status !== 'synced' && plan.summary.status !== 'empty'
        if (!forceNew && (plan.summary.status === 'synced' || plan.summary.status === 'empty' || plan.summary.status === 'new' && plan.summary.pendingRows === 0)) {
          result.skippedSessions += 1
          continue
        }
        // WorkBuddy is ahead and DSH has nothing new: this direction cannot
        // help, so leave the transcript untouched instead of forking it.
        if (!forceNew && plan.summary.status === 'workbuddy-ahead') {
          result.skippedSessions += 1
          result.pendingImport.push({ sessionId: dshSessionId, ...(plan.title === undefined ? {} : { title: plan.title }) })
          continue
        }

        const createNew = forceNew || plan.createNew
        const workbuddySessionId = createNew ? randomWorkBuddyId() : plan.workbuddySessionId
        const transcriptPath = createNew
          ? workBuddySessionPath(this.root, plan.cwd, workbuddySessionId)
          : plan.transcriptPath
        const existed = !createNew && existsSync(transcriptPath)
        const bytesBefore = existed ? statSync(transcriptPath).size : 0

        const buildOptions = createNew || !existed
          ? {
              sessionId: workbuddySessionId,
              cwd: plan.cwd,
              bootstrap: { ...(plan.title === undefined ? {} : { title: plan.title }), createdAt: plan.summary.createdAt },
            }
          : ((): { sessionId: string; cwd: string; chainFrom?: string; chainTime?: number } => {
              const tail = tailInfo(transcriptPath)
              return {
                sessionId: workbuddySessionId,
                cwd: plan.cwd,
                ...(tail.lastRowId === undefined ? {} : { chainFrom: tail.lastRowId }),
                ...(tail.lastTimestamp === undefined ? {} : { chainTime: tail.lastTimestamp }),
              }
            })()

        const window = exportWindow(plan.events, plan.summary.startSeq)
        if (window.events.length === 0) {
          result.skippedSessions += 1
          continue
        }
        const built = buildWorkBuddyRows(window.events, buildOptions)
        if (built.rows.length === 0) {
          result.skippedSessions += 1
          continue
        }
        const lastRowId = String(built.rows.at(-1)?.id ?? '')
        const needsNewline = existed && bytesBefore > 0 && !tailInfo(transcriptPath).endsWithNewline
        const payload = serializeRows(built.rows, needsNewline)

        const prior: PriorEntry = plan.entry === undefined
          ? { existed: false }
          : {
              existed: true,
              lastSyncedEventSeq: plan.entry.lastSyncedEventSeq,
              ...(plan.entry.lastSyncedAt === undefined ? {} : { lastSyncedAt: plan.entry.lastSyncedAt }),
              ...(plan.entry.lastRowId === undefined ? {} : { lastRowId: plan.entry.lastRowId }),
              ...(plan.entry.rowsExported === undefined ? {} : { rowsExported: plan.entry.rowsExported }),
              created: plan.entry.created,
            }

        const dbEffect: DbEffect = { sessionInserted: false, workspaceInserted: false, workspacePath: catalogPath(plan.cwd) }

        try {
          mkdirSync(dirname(transcriptPath), { recursive: true })
          appendFileSync(transcriptPath, payload, 'utf8')

          // The catalog row is what makes the transcript show up in WorkBuddy's
          // sidebar; a file on its own stays invisible.
          database ??= (this.options.openDatabase ?? openExportDatabase)(this.root)
          if (createNew) {
            batch.dbBackup ??= this.backupCatalog(`${batch.id}-${String(Date.now())}`) ?? '（备份失败）'
          }
          const now = Date.now()
          if (database.sessionExists(workbuddySessionId)) {
            const before = database.activity(workbuddySessionId)
            if (before.updated_at !== undefined) dbEffect.previousUpdatedAt = before.updated_at
            if (before.last_activity_at !== undefined) dbEffect.previousLastActivityAt = before.last_activity_at
            database.updateActivity(workbuddySessionId, now, now)
          } else if (createNew) {
            database.insertSession(
              {
                id: workbuddySessionId,
                cwd: plan.cwd,
                ...(plan.title === undefined ? {} : { title: plan.title }),
                createdAt: plan.summary.createdAt,
                updatedAt: now,
                lastActivityAt: now,
              },
              database.template(),
            )
            dbEffect.sessionInserted = true
          }
          if (createNew) {
            const workspacePath = catalogPath(plan.cwd)
            dbEffect.workspacePath = workspacePath
            dbEffect.workspaceInserted = !database.workspaceExists(workspacePath)
            database.touchWorkspace(workspacePath, now)
          }
        } catch (cause) {
          // Roll the transcript back to its pre-append length so a retry starts
          // from a clean file instead of duplicating rows.
          try {
            if (!existed) unlinkSync(transcriptPath)
            else truncateSync(transcriptPath, bytesBefore)
          } catch { /* the journal still records the batch for an explicit undo */ }
          result.errors.push({ sessionId: dshSessionId, message: cause instanceof Error ? cause.message : String(cause) })
          result.skippedSessions += 1
          continue
        }

        const nextEntry: ExportJournalEntry = {
          dshSessionId,
          workbuddySessionId,
          transcriptPath,
          cwd: normalizeWorkBuddyPath(plan.cwd),
          ...(plan.title === undefined ? {} : { title: plan.title }),
          lastSyncedEventSeq: built.lastEventSeq,
          lastSyncedAt: new Date().toISOString(),
          lastRowId,
          rowsExported: (prior.rowsExported ?? 0) + built.rows.length,
          created: prior.created ?? !existed,
        }
        const at = journal.sessions.findIndex(item => item.dshSessionId === dshSessionId)
        if (at === -1) journal.sessions.push(nextEntry)
        else journal.sessions[at] = nextEntry
        batch.sessions.push({
          dshSessionId,
          workbuddySessionId,
          transcriptPath,
          bytesBefore,
          createdFile: !existed,
          rows: built.rows.length,
          lastEventSeq: built.lastEventSeq,
          lastRowId,
          db: dbEffect,
          prior,
        })
        await this.persist(journal)

        result.exportedSessions += 1
        result.rows += built.rows.length
        if (createNew) result.createdSessions += 1
        else result.appendedSessions += 1
        result.sessions.push({
          sessionId: dshSessionId,
          workbuddySessionId,
          transcriptPath,
          rows: built.rows.length,
          lastEventSeq: built.lastEventSeq,
          created: createNew,
        })
      }
      batch.status = 'completed'
    } catch (cause) {
      batch.status = 'failed'
      batch.error = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      database?.close()
      batch.finishedAt = new Date().toISOString()
      journal.batches.unshift(batch)
      await this.persist(journal)
      this.cache = undefined
    }
    result.finishedAt = batch.finishedAt ?? new Date().toISOString()
    return result
  }

  /**
   * Undo one export: truncate every touched transcript back to its pre-append
   * length, delete the files this plugin created, restore the catalog rows and
   * rewind the watermarks.
   */
  async undo(batchId?: string): Promise<{ undone: boolean; batchId?: string; files: number; sessions: number }> {
    this.guard('撤销导出', true)
    const journal = this.state()
    const batch = batchId === undefined
      ? journal.batches.find(item => item.status === 'completed')
      : journal.batches.find(item => item.id === batchId)
    if (batch === undefined || batch.status === 'undone') {
      return { undone: false, ...(batch === undefined ? {} : { batchId: batch.id }), files: 0, sessions: 0 }
    }

    let files = 0
    let database: ExportDatabase | undefined
    for (const item of batch.sessions) {
      try {
        if (item.createdFile) {
          if (existsSync(item.transcriptPath)) { unlinkSync(item.transcriptPath); files += 1 }
        } else if (existsSync(item.transcriptPath)) {
          truncateSync(item.transcriptPath, item.bytesBefore)
          files += 1
        }
      } catch { /* the journal keeps the intent for a retry */ }

      const needsDatabase = item.db.sessionInserted
        || item.db.workspaceInserted
        || item.db.previousUpdatedAt !== undefined
        || item.db.previousLastActivityAt !== undefined
      if (needsDatabase) {
        try {
          database ??= (this.options.openDatabase ?? openExportDatabase)(this.root)
          if (item.db.sessionInserted) database.deleteSession(item.workbuddySessionId)
          else if (item.db.previousUpdatedAt !== undefined || item.db.previousLastActivityAt !== undefined) {
            const fallback = Date.now()
            database.updateActivity(
              item.workbuddySessionId,
              item.db.previousUpdatedAt ?? item.db.previousLastActivityAt ?? fallback,
              item.db.previousLastActivityAt ?? item.db.previousUpdatedAt ?? fallback,
            )
          }
          if (item.db.workspaceInserted && item.db.workspacePath !== undefined) database.deleteWorkspace(item.db.workspacePath)
        } catch { /* leave the row for a later retry */ }
      }

      const at = journal.sessions.findIndex(candidate => candidate.dshSessionId === item.dshSessionId)
      if (at === -1) continue
      if (!item.prior.existed) journal.sessions.splice(at, 1)
      else {
        const previous = journal.sessions[at]!
        previous.lastSyncedEventSeq = item.prior.lastSyncedEventSeq ?? previous.lastSyncedEventSeq
        if (item.prior.lastSyncedAt === undefined) delete previous.lastSyncedAt
        else previous.lastSyncedAt = item.prior.lastSyncedAt
        if (item.prior.lastRowId === undefined) delete previous.lastRowId
        else previous.lastRowId = item.prior.lastRowId
        if (item.prior.rowsExported === undefined) delete previous.rowsExported
        else previous.rowsExported = item.prior.rowsExported
        previous.created = item.prior.created ?? previous.created
      }
    }
    database?.close()
    batch.status = 'undone'
    await this.persist(journal)
    this.cache = undefined
    return { undone: true, batchId: batch.id, files, sessions: batch.sessions.length }
  }

  /** Batches newest-first, for the export panel's history list. */
  history(): Array<{ id: string; startedAt: string; finishedAt?: string; status: string; sessions: number; rows: number }> {
    return this.state().batches.map(item => ({
      id: item.id,
      startedAt: item.startedAt,
      ...(item.finishedAt === undefined ? {} : { finishedAt: item.finishedAt }),
      status: item.status,
      sessions: item.sessions.length,
      rows: item.sessions.reduce((total, session) => total + session.rows, 0),
    }))
  }
}

/** Raised when exporting would write into a live WorkBuddy installation. */
export class ExportBlockedError extends Error {
  constructor(message: string, readonly activity: WorkBuddyActivity) {
    super(message)
    this.name = 'ExportBlockedError'
  }
}

let idCounter = 0

/** A fresh RFC 9562 v7 identifier in WorkBuddy's own id shape. */
function randomWorkBuddyId(): string {
  idCounter = (idCounter + 1) % 0x1000
  const now = Date.now()
  const buffer = Buffer.alloc(16)
  buffer.writeUIntBE(Math.floor(now / 2 ** 16), 0, 6)
  buffer.writeUIntBE(now % 2 ** 16, 4, 2)
  createHash('sha256').update(`${String(now)}-${String(idCounter)}-${String(Math.random())}`).digest().copy(buffer, 6, 0, 10)
  buffer[6] = (buffer[6]! & 0x0f) | 0x70
  buffer[8] = (buffer[8]! & 0x3f) | 0x80
  const hex = buffer.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
