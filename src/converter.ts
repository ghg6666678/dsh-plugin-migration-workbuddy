import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
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
 * v10: keep the memory summary as an ordinary message (View = full history).
 * v11: `summaryMode: 'checkpoint'` folds WorkBuddy's own summaries into a real
 * DSH compaction checkpoint so a huge project is continuable at import time.
 */
export const MIGRATION_CONVERTER_VERSION = 11

export type ToolMode = 'transcript' | 'narrative'

const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message'])

/** A protected system head for a seed that starts mid-conversation. */
function systemHeadEvent(turn: number, step: number, time: number): SessionEvent {
  return {
    type: 'system/message',
    seq: 0,
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: randomUUID(),
        role: 'system',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: 'WorkBuddy 导入的历史记录（较早轮次已按上下文预算省略；系统提示由当前部署在后续轮次重新提供）。' }],
      },
    },
  } as unknown as SessionEvent
}

/** Insert the protected system head right after the first step/start when missing. */
function ensureSystemHead(events: SessionEvent[]): SessionEvent[] {
  const firstSurface = events.findIndex(event => SURFACE_EVENT_TYPES.has(event.type))
  if (firstSurface === -1 || (events[firstSurface] as { type?: string }).type === 'system/message') return events
  let stepIndex = -1
  for (let index = firstSurface - 1; index >= 0; index -= 1) {
    if (events[index]!.type === 'step/start') { stepIndex = index; break }
  }
  if (stepIndex === -1) return events
  const stepData = events[stepIndex]!.data as { turn: number; step: number }
  const head = systemHeadEvent(stepData.turn, stepData.step, events[firstSurface]!.time)
  return [...events.slice(0, stepIndex + 1), head, ...events.slice(stepIndex + 1)]
}

/**
 * Drop the oldest turns until the seed fits the model context budget.
 *
 * A large WorkBuddy project can exceed the provider's context window once the
 * whole transcript is sent as history. Keeping the most recent turns and a
 * protected system head keeps the session continuable.
 */
type MemorySection = { name: string; text: string; index: number }

/**
 * WorkBuddy keeps its long-term memory as a giant rolling compaction summary
 * (`cb_summary`) plus a short task summary. When the raw history is trimmed,
 * that summary is what stops the model from forgetting the project's start.
 */
function pickMemorySummary(events: SessionEvent[]): MemorySection | undefined {
  let comprehensive: MemorySection | undefined
  let latest: MemorySection | undefined
  for (const [index, event] of events.entries()) {
    if (event.type !== 'user/message') continue
    const sections = (event as unknown as { data?: { source?: { sections?: unknown } } }).data?.source?.sections
    if (!Array.isArray(sections)) continue
    for (const section of sections) {
      if (section === null || typeof section !== 'object') continue
      const candidate = section as { name?: unknown; text?: unknown }
      if (typeof candidate.name !== 'string' || typeof candidate.text !== 'string' || candidate.text === '') continue
      if (candidate.name === '历史压缩摘要') comprehensive = { name: candidate.name, text: candidate.text, index }
      else if (candidate.name === '历史摘要') latest = { name: candidate.name, text: candidate.text, index }
    }
  }
  return comprehensive ?? latest
}

function memorySummaryEvent(section: { name: string; text: string }, time: number): SessionEvent {
  return {
    type: 'user/message',
    seq: 0,
    time,
    surfaceOp: 'append',
    data: {
      ...createUserMessage({
        content: content(section.text),
        // Format v4 refuses the retired 'plugin' wrapper; the trim pass runs
        // after normalizeMessageSources, so it must pick the kind here.
        source: { kind: V4 ? IMPORT_SOURCE_KIND : 'plugin', plugin: 'WorkBuddy 历史摘要', form: 'snapshot', sections: [section] } as never,
      }),
    },
  } as unknown as SessionEvent
}

