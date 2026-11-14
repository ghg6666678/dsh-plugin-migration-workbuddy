import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MigrationApi } from './api.js'
import { ImportPanel } from './ImportPanel.js'
import { SECTION_CSS } from './section-css.js'

export type MigrationSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'migration.workbuddy'> & { api: MigrationApi; refreshSessions?: () => void }

/**
 * The migration settings section.
 *
 * This build carries one direction only: 导入数据 reads WorkBuddy and writes
 * DSH. The DSH -> WorkBuddy direction (export) is not part of this release, so
 * the section renders a single board with no tabs.
 */
export function MigrationSection({ t, api, refreshSessions }: MigrationSectionProps): React.ReactElement {
  return <section className="mwb-migration">
    <style>{SECTION_CSS}</style>
    <div className="mwb-migration-hero">
      <div className="mwb-migration-kicker">WORKBUDDY · DATA BRIDGE</div>
      <h2>{t('title')}</h2>
      <p>{t('intro')}</p>
    </div>
    <ImportPanel t={t} api={api} {...(refreshSessions ? { refreshSessions } : {})} />
  </section>
}
