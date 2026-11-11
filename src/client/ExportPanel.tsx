import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExportPreview, ExportResult, ExportSessionSummary } from '../model.js'
import { blockedActivity, type MigrationApi } from './api.js'

export type ExportPanelProps = PropsLocale<'migration.workbuddy'> & { api: MigrationApi }

/** Statuses that have something for the export direction to write. */
function isWritable(item: ExportSessionSummary): boolean {
  return item.status === 'new' || item.status === 'ahead' || item.status === 'conflict'
}

/** Rows a plan would write, for the "N rows" hint. */
function rowCount(item: ExportSessionSummary): number {
  return item.pendingRows
}

export function ExportPanel({ t, api }: ExportPanelProps): React.ReactElement {
  const [preview, setPreview] = useState<ExportPreview>()
  const [result, setResult] = useState<ExportResult>()
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [blocked, setBlocked] = useState<ExportPreview['activity']>()
  const [running, setRunning] = useState(false)
  // Two dialogs: the pre-flight quit checklist, then the final go-ahead.
  const [step, setStep] = useState<'idle' | 'quit' | 'confirm'>('idle')
  const [noted, setNoted] = useState(false)
  const [undoing, setUndoing] = useState(false)

  const refresh = (options: { refresh?: boolean } = {}): void => {
    setLoading(true); setError(undefined)
    void api.exportPreview(options.refresh === true)
      .then(value => {
        setPreview(value)
        setBlocked(value.activity.running || !value.activity.observed ? value.activity : undefined)
        setSelected(current => {
          const writable = value.sessions.filter(isWritable).map(item => item.id)
          // Keep an explicit choice across refreshes, but never keep a session
          // that no longer needs writing.
          const kept = current.filter(id => writable.includes(id))
          return kept.length > 0 ? kept : writable
        })
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : t('loadFailed')))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const sessions = preview?.sessions ?? []
  const writable = useMemo(() => sessions.filter(isWritable), [sessions])
  const allSelected = writable.length > 0 && writable.every(item => selected.includes(item.id))
  const pendingRows = writable.filter(item => selected.includes(item.id)).reduce((total, item) => total + rowCount(item), 0)
  const summary = preview?.summary

  const begin = (): void => {
    setError(undefined); setNoted(false)
    // A live WorkBuddy short-circuits straight to the explanation.
    if (blocked !== undefined) { setStep('quit'); return }
    setStep('quit')
  }

  const run = async (): Promise<void> => {
    setStep('idle'); setRunning(true); setError(undefined)
    try {
      const value = await api.exportRun({ confirmed: true, exitConfirmed: true, sessionIds: selected, refresh: true })
      setResult(value)
      refresh({ refresh: true })
    } catch (cause) {
      const activity = blockedActivity(cause)
      if (activity !== undefined) { setBlocked(activity); setStep('quit') }
      else setError(cause instanceof Error ? cause.message : t('exportFailed'))
    } finally {
      setRunning(false)
    }
  }

  const undo = async (): Promise<void> => {
    setUndoing(true); setError(undefined)
    try {
      const value = await api.exportUndo()
      if (value.undone) { setResult(undefined); refresh({ refresh: true }) }
    } catch (cause) {
      const activity = blockedActivity(cause)
      if (activity !== undefined) { setBlocked(activity); setStep('quit') }
      else setError(cause instanceof Error ? cause.message : t('exportFailed'))
    } finally {
      setUndoing(false)
    }
  }

  const statusLabel = (status: ExportSessionSummary['status']): string => {
    switch (status) {
      case 'new': return t('exportStatusNew')
      case 'ahead': return t('exportStatusAhead')
      case 'synced': return t('exportStatusSynced')
      case 'workbuddy-ahead': return t('exportStatusWorkbuddyAhead')
      case 'conflict': return t('exportStatusConflict')
      case 'empty': return t('exportStatusEmpty')
      default: return t('exportStatusFailed')
    }
  }

  return <div className="mwb-migration-panel">
    <div className="mwb-migration-panel-head">
      <h3>{t('exportTitle')}</h3>
      <span>{t('exportIntro')}</span>
    </div>

    <div className="mwb-migration-toolbar">
      <span className="mwb-migration-source">
        {loading ? t('preview') : preview === undefined ? t('sourceMissing') : `${t('exportWorkbuddyRoot')}: ${preview.workbuddyRoot}`}
      </span>
      <button className="mwb-migration-refresh" type="button" disabled={loading} onClick={() => { refresh({ refresh: true }) }}>{t('exportRefresh')}</button>
    </div>

    {error !== undefined ? <div className="mwb-migration-error">{error}</div> : null}

    {blocked !== undefined
      ? <div className="mwb-migration-warn"><span>⚠</span><div><strong>{t('exportRunningTitle')}</strong>{t('exportRunningBody')}</div></div>
      : null}

    {summary !== undefined
      ? <div className="mwb-migration-summary">
          {([[summary.new, t('exportStatusNew')], [summary.ahead, t('exportStatusAhead')], [summary.synced, t('exportStatusSynced')], [summary.workbuddyAhead, t('exportStatusWorkbuddyAhead')]] as const).map(([count, label]) =>
            <div key={label}><b>{count}</b><span>{label}</span></div>)}
        </div>
      : null}

    {loading ? null
      : sessions.length === 0 ? <div className="mwb-migration-empty">{t('exportNoSessions')}</div>
        : writable.length === 0 && summary !== undefined && summary.workbuddyAhead === 0
          ? <div className="mwb-migration-empty">{t('exportNothing')}{summary.lastExportedAt === undefined ? '' : ` · ${t('exportLastExported')}: ${new Date(summary.lastExportedAt).toLocaleString()}`}</div>
          : <div className="mwb-migration-list">
              {sessions.filter(item => item.status !== 'empty').map(item =>
                <button
                  className="mwb-migration-row"
                  data-disabled={isWritable(item) ? undefined : 'true'}
                  key={item.id}
                  type="button"
                  onClick={() => { if (!isWritable(item)) return; setSelected(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id]) }}
                >
                  <input
                    className="mwb-migration-check"
                    type="checkbox"
                    checked={selected.includes(item.id)}
                    disabled={!isWritable(item)}
                    onChange={() => undefined}
                    onClick={event => event.stopPropagation()}
                  />
                  <span className="mwb-migration-row-main">
                    <span className="mwb-migration-row-title">{item.title ?? item.id}</span>
                    <span className="mwb-migration-row-sub">{item.detail ?? `${item.eventCount} 条事件 · ${String(rowCount(item))} 条待写入`}</span>
                  </span>
                  <span className="mwb-migration-badge" data-kind={item.status}>{statusLabel(item.status)}</span>
                </button>)}
            </div>}

    <div className="mwb-migration-safe"><span>⤴</span><div><strong>{t('exportTitle')}</strong><span>{t('exportRunBody')}</span></div></div>

    <div className="mwb-migration-actions">
      <label>
        <input
          type="checkbox"
          checked={allSelected}
          disabled={writable.length === 0}
          onChange={() => setSelected(allSelected ? [] : writable.map(item => item.id))}
        /> {t('exportSelectAll')}
      </label>
      <div style={{ display: 'flex', gap: 10 }}>
        {preview?.summary.lastExportedAt !== undefined
          ? <button className="mwb-migration-secondary" type="button" disabled={undoing || running} onClick={() => { void undo() }}>{t('exportUndo')}</button>
          : null}
        <button className="mwb-migration-primary" type="button" disabled={running || pendingRows === 0} onClick={begin}>
          {running ? t('exportWorking') : pendingRows === 0 ? t('exportNothing') : `${t('exportBegin')} · ${String(pendingRows)} ${t('exportRows')}`}
        </button>
      </div>
    </div>

    {result !== undefined
      ? <div className="mwb-migration-result">
          <div className="mwb-migration-stat"><b>{result.rows}</b><span>{t('exportRows')}</span></div>
          <div className="mwb-migration-stat"><b>{result.createdSessions}</b><span>{t('exportCreated')}</span></div>
          <div className="mwb-migration-stat"><b>{result.appendedSessions}</b><span>{t('exportAppended')}</span></div>
          <div className="mwb-migration-stat"><b>{result.skippedSessions}</b><span>{t('exportSkipped')}</span></div>
        </div>
      : null}

    {result !== undefined && result.pendingImport.length > 0
      ? <div className="mwb-migration-warn"><span>↩</span><div><strong>{t('exportPendingImport')}</strong>{result.pendingImport.map(item => item.title ?? item.sessionId).join('、')}</div></div>
      : null}

    {result !== undefined && result.errors.length > 0
      ? <div className="mwb-migration-error"><strong>{t('exportFailed')} · {result.errors.length}</strong><ul className="mwb-migration-audit-list">{result.errors.slice(0, 5).map((item, index) => <li key={`${item.sessionId}-${String(index)}`}>{item.message}</li>)}</ul></div>
      : null}

    {step !== 'idle'
      ? <div className="mwb-migration-modal" role="presentation">
          <div className="mwb-migration-dialog" role="dialog" aria-modal="true">
            {step === 'quit' ? <>
              <h3>{t('exportQuitTitle')}</h3>
              <p>{blocked !== undefined ? t('exportRunningBody') : t('exportQuitBody')}</p>
              <div className="mwb-migration-scope">{t('exportWorkbuddyRoot')}: {preview?.workbuddyRoot ?? '—'}</div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, fontSize: 13 }}>
                <input type="checkbox" checked={noted} onChange={() => setNoted(value => !value)} />
                {t('exportQuitConfirm')}
              </label>
              <div className="mwb-migration-dialog-actions">
                <button className="mwb-migration-secondary" type="button" onClick={() => setStep('idle')}>{t('exportQuitCancel')}</button>
                <button className="mwb-migration-primary" type="button" disabled={!noted || blocked !== undefined} onClick={() => setStep('confirm')}>{t('confirm')}</button>
              </div>
            </> : <>
              <h3>{t('exportRunTitle')}</h3>
              <p>{t('exportRunBody')}</p>
              <div className="mwb-migration-scope">{t('exportSummary')
                .replace('{total}', String(summary?.total ?? 0))
                .replace('{new}', String(summary?.new ?? 0))
                .replace('{ahead}', String(summary?.ahead ?? 0))
                .replace('{synced}', String(summary?.synced ?? 0))
                .replace('{workbuddyAhead}', String(summary?.workbuddyAhead ?? 0))
                .replace('{conflict}', String(summary?.conflict ?? 0))}</div>
              <div className="mwb-migration-scope">{t('exportBegin')} · {selected.length} · {pendingRows} {t('exportRows')}</div>
              <div className="mwb-migration-dialog-actions">
                <button className="mwb-migration-secondary" type="button" onClick={() => setStep('idle')}>{t('cancel')}</button>
                <button className="mwb-migration-primary" type="button" onClick={() => { void run() }}>{t('confirm')}</button>
              </div>
            </>}
          </div>
        </div>
      : null}
  </div>
}
