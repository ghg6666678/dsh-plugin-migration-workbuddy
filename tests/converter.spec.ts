import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { convertWorkBuddySession, trimEventsToBudget } from '../src/converter.js'
import { estimateEventTokens } from '../src/tokens.js'

/** The pinned test peer predates system/message; derive messages without it. */
function derivable(events: readonly unknown[]): never[] {
  return (events as Array<{ type?: string; seq?: number }>)
    .filter(item => item.type !== 'system/message')
    .map((item, index) => ({ ...item, seq: index })) as never[]
}

describe('WorkBuddy converter', () => {
  it('keeps message order, reasoning and tool events in a contiguous DSH log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'hello', timestamp: 1000, cwd: root }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'hi', timestamp: 2000 }),
      JSON.stringify({ type: 'reasoning', rawContent: 'think', timestamp: 3000 }),
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: { path: 'a' }, timestamp: 4000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'ok', status: 'success', timestamp: 5000 }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Demo' }),
      JSON.stringify({ type: 'file-history-snapshot' }),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root)
    expect(converted.title).toBe('Demo')
    expect(converted.events.map(event => (event as { type: string }).type)).toContain('tool/call')
    expect(converted.events.map(event => (event as { type: string }).type)).toContain('tool/result')
    expect(converted.events.every((event, index) => Number((event as { seq: number }).seq) === index)).toBe(true)
    expect(converted.events.filter(event => (event as { type: string }).type === 'turn/start').every(event => Number((event as { data: { turn: number } }).data.turn) >= 1)).toBe(true)
    expect(converted.events.filter(event => (event as { type: string }).type === 'step/start').every(event => Number((event as { data: { step: number } }).data.step) >= 1)).toBe(true)
    expect(converted.events.filter(event => ['user/message', 'assistant/message', 'tool/result'].includes((event as { type?: string }).type ?? '')).every(event => (event as { surfaceOp?: string }).surfaceOp === 'append')).toBe(true)
    expect(converted.loss.map(item => item.code)).toContain('file-history')
  })

  it('projects tool calls and results as a provider-valid paired transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-tools-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: { path: 'a' }, timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'ok', status: 'success', timestamp: 1100 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'continue', timestamp: 1200 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-tool-pair'), derivable(converted.events))
    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['assistant', 'user', 'user'])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-call', id: 'c1', name: 'read' })
    expect(messages[1]?.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'c1' })
    expect(messages[2]?.content[0]).toMatchObject({ type: 'text', text: 'continue' })
  })

  it('synthesizes a call for orphan results and a result for dangling calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-tool-repair-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call_result', callId: 'orphan', name: 'lookup', output: 'missing call', timestamp: 1000 }),
      JSON.stringify({ type: 'function_call', callId: 'dangling', name: 'write', arguments: '{}', timestamp: 1100 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-tool-repair'), derivable(converted.events))
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls.map(block => block.type === 'tool-call' ? block.id : '')).toEqual(['orphan', 'dangling'])
    expect(results.map(block => block.type === 'tool-result' ? block.toolCallId : '')).toEqual(['orphan', 'dangling'])
    expect(converted.loss.map(item => item.code)).toEqual(expect.arrayContaining(['orphan-tool-result', 'unpaired-tool-call']))
  })

  it('keeps the authoritative workspace cwd from WorkBuddy records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-cwd-'))
    const project = 'Users-example-Workspace-Projects-acme-dashboard'
    await mkdir(join(root, 'projects', project), { recursive: true })
    const path = join(root, 'projects', project, 's.jsonl')
    const cwd = '/Users/example/Workspace/Projects/acme-dashboard'
    await writeFile(path, JSON.stringify({ type: 'message', role: 'user', content: 'hello', cwd, timestamp: 1000 }))
    const converted = await convertWorkBuddySession(path, root)
    expect(converted.cwd).toBe(cwd)
  })

  it('renders WorkBuddy context as a collapsible snapshot and keeps the query clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-context-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, JSON.stringify({
      type: 'message', role: 'user', timestamp: 1000,
      content: '<system-reminder data-role="user-context"><user_info>OS Version: darwin</user_info><user_query>你好</user_query></system-reminder>',
    }))
    const converted = await convertWorkBuddySession(path, root)
    const messages = converted.events.filter(event => (event as { type?: string }).type === 'user/message') as Array<{ data: { content: Array<{ text?: string }>; source: Record<string, unknown> } }>
    expect(messages).toHaveLength(2)
    expect(messages[0]?.data.source).toMatchObject({ kind: 'plugin', plugin: 'WorkBuddy 上下文', form: 'snapshot' })
    expect(messages[1]?.data.content[0]?.text).toBe('你好')
    expect(messages[1]?.data.content[0]?.text).not.toContain('system-reminder')
  })

  it('uses catalog metadata for the title, mode and canonical cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-metadata-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 'session.jsonl')
    await writeFile(path, JSON.stringify({ type: 'message', role: 'user', content: 'hello', cwd: '/wrong', timestamp: 1000 }))
    const converted = await convertWorkBuddySession(path, root, {
      sourceSessionId: 'session', mode: 'session', cwd: '/target/session-mode', title: '正式标题',
    })
    expect(converted.title).toBe('正式标题')
    expect(converted.mode).toBe('session')
    expect(converted.cwd).toBe('/target/session-mode')
    expect(converted.events[0]).toMatchObject({ type: 'session/title', data: { title: '正式标题', messageSeqs: [], source: { kind: 'user' } } })
    expect(converted.events[3]).toMatchObject({ type: 'system/message', surfaceOp: 'append', data: { message: { role: 'system', source: { kind: 'system-prompt' } } } })
    expect(converted.events.map(event => Number((event as { seq: number }).seq))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('emits one tool output per call id when WorkBuddy repeats a result row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-dup-result-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: { path: 'a' }, timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'first', status: 'success', timestamp: 1100 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'retried', status: 'success', timestamp: 1200 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'continue', timestamp: 1300 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-dup-result'), derivable(converted.events))
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls.map(block => (block.type === 'tool-call' ? block.id : ''))).toEqual(['c1'])
    expect(results.map(block => (block.type === 'tool-result' ? block.toolCallId : ''))).toEqual(['c1'])
    expect(converted.loss.map(item => item.code)).toContain('duplicate-tool-result')
  })

  it('flattens tool calls and results into plain text in narrative mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-narrative-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'Read', arguments: { file_path: 'a.md' }, timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'file contents', status: 'success', timestamp: 1100 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'continue', timestamp: 1200 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root, undefined, { toolMode: 'narrative' })
    const session = Session.create(SessionId('workbuddy-narrative'), derivable(converted.events))
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls).toHaveLength(0)
    expect(results).toHaveLength(0)
    const texts = messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : ''))
    expect(texts.join('\n')).toContain('【工具调用 Read】')
    expect(texts.join('\n')).toContain('【工具结果】file contents')
    expect(converted.loss.map(item => item.code)).toEqual(expect.arrayContaining(['tool-flattened', 'tool-result-flattened']))
  })

  it('deduplicates orphan pairing and repeated call rows for the same call id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-dup-call-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call_result', callId: 'orphan', name: 'lookup', output: 'a', timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'orphan', name: 'lookup', output: 'b', timestamp: 1100 }),
      JSON.stringify({ type: 'function_call', callId: 'twice', name: 'write', arguments: '{}', timestamp: 1200 }),
      JSON.stringify({ type: 'function_call', callId: 'twice', name: 'write', arguments: '{}', timestamp: 1300 }),
      JSON.stringify({ type: 'function_call_result', callId: 'twice', output: 'ok', timestamp: 1400 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-dup-call'), derivable(converted.events))
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls.map(block => (block.type === 'tool-call' ? block.id : ''))).toEqual(['orphan', 'twice'])
    expect(results.map(block => (block.type === 'tool-result' ? block.toolCallId : ''))).toEqual(['orphan', 'twice'])
    expect(converted.loss.map(item => item.code)).toEqual(expect.arrayContaining(['duplicate-tool-result', 'duplicate-tool-call']))
  })

  it('settles assistant messages with an explicit stream member for current persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-settlement-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'hi', timestamp: 1000 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'hello', timestamp: 1100 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const assistant = (converted.events as Array<{ type?: string; data?: { stream?: unknown } }>)
      .filter(event => event.type === 'assistant/message')
    expect(assistant.length).toBeGreaterThan(0)
    for (const item of assistant) {
      expect(Array.isArray(item.data?.stream)).toBe(true)
    }
  })

  it('keeps a delayed tool result with its call instead of closing the step unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-delayed-result-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'start', timestamp: 1000 }),
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: '{}', timestamp: 1100 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'next', timestamp: 1200 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'ok', timestamp: 1300 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'done', timestamp: 1400 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    expect(converted.loss.map(item => item.code)).not.toContain('unpaired-tool-call')
    const types = (converted.events as Array<{ type?: string }>).map(event => event.type)
    expect(types.filter(type => type === 'tool/call')).toHaveLength(1)
    expect(types.filter(type => type === 'tool/result')).toHaveLength(1)
    expect(types.filter(type => type === 'turn/start')).toHaveLength(2)
    Session.create(SessionId('workbuddy-delayed-result'), derivable(converted.events))
  })
})

