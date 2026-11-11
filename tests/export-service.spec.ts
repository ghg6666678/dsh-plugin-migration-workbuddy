import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionHeader, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  ExportBlockedError,
  ExportService,
  type ExportDatabase,
  type SessionRow,
  type SessionTemplate,
} from '../src/export-service.js'
import type { WorkBuddyActivity } from '../src/workbuddy-process.js'
import { sessionRowPath } from '../src/exporter.js'

const IDLE: WorkBuddyActivity = { running: false, observed: true, evidence: ['named pipe: none'], checkedAt: '2026-11-11T00:00:00.000Z' }
const RUNNING: WorkBuddyActivity = { running: true, observed: true, evidence: ['named pipe: workbuddy-ipc'], checkedAt: '2026-11-11T00:00:00.000Z' }
const BLIND: WorkBuddyActivity = { running: false, observed: false, evidence: ['无法枚举命名管道: EPERM'], checkedAt: '2026-11-11T00:00:00.000Z' }

function header(id: string, createdAt: number, cwd: string): SessionHeader {
  return { version: 4, id, createdAt, cwd, isSeeded: false } as unknown as SessionHeader
}

function persistenceOf(sessions: Array<{ header: SessionHeader; events: unknown[] }>): SessionPersistence {
  return {
    list: async () => sessions.map(item => item.header),
    inspect: async (id: unknown) => {
      const found = sessions.find(item => String(item.header.id) === String(id))
      if (found === undefined) throw new Error('not found')
      return { meta: found.header, inheritedEventCount: 0, events: found.events }
    },
  } as unknown as SessionPersistence
}

interface FakeDatabase extends ExportDatabase {
  readonly sessions: Map<string, { updated_at?: number; last_activity_at?: number; cwd: string }>
  readonly workspaces: Map<string, number>
  readonly inserts: SessionRow[]
}

function fakeDatabase(): FakeDatabase {
  const sessions = new Map<string, { updated_at?: number; last_activity_at?: number; cwd: string }>()
  const workspaces = new Map<string, number>()
  const inserts: SessionRow[] = []
  const template: SessionTemplate = { userId: 'tester', isPlayground: 1, transport: 'local' }
  return {
    sessions,
    workspaces,
    inserts,
    template: () => template,
    sessionExists: id => sessions.has(id),
    activity: id => sessions.get(id) ?? {},
    insertSession: (row) => {
      // Mirror the real writer: `sessions.cwd` uses forward slashes while the
      // file system path stays in backslash form.
      inserts.push({ ...row, cwd: sessionRowPath(row.cwd) })
      sessions.set(row.id, { cwd: sessionRowPath(row.cwd) })
    },
    updateActivity: (id, updatedAt, lastActivityAt) => { sessions.set(id, { ...(sessions.get(id) ?? { cwd: '' }), updated_at: updatedAt, last_activity_at: lastActivityAt }) },
    deleteSession: id => { sessions.delete(id) },
    workspaceExists: path => workspaces.has(path),
    touchWorkspace: (path, at) => { workspaces.set(path, at) },
    deleteWorkspace: path => { workspaces.delete(path) },
    close: () => undefined,
  }
}

