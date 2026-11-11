import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MigrationApi } from './api.js'
import { ImportPanel } from './ImportPanel.js'
import { ExportPanel } from './ExportPanel.js'
import { SECTION_CSS } from './section-css.js'

export type MigrationSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'migration.workbuddy'> & { api: MigrationApi }

type Board = 'import' | 'export'

/**
 * The migration settings section, split into the two directions.
 *
 * 导入数据 reads WorkBuddy and writes DSH; 导出数据 writes WorkBuddy and needs the
 * app to be fully quit first. Keeping them on separate boards means the quit
 * checklist only appears on the side that actually touches WorkBuddy's files.
 */
export function MigrationSection({ t, api }: MigrationSectionProps): React.ReactElement {
  const [board, setBoard] = useState<Board>('import')
  return <section className="mwb-migration">
    <style>{SECTION_CSS}</style>
    <div className="mwb-migration-hero">
      <div className="mwb-migration-kicker">WORKBUDDY · DATA BRIDGE</div>
      <h2>{t('title')}</h2>
      <p>{t('intro')}</p>
    </div>
    <div className="mwb-migration-tabs" role="tablist">
      <button className="mwb-migration-tab" data-active={board === 'import'} type="button" role="tab" aria-selected={board === 'import'} onClick={() => setBoard('import')}>{t('tabImport')}</button>
      <button className="mwb-migration-tab" data-active={board === 'export'} type="button" role="tab" aria-selected={board === 'export'} onClick={() => setBoard('export')}>{t('tabExport')}</button>
    </div>
    {board === 'import' ? <ImportPanel t={t} api={api} /> : <ExportPanel t={t} api={api} />}
  </section>
}
