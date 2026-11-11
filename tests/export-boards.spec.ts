import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isSubstantiveMemory,
  mergeMcpDocument,
  mergeMemoryBlock,
  MEMORY_BLOCK_START,
  readExportAutomations,
  readExportMcp,
  readExportMemories,
  removeMcpServers,
  removeMemoryBlock,
  scanMcpPatch,
  toAutomationRow,
  toExportAutomation,
} from '../src/export-boards.js'

function homes(): { dshHome: string; workbuddyRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'mwb-boards-'))
  const dshHome = join(base, 'dsh')
  const workbuddyRoot = join(base, 'workbuddy')
  mkdirSync(join(dshHome, 'migration', 'memory'), { recursive: true })
  mkdirSync(workbuddyRoot, { recursive: true })
  return { dshHome, workbuddyRoot }
}

describe('memory export', () => {
  it('drops the scaffolding the importers emit', () => {
    for (const noise of [
      '---', '> Last updated: 2026-01-01', '> Version: 0', '<!-- RAW_JSON_START',
      'RAW_JSON_END -->', '{', '}', '"uid": "abc",', '"memoryBlock": "",', '"updatedAt": 12,', '   ',
    ]) {
      expect(isSubstantiveMemory(noise), noise).toBe(false)
    }
  })

  it('keeps a real memory line', () => {
    expect(isSubstantiveMemory('本机 MCP 统一放在 ~/.workbuddy/mcp.json')).toBe(true)
    expect(isSubstantiveMemory('- 用 REA 分析 app.asar 时走 ELECTRON_RUN_AS_NODE')).toBe(true)
  })

  it('reports nothing to export when every record is scaffolding', () => {
    const { dshHome, workbuddyRoot } = homes()
    writeFileSync(join(dshHome, 'migration', 'memory', 'records.jsonl'), [
      JSON.stringify({ id: 'a', content: '---' }),
      JSON.stringify({ id: 'b', content: '> Version: 0' }),
      JSON.stringify({ id: 'c', content: '"uid": "x",' }),
      '',
    ].join('\n'))
    const board = readExportMemories(dshHome, workbuddyRoot)
    expect(board.records).toEqual([])
    expect(board.summary).toEqual({ total: 0, pending: 0, present: 0, skipped: 3 })
    expect(board.targetExists).toBe(false)
    expect(board.targetPath.endsWith('MEMORY.md')).toBe(true)
  })

  it('counts a record already present in MEMORY.md as present', () => {
    const { dshHome, workbuddyRoot } = homes()
    writeFileSync(join(dshHome, 'migration', 'memory', 'records.jsonl'), [
      JSON.stringify({ id: 'a', content: '本机 MCP 统一放在 ~/.workbuddy/mcp.json' }),
      JSON.stringify({ id: 'b', content: '另一个还没写进去的事实' }),
      '',
    ].join('\n'))
    writeFileSync(join(workbuddyRoot, 'MEMORY.md'), '# MEMORY.md\n\n- 本机 MCP 统一放在   ~/.workbuddy/mcp.json\n')
    const board = readExportMemories(dshHome, workbuddyRoot)
    expect(board.summary).toMatchObject({ total: 2, pending: 1, present: 1, skipped: 0 })
    expect(board.targetExists).toBe(true)
    expect(board.records.find(item => item.present)?.id).toBe('a')
  })

  it('reads the manifest copy and skips disabled records', () => {
    const { dshHome, workbuddyRoot } = homes()
    writeFileSync(join(dshHome, 'migration', 'manifest.json'), JSON.stringify({
      memories: [
        { id: 'on', content: '把 EXPORT 目录固定放在 D 盘', enabled: true },
        { id: 'off', content: '这条已被停用', enabled: false },
      ],
    }))
    const board = readExportMemories(dshHome, workbuddyRoot)
    expect(board.records.map(item => item.id)).toEqual(['on'])
    expect(board.records[0]!.source).toBe('manifest')
  })

  it('writes one managed block and leaves the user sections alone', () => {
    const existing = '# MEMORY.md\n\n## 本机环境\n\n- 我是 Windows\n'
    const once = mergeMemoryBlock(existing, ['规则一'])
    expect(once).toContain('## 本机环境')
    expect(once).toContain(MEMORY_BLOCK_START)
    expect(once).toContain('- 规则一')
    // A second export replaces the block instead of stacking a duplicate.
    const twice = mergeMemoryBlock(once, ['规则二'])
    expect(twice.split(MEMORY_BLOCK_START)).toHaveLength(2)
    expect(twice).toContain('- 规则二')
    expect(twice).not.toContain('- 规则一')
    expect(twice).toContain('## 本机环境')
  })

  it('round-trips the block back out for undo', () => {
    const existing = '# MEMORY.md\n\n## 本机环境\n\n- 我是 Windows\n'
    const merged = mergeMemoryBlock(existing, ['规则一'])
    expect(removeMemoryBlock(merged)).toBe(existing)
    expect(removeMemoryBlock(existing)).toBeUndefined()
  })
})

