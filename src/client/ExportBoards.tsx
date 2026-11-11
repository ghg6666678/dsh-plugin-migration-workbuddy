import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ExportAutomationBoard,
  ExportAutomationSummary,
  ExportMcpBoard,
  ExportMcpSummary,
  ExportMemoryBoard,
  ExportMemorySummary,
  ExportPreview,
} from '../model.js'

type Locale = PropsLocale<'migration.workbuddy'>['t']

export interface ExportBoardsProps {
  t: Locale
  preview: ExportPreview
  memoryIds: string[]
  mcpIds: string[]
  automationIds: string[]
  onToggleMemory(id: string): void
  onToggleMcp(id: string): void
  onToggleAutomation(id: string): void
  /** Disables every control while a run is in flight. */
  disabled: boolean
}

/** One collapsible board, so three long lists never bury the session list. */
function Board(props: {
  icon: string
  title: string
  hint: string
  count: string
  target?: string
  note?: string
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  return <div className="mwb-migration-board">
    <button className="mwb-migration-board-head" type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      <span className="mwb-migration-icon" style={{ width: 26, height: 26, fontSize: 14 }}>{props.icon}</span>
      <span className="mwb-migration-board-title">{props.title}</span>
      <span className="mwb-migration-board-count">{props.count}</span>
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
    {open ? <>
      {props.target === undefined ? null : <div className="mwb-migration-board-target">{props.target}</div>}
      {props.note === undefined ? null : <p className="mwb-migration-board-note">{props.note}</p>}
      {props.children}
      <div className="mwb-migration-board-target">{props.hint}</div>
    </> : null}
  </div>
}

function Row(props: {
  checked: boolean
  disabled: boolean
  onToggle(): void
  title: string
  meta?: string
  badge: string
  kind: string
}): React.ReactElement {
  return <label className="mwb-migration-board-row" data-disabled={props.disabled ? 'true' : undefined}>
    <input
      className="mwb-migration-check"
      type="checkbox"
      checked={props.checked}
      disabled={props.disabled}
      onChange={props.onToggle}
    />
    <span className="mwb-migration-board-main">
      <span className="mwb-migration-board-line">{props.title}</span>
      {props.meta === undefined ? null : <span className="mwb-migration-board-meta">{props.meta}</span>}
    </span>
    <span className="mwb-migration-badge" data-kind={props.kind}>{props.badge}</span>
  </label>
}

function noPlate(text: string): React.ReactElement {
  return <div className="mwb-migration-board-empty">{text}</div>
}

/** Whether a memory record still needs writing. */
function memoryPending(item: ExportMemorySummary): boolean {
  return !item.present
}

function mcpPending(item: ExportMcpSummary): boolean {
  return item.status === 'new'
}

function automationPending(item: ExportAutomationSummary): boolean {
  return item.status === 'new'
}

function MemoryBoard(props: { t: Locale; board: ExportMemoryBoard; ids: string[]; disabled: boolean; onToggle(id: string): void }): React.ReactElement {
  const { board, t } = props
  const pending = board.records.filter(memoryPending).length
  const note = board.summary.skipped > 0
    ? t('exportMemoriesFiltered').replace('{skipped}', String(board.summary.skipped))
    : undefined
  return <Board
    icon="✦"
    title={t('memories')}
    hint={t('exportMemoriesHint')}
    count={`${String(pending)} / ${String(board.records.length)}`}
    target={`${t('exportMemoriesTarget')}: ${board.targetPath}`}
    {...(note === undefined ? {} : { note })}
  >
    {board.records.length === 0
      ? noPlate(t('exportMemoriesEmpty'))
      : <div className="mwb-migration-board-body">
          {board.records.map(item => <Row
            key={item.id}
            checked={item.present || props.ids.includes(item.id)}
            disabled={props.disabled || item.present}
            onToggle={() => props.onToggle(item.id)}
            title={item.content}
            meta={`${item.sourcePath}${item.createdAt === undefined ? '' : ` · ${new Date(item.createdAt).toLocaleDateString()}`}`}
            kind={item.present ? 'present' : 'new'}
            badge={item.present ? t('exportMemoriesPresent') : t('exportMemoriesPending')}
          />)}
        </div>}
  </Board>
}

function McpBoard(props: { t: Locale; board: ExportMcpBoard; ids: string[]; disabled: boolean; onToggle(id: string): void }): React.ReactElement {
  const { board, t } = props
  const shape = (item: ExportMcpSummary): string => item.transport === 'streamable-http' && item.url !== undefined
    ? `streamable-http · ${item.url}`
    : `stdio · ${item.command ?? ''}${item.args.length === 0 ? '' : ` ${item.args.join(' ')}`}`
  const secrets = board.servers.filter(item => mcpPending(item) && item.secretKeys.length > 0)
  const note = secrets.length === 0
    ? undefined
    : `${t('exportMcpSecrets')}（${secrets.map(item => `${item.serverName}: ${item.secretKeys.join(', ')}`).join('；')}）。${t('exportMcpSecretNote')}`
  const badgeOf = (item: ExportMcpSummary): string => {
    switch (item.status) {
      case 'present': return t('exportMemoriesPresent')
      case 'conflict': return t('exportStatusConflict')
      default: return t('exportMcpNew')
    }
  }
  return <Board
    icon="⌘"
    title={t('mcp')}
    hint={t('exportMcpHint')}
    count={`${String(board.summary.new)} / ${String(board.servers.length)}`}
    target={`${t('exportMcpTarget')}: ${board.targetPath}`}
    {...(note === undefined ? {} : { note })}
  >
    {board.servers.length === 0
      ? noPlate(t('exportMcpEmpty'))
      : <div className="mwb-migration-board-body">
          {board.servers.map(item => <Row
            key={item.id}
            checked={item.status === 'present' || props.ids.includes(item.id)}
            disabled={props.disabled || !mcpPending(item)}
            onToggle={() => props.onToggle(item.id)}
            title={item.serverName}
            meta={`${shape(item)}${item.detail === undefined ? '' : ` · ${item.detail}`} · ${item.sourcePath}`}
            kind={item.status}
            badge={badgeOf(item)}
          />)}
        </div>}
  </Board>
}

function AutomationBoard(props: { t: Locale; board: ExportAutomationBoard; ids: string[]; disabled: boolean; onToggle(id: string): void }): React.ReactElement {
  const { board, t } = props
  if (!board.available) {
    return <Board icon="⏱" title={t('automations')} hint={t('exportAutomationsHint')} count="—">
      {noPlate(board.detail ?? t('exportAutomationsUnavailable'))}
    </Board>
  }
  const badgeOf = (item: ExportAutomationSummary): string => {
    switch (item.status) {
      case 'present': return t('exportMemoriesPresent')
      case 'unsupported': return t('exportStatusFailed')
      default: return t('exportAutomationsPending')
    }
  }
  return <Board
    icon="⏱"
    title={t('automations')}
    hint={t('exportAutomationsHint')}
    count={`${String(board.summary.pending)} / ${String(board.automations.length)}`}
    {...(board.detail === undefined ? {} : { note: board.detail })}
  >
    {board.automations.length === 0
      ? noPlate(t('exportAutomationsEmpty'))
      : <div className="mwb-migration-board-body">
          {board.automations.map(item => <Row
            key={item.id}
            checked={item.status === 'present' || props.ids.includes(item.id)}
            disabled={props.disabled || !automationPending(item)}
            onToggle={() => props.onToggle(item.id)}
            title={item.title}
            meta={[
              item.scheduleType === 'once' ? t('automationOnce') : item.rrule ?? t('automations'),
              item.detail,
            ].filter((value): value is string => value !== undefined && value !== '').join(' · ')}
            kind={item.status}
            badge={badgeOf(item)}
          />)}
        </div>}
  </Board>
}

/**
 * The export direction's memories / MCP / automations boards.
 *
 * Each board mirrors the matching import board so both directions offer the
 * same three categories, and each reports its own "nothing to export" state
 * instead of hiding the category.
 */
export function ExportBoards(props: ExportBoardsProps): React.ReactElement {
  return <div className="mwb-migration-boards">
    <MemoryBoard t={props.t} board={props.preview.memories} ids={props.memoryIds} disabled={props.disabled} onToggle={props.onToggleMemory} />
    <McpBoard t={props.t} board={props.preview.mcp} ids={props.mcpIds} disabled={props.disabled} onToggle={props.onToggleMcp} />
    <AutomationBoard t={props.t} board={props.preview.automations} ids={props.automationIds} disabled={props.disabled} onToggle={props.onToggleAutomation} />
  </div>
}
