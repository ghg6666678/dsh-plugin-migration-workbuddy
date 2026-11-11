import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export type WorkBuddyMode = 'workspace' | 'session' | 'unknown'

export interface WorkBuddySessionMetadata {
  sourceSessionId: string
  mode: WorkBuddyMode
  cwd?: string
  title?: string
}

/**
 * WorkBuddy's own view of the catalog. Migration must respect the source app's
 * deletions: a session the user deleted in WorkBuddy (and a workspace whose
 * directory is gone) must not be resurrected just because its files still sit
 * on disk.
 */
export interface WorkBuddyCatalog {
  /** Live sessions by id (rows with `deleted_at` set are excluded). */
  sessions: Map<string, WorkBuddySessionMetadata>
  /** Session ids WorkBuddy marks deleted; their transcripts are skipped. */
  deletedSessionIds: ReadonlySet<string>
  /** Workspace paths WorkBuddy still lists in its own `workspaces` table. */
  liveWorkspacePaths: ReadonlySet<string>
  /** False when the database is missing or unreadable (degraded fallback). */
  available: boolean
  /**
   * Why the catalog is unavailable. `unreadable` means the database file is
   * there but could not be read — deletion state is unknown and callers must
   * not import transcripts, or they would resurrect deleted sessions.
   */
  unavailableReason?: 'missing' | 'unreadable'
}

type Row = {
  id?: unknown
  cwd?: unknown
  title?: unknown
  custom_title?: unknown
  is_playground?: unknown
  deleted_at?: unknown
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/** Whether a `deleted_at` column value marks the row as deleted. */
function isDeleted(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') return value.trim() !== '' && value.trim() !== '0'
  return true
}

function emptyCatalog(unavailableReason: 'missing' | 'unreadable'): WorkBuddyCatalog {
  return { sessions: new Map(), deletedSessionIds: new Set(), liveWorkspacePaths: new Set(), available: false, unavailableReason }
}

/**
 * Open the database read-only, copying it aside when a running WorkBuddy keeps
 * an exclusive lock. The copy also covers WAL databases whose `-shm` cannot be
 * opened read-only; deletion state must stay readable rather than silently
 * degrade to "nothing is deleted".
 */
function openCatalog(path: string): { db: DatabaseSync; dispose?: () => void } | undefined {
  try {
    return { db: new DatabaseSync(path, { readOnly: true }) }
  } catch { /* try the copy fallback below */ }
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-wb-catalog-'))
    const name = basename(path)
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(dirname(path), `${name}${suffix}`)
      if (existsSync(source)) copyFileSync(source, join(dir, `${name}${suffix}`))
    }
    const db = new DatabaseSync(join(dir, name), { readOnly: true })
    return { db, dispose: () => { try { rmSync(dir!, { recursive: true, force: true }) } catch { /* best effort */ } } }
  } catch {
    if (dir !== undefined) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
    return undefined
  }
}

/** Columns this reader depends on; missing ones degrade to the fallback path. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const columns = new Set<string>()
  try {
    for (const row of db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>) {
      const name = text(row.name)
      if (name !== undefined) columns.add(name)
    }
  } catch { /* treat as unknown */ }
  return columns
}

/**
 * Read the local WorkBuddy catalog without making it a hard dependency of
 * migration. A missing database or schema change returns `available: false`
 * and the caller falls back to filesystem-only scanning.
 */
export function readWorkBuddyCatalog(root: string): WorkBuddyCatalog {
  const path = join(root, 'workbuddy.db')
  if (!existsSync(path)) return emptyCatalog('missing')
  const opened = openCatalog(path)
  if (opened === undefined) return emptyCatalog('unreadable')
  const { db, dispose } = opened
  try {
    const sessions = new Map<string, WorkBuddySessionMetadata>()
    const deletedSessionIds = new Set<string>()
    const columns = tableColumns(db, 'sessions')
    const rows = db.prepare(`SELECT id, cwd, title, custom_title, is_playground${columns.has('deleted_at') ? ', deleted_at' : ''} FROM sessions`).all() as Row[]
    for (const row of rows) {
      const id = text(row.id)
      if (!id) continue
      if (isDeleted(row.deleted_at)) {
        deletedSessionIds.add(id)
        continue
      }
      const cwd = text(row.cwd)
      const title = text(row.custom_title) ?? text(row.title)
      const mode: WorkBuddyMode = row.is_playground === 1 || row.is_playground === true
        ? 'session'
        : row.is_playground === 0 || row.is_playground === false ? 'workspace' : 'unknown'
      sessions.set(id, { sourceSessionId: id, mode, ...(cwd ? { cwd } : {}), ...(title ? { title } : {}) })
    }
    const liveWorkspacePaths = new Set<string>()
    try {
      for (const row of db.prepare('SELECT path FROM workspaces').all() as Array<{ path?: unknown }>) {
        const value = text(row.path)
        if (value !== undefined) liveWorkspacePaths.add(value)
      }
    } catch { /* older database without the table: leave the set empty */ }
    return { sessions, deletedSessionIds, liveWorkspacePaths, available: true }
  } catch {
    return emptyCatalog('unreadable')
  } finally {
    try { db.close() } catch { /* best effort */ }
    dispose?.()
  }
}

/** Live session metadata only (compatibility wrapper around the catalog read). */
export function readWorkBuddySessionMetadata(root: string): Map<string, WorkBuddySessionMetadata> {
  return readWorkBuddyCatalog(root).sessions
}
