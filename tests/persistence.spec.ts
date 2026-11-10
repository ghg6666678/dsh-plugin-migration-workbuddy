import { describe, expect, it, vi } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { writeSeededSession } from '../src/service.js'

const header = { version: 4, id: 'session-test', createdAt: 1, isSeeded: true } as unknown as SessionHeader
const events = [{ type: 'turn/start', seq: 0, time: 1, data: {} }] as unknown as SessionEvent[]
const id = 'session-test' as unknown as SessionId

describe('writeSeededSession', () => {
  it('writes through the dsh 0.2 handle and releases ownership', async () => {
    const append = vi.fn(async () => undefined)
    const flush = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ append, flush, close }))
    await writeSeededSession({ create } as unknown as SessionPersistence, header, events, id)
    expect(create).toHaveBeenCalledWith(header, { inheritedEventCount: events.length })
    expect(append).toHaveBeenCalledWith(events)
    expect(flush).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('uses the legacy 0.1 persistence.append path when the service exposes it', async () => {
    const append = vi.fn(async () => undefined)
    const create = vi.fn(async () => undefined)
    await writeSeededSession({ create, append } as unknown as SessionPersistence, header, events, id)
    expect(create).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith(id, events)
  })

  it('fails with a clear message when neither API shape is available', async () => {
    const create = vi.fn(async () => undefined)
    await expect(writeSeededSession({ create } as unknown as SessionPersistence, header, events, id))
      .rejects.toThrow('unsupported sessionPersistence API')
  })
})
