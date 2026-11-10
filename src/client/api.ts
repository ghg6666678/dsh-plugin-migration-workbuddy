import type { MigrationPreview, MigrationResult } from '../model.js'

export interface MigrationApi {
  preview(): Promise<MigrationPreview>
  run(input: { confirmed: true; sessions: boolean; memories: boolean; mcp: boolean; automations?: boolean; force?: boolean; sessionKeys?: string[]; workspaceIds?: string[]; automationIds?: string[] }): Promise<MigrationResult>
  manifest(): Promise<Record<string, unknown>>
  setMemoryEnabled(id: string, enabled: boolean): Promise<void>
  deleteMemory(id: string): Promise<boolean>
}

/** Marker required by the host for mutating routes; keep in sync with src/routes.ts. */
const CLIENT_HEADER = 'x-workbuddy-migration'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { accept: 'application/json', [CLIENT_HEADER]: '1', ...(init?.body ? { 'content-type': 'application/json' } : {}) } })
  const raw = await response.text()
  let value: ({ error?: string } & T) | undefined
  try { value = raw.length > 0 ? JSON.parse(raw) as { error?: string } & T : undefined } catch { /* preserve plain-text server errors below */ }
  if (!response.ok) throw new Error(value?.error ?? (raw.trim() || `${response.status}`))
  if (value === undefined) throw new Error(`${response.status}: empty response`)
  return value
}

export function createMigrationApi(): MigrationApi {
  return {
    preview: () => request<MigrationPreview>('/api/migration/workbuddy/preview'),
    run: input => request<MigrationResult>('/api/migration/workbuddy/run', { method: 'POST', body: JSON.stringify(input) }),
    manifest: () => request<Record<string, unknown>>('/api/migration/workbuddy/manifest'),
    setMemoryEnabled: async (id, enabled) => { await request('/api/migration/workbuddy/memory/update', { method: 'POST', body: JSON.stringify({ id, enabled }) }) },
    deleteMemory: async id => (await request<{ ok: boolean }>('/api/migration/workbuddy/memory/delete', { method: 'POST', body: JSON.stringify({ id }) })).ok,
  }
}
