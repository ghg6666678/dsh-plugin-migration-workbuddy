import { createHash, randomUUID } from 'node:crypto'
import { join, sep, win32 } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * DSH -> WorkBuddy writer.
 *
 * The importer turns WorkBuddy JSONL rows into DSH events. This module does the
 * exact reverse for the part WorkBuddy can still display: conversational rows
 * (`message`, `reasoning`, `function_call`, `function_call_result`) chained by
 * `parentId`, plus the catalog rows that make the session appear in WorkBuddy's
 * sidebar.
 *
 * Two invariants drive the shape of the output:
 *
 * 1. WorkBuddy appends one JSON object per line and follows `parentId` to
 *    reconstruct the conversation. Appended rows therefore always continue from
 *    the file's last row id, and every emitted row gets a fresh, monotonically
 *    increasing timestamp.
 * 2. WorkBuddy's own context snapshots must never cross back. DSH stores system
 *    prompts, runtime context and imported snapshot messages as `system/message`
 *    or non-user-sourced `user/message`; all of those are skipped so the export
 *    carries only what a human typed and the assistant answered.
 */

/** One WorkBuddy JSONL row; the exact key set depends on `type`. */
export type WorkBuddyRow = Record<string, unknown>

/** Rows the exporter is able to reconstruct. */
export interface ExportRowCounts {
  message: number
  reasoning: number
  functionCall: number
  functionCallResult: number
}

export interface ExportBatch {
  rows: WorkBuddyRow[]
  counts: ExportRowCounts
  /** DSH events actually reflected by `rows` (surface rows only). */
  exportedEvents: number
  /** Highest DSH event seq covered by this window. */
  lastEventSeq: number
  loss: Array<{ code: string; detail: string }>
}

export interface BuildOptions {
  /** WorkBuddy session id the rows belong to. */
  sessionId: string
  /** Workspace path recorded on every row (`c:\Users\…` form). */
  cwd: string
  /** Model name recorded in `providerData`; purely informational to WorkBuddy. */
  model?: string
  /** Id of the row this batch continues from (append mode). */
  chainFrom?: string
  /** Timestamp of the row this batch continues from (append mode). */
  chainTime?: number
  /** Emit the leading `session-meta` + `ai-title` rows of a brand-new file. */
  bootstrap?: { title?: string; createdAt: number }
}

const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])

/** WorkBuddy names the file's project directory after the workspace path. */
export function projectHashOf(cwd: string): string {
  // WorkBuddy never records a trailing separator, but a caller passing
  // `…/demo/` must still land in `…-demo` rather than `…-demo-`.
  const trimmed = cwd.trim().replace(/[\\/]+$/, '')
  const stripped = trimmed.replace(/[:*?"<>|]/g, '')
  const flattened = stripped.replace(/[\\/]+/g, '-')
  return flattened.length === 0 ? flattened : flattened[0]!.toLowerCase() + flattened.slice(1)
}

/**
 * Normalise a workspace path into the spelling WorkBuddy writes into its rows
 * and catalog (`c:\Users\ASUS\…`: lowercase drive letter, backslashes).
 */
export function normalizeWorkBuddyPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '') return trimmed
  const unified = trimmed.replace(/\//g, '\\').replace(/\\+$/, '')
  return unified[0]!.toLowerCase() + unified.slice(1)
}

/** Absolute WorkBuddy transcript path for one session. */
export function workBuddySessionPath(root: string, cwd: string, sessionId: string): string {
  return join(root, 'projects', projectHashOf(normalizeWorkBuddyPath(cwd)), `${sessionId}.jsonl`)
}

/**
 * Spelling `workbuddy.db`'s `workspaces.path` uses: backslashes, lowercase drive
 * letter. A workspace row whose spelling differs from the session's is treated
 * as a different workspace, so both must come from the same normalisation.
 */
export function catalogPath(cwd: string): string {
  return normalizeWorkBuddyPath(cwd)
}

/**
 * Spelling `workbuddy.db`'s `sessions.cwd` uses. WorkBuddy stores this one with
 * forward slashes while the transcripts and `workspaces` use backslashes; the
 * app tolerates either, but keeping each table in its own native form avoids
 * surprising its own readers.
 */
export function sessionRowPath(cwd: string): string {
  return normalizeWorkBuddyPath(cwd).replace(/\\/g, '/')
}

/**
 * RFC 9562 version 7 identifier: WorkBuddy's own row ids are time-sortable, and
 * keeping the same layout means its ordering helpers behave identically.
 */
export function uuidV7(now = Date.now()): string {
  const buffer = Buffer.alloc(16)
  buffer.writeUIntBE(Math.floor(now / 2 ** 16), 0, 6)
  buffer.writeUIntBE(now % 2 ** 16, 4, 2)
  const random = createHash('sha256').update(randomUUID()).digest().subarray(0, 10)
  random.copy(buffer, 6)
  buffer[6] = (buffer[6]! & 0x0f) | 0x70
  buffer[8] = (buffer[8]! & 0x3f) | 0x80
  const hex = buffer.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function textOfBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    const item = record(block)
    if (item === undefined) continue
    // A tool result's block carries its own `content` array; a message's block
    // carries `text`. Both are flattened into the row WorkBuddy reads.
    if (item.type === 'tool-result') {
      const nested = textOfBlocks(item.content)
      if (nested !== '') parts.push(nested)
      continue
    }
    if (item.type !== 'text' && item.type !== 'output_text' && item.type !== 'input_text') continue
    if (typeof item.text === 'string' && item.text !== '') parts.push(item.text)
  }
  return parts.join('\n')
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value !== '') return value
  return ''
}

