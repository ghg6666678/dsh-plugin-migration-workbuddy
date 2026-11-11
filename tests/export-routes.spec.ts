import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ExportBlockedError, type ExportService } from '../src/export-service.js'
import {
  MIGRATION_CLIENT_HEADER,
  MIGRATION_EXPORT_HISTORY_PATH,
  MIGRATION_EXPORT_PREVIEW_PATH,
  MIGRATION_EXPORT_RUN_PATH,
  MIGRATION_EXPORT_UNDO_PATH,
  registerExportRoutes,
} from '../src/routes.js'

const PORT = 18_888
const HOST = `127.0.0.1:${String(PORT)}`
const MARKER = { [MIGRATION_CLIENT_HEADER]: '1' }

interface Registered {
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

function mount(exporter: Partial<ExportService>): Map<string, Registered['handler']> {
  const routes = new Map<string, Registered['handler']>()
  const webServer = {
    port: PORT,
    register: (route: Registered) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  registerExportRoutes(webServer as never, exporter as ExportService)
  return routes
}

interface Reply {
  status: number
  body: Record<string, unknown>
}

async function call(
  handler: Registered['handler'],
  options: { method?: string; body?: unknown; headers?: Record<string, string>; url?: string } = {},
): Promise<Reply> {
  const payload = options.body === undefined ? '' : JSON.stringify(options.body)
  const request = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: { host: HOST, ...MARKER, ...options.headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (payload !== '') yield Buffer.from(payload) },
  } as unknown as IncomingMessage
  const result: Reply = { status: 0, body: {} }
  const response = {
    set statusCode(value: number) { result.status = value },
    setHeader: () => undefined,
    end: (value: string) => { result.body = JSON.parse(value) as Record<string, unknown> },
  } as unknown as ServerResponse
  await handler(request, response)
  return result
}

const IDLE = { running: false, observed: true, evidence: [], checkedAt: '2026-11-11T00:00:00.000Z' }

function exportResultStub(exported: number) {
  return {
    exportFormatVersion: 1,
    finishedAt: '2026-11-11T00:00:00.000Z',
    exportedSessions: exported,
    skippedSessions: 0,
    createdSessions: exported,
    appendedSessions: 0,
    rows: 4,
    sessions: [],
    errors: [],
    pendingImport: [],
  }
}

function previewStub() {
  return {
    exportFormatVersion: 1,
    generatedAt: '2026-11-11T00:00:00.000Z',
    workbuddyRoot: 'C:\\Users\\ASUS\\.workbuddy',
    activity: IDLE,
    sessions: [{
      id: 'session-a',
      createdAt: 1_700_000_000_000,
      eventCount: 4,
      startSeq: 0,
      lastSyncedEventSeq: -1,
      pendingEvents: 4,
      pendingRows: 4,
      status: 'new' as const,
      workbuddySessionId: 'pending:abc',
      transcriptPath: 'C:\\Users\\ASUS\\.workbuddy\\projects\\p\\abc.jsonl',
    }],
    summary: { total: 1, new: 1, ahead: 0, synced: 0, workbuddyAhead: 0, conflict: 0, empty: 0, failed: 0, pendingRows: 4, lastSyncedSessions: 0 },
  }
}

describe('export routes', () => {
  it('registers exactly the four export paths', () => {
    const routes = mount({})
    expect([...routes.keys()].sort()).toEqual([
      MIGRATION_EXPORT_HISTORY_PATH,
      MIGRATION_EXPORT_PREVIEW_PATH,
      MIGRATION_EXPORT_RUN_PATH,
      MIGRATION_EXPORT_UNDO_PATH,
    ].sort())
  })

  it('serves a preview and hides the user name in paths', async () => {
    const preview = vi.fn(async () => previewStub())
    const routes = mount({ preview })
    const reply = await call(routes.get(MIGRATION_EXPORT_PREVIEW_PATH)!, { method: 'GET' })
    expect(reply.status).toBe(200)
    expect(preview).toHaveBeenCalledWith({ refresh: false })
    // The absolute path never leaves the host.
    expect(JSON.stringify(reply.body)).not.toContain('ASUS')
  })

  it('honours an explicit refresh', async () => {
    const preview = vi.fn(async () => previewStub())
    const routes = mount({ preview })
    await call(routes.get(MIGRATION_EXPORT_PREVIEW_PATH)!, { method: 'POST', body: { refresh: true } })
    expect(preview).toHaveBeenCalledWith({ refresh: true })
    await call(routes.get(MIGRATION_EXPORT_PREVIEW_PATH)!, { method: 'GET', url: '/?refresh=1' })
    expect(preview).toHaveBeenLastCalledWith({ refresh: true })
  })

  it('rejects a run without the quit acknowledgement', async () => {
    const run = vi.fn()
    const routes = mount({ run })
    const reply = await call(routes.get(MIGRATION_EXPORT_RUN_PATH)!, { method: 'POST', body: { confirmed: true } })
    expect(reply.status).toBe(400)
    expect(String(reply.body.error)).toContain('exitConfirmed')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a run without the general confirmation', async () => {
    const run = vi.fn()
    const routes = mount({ run })
    const reply = await call(routes.get(MIGRATION_EXPORT_RUN_PATH)!, { method: 'POST', body: { exitConfirmed: true } })
    expect(reply.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('runs with both acknowledgements and passes the selection through', async () => {
    const run = vi.fn(async () => exportResultStub(1))
    const routes = mount({ run })
    const reply = await call(routes.get(MIGRATION_EXPORT_RUN_PATH)!, {
      method: 'POST',
      body: { confirmed: true, exitConfirmed: true, sessionIds: ['session-a'], mode: 'new-session' },
    })
    expect(reply.status).toBe(200)
    expect(run).toHaveBeenCalledWith({ sessionIds: ['session-a'], mode: 'new-session', exitConfirmed: true })
  })

  it('answers 409, not 500, when WorkBuddy is still running', async () => {
    const running = { running: true, observed: true, evidence: ['named pipe: workbuddy'], checkedAt: '2026-11-11T00:00:00.000Z' }
    const run = vi.fn(async () => { throw new ExportBlockedError('WorkBuddy 仍在运行', running) })
    const routes = mount({ run })
    const reply = await call(routes.get(MIGRATION_EXPORT_RUN_PATH)!, {
      method: 'POST',
      body: { confirmed: true, exitConfirmed: true },
    })
    expect(reply.status).toBe(409)
    // The evidence rides along so the dialog can explain what was detected.
    expect(reply.body).toMatchObject({ error: 'WorkBuddy 仍在运行', activity: { running: true } })
  })

  it('refuses a cross-site write', async () => {
    const run = vi.fn()
    const routes = mount({ run })
    const reply = await call(routes.get(MIGRATION_EXPORT_RUN_PATH)!, {
      method: 'POST',
      body: { confirmed: true, exitConfirmed: true },
      headers: { [MIGRATION_CLIENT_HEADER]: '', 'sec-fetch-site': 'cross-site' },
    })
    expect(reply.status).toBe(403)
    expect(run).not.toHaveBeenCalled()
  })

  it('serves the batch history', async () => {
    const history = vi.fn(() => [{ id: 'export-1', startedAt: 'x', status: 'completed', sessions: 1, rows: 4 }])
    const routes = mount({ history })
    const reply = await call(routes.get(MIGRATION_EXPORT_HISTORY_PATH)!, { method: 'GET' })
    expect(reply.status).toBe(200)
    expect(reply.body.batches).toHaveLength(1)
  })

  it('undoes the latest batch', async () => {
    const undo = vi.fn(async () => ({ undone: true, batchId: 'export-1', files: 1, sessions: 1 }))
    const routes = mount({ undo })
    const reply = await call(routes.get(MIGRATION_EXPORT_UNDO_PATH)!, { method: 'POST', body: {} })
    expect(reply.status).toBe(200)
    expect(undo).toHaveBeenCalledWith(undefined)
    expect(reply.body).toMatchObject({ undone: true })
  })

  it('undoes a named batch', async () => {
    const undo = vi.fn(async () => ({ undone: true, batchId: 'export-2', files: 1, sessions: 1 }))
    const routes = mount({ undo })
    await call(routes.get(MIGRATION_EXPORT_UNDO_PATH)!, { method: 'POST', body: { batchId: 'export-2' } })
    expect(undo).toHaveBeenCalledWith('export-2')
  })

  it('rejects GET on the mutating paths', async () => {
    const routes = mount({ run: vi.fn(), undo: vi.fn() })
    expect((await call(routes.get(MIGRATION_EXPORT_RUN_PATH)!, { method: 'GET' })).status).toBe(405)
    expect((await call(routes.get(MIGRATION_EXPORT_UNDO_PATH)!, { method: 'GET' })).status).toBe(405)
  })
})
