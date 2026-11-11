import type { AutomationDraft } from './automation.js'

export const PROBE_FORMAT_VERSION = 1
export const MIGRATION_FORMAT_VERSION = 2

export type ProbeWarningCode =
  | 'missing-root'
  | 'file-too-large'
  | 'large-file'
  | 'file-limit'
  | 'symlink-skipped'
  | 'invalid-json'
  | 'unknown-event'
  | 'sqlite-header-only'
  | 'workbuddy-catalog-unreadable'
  | 'read-failed'

export interface ProbeWarning {
  code: ProbeWarningCode
  path: string
  detail: string
}

export interface JsonlFileReport {
  path: string
  projectHash: string
  sessionId: string
  bytes: number
  lines: number
  validLines: number
  invalidLines: number
  eventCounts: Record<string, number>
  schemaVersions: string[]
}

export interface MemoryCandidate {
  path: string
  bytes: number
  kind: 'markdown' | 'json' | 'jsonl' | 'unknown'
}

export interface LegacyDatabaseReport {
  path: string
  bytes: number
  sqliteHeader: boolean
  schemaInspected: false
}

export interface ProbeReport {
  probeFormatVersion: number
  sourceRoot: string
  scannedAt: string
  projectsPath: string
  memoryPath: string
  memoryPaths: string[]
  sessions: JsonlFileReport[]
  memoryCandidates: MemoryCandidate[]
  legacyDatabase?: LegacyDatabaseReport
  warnings: ProbeWarning[]
}

export interface ProbeOptions {
  root?: string
  maxFileBytes?: number
  maxFiles?: number
}

export type MigrationSelection = {
  sessions: boolean
  memories: boolean
  mcp: boolean
  /** Import WorkBuddy automation rules as DSH automation rules. */
  automations?: boolean
  force?: boolean
  /** Narrow session import to these source keys (union with workspaceIds). */
  sessionKeys?: string[]
  /** Narrow session import to these workspace identifiers (union with sessionKeys). */
  workspaceIds?: string[]
  /** Narrow automation import to these source automation ids. */
  automationIds?: string[]
}

export interface LossRecord {
  code: string
  detail: string
}

export interface ConvertedSession {
  sourcePath: string
  sourceHash: string
  sourceSessionId: string
  projectHash: string
  targetSessionId: string
  cwd?: string
  mode?: 'workspace' | 'session' | 'unknown'
  createdAt: number
  title?: string
  events: unknown[]
  loss: LossRecord[]
}

export interface MemoryRecord {
  id: string
  content: string
  sourcePath: string
  sourceHash: string
  enabled: boolean
  createdAt: string
}

export interface MemoryPreview {
  sourcePath: string
  sourceHash: string
  kind: MemoryCandidate['kind']
  records: Array<{ id: string; content: string }>
  skipped: number
  loss: LossRecord[]
}

export interface McpDraft {
  id: string
  name: string
  url?: string
  transport?: string
  command?: string
  args?: string[]
  sourcePath: string
  skippedSecrets: string[]
}

export interface WorkspaceSummary {
  /** sha256(workspacePath).slice(0, 16); 'ungrouped' for sessions without a workspace. */
  id: string
  title?: string
  /** Redacted display path ('~/…'). */
  path: string
  mode: 'workspace' | 'session' | 'mixed' | 'ungrouped'
  count: number
  eligible: number
  newCount: number
  changedCount: number
  repairCount: number
  unchangedCount: number
  failedCount: number
}

