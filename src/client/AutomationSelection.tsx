import type { AutomationDraft } from '../automation.js'
import type { MigrationLocaleKey } from './locales.js'
import { THEME_CSS } from './theme.js'

export interface AutomationSelectionProps {
  t: (key: MigrationLocaleKey) => string
  drafts: AutomationDraft[]
  selectedKeys: string[]
  onSelectionChange: (keys: string[]) => void
  onBack: () => void
}

const styles = THEME_CSS + `.mwb-auto{display:flex;flex-direction:column;gap:10px}.mwb-auto-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.mwb-auto-back{border:0;background:var(--mwb-subtle-bg,#eef4f5);color:var(--mwb-accent,#087f8c);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px}.mwb-auto-title{font-size:16px;font-weight:700}.mwb-auto-sum{font-size:13px;color:var(--mwb-text-2,#52606d)}.mwb-auto-tools{display:flex;gap:8px}.mwb-auto-chip{border:1px solid var(--mwb-border,#e3e8ef);border-radius:999px;padding:4px 12px;background:var(--mwb-surface,#fff);font-size:12px;cursor:pointer;color:var(--mwb-text-2,#52606d)}.mwb-auto-list{border:1px solid var(--mwb-border,#e3e8ef);border-radius:14px;overflow:hidden}.mwb-auto-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--mwb-divider,#f0f3f7)}.mwb-auto-row:last-child{border-bottom:0}.mwb-auto-row.disabled{opacity:.55}.mwb-auto-check{width:15px;height:15px;accent-color:var(--mwb-accent-text,#0d8b86)}.mwb-auto-name{flex:1;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mwb-auto-meta{font-size:11px;color:var(--mwb-text-3,#708090);white-space:nowrap}.mwb-auto-tag{border:1px solid var(--mwb-border,#e3e8ef);border-radius:6px;font-size:10px;color:var(--mwb-text-2,#52606d);padding:0 5px}.mwb-auto-empty{color:var(--mwb-text-3,#708090);text-align:center;padding:30px 0;font-size:12px}.mwb-auto-actions{display:flex;justify-content:flex-end;gap:10px}.mwb-auto-secondary{border:1px solid var(--mwb-border,#e3e8ef);border-radius:10px;padding:9px 16px;background:var(--mwb-surface,#fff);cursor:pointer}.mwb-auto-primary{border:0;border-radius:10px;padding:10px 16px;background:#0d8b86;color:#fff;font-weight:600;cursor:pointer}`

export function AutomationSelection({ t, drafts, selectedKeys, onSelectionChange, onBack }: AutomationSelectionProps): React.ReactElement {
  const selected = new Set(selectedKeys)
  const eligible = drafts.filter(draft => draft.eligible === true && draft.triggerKind !== 'unsupported')
  const allSelected = eligible.length > 0 && eligible.every(draft => selected.has(draft.sourceId))
  const scheduleText = (draft: AutomationDraft): string => {
    if (draft.triggerKind === 'cron') return String(draft.cron ?? '')
    if (draft.triggerKind === 'single') return `${t('automationOnce')} ${String(draft.runAt ?? '')}`
    return draft.loss.map(item => item.detail).join('; ') || 'unsupported'
  }
  const toggle = (key: string, checked: boolean): void => {
    const next = new Set(selectedKeys)
    if (checked) next.add(key)
    else next.delete(key)
    onSelectionChange([...next])
  }
  const toggleAll = (): void => onSelectionChange(allSelected ? [] : eligible.map(draft => draft.sourceId))

  return <div className="mwb-auto">
    <style>{styles}</style>
    <div className="mwb-auto-head">
      <button className="mwb-auto-back" type="button" onClick={onBack}>‹ {t('back')}</button>
      <span className="mwb-auto-title">{t('automations')}</span>
      <span className="mwb-auto-sum">{t('selectedHeader').replace('{selected}', String(selectedKeys.length)).replace('{total}', String(drafts.length)).replace('{eligible}', String(eligible.length))}</span>
    </div>
    <div className="mwb-auto-tools">
      <button className="mwb-auto-chip" type="button" onClick={toggleAll}>{allSelected ? t('clearAll') : t('selectImportable')}</button>
    </div>
    <div className="mwb-auto-list">
      {drafts.length === 0 ? <div className="mwb-auto-empty">{t('automationNone')}</div> : drafts.map(draft => {
        const disabled = draft.eligible !== true || draft.triggerKind === 'unsupported'
        return <div className={`mwb-auto-row ${disabled ? 'disabled' : ''}`} key={draft.sourceId}>
          <input className="mwb-auto-check" type="checkbox" checked={selected.has(draft.sourceId)} disabled={disabled} onChange={event => toggle(draft.sourceId, event.target.checked)} />
          <span className="mwb-auto-name" title={draft.prompt}>{draft.name}</span>
          <span className="mwb-auto-tag">{draft.status === 'unchanged' ? t('upToDate') : t('filterNew')}</span>
          <span className="mwb-auto-meta">{scheduleText(draft)}</span>
          <span className="mwb-auto-meta">{draft.modelId ?? ''}</span>
        </div>
      })}
    </div>
    <div className="mwb-auto-actions">
      <button className="mwb-auto-secondary" type="button" onClick={onBack}>{t('cancel')}</button>
      <button className="mwb-auto-primary" type="button" onClick={onBack}>{t('finish')}（{String(selectedKeys.length)} 项）</button>
    </div>
  </div>
}