function providerData(model: string, traceSeed: string): Record<string, unknown> {
  const trace = createHash('sha1').update(traceSeed).digest('hex')
  return {
    conversationRequestId: trace.slice(0, 32),
    messageId: trace.slice(0, 32),
    model,
    requestModelId: model,
    requestModelName: model,
    traceId: trace,
    agent: 'cli',
  }
}

/** Accumulates rows while keeping the parentId chain and clock monotonic. */
class RowWriter {
  readonly rows: WorkBuddyRow[] = []
  readonly counts: ExportRowCounts = { message: 0, reasoning: 0, functionCall: 0, functionCallResult: 0 }
  private parent: string | undefined
  private clock: number

  constructor(private readonly options: BuildOptions, private readonly now: () => number = Date.now) {
    this.parent = options.chainFrom
    this.clock = options.chainTime ?? 0
  }

  private stamp(time: number): number {
    const candidate = Number.isFinite(time) ? Math.min(Math.max(time, 0), this.now()) : this.now()
    this.clock = Math.max(this.clock + 1, candidate)
    return this.clock
  }

  /** Emit one row and advance the chain head. */
  push(row: WorkBuddyRow, identity: 'chain' | 'loose' = 'chain'): void {
    if (identity === 'chain') {
      const id = String(row.id ?? uuidV7())
      row.id = id
      if (this.parent !== undefined) row.parentId = this.parent
      this.parent = id
    }
    this.rows.push(row)
  }

  message(role: 'user' | 'assistant', text: string, time: number, status?: string): void {
    const cwd = this.options.cwd
    const stamp = this.stamp(time)
    if (role === 'user') {
      this.push({
        id: uuidV7(stamp),
        timestamp: stamp,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
        providerData: { ...providerData(this.options.model ?? 'deepseek-v4.1-flash', `${stamp}-u`), agent: 'cli' },
        sessionId: this.options.sessionId,
        cwd,
        __codebuddyLocal: { sensitiveUserInputReviewed: true },
      })
    } else {
      this.push({
        id: uuidV7(stamp),
        timestamp: stamp,
        type: 'message',
        role: 'assistant',
        providerData: providerData(this.options.model ?? 'deepseek-v4.1-flash', `${stamp}-a`),
        status: status ?? 'completed',
        content: [{ providerData: { annotations: [] }, type: 'output_text', text }],
        sessionId: this.options.sessionId,
        cwd,
      })
    }
    this.counts.message += 1
  }

  reasoning(text: string, time: number): void {
    const stamp = this.stamp(time)
    this.push({
      id: uuidV7(stamp),
      timestamp: stamp,
      type: 'reasoning',
      providerData: providerData(this.options.model ?? 'deepseek-v4.1-flash', `${stamp}-r`),
      content: [],
      rawContent: [{ type: 'reasoning_text', text }],
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
    })
    this.counts.reasoning += 1
  }

  call(callId: string, name: string, args: string, time: number): void {
    const stamp = this.stamp(time)
    this.push({
      id: uuidV7(stamp),
      timestamp: stamp,
      type: 'function_call',
      providerData: providerData(this.options.model ?? 'deepseek-v4.1-flash', `${stamp}-c`),
      callId,
      name,
      arguments: args,
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
    })
    this.counts.functionCall += 1
  }

