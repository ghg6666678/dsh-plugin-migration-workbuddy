import { useMemo, useState } from 'react'
import type { MigrationPreview, WorkspaceSummary } from '../model.js'
import type { MigrationLocaleKey } from './locales.js'
import { THEME_CSS } from './theme.js'

export interface SessionSelectionProps {
  t: (key: MigrationLocaleKey) => string
  sessions: MigrationPreview['sessions']
  workspaces: WorkspaceSummary[]
  selectedKeys: string[]
  onSelectionChange: (keys: string[]) => void
  onBack: () => void
}

const styles = THEME_CSS + `.mwb-picker{display:flex;flex-direction:column;gap:10px}.mwb-picker-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.mwb-picker-back{border:0;background:var(--mwb-subtle-bg,#eef4f5);color:var(--mwb-accent,#087f8c);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px}.mwb-picker-title{font-size:16px;font-weight:700}.mwb-picker-sum{font-size:13px;color:var(--mwb-text-2,#52606d)}.mwb-picker-sum b{color:var(--mwb-text,#17202a)}.mwb-picker-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.mwb-picker-chip{border:1px solid var(--mwb-border,#e3e8ef);border-radius:999px;padding:4px 12px;background:var(--mwb-surface,#fff);font-size:12px;cursor:pointer;color:var(--mwb-text-2,#52606d)}.mwb-picker-chip.active{background:var(--mwb-active-bg,#e6f6f5);border-color:var(--mwb-accent-text,#0d8b86);color:var(--mwb-accent-text,#0d8b86);font-weight:600}.mwb-picker-md{display:grid;grid-template-columns:minmax(180px,26%) minmax(0,1fr);border:1px solid var(--mwb-border,#e3e8ef);border-radius:14px;overflow:hidden;min-height:380px;max-height:56vh;resize:vertical}.mwb-picker-left{min-width:0;border-right:1px solid var(--mwb-border,#e3e8ef);background:var(--mwb-surface-2,#f7fafc);overflow:auto;padding:8px}.mwb-picker-right{min-width:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}.mwb-picker-ws{display:block;border:1px solid transparent;border-radius:10px;padding:10px;cursor:pointer}.mwb-picker-ws:hover{background:var(--mwb-surface,#fff);border-color:var(--mwb-border,#e3e8ef)}.mwb-picker-ws.active{background:var(--mwb-surface,#fff);border-color:var(--mwb-accent-text,#0d8b86);box-shadow:0 0 0 1px rgba(13,139,134,.2)}.mwb-picker-ws-row{display:flex;align-items:center;gap:8px}.mwb-picker-ws-title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mwb-picker-ws-counts{font-size:11px;line-height:15px;color:var(--mwb-text-3,#708090);margin:3px 0 0 26px;overflow-wrap:anywhere}.mwb-picker-check{width:15px;height:15px;accent-color:var(--mwb-accent-text,#0d8b86)}.mwb-picker-tag{border:1px solid var(--mwb-border,#e3e8ef);border-radius:6px;font-size:10px;color:var(--mwb-text-2,#52606d);padding:0 5px}.mwb-picker-badge{border-radius:999px;padding:1px 7px;font-size:10px;color:#fff;white-space:nowrap}.mwb-picker-badge.new{background:#0f9d91}.mwb-picker-badge.changed{background:#3b82f6}.mwb-picker-badge.repair{background:#d97706}.mwb-picker-badge.unchanged{background:#9aa5b1}.mwb-picker-badge.failed{background:#dc2626}.mwb-picker-search{flex:1 1 150px;min-width:130px;border:1px solid var(--mwb-border,#e3e8ef);border-radius:999px;padding:6px 12px;font:inherit;font-size:12px}.mwb-picker-right-title{font-weight:600;font-size:13px}.mwb-picker-row{display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--mwb-divider,#f0f3f7)}.mwb-picker-row:last-child{border-bottom:0}.mwb-picker-row.disabled{opacity:.55}.mwb-picker-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.mwb-picker-row-meta{font-size:11px;color:var(--mwb-text-3,#708090);white-space:nowrap}.mwb-picker-loss{display:inline-block;width:14px;height:14px;border-radius:50%;background:var(--mwb-warn-bg,#fef3c7);color:var(--mwb-warn-text,#92400e);font-size:10px;text-align:center;line-height:14px;cursor:help}.mwb-picker-empty{color:var(--mwb-text-3,#708090);text-align:center;padding:30px 0;font-size:12px}.mwb-picker-actions{display:flex;justify-content:flex-end;gap:10px}.mwb-picker-secondary{border:1px solid var(--mwb-border,#e3e8ef);border-radius:10px;padding:9px 16px;background:var(--mwb-surface,#fff);cursor:pointer}.mwb-picker-primary{border:0;border-radius:10px;padding:10px 16px;background:#0d8b86;color:#fff;font-weight:600;cursor:pointer}@media(max-width:820px){.mwb-picker-md{grid-template-columns:minmax(0,1fr);max-height:none;min-height:0}.mwb-picker-left{border-right:0;border-bottom:1px solid var(--mwb-border,#e3e8ef);max-height:34vh}}`

