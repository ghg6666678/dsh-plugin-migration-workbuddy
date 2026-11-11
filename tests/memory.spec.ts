import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMemoryScaffolding, parseMemoryCandidate, pruneScaffoldingRecords, toMemoryRecords } from '../src/memory.js'

describe('memory migration', () => {
  it('parses markdown bullets and deduplicates records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-memory-'))
    const path = join(root, 'user_memory.md')
    await writeFile(path, '# facts\n- prefers Chinese\n- prefers Chinese\n- likes concise answers\n')
    const preview = await parseMemoryCandidate(path, 'markdown')
    expect(preview.records).toHaveLength(2)
    expect(toMemoryRecords([preview]).records).toHaveLength(2)
  })

  it('keeps real notes from the curated root MEMORY.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-memory-'))
    const path = join(root, 'MEMORY.md')
    await writeFile(path, [
      '# MEMORY.md',
      '',
      '## 本机环境',
      '',
      '- MCP 配置在 `.workbuddy/mcp.json`。',
      '- 连接器信任记录与路径绑定。',
      '',
      '## 经验',
      '',
      '- 托管的子进程缺少 PATHEXT 会报错。',
      '',
    ].join('\n'))
    const preview = await parseMemoryCandidate(path, 'markdown')
    expect(preview.records.map(record => record.content)).toEqual([
      'MCP 配置在 `.workbuddy/mcp.json`。',
      '连接器信任记录与路径绑定。',
      '托管的子进程缺少 PATHEXT 会报错。',
    ])
  })

  it('yields nothing for the per-account profile scaffolding', async () => {
    // Exactly the shape WorkBuddy writes to ~/.workbuddy/memory/<uid>_memory.md:
    // an empty Memory Block plus a RAW_JSON trailer. It used to import as ten
    // "memories" that were JSON braces, which is why the export board then
    // looked empty.
    const root = await mkdtemp(join(tmpdir(), 'mwb-memory-'))
    const path = join(root, 'uid_memory.md')
    await writeFile(path, [
      '# User Memory Profile',
      '> Last updated: 2026-11-11T15:38:18.430Z',
      '> Version: 0',
      '',
      '## Memory Block',
      '',
      '',
      '',
      '---',
      '',
      '<!-- RAW_JSON_START',
      '{',
      '  "uid": "f56cbccd-84f1-4a5d-a90d-6169a354bf7f",',
      '  "memoryBlock": "",',
      '  "updatedAt": "2026-11-11T15:38:18.430Z"',
      '}',
      'RAW_JSON_END -->',
      '',
    ].join('\n'))
    const preview = await parseMemoryCandidate(path, 'markdown')
    expect(preview.records).toEqual([])
  })

  it('only reads the Memory Block section when one is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-memory-'))
    const path = join(root, 'uid_memory.md')
    await writeFile(path, [
      '# User Memory Profile',
      '> Version: 0',
      '',
      '## Memory Block',
      '',
      '- 喜欢简洁的回答',
      '',
      '## Something Else',
      '',
      '- 这一段不属于记忆块',
    ].join('\n'))
    const preview = await parseMemoryCandidate(path, 'markdown')
    expect(preview.records.map(record => record.content)).toEqual(['喜欢简洁的回答'])
  })

  it('drops metadata and markup-only lines but keeps prose', () => {
    for (const value of ['---', '> Version: 0', '<!-- RAW_JSON_START', 'RAW_JSON_END -->', '{', '}', '"memoryBlock": "",', 'title: "SOUL.md Template"', '**', '``', '-']) {
      expect(isMemoryScaffolding(value), value).toBe(true)
    }
    for (const value of ['MCP 配置在 .workbuddy/mcp.json。', '**托管的进程缺 PATHEXT** 会报错。', '回滚用 `git revert`。']) {
      expect(isMemoryScaffolding(value), value).toBe(false)
    }
  })

  it('prunes scaffolding rows an older release already stored', () => {
    const record = (id: string, content: string) => ({ id, content, sourcePath: 'p', sourceHash: 'h', enabled: true, createdAt: '2026-11-10T00:00:00.000Z' })
    const existing = [
      record('a', '> Last updated: 2026-11-10T17:35:01.983Z'),
      record('b', '---'),
      record('c', '"uid": "f56cbccd-84f1-4a5d-a90d-6169a354bf7f",'),
      record('d', '"memoryBlock": "",'),
      record('e', 'MCP 配置在 .workbuddy/mcp.json。'),
    ]
    const pruned = pruneScaffoldingRecords(existing)
    expect(pruned.removed).toBe(4)
    expect(pruned.kept.map(item => item.content)).toEqual(['MCP 配置在 .workbuddy/mcp.json。'])
  })
})
