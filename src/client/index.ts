import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createMigrationApi } from './api.js'
import { MigrationSection } from './MigrationSectionV2.js'
import { en, zh, type MigrationLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'migration.workbuddy': MigrationLocaleKey } }
export const inject = ['slots', 'locale']
const NS = 'migration.workbuddy'
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const api = createMigrationApi()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-migration-workbuddy: dictionaries')
  /**
   * Pull the Session list again after an import.
   *
   * The plugin writes session logs straight to disk, so the Host never emits
   * `api-session/added` for them: that event is only produced for a live
   * Session the Host itself created. The sidebar is event-driven and does not
   * poll, so freshly imported conversations stayed invisible until the whole
   * Harness was restarted. `sessions.refresh()` re-runs `session.list`, which
   * rescans the session directories on every call, so the new rows appear at
   * once. The service is looked up lazily because this plugin does not depend
   * on the session controller, and a missing service must not break the panel.
   */
  const refreshSessions = (): void => {
    try {
      const sessions = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessions') as
        | { refresh?: () => Promise<unknown> }
        | undefined
      void sessions?.refresh?.()?.catch(() => undefined)
    } catch { /* a sidebar refresh failure must never surface as an import error */ }
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'migration.workbuddy', order: 230, label: () => t('nav'), locale: NS, inject: () => ({ api, refreshSessions }) }, MigrationSection))
}