export function trimEventsToBudget(events: SessionEvent[], budgetChars: number): { events: SessionEvent[]; droppedTurns: number } {
  if (budgetChars <= 0 || events.length === 0) return { events, droppedTurns: 0 }
  const starts: number[] = []
  for (let index = 0; index < events.length; index += 1) if (events[index]!.type === 'turn/start') starts.push(index)
  if (starts.length <= 1) return { events, droppedTurns: 0 }
  const prefix = events.slice(0, starts[0])
  const turns = starts.map((start, index) => events.slice(start, index + 1 < starts.length ? starts[index + 1] : events.length))
  let total = 0
  for (const turn of turns) for (const event of turn) total += JSON.stringify(event).length
  if (total <= budgetChars) return { events, droppedTurns: 0 }

  const memory = pickMemorySummary(events)
  const memoryChars = memory === undefined ? 0 : Math.min(memory.text.length, Math.floor(budgetChars * 0.5))
  const turnBudget = Math.max(20_000, budgetChars - memoryChars)
  let accumulated = 0
  let keepFrom = turns.length
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    accumulated += turns[index]!.reduce((sum, event) => sum + JSON.stringify(event).length, 0)
    if (accumulated > turnBudget) break
    keepFrom = index
  }
  if (keepFrom === 0) keepFrom = 1
  if (keepFrom >= turns.length) keepFrom = turns.length - 1
  let kept = [...prefix, ...turns.slice(keepFrom).flat()]
  // Turn numbers are one-based and sequential in DSH; renumber the kept window.
  const firstTurn = kept.find(event => event.type === 'turn/start')
  const baseTurn = firstTurn === undefined ? 1 : Number((firstTurn.data as { turn: number }).turn)
  for (const event of kept) {
    const data = (event as unknown as { data?: { turn?: unknown } }).data
    if (data !== undefined && typeof data.turn === 'number') data.turn = data.turn - baseTurn + 1
  }
  kept = ensureSystemHead(kept)
  // Re-inject the compaction summary when it fell outside the kept window.
  if (memory !== undefined && memory.index < starts[keepFrom]!) {
    const stepIndex = kept.findIndex(event => event.type === 'step/start')
    const injected = memorySummaryEvent(
      { name: memory.name, text: memoryChars < memory.text.length ? `${memory.text.slice(0, memoryChars)}\n…（摘要已按上下文预算截断）` : memory.text },
      kept[stepIndex + 1]?.time ?? Date.now(),
    )
    kept = [...kept.slice(0, stepIndex + 2), injected, ...kept.slice(stepIndex + 2)]
  }
  for (let index = 0; index < kept.length; index += 1) (kept[index] as unknown as { seq: number }).seq = index
  return { events: kept, droppedTurns: keepFrom }
}

export interface ConvertOptions {
  toolMode?: ToolMode
  /**
   * Fold a WorkBuddy long-term summary into a DSH compaction checkpoint so the
   * imported project can be continued instead of merely read.
   *
   * `'none'` (default) imports the transcript verbatim. `'checkpoint'` keeps
   * every appended event for the human transcript but lands a
   * `compact-checkpoint` replacement over the summarized prefix, so the model
   * receives the summary plus the recent tail instead of millions of tokens.
   */
  summaryMode?: SummaryMode
  /**
   * Token size of the recent tail kept outside the checkpoint in
   * `summaryMode: 'checkpoint'`. The tail is what lets the model resume detailed
   * work; everything older is represented by the summary. Defaults to
   * `DEFAULT_SUMMARY_TAIL_TOKENS`.
   */
  summaryTailTokens?: number
}

/** Recent tail kept verbatim when folding a summary into a checkpoint. */
export const DEFAULT_SUMMARY_TAIL_TOKENS = 40_000

/**
 * How an imported WorkBuddy summary is exposed to the model.
 *
 * - `auto` (default): fold only when the transcript is too large to continue
 *   as-is. Small projects import verbatim; a multi-million-token project would
 *   otherwise be unable to compact at all (the model never receives it).
 * - `always`: fold whenever WorkBuddy wrote a summary.
 * - `never`: import only; the summary stays ordinary history.
 */
export type SummaryMode = 'auto' | 'always' | 'never'

/**
 * Estimated log size above which a session cannot continue without a fold.
 *
 * DSH compacts at 80% of the model window and the default window is 300k
 * tokens, so anything past ~240k is guaranteed to hit compaction on the very
 * first message — and compaction cannot summarize a prompt the model itself
 * cannot receive. Folding at import time is what makes those projects work.
 */
export const AUTO_SUMMARY_TOKENS = 200_000

/** Chars per token for the rough budget DSH itself uses when trimming. */
const CHARS_PER_TOKEN = 3

/** Structured WorkBuddy long-term summary extracted from one transcript row. */
interface WorkBuddySummary {
  /** Text of the `<summary>` block — the part that actually carries state. */
  text: string
  /** Line number the block was found on, for loss reporting. */
  line: number
  /** Whether the row also re-embedded tool calls (the bulky, redundant form). */
  embeddedHistory: boolean
}

