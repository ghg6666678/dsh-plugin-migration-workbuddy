import z from '@deepseek-ai/schemastery'

export interface MigrationConfig {
  enabled: boolean
  /** Per-file cap in bytes; 0 (default) means no cap at all. */
  maxFileBytes: number
  /** Estimated context-token budget for one imported seed; 0 = keep everything. */
  maxContextTokens: number
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
  /**
   * WorkBuddy data directory used by export. Empty (default) means
   * `$WORKBUDDY_HOME`, then `~/.workbuddy`.
   */
  workbuddyRoot: string
}

export const Config: z<MigrationConfig> = z.object({
  enabled: z.boolean().default(true),
  maxFileBytes: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  maxContextTokens: z.number().step(1).min(0).max(10_000_000).default(500_000),
  maxFiles: z.number().step(1).min(1).max(100_000).default(5_000),
  toolMode: (z.union(['transcript', 'narrative'] as const)).default('transcript'),
  automationModelId: z.string().default(''),
  automationModelAllowlist: z.array(z.string()).default([]),
  workbuddyRoot: z.string().default(''),
})

export function normalizeMigrationConfig(raw: Partial<MigrationConfig> | undefined): MigrationConfig {
  return {
    enabled: raw?.enabled ?? true,
    maxFileBytes: Math.max(0, raw?.maxFileBytes ?? 0),
    maxContextTokens: Math.max(0, raw?.maxContextTokens ?? 500_000),
    maxFiles: raw?.maxFiles ?? 5_000,
    toolMode: raw?.toolMode === 'narrative' ? 'narrative' : 'transcript',
    automationModelId: raw?.automationModelId?.trim() ?? '',
    automationModelAllowlist: (raw?.automationModelAllowlist ?? [])
      .map(item => item.trim())
      .filter(item => item.length > 0),
    workbuddyRoot: raw?.workbuddyRoot?.trim() ?? '',
  }
}
