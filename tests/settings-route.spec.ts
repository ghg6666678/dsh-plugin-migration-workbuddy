import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MigrationService } from '../src/service.js'
import { MIGRATION_SETTINGS_PATH, registerMigrationRoutes } from '../src/routes.js'

const PORT = 18889
const HEADER = 'x-workbuddy-migration'

interface Handler { (req: unknown, res: unknown): Promise<void> }

function fakeWebServer() {
  const handlers = new Map<string, Handler>()
  return {
    port: PORT,
    register: (route: { path: string; handler: Handler }) => {
      handlers.set(route.path, route.handler)
      return () => { handlers.delete(route.path) }
    },
    handlers,
  }
}

function fakeReq(method: string, bodyValue?: unknown, headers: Record<string, string> = {}) {
  const chunks = bodyValue === undefined ? [] : [Buffer.from(JSON.stringify(bodyValue))]
  const req = {
    method,
    headers: {
      host: `127.0.0.1:${String(PORT)}`,
      ...(bodyValue === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  return req
}

function fakeRes() {
  const result: { status?: number; body?: string } = {}
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader: (key: string, value: string) => { res.headers[key] = value },
    // `exactOptionalPropertyTypes` forbids assigning a possibly-undefined value
    // to an optional field, and the handler may end the response with no body.
    end: (value?: string) => { result.status = res.statusCode; if (value !== undefined) result.body = value },
  }
  return { res, result }
}

describe('settings route', () => {
  it('is registered and round-trips GET and POST (regression for the missing path)', async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-settings-route-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService({} as never, undefined, { sourceRoot: targetRoot })
      const webserver = fakeWebServer()
      const dispose = registerMigrationRoutes(webserver as never, {} as never, service)
      expect([...webserver.handlers.keys()]).toContain(MIGRATION_SETTINGS_PATH)
      const handler = webserver.handlers.get(MIGRATION_SETTINGS_PATH)!

      // GET is a read: no marker required.
      const read = fakeRes()
      await handler(fakeReq('GET'), read.res)
      expect(read.result.status).toBe(200)
      expect(JSON.parse(read.result.body ?? '{}')).toEqual({})

      // POST without the marker must be refused (mutating).
      const unmarked = fakeRes()
      await handler(fakeReq('POST', { maxContextTokens: 250000 }), unmarked.res)
      expect(unmarked.result.status).toBe(403)

      // POST with the marker persists the context budget.
      const write = fakeRes()
      await handler(fakeReq('POST', { maxContextTokens: 250000 }, { [HEADER]: '1' }), write.res)
      expect(write.result.status).toBe(200)
      expect(JSON.parse(write.result.body ?? '{}')).toEqual({ maxContextTokens: 250000 })

      // A later GET reflects the saved value.
      const reread = fakeRes()
      await handler(fakeReq('GET'), reread.res)
      expect(JSON.parse(reread.result.body ?? '{}')).toEqual({ maxContextTokens: 250000 })

      dispose()
      expect(webserver.handlers.size).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