describe('MCP export', () => {
  const patch = [
    '- insert:',
    '- id: mcp-everything',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: everything',
    '    transport: stdio',
    '    command: npx',
    "    args: ['-y', '@modelcontextprotocol/server-everything']",
    '# - id: mcp-memory',
    '#   config:',
    '#     serverName: memory',
    '#     command: npx',
    '- id: mcp-remote',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: remote-tools',
    '    transport: streamable-http',
    '    url: https://example.test/mcp',
    '    headers:',
    '      Authorization: !!js process.env.TOKEN',
    '- id: other',
    "  name: '@deepseek-ai/dsh-schedule'",
    '  config:',
    '    serverName: not-a-server',
    '',
  ].join('\n')

  it('recovers stdio and http servers and ignores commented-out entries', () => {
    const servers = scanMcpPatch('C:/p/cordis.patch.yml', patch)
    expect(servers.map(item => item.serverName)).toEqual(['everything', 'remote-tools'])
    expect(servers[0]).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    })
    expect(servers[1]).toMatchObject({ transport: 'streamable-http', url: 'https://example.test/mcp' })
  })

  it('keeps only the header names, never their values', () => {
    const servers = scanMcpPatch('C:/p/cordis.patch.yml', patch)
    expect(servers[1]!.secretKeys).toEqual(['Authorization'])
    expect(JSON.stringify(servers)).not.toContain('process.env.TOKEN')
  })

  it('ignores a patch file that mounts no mcp-client', () => {
    expect(scanMcpPatch('C:/p/cordis.patch.yml', '- id: other\n  name: nope\n  config:\n    serverName: x\n')).toEqual([])
  })

  it('marks a new server as new and a matching one as present', () => {
    const { dshHome, workbuddyRoot } = homes()
    const profile = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mcp-bridge')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
    const board = readExportMcp(dshHome, workbuddyRoot)
    expect(board.servers.map(item => item.serverName).sort()).toEqual(['everything', 'remote-tools'])
    expect(board.summary).toMatchObject({ total: 2, new: 2, present: 0, conflict: 0 })
    expect(board.targetPath.endsWith('mcp.json')).toBe(true)
    expect(board.targetExists).toBe(false)
  })

  it('reports the same name with a different shape as a conflict, not an overwrite', () => {
    const { dshHome, workbuddyRoot } = homes()
    const profile = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mcp-bridge')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
    writeFileSync(join(workbuddyRoot, 'mcp.json'), JSON.stringify({
      mcpServers: {
        everything: { command: 'node', args: ['other.js'] },
        'remote-tools': { url: 'https://example.test/mcp' },
      },
    }))
    const board = readExportMcp(dshHome, workbuddyRoot)
    const byName = new Map(board.servers.map(item => [item.serverName, item]))
    expect(byName.get('everything')?.status).toBe('conflict')
    expect(byName.get('remote-tools')?.status).toBe('present')
    expect(board.summary).toMatchObject({ new: 0, present: 1, conflict: 1 })
  })

  it('falls back to the import manifest when no profile mounts the server', () => {
    const { dshHome, workbuddyRoot } = homes()
    writeFileSync(join(dshHome, 'migration', 'manifest.json'), JSON.stringify({
      mcp: [{
        id: 'mcp-1',
        name: 'rea',
        transport: 'stdio',
        command: 'node.exe',
        args: ['rea.mjs', 'mcp'],
        sourcePath: 'C:/Users/x/.workbuddy/mcp.json',
        skippedSecrets: ['rea.env'],
      }],
    }))
    const board = readExportMcp(dshHome, workbuddyRoot)
    expect(board.servers).toHaveLength(1)
    expect(board.servers[0]).toMatchObject({ serverName: 'rea', command: 'node.exe', secretKeys: ['env'] })
  })

  it('merges without touching an existing entry or its ordering', () => {
    const existing = `${JSON.stringify({ mcpServers: { rea: { command: 'node.exe' } }, other: 1 }, null, 2)}\n`
    const { content, added } = mergeMcpDocument(existing, [{
      id: 'x',
      serverName: 'goofish',
      transport: 'stdio',
      command: 'runner.exe',
      args: [],
      secretKeys: [],
      sourcePath: 'p',
      status: 'new',
    }])
    expect(added).toEqual(['goofish'])
    const parsed = JSON.parse(content) as Record<string, unknown>
    expect(parsed.other).toBe(1)
    expect((parsed.mcpServers as Record<string, unknown>).rea).toEqual({ command: 'node.exe' })
    expect((parsed.mcpServers as Record<string, unknown>).goofish).toEqual({ command: 'runner.exe' })
  })

  it('exports a secret-bearing server disabled so it cannot half-work', () => {
    const { content } = mergeMcpDocument(undefined, [{
      id: 'x',
      serverName: 'needs-token',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      args: [],
      secretKeys: ['Authorization'],
      sourcePath: 'p',
      status: 'new',
    }])
    const parsed = JSON.parse(content) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(parsed.mcpServers['needs-token']).toMatchObject({ url: 'https://example.test/mcp', disabled: true })
    expect(JSON.stringify(parsed)).not.toContain('Authorization')
  })

  it('skips a conflict instead of replacing the user entry', () => {
    const existing = `${JSON.stringify({ mcpServers: { rea: { command: 'mine' } } })}\n`
    const { added, content } = mergeMcpDocument(existing, [{
      id: 'x',
      serverName: 'rea',
      transport: 'stdio',
      command: 'theirs',
      args: [],
      secretKeys: [],
      sourcePath: 'p',
      status: 'conflict',
    }])
    expect(added).toEqual([])
    expect((JSON.parse(content) as { mcpServers: Record<string, unknown> }).mcpServers.rea).toEqual({ command: 'mine' })
  })

  it('refuses to rewrite an mcp.json that is not an object', () => {
    expect(() => mergeMcpDocument('[]', [])).toThrow(/mcp\.json/)
  })

  it('removes exactly the servers it added on undo', () => {
    const existing = `${JSON.stringify({ mcpServers: { rea: { command: 'node.exe' }, newone: { command: 'x' } } }, null, 2)}\n`
    const parsed = JSON.parse(removeMcpServers(existing, ['newone'])) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(parsed.mcpServers)).toEqual(['rea'])
  })
})

