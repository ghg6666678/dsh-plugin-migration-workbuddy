import { describe, expect, it } from 'vitest'
import {
  buildWorkBuddyRows,
  catalogPath,
  exportWindow,
  normalizeWorkBuddyPath,
  projectHashOf,
  seedWatermark,
  serializeRows,
  sessionRowPath,
  uuidV7,
  workBuddySessionPath,
} from '../src/exporter.js'

/** Minimal DSH event builder; only the fields the exporter reads. */
function event(seq: number, type: string, data: unknown, time = 1_000 + seq): never {
  return { type, seq, time, data } as never
}

function user(seq: number, text: string, time?: number): never {
  return event(seq, 'user/message', {
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${String(seq)}`, clientTimeZone: 'Asia/Shanghai' },
    role: 'user',
    id: `msg-${String(seq)}`,
  }, time)
}

function assistant(seq: number, blocks: unknown[], time?: number): never {
  return event(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: blocks },
  }, time)
}

const OPTIONS = { sessionId: '0192f000-0000-7000-8000-000000000010', cwd: 'c:\\Users\\ASUS\\WorkBuddy\\demo' }

describe('WorkBuddy path helpers', () => {
  it('derives the project directory the way WorkBuddy does', () => {
    // Verified against 45 real transcripts: strip `:`, flatten separators,
    // lowercase only the first character (a `Users` segment keeps its case).
    expect(projectHashOf('c:\\Users\\ASUS\\WorkBuddy\\2026-08-30-19-18-00')).toBe('c-Users-ASUS-WorkBuddy-2026-08-30-19-18-00')
    expect(projectHashOf('C:/Users/ASUS/WorkBuddy/app')).toBe('c-Users-ASUS-WorkBuddy-app')
    expect(projectHashOf('C:\\Users\\ASUS\\WorkBuddy\\x')).toBe(projectHashOf('c:/Users/ASUS/WorkBuddy/x/'))
  })

  it('keeps each store in its own native spelling', () => {
    const input = 'C:/Users/ASUS/WorkBuddy/demo/'
    expect(normalizeWorkBuddyPath(input)).toBe('c:\\Users\\ASUS\\WorkBuddy\\demo')
    // workspaces.path: backslashes, lowercase drive.
    expect(catalogPath(input)).toBe('c:\\Users\\ASUS\\WorkBuddy\\demo')
    // sessions.cwd: WorkBuddy writes this column with forward slashes.
    expect(sessionRowPath(input)).toBe('c:/Users/ASUS/WorkBuddy/demo')
  })

  it('places a transcript under projects/<hash>/<session>.jsonl', () => {
    expect(workBuddySessionPath('C:\\wb', 'C:/Users/ASUS/WorkBuddy/demo', 'abc')).toBe(
      'C:\\wb\\projects\\c-Users-ASUS-WorkBuddy-demo\\abc.jsonl',
    )
  })
})

describe('DSH watermark and window selection', () => {
  it('starts after the last inherited seed marker', () => {
    expect(seedWatermark([user(0, 'a'), event(1, 'turn/start', { turn: 1 })] as never)).toBe(0)
    const seeded = [
      user(0, 'imported summary'),
      event(1, 'session/end-seed', { inherited: true }),
      event(2, 'session/end-seed', {}),
      user(3, 'typed later'),
      event(4, 'session/end-seed', { inherited: true }),
      user(5, 'typed after'),
    ]
    // Only inherited markers move the watermark; a plain end-seed does not.
    expect(seedWatermark(seeded as never)).toBe(5)
  })

  it('never exports a half-finished turn', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      user(1, 'one'),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(3, 'turn/start', { turn: 2 }),
      user(4, 'two'),
    ]
    const window = exportWindow(events as never, 0)
    // The live turn 2 is left for the next export, not written as an orphan.
    expect(window.events.map(item => (item as { seq: number }).seq)).toEqual([0, 1, 2])
    expect(window.lastEventSeq).toBe(2)
    expect(window.openTurn).toBe(false)
  })

  it('reports an open turn when nothing has finished yet', () => {
    const window = exportWindow([event(0, 'turn/start', { turn: 1 }), user(1, 'x')] as never, 0)
    expect(window.events).toEqual([])
    expect(window.lastEventSeq).toBe(-1)
    expect(window.openTurn).toBe(true)
  })
})

describe('DSH -> WorkBuddy row building', () => {
  it('carries only human turns and assistant answers, never DSH context', () => {
    const built = buildWorkBuddyRows([
      event(0, 'system/message', { content: [{ type: 'text', text: 'you are a helpful agent' }] }),
      user(1, 'make it blue'),
      // An imported summary is a user/message with a producer kind; it must not
      // travel back, or the other app shows a prompt nobody typed.
      event(2, 'user/message', {
        content: [{ type: 'text', text: 'imported summary' }],
        source: { kind: 'workbuddy-migration' },
        role: 'user',
        id: 'summary',
      }),
      assistant(3, [{ type: 'text', text: 'done' }]),
    ] as never, OPTIONS)

    const messages = built.rows.filter(row => row.type === 'message')
    expect(messages.map(row => row.role)).toEqual(['user', 'assistant'])
    expect(messages.map(row => (row.content as Array<{ text: string }>)[0]!.text)).toEqual(['make it blue', 'done'])
    expect(built.counts).toMatchObject({ message: 2, reasoning: 0, functionCall: 0, functionCallResult: 0 })
    expect(built.loss).toEqual([])
  })

  it('splits reasoning, text and tool calls into WorkBuddy rows in order', () => {
    const built = buildWorkBuddyRows([
      user(0, 'check the build'),
      assistant(1, [
        { type: 'reasoning', text: 'think first' },
        { type: 'text', text: 'running it' },
        { type: 'tool-call', id: 'call-1', name: 'shell', arguments: { command: 'npm run build' } },
      ]),
      event(2, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: '{"command":"npm run build"}' }),
      event(3, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          toolCallId: 'call-1',
          content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
        },
      }),
    ] as never, OPTIONS)

    expect(built.rows.map(row => row.type)).toEqual([
      'message',
      'reasoning',
      'message',
      'function_call',
      'function_call_result',
    ])
    // The tool/call event itself is not a second row: the assistant block is.
    expect(built.counts).toMatchObject({ message: 2, reasoning: 1, functionCall: 1, functionCallResult: 1 })
    const call = built.rows.find(row => row.type === 'function_call')!
    expect(call).toMatchObject({ callId: 'call-1', name: 'shell' })
    expect(call.arguments).toBe('{"command":"npm run build"}')
  })

  it('emits the missing call row so a result is never an answer to nothing', () => {
    const built = buildWorkBuddyRows([
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'tool/call', { turn: 1, step: 1, callId: 'lost', name: 'read', arguments: '{}' }),
      event(2, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'lost' },
          content: [{ type: 'tool-result', toolCallId: 'lost', content: [{ type: 'text', text: 'contents' }] }],
        },
      }),
    ] as never, OPTIONS)

    expect(built.rows.map(row => row.type)).toEqual(['function_call', 'function_call_result'])
    expect(built.rows[0]).toMatchObject({ callId: 'lost', name: 'read' })
    // The original arguments survived even though the announcing message did not.
    expect(built.rows[0]!.arguments).toBe('{}')
  })

  it('marks a failed tool result as incomplete, matching WorkBuddy own failures', () => {
    const built = buildWorkBuddyRows([
      event(0, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{}' }),
      // Real DSH logs put the call id on the message AND wrap the outcome in a
      // tool-result block, so both shapes must resolve to the same call.
      event(1, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'not found' }] }],
          isError: true,
        },
        error: { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' },
      }),
    ] as never, OPTIONS)
    const result = built.rows.find(row => row.type === 'function_call_result')!
    expect(result).toMatchObject({ status: 'incomplete', callId: 'c1' })
    // The nested block content is what the user must see in the other app.
    expect(result.output).toEqual({ type: 'text', text: 'not found' })
  })

  it('treats a tool-result block failure flag as an error too', () => {
    const built = buildWorkBuddyRows([
      event(0, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'shell', arguments: '{}' }),
      event(1, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'c2' },
          content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'rejected' }], isError: true }],
        },
      }),
    ] as never, OPTIONS)
    expect(built.rows.find(row => row.type === 'function_call_result')).toMatchObject({ status: 'incomplete' })
  })

  it('chains rows by parentId and keeps the clock strictly increasing', () => {
    const built = buildWorkBuddyRows([
      user(0, 'a', 5_000),
      assistant(1, [{ type: 'text', text: 'b' }], 5_000),
      user(2, 'c', 1_000),
      assistant(3, [{ type: 'text', text: 'd' }], 1_000),
    ] as never, { ...OPTIONS, bootstrap: { title: 'Demo', createdAt: 4_000 } })

    const chained = built.rows.filter(row => row.type === 'message')
    expect(chained[0]!.parentId).toBeUndefined()
    for (let index = 1; index < chained.length; index += 1) {
      expect(chained[index]!.parentId).toBe(chained[index - 1]!.id)
      // A session that sat idle must not produce a row that sorts before its
      // predecessor.
      expect(Number(chained[index]!.timestamp)).toBeGreaterThan(Number(chained[index - 1]!.timestamp))
    }
  })

  it('starts a new chain from the previous row when appending', () => {
    const built = buildWorkBuddyRows([user(0, 'more')] as never, { ...OPTIONS, chainFrom: 'previous-row', chainTime: 9_000 })
    expect(built.rows[0]!.parentId).toBe('previous-row')
    expect(built.rows[0]!.timestamp!).toBeGreaterThan(9_000)
  })

  it('keeps bootstrap rows off the parentId chain', () => {
    const built = buildWorkBuddyRows([user(0, 'hello')] as never, {
      ...OPTIONS,
      bootstrap: { title: 'Demo title', createdAt: 4_000 },
    })
    // WorkBuddy own files begin the chain at the first message row; a title
    // must not be mistaken for the conversation root.
    expect(built.rows.map(row => row.type)).toEqual(['session-meta', 'ai-title', 'message'])
    expect(built.rows[0]!.parentId).toBeUndefined()
    expect(built.rows[1]!.parentId).toBeUndefined()
    expect(built.rows[2]!.parentId).toBeUndefined()
    expect(built.rows[1]!.aiTitle).toBe('Demo title')
  })

  it('records the watermark of the events it actually covered', () => {
    const built = buildWorkBuddyRows([
      user(10, 'a'),
      event(11, 'turn/start', { turn: 1 }),
      assistant(12, [{ type: 'text', text: 'b' }]),
      event(13, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ] as never, OPTIONS)
    expect(built.lastEventSeq).toBe(13)
    expect(built.exportedEvents).toBe(2)
  })
})

describe('transcript serialisation', () => {
  it('writes one JSON object per line and terminates the file', () => {
    const text = serializeRows([{ type: 'message', id: 'a' }, { type: 'message', id: 'b' }], false)
    expect(text).toBe('{"type":"message","id":"a"}\n{"type":"message","id":"b"}\n')
  })

  it('does not glue a row onto a file that lost its final newline', () => {
    const text = serializeRows([{ type: 'message', id: 'a' }], true)
    expect(text).toBe('\n{"type":"message","id":"a"}\n')
  })
})

describe('row identifiers', () => {
  it('emits time-sortable v7 ids', () => {
    const earlier = uuidV7(1_700_000_000_000)
    const later = uuidV7(1_700_000_001_000)
    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // WorkBuddy orders rows by id, so the time prefix must sort correctly.
    expect(later > earlier).toBe(true)
  })

  it('never repeats an id within a batch', () => {
    const built = buildWorkBuddyRows([
      user(0, 'a'),
      assistant(1, [{ type: 'reasoning', text: 'r' }]),
      assistant(2, [{ type: 'tool-call', id: 'c1', name: 'x', arguments: {} }]),
      event(3, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
        },
      }),
    ] as never, OPTIONS)
    const ids = built.rows.map(row => row.id as string)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
