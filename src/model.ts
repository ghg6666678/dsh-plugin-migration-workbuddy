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