describe('automation export', () => {
  it('maps a daily rule onto an RRULE', () => {
    expect(toExportAutomation({ id: 's1', kind: 'daily', title: '每日巡检', prompt: '检查', time: '09:30:00', scheduledAt: '2027-01-01T01:30:00.000Z' }))
      .toMatchObject({ scheduleType: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30', status: 'new' })
  })

  it('renumbers ISO weekdays into RRULE day codes', () => {
    expect(toExportAutomation({ id: 's2', kind: 'weekly', title: '周报', prompt: '写', time: '18:00:00', weekdays: [1, 5] }))
      .toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=18;BYMINUTE=0' })
  })

  it('keeps a fractional second in BYSECOND', () => {
    expect(toExportAutomation({ id: 's3', kind: 'daily', title: 't', prompt: 'p', time: '00:00:30.5' })?.rrule)
      .toBe('FREQ=DAILY;BYHOUR=0;BYMINUTE=0;BYSECOND=30')
  })

  it('maps an absolute rule onto a one-shot automation', () => {
    expect(toExportAutomation({ id: 's4', kind: 'at', title: '一次', prompt: 'p', scheduledAt: '2027-02-03T04:05:06.000Z' }))
      .toMatchObject({ scheduleType: 'once', scheduledAt: '2027-02-03T04:05:06.000Z' })
  })

  it('passes an rrule record through verbatim', () => {
    expect(toExportAutomation({ id: 's5', kind: 'rrule', title: 't', prompt: 'p', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' }))
      .toMatchObject({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' })
  })

  it('refuses to mistranslate cron, interval and delay rules', () => {
    for (const kind of ['cron', 'every', 'after']) {
      expect(toExportAutomation({ id: 'x', kind, title: 't', prompt: 'p' })).toMatchObject({ status: 'unsupported' })
    }
  })

  it('reports an empty board rather than failing when no schedule service is mounted', () => {
    const board = readExportAutomations(undefined, [], '没有挂载')
    expect(board).toMatchObject({ available: false, detail: '没有挂载', summary: { total: 0, pending: 0 } })
    expect(board.automations).toEqual([])
  })

  it('marks an automation whose name already exists as present', () => {
    const board = readExportAutomations([
      { id: 'a', kind: 'daily', title: '每日巡检', prompt: 'p', time: '09:00:00' },
      { id: 'b', kind: 'cron', title: '奇怪的', prompt: 'p' },
    ], ['每日巡检'])
    expect(board.summary).toMatchObject({ total: 2, pending: 0, present: 1, unsupported: 1 })
  })

  it('builds a row WorkBuddy can insert', () => {
    const row = toAutomationRow({ id: 's', title: '每日巡检', prompt: '检查', scheduleType: 'recurring', rrule: 'FREQ=DAILY', status: 'new' }, 1_700_000_000_000)
    expect(row).toMatchObject({ name: '每日巡检', status: 'ACTIVE', rrule: 'FREQ=DAILY', createdAt: 1_700_000_000_000 })
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('export service boards', () => {
  function serviceAt(dshHome: string, workbuddyRoot: string, entries: readonly unknown[] = []): Promise<unknown> {
    return import('../src/export-service.js').then(({ ExportService }) => new ExportService(
      { list: async () => [], open: async () => { throw new Error('unused') } } as never,
      {
        dshHome,
        root: workbuddyRoot,
        activity: () => ({ running: false, observed: true, evidence: [], checkedAt: 'x' }),
        openDatabase: () => ({ close: () => undefined }) as never,
        schedule: { list: async () => ({ items: entries }) },
      },
    ))
  }

  it('reports all three boards in the preview', async () => {
    const { dshHome, workbuddyRoot } = homes()
    const service = await serviceAt(dshHome, workbuddyRoot, [
      { id: 'a', kind: 'daily', title: '每日巡检', prompt: 'p', time: '09:00:00' },
    ]) as { preview(): Promise<import('../src/model.js').ExportPreview> }
    const preview = await service.preview()
    expect(preview.memories).toMatchObject({ records: [], summary: { skipped: 0, pending: 0 } })
    expect(preview.mcp.servers).toEqual([])
    expect(preview.automations).toMatchObject({ available: true, summary: { pending: 1 } })
    expect(preview.summary.total).toBe(0)
  })

  it('reports the automations board as unavailable without a schedule service', async () => {
    const { dshHome, workbuddyRoot } = homes()
    const { ExportService } = await import('../src/export-service.js')
    const service = new ExportService(
      { list: async () => [], open: async () => { throw new Error('unused') } } as never,
      {
        dshHome,
        root: workbuddyRoot,
        activity: () => ({ running: false, observed: true, evidence: [], checkedAt: 'x' }),
        openDatabase: () => ({ close: () => undefined }) as never,
      },
    )
    const preview = await service.preview()
    expect(preview.automations.available).toBe(false)
    expect(preview.automations.detail).toContain('定时任务服务')
  })

  it('writes memories and mcp, then undoes both', async () => {
    const { dshHome, workbuddyRoot } = homes()
    const original = '# MEMORY.md\n\n- 我自己的笔记\n'
    writeFileSync(join(workbuddyRoot, 'MEMORY.md'), original)
    writeFileSync(join(workbuddyRoot, 'mcp.json'), `${JSON.stringify({ mcpServers: {} })}\n`)
    writeFileSync(join(dshHome, 'migration', 'memory', 'records.jsonl'), `${JSON.stringify({ id: 'm1', content: '把导出目录固定在 D 盘' })}\n`)
    writeFileSync(join(dshHome, 'migration', 'manifest.json'), JSON.stringify({
      mcp: [{ id: 'k1', name: 'rea', transport: 'stdio', command: 'node.exe', args: ['rea.mjs', 'mcp'], skippedSecrets: ['rea.env'] }],
    }))
    const service = await serviceAt(dshHome, workbuddyRoot) as {
      run(input: Record<string, unknown>): Promise<import('../src/model.js').ExportResult>
      undo(): Promise<{ undone: boolean }>
    }

    const result = await service.run({ exitConfirmed: true, memoryIds: ['m1'], mcpIds: ['k1'] })
    expect(result.memories.written).toBe(1)
    expect(result.mcp.written).toBe(1)
    expect(result.mcp.secretKeys).toEqual(['rea.env'])
    const written = readFileSync(join(workbuddyRoot, 'MEMORY.md'), 'utf8')
    expect(written).toContain('- 把导出目录固定在 D 盘')
    expect(written).toContain('- 我自己的笔记')
    const mcp = JSON.parse(readFileSync(join(workbuddyRoot, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(mcp.mcpServers.rea).toMatchObject({ command: 'node.exe', disabled: true })

    expect((await service.undo()).undone).toBe(true)
    expect(readFileSync(join(workbuddyRoot, 'MEMORY.md'), 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(join(workbuddyRoot, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: {} })
  })

  it('inserts automation rows and removes them on undo', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { dshHome, workbuddyRoot } = homes()
    const db = new DatabaseSync(join(workbuddyRoot, 'workbuddy.db'))
    db.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL, schedule_type TEXT NOT NULL DEFAULT 'recurring', rrule TEXT NOT NULL DEFAULT '',
      scheduled_at TEXT, cwds TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      deleted_at INTEGER)`)
    db.close()

    const service = await serviceAt(dshHome, workbuddyRoot, [
      { id: 's1', kind: 'daily', title: '每日巡检', prompt: '检查磁盘', time: '09:30:00' },
      { id: 's2', kind: 'cron', title: '无法转换', prompt: 'p' },
    ]) as {
      preview(): Promise<import('../src/model.js').ExportPreview>
      run(input: Record<string, unknown>): Promise<import('../src/model.js').ExportResult>
      undo(): Promise<{ undone: boolean }>
    }
    const preview = await service.preview()
    const target = preview.automations.automations.find(item => item.status === 'new')!
    const result = await service.run({ exitConfirmed: true, automationIds: [target.id] })
    expect(result.automations.written).toBe(1)
    expect(result.automations.unsupported).toBe(1)
    const check = new DatabaseSync(join(workbuddyRoot, 'workbuddy.db'))
    expect(check.prepare('SELECT name, rrule, status FROM automations').all()).toEqual([
      { name: '每日巡检', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30', status: 'ACTIVE' },
    ])
    check.close()
    expect((await service.undo()).undone).toBe(true)
    const after = new DatabaseSync(join(workbuddyRoot, 'workbuddy.db'))
    expect(after.prepare('SELECT COUNT(*) AS n FROM automations').get()).toEqual({ n: 0 })
    after.close()
  })
})
