import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ConvertedSession, LossRecord } from './model.js'
import type { WorkBuddySessionMetadata } from './workbuddy-db.js'
import { parseWorkBuddyInput } from './input-envelope.js'

/**
 * Bump when persisted events need a compatibility repair on re-import.
 * v6: dedupe repeated tool call/result rows by callId (duplicate tool output).
 * v7: imported sessions are persisted as a seed prefix (isSeeded + inherited
 * count) so the runtime never replays imported history into the live surface.
 * v8: toolMode 'narrative' flattens tool calls/results into plain text so the
 * imported history carries no tool-output protocol (continuation always valid).
 * v9: group rows into real turns and steps — one user request is one turn and
 * every assistant round is one step carrying its tool calls and results —
 * instead of emitting one turn per WorkBuddy row.
 */
export const MIGRATION_CONVERTER_VERSION = 9

export type ToolMode = 'transcript' | 'narrative'

export interface ConvertOptions {
  toolMode?: ToolMode
}

type WorkBuddyRecord = Record<string, unknown>

function record(value: unknown): WorkBuddyRecord | undefined {
  return typeof value === 'object' && value !== null ? value as WorkBuddyRecord : undefined
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  const object = record(value)
  if (object !== undefined) {
    for (const key of ['text', 'content', 'value', 'output', 'rawContent']) {
      const candidate = object[key]
      if (candidate !== undefined) {
        const text = textOf(candidate)
        if (text) return text
      }
    }
  }
  return value === undefined || value === null ? '' : JSON.stringify(value)
}

function timeOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function argumentsOf(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}) } catch { return '{}' }
}

function sourceId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function content(text: string, reasoning = false): ContentBlock[] {
  return [{ type: reasoning ? 'reasoning' : 'text', text } as ContentBlock]
}

/** Build the model-facing assistant block that pairs with a tool result. */
function toolCallContent(call: { callId: string; name: string; arguments: string }): ContentBlock[] {
  return [{
    type: 'tool-call',
    id: ToolCallId(call.callId),
    name: call.name,
    arguments: call.arguments,
  } as ContentBlock]
}

function event<T extends SessionEvent['type']>(type: T, data: SessionEvent<T>['data'], seq: number, time: number): SessionEvent<T> {
  return { type, data, seq: SessionSeq(seq), time } as SessionEvent<T>
}

function surfaceEvent<T extends 'user/message' | 'assistant/message' | 'tool/result'>(
  type: T,
  data: SessionEvent<T>['data'],
  seq: number,
  time: number,
): SessionEvent<T> {
  return { ...event(type, data, seq, time), surfaceOp: 'append' } as SessionEvent<T>
}

/**
 * dsh session format v4 (0.2.x) refuses any durable message whose source is
 * missing a producer-owned `kind`, or still uses the retired 'plugin' wrapper.
 * Older converters emitted `{ provider, model }` for assistant messages and
 * `{ kind: 'plugin', ... }` for context snapshots. Unknown kinds are admitted
 * verbatim, so a migration-specific kind keeps both generations readable.
 */
const IMPORT_SOURCE_KIND = 'workbuddy-migration'
/** V4 refuses the retired 'plugin' wrapper; V3 still uses it for snapshots. */
const V4 = Number(SESSION_FORMAT_VERSION) >= 4

function producerSource(value: unknown): Record<string, unknown> {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const kind = source.kind
  const owned = typeof kind === 'string' && kind.length > 0 && (!V4 || kind !== 'plugin')
  return { ...source, kind: owned ? kind : IMPORT_SOURCE_KIND }
}

/**
 * Replace (never mutate) each message with a copy carrying an admissible
 * source. dsh-llm's message factories return frozen objects, so assigning
 * `message.source` in place throws even though the surrounding event is plain.
 */
