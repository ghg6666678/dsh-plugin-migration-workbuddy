import z from '@deepseek-ai/schemastery'

export interface MigrationConfig {
  enabled: boolean
  maxFileBytes: number
  maxFiles: number
  /**
   * 'narrative' (default): flatten tool calls/results into plain text so an
   * imported history carries no tool-output protocol and always continues.
   * 'transcript': keep faithful assistant tool-call blocks + tool/result pairs.
   */
  toolMode: 'transcript' | 'narrative'
  /**
   * Model id written into every migrated automation. Empty (default) drops the
   * WorkBuddy model so the deployment default model is used; WorkBuddy's own
   * model vocabulary is not valid there.
   */
  automationModelId: string
  /**
   * WorkBuddy model ids that may be carried over verbatim because this
   * deployment serves them (e.g. `deepseek-v4-pro`). Everything else is
   * replaced by `automationModelId` or the deployment default.
   */
  automationModelAllowlist: string[]
}

export const Config: z<MigrationConfig> = z.object({
  enabled: z.boolean().default(true),
  maxFileBytes: z.number().step(1).min(1024).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  maxFiles: z.number().step(1).min(1).max(100_000).default(5_000),
  toolMode: (z.union(['transcript', 'narrative'] as const)).default('transcript'),
  automationModelId: z.string().default(''),
  automationModelAllowlist: z.array(z.string()).default([]),
})

export function normalizeMigrationConfig(raw: Partial<MigrationConfig> | undefined): MigrationConfig {
  return {
    enabled: raw?.enabled ?? true,
    maxFileBytes: raw?.maxFileBytes ?? 10 * 1024 * 1024,
    maxFiles: raw?.maxFiles ?? 5_000,
    toolMode: raw?.toolMode === 'narrative' ? 'narrative' : 'transcript',
    automationModelId: raw?.automationModelId?.trim() ?? '',
    automationModelAllowlist: (raw?.automationModelAllowlist ?? [])
      .map(item => item.trim())
      .filter(item => item.length > 0),
  }
}
