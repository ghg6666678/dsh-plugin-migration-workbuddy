import type { ExportPreview, ExportResult, MigrationPreview, MigrationResult } from '../model.js'

export interface MigrationSettings {
  maxFileBytes?: number
  maxContextTokens?: number
}

export interface ExportRunInput {
  /** Always true; the host rejects a run without it. */
  confirmed: true
  /** Proof that the user confirmed every WorkBuddy conversation finished and it was quit. */
  exitConfirmed: true
  sessionIds?: string[]
  mode?: 'auto' | 'new-session'
  refresh?: boolean
}

export interface ExportUndoResult {
  undone: boolean
  batchId?: string
  files: number
  sessions: number
}

export interface ExportHistoryEntry {
  id: string
  startedAt: string
  finishedAt?: string
  status: string
  sessions: number
  rows: number
}

export interface MigrationApi {
  preview(): Promise<MigrationPreview>
  run(input: { confirmed: true; sessions: boolean; memories: boolean; mcp: boolean; automations?: boolean; force?: boolean; sessionKeys?: string[]; workspaceIds?: string[]; automationIds?: string[] }): Promise<MigrationResult>
  manifest(): Promise<Record<string, unknown>>
  settings(): Promise<MigrationSettings>
  saveSettings(input: MigrationSettings): Promise<MigrationSettings>
  setMemoryEnabled(id: string, enabled: boolean): Promise<void>
  deleteMemory(id: string): Promise<boolean>
  exportPreview(refresh?: boolean): Promise<ExportPreview>
  exportRun(input: ExportRunInput): Promise<ExportResult>
  exportUndo(batchId?: string): Promise<ExportUndoResult>
  exportHistory(): Promise<ExportHistoryEntry[]>
}

/** Marker required by the host for mutating routes; keep in sync with src/routes.ts. */
const CLIENT_HEADER = 'x-workbuddy-migration'

const EXPORT_BASE = '/api/migration/workbuddy/export'

interface Failure extends Error {
  /** Set when the host refused because WorkBuddy is still alive (HTTP 409). */
  activity?: ExportPreview['activity']
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { accept: 'application/json', [CLIENT_HEADER]: '1', ...(init?.body ? { 'content-type': 'application/json' } : {}) } })
  const raw = await response.text()
  let value: ({ error?: string; activity?: ExportPreview['activity'] } & T) | undefined
  try { value = raw.length > 0 ? JSON.parse(raw) as { error?: string; activity?: ExportPreview['activity'] } & T : undefined } catch { /* preserve plain-text server errors below */ }
  if (!response.ok) {
    // A 409 carries the evidence of a live WorkBuddy instance, which the panel
    // turns into the "quit it first" step instead of a generic error line.
    const failure: Failure = new Error(value?.error ?? (raw.trim() || `${response.status}`))
    if (value?.activity !== undefined) failure.activity = value.activity
    throw failure
  }
  if (value === undefined) throw new Error(`${response.status}: empty response`)
  return value
}

export function createMigrationApi(): MigrationApi {
  return {
    preview: () => request<MigrationPreview>('/api/migration/workbuddy/preview'),
    run: input => request<MigrationResult>('/api/migration/workbuddy/run', { method: 'POST', body: JSON.stringify(input) }),
    manifest: () => request<Record<string, unknown>>('/api/migration/workbuddy/manifest'),
    settings: () => request<MigrationSettings>('/api/migration/workbuddy/settings'),
    saveSettings: input => request<MigrationSettings>('/api/migration/workbuddy/settings', { method: 'POST', body: JSON.stringify(input) }),
    setMemoryEnabled: async (id, enabled) => { await request('/api/migration/workbuddy/memory/update', { method: 'POST', body: JSON.stringify({ id, enabled }) }) },
    deleteMemory: async id => (await request<{ ok: boolean }>('/api/migration/workbuddy/memory/delete', { method: 'POST', body: JSON.stringify({ id }) })).ok,
    exportPreview: async refresh => (refresh === true
      ? request<ExportPreview>(`${EXPORT_BASE}/preview`, { method: 'POST', body: JSON.stringify({ refresh: true }) })
      : request<ExportPreview>(`${EXPORT_BASE}/preview`)),
    exportRun: input => request<ExportResult>(`${EXPORT_BASE}/run`, { method: 'POST', body: JSON.stringify(input) }),
    exportUndo: batchId => request<ExportUndoResult>(`${EXPORT_BASE}/undo`, { method: 'POST', body: JSON.stringify(batchId === undefined ? {} : { batchId }) }),
    exportHistory: async () => (await request<{ batches: ExportHistoryEntry[] }>(`${EXPORT_BASE}/history`)).batches,
  }
}

/** The `activity` payload of a 409, if the failure carries one. */
export function blockedActivity(cause: unknown): ExportPreview['activity'] | undefined {
  return cause instanceof Error && 'activity' in cause ? (cause as Failure).activity : undefined
}