/**
 * Detect a WorkBuddy long-term memory row and pull out its `<summary>` block.
 *
 * WorkBuddy writes two shapes of the same summary: a compact one holding only
 * `<conversation_history_summary>` (a few KB), and a much larger one that
 * re-embeds hundreds of `<previous_tool_call>` records. Both carry the curated
 * `<summary>` text; the re-embedded history is already covered by it, so only
 * the summary is retained — that drops a 528 KB row to ~5 KB.
 */
function extractWorkBuddySummary(text: string, line: number): WorkBuddySummary | undefined {
  if (text.length === 0) return undefined
  const head = text.slice(0, 512)
  const isMemory = /<cb_summary>|<conversation_history_summary>/i.test(head) || /历史压缩摘要/.test(head)
  if (!isMemory) return undefined
  const match = /<summary>([\s\S]*?)<\/summary>/i.exec(text)
  // A memory row without a <summary> tag still ends up summarized state; keep
  // the leading prose but never the re-embedded tool history.
  const body = (match?.[1] ?? (match === null ? text.replace(/<previous_[a-z_]+>[\s\S]*?<\/previous_[a-z_]+>/gi, '') : '')).trim()
  if (body.length < 80) return undefined
  return { text: body, line, embeddedHistory: /<previous_tool_call>|<previous_user_message>/i.test(text) }
}

/** Collapse repeated re-embeddings of the same summary into one timeline. */
function dedupeSummaries(summaries: WorkBuddySummary[]): WorkBuddySummary[] {
  const seen = new Set<string>()
  const kept: WorkBuddySummary[] = []
  for (const summary of summaries) {
    const key = createHash('sha256').update(summary.text).digest('hex')
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(summary)
  }
  return kept
}

/**
 * Render the consolidated summary body for a DSH checkpoint.
 *
 * DSH's own summarizer prompt asks the model to *merge* a prior checkpoint
 * instead of copying it forward; WorkBuddy never did, which is why one
 * transcript accumulates a summary per compaction. Importing the distinct
 * versions in order reproduces that consolidation without another model call.
 */
function renderSummaryBody(summaries: WorkBuddySummary[]): string {
  if (summaries.length === 1) return summaries[0]!.text
  const stages = summaries.map((summary, index) => `## 阶段 ${String(index + 1)}\n${summary.text}`).join('\n\n---\n\n')
  return `（本摘要按时间顺序合并了 WorkBuddy 在各阶段生成的 ${String(summaries.length)} 份压缩摘要。）\n\n${stages}`
}

/**
 * Build the DSH checkpoint replacement message.
 *
 * Mirrors `frameSummary` from `dsh-compaction-basic` — preamble plus
 * `<compacted-summary>` open tag, the summary body, then the close tag — because
 * every consumer recognizes a checkpoint by `data.source.kind ===
 * 'compact-checkpoint'` together with a non-append `surfaceOp`, not by the text.
 */
function checkpointData(body: string, compactionId: string, shadowedTokens: number): Record<string, unknown> {
  const preamble = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. '
    + 'Treat the captured context as established background and build on it without restating it. '
    + 'Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
  return {
    role: 'user',
    id: randomUUID(),
    content: [
      { type: 'text', text: `${preamble}\n\n<compacted-summary>` },
      { type: 'text', text: `<compacted-summary>\n\n${body}` },
      { type: 'text', text: '</compacted-summary>' },
    ],
    source: { kind: 'compact-checkpoint', compactionId, shadowedTokenCount: shadowedTokens },
  }
}

/** Assistant tool calls add to the pairing balance; each result closes one. */
function pairingDelta(event: SessionEvent): number {
  if (event.type === 'assistant/message') {
    const message = (event.data as { message?: { content?: Array<{ type?: string }> } }).message
    return (message?.content ?? []).filter(block => block.type === 'tool-call').length
  }
  if (event.type === 'tool/result') return -1
  return 0
}

/**
 * Fold the summarized prefix of an imported transcript into one checkpoint.
 *
 * The appended events stay in the log, so the human transcript keeps every
 * message; the replacement only removes that prefix from the model-visible
 * surface. This is the transition `dsh-compaction-basic` commits, performed at
 * import time so a multi-million-token project is continuable immediately.
 *
 * @returns the extended event list plus fold statistics, or `undefined` when no
 * balanced boundary exists within the tail budget.
 */
