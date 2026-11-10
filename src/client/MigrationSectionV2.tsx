import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MigrationApi } from './api.js'
import type { MigrationPreview, MigrationResult } from '../model.js'
import { SessionSelection } from './SessionSelection.js'
import { AutomationSelection } from './AutomationSelection.js'
import { THEME_CSS } from './theme.js'

export type MigrationSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'migration.workbuddy'> & { api: MigrationApi }

const styles = THEME_CSS + `.mwb-migration{max-width:900px;color:var(--mwb-text,#17202a);display:flex;flex-direction:column;gap:20px}.mwb-migration-hero{padding:28px;border-radius:22px;background:linear-gradient(135deg,#102a43,#176b87 55%,#7dd3b0 140%);color:#fff}.mwb-migration-kicker{font-size:12px;letter-spacing:.12em;opacity:.72}.mwb-migration h2{margin:8px 0 6px;font-size:25px}.mwb-migration-hero p{margin:0;line-height:22px;color:rgba(255,255,255,.82)}.mwb-migration-toolbar,.mwb-migration-actions{display:flex;justify-content:space-between;align-items:center;gap:12px}.mwb-migration-source{font-size:13px;color:var(--mwb-text-2,#52606d)}.mwb-migration-refresh,.mwb-migration-link{border:0;background:transparent;color:var(--mwb-accent,#087f8c);cursor:pointer;font:inherit}.mwb-migration-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}@media(max-width:640px){.mwb-migration-grid{grid-template-columns:1fr}}.mwb-migration-card{border:1px solid var(--mwb-border,#e3e8ef);border-radius:16px;padding:16px;text-align:left;background:var(--mwb-surface,#fff);cursor:pointer}.mwb-migration-card[data-selected=true]{border-color:#1aa6a6;box-shadow:0 0 0 2px rgba(26,166,166,.14)}.mwb-migration-card-top{display:flex;justify-content:space-between}.mwb-migration-icon{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:var(--mwb-icon-bg,#e8f7f4);color:var(--mwb-accent,#087f8c);font-size:18px}.mwb-migration-count{font-size:28px;font-weight:700;color:var(--mwb-text,#102a43);margin-top:10px}.mwb-migration-label{font-weight:600}.mwb-migration-hint{font-size:12px;line-height:18px;color:var(--mwb-text-3,#708090);margin-top:4px}.mwb-migration-check{accent-color:#0f9d91}.mwb-migration-status{padding:12px 16px;border-radius:12px;background:var(--mwb-surface-2,#f7fafc);color:var(--mwb-text-2,#52606d);font-size:13px}.mwb-migration-safe{display:flex;gap:12px;padding:14px 16px;border-radius:14px;background:var(--mwb-safe-bg,#f0faf8);border:1px solid var(--mwb-safe-border,#c6eee4)}.mwb-migration-safe strong{display:block;font-size:13px}.mwb-migration-safe span{display:block;font-size:12px;line-height:18px;color:var(--mwb-safe-text,#4e6b6b);margin-top:3px}.mwb-migration-primary{border:0;border-radius:12px;padding:11px 18px;background:#0d8b86;color:#fff;font-weight:600;cursor:pointer}.mwb-migration-primary:disabled{opacity:.48;cursor:not-allowed}.mwb-migration-empty,.mwb-migration-error{padding:24px;border-radius:14px;background:var(--mwb-surface-2,#f8fafc);text-align:center;color:var(--mwb-text-2,#667085)}.mwb-migration-error{color:var(--mwb-error-text,#b42318);background:var(--mwb-error-bg,#fff5f5)}.mwb-migration-result{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.mwb-migration-stat{padding:14px;border-radius:14px;background:var(--mwb-surface-2,#f7fafc)}.mwb-migration-stat b{display:block;font-size:23px;color:var(--mwb-text,#102a43)}.mwb-migration-stat span{font-size:12px;color:var(--mwb-text-2,#667085)}.mwb-migration-modal{position:fixed;inset:0;background:var(--mwb-mask,rgba(16,42,67,.35));display:grid;place-items:center;z-index:10}.mwb-migration-dialog{width:min(560px,calc(100vw - 40px));max-height:calc(100vh - 40px);overflow:auto;background:var(--mwb-surface,#fff);border-radius:18px;padding:22px;box-shadow:0 20px 50px var(--mwb-shadow,rgba(16,42,67,.2))}.mwb-migration-dialog h3{margin:0 0 8px}.mwb-migration-dialog p{font-size:13px;line-height:20px;color:var(--mwb-text-2,#667085)}.mwb-migration-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.mwb-migration-secondary{border:1px solid var(--mwb-border,#d0d5dd);border-radius:10px;padding:9px 14px;background:var(--mwb-surface,#fff);cursor:pointer}.mwb-migration-audit-list{max-height:300px;overflow:auto;margin:14px 0 0;padding:0;list-style:none;border:1px solid var(--mwb-divider,#edf0f4);border-radius:12px}.mwb-migration-audit-list li{padding:10px 12px;border-bottom:1px solid var(--mwb-divider,#edf0f4);font-size:12px}.mwb-migration-audit-list li:last-child{border-bottom:0}.mwb-migration-audit-title{font-weight:600;color:var(--mwb-text,#102a43);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mwb-migration-audit-path{margin-top:3px;color:var(--mwb-text-3,#8a94a6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mwb-migration-audit-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.mwb-migration-audit-summary div{padding:10px;border-radius:10px;background:var(--mwb-surface-2,#f7fafc);text-align:center}.mwb-migration-audit-summary b{display:block;font-size:20px;color:var(--mwb-accent-text,#0d8b86)}.mwb-migration-audit-summary span{font-size:11px;color:var(--mwb-text-2,#667085)}.mwb-migration-scope{background:var(--mwb-surface-2,#f7fafc);border:1px solid var(--mwb-border,#e3e8ef);border-radius:10px;padding:9px 12px;font-size:13px;margin-top:6px}`

