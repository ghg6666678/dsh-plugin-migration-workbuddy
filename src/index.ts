import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { Config, normalizeMigrationConfig } from './config.js'
import { ExportService } from './export-service.js'
import { registerExportRoutes, registerMigrationRoutes } from './routes.js'
import { MigrationService } from './service.js'

export const name = 'migration-workbuddy'
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry']
export const ConfigSchema = Config

/** A deployment-provided channel that persists one imported automation rule. */
interface AutomationImportChannel {
  saveRule?: (rule: unknown) => Promise<unknown>
}

/** The plugin is available by default; import routes remain preview-first. */
export function apply(ctx: Context, rawConfig: Partial<ReturnType<typeof normalizeMigrationConfig>> | undefined): void {
  const config = normalizeMigrationConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger.info('dsh-plugin-migration-workbuddy: disabled; no WorkBuddy files will be scanned')
    return
  }
  // Automation rules are written through the `automationImport` channel when the
  // deployment registers one. No channel is a dependency of this plugin:
  // without one the preview still lists automation drafts but reports them
  // ineligible, and an explicit automation import skips them with a loss record
  // instead of failing the batch.
  const channel = ctx.get('automationImport') as AutomationImportChannel | undefined
  const bound = channel === undefined ? undefined : channel.saveRule
  const saveAutomationRule = bound === undefined
    ? undefined
    : async (rule: unknown): Promise<void> => { await bound.call(channel, rule) }
  const service = new MigrationService(ctx.sessionPersistence, ctx.get('workspaceRegistry'), {
    maxFileBytes: config.maxFileBytes,
    maxContextTokens: config.maxContextTokens,
    maxFiles: config.maxFiles,
    toolMode: config.toolMode,
    automationModelId: config.automationModelId,
    automationModelAllowlist: config.automationModelAllowlist,
    ...(saveAutomationRule === undefined ? {} : { saveAutomationRule }),
  })
  ctx.effect(
    () => registerMigrationRoutes(ctx.webServer, config, service),
    'dsh-plugin-migration-workbuddy: migration routes',
  )
  // The DSH -> WorkBuddy direction is a separate service: it writes into
  // another application's data directory, keeps its own journal, and refuses to
  // run while WorkBuddy is alive.
  const exporter = new ExportService(ctx.sessionPersistence, {
    ...(config.workbuddyRoot === '' ? {} : { root: config.workbuddyRoot }),
  })
  ctx.effect(
    () => registerExportRoutes(ctx.webServer, exporter),
    'dsh-plugin-migration-workbuddy: export routes',
  )
  ctx.logger.info('dsh-plugin-migration-workbuddy: WorkBuddy import and export enabled')
}

export * from './model.js'
export * from './probe.js'
export * from './converter.js'
export * from './exporter.js'
export * from './export-service.js'
export * from './workbuddy-process.js'
export * from './memory.js'
export * from './mcp.js'
export * from './service.js'
