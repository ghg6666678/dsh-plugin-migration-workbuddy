import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { MigrationConfig } from './config.js'
import { MigrationService, sanitizePathForPreview, sanitizeSessionFilter } from './service.js'

export const MIGRATION_PROBE_PATH = '/api/migration/workbuddy/probe'
export const MIGRATION_PREVIEW_PATH = '/api/migration/workbuddy/preview'
export const MIGRATION_RUN_PATH = '/api/migration/workbuddy/run'
export const MIGRATION_MANIFEST_PATH = '/api/migration/workbuddy/manifest'
export const MIGRATION_ARCHIVE_PATH = '/api/migration/workbuddy/archive'
export const MIGRATION_MEMORY_UPDATE_PATH = '/api/migration/workbuddy/memory/update'
export const MIGRATION_MEMORY_DELETE_PATH = '/api/migration/workbuddy/memory/delete'

/** Sent by the bundled client on every call; keep in sync with src/client/api.ts. */
export const MIGRATION_CLIENT_HEADER = 'x-workbuddy-migration'

function loopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address?.startsWith('::ffff:127.') === true
}

function loopbackHosts(port: number): Set<string> {
  return new Set([
    `127.0.0.1:${String(port)}`,
    `localhost:${String(port)}`,
    `[::1]:${String(port)}`,
  ])
}

/**
 * Guard against DNS rebinding and cross-site writes while remaining usable from
 * the Electron desktop shell: its document can carry `Origin: null` (or no
 * Origin at all), and the host spellings vary between loopback aliases. The real
 * barriers are a loopback peer plus an exact loopback Host. For writes we also
 * require the bundled client's marker header: a cross-site page cannot set a
 * custom header without a CORS preflight, which these routes never grant.
 */
export function sameOrigin(req: IncomingMessage, mutating: boolean, port: number): boolean {
  if (!loopback(req)) return false
  const host = req.headers.host
  const hosts = loopbackHosts(port)
  if (host === undefined || !hosts.has(host)) return false
  const origin = req.headers.origin
  // Reject a genuine cross-site http(s) origin. Opaque origins ("null",
  // custom desktop schemes, or a missing header) are expected from the
  // Electron shell; the marker header below is what stops forged writes.
  const externalHttpOrigin = origin !== undefined
    && origin !== 'null'
    && /^https?:\/\//i.test(origin)
    && ![...hosts].some(value => `http://${value}` === origin || `https://${value}` === origin)
  if (externalHttpOrigin) return false
  if (mutating) {
    // The bundled client always sends the marker. Sec-Fetch-Site is a fallback
    // for shells that proxy the request and drop custom headers; browsers set
    // it themselves, so a cross-site form cannot forge "same-origin"/"none".
    return req.headers[MIGRATION_CLIENT_HEADER] === '1'
      || req.headers['sec-fetch-site'] === 'same-origin'
      || req.headers['sec-fetch-site'] === 'none'
  }
  return true
}

function sendJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

function redactPreview(value: Awaited<ReturnType<MigrationService['preview']>>): Awaited<ReturnType<MigrationService['preview']>> {
  return {
    ...value,
    source: {
      ...value.source,
      sourceRoot: sanitizePathForPreview(value.source.sourceRoot),
      projectsPath: sanitizePathForPreview(value.source.projectsPath),
      memoryPath: sanitizePathForPreview(value.source.memoryPath),
      memoryPaths: value.source.memoryPaths.map(sanitizePathForPreview),
      sessions: value.source.sessions.map(item => ({ ...item, path: sanitizePathForPreview(item.path) })),
      memoryCandidates: value.source.memoryCandidates.map(item => ({ ...item, path: sanitizePathForPreview(item.path) })),
      warnings: value.source.warnings.map(item => ({ ...item, path: sanitizePathForPreview(item.path) })),
      ...(value.source.legacyDatabase ? { legacyDatabase: { ...value.source.legacyDatabase, path: sanitizePathForPreview(value.source.legacyDatabase.path) } } : {}),
    },
    sessions: value.sessions.map(item => ({ ...item, path: sanitizePathForPreview(item.path), ...(item.workspacePath ? { workspacePath: sanitizePathForPreview(item.workspacePath) } : {}) })),
    workspaces: value.workspaces.map(item => ({ ...item, path: item.path === '' ? '' : sanitizePathForPreview(item.path) })),
    memories: value.memories.map(item => ({ ...item, sourcePath: sanitizePathForPreview(item.sourcePath) })),
    mcp: value.mcp.map(item => ({ ...item, sourcePath: sanitizePathForPreview(item.sourcePath) })),
    automations: value.automations.map(item => ({ ...item, ...(item.targetWorkspacePath ? { targetWorkspacePath: sanitizePathForPreview(item.targetWorkspacePath) } : {}) })),
  }
}

