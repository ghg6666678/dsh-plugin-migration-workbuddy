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
import { estimateEventTokens } from './tokens.js'

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
 * v12: the checkpoint is written as the full four-frame compaction transaction
 * (start/summary/checkpoint/end). v11 emitted the checkpoint alone, which the
 * reader rejects with "compaction checkpoint has no matching compaction/start";
 * a bump is the only way to force those sessions to be rewritten.
 * v13: price the checkpoint's `shadowedTokenCount` with the runtime's own
 * heuristic (chars/4 + per-block/role overhead) instead of chars/3 over whole
 * event JSON — the old price was ~1.8x too high, displayed as "已压缩 1000多万
 * token", and drove `contextPressure.surfaceTokens` negative, which violates the
 * runtime's zod schema. Also stop treating WorkBuddy's `<cb_summary>` template
 * pages (verbatim history replays with no curated `<summary>`) as summaries:
 * they produced checkpoint "阶段 N" sections whose content was empty.
 * v14: when a huge transcript has no curated summary at all, rebuild a request
 * timeline from WorkBuddy's own `<cb_summary>` replays and fold that. Without it
 * those sessions import as full surfaces larger than the model window, and the
 * runtime compactor cannot summarize a prompt the model itself cannot receive.
 */
export const MIGRATION_CONVERTER_VERSION = 14

export type ToolMode = 'transcript' | 'narrative'

// Must match dsh-session's SURFACE_EVENT_TYPES: developer/message is a priced
// surface node too, so a replace over a range containing one must cite it.
const SURFACE_EVENT_TYPES = new Set([
  'user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message',
])

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
 * Estimated model-visible surface size above which a session cannot continue
 * without a fold, in the runtime's heuristic tokens (see `./tokens.js`).
 *
 * DSH compacts at `min(contextWindow * 0.8, contextWindow - headroom)`; with a
 * 300k window and the default 65536-token headroom that is 234,464 tokens.
 * Anything past that is guaranteed to hit compaction on the very first message
 * — and compaction cannot summarize a prompt the model itself cannot receive.
 * Folding at import time is what makes those projects work. 200k leaves room
 * for the tool schema and the live turn on top of the folded tail.
 */
export const AUTO_SUMMARY_TOKENS = 200_000

/** Structured WorkBuddy long-term summary extracted from one transcript row. */
interface WorkBuddySummary {
  /** Text of the `<summary>` block — the part that actually carries state. */
  text: string
  /** Line number the block was found on, for loss reporting. */
  line: number
}

/**
 * Boilerplate lines WorkBuddy writes around a compaction, without any state.
 *
 * A `<cb_summary>` row is a *verbatim replay* of the earlier transcript: a
 * template header plus `<previous_user_message>` / `<previous_tool_call>` blocks.
 * The old extractor stripped those blocks and kept the header and the blank
 * lines, then accepted the result because it was longer than 80 characters —
 * which is why imported checkpoints showed "阶段 1 / 阶段 2 …" sections whose
 * `<cb_summary>` content was empty. Only rows whose head is a curated
 * `<conversation_history_summary>` (or a 历史压缩摘要 section) carry state.
 */
const SUMMARY_BOILERPLATE = /^\s*(?:<cb_summary>|<\/cb_summary>|<conversation_history_summary>|<\/conversation_history_summary>|Summary of the conversation so far:?|The conversation is between an AI agent and a user\.?|Use this to get up to speed,?\s*and continue helping the user as the AI agent\.?|Some contents may be omitted,?\s*indicated by\s*["“]?<omitted\s*\/>["”]?\.?)\s*$/i

/** Strip the template frame so only the curated state is measured. */
function summarySubstance(text: string): string {
  return text.split('\n').filter(line => !SUMMARY_BOILERPLATE.test(line)).join('\n').replace(/\s+/g, ' ').trim()
}

/**
 * Detect a WorkBuddy *curated* compaction summary and pull out its `<summary>`
 * block.
 *
 * WorkBuddy writes two very different memory rows:
 * - `<conversation_history_summary>` with `<analysis>…</analysis>` and a curated
 *   `<summary>…</summary>` (a few KB of consolidated state). This is the only
 *   form worth carrying into a DSH checkpoint.
 * - `<cb_summary>` with the same template header plus `<previous_*>` blocks that
 *   replay the raw transcript. It has no curated `<summary>` and must be ignored;
 *   the events themselves are already in the log. A `<task-notification>` also
 *   contains a `<summary>` tag, but only says "Background command … completed".
 *
 * Requiring the curated head, a real `<summary>` block, and at least 80
 * characters of non-template substance keeps both junk forms out.
 */