export interface MigrationPreview {
  migrationFormatVersion: number
  generatedAt: string
  source: ProbeReport
  sessions: Array<{
    path: string
    sourceSessionId: string
    projectHash: string
    bytes: number
    title?: string
    mode?: 'workspace' | 'session' | 'unknown'
    workspacePath?: string
    /** Stable, non-sensitive selection key (sourceSessionId or relative path). */
    key: string
    /** workspaceId for sessions that resolve to a workspace. */
    workspaceId?: string
    status: 'new' | 'unchanged' | 'changed' | 'repair' | 'archived' | 'failed'
    eligible: boolean
    eventCount: number
    loss: LossRecord[]
    sourceHash?: string
  }>
  workspaces: WorkspaceSummary[]
  memories: MemoryPreview[]
  mcp: McpDraft[]
  automations: AutomationDraft[]
  summary: {
    sessions: number
    memories: number
    mcp: number
    automations: number
    automationEligible: number
    lossyFields: number
    skippedSecrets: number
    eligible: number
    unchanged: number
    changed: number
    repair: number
    memoryEligible: number
    mcpEligible: number
    /** Sessions WorkBuddy marks deleted (skipped entirely). */
    excludedDeletedSessions: number
    /** Sessions whose workspace directory is gone (skipped entirely). */
    excludedMissingWorkspaces: number
    lastImportedAt?: string
  }
}

export interface MigrationResult {
  migrationFormatVersion: number
  manifestId: string
  finishedAt: string
  importedSessions: number
  skippedSessions: number
  importedMemories: number
  skippedMemories: number
  importedMcp: number
  skippedMcp: number
  importedAutomations: number
  skippedAutomations: number
  loss: LossRecord[]
  errors: Array<{ sourcePath: string; message: string }>
}

/** Format version of the DSH -> WorkBuddy journal written by the exporter. */
export const WORKBUDDY_EXPORT_FORMAT_VERSION = 1

/**
 * How one DSH session relates to its WorkBuddy transcript.
 *
 * - `new`: nothing has been exported yet; a new WorkBuddy session is created.
 * - `ahead`: DSH holds events the transcript does not; they are appended.
 * - `synced`: both sides are at the same event; nothing to write.
 * - `workbuddy-ahead`: only WorkBuddy moved on. Exporting would be a no-op, so
 *   the user is told to import that session back instead.
 * - `conflict`: both sides moved on independently. Appending would interleave
 *   two histories, so a new WorkBuddy session carries the DSH side.
 * - `empty`: the session has no exportable event (e.g. only a seed).
 * - `failed`: the session log could not be read.
 */
export type ExportSessionStatus = 'new' | 'ahead' | 'synced' | 'workbuddy-ahead' | 'conflict' | 'empty' | 'failed'

export interface ExportSessionSummary {
  /** DSH session id. */
  id: string
  title?: string
  createdAt: number
  /** WorkBuddy-formatted working directory. */
  cwd?: string
  eventCount: number
  /** First DSH event sequence this export would consider. */
  startSeq: number
  /** Highest event sequence already present in WorkBuddy. */
  lastSyncedEventSeq: number
  /** Events that would be written by the next export. */
  pendingEvents: number
  /** WorkBuddy rows that would be written by the next export. */
  pendingRows: number
  status: ExportSessionStatus
  /** Target WorkBuddy session id, or a placeholder when none exists yet. */
  workbuddySessionId: string
  transcriptPath: string
  lastSyncedAt?: string
  /** Explanation shown next to a conflict or an unavailable target. */
  detail?: string
}

/**
 * One DSH-side fact an export would append to WorkBuddy's `MEMORY.md`.
 *
 * DSH keeps no memory store of its own, so the only honest source is what the
 * import direction already captured: the manifest and its JSONL record file.
 */
export interface ExportMemorySummary {
  id: string
  /** Single-line memory text, verbatim. */
  content: string
  /** Where the record came from: the import manifest or the live record file. */
  source: 'manifest' | 'record'
  sourcePath: string
  createdAt?: string
  /** True when WorkBuddy's MEMORY.md already carries this line. */
  present: boolean
}

export interface ExportMemoryBoard {
  /** The WorkBuddy file the export appends to. */
  targetPath: string
  targetExists: boolean
  records: ExportMemorySummary[]
  summary: {
    total: number
    pending: number
    present: number
    /** Records dropped because they carry no reusable knowledge. */
    skipped: number
  }
}

export type ExportMcpStatus = 'new' | 'present' | 'conflict'

/**
 * One MCP server an export would register in WorkBuddy's `mcp.json`.
 *
 * DSH's `dsh-mcp-client` exposes no registry, so servers are recovered from the
 * profile patch files that mount them plus the import manifest.
 */