/** A tiny DSH log: one finished turn whose only content is one typed prompt. */
function oneTurn(text: string, startSeq = 0): unknown[] {
  return [
    { type: 'turn/start', seq: startSeq, time: 1_000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: startSeq + 1,
      time: 1_001,
      surfaceOp: 'append',
      data: {
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `rpc-${text}`, clientTimeZone: 'Asia/Shanghai' },
        role: 'user',
        id: `m-${text}`,
      },
    },
    {
      type: 'assistant/message',
      seq: startSeq + 2,
      time: 1_002,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `re: ${text}` }] }, stream: [] },
    },
    { type: 'turn/end', seq: startSeq + 3, time: 1_003, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function harness(options: {
  sessions?: Array<{ header: SessionHeader; events: unknown[] }>
  activity?: WorkBuddyActivity
} = {}): {
  service: ExportService
  root: string
  home: string
  database: FakeDatabase
} {
  const root = mkdtempSync(join(tmpdir(), 'mwb-export-root-'))
  const home = mkdtempSync(join(tmpdir(), 'mwb-export-home-'))
  mkdirSync(join(root, 'projects'), { recursive: true })
  const database = fakeDatabase()
  const service = new ExportService(persistenceOf(options.sessions ?? []), {
    root,
    dshHome: home,
    activity: () => options.activity ?? IDLE,
    openDatabase: () => database,
  })
  return { service, root, home, database }
}

const CWD = 'C:\\Users\\ASUS\\WorkBuddy\\exported'

function sessionsFixture(events: unknown[] = oneTurn('hello')): Array<{ header: SessionHeader; events: unknown[] }> {
  return [{ header: header('session-a', 1_700_000_000_000, CWD), events }]
}

afterEach(() => { vi.restoreAllMocks() })

describe('export guard', () => {
  it('refuses to write while WorkBuddy is running', async () => {
    const { service } = harness({ sessions: sessionsFixture(), activity: RUNNING })
    await expect(service.run({ exitConfirmed: true })).rejects.toBeInstanceOf(ExportBlockedError)
  })

  it('names the quit requirement in the refusal', async () => {
    const { service } = harness({ sessions: sessionsFixture(), activity: RUNNING })
    await expect(service.run({ exitConfirmed: true })).rejects.toThrow(/所有会话都已执行完毕.*完全退出/)
  })

  it('fails closed when the running state cannot be observed', async () => {
    // An unreadable pipe directory must never be read as "WorkBuddy is closed".
    const { service } = harness({ sessions: sessionsFixture(), activity: BLIND })
    await expect(service.run({ exitConfirmed: true })).rejects.toThrow(/无法确认 WorkBuddy 是否已完全退出/)
  })

  it('requires the explicit quit acknowledgement', async () => {
    const { service } = harness({ sessions: sessionsFixture() })
    await expect(service.run({})).rejects.toThrow(/请先确认 WorkBuddy 中所有会话都已执行完毕/)
  })
})

describe('export preview', () => {
  it('reports a first-time session as new with pending rows', async () => {
    const { service } = harness({ sessions: sessionsFixture() })
    const preview = await service.preview()
    expect(preview.sessions).toHaveLength(1)
    // Two conversational rows plus the `session-meta`/`ai-title` header a brand
    // new WorkBuddy file needs before it can be opened.
    expect(preview.sessions[0]).toMatchObject({ id: 'session-a', status: 'new', pendingRows: 4 })
    expect(preview.summary).toMatchObject({ total: 1, new: 1, pendingRows: 4 })
    expect(preview.activity.running).toBe(false)
  })

  it('carries the newest-first order and skips child sessions', async () => {
    const child = { ...header('session-child', 1_700_000_099_000, CWD), parentSession: 'session-a' } as unknown as SessionHeader
    const { service } = harness({
      sessions: [
        { header: header('session-old', 1_700_000_000_000, CWD), events: oneTurn('old') },
        { header: header('session-new', 1_700_000_050_000, CWD), events: oneTurn('new') },
        { header: child, events: oneTurn('child') },
      ],
    })
    const preview = await service.preview()
    expect(preview.sessions.map(item => item.id)).toEqual(['session-new', 'session-old'])
  })

  it('reports a session as failed instead of dropping it when it cannot be read', async () => {
    const broken = {
      list: async () => [header('session-broken', 1_700_000_000_000, CWD)],
      inspect: async () => { throw new Error('corrupt log') },
    } as unknown as SessionPersistence
    const root = mkdtempSync(join(tmpdir(), 'mwb-export-root-'))
    const service = new ExportService(broken, {
      root,
      dshHome: mkdtempSync(join(tmpdir(), 'mwb-export-home-')),
      activity: () => IDLE,
      openDatabase: () => fakeDatabase(),
    })
    const preview = await service.preview()
    expect(preview.sessions[0]).toMatchObject({ status: 'failed', detail: 'corrupt log' })
  })
})

describe('export run', () => {
  it('writes a transcript, catalog row and workspace for a new session', async () => {
    const { service, database } = harness({ sessions: sessionsFixture() })
    const result = await service.run({ exitConfirmed: true })

    expect(result).toMatchObject({ exportedSessions: 1, createdSessions: 1, appendedSessions: 0, skippedSessions: 0 })
    expect(result.errors).toEqual([])
    expect(result.rows).toBe(4)

    const target = result.sessions[0]!
    expect(existsSync(target.transcriptPath)).toBe(true)
    const rows = readFileSync(target.transcriptPath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(rows.map(row => row.type)).toEqual(['session-meta', 'ai-title', 'message', 'message'])

    // The transcript alone is invisible in WorkBuddy: the catalog row and the
    // workspace row are what make it appear.
    expect(database.inserts).toHaveLength(1)
    expect(database.inserts[0]).toMatchObject({ id: target.workbuddySessionId, cwd: 'c:/Users/ASUS/WorkBuddy/exported' })
    expect([...database.workspaces.keys()]).toEqual(['c:\\Users\\ASUS\\WorkBuddy\\exported'])
  })

  it('appends only the new turn on a second run and moves the watermark', async () => {
    const events = oneTurn('first')
    const grown = [...events, ...oneTurn('second', events.length)]
    const sessions = [{ header: header('session-a', 1_700_000_000_000, CWD), events }]
    const { service, database } = harness({ sessions })

    const first = await service.run({ exitConfirmed: true })
    expect(first.createdSessions).toBe(1)
    expect(first.rows).toBe(4)

    // Grow the log the way a live DSH session would.
    sessions[0]!.events = grown
    const second = await service.run({ exitConfirmed: true, refresh: true })

    // The append carries only the new turn: no repeated header, no repeated turn.
    expect(second).toMatchObject({ exportedSessions: 1, createdSessions: 0, appendedSessions: 1, rows: 2 })
    const path = second.sessions[0]!.transcriptPath
    const rows = readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>)
    // Four conversational rows, not eight: the first turn was not rewritten.
    expect(rows.filter(row => row.type === 'message')).toHaveLength(4)
    // One catalog insert for the first run; the second only refreshed activity.
    expect(database.inserts).toHaveLength(1)

    // Chained, not restarted: the second run's first row continues the first.
    const messages = rows.filter(row => row.type === 'message')
    for (let index = 1; index < messages.length; index += 1) {
      expect(messages[index]!.parentId).toBe(messages[index - 1]!.id)
    }
  })

  it('reports a synced session as skipped on a third run', async () => {
    const { service } = harness({ sessions: sessionsFixture() })
    await service.run({ exitConfirmed: true })
    const again = await service.run({ exitConfirmed: true, refresh: true })
    expect(again).toMatchObject({ exportedSessions: 0, skippedSessions: 1 })
  })

  it('appends into the transcript a session was imported from', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mwb-export-home-'))
    const root = mkdtempSync(join(tmpdir(), 'mwb-export-root-'))
    const existing = join(root, 'projects', 'p', 'imported.jsonl')
    mkdirSync(join(root, 'projects', 'p'), { recursive: true })
    // A WorkBuddy transcript with its own history and an established chain head.
    writeFileSync(existing, [
      JSON.stringify({ type: 'message', id: 'wb-1', timestamp: 1_700_000_000_000, role: 'user', content: [{ type: 'input_text', text: 'from WorkBuddy' }], sessionId: 'imported', cwd: CWD }),
      JSON.stringify({ type: 'message', id: 'wb-2', parentId: 'wb-1', timestamp: 1_700_000_001_000, role: 'assistant', content: [{ type: 'output_text', text: 'answer' }], sessionId: 'imported', cwd: CWD }),
    ].join('\n') + '\n', 'utf8')
    mkdirSync(join(home, 'migration'), { recursive: true })
    writeFileSync(join(home, 'migration', 'manifest.json'), JSON.stringify({
      version: 1,
      sessions: [{
        targetSessionId: 'session-a',
        sourceSessionId: 'imported',
        sourcePath: existing,
        sourceHash: 'x',
      }],
    }), 'utf8')

    const database = fakeDatabase()
    const service = new ExportService(persistenceOf(sessionsFixture()), {
      root,
      dshHome: home,
      activity: () => IDLE,
      openDatabase: () => database,
    })

    const result = await service.run({ exitConfirmed: true })
    expect(result).toMatchObject({ exportedSessions: 1, createdSessions: 0, appendedSessions: 1 })

    const rows = readFileSync(existing, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>)
    // Two WorkBuddy rows survived; the DSH turn was appended after them.
    expect(rows).toHaveLength(4)
    expect(rows.slice(0, 2).map(row => row.id)).toEqual(['wb-1', 'wb-2'])
    expect(rows[2]!.parentId).toBe('wb-2')
    // No new catalog row and no new workspace: this session already exists there.
    expect(database.inserts).toHaveLength(0)
    expect([...database.workspaces.keys()]).toEqual([])
  })

  it('gives a session a new WorkBuddy home when its transcript was deleted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mwb-export-home-'))
    const root = mkdtempSync(join(tmpdir(), 'mwb-export-root-'))
    mkdirSync(join(home, 'migration'), { recursive: true })
    writeFileSync(join(home, 'migration', 'manifest.json'), JSON.stringify({
      version: 1,
      sessions: [{ targetSessionId: 'session-a', sourceSessionId: 'gone', sourcePath: join(root, 'projects', 'p', 'gone.jsonl'), sourceHash: 'x' }],
    }), 'utf8')

    const database = fakeDatabase()
    const service = new ExportService(persistenceOf(sessionsFixture()), { root, dshHome: home, activity: () => IDLE, openDatabase: () => database })
    const preview = await service.preview()
    expect(preview.sessions[0]).toMatchObject({ status: 'new' })
    expect(preview.sessions[0]!.detail).toContain('找不到该会话文件')

    const result = await service.run({ exitConfirmed: true })
    expect(result.createdSessions).toBe(1)
    expect(database.inserts).toHaveLength(1)
  })

  it('points at the import direction when only WorkBuddy moved on', async () => {
    const { service } = harness({ sessions: sessionsFixture() })
    const first = await service.run({ exitConfirmed: true })
    const path = first.sessions[0]!.transcriptPath

    // WorkBuddy continued the conversation; DSH has nothing new.
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({
      type: 'message', id: 'wb-later', parentId: 'anything', timestamp: Date.now(), role: 'user', content: [{ type: 'input_text', text: 'typed in WorkBuddy' }], sessionId: 's', cwd: CWD,
    }) + '\n', 'utf8')

    const preview = await service.preview({ refresh: true })
    expect(preview.sessions[0]).toMatchObject({ status: 'workbuddy-ahead' })
    expect(preview.sessions[0]!.detail).toContain('导入数据')
    expect(preview.summary.workbuddyAhead).toBe(1)

    const second = await service.run({ exitConfirmed: true, refresh: true })
    // Nothing is written: exporting would fork or ignore the WorkBuddy turn.
    expect(second).toMatchObject({ exportedSessions: 0, createdSessions: 0, skippedSessions: 1 })
    expect(second.pendingImport.map(item => item.sessionId)).toEqual(['session-a'])
    expect(readFileSync(path, 'utf8')).toContain('typed in WorkBuddy')
  })

  it('starts a new WorkBuddy session when both sides moved on', async () => {
    const events = oneTurn('first')
    const sessions = [{ header: header('session-a', 1_700_000_000_000, CWD), events }]
    const { service, root } = harness({ sessions })
    const first = await service.run({ exitConfirmed: true })
    const path = first.sessions[0]!.transcriptPath

    // Both sides gained a turn.
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({
      type: 'message', id: 'wb-later', parentId: 'anything', timestamp: Date.now(), role: 'user', content: [{ type: 'input_text', text: 'typed in WorkBuddy' }], sessionId: 's', cwd: CWD,
    }) + '\n', 'utf8')
    sessions[0]!.events = [...events, ...oneTurn('second', events.length)]

    const preview = await service.preview({ refresh: true })
    expect(preview.sessions[0]).toMatchObject({ status: 'conflict' })
    expect(preview.sessions[0]!.detail).toContain('新建一个 WorkBuddy 会话')

    const second = await service.run({ exitConfirmed: true, refresh: true })
    expect(second.createdSessions).toBe(1)
    expect(second.sessions[0]!.workbuddySessionId).not.toBe(first.sessions[0]!.workbuddySessionId)
    // The original untouched: its WorkBuddy-side history is the user's record.
    expect(readFileSync(path, 'utf8')).toContain('typed in WorkBuddy')
    expect(second.sessions[0]!.transcriptPath.startsWith(root)).toBe(true)
  })

  it('rolls the transcript back when the catalog write fails', async () => {
    const { service, database } = harness({ sessions: sessionsFixture() })
    database.insertSession = () => { throw new Error('database is locked') }
    const result = await service.run({ exitConfirmed: true })
    expect(result.exportedSessions).toBe(0)
    expect(result.errors[0]!.message).toBe('database is locked')
    // A half-written transcript would corrupt the next attempt, so it is gone.
    expect(existsSync(join(service.root, 'projects'))).toBe(true)
    const preview = await service.preview({ refresh: true })
    expect(preview.sessions[0]).toMatchObject({ status: 'new' })
  })
})