  result(callId: string, name: string, output: string, isError: boolean, time: number): void {
    const stamp = this.stamp(time)
    this.push({
      id: uuidV7(stamp),
      timestamp: stamp,
      type: 'function_call_result',
      providerData: providerData(this.options.model ?? 'deepseek-v4.1-flash', `${stamp}-x`),
      name,
      callId,
      status: isError ? 'incomplete' : 'completed',
      output: { type: 'text', text: output },
      sessionId: this.options.sessionId,
      cwd: this.options.cwd,
    })
    this.counts.functionCallResult += 1
  }

  /**
   * Leading rows of a brand-new transcript.
   *
   * Both are deliberately off-chain: WorkBuddy's own files start their
   * `parentId` chain with the first `message` row and let the title rows dangle,
   * so writing them as chain members would make the reader treat a title as the
   * conversation root.
   */
  bootstrap(title: string | undefined, createdAt: number): void {
    const stamp = this.stamp(createdAt)
    this.push({
      id: uuidV7(stamp),
      sessionId: this.options.sessionId,
      timestamp: stamp,
      type: 'session-meta',
      meta: { 'codebuddy.ai/hostKind': 'unopted' },
    }, 'loose')
    if (title !== undefined && title !== '') {
      this.push({
        id: uuidV7(this.stamp(createdAt + 1)),
        timestamp: this.clock,
        type: 'ai-title',
        aiTitle: title,
        sessionId: this.options.sessionId,
        cwd: this.options.cwd,
      }, 'loose')
    }
  }
}

/**
 * Pick the DSH events that may be exported from a full session log.
 *
 * The window always ends at the last balanced `turn/end`: a live turn may still
 * be streaming, and a half-written exchange would leave WorkBuddy with a
 * `function_call` that never receives its result.
 */
export function exportWindow(events: readonly SessionEvent[], fromSeq: number): { events: SessionEvent[]; lastEventSeq: number; openTurn: boolean } {
  let end = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type !== 'turn/end') continue
    if (Number(event.seq) >= fromSeq) end = index
  }
  if (end === -1) {
    return { events: [], lastEventSeq: fromSeq - 1, openTurn: events.some(event => Number(event.seq) >= fromSeq) }
  }
  const lastEventSeq = Number(events[end]!.seq)
  const window = events.filter(event => Number(event.seq) >= fromSeq && Number(event.seq) <= lastEventSeq)
  return { events: window, lastEventSeq, openTurn: false }
}

/** The seq after the last inherited seed marker; 0 for a session that was never seeded. */
export function seedWatermark(events: readonly SessionEvent[]): number {
  let mark = -1
  for (const event of events) {
    if (event.type !== 'session/end-seed') continue
    const data = record(event.data)
    if (data?.inherited === true) mark = Number(event.seq)
  }
  return mark + 1
}