export interface ExportMcpSummary {
  id: string
  /** The `mcpServers` key this entry occupies. */
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args: string[]
  url?: string
  /**
   * Names of `env` / `headers` entries whose values were never read. WorkBuddy
   * stores literal values, so these must be filled in by hand.
   */
  secretKeys: string[]
  sourcePath: string
  status: ExportMcpStatus
  detail?: string
}

export interface ExportMcpBoard {
  targetPath: string
  targetExists: boolean
  servers: ExportMcpSummary[]
  summary: {
    total: number
    new: number
    present: number
    conflict: number
    /** Secret-bearing keys across every pending server. */
    secretKeys: number
  }
}

export type ExportAutomationStatus = 'new' | 'present' | 'unsupported'

/** One DSH scheduled task an export would create as a WorkBuddy automation. */
export interface ExportAutomationSummary {
  id: string
  title: string
  prompt: string
  scheduleType: 'recurring' | 'once'
  /** RRULE text WorkBuddy stores; absent for one-shot or unsupported rules. */
  rrule?: string
  scheduledAt?: string
  status: ExportAutomationStatus
  detail?: string
}

export interface ExportAutomationBoard {
  /** False when this Host mounts no schedule service at all. */
  available: boolean
  detail?: string
  automations: ExportAutomationSummary[]
  summary: {
    total: number
    pending: number
    present: number
    unsupported: number
  }
}

export interface ExportPreview {
  exportFormatVersion: number
  generatedAt: string
  /** WorkBuddy data directory the export writes into. */
  workbuddyRoot: string
  /** Whether WorkBuddy is still running, which blocks every write. */
  activity: {
    running: boolean
    observed: boolean
    evidence: string[]
    checkedAt: string
  }
  sessions: ExportSessionSummary[]
  /**
   * The three non-session boards. They mirror the import direction's memory,
   * MCP and automation boards so both sides offer the same categories.
   */
  memories: ExportMemoryBoard
  mcp: ExportMcpBoard
  automations: ExportAutomationBoard
  summary: {
    total: number
    new: number
    ahead: number
    synced: number
    /** Sessions that only moved on in WorkBuddy; import them back instead. */
    workbuddyAhead: number
    conflict: number
    empty: number
    failed: number
    pendingRows: number
    lastExportedAt?: string
    lastSyncedSessions: number
  }
}

export interface ExportResult {
  exportFormatVersion: number
  finishedAt: string
  exportedSessions: number
  skippedSessions: number
  /** Sessions written as brand-new WorkBuddy conversations. */
  createdSessions: number
  /** Sessions appended to the transcript they came from. */
  appendedSessions: number
  /** WorkBuddy rows written in total. */
  rows: number
  sessions: Array<{
    sessionId: string
    workbuddySessionId: string
    /** Where the rows landed; the panel links to it so the user can check. */
    transcriptPath: string
    rows: number
    lastEventSeq: number
    created: boolean
  }>
  errors: Array<{ sessionId: string; message: string }>
  /** What the run wrote into WorkBuddy's `MEMORY.md`. */
  memories: { written: number; skipped: number; targetPath: string; backupPath?: string }
  /** What the run wrote into WorkBuddy's `mcp.json`. */
  mcp: { written: number; skipped: number; targetPath: string; backupPath?: string; secretKeys: string[] }
  /** What the run wrote into WorkBuddy's `automations` table. */
  automations: { written: number; skipped: number; unsupported: number; backupPath?: string }
  /**
   * Sessions whose newer content exists only in WorkBuddy. Exporting cannot
   * bring it across, so the result points the user at the import direction.
   */
  pendingImport: Array<{ sessionId: string; title?: string }>
}

/** Input for the export direction's non-session boards. */
export interface ExportBoardsInput {
  confirmed: true
  exitConfirmed: true
  /** Omit an array to mean "everything eligible on that board". */
  memoryIds?: string[]
  mcpIds?: string[]
  automationIds?: string[]
  refresh?: boolean
}
