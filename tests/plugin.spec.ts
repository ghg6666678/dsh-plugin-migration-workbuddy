import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.js'
import {
  MIGRATION_ARCHIVE_PATH,
  MIGRATION_EXPORT_HISTORY_PATH,
  MIGRATION_EXPORT_PREVIEW_PATH,
  MIGRATION_EXPORT_RUN_PATH,
  MIGRATION_EXPORT_UNDO_PATH,
  MIGRATION_MANIFEST_PATH,
  MIGRATION_MEMORY_DELETE_PATH,
  MIGRATION_MEMORY_UPDATE_PATH,
  MIGRATION_PREVIEW_PATH,
  MIGRATION_PROBE_PATH,
  MIGRATION_RUN_PATH,
} from '../src/routes.js'

interface RegisteredRoute {
  kind: string
  path: string
}

/**
 * The narrowest context the Host half touches. Only the members `apply` reads
 * are present, so this test fails loudly if the plugin grows a new mount-time
 * dependency without the profile providing it.
 */
function fakeContext(channel?: { saveRule?: (rule: unknown) => Promise<unknown> }) {
  const routes: RegisteredRoute[] = []
  const disposers: Array<() => void> = []
  const logs: string[] = []
  const context = {
    sessionPersistence: { create: async () => undefined, append: async () => undefined },
    webServer: {
      port: 45999,
      register: (route: RegisteredRoute) => {
        routes.push(route)
        const dispose = (): void => { routes.splice(routes.indexOf(route), 1) }
        disposers.push(dispose)
        return dispose
      },
    },
    logger: { info: (message: string) => { logs.push(message) } },
    effect: (callback: () => () => void) => callback(),
    get: (serviceName: string) => serviceName === 'automationImport' ? channel : undefined,
  }
  return { context, routes, disposers, logs }
}

describe('plugin mount', () => {
  it('registers the migration routes and releases them with its fiber', () => {
    const { context, routes, disposers } = fakeContext()
    apply(context as never, { enabled: true })
    expect(routes.map(route => route.path).sort()).toEqual([
      MIGRATION_ARCHIVE_PATH,
      MIGRATION_EXPORT_HISTORY_PATH,
      MIGRATION_EXPORT_PREVIEW_PATH,
      MIGRATION_EXPORT_RUN_PATH,
      MIGRATION_EXPORT_UNDO_PATH,
      MIGRATION_MANIFEST_PATH,
      MIGRATION_MEMORY_DELETE_PATH,
      MIGRATION_MEMORY_UPDATE_PATH,
      MIGRATION_PREVIEW_PATH,
      MIGRATION_PROBE_PATH,
      MIGRATION_RUN_PATH,
    ].sort())
    // Routes are namespaced to this plugin, never to a host product surface.
    expect(routes.every(route => route.path.startsWith('/api/migration/workbuddy/'))).toBe(true)
    expect(routes.every(route => route.kind === 'exact')).toBe(true)
    disposers.forEach(dispose => { dispose() })
    expect(routes).toEqual([])
  })

  it('mounts without an automation channel', () => {
    const { context, routes } = fakeContext()
    // No channel registered anywhere: mounting must still succeed, because the
    // channel is an optional integration rather than a dependency.
    expect(() => { apply(context as never, undefined) }).not.toThrow()
    // Seven import routes plus four export routes.
    expect(routes).toHaveLength(11)
  })

  it('mounts with a rule-import channel', () => {
    const { context } = fakeContext({ saveRule: async () => undefined })
    expect(() => { apply(context as never, undefined) }).not.toThrow()
  })

  it('scans nothing when disabled', () => {
    const { context, routes, logs } = fakeContext()
    apply(context as never, { enabled: false })
    expect(routes).toEqual([])
    expect(logs.some(message => message.includes('disabled'))).toBe(true)
  })

  it('exposes the profile row identity a composition mounts', () => {
    // The bundle patch and this export must agree, or `dsh plugin add` mounts a
    // row whose module never provides the expected plugin.
    expect(name).toBe('migration-workbuddy')
    expect(inject).toEqual(['webServer', 'sessionPersistence', 'workspaceRegistry'])
  })
})
