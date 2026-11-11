import { createReadStream } from 'node:fs'
import { lstat, opendir, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  JsonlFileReport,
  LegacyDatabaseReport,
  MemoryCandidate,
  ProbeOptions,
  ProbeReport,
  ProbeWarning,
} from './model.js'
import { PROBE_FORMAT_VERSION } from './model.js'

/** 0 = no per-file cap; transcripts are streamed, not buffered whole. */
export const DEFAULT_MAX_FILE_BYTES = 0
const LARGE_FILE_WARNING_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_FILES = 5_000
const KNOWN_EVENTS = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_result',
  'file-history-snapshot',
  // Metadata events observed in the local corpus; P1 decides whether to
  // materialize them as DSH title/summary events or keep them as notices.
  'ai-title',
  'custom-title',
  'summary',
  // Bookkeeping records emitted by newer WorkBuddy desktop builds. The
  // converter has nothing to import from them, but they are expected input
  // and must not flood the audit with "unknown event" warnings.
  'session-meta',
  'resend-fork-notice',
  'credit-usage',
])

export function defaultWorkBuddyRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy'))
}

export function displayPath(path: string, home = homedir()): string {
  // Pick the API from the path's own style. A WorkBuddy source keeps the
  // separator convention of the machine that recorded it, so a POSIX path must
  // never be resolved with win32 (which would mangle `/Users/x/...` into a
  // drive-relative path) — including when the preview itself runs on Windows
  // and the host home is `C:\Users\x`.
  const api = path.includes('\\') ? win32 : posix
  const normalizedPath = api.resolve(path)
  const normalizedHome = api.resolve(home)
  const suffix = api.relative(normalizedHome, normalizedPath)
  if (suffix === '') return '~'
  // `relative` returns the absolute target when the roots differ (e.g. `\…`
  // versus `C:…`), so an absolute suffix means "not inside home".
  const insideHome = !api.isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${api.sep}`)
  if (insideHome) return `~${api.sep}${suffix}`
  // The home uses the other separator convention (POSIX source on Windows, or
  // the reverse). The user's directory name still identifies it, so render the
  // familiar `~/...` form instead of a mangled absolute path. Only a whole path
  // segment counts: `/data/alice-notes` is not the home of user `alice`.
  const homeApi = home.includes('\\') ? win32 : posix
  const homeName = homeApi.basename(home)
  const marker = `${api.sep}${homeName}`
  let index = homeName.length === 0 ? -1 : normalizedPath.lastIndexOf(marker)
  while (index >= 0) {
    const after = normalizedPath.slice(index + marker.length)
    if (after === '' || after.startsWith(api.sep)) break
    index = normalizedPath.lastIndexOf(marker, index - 1)
  }
  if (index < 0) return normalizedPath
  const remainder = normalizedPath.slice(index + marker.length)
  return remainder === '' ? '~' : `~${remainder}`
}

function eventKind(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'unknown'
  const record = value as Record<string, unknown>
  const candidate = record.type ?? record.event ?? record.kind
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'unknown'
}

function schemaVersion(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>).version
  return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : undefined
}

async function walkFiles(root: string, extension: string, warnings: ProbeWarning[], maxFiles: number): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    if (found.length >= maxFiles) return
    let handle
    try {
      handle = await opendir(directory)
    } catch (cause) {
      warnings.push({ code: 'read-failed', path: directory, detail: cause instanceof Error ? cause.message : String(cause) })
      return
    }
    for await (const entry of handle) {
      if (found.length >= maxFiles) break
      const child = join(directory, entry.name)
      let info
      try {
        info = await lstat(child)
      } catch (cause) {
        warnings.push({ code: 'read-failed', path: child, detail: cause instanceof Error ? cause.message : String(cause) })
        continue
      }
      if (info.isSymbolicLink()) {
        warnings.push({ code: 'symlink-skipped', path: child, detail: 'symbolic links are excluded from migration scans' })
      } else if (info.isDirectory()) {
        await visit(child)
      } else if (info.isFile() && child.endsWith(extension)) {
        found.push(child)
      }
    }
  }
  await visit(root)
  if (found.length >= maxFiles) warnings.push({ code: 'file-limit', path: root, detail: `scan stopped at ${String(maxFiles)} files` })
  return found
}

async function inspectJsonl(path: string, root: string, warnings: ProbeWarning[], maxFileBytes: number): Promise<JsonlFileReport | undefined> {
  let bytes: number
  try {
    bytes = (await stat(path)).size
  } catch (cause) {
    warnings.push({ code: 'read-failed', path, detail: cause instanceof Error ? cause.message : String(cause) })
    return undefined
  }
  if (maxFileBytes > 0 && bytes > maxFileBytes) {
    warnings.push({ code: 'file-too-large', path, detail: `${String(bytes)} bytes exceeds ${String(maxFileBytes)}-byte limit` })
    return undefined
  }
  if (bytes > LARGE_FILE_WARNING_BYTES) {
    warnings.push({ code: 'large-file', path, detail: `${String(bytes)} bytes; converting a very large transcript may take a while` })
  }
  const relativePath = relative(join(root, 'projects'), path)
  const parts = relativePath.split(sep)
  const projectHash = parts[0] ?? 'unknown'
  const sessionId = basename(path, '.jsonl')
  const eventCounts: Record<string, number> = {}
  const versions = new Set<string>()
  let lines = 0
  let validLines = 0
  let invalidLines = 0
  const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of input) {
    lines += 1
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      validLines += 1
      const kind = eventKind(parsed)
      eventCounts[kind] = (eventCounts[kind] ?? 0) + 1
      if (!KNOWN_EVENTS.has(kind)) warnings.push({ code: 'unknown-event', path, detail: `unknown event kind ${kind}` })
      const version = schemaVersion(parsed)
      if (version !== undefined) versions.add(version)
    } catch (cause) {
      invalidLines += 1
      warnings.push({ code: 'invalid-json', path, detail: `line ${String(lines)}: ${cause instanceof Error ? cause.message : String(cause)}` })
    }
  }
  return { path, projectHash, sessionId, bytes, lines, validLines, invalidLines, eventCounts, schemaVersions: [...versions].sort() }
}

async function inspectMemory(root: string, warnings: ProbeWarning[], maxFiles: number): Promise<{ paths: string[]; candidates: MemoryCandidate[] }> {
  const memoryRoots = [join(root, 'memory'), join(root, 'app', 'memory'), join(root, 'memery')]
  const paths: string[] = []
  const files: string[] = []
  for (const memoryRoot of memoryRoots) {
    try {
      const info = await lstat(memoryRoot)
      if (info.isSymbolicLink()) {
        warnings.push({ code: 'symlink-skipped', path: memoryRoot, detail: 'symbolic links are excluded from migration scans' })
      } else if (info.isDirectory()) {
        paths.push(memoryRoot)
        files.push(...await walkFiles(memoryRoot, '', warnings, Math.max(0, maxFiles - files.length)))
      }
    } catch {
      // Missing candidate directories are expected for older WorkBuddy versions.
    }
    if (files.length >= maxFiles) break
  }
  // The curated memory the user actually sees lives at the root as MEMORY.md.
  // The `memory/` directory only holds the per-account profile scaffolding, so
  // scanning directories alone reported "4 memories" that were JSON braces
  // while the real notes were never read. USER.md / IDENTITY.md / SOUL.md /
  // BOOTSTRAP.md are persona templates, not notes, so they stay out.
  for (const name of ['MEMORY.md']) {
    const path = join(root, name)
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) continue
      files.push(path)
    } catch {
      // An absent root MEMORY.md is expected; nothing to scan.
    }
  }
  const candidates: MemoryCandidate[] = []
  for (const path of files) {
    try {
      const info = await stat(path)
      const extension = path.toLowerCase().split('.').pop()
      const kind = extension === 'md' || extension === 'markdown' ? 'markdown' : extension === 'json' ? 'json' : extension === 'jsonl' ? 'jsonl' : 'unknown'
      if (kind !== 'unknown' || basename(path).toLowerCase().includes('memory')) candidates.push({ path, bytes: info.size, kind })
    } catch (cause) {
      warnings.push({ code: 'read-failed', path, detail: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return { paths, candidates }
}

async function inspectLegacyDatabase(root: string, warnings: ProbeWarning[]): Promise<LegacyDatabaseReport | undefined> {
  const path = join(root, 'workbuddy.db')
  try {
    const info = await stat(path)
    const handle = await open(path, 'r')
    const headerBuffer = Buffer.alloc(16)
    try {
      await handle.read(headerBuffer, 0, headerBuffer.length, 0)
    } finally {
      await handle.close()
    }
    const header = headerBuffer.toString('utf8') === 'SQLite format 3\u0000'
    warnings.push({ code: 'sqlite-header-only', path, detail: 'P0 checks the SQLite header only; schema import is deferred' })
    return { path, bytes: info.size, sqliteHeader: header, schemaInspected: false }
  } catch {
    return undefined
  }
}

export async function probeWorkBuddy(options: ProbeOptions = {}): Promise<ProbeReport> {
  const root = resolve(options.root ?? defaultWorkBuddyRoot())
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const warnings: ProbeWarning[] = []
  try {
    const info = await lstat(root)
    if (info.isSymbolicLink()) throw new Error('root must not be a symbolic link')
    if (!info.isDirectory()) throw new Error('root is not a directory')
  } catch (cause) {
    warnings.push({ code: 'missing-root', path: root, detail: cause instanceof Error ? cause.message : String(cause) })
    return { probeFormatVersion: PROBE_FORMAT_VERSION, sourceRoot: root, scannedAt: new Date().toISOString(), projectsPath: join(root, 'projects'), memoryPath: join(root, 'memory'), memoryPaths: [], sessions: [], memoryCandidates: [], warnings }
  }
  const projectRoot = join(root, 'projects')
  const jsonlFiles = await walkFiles(projectRoot, '.jsonl', warnings, maxFiles)
  const sessions: JsonlFileReport[] = []
  for (const path of jsonlFiles) {
    const report = await inspectJsonl(path, root, warnings, maxFileBytes)
    if (report !== undefined) sessions.push(report)
  }
  const memory = await inspectMemory(root, warnings, maxFiles)
  const legacyDatabase = await inspectLegacyDatabase(root, warnings)
  return { probeFormatVersion: PROBE_FORMAT_VERSION, sourceRoot: root, scannedAt: new Date().toISOString(), projectsPath: projectRoot, memoryPath: join(root, 'memory'), memoryPaths: memory.paths, sessions, memoryCandidates: memory.candidates, ...(legacyDatabase === undefined ? {} : { legacyDatabase }), warnings }
}

export function summarizeProbe(report: ProbeReport): { projectCount: number; sessionCount: number; memoryCount: number; warningCount: number } {
  return {
    projectCount: new Set(report.sessions.map(session => session.projectHash)).size,
    sessionCount: report.sessions.length,
    memoryCount: report.memoryCandidates.length,
    warningCount: report.warnings.length,
  }
}
