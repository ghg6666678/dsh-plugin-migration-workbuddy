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
 */
export const MIGRATION_CONVERTER_VERSION = 8

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

function pushTurn(events: SessionEvent[], turn: number, time: number, append: (seq: number, step: number) => SessionEvent[], seq: number): number {
  events.push(event('turn/start', { turn }, seq++, time))
  // DSH turn/step numbers are one-based. A zero turn is accepted by TypeScript
  // casts but rejected when the persisted session is reloaded.
  events.push(event('step/start', { turn, step: 1 }, seq++, time))
  for (const item of append(seq, 1)) { events.push(item); seq += 1 }
  events.push(event('step/end', { turn, step: 1 }, seq++, time))
  events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, seq++, time))
  return seq
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
  const events: SessionEvent[] = []
  const loss: LossRecord[] = []
  const pendingCalls = new Map<string, { callId: string; name: string; arguments: string }>()
  // WorkBuddy can repeat the same call/result row (retries, streamed updates).
  // OpenAI-compatible gateways reject duplicate tool outputs for one call id,
  // so each callId emits at most one assistant tool-call block and one result.
  const emittedCallIds = new Set<string>()
  const resultedCallIds = new Set<string>()
  let seq = 0
  let turn = 0
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
      const currentTurn = ++turn
      if (role === 'assistant') {
        const message = createAssistantMessage({ content: content(textOf(row.content)), source: { provider: 'workbuddy', model: 'imported' } })
        seq = pushTurn(events, currentTurn, at, (start, step) => [surfaceEvent('assistant/message', { turn: currentTurn, step, message }, start, at)], seq)
      } else {
        const input = parsedInput!
        for (const warning of input.warnings) loss.push({ code: 'input-envelope-warning', detail: `line ${index + 1}: ${warning}` })
        seq = pushTurn(events, currentTurn, at, (start) => {
          const appended: SessionEvent[] = []
          let next = start
          if (input.contextSections.length > 0) {
            const contextMessage = createUserMessage({
              content: content(input.contextSections.map(section => `${section.name}:\n${section.text}`).join('\n\n')),
              source: { kind: 'plugin', plugin: 'WorkBuddy 上下文', form: 'snapshot', sections: input.contextSections },
            })
            appended.push(surfaceEvent('user/message', contextMessage, next, at))
            next += 1
          }
          if (input.text !== '' || !input.hadContext) {
            const message = createUserMessage({ content: content(input.text), source: { kind: 'user' } })
            appended.push(surfaceEvent('user/message', message, next, at))
          } else {
            loss.push({ code: 'context-only-message', detail: `line ${index + 1}: no user_query was present` })
          }
          return appended
        }, seq)
      }
    } else if (kind === 'reasoning') {
      const message = createAssistantMessage({ content: content(textOf(row.rawContent ?? row.content), true), source: { provider: 'workbuddy', model: 'imported' } })
      const currentTurn = ++turn
      seq = pushTurn(events, currentTurn, at, (start, step) => [surfaceEvent('assistant/message', { turn: currentTurn, step, message }, start, at)], seq)
    } else if (kind === 'function_call') {
      const callId = sourceId(row.callId ?? row.id, `workbuddy-call-${index}`)
      if (toolMode === 'narrative') {
        const callName = sourceId(row.name, 'unknown-tool')
        const callArgs = argumentsOf(row.arguments)
        const currentTurn = ++turn
        const message = createAssistantMessage({ content: content(`【工具调用 ${callName}】${callArgs}`), source: { provider: 'workbuddy', model: 'imported' } })
        seq = pushTurn(events, currentTurn, at, (start, step) => [surfaceEvent('assistant/message', { turn: currentTurn, step, message }, start, at)], seq)
        loss.push({ code: 'tool-flattened', detail: `line ${index + 1} (${callId})` })
        continue
      }
      if (emittedCallIds.has(callId) || resultedCallIds.has(callId)) {
        loss.push({ code: 'duplicate-tool-call', detail: `line ${index + 1} (${callId})` })
        continue
      }
      const call = { callId, name: sourceId(row.name, 'unknown-tool'), arguments: argumentsOf(row.arguments) }
      pendingCalls.set(callId, call)
      const currentTurn = ++turn
      seq = pushTurn(events, currentTurn, at, (start, step) => {
        const message = createAssistantMessage({
          content: toolCallContent(call),
          source: { provider: 'workbuddy', model: 'imported' },
        })
        return [
          surfaceEvent('assistant/message', { turn: currentTurn, step, message }, start, at),
          event('tool/call', { turn: currentTurn, step, callId: ToolCallId(callId), name: call.name, arguments: call.arguments }, start + 1, at),
        ]
      }, seq)
      emittedCallIds.add(callId)
    } else if (kind === 'function_call_result') {
      const callId = sourceId(row.callId ?? row.id, `workbuddy-call-${index}`)
      if (toolMode === 'narrative') {
        const outputText = textOf(row.output ?? row.content)
        const isError = row.status === 'error' || row.isError === true
        const currentTurn = ++turn
        const message = createUserMessage({ content: content(`【工具结果${isError ? '（错误）' : ''}】${outputText}`), source: { kind: 'user' } })
        seq = pushTurn(events, currentTurn, at, (start) => [surfaceEvent('user/message', message, start, at)], seq)
        loss.push({ code: 'tool-result-flattened', detail: `line ${index + 1} (${callId})` })
        continue
      }
      if (resultedCallIds.has(callId)) {
        loss.push({ code: 'duplicate-tool-result', detail: `line ${index + 1} (${callId})` })
        continue
      }
      let call = pendingCalls.get(callId)
      const orphan = call === undefined
      if (orphan) {
        loss.push({ code: 'orphan-tool-result', detail: `line ${index + 1} (${callId})` })
        // Keep an orphan result usable by the next model request. OpenAI-style
        // gateways reject a tool output whose call id never appeared in an
        // assistant tool-call message, so create a conservative synthetic call.
        call = {
          callId,
          name: sourceId(row.name, 'unknown-tool'),
          arguments: argumentsOf(row.arguments),
        }
      }
      const message = createToolResultMessage({ callId: ToolCallId(callId), content: content(textOf(row.output ?? row.content)), isError: row.status === 'error' || row.isError === true })
      const currentTurn = ++turn
      seq = pushTurn(events, currentTurn, at, (start, step) => {
        const appended: SessionEvent[] = []
        let next = start
        if (orphan) {
          const assistant = createAssistantMessage({
            content: toolCallContent(call!),
            source: { provider: 'workbuddy', model: 'imported' },
          })
          appended.push(surfaceEvent('assistant/message', { turn: currentTurn, step, message: assistant }, next, at))
          next += 1
        }
        appended.push(surfaceEvent('tool/result', { turn: currentTurn, step, message }, next, at))
        return appended
      }, seq)
      pendingCalls.delete(callId)
      resultedCallIds.add(callId)
      if (orphan) emittedCallIds.add(callId)
    } else if (kind === 'file-history-snapshot') loss.push({ code: 'file-history', detail: 'file history snapshots are not imported' })
    else loss.push({ code: 'unknown-event', detail: `${kind} at line ${index + 1}` })
  }
  if (pendingCalls.size > 0) {
    loss.push({ code: 'unpaired-tool-call', detail: `${String(pendingCalls.size)} tool call(s) have no result` })
    // Close every dangling assistant tool call with an explicit error result.
    // This keeps imported history valid for a subsequent user turn while the
    // loss record makes the source truncation visible in the audit report.
    for (const call of pendingCalls.values()) {
      const currentTurn = ++turn
      const at = Number.isFinite(createdAt) ? createdAt : Date.now()
      const message = createToolResultMessage({
        callId: ToolCallId(call.callId),
        content: content('WorkBuddy 未返回工具结果；此调用仅作为历史占位。'),
        isError: true,
      })
      seq = pushTurn(events, currentTurn, at, (start, step) => [surfaceEvent('tool/result', { turn: currentTurn, step, message }, start, at)], seq)
    }
  }
  title ??= firstUserTitle
  // Titles are log-only metadata and must precede the seed turns. Explicit
  // user-supplied titles cite no messages, which is the invariant accepted by
  // the session-title package. Shift converted event sequence numbers once.
  if (title) {
    for (const item of events) item.seq = SessionSeq(Number(item.seq) + 1)
    events.unshift({ type: 'session/title', seq: SessionSeq(0), time: Number.isFinite(createdAt) ? createdAt : Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } } as unknown as SessionEvent)
  }
  normalizeMessageSources(events)
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
