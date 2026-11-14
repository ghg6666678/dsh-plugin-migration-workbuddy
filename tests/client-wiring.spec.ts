import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.js'

interface RegisteredSlot {
  name: string
  id: string
  inject: () => { api: unknown; refreshSessions?: () => void }
}

/**
 * The narrowest client context the settings section touches. Only the members
 * `apply` reads are present, so the test fails loudly if the client half grows a
 * mount-time dependency the profile does not provide.
 */
function fakeClientContext(services: Record<string, unknown> = {}) {
  const slots: RegisteredSlot[] = []
  const dictionaries: string[] = []
  const context = {
    locale: {
      bind: () => (key: string) => key,
      register: (namespace: string) => { dictionaries.push(namespace); return () => undefined },
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => { callback() },
      register: (slot: RegisteredSlot) => { slots.push(slot); return () => undefined },
    },
    effect: (callback: () => () => void) => callback(),
    get: (serviceName: string) => services[serviceName],
  }
  return { context, slots, dictionaries }
}

describe('client wiring', () => {
  it('declares only the services it needs', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the settings section and publishes the locale namespace', () => {
    const { context, slots, dictionaries } = fakeClientContext()
    apply(context as never)
    expect(slots.map(slot => slot.id)).toEqual(['migration.workbuddy'])
    expect(slots[0]?.name).toBe('settings.section')
    expect(dictionaries).toEqual(['migration.workbuddy'])
  })

  /**
   * The sidebar never polls and the Host pushes nothing for a session a plugin
   * wrote straight to disk, so the panel must ask for a list refresh. Without
   * this call newly imported conversations stay invisible until Harness is
   * restarted — the exact bug this test pins.
   */
  it('asks the session list to refresh when the service is present', () => {
    let refreshes = 0
    const { context, slots } = fakeClientContext({ sessions: { refresh: async () => { refreshes += 1 } } })
    apply(context as never)
    slots[0]?.inject().refreshSessions?.()
    expect(refreshes).toBe(1)
  })

  it('survives a profile without the session controller service', () => {
    const { context, slots } = fakeClientContext({})
    apply(context as never)
    expect(() => { slots[0]?.inject().refreshSessions?.() }).not.toThrow()
  })

  it('never lets a rejected refresh escape into the panel', async () => {
    const { context, slots } = fakeClientContext({ sessions: { refresh: () => Promise.reject(new Error('offline')) } })
    apply(context as never)
    expect(() => { slots[0]?.inject().refreshSessions?.() }).not.toThrow()
    // Give the swallowed rejection a turn to settle: an unhandled rejection
    // would fail this suite.
    await Promise.resolve()
  })

  it('tolerates a service without a refresh method', () => {
    const { context, slots } = fakeClientContext({ sessions: {} })
    apply(context as never)
    expect(() => { slots[0]?.inject().refreshSessions?.() }).not.toThrow()
  })
})