export function normalizeMessageSources(events: SessionEvent[]): SessionEvent[] {
  for (let index = 0; index < events.length; index += 1) {
    const item = events[index]!
    const data = item.data as unknown
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    const record = data as Record<string, unknown>
    if (item.type === 'user/message') {
      events[index] = { ...item, data: { ...record, source: producerSource(record.source) } } as SessionEvent
    } else if (item.type === 'assistant/message' || item.type === 'tool/result') {
      const message = record.message
      if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
        const copy = message as Record<string, unknown>
        events[index] = { ...item, data: { ...record, message: { ...copy, source: producerSource(copy.source) } } } as SessionEvent
      }
    }
  }
  return events
}

/**
 * dsh 0.2 stores the attempt's timed stream on the settlement event, and the
 * current format rejects an `assistant/message` without the `stream` member.
 * The published event type still describes the pre-0.2 shape, so add the empty
 * stream explicitly: imported history has no live chunks to embed.
 */
export function normalizeAssistantSettlements(events: SessionEvent[]): SessionEvent[] {
  for (let index = 0; index < events.length; index += 1) {
    const item = events[index]!
    if (item.type !== 'assistant/message') continue
    const record = item.data as unknown
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const data = record as Record<string, unknown>
    if (!Array.isArray(data.stream)) events[index] = { ...item, data: { ...data, stream: [] } } as SessionEvent
  }
  return events
}

type PendingCall = { callId: string; name: string; arguments: string }
type UserMessageLike = ReturnType<typeof createUserMessage>
type ToolResultLike = ReturnType<typeof createToolResultMessage>

/**
 * Group WorkBuddy rows into DSH's real conversation shape.
 *
 * One user request is one DSH turn. Inside it, every assistant round is a
 * step: the assistant message (text/reasoning/tool-call blocks), its
 * `tool/call` events, and the matching `tool/result` events. Parallel calls
 * share a step; a new assistant round after results opens the next step.
 * Streaming rows as one turn each — the old behaviour — made every tool call
 * and every result look like a separate conversation.
 */
class TurnAssembler {
  readonly events: SessionEvent[] = []
  private seq = 0
  private turn = 0
  private step = 0
  private turnOpen = false
  private stepOpen = false
  private stepHasResults = false
  private bufferedBlocks: ContentBlock[] = []
  private bufferedCalls: PendingCall[] = []
  private readonly outstanding = new Map<string, PendingCall>()

  private readonly deferred: Array<{ messages: UserMessageLike[]; time: number }> = []
  private readonly synthesized: PendingCall[] = []
  private readonly synthesizedIds = new Set<string>()

  /** A call this assembler emitted or buffered, waiting for its result. */
  knownCall(callId: string): PendingCall | undefined {
    return this.outstanding.get(callId)
  }

  /** Whether a late result arrived for a call this assembler already closed. */
  wasSynthesized(callId: string): boolean {
    return this.synthesizedIds.has(callId)
  }

  /** Calls closed with a placeholder because their transcript lacked a result. */
  get synthesizedCount(): number {
    return this.synthesized.length
  }

  private event<T extends SessionEvent['type']>(type: T, data: SessionEvent<T>['data'], time: number): void {
    this.events.push({ type, data, seq: SessionSeq(this.seq), time } as unknown as SessionEvent)
    this.seq += 1
  }

  private surface<T extends 'user/message' | 'assistant/message' | 'tool/result'>(type: T, data: SessionEvent<T>['data'], time: number): void {
    this.events.push(surfaceEvent(type, data, this.seq, time))
    this.seq += 1
  }

  private startTurn(time: number): void {
    this.turn += 1
    this.step = 0
    this.turnOpen = true
    this.event('turn/start', { turn: this.turn }, time)
  }

  private ensureStep(time: number): void {
    if (!this.turnOpen) this.startTurn(time)
    if (this.stepOpen) return
    this.step += 1
    this.stepOpen = true
    this.stepHasResults = false
    this.event('step/start', { turn: this.turn, step: this.step }, time)
  }

