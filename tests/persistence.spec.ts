import { describe, expect, it, vi } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { writeSeededSession } from '../src/service.js'

const header = { version: 4, id: 'session-test', createdAt: 1, isSeeded: true } as unknown as SessionHeader
const events = [{ type: 'turn/start', seq: 0, time: 1, data: {} }] as unknown as SessionEvent[]
const id = 'session-test' as unknown as SessionId

describe('writeSeededSession', () => {
  it('writes through the dsh 0.2 handle, marks the inherited cut, and releases ownership', async () => {
    const append = vi.fn(async () => undefined)
    const flush = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ append, flush, close }))
    await writeSeededSession({ create } as unknown as SessionPersistence, header, events, id)
    expect(create).toHaveBeenCalledWith(header, { inheritedEventCount: events.length })
    expect(append).toHaveBeenCalledWith([
      events[0],
      {
        type: 'session/end-seed',
        seq: 1,
        time: 1,
        data: { inherited: true },
      },
    ])
    expect(flush).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('still writes the inherited cut marker when the imported session has no events', async () => {
    const append = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ append, close }))
    await writeSeededSession({ create } as unknown as SessionPersistence, header, [], id)
    expect(append).toHaveBeenCalledWith([
      { type: 'session/end-seed', seq: 0, time: header.createdAt, data: { inherited: true } },
    ])
  })

  it('uses the legacy 0.1 persistence.append path when the service exposes it', async () => {
    const append = vi.fn(async () => undefined)
    const create = vi.fn(async () => undefined)
    await writeSeededSession({ create, append } as unknown as SessionPersistence, header, events, id)
    expect(create).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith(id, events)
  })

  it('releases the write handle even when append is rejected', async () => {
    const close = vi.fn(async () => undefined)
    const append = vi.fn(async () => { throw new Error('format v4 rejected the batch') })
    const create = vi.fn(async () => ({ append, close }))
    await expect(writeSeededSession({ create } as unknown as SessionPersistence, header, events, id))
      .rejects.toThrow('format v4 rejected the batch')
    expect(close).toHaveBeenCalled()
  })

  it('fails with a clear message when neither API shape is available', async () => {
    const create = vi.fn(async () => undefined)
    await expect(writeSeededSession({ create } as unknown as SessionPersistence, header, events, id))
      .rejects.toThrow('unsupported sessionPersistence API')
  })
})
