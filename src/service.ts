import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { convertWorkBuddySession, MIGRATION_CONVERTER_VERSION } from './converter.js'
import type {
  McpDraft, MemoryRecord, MigrationPreview, MigrationResult, MigrationSelection, ProbeReport, WorkspaceSummary,
} from './model.js'
import { MIGRATION_FORMAT_VERSION } from './model.js'
import { parseMemoryCandidate, toMemoryRecords } from './memory.js'
import { sanitizeMcpConfig } from './mcp.js'
import { readWorkBuddyAutomations, resolveAutomationModel, toAutomationDraft, type AutomationDraft, type AutomationModelPolicy } from './automation.js'
import { defaultWorkBuddyRoot, displayPath, probeWorkBuddy } from './probe.js'
import { readWorkBuddyCatalog, readWorkBuddySessionMetadata, type WorkBuddySessionMetadata, type WorkBuddyMode } from './workbuddy-db.js'
import { replaceFile } from './atomic-file.js'

interface WorkspaceLike {
  resolveByPath(path: string): Promise<{ id: string; attachSession?(id: string): Promise<void> } | undefined>
  create(path: string, title?: string): Promise<{ id: string; attachSession?(id: string): Promise<void> }>
}

/** dsh >= 0.2 returns an owned write handle from sessionPersistence.create(). */
interface SessionWriteHandle {
  append(events: SessionEvent[]): Promise<unknown>
  flush?(): Promise<unknown> | unknown
  close?(): Promise<unknown> | unknown
}

/**
 * Persist a seeded session across both persistence generations.
 *
 * dsh 0.1.x exposes persistence.append(id, events) and takes the seed offset as
 * create()'s second argument. dsh 0.2.x removed that method: create() returns
 * an owned write handle, events go through handle.append(), and the seed prefix
 * is declared with options.inheritedEventCount. Closing the handle completes
 * durability and releases write ownership, which the sidebar needs to list it.
 */
export async function writeSeededSession(
  persistence: SessionPersistence,
  header: SessionHeader,
  events: SessionEvent[],
  id: SessionId,
): Promise<void> {
  const api = persistence as unknown as {
    create(header: SessionHeader, options?: unknown): Promise<unknown>
    append?(id: SessionId, events: SessionEvent[]): Promise<unknown>
  }
  if (typeof api.append === 'function') {
    await api.create(header, SessionLogOffset(events.length))
    await api.append(id, events)
    return
  }
  const handle = await api.create(header, { inheritedEventCount: events.length }) as SessionWriteHandle | undefined
  if (handle === undefined || handle === null || typeof handle.append !== 'function') {
    throw new Error('unsupported sessionPersistence API: create() returned no write handle and append() is unavailable')
  }
  try {
    await handle.append(events)
    await handle.flush?.()
  } finally {
    // A failed append (e.g. a format rejection) must still release the write
    // lease. Otherwise the created id stays pending in the process and every
    // later attempt fails with "session already exists".
    await handle.close?.()
  }
}

interface Manifest {
  version: number
  updatedAt: string
  sessions: Array<{ sourceHash: string; sourcePath: string; sourceSessionId?: string; sourceKey?: string; metadataHash?: string; targetSessionId: string; importId?: string; title?: string; mode?: WorkBuddyMode; workspacePath?: string; lastImportedAt?: string; status?: 'imported' | 'changed' | 'archived' | 'failed' | 'missing'; supersededBy?: string; archived?: boolean; converterVersion?: number; toolMode?: 'transcript' | 'narrative' }>
  memories: MemoryRecord[]
  mcp: McpDraft[]
  automations: Array<{ sourceId: string; fingerprint: string; targetRuleId: string; importedAt: string; status?: string }>
  imports: Array<string | MigrationBatch>
}

interface MigrationBatch {
  id: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed'
  selection: MigrationSelection
  importedSessions: number
  skippedSessions: number
  importedMemories: number
  importedMcp: number
  errors: number
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  await replaceFile(temp, path)
}

function targetRoot(): string { return process.env.DSH_HOME ?? join(homedir(), '.dsh') }

function sessionModeWorkspacePath(): string { return join(targetRoot(), 'workspaces', 'session-mode') }

function metadataHash(metadata: WorkBuddySessionMetadata | undefined): string {
  return createHash('sha256').update(JSON.stringify(metadata ? { sourceSessionId: metadata.sourceSessionId, mode: metadata.mode, cwd: metadata.cwd ?? null, title: metadata.title ?? null } : null)).digest('hex')
}