const STATUS_KEYS = { new: 'filterNew', changed: 'filterChanged', repair: 'filterRepair', unchanged: 'filterAll', failed: 'filterFailed' } as const

function isEligible(status: string): boolean {
  return status === 'new' || status === 'changed' || status === 'repair'
}

function isSelectable(status: string): boolean {
  return isEligible(status) || status === 'failed'
}

export function SessionSelection({ t, sessions, workspaces, selectedKeys, onSelectionChange, onBack }: SessionSelectionProps): React.ReactElement {
  const [activeId, setActiveId] = useState(workspaces[0]?.id ?? 'ungrouped')
  const [filter, setFilter] = useState<'all' | 'new' | 'changed' | 'repair' | 'failed'>('all')
  const [query, setQuery] = useState('')
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys])

  const activeWorkspace = workspaces.find(workspace => workspace.id === activeId) ?? workspaces[0]
  const list = sessions.filter(session => {
    const workspaceId = session.workspaceId ?? 'ungrouped'
    if (activeWorkspace !== undefined && workspaceId !== activeWorkspace.id) return false
    if (filter !== 'all' && session.status !== filter) return false
    if (query) {
      const q = query.toLowerCase()
      if (!session.title?.toLowerCase().includes(q) && !session.path.toLowerCase().includes(q)) return false
    }
    return true
  })

  const toggleKey = (key: string, checked: boolean): void => {
    const next = new Set(selectedKeys)
    if (checked) next.add(key)
    else next.delete(key)
    onSelectionChange([...next])
  }

  const toggleWorkspace = (workspace: WorkspaceSummary | undefined, checked: boolean): void => {
    const group = sessions.filter(session => (session.workspaceId ?? 'ungrouped') === (workspace?.id ?? 'ungrouped') && isSelectable(session.status))
    const next = new Set(selectedKeys)
    for (const session of group) { if (checked) next.add(session.key); else next.delete(session.key) }
    onSelectionChange([...next])
  }

  const groupState = (workspace: WorkspaceSummary | undefined): 'none' | 'some' | 'all' => {
    const group = sessions.filter(session => (session.workspaceId ?? 'ungrouped') === (workspace?.id ?? 'ungrouped') && isSelectable(session.status))
    if (group.length === 0) return 'none'
    const picked = group.filter(session => selected.has(session.key)).length
    if (picked === 0) return 'none'
    if (picked === group.length) return 'all'
    return 'some'
  }

  const filterChips: Array<{ value: 'all' | 'new' | 'changed' | 'repair' | 'failed'; label: string }> = [
    { value: 'all', label: t('filterAll') },
    { value: 'new', label: t('filterNew') },
    { value: 'changed', label: t('filterChanged') },
    { value: 'repair', label: t('filterRepair') },
    { value: 'failed', label: t('filterFailed') },
  ]

  const allEligibleSelected = sessions.filter(session => isEligible(session.status)).every(session => selected.has(session.key))
  const toggleSelectAll = (): void => {
    onSelectionChange(allEligibleSelected ? [] : sessions.filter(session => isEligible(session.status)).map(session => session.key))
  }

  return <div className="mwb-picker">
    <style>{styles}</style>
    <div className="mwb-picker-head">
      <button className="mwb-picker-back" type="button" onClick={onBack}>‹ {t('back')}</button>
      <span className="mwb-picker-title">{t('pickerTitle')}</span>
      <span className="mwb-picker-sum">{t('selectedHeader').replace('{selected}', String(selectedKeys.length)).replace('{total}', String(sessions.length)).replace('{eligible}', String(sessions.filter(session => isEligible(session.status)).length))}</span>
    </div>
    <div className="mwb-picker-tools">
      <button className="mwb-picker-chip" type="button" onClick={toggleSelectAll}>{allEligibleSelected ? t('clearAll') : t('selectImportable')}</button>
    </div>
    <div className="mwb-picker-md">
      <div className="mwb-picker-left">
        {workspaces.map(workspace => {
          const state = groupState(workspace)
          return <div className={`mwb-picker-ws ${activeWorkspace?.id === workspace.id ? 'active' : ''}`} key={workspace.id} onClick={() => setActiveId(workspace.id)}>
            <div className="mwb-picker-ws-row">
              <input
                className="mwb-picker-check"
                type="checkbox"
                checked={state === 'all'}
                ref={element => { if (element) element.indeterminate = state === 'some' }}
                onClick={event => event.stopPropagation()}
                onChange={event => toggleWorkspace(workspace, event.target.checked)}
              />
              <span className="mwb-picker-ws-title">
                {workspace.title ?? t('ungrouped')}
                <span className="mwb-picker-tag">{workspace.id === 'ungrouped' ? t('ungrouped') : workspace.mode === 'session' ? t('sessionMode') : t('workspaceTag')}</span>
                {workspace.id === 'ungrouped' ? <span title="无工作区归属，仅可按会话选择">⚠</span> : null}
              </span>
            </div>
            <div className="mwb-picker-ws-counts">共 {workspace.count} · {t('filterNew')} {workspace.newCount} · {t('filterChanged')} {workspace.changedCount} · {t('filterRepair')} {workspace.repairCount} · {t('filterAll')} {workspace.unchangedCount} · {t('filterFailed')} {workspace.failedCount}</div>
          </div>
        })}
      </div>
      <div className="mwb-picker-right">
        <span className="mwb-picker-right-title">{activeWorkspace?.title ?? t('ungrouped')}（{String(list.length)}）</span>
        <div className="mwb-picker-tools">
          {filterChips.map(chip => <button className={`mwb-picker-chip ${filter === chip.value ? 'active' : ''}`} type="button" key={chip.value} onClick={() => setFilter(chip.value)}>{chip.label}</button>)}
          <input className="mwb-picker-search" placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div>
          {list.length === 0 ? <div className="mwb-picker-empty">{t('noMatch')}</div> : list.map(session => {
            const disabled = !isSelectable(session.status)
            return <div className={`mwb-picker-row ${disabled ? 'disabled' : ''}`} key={session.key}>
              <input className="mwb-picker-check" type="checkbox" checked={selected.has(session.key)} disabled={disabled} onChange={event => toggleKey(session.key, event.target.checked)} />
              <span className="mwb-picker-row-title" title={session.path}>{session.title ?? session.sourceSessionId}</span>
              <span className={`mwb-picker-badge ${session.status}`}>{t(STATUS_KEYS[session.status as keyof typeof STATUS_KEYS] ?? 'filterAll')}</span>
              <span className="mwb-picker-tag">{session.mode === 'session' ? t('sessionMode') : t('workspaceTag')}</span>
              <span className="mwb-picker-row-meta">{String(session.eventCount)}</span>
              {session.loss.length > 0 ? <span className="mwb-picker-loss" title={session.loss.map(item => item.code).join('\n')}>{String(session.loss.length)}</span> : null}
            </div>
          })}
        </div>
      </div>
    </div>
    <div className="mwb-picker-actions">
      <button className="mwb-picker-secondary" type="button" onClick={onBack}>{t('cancel')}</button>
      <button className="mwb-picker-primary" type="button" onClick={onBack}>{t('finish')}（{String(selectedKeys.length)} 项）</button>
    </div>
  </div>
}