function foldSummaryIntoCheckpoint(
  events: SessionEvent[],
  summaries: WorkBuddySummary[],
  tailTokens: number,
): { events: SessionEvent[]; shadowedEvents: number; shadowedTokens: number; keptTailEvents: number } | undefined {
  const nodes = events.filter(event => SURFACE_EVENT_TYPES.has(event.type) && (event as { surfaceOp?: unknown }).surfaceOp === 'append')
  if (nodes.length < 3) return undefined
  // Node 0 is the protected system head: a replace covering it must itself be a
  // system/message, so the fold always starts at node 1.
  const sizes = nodes.map(node => Math.round(JSON.stringify(node).length / CHARS_PER_TOKEN))
  let keepFrom = nodes.length
  let tail = 0
  while (keepFrom > 2 && tail + sizes[keepFrom - 1]! <= tailTokens) {
    tail += sizes[keepFrom - 1]!
    keepFrom -= 1
  }
  if (keepFrom < 2) keepFrom = 2
  // Never split a tool call from its result: walk the boundary back until the
  // shadowed prefix is pair-balanced, exactly as the compaction engine does.
  const balances: number[] = []
  let balance = 0
  for (const node of nodes) {
    balance += pairingDelta(node)
    if (balance < 0) return undefined
    balances.push(balance)
  }
  let endIndex = keepFrom - 1
  while (endIndex >= 1 && balances[endIndex] !== 0) endIndex -= 1
  if (endIndex < 1) return undefined
  const shadowed = nodes.slice(1, endIndex + 1)
  if (shadowed.length === 0) return undefined
  const shadowedTokens = shadowed.reduce((sum, _node, index) => sum + sizes[index + 1]!, 0)
  const compactionId = randomUUID()
  const seq = events.reduce((max, event) => Math.max(max, Number(event.seq)), 0) + 1
  const checkpoint = {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: Number(events[events.length - 1]!.time) + 1,
    surfaceOp: { op: 'replace', startSeq: SessionSeq(Number(nodes[1]!.seq)), endSeq: SessionSeq(Number(nodes[endIndex]!.seq)) },
    // Every shadowed surface node must be cited or the fold rejects the replace.
    sourceEventSeqs: shadowed.map(node => Number(node.seq)),
    data: checkpointData(renderSummaryBody(summaries), compactionId, shadowedTokens),
  } as unknown as SessionEvent
  return { events: [...events, checkpoint], shadowedEvents: shadowed.length, shadowedTokens, keptTailEvents: nodes.length - endIndex - 1 }
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
  private systemHeadEmitted = false
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
    // A seeded session must carry a protected system head: when the user later
    // continues it, the runtime appends its real system/message and the format
    // only accepts that after a first surface head exists.
    if (!this.systemHeadEmitted && this.turn === 1 && this.step === 1) {
      this.systemHeadEmitted = true
      this.events.push({
        type: 'system/message',
        seq: SessionSeq(this.seq),
        time,
        surfaceOp: 'append',
        data: {
          turn: this.turn,
          step: this.step,
          message: {
            id: randomUUID(),
            role: 'system',
            source: { kind: 'system-prompt' },
            content: [{ type: 'text', text: 'WorkBuddy 导入的历史记录（系统提示由当前部署在后续轮次重新提供）。' }],
          },
        },
      } as unknown as SessionEvent)
      this.seq += 1
    }
  }

  /** Emit the buffered assistant message and its tool calls in the current step. */
  private flush(time: number): void {
    if (this.bufferedBlocks.length === 0 && this.bufferedCalls.length === 0) return
    this.ensureStep(time)
    if (this.bufferedBlocks.length > 0) {
      // Tool calls must be the last content blocks: providers reject a
      // `tool_use` that is followed by more assistant text instead of the
      // matching `tool_result`.
      const ordered = [
        ...this.bufferedBlocks.filter(block => block.type !== 'tool-call'),
        ...this.bufferedBlocks.filter(block => block.type === 'tool-call'),
      ]
      const message = createAssistantMessage({ content: ordered, source: { provider: 'workbuddy', model: 'imported' } })
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
  const sourceSessionId = basename(path, '.jsonl')
  const parts = relative(`${root}/projects`, path).split(sep)
  const projectHash = parts[0] ?? 'unknown'
  const assembler = new TurnAssembler()
  const loss: LossRecord[] = []
  // WorkBuddy can repeat the same call/result row (retries, streamed updates).
  // OpenAI-compatible gateways reject duplicate tool outputs for one call id,
  // so each callId emits at most one assistant tool-call block and one result.
  const emittedCallIds = new Set<string>()
  const resultedCallIds = new Set<string>()
  // WorkBuddy periodically folds its own history into a `<cb_summary>` memory
  // row. Collect the distinct ones so `summaryMode: 'checkpoint'` can reuse that
  // curation as a DSH checkpoint instead of paying for another summarization.
  const summaries: WorkBuddySummary[] = []
  let title: string | undefined = metadata?.title
  let firstUserTitle: string | undefined
  let createdAt = Number.POSITIVE_INFINITY
  let cwd: string | undefined = metadata?.cwd
  // Stream the transcript: a project can be hundreds of MiB, and reading it as
  // one string both spikes memory and exceeds V8's string limit.
  const digest = createHash('sha256')
  const stream = createReadStream(path)
  stream.on('data', (chunk: string | Buffer) => { digest.update(chunk) })
  const input = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0
  for await (const rawLine of input) {
    lineNumber += 1
    const line = rawLine.trim()
    if (!line) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { loss.push({ code: 'invalid-json', detail: `line ${lineNumber}` }); continue }
    const row = record(parsed)
    if (row === undefined) { loss.push({ code: 'invalid-record', detail: `line ${lineNumber}` }); continue }
    const kind = sourceId(row.type ?? row.event ?? row.kind, 'unknown')
    const at = timeOf(row.timestamp ?? row.time ?? row.createdAt, Date.now())
    createdAt = Math.min(createdAt, at)
    if (cwd === undefined && typeof row.cwd === 'string' && isAbsolute(row.cwd)) cwd = row.cwd
    if (kind === 'ai-title') title = textOf(row.aiTitle)
    else if (kind === 'custom-title') title = textOf(row.customTitle)
    else if (kind === 'summary') loss.push({ code: 'summary-metadata', detail: 'summary retained in import manifest' })
    else if (kind === 'message') {
      const role = row.role === 'assistant' ? 'assistant' : 'user'
      const rawText = textOf(row.content)
      if (role === 'user') {
        const memory = extractWorkBuddySummary(rawText, lineNumber)
        if (memory !== undefined) summaries.push(memory)
      }
      const parsedInput = role === 'user' ? parseWorkBuddyInput(rawText) : undefined
      if (role === 'user' && firstUserTitle === undefined) {
        const candidate = (parsedInput?.text ?? textOf(row.content)).trim()
        if (candidate) firstUserTitle = candidate.slice(0, 80)
      }
      if (role === 'assistant') {
        assembler.assistant(content(textOf(row.content)), at)
      } else {
        const input = parsedInput!
        for (const warning of input.warnings) loss.push({ code: 'input-envelope-warning', detail: `line ${lineNumber}: ${warning}` })
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
          loss.push({ code: 'context-only-message', detail: `line ${lineNumber}: no user_query was present` })
        }
        if (messages.length > 0) assembler.userRow(messages, at)
      }
    } else if (kind === 'reasoning') {
      assembler.assistant(content(textOf(row.rawContent ?? row.content), true), at)
    } else if (kind === 'function_call') {
      const callId = sourceId(row.callId ?? row.id, `workbuddy-call-${lineNumber}`)
      const callName = sourceId(row.name, 'unknown-tool')
      const callArguments = argumentsOf(row.arguments)
      if (toolMode === 'narrative') {
        assembler.assistant(content(`【工具调用 ${callName}】${callArguments}`), at)
        loss.push({ code: 'tool-flattened', detail: `line ${lineNumber} (${callId})` })
        continue
      }
      if (emittedCallIds.has(callId) || resultedCallIds.has(callId)) {
        loss.push({ code: 'duplicate-tool-call', detail: `line ${lineNumber} (${callId})` })
        continue
      }
      assembler.call({ callId, name: callName, arguments: callArguments }, at)
      emittedCallIds.add(callId)
    } else if (kind === 'function_call_result') {
      const callId = sourceId(row.callId ?? row.id, `workbuddy-call-${lineNumber}`)
      const isError = row.status === 'error' || row.isError === true
      if (toolMode === 'narrative') {
        const outputText = textOf(row.output ?? row.content)
        assembler.assistant(content(`【工具结果${isError ? '（错误）' : ''}】${outputText}`), at)
        loss.push({ code: 'tool-result-flattened', detail: `line ${lineNumber} (${callId})` })
        continue
      }
      if (resultedCallIds.has(callId)) {
        loss.push({ code: 'duplicate-tool-result', detail: `line ${lineNumber} (${callId})` })
        continue
      }
      const known = assembler.knownCall(callId)
      const orphan = known === undefined && !assembler.wasSynthesized(callId)
      if (assembler.wasSynthesized(callId)) {
        loss.push({ code: 'duplicate-tool-result', detail: `line ${lineNumber} (${callId}): result arrived after the call was closed` })
        resultedCallIds.add(callId)
        continue
      }
      if (orphan) loss.push({ code: 'orphan-tool-result', detail: `line ${lineNumber} (${callId})` })
      const call = known ?? { callId, name: sourceId(row.name, 'unknown-tool'), arguments: argumentsOf(row.arguments) }
      const resultMessage = createToolResultMessage({ callId: ToolCallId(callId), content: content(textOf(row.output ?? row.content)), isError })
      assembler.result(call, resultMessage, orphan, at)
      resultedCallIds.add(callId)
      if (orphan) emittedCallIds.add(callId)
    } else if (kind === 'file-history-snapshot') loss.push({ code: 'file-history', detail: 'file history snapshots are not imported' })
    else loss.push({ code: 'unknown-event', detail: `${kind} at line ${lineNumber}` })
  }
  const sourceHash = digest.digest('hex')
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
  // Fold AFTER every structural change above. `foldSurface` replays the log with
  // the array index as the event sequence, so `surfaceOp` and `sourceEventSeqs`
  // must cite final positions — folding earlier would cite pre-title indices and
  // desynchronize every reference by one.
  let fold: { shadowedEvents: number; shadowedTokens: number; keptTailEvents: number } | undefined
  const summaryMode = options.summaryMode ?? 'auto'
  if (summaryMode !== 'never') {
    const distinct = dedupeSummaries(summaries)
    // `auto` only intervenes when leaving the log intact would make the import
    // unusable (see AUTO_SUMMARY_TOKENS). A small project keeps its real
    // transcript so the model sees exactly what the user saw.
    const logTokens = summaryMode === 'auto'
      ? Math.round(events.reduce((sum, event) => sum + JSON.stringify(event).length, 0) / CHARS_PER_TOKEN)
      : 0
    if (summaryMode === 'auto' && logTokens <= AUTO_SUMMARY_TOKENS) {
      // Nothing to do: the whole project already fits a normal turn.
    } else if (distinct.length === 0) {
      loss.push({
        code: 'summary-missing',
        detail: logTokens > 0
          ? `这个会话约 ${String(logTokens)} token，超出可直接继续的范围，但 WorkBuddy 没有为它生成压缩摘要，因此只能按完整记录导入；发消息时 DSH 会尝试实时压缩`
          : 'WorkBuddy 没有为这个会话生成压缩摘要，因此无法折叠成 checkpoint；已按完整记录导入',
      })
    } else {
      // The part the summary does not already cover is the recent tail, so it
      // survives the fold: it is what lets the model resume detailed work.
      const folded = foldSummaryIntoCheckpoint(events, distinct, options.summaryTailTokens ?? DEFAULT_SUMMARY_TAIL_TOKENS)
      if (folded === undefined) {
        loss.push({ code: 'summary-unfoldable', detail: '摘要无法与导入事件安全对齐（工具调用与结果必须成对折叠）；已按完整记录导入' })
      } else {
        events.splice(0, events.length, ...folded.events)
        fold = { shadowedEvents: folded.shadowedEvents, shadowedTokens: folded.shadowedTokens, keptTailEvents: folded.keptTailEvents }
        loss.push({
          code: 'summary-checkpoint',
          detail: `已把 ${String(distinct.length)} 份 WorkBuddy 摘要合并为 DSH checkpoint：折叠 ${String(folded.shadowedEvents)} 条历史（约 ${String(folded.shadowedTokens)} token），保留最近 ${String(folded.keptTailEvents)} 条；对话记录本身完整保留，可随时查看`,
        })
      }
    }
  }
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
    ...(fold === undefined ? {} : { summaryFold: fold }),
  }
}