/** Stable, non-sensitive workspace identifier derived from the raw path. */
function workspaceIdOf(workspacePath: string | undefined): string | undefined {
  if (workspacePath === undefined) return undefined
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 16)
}

const SESSION_FILTER_LIMIT = 50_000

/** Validate an optional session-filter array; throws a readable error on misuse. */
export function sanitizeSessionFilter(values: unknown, name: string): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new Error(`invalid selection: ${name} must be an array of strings`)
  if (values.length > SESSION_FILTER_LIMIT) throw new Error(`invalid selection: ${name} exceeds ${String(SESSION_FILTER_LIMIT)} items`)
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`invalid selection: ${name} contains invalid entries`)
  }
  return values as string[]
}

function sourceKey(item: { sessionId: string; path: string }, metadata: WorkBuddySessionMetadata | undefined, sourceRoot: string): string {
  if (metadata?.sourceSessionId) return metadata.sourceSessionId
  const prefix = `${join(sourceRoot, 'projects')}/`
  return item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path
}

function metadataFor(path: string, sourceRoot: string, catalog: Map<string, WorkBuddySessionMetadata>): WorkBuddySessionMetadata | undefined {
  const direct = catalog.get(basename(path, '.jsonl'))
  if (direct) return direct
  // Agent JSONL files are nested below <parent-session>/subagents and do not
  // have rows of their own in WorkBuddy's sessions table. Inherit the parent
  // mode/cwd/title context when the parent row is available.
  const marker = `${join(sourceRoot, 'projects')}/`
  const relativePath = path.startsWith(marker) ? path.slice(marker.length).split('/') : []
  const subagents = relativePath.indexOf('subagents')
  if (subagents > 0) {
    const parent = catalog.get(relativePath[subagents - 1]!)
    if (parent) return { sourceSessionId: basename(path, '.jsonl'), mode: parent.mode, ...(parent.cwd ? { cwd: parent.cwd } : {}) }
  }
  return undefined
}

function effectiveMetadata(path: string, sourceRoot: string, catalog: Map<string, WorkBuddySessionMetadata>): WorkBuddySessionMetadata | undefined {
  const found = metadataFor(path, sourceRoot, catalog)
  if (!found) return undefined
  if (found.mode !== 'session') return found
  return { ...found, cwd: sessionModeWorkspacePath() }
}

/** Decode WorkBuddy's sanitized project directory into its original workspace path. */
function projectWorkspacePath(projectHash: string): string | undefined {
  const prefix = `Users-${basename(homedir())}-`
  if (!projectHash.startsWith(prefix)) return undefined
  const encoded = projectHash.slice(prefix.length)
  const separator = encoded.indexOf('-')
  if (separator <= 0 || separator === encoded.length - 1) return undefined
  return join(homedir(), encoded.slice(0, separator), encoded.slice(separator + 1))
}

async function loadManifest(path: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Manifest>
    return {
      version: parsed.version ?? 1,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      mcp: Array.isArray(parsed.mcp) ? parsed.mcp : [],
      automations: Array.isArray(parsed.automations) ? parsed.automations : [],
      imports: Array.isArray(parsed.imports) ? parsed.imports as Array<string | MigrationBatch> : [],
    }
  } catch {
    return { version: MIGRATION_FORMAT_VERSION, updatedAt: new Date(0).toISOString(), sessions: [], memories: [], mcp: [], automations: [], imports: [] }
  }
}

async function connectorFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const files: string[] = []
  const ignoredDirectories = /^(projects?|memory|memery|migration-history|artifact-index|binaries|local-models|plugins|skills|logs|session|cache|connectors-marketplace)$/i
  const interestingFile = (name: string, parent: string): boolean => {
    const lower = name.toLowerCase()
    if (!/\.jsonc?$/.test(lower) || lower === 'connector-states.json') return false
    if (lower === 'mcp.json' || lower.endsWith('.mcp.json') || lower === 'mcp.jsonc') return true
    if (/^(connectors?|servers?|settings|config)\.jsonc?$/.test(lower)) return true
    return parent.toLowerCase().endsWith('/connectors')
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.test(entry.name)) await walk(path, depth + 1)
      } else if (entry.isFile() && interestingFile(entry.name, directory)) {
        files.push(path)
      }
    }
  }
  await walk(root, 0)
  return [...new Set(files)].sort()
}