export function MigrationSection({ t, api }: MigrationSectionProps): React.ReactElement {
  const [preview, setPreview] = useState<MigrationPreview>()
  const [result, setResult] = useState<MigrationResult>()
  const [selected, setSelected] = useState({ sessions: true, memories: true, mcp: true })
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [view, setView] = useState<'overview' | 'picker' | 'automation'>('overview')
  const [selectedAutomations, setSelectedAutomations] = useState(true)
  const [automationKeys, setAutomationKeys] = useState<string[]>([])
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string>()
  const [manifest, setManifest] = useState<Record<string, unknown>>()
  const [manifestLoading, setManifestLoading] = useState(false)
  const [manifestError, setManifestError] = useState<string>()

  const eligibleItems = (value: MigrationPreview | undefined): MigrationPreview['sessions'] => value?.sessions.filter(item => item.status === 'new' || item.status === 'changed' || item.status === 'repair') ?? []

  const refresh = (): void => {
    setLoading(true); setError(undefined)
    void api.preview().then(value => { setPreview(value); setSelectedKeys(eligibleItems(value).map(item => item.key)); setAutomationKeys(value.automations.filter(item => item.eligible === true && item.triggerKind !== 'unsupported').map(item => item.sourceId)); setSelectedAutomations(value.summary.automationEligible > 0); setSelected(current => ({ ...current, sessions: value.summary.eligible - value.summary.memoryEligible - value.summary.mcpEligible - value.summary.automationEligible > 0 })) }).catch(cause => setError(cause instanceof Error ? cause.message : t('loadFailed'))).finally(() => setLoading(false))
  }
  useEffect(() => { refresh() }, [])

  const run = async (): Promise<void> => {
    setConfirming(false); setRunning(true); setError(undefined)
    const allEligibleSelected = eligibleItems(preview).every(item => selectedKeys.includes(item.key))
    const sessionPayload = selected.sessions && selectedKeys.length === 0
      ? { sessions: false as const }
      : selected.sessions && !allEligibleSelected
        ? { sessions: true as const, sessionKeys: selectedKeys }
        : { sessions: true as const }
    const automationPayload = !selectedAutomations || automationKeys.length === 0
      ? { automations: false as const }
      : automationKeys.length < counts.automationEligible
        ? { automations: true as const, automationIds: automationKeys }
        : { automations: true as const }
    try { const migrated = await api.run({ confirmed: true, memories: selected.memories, mcp: selected.mcp, ...sessionPayload, ...automationPayload }); setResult(migrated); refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : t('runFailed')) } finally { setRunning(false) }
  }
  const openManifest = async (): Promise<void> => {
    setManifestLoading(true); setManifestError(undefined)
    try { setManifest(await api.manifest()) } catch (cause) { setManifestError(cause instanceof Error ? cause.message : t('loadFailed')) } finally { setManifestLoading(false) }
  }

  const counts = preview?.summary ?? { sessions: 0, memories: 0, mcp: 0, automations: 0, automationEligible: 0, lossyFields: 0, skippedSecrets: 0, eligible: 0, unchanged: 0, changed: 0, repair: 0, memoryEligible: 0, mcpEligible: 0, excludedDeletedSessions: 0, excludedMissingWorkspaces: 0 }
  const sessionEligible = Math.max(0, counts.eligible - counts.memoryEligible - counts.mcpEligible)
  const total = counts.sessions + counts.memories + counts.mcp
  const canRun = (selected.sessions && selectedKeys.length > 0) || (selected.memories && counts.memoryEligible > 0) || (selected.mcp && counts.mcpEligible > 0) || (selectedAutomations && automationKeys.length > 0)
  const sessionModeCount = preview?.sessions.filter(item => item.mode === 'session').length ?? 0
  const workspaceModeCount = preview?.sessions.filter(item => item.mode === 'workspace').length ?? 0
  const sessionHint = `${t('sessionsHint')} · ${t('sessionMode')}: ${sessionModeCount} · ${t('workspaceMode')}: ${workspaceModeCount}`
  const allEligibleSelected = eligibleItems(preview).length > 0 && eligibleItems(preview).every(item => selectedKeys.includes(item.key))
  const handleSessionSingleClick = (): void => {
    if (clickTimer.current !== null) { clearTimeout(clickTimer.current); clickTimer.current = null; return }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      setSelectedKeys(allEligibleSelected ? [] : eligibleItems(preview).map(item => item.key))
    }, 200)
  }
  const handleSessionDoubleClick = (): void => {
    if (clickTimer.current !== null) { clearTimeout(clickTimer.current); clickTimer.current = null }
    setView('picker')
  }
  const scopeSummary = ((): string => {
    if (preview === undefined) return ''
    const picked = preview.sessions.filter(item => selectedKeys.includes(item.key))
    const wsIds = new Set(picked.map(item => item.workspaceId).filter(item => item !== undefined))
    const titles = preview.workspaces.filter(item => wsIds.has(item.id)).map(item => item.title ?? t('ungrouped'))
    const c = { n: 0, ch: 0, r: 0, f: 0 }
    for (const item of picked) { if (item.status === 'new') c.n += 1; else if (item.status === 'changed') c.ch += 1; else if (item.status === 'repair') c.r += 1; else if (item.status === 'failed') c.f += 1 }
    return t('scopeSummary')
      .replace('{spaces}', String(titles.length))
      .replace('{spaceNames}', `${titles.slice(0, 3).join('、')}${titles.length > 3 ? ' 等' : ''}`)
      .replace('{sessions}', String(picked.length))
      .replace('{newCount}', String(c.n))
      .replace('{changedCount}', String(c.ch))
      .replace('{repairCount}', String(c.r))
      .replace('{failed}', c.f > 0 ? `、${t('filterFailed')} ${String(c.f)}` : '')
  })() + (selectedAutomations && automationKeys.length > 0 ? ` · ${t('automations')} ${String(automationKeys.length)}` : '')
  const cards = [['sessions', '◌', counts.sessions, t('sessions'), sessionHint], ['memories', '✦', counts.memories, t('memories'), t('memoriesHint')], ['mcp', '⌘', counts.mcp, t('mcp'), t('mcpHint')], ['automations', '⏱', counts.automations, t('automations'), t('automationsHint')]] as const
  const allSelected = selected.sessions && selected.memories && selected.mcp && selectedAutomations
  const manifestSessions = Array.isArray(manifest?.sessions) ? manifest.sessions.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []
  const manifestMemories = Array.isArray(manifest?.memories) ? manifest.memories.length : 0
  const manifestMcp = Array.isArray(manifest?.mcp) ? manifest.mcp.length : 0

  if (view === 'picker' && preview !== undefined) {
    return <SessionSelection t={t} sessions={preview.sessions} workspaces={preview.workspaces} selectedKeys={selectedKeys} onSelectionChange={setSelectedKeys} onBack={() => setView('overview')} />
  }
  if (view === 'automation' && preview !== undefined) {
    return <AutomationSelection t={t} drafts={preview.automations} selectedKeys={automationKeys} onSelectionChange={setAutomationKeys} onBack={() => setView('overview')} />
  }
  return <section className="mwb-migration"><style>{styles}</style>
    <div className="mwb-migration-hero"><div className="mwb-migration-kicker">WORKBUDDY · DATA BRIDGE</div><h2>{t('title')}</h2><p>{t('intro')}</p></div>
    <div className="mwb-migration-toolbar"><span className="mwb-migration-source">{loading ? t('preview') : total > 0 ? `✓ ${t('sourceFound')}` : t('sourceMissing')}</span><button className="mwb-migration-refresh" type="button" onClick={refresh} disabled={loading}>{t('refresh')}</button></div>
    {error ? <div className="mwb-migration-error">{error}</div> : null}
    {loading ? null : preview && total > 0 ? <>
      <div className="mwb-migration-status">{canRun ? `${t('newItems')} ${Math.max(0, sessionEligible - counts.changed - counts.repair)} · ${t('changedItems')} ${counts.changed} · ${t('repairItems')} ${counts.repair} · ${t('memories')} ${counts.memoryEligible} · ${t('mcp')} ${counts.mcpEligible}` : t('upToDate')}{counts.lastImportedAt ? ` · ${t('lastImported')}: ${new Date(counts.lastImportedAt).toLocaleString()}` : ''}{counts.excludedDeletedSessions > 0 || counts.excludedMissingWorkspaces > 0 ? ` · ${t('excluded').replace('{deleted}', String(counts.excludedDeletedSessions)).replace('{missing}', counts.excludedMissingWorkspaces > 0 ? ` + ${String(counts.excludedMissingWorkspaces)} ${t('workspaceMode')}` : '')}` : ''}</div>
      <div className="mwb-migration-grid">{cards.map(([key, icon, count, label, hint]) => key === 'sessions'
        ? <button className="mwb-migration-card" data-selected={selectedKeys.length > 0 ? 'true' : undefined} key={key} type="button" onClick={handleSessionSingleClick} onDoubleClick={handleSessionDoubleClick}>
            <div className="mwb-migration-card-top"><span className="mwb-migration-icon">{icon}</span><input className="mwb-migration-check" type="checkbox" checked={allEligibleSelected} onChange={event => setSelectedKeys((event.target as HTMLInputElement).checked ? eligibleItems(preview).map(item => item.key) : [])} onClick={event => event.stopPropagation()} /></div>
            <div className="mwb-migration-count">{count}</div><div className="mwb-migration-label">{label}</div><div className="mwb-migration-hint">{hint}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 }}><span style={{ fontSize: 12, color: 'var(--mwb-accent,#087f8c)', fontWeight: 600 }}>{t('selectedHeader').replace('{selected}', String(selectedKeys.length)).replace('{total}', String(counts.sessions)).replace('{eligible}', String(sessionEligible))}</span><span style={{ fontSize: 12, color: 'var(--mwb-text-3,#708090)' }}>{t('doubleClick')}</span></div>
          </button>
        : key === 'automations'
          ? <button className="mwb-migration-card" data-selected={selectedAutomations ? 'true' : undefined} key={key} type="button" onClick={() => setSelectedAutomations(value => !value)} onDoubleClick={() => setView('automation')}>
              <div className="mwb-migration-card-top"><span className="mwb-migration-icon">{icon}</span><input className="mwb-migration-check" type="checkbox" checked={selectedAutomations} onChange={() => setSelectedAutomations(value => !value)} onClick={event => event.stopPropagation()} /></div>
              <div className="mwb-migration-count">{count}</div><div className="mwb-migration-label">{label}</div><div className="mwb-migration-hint">{hint}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 }}><span style={{ fontSize: 12, color: 'var(--mwb-accent,#087f8c)', fontWeight: 600 }}>{t('selectedHeader').replace('{selected}', String(automationKeys.length)).replace('{total}', String(counts.automations)).replace('{eligible}', String(counts.automationEligible))}</span><span style={{ fontSize: 12, color: 'var(--mwb-text-3,#708090)' }}>{t('doubleClick')}</span></div>
            </button>
        : <button className="mwb-migration-card" data-selected={selected[key] ? 'true' : undefined} key={key} type="button" onClick={() => setSelected(value => ({ ...value, [key]: !value[key] }))}><div className="mwb-migration-card-top"><span className="mwb-migration-icon">{icon}</span><input className="mwb-migration-check" type="checkbox" checked={selected[key]} onChange={() => setSelected(value => ({ ...value, [key]: !value[key] }))} onClick={event => event.stopPropagation()} /></div><div className="mwb-migration-count">{count}</div><div className="mwb-migration-label">{label}</div><div className="mwb-migration-hint">{hint}</div></button>)}</div>
      <div className="mwb-migration-safe"><span>⌁</span><div><strong>{t('safeTitle')}</strong><span>{t('safeBody')}</span></div></div>
      {result ? <><h3>{result.errors.length > 0 ? t('failed') : t('done')}</h3><div className="mwb-migration-result"><div className="mwb-migration-stat"><b>{result.importedSessions + result.importedMemories + result.importedMcp}</b><span>{t('imported')}</span></div><div className="mwb-migration-stat"><b>{result.skippedSessions + result.skippedMemories + result.skippedMcp}</b><span>{t('skipped')}</span></div><div className="mwb-migration-stat"><b>{result.loss.length}</b><span>{t('lossy')}</span></div><div className="mwb-migration-stat"><b>✓</b><span>{t('secrets')}</span></div></div>{result.errors.length > 0 ? <div className="mwb-migration-error"><strong>{t('importErrors')} · {result.errors.length}</strong><ul className="mwb-migration-audit-list">{result.errors.slice(0, 5).map((item, index) => <li key={index}>{item.message}</li>)}</ul>{result.errors.length > 5 ? <span>{`… +${String(result.errors.length - 5)}`}</span> : null}</div> : null}<button className="mwb-migration-link" type="button" onClick={() => { void openManifest() }}>{t('viewManifest')}</button></> : <div className="mwb-migration-actions"><label><input type="checkbox" checked={allSelected} onChange={() => { const next = !allSelected; setSelected({ sessions: next, memories: next, mcp: next }); setSelectedAutomations(next) }} /> {t('selectAll')}</label><button className="mwb-migration-primary" type="button" disabled={running || !canRun} onClick={() => setConfirming(true)}>{running ? t('working') : canRun ? t('incrementalBegin') : t('upToDate')}</button></div>}
    </> : <div className="mwb-migration-empty">{t('noData')}</div>}
    {confirming ? <div className="mwb-migration-modal" role="presentation"><div className="mwb-migration-dialog" role="dialog" aria-modal="true"><h3>{t('confirmTitle')}</h3><p>{t('confirmBody')}</p>{scopeSummary ? <div className="mwb-migration-scope">{scopeSummary}</div> : null}{selectedAutomations && automationKeys.length > 0 ? <div className="mwb-migration-scope">{t('automationPermission')} · {t('automationLive')}</div> : null}<div className="mwb-migration-dialog-actions"><button className="mwb-migration-secondary" type="button" onClick={() => setConfirming(false)}>{t('cancel')}</button><button className="mwb-migration-primary" type="button" onClick={() => { void run() }}>{t('confirm')}</button></div></div></div> : null}
    {manifestLoading || manifestError || manifest ? <div className="mwb-migration-modal" role="presentation"><div className="mwb-migration-dialog" role="dialog" aria-modal="true"><h3>{t('auditTitle')}</h3>{manifestLoading ? <p>{t('preview')}</p> : manifestError ? <div className="mwb-migration-error">{manifestError}</div> : manifestSessions.length === 0 && manifestMemories === 0 && manifestMcp === 0 ? <p>{t('auditEmpty')}</p> : <><div className="mwb-migration-audit-summary"><div><b>{manifestSessions.length}</b><span>{t('auditSessions')}</span></div><div><b>{manifestMemories}</b><span>{t('auditMemories')}</span></div><div><b>{manifestMcp}</b><span>{t('auditMcp')}</span></div></div><ul className="mwb-migration-audit-list">{manifestSessions.slice(-8).reverse().map((item, index) => <li key={`${String(item.targetSessionId ?? 'session')}-${String(index)}`}><div className="mwb-migration-audit-title">{String(item.title ?? item.targetSessionId ?? 'session')}</div><div className="mwb-migration-audit-path">{String(item.sourcePath ?? '')}</div></li>)}</ul></>}<div className="mwb-migration-dialog-actions"><button className="mwb-migration-secondary" type="button" onClick={() => { setManifest(undefined); setManifestError(undefined) }}>{t('auditClose')}</button></div></div></div> : null}
  </section>
}
