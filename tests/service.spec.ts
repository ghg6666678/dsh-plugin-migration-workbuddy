import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MigrationService, sanitizeSessionFilter } from '../src/service.js'

describe('MigrationService incremental imports', () => {
  it('skips an unchanged source and replaces a changed source', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-migration-source-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-migration-target-'))
    const project = join(sourceRoot, 'projects', 'project')
    await mkdir(project, { recursive: true })
    const sourcePath = join(project, 'session.jsonl')
    await writeFile(sourcePath, JSON.stringify({ type: 'message', role: 'user', content: 'first', cwd: sourceRoot, timestamp: 1000 }))
    const created: string[] = []
    const persisted: Array<{ isSeeded: boolean | undefined; inherited: number | undefined }> = []
    const persistence = {
      create: async (header: { id: string; isSeeded?: boolean }, inheritedEventCount?: number) => { created.push(header.id); persisted.push({ isSeeded: header.isSeeded, inherited: inheritedEventCount }) },
      append: async () => undefined,
    }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      const firstPreview = await service.preview()
      expect(firstPreview.sessions[0]?.status).toBe('new')
      expect(firstPreview.summary.eligible).toBe(1)
      const first = await service.migrate({ sessions: true, memories: false, mcp: false })
      expect(first.importedSessions).toBe(1)
      expect(created).toHaveLength(1)
      expect(persisted[0]).toMatchObject({ isSeeded: true, inherited: expect.any(Number) })
      expect(persisted[0]?.inherited).toBeGreaterThanOrEqual(1)

      const unchangedPreview = await service.preview()
      expect(unchangedPreview.sessions[0]?.status).toBe('unchanged')
      expect(unchangedPreview.summary.eligible).toBe(0)
      const skipped = await service.migrate({ sessions: true, memories: false, mcp: false })
      expect(skipped.importedSessions).toBe(0)
      expect(skipped.skippedSessions).toBe(1)
      expect(created).toHaveLength(1)

      await writeFile(sourcePath, JSON.stringify({ type: 'message', role: 'user', content: 'changed', cwd: sourceRoot, timestamp: 1000 }))
      const changedPreview = await service.preview()
      expect(changedPreview.sessions[0]?.status).toBe('changed')
      expect(changedPreview.summary.changed).toBe(1)
      const changed = await service.migrate({ sessions: true, memories: false, mcp: false })
      expect(changed.importedSessions).toBe(1)
      expect(created).toHaveLength(2)

      // The superseded import stays in the manifest as history, but it must never
      // be marked archived: archiving the old entry is what previously removed
      // the user's existing conversation from the DSH sidebar.
      const manifest = JSON.parse(await readFile(service.manifestPath, 'utf8')) as { sessions: Array<{ archived?: boolean; status?: string; targetSessionId: string }> }
      expect(manifest.sessions.filter(item => item.archived !== true)).toHaveLength(2)
      expect(manifest.sessions.filter(item => item.status === 'archived')).toHaveLength(0)
      expect(manifest.sessions[0]?.status).toBe('imported')
      expect(manifest.sessions[1]?.status).toBe('imported')
      expect(manifest.sessions[0]?.targetSessionId).not.toBe(manifest.sessions[1]?.targetSessionId)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('MigrationService on-demand session selection', () => {
  async function setup(): Promise<{ service: MigrationService; keys: { a: string; b: string; u: string }; workspaceId: string | undefined; targetRoot: string }> {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-migration-on-demand-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-migration-target-'))
    const project = join(sourceRoot, 'projects', 'p1')
    await mkdir(project, { recursive: true })
    const write = async (name: string, cwd?: string): Promise<void> => {
      await writeFile(join(project, name), JSON.stringify({ type: 'message', role: 'user', content: name, ...(cwd ? { cwd } : {}), timestamp: 1000 }))
    }
    await write('a.jsonl', sourceRoot)
    await write('b.jsonl', sourceRoot)
    await write('u.jsonl')
    const created: string[] = []
    const persistence = {
      create: async (header: { id: string }) => { created.push(header.id) },
      append: async () => undefined,
    }
    process.env.DSH_HOME = targetRoot
    const service = new MigrationService(persistence as never, undefined, { sourceRoot })
    const preview = await service.preview()
    const keys: { a: string; b: string; u: string } = { a: '', b: '', u: '' }
    for (const item of preview.sessions) {
      if (item.sourceSessionId === 'a') keys.a = item.key
      if (item.sourceSessionId === 'b') keys.b = item.key
      if (item.sourceSessionId === 'u') keys.u = item.key
    }
    return { service, keys, workspaceId: preview.sessions.find(item => item.sourceSessionId === 'a')?.workspaceId, targetRoot }
  }

  it('exposes stable key and workspaces summary in preview', async () => {
    const { service, keys } = await setup()
    try {
      const preview = await service.preview()
      expect(preview.sessions.map(item => item.key)).toContain(keys.a)
      expect(preview.sessions.find(item => item.sourceSessionId === 'a')?.workspaceId).toBeDefined()
      expect(preview.sessions.find(item => item.sourceSessionId === 'u')?.workspaceId).toBeUndefined()
      expect(preview.workspaces).toHaveLength(2)
      const grouped = preview.workspaces.find(item => item.id !== 'ungrouped')
      expect(grouped?.count).toBe(2)
      expect(preview.workspaces.find(item => item.id === 'ungrouped')?.count).toBe(1)
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('imports only sessions selected by key', async () => {
    const { service, keys } = await setup()
    try {
      const result = await service.migrate({ sessions: true, memories: false, mcp: false, sessionKeys: [keys.b] })
      expect(result.importedSessions).toBe(1)
      expect(result.skippedSessions).toBe(2)
      const manifest = JSON.parse(await readFile(service.manifestPath, 'utf8')) as { sessions: Array<{ sourceKey?: string; targetSessionId: string }> }
      expect(manifest.sessions.map(item => item.sourceKey)).toEqual([keys.b])
      const untouchedPreview = await service.preview()
      expect(untouchedPreview.sessions.find(item => item.key === keys.a)?.status).toBe('new')
      expect(untouchedPreview.sessions.find(item => item.key === keys.b)?.status).toBe('unchanged')
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('imports a whole workspace by workspaceId', async () => {
    const { service, keys, workspaceId } = await setup()
    expect(workspaceId).toBeDefined()
    try {
      const result = await service.migrate({ sessions: true, memories: false, mcp: false, workspaceIds: [workspaceId!] })
      expect(result.importedSessions).toBe(2)
      expect(result.skippedSessions).toBe(1)
      const manifest = JSON.parse(await readFile(service.manifestPath, 'utf8')) as { sessions: Array<{ sourceKey?: string }> }
      expect(manifest.sessions.map(item => item.sourceKey).sort()).toEqual([keys.a, keys.b].sort())
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('reports unknown selection keys without side effects', async () => {
    const { service } = await setup()
    try {
      const result = await service.migrate({ sessions: true, memories: false, mcp: false, sessionKeys: ['does-not-exist'] })
      expect(result.importedSessions).toBe(0)
      expect(result.loss.some(item => item.code === 'unknown-selection-key')).toBe(true)
      const manifest = JSON.parse(await readFile(service.manifestPath, 'utf8')) as { sessions: unknown[] }
      expect(manifest.sessions).toHaveLength(0)
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('rejects filters when sessions are disabled', async () => {
    const { service, keys } = await setup()
    try {
      await expect(service.migrate({ sessions: false, memories: false, mcp: false, sessionKeys: [keys.a] })).rejects.toThrow('session filters require sessions')
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('validates filter arrays', () => {
    expect(sanitizeSessionFilter(['ok', 'fine'], 'sessionKeys')).toEqual(['ok', 'fine'])
    expect(sanitizeSessionFilter(undefined, 'sessionKeys')).toEqual([])
    expect(() => sanitizeSessionFilter('nope', 'sessionKeys')).toThrow('must be an array')
    expect(() => sanitizeSessionFilter([''], 'sessionKeys')).toThrow('invalid entries')
  })
})

describe('MigrationService deleted sessions', () => {
  it('never imports a session WorkBuddy marks deleted, even with force', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-migration-deleted-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-migration-deleted-target-'))
    const project = join(sourceRoot, 'projects', 'p')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'live.jsonl'), JSON.stringify({ type: 'message', role: 'user', content: 'live', timestamp: 1000 }))
    await writeFile(join(project, 'gone.jsonl'), JSON.stringify({ type: 'message', role: 'user', content: 'gone', timestamp: 1000 }))

    const db = new DatabaseSync(join(sourceRoot, 'workbuddy.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, is_playground INTEGER, deleted_at INTEGER)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('live', null, 't', null, 1, null)
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('gone', null, 't', null, 1, 1735689600000)
    db.close()

    const created: string[] = []
    const persistence = {
      create: async (header: { id: string }) => { created.push(header.id) },
      append: async () => undefined,
    }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      const preview = await service.preview()
      expect(preview.sessions.map(item => item.sourceSessionId)).toEqual(['live'])
      const result = await service.migrate({ sessions: true, memories: false, mcp: false, force: true })
      expect(result.importedSessions).toBe(1)
      expect(created).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('MigrationService memory import', () => {
  it('imports the curated MEMORY.md and prunes scaffolding stored by older builds', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-mem-source-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-mem-target-'))
    await mkdir(join(sourceRoot, 'memory'), { recursive: true })
    // The per-account profile is scaffolding; the curated notes live at the root.
    await writeFile(join(sourceRoot, 'memory', 'uid_memory.md'), [
      '# User Memory Profile',
      '> Last updated: 2026-11-11T15:38:18.430Z',
      '> Version: 0',
      '',
      '## Memory Block',
      '',
      '',
      '---',
      '<!-- RAW_JSON_START',
      '{',
      '  "memoryBlock": "",',
      '}',
      'RAW_JSON_END -->',
    ].join('\n'))
    await writeFile(join(sourceRoot, 'MEMORY.md'), '# MEMORY.md\n\n## 经验\n\n- 真实笔记一\n- 真实笔记二\n')

    // Simulate the store a pre-fix release left behind.
    await mkdir(join(targetRoot, 'migration', 'memory'), { recursive: true })
    const noise = JSON.stringify({
      id: 'stale', content: '> Last updated: 2026-11-10T17:35:01.983Z',
      sourcePath: join(sourceRoot, 'memory', 'uid_memory.md'), sourceHash: 'h', enabled: true, createdAt: '2026-11-10T00:00:00.000Z',
    })
    await writeFile(join(targetRoot, 'migration', 'memory', 'records.jsonl'), `${noise}\n`)
    await writeFile(join(targetRoot, 'migration', 'manifest.json'), JSON.stringify({
      version: 2, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
      sessions: [], mcp: [], automations: [],
      memories: [JSON.parse(noise)],
    }))

    const persistence = { create: async () => undefined, append: async () => undefined }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      const preview = await service.preview()
      expect(preview.memories.flatMap(item => item.records.map(record => record.content)))
        .toEqual(['真实笔记一', '真实笔记二'])

      const result = await service.migrate({ sessions: false, memories: true, mcp: false })
      expect(result.importedMemories).toBe(2)

      const stored = (await readFile(join(targetRoot, 'migration', 'memory', 'records.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as { content: string })
      expect(stored.map(item => item.content)).toEqual(['真实笔记一', '真实笔记二'])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('MigrationService settings', () => {
  it('persists the per-file limit and applies it to probing', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-settings-source-'))
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-settings-target-'))
    const project = join(sourceRoot, 'projects', 'p')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 's.jsonl'), JSON.stringify({ type: 'message', role: 'user', content: 'hi', timestamp: 1000 }))
    const persistence = { create: async () => undefined, append: async () => undefined }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      expect(await service.settings()).toEqual({})
      await service.saveSettings({ maxFileBytes: 0 })
      expect(await service.settings()).toEqual({ maxFileBytes: 0 })
      expect((await service.preview()).sessions).toHaveLength(1)

      await service.saveSettings({ maxFileBytes: 1 })
      const limited = await service.preview()
      expect(limited.sessions).toHaveLength(0)
      expect(limited.source.warnings.some(item => item.code === 'file-too-large')).toBe(true)

      await service.saveSettings({ maxFileBytes: 0 })
      expect((await service.preview()).sessions).toHaveLength(1)
      await expect(service.saveSettings({ maxFileBytes: -1 })).rejects.toThrow('non-negative integer')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('MigrationService context budget', () => {
  /**
   * Importing must reproduce the whole conversation by default.
   *
   * A configured budget used to be applied unconditionally and silently, which
   * reduced a 77 MB / 21659-line WorkBuddy transcript to a handful of turns and
   * replaced the rest with a summary. Nothing may trim unless the user asks.
   */
  async function writeLongSource(): Promise<string> {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-budget-source-'))
    const project = join(sourceRoot, 'projects', 'p')
    await mkdir(project, { recursive: true })
    const lines = Array.from({ length: 40 }, (_, index) => JSON.stringify({ type: 'message', role: index % 2 === 0 ? 'user' : 'assistant', content: `turn-${String(index)} ${'x'.repeat(400)}`, cwd: sourceRoot, timestamp: 1000 + index }))
    const path = join(project, 'long.jsonl')
    await writeFile(path, `${lines.join('\n')}\n`)
    return sourceRoot
  }

  it('keeps every turn when no budget is configured', async () => {
    const sourceRoot = await writeLongSource()
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-budget-target-'))
    const created: Array<{ id: string }> = []
    const persistence = { create: async (header: { id: string }) => { created.push(header); return { append: async () => undefined, flush: async () => undefined, close: async () => undefined } }, append: async () => undefined }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      expect(await service.settings()).toEqual({})
      const result = await service.migrate({ sessions: true, memories: false, mcp: false })
      expect(result.importedSessions).toBe(1)
      expect(result.loss.filter(item => item.code === 'context-trimmed')).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('trims only when the user sets a budget, and reports it', async () => {
    const sourceRoot = await writeLongSource()
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-budget-target-'))
    const persistence = { create: async () => ({ append: async () => undefined, flush: async () => undefined, close: async () => undefined }), append: async () => undefined }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      await service.saveSettings({ maxContextTokens: 1000 })
      const result = await service.migrate({ sessions: true, memories: false, mcp: false })
      expect(result.importedSessions).toBe(1)
      const trimmed = result.loss.filter(item => item.code === 'context-trimmed')
      expect(trimmed).toHaveLength(1)
      expect(trimmed[0]?.detail).toContain('set the budget to 0')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('MigrationService summary fold', () => {
  /** A transcript big enough that `auto` must fold, carrying one WB summary. */
  async function writeFoldableSource(): Promise<string> {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-fold-source-'))
    const project = join(sourceRoot, 'projects', 'p')
    await mkdir(project, { recursive: true })
    const summary = 'Established the parser, the CLI entry point and the catalog reader. '
      + 'Remaining work: wire the fold into the service layer and verify it against '
      + 'a real transcript before publishing.'
    const lines = [
      JSON.stringify({ type: 'message', role: 'user', content: 'start', cwd: sourceRoot, timestamp: 1000 }),
      ...Array.from({ length: 40 }, (_, index) => JSON.stringify({ type: 'message', role: 'assistant', content: `step ${String(index)} ${'x'.repeat(20_000)}`, timestamp: 2000 + index })),
      JSON.stringify({ type: 'message', role: 'user', timestamp: 9000, content: `<conversation_history_summary>\n<summary>${summary}</summary>\n</conversation_history_summary>` }),
      JSON.stringify({ type: 'message', role: 'user', content: 'later question', timestamp: 9500 }),
    ]
    await writeFile(join(project, 'big.jsonl'), `${lines.join('\n')}\n`)
    return sourceRoot
  }

  it('folds by default and records why, so a huge project stays continuable', async () => {
    const sourceRoot = await writeFoldableSource()
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-fold-target-'))
    const written: Array<{ events: Array<{ data?: { source?: { kind?: string } } }> }> = []
    const persistence = {
      create: async () => ({ append: async (body: { events: never[] }) => { written.push(body as never) }, flush: async () => undefined, close: async () => undefined }),
      append: async () => undefined,
    }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      // `auto` is the default: no setting is required for the large case.
      expect((await service.settings()).summaryMode).toBeUndefined()
      const result = await service.migrate({ sessions: true, memories: false, mcp: false })
      expect(result.importedSessions).toBe(1)
      expect(result.loss.map(item => item.code)).toContain('summary-checkpoint')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('honours summaryMode "never" and keeps the untouched transcript', async () => {
    const sourceRoot = await writeFoldableSource()
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-fold-target-'))
    const persistence = { create: async () => ({ append: async () => undefined, flush: async () => undefined, close: async () => undefined }), append: async () => undefined }
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = targetRoot
    try {
      const service = new MigrationService(persistence as never, undefined, { sourceRoot })
      await service.saveSettings({ summaryMode: 'never' })
      const result = await service.migrate({ sessions: true, memories: false, mcp: false })
      expect(result.importedSessions).toBe(1)
      expect(result.loss.map(item => item.code)).not.toContain('summary-checkpoint')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('MigrationService archive bookkeeping', () => {
  /**
   * `archiveSession()` reports refusal in its result object and never throws, so
   * a refused archive must not be recorded as archived: the manifest would then
   * claim a state the sidebar does not show. This pins the result check.
   */
  async function setupArchive(archiveSession: (id: string) => Promise<unknown>) {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'mwb-archive-source-'))
    const project = join(sourceRoot, 'projects', 'p1')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 's.jsonl'), JSON.stringify({ type: 'message', role: 'user', content: 'hi', cwd: sourceRoot, timestamp: 1000 }))
    const persistence = { create: async () => undefined, append: async () => undefined }
    const workspaceRegistry = {
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'ws-1', attachSession: async () => undefined }),
      archiveSession,
    }
    const service = new MigrationService(persistence as never, workspaceRegistry as never, { sourceRoot })
    await service.migrate({ sessions: true, memories: false, mcp: false })
    return { service }
  }

  it('does not record an archive the workspace refused', async () => {
    const refusals: string[] = []
    const previous = process.env.DSH_HOME
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-archive-env-'))
    process.env.DSH_HOME = targetRoot
    try {
      const { service } = await setupArchive(async (id: string) => { refusals.push(id); return { ok: false } })
      const result = await service.archiveLastImport()
      expect(refusals).toHaveLength(1)
      expect(result).toEqual({ archived: 0, failed: 1 })
      const manifest = JSON.parse(await readFile(service.manifestPath, 'utf8')) as { sessions: Array<{ archived?: boolean }> }
      expect(manifest.sessions.some(item => item.archived === true)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('records the archive when the workspace accepts it', async () => {
    const previous = process.env.DSH_HOME
    const targetRoot = await mkdtemp(join(tmpdir(), 'mwb-archive-env-'))
    process.env.DSH_HOME = targetRoot
    try {
      const { service } = await setupArchive(async () => ({ ok: true }))
      expect(await service.archiveLastImport()).toEqual({ archived: 1, failed: 0 })
      const manifest = JSON.parse(await readFile(service.manifestPath, 'utf8')) as { sessions: Array<{ archived?: boolean }> }
      expect(manifest.sessions.filter(item => item.archived === true)).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
