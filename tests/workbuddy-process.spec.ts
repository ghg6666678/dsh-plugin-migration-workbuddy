import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The pipe namespace is read through `node:fs`, so each test replaces that
 * module's `readdirSync` before importing the module under test. `vi.resetModules`
 * keeps the probe's own import from being shared between cases.
 */
async function withPipes(readdir: () => string[]) {
  vi.resetModules()
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return { ...actual, readdirSync: vi.fn(readdir) }
  })
  return import('../src/workbuddy-process.js')
}

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

describe('WorkBuddy running detection', () => {
  it('treats a WorkBuddy named pipe as a live instance', async () => {
    const module = await withPipes(() => ['workbuddy-ipc-1', 'initShutdown', 'some-other-app'])
    const activity = module.detectWorkBuddy()
    expect(activity.running).toBe(true)
    expect(activity.observed).toBe(true)
    // Only the matching pipe is evidence; unrelated apps are not.
    expect(activity.evidence).toEqual(['named pipe: workbuddy-ipc-1'])
  })

  it('recognises the CodeBuddy helper pipes too', async () => {
    const module = await withPipes(() => ['codebuddy-helper.sock'])
    expect(module.detectWorkBuddy().running).toBe(true)
  })

  it('reports a clean exit when no matching pipe exists', async () => {
    const module = await withPipes(() => ['initShutdown', 'lsass'])
    const activity = module.detectWorkBuddy()
    expect(activity).toMatchObject({ running: false, observed: true })
    expect(activity.evidence).toEqual([])
  })

  it('fails closed when the pipe namespace cannot be read', async () => {
    // A sandbox or a non-Windows host makes the listing throw. An unreadable
    // namespace must never be reported as "workbuddy is closed".
    const module = await withPipes(() => { throw new Error('EPERM: operation not permitted') })
    const activity = module.detectWorkBuddy()
    expect(activity.running).toBe(false)
    expect(activity.observed).toBe(false)
    expect(activity.evidence[0]).toContain('EPERM')
  })

  it('stamps the check time as an ISO instant', async () => {
    const module = await withPipes(() => [])
    expect(Number.isNaN(Date.parse(module.detectWorkBuddy().checkedAt))).toBe(false)
  })
})

describe('WorkBuddy data directory', () => {
  it('prefers WORKBUDDY_HOME and otherwise resolves ~/.workbuddy', async () => {
    const module = await withPipes(() => [])
    const previous = process.env.WORKBUDDY_HOME
    try {
      process.env.WORKBUDDY_HOME = 'C:\\custom\\workbuddy'
      expect(module.workBuddyRoot()).toBe('C:\\custom\\workbuddy')
      process.env.WORKBUDDY_HOME = '   '
      expect(module.workBuddyRoot().endsWith('.workbuddy')).toBe(true)
      delete process.env.WORKBUDDY_HOME
      expect(module.workBuddyRoot().endsWith('.workbuddy')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.WORKBUDDY_HOME
      else process.env.WORKBUDDY_HOME = previous
    }
  })
})