  /** Emit the buffered assistant message and its tool calls in the current step. */
  private flush(time: number): void {
    if (this.bufferedBlocks.length === 0 && this.bufferedCalls.length === 0) return
    this.ensureStep(time)
    if (this.bufferedBlocks.length > 0) {
      const message = createAssistantMessage({ content: this.bufferedBlocks, source: { provider: 'workbuddy', model: 'imported' } })
      this.surface('assistant/message', { turn: this.turn, step: this.step, message }, time)
    }
    for (const call of this.bufferedCalls) {
      this.event('tool/call', { turn: this.turn, step: this.step, callId: ToolCallId(call.callId), name: call.name, arguments: call.arguments }, time)
    }
    this.bufferedBlocks = []
    this.bufferedCalls = []
  }

  private closeStep(time: number): void {
    this.flush(time)
    if (this.outstanding.size > 0) {
      // The strict log validator refuses a step/end while an advertised call
      // has no result, so close every orphan here — before the boundary.
      this.ensureStep(time)
      for (const call of [...this.outstanding.values()]) {
        const message = createToolResultMessage({
          callId: ToolCallId(call.callId),
          content: content('WorkBuddy 未返回工具结果；此调用仅作为历史占位。'),
          isError: true,
        })
        this.surface('tool/result', { turn: this.turn, step: this.step, message }, time)
        this.outstanding.delete(call.callId)
        this.synthesized.push(call)
        this.synthesizedIds.add(call.callId)
      }
    }
    if (!this.stepOpen) return
    this.event('step/end', { turn: this.turn, step: this.step }, time)
    this.stepOpen = false
  }

  closeTurn(time: number): void {
    this.closeStep(time)
    if (!this.turnOpen) return
    this.event('turn/end', { turn: this.turn, reason: { kind: 'completed' } }, time)
    this.turnOpen = false
  }

  /** Start the next user turn, closing any open assistant round first. */
  beginTurn(time: number): void {
    this.closeTurn(time)
    this.startTurn(time)
    this.ensureStep(time)
  }

  /** Emit user rows that were held back while a tool call waited for its result. */
  private flushDeferred(time: number): void {
    if (this.deferred.length === 0 || this.outstanding.size > 0) return
    const queue = this.deferred.splice(0)
    this.beginTurn(time)
    for (const row of queue) {
      for (const message of row.messages) this.surface('user/message', message, row.time)
    }
  }

  /**
   * A user row starts a turn, unless a call is still waiting for its result:
   * WorkBuddy may write the next user prompt before the tool result, and
   * closing the turn there would leave the step with an unresolved call.
   */
  userRow(messages: UserMessageLike[], time: number): void {
    if (this.outstanding.size > 0) {
      this.deferred.push({ messages, time })
      return
    }
    if (this.deferred.length > 0) {
      this.deferred.push({ messages, time })
      this.flushDeferred(time)
      return
    }
    this.beginTurn(time)
    for (const message of messages) this.surface('user/message', message, time)
  }

  assistant(blocks: ContentBlock[], time: number): void {
    if (this.deferred.length > 0) {
      if (this.outstanding.size > 0) this.closeTurn(time)
      this.flushDeferred(time)
    }
    if (this.stepHasResults) this.closeStep(time)
    this.ensureStep(time)
    this.bufferedBlocks.push(...blocks)
  }

  call(call: PendingCall, time: number): void {
    if (this.deferred.length > 0) {
      if (this.outstanding.size > 0) this.closeTurn(time)
      this.flushDeferred(time)
    }
    if (this.stepHasResults) this.closeStep(time)
    this.ensureStep(time)
    this.bufferedBlocks.push(...toolCallContent(call))
    this.bufferedCalls.push(call)
    this.outstanding.set(call.callId, call)
  }

  result(call: PendingCall, message: ToolResultLike, needsSyntheticCall: boolean, time: number): void {
    this.ensureStep(time)
    if (needsSyntheticCall) this.call(call, time)
    this.flush(time)
    this.surface('tool/result', { turn: this.turn, step: this.step, message }, time)
    this.stepHasResults = true
    this.outstanding.delete(call.callId)
    if (this.outstanding.size === 0) this.flushDeferred(time)
  }