/** Convert the exported slice of a DSH log into WorkBuddy rows. */
export function buildWorkBuddyRows(events: readonly SessionEvent[], options: BuildOptions): ExportBatch {
  const writer = new RowWriter(options)
  const loss: Array<{ code: string; detail: string }> = []
  // A call is only visible to WorkBuddy once a `function_call` row exists for
  // it, so track both what the assistant announced and what a result needs.
  const callNames = new Map<string, string>()
  const callArguments = new Map<string, string>()
  const emitted = new Set<string>()
  let exportedEvents = 0
  let lastEventSeq = 0

  const emitCall = (callId: string, name: string, args: string, time: number): void => {
    if (emitted.has(callId)) return
    emitted.add(callId)
    writer.call(callId, name, args, time)
  }

  if (options.bootstrap !== undefined) writer.bootstrap(options.bootstrap.title, options.bootstrap.createdAt)

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    const data = record(event.data)
    const time = Number(event.time)
    lastEventSeq = Math.max(lastEventSeq, Number(event.seq))
    if (data === undefined) continue
    if (event.type === 'tool/call') {
      // The authoritative record of a call, whether or not the assistant
      // message that requested it was exported (an interrupted step keeps the
      // call but drops the text block that named it).
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const name = typeof data.name === 'string' ? data.name : undefined
      if (callId !== undefined && name !== undefined) {
        callNames.set(callId, name)
        callArguments.set(callId, typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}))
      }
      continue
    }
    if (!SURFACE.has(event.type)) continue
    if (event.type === 'user/message') {
      const source = record(data.source)
      // Only what a human typed belongs in the other app; context snapshots,
      // imported summaries and runtime reminders stay behind.
      if (source?.kind !== 'user') { continue }
      const text = textOfBlocks(data.content)
      if (text === '') continue
      writer.message('user', text, time)
      exportedEvents += 1
      continue
    }
    if (event.type === 'assistant/message') {
      const message = record(data.message)
      const blocks = Array.isArray(message?.content) ? message.content : []
      let text: string[] = []
      const flushText = (): void => {
        if (text.length === 0) return
        const joined = text.join('\n').trim()
        text = []
        if (joined !== '') writer.message('assistant', joined, time, data.interrupted === true ? 'incomplete' : 'completed')
      }
      for (const block of blocks) {
        const item = record(block)
        if (item === undefined) continue
        if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim() !== '') {
          flushText()
          writer.reasoning(item.text, time)
        } else if (item.type === 'text' && typeof item.text === 'string') {
          text.push(item.text)
        } else if (item.type === 'tool-call') {
          flushText()
          const callId = typeof item.id === 'string' ? item.id : ''
          const name = typeof item.name === 'string' ? item.name : 'tool'
          if (callId === '') { loss.push({ code: 'tool-call-without-id', detail: `seq ${String(event.seq)}` }); continue }
          callNames.set(callId, name)
          const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
          emitCall(callId, name, args, time)
        }
      }
      flushText()
      exportedEvents += 1
      continue
    }
    // tool/result
    const message = record(data.message)
    // Real logs keep the id in three places (event data, the block, the message
    // source); older or repaired logs may keep only one, so accept any of them.
    const block = Array.isArray(message?.content) ? record(message.content[0]) : undefined
    const callId = firstString(data.toolCallId, message?.toolCallId, record(message?.source)?.callId, block?.toolCallId)
    if (callId === '') { loss.push({ code: 'tool-result-without-call', detail: `seq ${String(event.seq)}` }); continue }
    // A result whose call was never announced still needs its call row, or
    // WorkBuddy shows an answer to a question it cannot see.
    emitCall(callId, callNames.get(callId) ?? 'tool', callArguments.get(callId) ?? '{}', time)
    const output = textOfBlocks(message?.content)
    // A failure is recorded at three levels depending on the producer: the
    // event's error object, the message's flag, or the result block's flag.
    const isError = data.error !== undefined || message?.isError === true || block?.isError === true
    writer.result(callId, callNames.get(callId) ?? 'tool', output, isError, time)
    exportedEvents += 1
  }

  return { rows: writer.rows, counts: writer.counts, exportedEvents, lastEventSeq, loss }
}

/** Tail state of an existing WorkBuddy transcript. */
export interface TranscriptTail {
  exists: boolean
  bytes: number
  rows: number
  lastRowId?: string
  lastTimestamp?: number
  sessionIds: Set<string>
  cwds: string[]
}

/**
 * Read only what an append needs: the chain head, the clock, and the size the
 * undo journal must truncate back to. A transcript can be tens of MiB, so the
 * scan is line-oriented and keeps no rows.
 */
export function scanTranscriptTail(content: string): TranscriptTail {
  const lines = content.split('\n')
  let rows = 0
  let lastRowId: string | undefined
  let lastTimestamp: number | undefined
  const sessionIds = new Set<string>()
  const cwds: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    rows += 1
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { continue }
    const row = record(parsed)
    if (row === undefined) continue
    if (typeof row.id === 'string') lastRowId = row.id
    if (typeof row.timestamp === 'number') {
      lastTimestamp = lastTimestamp === undefined ? row.timestamp : Math.max(lastTimestamp, row.timestamp)
    }
    if (typeof row.sessionId === 'string') sessionIds.add(row.sessionId)
    if (typeof row.cwd === 'string' && !cwds.includes(row.cwd)) cwds.push(row.cwd)
  }
  return {
    exists: true,
    bytes: Buffer.byteLength(content, 'utf8'),
    rows,
    ...(lastRowId === undefined ? {} : { lastRowId }),
    ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
    sessionIds,
    cwds,
  }
}

/** Serialise rows exactly the way WorkBuddy does: one object per line, trailing newline. */
export function serializeRows(rows: readonly WorkBuddyRow[], leadingNewline: boolean): string {
  if (rows.length === 0) return ''
  const text = rows.map(row => JSON.stringify(row)).join('\n')
  return `${leadingNewline ? '\n' : ''}${text}\n`
}

/** Path helper mirroring WorkBuddy's own `<project>/<session>.jsonl` layout. */
export function transcriptDirectory(root: string, cwd: string): string {
  return join(root, 'projects', projectHashOf(normalizeWorkBuddyPath(cwd)))
}

/** Whether two workspace paths point at the same place once normalised. */
export function sameWorkspace(a: string, b: string): boolean {
  const left = normalizeWorkBuddyPath(a)
  const right = normalizeWorkBuddyPath(b)
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
}

/** Separator-independent display helper used by the preview. */
export function displayDirectory(path: string): string {
  return path.split(sep).join(win32.sep)
}