describe('export undo', () => {
  it('removes the file and catalog rows a first export created', async () => {
    const { service, database } = harness({ sessions: sessionsFixture() })
    const run = await service.run({ exitConfirmed: true })
    const path = run.sessions[0]!.transcriptPath
    expect(existsSync(path)).toBe(true)

    const undone = await service.undo()
    expect(undone).toMatchObject({ undone: true, files: 1, sessions: 1 })
    expect(existsSync(path)).toBe(false)
    expect(database.sessions.size).toBe(0)
    expect(database.workspaces.size).toBe(0)

    // Rewound: the session is exportable again.
    const preview = await service.preview({ refresh: true })
    expect(preview.sessions[0]).toMatchObject({ status: 'new', pendingRows: 4 })
  })

  it('truncates an appended transcript back to its previous length', async () => {
    const events = oneTurn('first')
    const sessions = [{ header: header('session-a', 1_700_000_000_000, CWD), events }]
    const { service } = harness({ sessions })
    await service.run({ exitConfirmed: true })
    sessions[0]!.events = [...events, ...oneTurn('second', events.length)]
    const appended = await service.run({ exitConfirmed: true, refresh: true })
    expect(appended.appendedSessions).toBe(1)
    const path = appended.sessions[0]!.transcriptPath

    await service.undo()
    const rows = readFileSync(path, 'utf8').split('\n').filter(line => line.trim())
    // Back to the four rows the first export wrote.
    expect(rows).toHaveLength(4)
    // The watermark is rewound, so the session counts as fully exported again.
    const after = await service.preview({ refresh: true })
    expect(after.sessions[0]).toMatchObject({ status: 'ahead' })
  })

  it('refuses to undo while WorkBuddy is running', async () => {
    const { service } = harness({ sessions: sessionsFixture(), activity: RUNNING })
    await expect(service.undo()).rejects.toBeInstanceOf(ExportBlockedError)
  })

  it('reports nothing to undo on a fresh install', async () => {
    const { service } = harness({ sessions: sessionsFixture() })
    expect(await service.undo()).toMatchObject({ undone: false, files: 0 })
  })

  it('cannot undo the same batch twice', async () => {
    const { service } = harness({ sessions: sessionsFixture() })
    const run = await service.run({ exitConfirmed: true })
    const first = await service.undo()
    expect(first.undone).toBe(true)
    const second = await service.undo(first.batchId!)
    expect(second.undone).toBe(false)
    expect(run.exportedSessions).toBe(1)
  })
})

describe('export history', () => {
  it('records each batch newest-first with its row count', async () => {
    const { service } = harness({ sessions: sessionsFixture() })
    await service.run({ exitConfirmed: true })
    await service.run({ exitConfirmed: true, refresh: true })
    const history = service.history()
    expect(history).toHaveLength(2)
    expect(history[0]!.status).toBe('completed')
    expect(history[0]!.id).not.toBe(history[1]!.id)
    // The second run had nothing left to write.
    expect(history[0]!.rows).toBe(0)
    expect(history[1]!.rows).toBe(4)
  })
})