function automationFingerprint(draft: AutomationDraft): string {
  return createHash('sha256').update(JSON.stringify({ name: draft.name, prompt: draft.prompt, cron: draft.cron ?? null, runAt: draft.runAt ?? null, workspace: draft.targetWorkspacePath ?? null, model: draft.modelId ?? null })).digest('hex')
}

async function automationRuleFor(draft: AutomationDraft, workspacePath: string | undefined, workspaceRegistry: WorkspaceLike | undefined, model?: string): Promise<Record<string, unknown>> {
  const now = new Date().toISOString()
  let trigger: Record<string, unknown>
  if (draft.triggerKind === 'cron') trigger = { kind: 'cron', cron: draft.cron, timezone: draft.timezone ?? 'Asia/Shanghai' }
  else if (draft.triggerKind === 'single') trigger = { kind: 'single', runAt: draft.runAt }
  else throw new Error(`automation "${draft.sourceId}" has unsupported schedule`)
  // The automation contract's target is `{ mode: 'new-session', workspaceId }`.
  // Writing `kind` (or omitting the workspace) used to import a rule the
  // executor rejects at run time ("复用已有会话模式暂未开放") — every migrated
  // automation failed on its first scheduled run.
  let workspaceId: string | undefined
  if (workspacePath !== undefined && workspaceRegistry !== undefined) {
    try {
      const workspace = await workspaceRegistry.resolveByPath(workspacePath) ?? await workspaceRegistry.create(workspacePath, draft.name)
      workspaceId = workspace.id
    } catch { /* keep import valid; the rule falls back to the default workspace */ }
  }
  return {
    id: `workbuddy-${draft.sourceId.replace(/[^a-zA-Z0-9-]/g, '-')}`,
    name: draft.name,
    enabled: draft.enabled,
    trigger,
    action: { kind: 'agent-prompt', prompt: draft.prompt, ...(model ? { model } : {}) },
    target: { mode: 'new-session', ...(workspaceId === undefined ? {} : { workspaceId }) },
    notification: { pushToSession: true, pushWecomBot: false },
    ...(draft.validFrom ? { effectiveFrom: draft.validFrom } : {}),
    ...(draft.validUntil ? { effectiveUntil: draft.validUntil } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

export class MigrationService {
  readonly manifestPath: string
  private readonly memoryPath: string
  private manifest?: Manifest
  private running = false

  constructor(
    private readonly persistence: SessionPersistence,
    private readonly workspaceRegistry?: WorkspaceLike,
    private readonly options: { sourceRoot?: string; maxFileBytes?: number; maxFiles?: number; toolMode?: 'transcript' | 'narrative'; automationModelId?: string; automationModelAllowlist?: string[]; saveAutomationRule?: (rule: unknown) => Promise<void> } = {},
  ) {
    const root = targetRoot()
    this.manifestPath = join(root, 'migration', 'manifest.json')
    this.memoryPath = join(root, 'migration', 'memory', 'records.jsonl')
  }

  private toolMode(): 'transcript' | 'narrative' {
    return this.options.toolMode ?? 'narrative'
  }

  /** Migrated automations must not carry WorkBuddy model ids (unknown on the gateway). */
  private automationModelPolicy(): AutomationModelPolicy {
    return {
      ...(this.options.automationModelAllowlist === undefined ? {} : { allowlist: new Set(this.options.automationModelAllowlist) }),
      ...(this.options.automationModelId === undefined || this.options.automationModelId.trim() === '' ? {} : { fallbackModelId: this.options.automationModelId.trim() }),
    }
  }

  private async state(): Promise<Manifest> {
    this.manifest ??= await loadManifest(this.manifestPath)
    return this.manifest
  }

  async probe(): Promise<ProbeReport> {
    return await probeWorkBuddy({ root: this.options.sourceRoot ?? defaultWorkBuddyRoot(), ...(this.options.maxFileBytes === undefined ? {} : { maxFileBytes: this.options.maxFileBytes }), ...(this.options.maxFiles === undefined ? {} : { maxFiles: this.options.maxFiles }) })
  }

  async preview(): Promise<MigrationPreview> {
    const source = await this.probe()
    const manifest = await this.state()
    const workbuddy = readWorkBuddyCatalog(source.sourceRoot)
    const catalog = workbuddy.sessions
    const sessions: MigrationPreview['sessions'] = []
    const excluded = { deletedSessions: 0, missingWorkspaces: 0 }
    for (const item of source.sessions) {
      try {
        // Respect WorkBuddy's own deletions: a session the user deleted there
        // must not be resurrected just because its transcript file remains.
        if (workbuddy.deletedSessionIds.has(item.sessionId)) {
          excluded.deletedSessions += 1
          continue
        }
        const metadata = effectiveMetadata(item.path, source.sourceRoot, catalog)
        const converted = await convertWorkBuddySession(item.path, source.sourceRoot, metadata, { toolMode: this.toolMode() })
        const workspacePath = metadata?.mode === 'session' ? sessionModeWorkspacePath() : (converted.cwd ?? projectWorkspacePath(converted.projectHash))
        // A workspace whose directory is gone was deleted in WorkBuddy (or on
        // disk); importing its sessions would recreate a dead workspace.
        if (metadata?.mode !== 'session' && workspacePath !== undefined && !existsSync(workspacePath)) {
          excluded.missingWorkspaces += 1
          continue
        }
        const key = sourceKey(item, metadata, source.sourceRoot)
        const known = [...manifest.sessions].reverse().find(entry => entry.archived !== true && (entry.sourceKey === key || entry.sourceSessionId === item.sessionId || entry.sourcePath === item.path))
        const repair = known !== undefined && (known.converterVersion ?? 1) < MIGRATION_CONVERTER_VERSION
        const changed = known !== undefined && (known.sourceHash !== converted.sourceHash || known.metadataHash !== metadataHash(metadata) || (known.toolMode ?? 'transcript') !== this.toolMode())
        const status: MigrationPreview['sessions'][number]['status'] = known === undefined ? 'new' : repair ? 'repair' : changed ? 'changed' : 'unchanged'
        const workspaceId = workspaceIdOf(workspacePath)
        sessions.push({ path: item.path, sourceSessionId: item.sessionId, projectHash: item.projectHash, bytes: item.bytes, key, ...(converted.title ? { title: converted.title } : {}), ...(metadata?.mode ? { mode: metadata.mode } : {}), ...(workspacePath ? { workspacePath } : {}), ...(workspaceId ? { workspaceId } : {}), status, eligible: status !== 'unchanged', eventCount: converted.events.length, loss: converted.loss, sourceHash: converted.sourceHash })
      } catch (cause) {
        if (workbuddy.deletedSessionIds.has(item.sessionId)) {
          excluded.deletedSessions += 1
          continue
        }
        const metadata = effectiveMetadata(item.path, source.sourceRoot, catalog)
        const key = sourceKey(item, metadata, source.sourceRoot)
        const workspacePath = metadata?.mode === 'session' ? sessionModeWorkspacePath() : (metadata?.cwd ?? projectWorkspacePath(item.projectHash))
        const workspaceId = workspaceIdOf(workspacePath)
        sessions.push({ path: item.path, sourceSessionId: item.sessionId, projectHash: item.projectHash, bytes: item.bytes, key, ...(workspacePath ? { workspacePath } : {}), ...(workspaceId ? { workspaceId } : {}), status: 'failed', eligible: false, eventCount: 0, loss: [{ code: 'read-failed', detail: cause instanceof Error ? cause.message : String(cause) }] })
      }
    }
    const memories = []
    for (const candidate of source.memoryCandidates) {
      try { memories.push(await parseMemoryCandidate(candidate.path, candidate.kind)) } catch (cause) { memories.push({ sourcePath: candidate.path, sourceHash: '', kind: candidate.kind, records: [], skipped: 1, loss: [{ code: 'read-failed', detail: cause instanceof Error ? cause.message : String(cause) }] }) }
    }
    const mcp: McpDraft[] = []
    let skippedSecrets = 0
    for (const path of await connectorFiles(source.sourceRoot)) {
      const result = await sanitizeMcpConfig(path)
      mcp.push(...result.drafts); skippedSecrets += result.skippedSecrets.length
    }
    // WorkBuddy mirrors the same MCP catalog into the root file and each active
    // connector profile. IDs are content-based, so keep one draft per server.
    const uniqueMcp = [...new Map(mcp.map(item => [item.id, item])).values()]
    const automationDrafts: AutomationDraft[] = readWorkBuddyAutomations(source.sourceRoot).map(toAutomationDraft).map(draft => {
      const known = manifest.automations.find(item => item.sourceId === draft.sourceId)
      const fingerprint = automationFingerprint(draft)
      const status: 'new' | 'unchanged' = known !== undefined && known.fingerprint === fingerprint ? 'unchanged' : 'new'
      // Without a rule-import channel the draft stays visible in the preview but
      // is not importable, so the UI never offers a selection that cannot land.
      return { ...draft, status, eligible: status === 'new' && this.options.saveAutomationRule !== undefined }
    })
    const automationEligible = automationDrafts.filter(item => item.eligible).length
    // Aggregate sessions by workspace for on-demand selection. Sessions without a
    // resolvable workspace form one 'ungrouped' bucket selectable by key only.
    const workspaceMap = new Map<string, WorkspaceSummary>()
    const ungrouped: WorkspaceSummary[] = []
    for (const item of sessions) {
      const rawPath = item.workspacePath
      const id = item.workspaceId ?? 'ungrouped'
      let group = workspaceMap.get(id)
      if (group === undefined) {
        group = {
          id,
          path: rawPath ?? '',
          ...(id === 'ungrouped' ? {} : { title: item.mode === 'session' ? '会话模式' : basename(rawPath ?? '') }),
          mode: id === 'ungrouped' ? 'ungrouped' : (item.mode === 'session' ? 'session' : item.mode === 'workspace' ? 'workspace' : 'mixed'),
          count: 0, eligible: 0, newCount: 0, changedCount: 0, repairCount: 0, unchangedCount: 0, failedCount: 0,
        }
        if (id === 'ungrouped') ungrouped.push(group)
        else workspaceMap.set(id, group)
      }
      group.count += 1
      if (item.mode === 'session') group.mode = group.mode === 'session' ? 'session' : 'mixed'
      else if (item.mode === 'workspace') group.mode = group.mode === 'workspace' ? 'workspace' : 'mixed'
      if (item.status === 'new') group.newCount += 1
      else if (item.status === 'changed') group.changedCount += 1
      else if (item.status === 'repair') group.repairCount += 1
      else if (item.status === 'unchanged') group.unchangedCount += 1
      else if (item.status === 'failed') group.failedCount += 1
      if (item.eligible) group.eligible += 1
    }
    const workspaces = [...workspaceMap.values(), ...ungrouped]
    const sessionCounts = sessions.reduce((counts, item) => { counts[item.status] += 1; return counts }, { new: 0, unchanged: 0, changed: 0, repair: 0, archived: 0, failed: 0 } as Record<MigrationPreview['sessions'][number]['status'], number>)
    const memoryEligible = toMemoryRecords(memories, manifest.memories).records.length
    const mcpEligible = uniqueMcp.filter(item => !manifest.mcp.some(existing => existing.id === item.id)).length
    const importedTimes = manifest.sessions.map(item => item.lastImportedAt).filter((item): item is string => typeof item === 'string')
    const lastImportedAt = importedTimes.sort().at(-1)
    return {
      migrationFormatVersion: MIGRATION_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      source,
      sessions,
      workspaces,
      memories,
      mcp: uniqueMcp,
      automations: automationDrafts,
      summary: {
        sessions: sessions.length,
        memories: memories.reduce((count, item) => count + item.records.length, 0),
        mcp: uniqueMcp.length,
        automations: automationDrafts.length,
        automationEligible,
        lossyFields: sessions.reduce((count, item) => count + item.loss.length, 0) + memories.reduce((count, item) => count + item.loss.length, 0),
        skippedSecrets,
        eligible: sessionCounts.new + sessionCounts.changed + sessionCounts.repair + memoryEligible + mcpEligible + automationEligible,
        unchanged: sessionCounts.unchanged,
        changed: sessionCounts.changed,
        repair: sessionCounts.repair,
        memoryEligible,
        mcpEligible,
        excludedDeletedSessions: excluded.deletedSessions,
        excludedMissingWorkspaces: excluded.missingWorkspaces,
        ...(lastImportedAt ? { lastImportedAt } : {}),
      },
    }
  }

  async migrate(selection: MigrationSelection): Promise<MigrationResult> {
    if (this.running) throw new Error('migration already running')
    this.running = true
    const manifest = await this.state()
    const result: MigrationResult = { migrationFormatVersion: MIGRATION_FORMAT_VERSION, manifestId: randomUUID(), finishedAt: new Date().toISOString(), importedSessions: 0, skippedSessions: 0, importedMemories: 0, skippedMemories: 0, importedMcp: 0, skippedMcp: 0, importedAutomations: 0, skippedAutomations: 0, loss: [], errors: [] }
    try {
      const source = await this.probe()
      const catalog = readWorkBuddySessionMetadata(source.sourceRoot)
      const sessionWorkspacePath = sessionModeWorkspacePath()
      const batch: MigrationBatch = { id: result.manifestId, startedAt: result.finishedAt, status: 'running', selection, importedSessions: 0, skippedSessions: 0, importedMemories: 0, importedMcp: 0, errors: 0 }
      manifest.version = MIGRATION_FORMAT_VERSION
      manifest.imports.push(batch)
      await atomicJson(this.manifestPath, manifest)
      if (selection.sessions) await mkdir(sessionWorkspacePath, { recursive: true, mode: 0o700 })
      const sessionKeys = sanitizeSessionFilter(selection.sessionKeys, 'sessionKeys')
      const workspaceIds = sanitizeSessionFilter(selection.workspaceIds, 'workspaceIds')
      const automationIds = sanitizeSessionFilter(selection.automationIds, 'automationIds')
      if (!selection.sessions && (sessionKeys.length > 0 || workspaceIds.length > 0)) throw new Error('invalid selection: session filters require sessions: true')
      if (!selection.automations && automationIds.length > 0) throw new Error('invalid selection: automation filters require automations: true')
      const keyFilter = new Set(sessionKeys)
      const wsFilter = new Set(workspaceIds)
      const hasFilter = keyFilter.size > 0 || wsFilter.size > 0
      const allSourceKeys = new Set<string>()
      const allSourceWids = new Set<string>()
      for (const item of source.sessions) {
        const metadata = effectiveMetadata(item.path, source.sourceRoot, catalog)
        allSourceKeys.add(sourceKey(item, metadata, source.sourceRoot))
        const cheapPath = metadata?.mode === 'session' ? sessionWorkspacePath : (metadata?.cwd ?? projectWorkspacePath(item.projectHash))
        const wid = workspaceIdOf(cheapPath)
        if (wid !== undefined) allSourceWids.add(wid)
      }
      if (selection.sessions) for (const item of source.sessions) {
        try {
          const metadata = effectiveMetadata(item.path, source.sourceRoot, catalog)
          const key = sourceKey(item, metadata, source.sourceRoot)
          if (hasFilter) {
            const cheapWorkspacePath = metadata?.mode === 'session' ? sessionWorkspacePath : (metadata?.cwd ?? projectWorkspacePath(item.projectHash))
            const cheapWid = workspaceIdOf(cheapWorkspacePath)
            if (!keyFilter.has(key) && cheapWid !== undefined && !wsFilter.has(cheapWid)) {
              // The cheap projection is the authoritative workbuddy.db cwd; a JSONL
              // row.cwd refinement cannot move a session into another workspace.
              result.skippedSessions += 1; batch.skippedSessions += 1; continue
            }
          }
          const converted = await convertWorkBuddySession(item.path, source.sourceRoot, metadata, { toolMode: this.toolMode() })
          if (hasFilter) {
            const finalWorkspacePath = metadata?.mode === 'session' ? sessionWorkspacePath : (converted.cwd ?? projectWorkspacePath(converted.projectHash))
            const finalWid = workspaceIdOf(finalWorkspacePath)
            if (!keyFilter.has(key) && (finalWid === undefined || !wsFilter.has(finalWid))) {
              result.skippedSessions += 1; batch.skippedSessions += 1; continue
            }
          }
          const known = [...manifest.sessions].reverse().find(entry => entry.archived !== true && (entry.sourceKey === key || entry.sourceSessionId === item.sessionId || entry.sourcePath === item.path || entry.sourceHash === converted.sourceHash))
          const needsRepair = known !== undefined && (known.converterVersion ?? 1) < MIGRATION_CONVERTER_VERSION
          const changed = known !== undefined && (known.sourceHash !== converted.sourceHash || known.metadataHash !== metadataHash(metadata))
          if (known && selection.force !== true && !needsRepair && !changed) { result.skippedSessions += 1; batch.skippedSessions += 1; continue }
          const targetId = known ? `${converted.targetSessionId}-${Date.now().toString(36)}` : converted.targetSessionId
          if (known && this.workspaceRegistry) {
            try {
              await (this.workspaceRegistry as WorkspaceLike & { archiveSession?: (id: string) => Promise<void> }).archiveSession?.(known.targetSessionId)
            } catch (cause) {
              result.loss.push({ code: 'legacy-session-archive-failed', detail: cause instanceof Error ? cause.message : String(cause) })
            }
          }
          const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId(targetId), createdAt: converted.createdAt, isSeeded: true, ...((converted.cwd ?? (metadata?.mode === 'session' ? sessionWorkspacePath : undefined)) ? { cwd: converted.cwd ?? sessionWorkspacePath } : {}) }
          // Imported history is a SEED prefix with an exact inherited count: the
          // runtime then treats [0, events.length) as seed and never replays the
          // imported log into the live surface, which would otherwise duplicate
          // the whole history in the first request (gateway: Duplicate tool output).
          await writeSeededSession(this.persistence, header, converted.events as SessionEvent[], SessionId(targetId))
          // WorkBuddy records carry the authoritative workspace in `cwd`. The
          // sanitized project directory is only a fallback: splitting its
          // hyphens cannot faithfully represent nested paths.
          const workspacePath = metadata?.mode === 'session' ? sessionWorkspacePath : (converted.cwd ?? projectWorkspacePath(converted.projectHash))
          if (this.workspaceRegistry && workspacePath && existsSync(workspacePath)) {
            try {
              const title = metadata?.mode === 'session' ? '会话模式' : basename(workspacePath)
              const workspace = await this.workspaceRegistry.resolveByPath(workspacePath) ?? await this.workspaceRegistry.create(workspacePath, title)
              // dsh >= 0.2 rebuilds workspace membership from stored session
              // headers (cwd) at startup and has no attachSession method. Older
              // builds need the explicit attach; call it only when present.
              if (typeof workspace.attachSession === 'function') await workspace.attachSession(targetId)
            } catch (cause) {
              // A missing/unavailable source workspace must not make an otherwise
              // valid session import fail. It remains visible under Ungrouped and
              // the manifest records why it could not be attached.
              result.loss.push({ code: 'workspace-attach-failed', detail: cause instanceof Error ? cause.message : String(cause) })
            }
          }
          if (known) { known.archived = true; known.status = 'archived'; known.supersededBy = targetId }
          manifest.sessions.push({ toolMode: this.toolMode(), sourceHash: converted.sourceHash, sourcePath: converted.sourcePath, sourceSessionId: converted.sourceSessionId, sourceKey: key, metadataHash: metadataHash(metadata), targetSessionId: targetId, importId: result.manifestId, converterVersion: MIGRATION_CONVERTER_VERSION, lastImportedAt: new Date().toISOString(), status: 'imported', ...(converted.title ? { title: converted.title } : {}), ...(metadata?.mode ? { mode: metadata.mode } : {}), ...(workspacePath ? { workspacePath } : {}) })
          result.importedSessions += 1; batch.importedSessions += 1; result.loss.push(...converted.loss)
          await atomicJson(this.manifestPath, manifest)
        } catch (cause) { result.errors.push({ sourcePath: item.path, message: cause instanceof Error ? cause.message : String(cause) }); batch.errors += 1 }
      }
      for (const key of [...keyFilter].filter(key => !allSourceKeys.has(key))) {
        result.loss.push({ code: 'unknown-selection-key', detail: key.slice(0, 128) })
      }
      for (const wid of [...wsFilter].filter(wid => !allSourceWids.has(wid))) {
        result.loss.push({ code: 'unknown-selection-key', detail: wid })
      }
      if (selection.memories) {
        const previews = (await this.preview()).memories
        const merged = toMemoryRecords(previews, manifest.memories)
        manifest.memories = [...manifest.memories, ...merged.records]
        result.importedMemories = merged.records.length; result.skippedMemories = merged.skipped; batch.importedMemories = merged.records.length
        result.loss.push(...previews.flatMap(item => item.loss))
        await mkdir(join(this.memoryPath, '..'), { recursive: true, mode: 0o700 })
        await writeFile(this.memoryPath, manifest.memories.map(item => JSON.stringify(item)).join('\n') + (manifest.memories.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 })
      }
      if (selection.mcp) {
        const previews = (await this.preview()).mcp
        const seen = new Set(manifest.mcp.map(item => item.id))
        for (const draft of previews) { if (seen.has(draft.id)) result.skippedMcp += 1; else { manifest.mcp.push(draft); result.importedMcp += 1; batch.importedMcp += 1 } }
      }
      if (selection.automations) {
        const drafts = (await this.preview()).automations
        const filter = new Set(automationIds)
        const hasFilter = filter.size > 0
        for (const draft of drafts) {
          try {
            if (hasFilter && !filter.has(draft.sourceId)) { result.skippedAutomations += 1; continue }
            const known = manifest.automations.find(item => item.sourceId === draft.sourceId)
            const fingerprint = automationFingerprint(draft)
            if (known !== undefined && known.fingerprint === fingerprint && selection.force !== true) { result.skippedAutomations += 1; continue }
            const workspacePath = draft.targetWorkspacePath
            if (draft.triggerKind === 'unsupported') { result.loss.push({ code: 'automation-unsupported', detail: `${draft.sourceId}: ${draft.loss.map(item => item.detail).join('; ')}` }); result.skippedAutomations += 1; continue }
            const resolvedModel = resolveAutomationModel(draft.modelId, this.automationModelPolicy())
            if (resolvedModel.mappedFrom !== undefined) {
              result.loss.push({
                code: 'automation-model-remapped',
                detail: `${draft.name}: ${resolvedModel.mappedFrom} -> ${resolvedModel.model ?? '部署默认模型'}`,
              })
            }
            // A deleted source workspace must not be recreated for the rule.
            if (workspacePath !== undefined && !existsSync(workspacePath)) {
              result.loss.push({ code: 'automation-workspace-missing', detail: `${draft.name}: ${workspacePath}` })
              result.skippedAutomations += 1
              continue
            }
            // No rule-import channel: skip the rule, keep the rest of the batch.
            // The guard sits before `automationRuleFor` so a skipped rule never
            // creates a workspace it would not be attached to.
            if (this.options.saveAutomationRule === undefined) {
              result.loss.push({ code: 'automation-channel-unavailable', detail: `${draft.name}: no automation rule-import channel is registered` })
              result.skippedAutomations += 1
              continue
            }
            const rule = await automationRuleFor(draft, workspacePath, this.workspaceRegistry, resolvedModel.model)
            await this.options.saveAutomationRule(rule)
            const existing = manifest.automations.find(item => item.sourceId === draft.sourceId)
            const next = { sourceId: draft.sourceId, fingerprint, targetRuleId: String((rule as { id: string }).id), importedAt: new Date().toISOString(), ...(draft.enabled ? {} : { status: 'imported-inactive' }) }
            if (existing === undefined) manifest.automations.push(next)
            else { manifest.automations = manifest.automations.map(item => item.sourceId === draft.sourceId ? next : item) }
            result.importedAutomations += 1
            result.loss.push(...draft.loss.map(item => ({ ...item, detail: `automation ${draft.name}: ${item.detail}` })))
            await atomicJson(this.manifestPath, manifest)
          } catch (cause) { result.errors.push({ sourcePath: `automation:${draft.name}`, message: cause instanceof Error ? cause.message : String(cause) }) }
        }
      }
      batch.status = result.errors.length > 0 ? 'failed' : 'completed'
      batch.finishedAt = new Date().toISOString()
      manifest.updatedAt = batch.finishedAt
      await atomicJson(this.manifestPath, manifest)
      return result
    } finally { this.running = false }
  }

  async archiveLastImport(manifestId?: string): Promise<{ archived: number }> {
    void manifestId
    const manifest = await this.state()
    let archived = 0
    for (const entry of manifest.sessions) {
      if (entry.archived === true || (manifestId !== undefined && entry.importId !== manifestId)) continue
      if (this.workspaceRegistry) { try { await (this.workspaceRegistry as WorkspaceLike & { archiveSession?: (id: string) => Promise<void> }).archiveSession?.(entry.targetSessionId) } catch { /* retain manifest audit even when archive is unavailable */ } }
      entry.archived = true; archived += 1
    }
    await atomicJson(this.manifestPath, manifest)
    return { archived }
  }

  async setMemoryEnabled(id: string, enabled: boolean): Promise<MemoryRecord | undefined> {
    const manifest = await this.state()
    const index = manifest.memories.findIndex(item => item.id === id)
    if (index < 0) return undefined
    const updated = { ...manifest.memories[index]!, enabled }
    manifest.memories = [...manifest.memories.slice(0, index), updated, ...manifest.memories.slice(index + 1)]
    await mkdir(join(this.memoryPath, '..'), { recursive: true, mode: 0o700 })
    await writeFile(this.memoryPath, manifest.memories.map(item => JSON.stringify(item)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
    await atomicJson(this.manifestPath, manifest)
    return updated
  }

  async deleteMemory(id: string): Promise<boolean> {
    const manifest = await this.state()
    const next = manifest.memories.filter(item => item.id !== id)
    if (next.length === manifest.memories.length) return false
    manifest.memories = next
    await mkdir(join(this.memoryPath, '..'), { recursive: true, mode: 0o700 })
    await writeFile(this.memoryPath, next.map(item => JSON.stringify(item)).join('\n') + (next.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 })
    await atomicJson(this.manifestPath, manifest)
    return true
  }

  async manifestView(): Promise<Manifest> { return await this.state() }
}

export function sanitizePathForPreview(value: string): string { return displayPath(value) }