  finish(time: number): void {
    this.closeTurn(time)
    this.flushDeferred(time)
    this.closeTurn(time)
  }
}

/** Convert one WorkBuddy JSONL file to DSH's durable event vocabulary. */
export async function convertWorkBuddySession(path: string, root: string, metadata?: WorkBuddySessionMetadata, options: ConvertOptions = {}): Promise<ConvertedSession> {
  const toolMode: ToolMode = options.toolMode ?? 'transcript'
  const raw = await readFile(path, 'utf8')
  const sourceHash = createHash('sha256').update(raw).digest('hex')
  const sourceSessionId = basename(path, '.jsonl')
  const parts = relative(`${root}/projects`, path).split(sep)
  const projectHash = parts[0] ?? 'unknown'
  const lines = raw.split(/\r?\n/)
  const assembler = new TurnAssembler()
  const loss: LossRecord[] = []
  // WorkBuddy can repeat the same call/result row (retries, streamed updates).
  // OpenAI-compatible gateways reject duplicate tool outputs for one call id,
  // so each callId emits at most one assistant tool-call block and one result.
  const emittedCallIds = new Set<string>()
  const resultedCallIds = new Set<string>()
  let title: string | undefined = metadata?.title
  let firstUserTitle: string | undefined
  let createdAt = Number.POSITIVE_INFINITY
  let cwd: string | undefined = metadata?.cwd
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { loss.push({ code: 'invalid-json', detail: `line ${index + 1}` }); continue }
    const row = record(parsed)
    if (row === undefined) { loss.push({ code: 'invalid-record', detail: `line ${index + 1}` }); continue }
    const kind = sourceId(row.type ?? row.event ?? row.kind, 'unknown')
    const at = timeOf(row.timestamp ?? row.time ?? row.createdAt, Date.now())
    createdAt = Math.min(createdAt, at)
    if (cwd === undefined && typeof row.cwd === 'string' && isAbsolute(row.cwd)) cwd = row.cwd
    if (kind === 'ai-title') title = textOf(row.aiTitle)
    else if (kind === 'custom-title') title = textOf(row.customTitle)
    else if (kind === 'summary') loss.push({ code: 'summary-metadata', detail: 'summary retained in import manifest' })
    else if (kind === 'message') {
      const role = row.role === 'assistant' ? 'assistant' : 'user'
      const parsedInput = role === 'user' ? parseWorkBuddyInput(textOf(row.content)) : undefined
      if (role === 'user' && firstUserTitle === undefined) {
        const candidate = (parsedInput?.text ?? textOf(row.content)).trim()
        if (candidate) firstUserTitle = candidate.slice(0, 80)
      }
      if (role === 'assistant') {
        assembler.assistant(content(textOf(row.content)), at)
      } else {
        const input = parsedInput!
        for (const warning of input.warnings) loss.push({ code: 'input-envelope-warning', detail: `line ${index + 1}: ${warning}` })
        const messages: UserMessageLike[] = []
        if (input.contextSections.length > 0) {
          messages.push(createUserMessage({
            content: content(input.contextSections.map(section => `${section.name}:\n${section.text}`).join('\n\n')),
            source: { kind: 'plugin', plugin: 'WorkBuddy 上下文', form: 'snapshot', sections: input.contextSections },
          }))
        }
        if (input.text !== '' || !input.hadContext) {
          messages.push(createUserMessage({ content: content(input.text), source: { kind: 'user' } }))
        } else {
          loss.push({ code: 'context-only-message', detail: `line ${index + 1}: no user_query was present` })
        }
        if (messages.length > 0) assembler.userRow(messages, at)
      }
    } else if (kind === 'reasoning') {
      assembler.assistant(content(textOf(row.rawContent ?? row.content), true), at)
    } else if (kind === 'function_call') {
      const callId = sourceId(row.callId ?? row.id, `workbuddy-call-${index}`)
      const callName = sourceId(row.name, 'unknown-tool')
      const callArguments = argumentsOf(row.arguments)
      if (toolMode === 'narrative') {
        assembler.assistant(content(`【工具调用 ${callName}】${callArguments}`), at)
        loss.push({ code: 'tool-flattened', detail: `line ${index + 1} (${callId})` })
        continue
      }
      if (emittedCallIds.has(callId) || resultedCallIds.has(callId)) {
        loss.push({ code: 'duplicate-tool-call', detail: `line ${index + 1} (${callId})` })
        continue
      }
      assembler.call({ callId, name: callName, arguments: callArguments }, at)
      emittedCallIds.add(callId)
    } else if (kind === 'function_call_result') {
      const callId = sourceId(row.callId ?? row.id, `workbuddy-call-${index}`)
      const isError = row.status === 'error' || row.isError === true
      if (toolMode === 'narrative') {
        const outputText = textOf(row.output ?? row.content)
        assembler.assistant(content(`【工具结果${isError ? '（错误）' : ''}】${outputText}`), at)
        loss.push({ code: 'tool-result-flattened', detail: `line ${index + 1} (${callId})` })
        continue
      }
      if (resultedCallIds.has(callId)) {
        loss.push({ code: 'duplicate-tool-result', detail: `line ${index + 1} (${callId})` })
        continue
      }
      const known = assembler.knownCall(callId)
      const orphan = known === undefined && !assembler.wasSynthesized(callId)
      if (assembler.wasSynthesized(callId)) {
        loss.push({ code: 'duplicate-tool-result', detail: `line ${index + 1} (${callId}): result arrived after the call was closed` })
        resultedCallIds.add(callId)
        continue
      }
      if (orphan) loss.push({ code: 'orphan-tool-result', detail: `line ${index + 1} (${callId})` })
      const call = known ?? { callId, name: sourceId(row.name, 'unknown-tool'), arguments: argumentsOf(row.arguments) }
      const resultMessage = createToolResultMessage({ callId: ToolCallId(callId), content: content(textOf(row.output ?? row.content)), isError })
      assembler.result(call, resultMessage, orphan, at)
      resultedCallIds.add(callId)
      if (orphan) emittedCallIds.add(callId)
    } else if (kind === 'file-history-snapshot') loss.push({ code: 'file-history', detail: 'file history snapshots are not imported' })
    else loss.push({ code: 'unknown-event', detail: `${kind} at line ${index + 1}` })
  }
  assembler.finish(Number.isFinite(createdAt) ? createdAt : Date.now())
  if (assembler.synthesizedCount > 0) {
    loss.push({ code: 'unpaired-tool-call', detail: `${String(assembler.synthesizedCount)} tool call(s) had no result` })
  }
  const events = assembler.events
  title ??= firstUserTitle
  // Titles are log-only metadata and must precede the seed turns. Explicit
  // user-supplied titles cite no messages, which is the invariant accepted by
  // the session-title package. Shift converted event sequence numbers once.
  if (title) {
    for (const item of events) item.seq = SessionSeq(Number(item.seq) + 1)
    events.unshift({ type: 'session/title', seq: SessionSeq(0), time: Number.isFinite(createdAt) ? createdAt : Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } } as unknown as SessionEvent)
  }
  normalizeMessageSources(events)
  normalizeAssistantSettlements(events)
  const id = `workbuddy-${sourceHash.slice(0, 24)}`
  return {
    sourcePath: path,
    sourceHash,
    sourceSessionId,
    projectHash,
    targetSessionId: String(SessionId(id)),
    ...(cwd === undefined ? {} : { cwd }),
    ...(metadata?.mode ? { mode: metadata.mode } : {}),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    ...(title ? { title } : {}),
    events,
    loss,
  }
}