function extractWorkBuddySummary(text: string, line: number): WorkBuddySummary | undefined {
  if (text.length === 0) return undefined
  const head = text.slice(0, 512)
  if (!/<conversation_history_summary>/i.test(head) && !/历史压缩摘要/.test(head)) return undefined
  const match = /<summary>([\s\S]*?)<\/summary>/i.exec(text)
  if (match === null) return undefined
  const body = (match[1] ?? '').trim()
  if (body.length < 80 || summarySubstance(body).length < 80) return undefined
  return { text: body, line }
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
function checkpointData(body: string, compactionId: string): Record<string, unknown> {
  const preamble = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. '
    + 'Treat the captured context as established background and build on it without restating it. '
    + 'Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
  return {
    role: 'user',
    id: randomUUID(),
    content: [
      { type: 'text', text: `${preamble}\n\n<compacted-summary>` },
      { type: 'text', text: body },
      { type: 'text', text: '</compacted-summary>' },
    ],
    // Exactly `compactCheckpointSource()`: the reader identifies a checkpoint by
    // this source kind plus a non-append `surfaceOp`, and rejects any
    // additional source key it does not know.
    source: { kind: 'compact-checkpoint', compactionId },
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
 * A deterministic digest reconstructed from WorkBuddy's `<cb_summary>` replays.
 *
 * Some transcripts never got a curated `<conversation_history_summary>`; their
 * only memory rows are the verbatim replay form. Those cannot become a real
 * summary, but they DO carry the user's actual requests and the assistant's
 * stated progress in tagged form. Extracting them gives a checkpoint body that
 * is honest about what it is and still lets a huge project be continued — the
 * alternative (a full import) exceeds the model window, and the runtime
 * compactor cannot summarize a prompt the model cannot receive.
 */
interface ReplayDigest {
  queries: string[]
  assistant: string[]
  seenQuery: Set<string>
  seenAssistant: Set<string>
}

/** Raw replay text to one readable line, decoding WorkBuddy's HTML entities. */
function cleanReplayText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Replay rows interleave background-task notifications; they are not requests. */
const REPLAY_NOISE = /completed (?:[Bb]ackground )?command|\[SYSTEM NOTIFICATION|Use the TaskOutput tool|\(bootloader\) max-download-size/i

const REPLAY_QUERY_LIMIT = 1500
const REPLAY_ASSISTANT_LIMIT = 400
/** Minimum digest size worth a checkpoint; below this the fold adds nothing. */
export const DIGEST_MIN_CHARS = 400

/** Collect the distinct user queries and assistant notes from one replay row. */
function collectReplayDigest(text: string, digest: ReplayDigest): void {
  if (!/<cb_summary>/i.test(text.slice(0, 512))) return
  for (const match of text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)) {
    const query = cleanReplayText(match[1] ?? '')
    if (query.length < 8 || REPLAY_NOISE.test(query)) continue
    const key = query.slice(0, 240)
    if (digest.seenQuery.has(key)) continue
    digest.seenQuery.add(key)
    digest.queries.push(query.length > REPLAY_QUERY_LIMIT ? `${query.slice(0, REPLAY_QUERY_LIMIT)}…` : query)
  }
  for (const match of text.matchAll(/<previous_assistant_message>([\s\S]*?)<\/previous_assistant_message>/gi)) {
    const note = cleanReplayText(match[1] ?? '')
    if (note.length < 24 || REPLAY_NOISE.test(note)) continue
    const key = note.slice(0, 240)
    if (digest.seenAssistant.has(key)) continue
    digest.seenAssistant.add(key)
    digest.assistant.push(note.length > REPLAY_ASSISTANT_LIMIT ? `${note.slice(0, REPLAY_ASSISTANT_LIMIT)}…` : note)
  }
}

/** Render the replay digest as a checkpoint body, or undefined when too thin. */
function renderDigestBody(digest: ReplayDigest): string | undefined {
  if (digest.queries.length === 0) return undefined
  const lines = [
    '（WorkBuddy 没有为这个会话生成整理过的压缩摘要。以下内容按时间顺序还原自它自己的历史回显：用户请求原文，以及助手当时自述的进展。项目细节仍保留在完整对话记录里。）',
    '',
    '## 用户请求（按时间顺序）',
    ...digest.queries.map((query, index) => `${String(index + 1)}. ${query}`),
  ]
  if (digest.assistant.length > 0) {
    lines.push('', '## 助手自述的进展（按时间顺序，已截断）', ...digest.assistant.map(note => `- ${note}`))
  }
  const body = lines.join('\n')
  return summarySubstance(body).length >= DIGEST_MIN_CHARS ? body : undefined
}

/**
 * Fold the summarized prefix of an imported transcript into one checkpoint.
 *
 * The appended events stay in the log, so the human transcript keeps every
 * message; the replacement only removes that prefix from the model-visible
 * surface. This is the transition `dsh-compaction-basic` commits, performed at
 * import time so a multi-million-token project is continuable immediately.
 *
 * @param body - the checkpoint summary text (curated merge or replay digest).
 * @returns the extended event list plus fold statistics, or `undefined` when no
 * balanced boundary exists within the tail budget.
 */
function foldSummaryIntoCheckpoint(
  events: SessionEvent[],
  body: string,
  tailTokens: number,
): { events: SessionEvent[]; shadowedEvents: number; shadowedTokens: number; keptTailEvents: number } | undefined {
  const nodes = events.filter(event => SURFACE_EVENT_TYPES.has(event.type) && (event as { surfaceOp?: unknown }).surfaceOp === 'append')
  if (nodes.length < 3) return undefined
  // Node 0 is the protected system head: a replace covering it must itself be a
  // system/message, so the fold always starts at node 1.
  // Price each surface node exactly as the runtime's token meter does. The
  // declared shadow price is charged against `contextPressure.surfaceTokens`,
  // so a different heuristic here would drive that counter negative and
  // violate the runtime's own zod schema (verified: chars/3 over whole event
  // JSON overstated this range ~1.8x).
  const sizes = nodes.map(node => estimateEventTokens(node as unknown as { type: string; data?: unknown }))
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
  const shadowedSeqs = shadowed.map(node => Number(node.seq))
  const compactionId = randomUUID()
  const startSeq = Number(nodes[1]!.seq)
  const endSeq = Number(nodes[endIndex]!.seq)
  let seq = events.reduce((max, event) => Math.max(max, Number(event.seq)), 0) + 1
  const time = Number(events[events.length - 1]!.time) + 1
  // A checkpoint is only legal inside an open compaction transaction: the
  // reader resolves `source.compactionId` against the `compaction/start` it saw
  // and rejects a bare replacement with "compaction checkpoint has no matching
  // compaction/start". So the import reproduces the exact four-frame sequence
  // `compactSurfaceRegion` commits — start, summary, replacement, end — instead
  // of appending the replacement on its own. `turn: null` is the manual
  // (out-of-turn) form, which is the only one valid in a seeded log.
  const lifecycle = { compactionId, turn: null }
  // Cite the transaction frames by their REAL sequence numbers. Writing
  // `startSeq`/`startSeq + 1` here instead would cite the first shadowed
  // messages rather than the frames, leaving the summary with no provenance.
  const startEventSeq = seq++
  const summaryEventSeq = seq++
  const checkpointEventSeq = seq++
  const endEventSeq = seq
  const transaction = [
    { type: 'compaction/start', seq: SessionSeq(startEventSeq), time, data: lifecycle },
    {
      type: 'compaction/summary',
      seq: SessionSeq(summaryEventSeq),
      time,
      data: {
        compactionId,
        summary: [{ type: 'text', text: body }],
        shadowedRange: { start: startSeq, end: endSeq },
        shadowedSeqs,
        shadowedTokenCount: shadowedTokens,
        provider: 'workbuddy',
        model: 'imported',
      },
    },
    {
      type: 'user/message',
      seq: SessionSeq(checkpointEventSeq),
      time,
      surfaceOp: { op: 'replace', startSeq: SessionSeq(startSeq), endSeq: SessionSeq(endSeq) },
      // Every shadowed surface node must be cited or the replace rejects, and
      // the two preceding transaction frames are cited so the summary has a
      // provenance the reader can resolve.
      sourceEventSeqs: [startEventSeq, summaryEventSeq, ...shadowedSeqs],
      data: checkpointData(body, compactionId),
    },
    { type: 'compaction/end', seq: SessionSeq(endEventSeq), time, data: lifecycle },
  ] as unknown as SessionEvent[]
  return { events: [...events, ...transaction], shadowedEvents: shadowed.length, shadowedTokens, keptTailEvents: nodes.length - endIndex - 1 }
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
  // The verbatim-replay form has no curated `<summary>`, but its tagged
  // `<user_query>` / `<previous_assistant_message>` blocks still describe what
  // the user asked for. Kept separately so it is never mistaken for a summary.
  const replayDigest: ReplayDigest = { queries: [], assistant: [], seenQuery: new Set(), seenAssistant: new Set() }
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
        collectReplayDigest(rawText, replayDigest)
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
    // Measure the model-visible surface in the SAME runtime heuristic tokens as
    // the fold's shadow price, not chars/3 over the whole event JSON. The old
    // estimate ran ~2.2x high and made `auto` fold sessions that fit comfortably.
    const logTokens = events.reduce((sum, event) => sum + estimateEventTokens(event as unknown as { type: string; data?: unknown }), 0)
    const tailTokens = options.summaryTailTokens ?? DEFAULT_SUMMARY_TAIL_TOKENS
    const foldWith = (body: string): boolean => {
      const folded = foldSummaryIntoCheckpoint(events, body, tailTokens)
      if (folded === undefined) return false
      events.splice(0, events.length, ...folded.events)
      fold = { shadowedEvents: folded.shadowedEvents, shadowedTokens: folded.shadowedTokens, keptTailEvents: folded.keptTailEvents }
      return true
    }
    const digestBody = distinct.length === 0 ? renderDigestBody(replayDigest) : undefined
    if (summaryMode === 'auto' && logTokens <= AUTO_SUMMARY_TOKENS) {
      // Nothing to do: the whole project already fits a normal turn.
    } else if (distinct.length > 0) {
      // The part the summary does not already cover is the recent tail, so it
      // survives the fold: it is what lets the model resume detailed work.
      if (!foldWith(renderSummaryBody(distinct))) {
        loss.push({ code: 'summary-unfoldable', detail: '摘要无法与导入事件安全对齐（工具调用与结果必须成对折叠）；已按完整记录导入' })
      } else {
        loss.push({
          code: 'summary-checkpoint',
          detail: `已把 ${String(distinct.length)} 份 WorkBuddy 摘要合并为 DSH checkpoint：折叠 ${String(fold!.shadowedEvents)} 条历史（约 ${String(fold!.shadowedTokens)} token），保留最近 ${String(fold!.keptTailEvents)} 条；对话记录本身完整保留，可随时查看`,
        })
      }
    } else if (logTokens > AUTO_SUMMARY_TOKENS && digestBody !== undefined) {
      // No curated summary exists, but the transcript is too large to send as-is
      // and the runtime cannot summarize a prompt the model itself cannot
      // receive. The replay rows still describe what the user asked for, so fold
      // that instead of leaving an unusable full import.
      if (!foldWith(digestBody)) {
        loss.push({ code: 'summary-unfoldable', detail: '历史回显无法与导入事件安全对齐（工具调用与结果必须成对折叠）；已按完整记录导入' })
      } else {
        loss.push({
          code: 'summary-digest',
          detail: `WorkBuddy 没有为这个会话生成整理过的压缩摘要，因此按它自己的历史回显还原了一份请求时间线作为 checkpoint：折叠 ${String(fold!.shadowedEvents)} 条历史（约 ${String(fold!.shadowedTokens)} token），保留最近 ${String(fold!.keptTailEvents)} 条；对话记录本身完整保留，可随时查看`,
        })
      }
    } else {
      loss.push({
        code: 'summary-missing',
        detail: logTokens > 0
          ? `这个会话约 ${String(logTokens)} token，超出可直接继续的范围，但 WorkBuddy 既没有生成压缩摘要、也没有留下可还原的历史回显，因此只能按完整记录导入；发消息时 DSH 会尝试实时压缩`
          : 'WorkBuddy 没有为这个会话生成压缩摘要，因此无法折叠成 checkpoint；已按完整记录导入',
      })
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