describe('WorkBuddy converter context budget', () => {
  it('drops the oldest turns and renumbers the kept window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-budget-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'one', timestamp: 1000 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'first', timestamp: 1100 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'two', timestamp: 1200 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'second', timestamp: 1300 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'three', timestamp: 1400 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'third', timestamp: 1500 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const before = (converted.events as Array<{ type?: string }>).filter(event => event.type === 'turn/start').length
    expect(before).toBe(3)
    const trimmed = trimEventsToBudget(converted.events as never[], 1)
    expect(trimmed.droppedTurns).toBeGreaterThan(0)
    const events = trimmed.events as Array<{ type?: string; data?: { turn?: number } }>
    const turns = events.filter(event => event.type === 'turn/start')
    expect(turns.length).toBeLessThan(before)
    expect(turns.map(event => event.data?.turn)).toEqual(turns.map((_event, index) => index + 1))
    expect(events.some(event => event.type === 'system/message')).toBe(true)
  })

  /**
   * WorkBuddy replays a call/result pair when it retries, so one callId can
   * appear twice in the transcript. A second `tool/result` for the same call
   * leaves DSH's surface with more results than calls, and its compaction
   * engine refuses to cut an unbalanced surface — an imported session then
   * cannot be condensed and the whole transcript is rejected as too large.
   */
  it('emits one result per call even when WorkBuddy replays the pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-replay-'))
    const project = join(root, 'projects', 'p')
    await mkdir(project, { recursive: true })
    const path = join(project, 'replay.jsonl')
    const row = (type: string, extra: Record<string, unknown>): string => JSON.stringify({ type, timestamp: 1000, ...extra })
    const pair = (id: string): string[] => [
      row('function_call', { callId: id, name: 'read_file', arguments: '{"path":"a.txt"}' }),
      row('function_call_result', { callId: id, status: 'completed', output: 'done' }),
    ]
    await writeFile(path, [
      row('message', { role: 'user', content: 'go' }),
      ...pair('call-1'),
      ...pair('call-2'),
      // The retry replays the first pair verbatim.
      ...pair('call-1'),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const events = converted.events as Array<{ type?: string; data?: { message?: { toolCallId?: string; source?: { callId?: string }; content?: Array<{ type?: string }> } } }>
    let balance = 0
    let negative = 0
    const resultIds = new Map<string, number>()
    for (const event of events) {
      if (event.type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) if (block.type === 'tool-call') balance += 1
      } else if (event.type === 'tool/result') {
        balance -= 1
        if (balance < 0) negative += 1
        const id = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId ?? 'unknown'
        resultIds.set(id, (resultIds.get(id) ?? 0) + 1)
      }
    }
    expect(balance).toBeGreaterThanOrEqual(0)
    expect(negative).toBe(0)
    expect([...resultIds.values()].every(count => count === 1)).toBe(true)
  })
})