function redactReport(value: Awaited<ReturnType<MigrationService['probe']>>): Awaited<ReturnType<MigrationService['probe']>> {
  return {
    ...value,
    sourceRoot: sanitizePathForPreview(value.sourceRoot),
    projectsPath: sanitizePathForPreview(value.projectsPath),
    memoryPath: sanitizePathForPreview(value.memoryPath),
    memoryPaths: value.memoryPaths.map(sanitizePathForPreview),
    sessions: value.sessions.map(item => ({ ...item, path: sanitizePathForPreview(item.path) })),
    memoryCandidates: value.memoryCandidates.map(item => ({ ...item, path: sanitizePathForPreview(item.path) })),
    warnings: value.warnings.map(item => ({ ...item, path: sanitizePathForPreview(item.path) })),
    ...(value.legacyDatabase ? { legacyDatabase: { ...value.legacyDatabase, path: sanitizePathForPreview(value.legacyDatabase.path) } } : {}),
  }
}

function redactManifest(value: Awaited<ReturnType<MigrationService['manifestView']>>): Awaited<ReturnType<MigrationService['manifestView']>> {
  return {
    ...value,
    sessions: value.sessions.map(item => ({ ...item, sourcePath: sanitizePathForPreview(item.sourcePath) })),
    memories: value.memories.map(item => ({ ...item, sourcePath: sanitizePathForPreview(item.sourcePath) })),
    mcp: value.mcp.map(item => ({ ...item, sourcePath: sanitizePathForPreview(item.sourcePath) })),
  }
}

export function registerMigrationRoutes(webserver: WebServer, config: MigrationConfig, service: MigrationService): () => void {
  const paths = [MIGRATION_PROBE_PATH, MIGRATION_PREVIEW_PATH, MIGRATION_RUN_PATH, MIGRATION_MANIFEST_PATH, MIGRATION_ARCHIVE_PATH, MIGRATION_MEMORY_UPDATE_PATH, MIGRATION_MEMORY_DELETE_PATH]
  const routes = paths.map(path => webserver.register({
    kind: 'exact' as const,
    path,
    handler: async (req, res) => {
      const mutating = path !== MIGRATION_PROBE_PATH && path !== MIGRATION_PREVIEW_PATH && path !== MIGRATION_MANIFEST_PATH
      if (!sameOrigin(req, mutating, webserver.port)) { sendJson(res, 403, { error: 'loopback same-origin request required' }); return }
      try {
        if (path === MIGRATION_PROBE_PATH || path === MIGRATION_PREVIEW_PATH) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET required' }); return }
          sendJson(res, 200, path === MIGRATION_PREVIEW_PATH ? redactPreview(await service.preview()) : redactReport(await service.probe()))
          return
        }
        if (path === MIGRATION_MANIFEST_PATH) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET required' }); return }
          sendJson(res, 200, redactManifest(await service.manifestView())); return
        }
        if (path === MIGRATION_RUN_PATH) {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return }
          const input = await body(req)
          if (input.confirmed !== true) { sendJson(res, 400, { error: 'explicit confirmation required' }); return }
          let sessionKeys: string[] | undefined
          let workspaceIds: string[] | undefined
          let automationIds: string[] | undefined
          try {
            sessionKeys = sanitizeSessionFilter(input.sessionKeys, 'sessionKeys')
            workspaceIds = sanitizeSessionFilter(input.workspaceIds, 'workspaceIds')
            automationIds = sanitizeSessionFilter(input.automationIds, 'automationIds')
          } catch (cause) {
            sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) }); return
          }
          sendJson(res, 200, await service.migrate({
            sessions: input.sessions !== false,
            memories: input.memories === true,
            mcp: input.mcp === true,
            automations: input.automations === true,
            force: input.force === true,
            ...(sessionKeys.length > 0 ? { sessionKeys } : {}),
            ...(workspaceIds.length > 0 ? { workspaceIds } : {}),
            ...(automationIds.length > 0 ? { automationIds } : {}),
          }))
          return
        }
        if (path === MIGRATION_MEMORY_UPDATE_PATH) {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return }
          const input = await body(req)
          if (typeof input.id !== 'string' || typeof input.enabled !== 'boolean') { sendJson(res, 400, { error: 'id and enabled required' }); return }
          sendJson(res, 200, { memory: await service.setMemoryEnabled(input.id, input.enabled) }); return
        }
        if (path === MIGRATION_MEMORY_DELETE_PATH) {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return }
          const input = await body(req)
          if (typeof input.id !== 'string') { sendJson(res, 400, { error: 'id required' }); return }
          sendJson(res, 200, { ok: await service.deleteMemory(input.id) }); return
        }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return }
        const input = await body(req)
        sendJson(res, 200, await service.archiveLastImport(typeof input.manifestId === 'string' ? input.manifestId : undefined))
      } catch (cause) { sendJson(res, 500, { error: cause instanceof Error ? cause.message : String(cause) }) }
    },
  }))
  void config
  return () => { routes.forEach(dispose => dispose()) }
}