describe('WorkBuddy summary checkpoint', () => {
  /** Real WorkBuddy summaries run 4–7K chars; this mirrors that shape. */
  const SUMMARY = 'Earlier work established the parser and the CLI entry point. '
    + 'The parser accepts both the legacy and current envelope shapes, and the CLI '
    + 'entry point validates the working directory before touching the catalog. '
    + 'Remaining work: wire the fold into the import path and document it.'

  /** One WorkBuddy memory row, in the compact shape it writes between compactions. */
  function memoryRow(summary: string): string {
    return JSON.stringify({
      type: 'message',
      role: 'user',
      timestamp: 9000,
      content: `<conversation_history_summary>\n<analysis>scratch</analysis>\n<summary>${summary}</summary>\n</conversation_history_summary>`,
    })
  }

  /** Build a transcript whose size forces `auto` to fold. */
  async function bigTranscript(): Promise<{ root: string; path: string }> {
    const root = await mkdtemp(join(tmpdir(), 'mwb-summary-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    const rows: string[] = []
    rows.push(JSON.stringify({ type: 'message', role: 'user', content: 'start the project', timestamp: 1000 }))
    // Padding is what pushes the log past AUTO_SUMMARY_TOKENS; the fold must
    // then replace exactly the summarized prefix and keep the recent tail.
    for (let index = 0; index < 40; index += 1) {
      rows.push(JSON.stringify({ type: 'message', role: 'assistant', content: `step ${index} ${'x'.repeat(20_000)}`, timestamp: 2000 + index }))
    }
    rows.push(memoryRow(SUMMARY))
    rows.push(JSON.stringify({ type: 'message', role: 'user', content: 'recent question', timestamp: 8000 }))
    rows.push(JSON.stringify({ type: 'message', role: 'assistant', content: 'recent answer', timestamp: 8500 }))
    await writeFile(path, rows.join('\n'))
    return { root, path }
  }

  it('does not fold a small project, so the model sees the real transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-small-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'hello', timestamp: 1000 }),
      memoryRow('A tiny summary that is long enough to be recognized by the extractor, '
        + 'which requires at least eighty characters of curated state before it treats '
        + 'a row as a compaction summary rather than an ordinary message.'),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'hi', timestamp: 2000 }),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'auto' })
    const checkpoints = (converted.events as Array<{ data?: { source?: { kind?: string } } }>)
      .filter(event => event.data?.source?.kind === 'compact-checkpoint')
    expect(checkpoints).toHaveLength(0)
    expect(converted.summaryFold).toBeUndefined()
  })

  it('folds WorkBuddy summaries into one DSH checkpoint over the summarized prefix', async () => {
    const { root, path } = await bigTranscript()
    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'always' })
    const events = converted.events as Array<{
      type?: string
      seq?: number
      surfaceOp?: unknown
      sourceEventSeqs?: number[]
      data?: { content?: Array<{ type?: string; text?: string }>; source?: { kind?: string; compactionId?: string }; role?: string }
    }>

    const checkpoints = events.filter(event => event.data?.source?.kind === 'compact-checkpoint')
    expect(checkpoints).toHaveLength(1)
    const checkpoint = checkpoints[0]!
    expect(checkpoint.type).toBe('user/message')
    expect(checkpoint.data?.role).toBe('user')
    // A checkpoint is recognized by a NON-append surface op; 'append' would make
    // it ordinary history and leave the huge prefix in the model's context.
    const op = checkpoint.surfaceOp as { op?: string; startSeq?: number; endSeq?: number }
    expect(op.op).toBe('replace')
    expect(op.startSeq).toBeGreaterThanOrEqual(1)
    expect(op.endSeq).toBeGreaterThan(op.startSeq!)
    expect(op.endSeq!).toBeLessThan(Number(checkpoint.seq))

    // Every shadowed surface node must be cited or the surface fold rejects it,
    // and the two transaction frames are cited ahead of them.
    const shadowed = events.filter(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type ?? '')
      && (event as { surfaceOp?: unknown }).surfaceOp === 'append'
      && Number(event.seq) >= op.startSeq! && Number(event.seq) <= op.endSeq!)
    expect(checkpoint.sourceEventSeqs!.slice(2)).toEqual(shadowed.map(event => Number(event.seq)))
    expect(new Set(checkpoint.sourceEventSeqs).size).toBe(checkpoint.sourceEventSeqs!.length)

    // The replacement is only legal inside an open compaction transaction: the
    // reader rejects a bare checkpoint with "compaction checkpoint has no
    // matching compaction/start". The import must reproduce the four frames
    // `compactSurfaceRegion` commits, in that exact order.
    const compactionId = checkpoint.data?.source?.compactionId
    expect(compactionId).toBeDefined()
    const lifecycle = events.filter(event => event.type?.startsWith('compaction/') === true)
    expect(lifecycle.map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])
    for (const frame of lifecycle) {
      expect((frame.data as { compactionId?: string }).compactionId).toBe(compactionId)
    }
    const [start, summary, end] = lifecycle
    for (const frame of [start!, end!]) {
      // `turn: null` is the out-of-turn (manual) form, the only one valid in a
      // seeded log whose last turn is already closed. `compaction/summary`
      // carries no `turn`, so only the two lifecycle frames are checked.
      expect((frame.data as { turn?: unknown }).turn).toBeNull()
    }
    expect(Number(start!.seq)).toBeLessThan(Number(checkpoint.seq))
    expect(Number(summary!.seq)).toBe(Number(start!.seq) + 1)
    expect(Number(end!.seq)).toBeGreaterThan(Number(checkpoint.seq))
    // The transaction precedes the inherited seed marker, which clears the open
    // compaction; appending it after would leave the transaction unclosed.
    const seedIndex = events.findIndex(event => event.type === 'session/end-seed')
    expect(seedIndex).toBe(-1)
    expect(Number(end!.seq)).toBe(events.reduce((max, event) => Math.max(max, Number(event.seq)), Number.NEGATIVE_INFINITY))
    // `compaction/summary` cites the same span the replacement shadows, and its
    // endpoints must match `shadowedSeqs` exactly.
    const summaryData = summary!.data as { shadowedRange?: { start?: number; end?: number }; shadowedSeqs?: number[]; summary?: Array<{ type?: string; text?: string }> }
    expect(summaryData.shadowedRange).toEqual({ start: op.startSeq, end: op.endSeq })
    expect(summaryData.shadowedSeqs).toEqual(shadowed.map(event => Number(event.seq)))
    expect(summaryData.summary?.[0]?.text).toContain('Earlier work established the parser')
    // The cited frames must be the transaction's own, not the shadowed messages:
    // citing `startSeq` here would leave the summary pointing at history.
    expect(checkpoint.sourceEventSeqs).toEqual([Number(start!.seq), Number(summary!.seq), ...shadowed.map(event => Number(event.seq))])

    // Framing must match what `dsh-compaction-basic` writes.
    const content = checkpoint.data?.content ?? []
    expect(content).toHaveLength(3)
    expect(content[0]!.text).toContain('<compacted-summary>')
    expect(content[1]!.text).toContain('Earlier work established the parser')
    expect(content[2]!.text).toBe('</compacted-summary>')
    expect(converted.summaryFold?.shadowedEvents).toBe(shadowed.length)
    expect(converted.loss.map(item => item.code)).toContain('summary-checkpoint')
  })

  it('merges every distinct summary version and drops repeats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-merge-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    // The same summary written three times, then a newer distinct one: the fold
    // must keep both versions once each, in order.
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'start', timestamp: 1000 }),
      memoryRow(SUMMARY),
      memoryRow(SUMMARY),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'progress', timestamp: 2000 }),
      memoryRow('A later summary recording that the fold was wired through the service layer and verified against a real transcript.'),
      memoryRow(SUMMARY),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'always' })
    const checkpoint = (converted.events as Array<{ data?: { source?: { kind?: string }; content?: Array<{ text?: string }> } }>)
      .find(event => event.data?.source?.kind === 'compact-checkpoint')
    expect(checkpoint).toBeDefined()
    const body = (checkpoint?.data?.content ?? []).map(block => block.text ?? '').join('')
    expect(body.split('Earlier work established the parser').length - 1).toBe(1)
    expect(body.split('A later summary recording').length - 1).toBe(1)
    // Earlier stage must precede the later one.
    expect(body.indexOf('Earlier work established')).toBeLessThan(body.indexOf('A later summary recording'))
  })

  it('reports why a huge transcript without any summary cannot be folded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-nosum-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'start', timestamp: 1000 }),
      ...Array.from({ length: 40 }, (_, index) => JSON.stringify({ type: 'message', role: 'assistant', content: `part ${String(index)} ${'y'.repeat(20_000)}`, timestamp: 2000 + index })),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'auto' })
    expect(converted.summaryFold).toBeUndefined()
    expect(converted.loss.map(item => item.code)).toContain('summary-missing')
  })

  /**
   * The runtime charges `compaction/summary.shadowedTokenCount` against
   * `contextPressure.surfaceTokens`. v12 priced the shadowed range with chars/3
   * over whole event JSON (~1.8x too high), which showed up as "已压缩 1000多万
   * token" in the UI and drove the projection counter negative — a zod schema
   * violation that makes the next cold restore throw. The declared price must
   * be exactly the runtime's own heuristic price of that same range.
   */
  it('prices the shadowed range in runtime heuristic tokens so surfaceTokens stays non-negative', async () => {
    const { root, path } = await bigTranscript()
    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'always' })
    const events = converted.events as Array<{
      type?: string
      seq?: number
      surfaceOp?: unknown
      data?: { shadowedRange?: { start?: number; end?: number }; shadowedTokenCount?: number; source?: { kind?: string }; content?: Array<{ text?: string }> }
    }>
    const summary = events.find(event => event.type === 'compaction/summary')!
    const op = events.find(event => event.data?.source?.kind === 'compact-checkpoint')!.surfaceOp as { startSeq: number; endSeq: number }
    const shadowed = events.filter(event => event.surfaceOp === 'append'
      && Number(event.seq) >= op.startSeq && Number(event.seq) <= op.endSeq)
    const recomputed = shadowed.reduce((sum, event) => sum + estimateEventTokens(event as never), 0)

    expect(summary.data!.shadowedTokenCount).toBe(recomputed)
    expect(converted.summaryFold!.shadowedTokens).toBe(recomputed)
    // The full pre-fold surface minus the declared shadow price plus the
    // checkpoint's own price must be >= 0 (the runtime's fold invariant).
    const wholeSurface = events.filter(event => event.surfaceOp === 'append')
      .reduce((sum, event) => sum + estimateEventTokens(event as never), 0)
    const checkpointPrice = estimateEventTokens(events.find(event => event.data?.source?.kind === 'compact-checkpoint') as never)
    expect(wholeSurface - summary.data!.shadowedTokenCount! + checkpointPrice).toBeGreaterThanOrEqual(0)
    // A non-trivial surface must be priced with the estimator, not a flat 0.
    expect(recomputed).toBeGreaterThan(0)
  })

  /** WorkBuddy's `<cb_summary>` verbatim replay has no curated `<summary>`. */
  const SHELL_TEMPLATE = '<cb_summary>\nSummary of the conversation so far:\n'
    + 'The conversation is between an AI agent and a user.\n'
    + 'Use this to get up to speed, and continue helping the user as the AI agent.\n'
    + 'Some contents may be omitted, indicated by "<omitted />".\n\n'
    + '<previous_user_message><user_query>hello</user_query></previous_user_message>\n'
    + '<previous_tool_call>Tool: Bash\nArguments: {"command":"ls"}</previous_tool_call>\n'
    + '</cb_summary>'

  /**
   * v12 treated the template header plus the blank lines left by stripping
   * `<previous_*>` blocks as a summary because it exceeded 80 characters. Those
   * rows became checkpoint "阶段 N" sections whose `<cb_summary>` was empty.
   * Only curated `<conversation_history_summary>` rows may become stages.
   */
  it('ignores empty cb_summary template pages and task notifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-shell-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    const notification = '<task-notification><task-id>x</task-id><status>completed</status>'
      + '<summary>Background command "python build.py" completed with exit code 0</summary>'
      + '</task-notification>\n\n[SYSTEM NOTIFICATION - NOT USER INPUT]'
    const curated = '<conversation_history_summary>\n'
      + 'Summary of the conversation between an AI agent and a user.\n'
      + '<analysis>scratch analysis</analysis>\n'
      + '<summary>' + SUMMARY + '</summary>\n</conversation_history_summary>'
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'start', timestamp: 1000 }),
      JSON.stringify({ type: 'message', role: 'user', content: SHELL_TEMPLATE, timestamp: 2000 }),
      JSON.stringify({ type: 'message', role: 'user', content: notification, timestamp: 3000 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'progress', timestamp: 4000 }),
      // Two identical template pages to prove none of them become stages.
      JSON.stringify({ type: 'message', role: 'user', content: SHELL_TEMPLATE, timestamp: 5000 }),
      JSON.stringify({ type: 'message', role: 'user', content: curated, timestamp: 6000 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'recent question', timestamp: 7000 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'recent answer', timestamp: 7500 }),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'always' })
    const checkpoint = (converted.events as Array<{ data?: { source?: { kind?: string }; content?: Array<{ text?: string }> } }>)
      .find(event => event.data?.source?.kind === 'compact-checkpoint')
    expect(checkpoint).toBeDefined()
    const body = (checkpoint?.data?.content ?? []).map(block => block.text ?? '').join('')
    // One curated summary => no "stages" wrapper and no template/notification text.
    expect(body).toContain('Earlier work established the parser')
    expect(body).not.toContain('阶段')
    expect(body).not.toContain('Summary of the conversation so far')
    expect(body).not.toContain('Background command')
    expect(body).toContain('<compacted-summary>')
  })

  /** A `<cb_summary>`-only transcript has no usable summary at all. */
  it('reports summary-missing when WorkBuddy only wrote template replay rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-shellonly-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'start', timestamp: 1000 }),
      JSON.stringify({ type: 'message', role: 'user', content: SHELL_TEMPLATE, timestamp: 2000 }),
      ...Array.from({ length: 40 }, (_, index) => JSON.stringify({ type: 'message', role: 'assistant', content: `part ${String(index)} ${'z'.repeat(20_000)}`, timestamp: 3000 + index })),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'always' })
    expect(converted.summaryFold).toBeUndefined()
    expect(converted.loss.map(item => item.code)).toContain('summary-missing')
    expect((converted.events as Array<{ data?: { source?: { kind?: string } } }>)
      .some(event => event.data?.source?.kind === 'compact-checkpoint')).toBe(false)
  })

  /**
   * A transcript whose only memory rows are `<cb_summary>` replays has no
   * curated summary, yet its surface can exceed the model window — and the
   * runtime compactor cannot summarize a prompt the model cannot receive.
   * Folding the replay-derived request timeline keeps it continuable.
   */
  it('folds a replay-derived request timeline when no curated summary exists', async () => {
    const queries = [
      '帮我把这个仓库的构建脚本改成可以直接发布 Release 的形式，并补上作者信息与许可证',
      '安装包传到手机后提示解析失败，请检查签名配置和 minSdkVersion 是否匹配',
      '给设置页加一个数值右对齐的文本框，金额最多两位小数，服务端不接受小数时回退为正整数',
      '把安卓端与网页端源码拆成两个仓库，并分别配置 GitHub Actions 自动构建',
    ]
    const replayBlock = queries.map((query, index) => '<previous_user_message>\n<user_query>'
      + query
      + '</user_query>\n</previous_user_message>\n<previous_assistant_message>\n'
      + `第 ${String(index + 1)} 项已实现：修改了 build.gradle 与 workflow，并在本地构建通过。`
      + '\n</previous_assistant_message>').join('\n')
    const replayRow = JSON.stringify({
      type: 'message',
      role: 'user',
      timestamp: 9000,
      content: '<cb_summary>\nSummary of the conversation so far:\n'
        + 'The conversation is between an AI agent and a user.\n'
        + 'Use this to get up to speed, and continue helping the user as the AI agent.\n'
        + 'Some contents may be omitted, indicated by "<omitted />".\n\n'
        + replayBlock + '\n</cb_summary>',
    })
    const root = await mkdtemp(join(tmpdir(), 'mwb-digest-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'start the project', timestamp: 1000 }),
      ...Array.from({ length: 60 }, (_, index) => JSON.stringify({ type: 'message', role: 'assistant', content: `step ${String(index)} ${'w'.repeat(30_000)}`, timestamp: 2000 + index })),
      replayRow,
      JSON.stringify({ type: 'message', role: 'user', content: 'recent question', timestamp: 10_000 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'recent answer', timestamp: 10_500 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root, undefined, { summaryMode: 'auto' })
    expect(converted.summaryFold).toBeDefined()
    expect(converted.loss.map(item => item.code)).toContain('summary-digest')
    const checkpoint = (converted.events as Array<{ data?: { source?: { kind?: string }; content?: Array<{ text?: string }> } }>)
      .find(event => event.data?.source?.kind === 'compact-checkpoint')
    expect(checkpoint).toBeDefined()
    const body = (checkpoint?.data?.content ?? []).map(block => block.text ?? '').join('')
    // The digest carries the real requests and never the WorkBuddy template.
    expect(body).toContain('帮我把这个仓库的构建脚本改成可以直接发布 Release 的形式')
    expect(body).toContain('把安卓端与网页端源码拆成两个仓库')
    expect(body).not.toContain('Summary of the conversation so far')
    expect(body).not.toContain('<cb_summary>')
    expect(body).toContain('<compacted-summary>')
  })
})
