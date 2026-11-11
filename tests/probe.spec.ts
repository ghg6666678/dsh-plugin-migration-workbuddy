import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { displayPath, probeWorkBuddy, summarizeProbe } from '../src/probe.js'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mwb-workbuddy-'))
  await mkdir(join(root, 'projects', 'project-a'), { recursive: true })
  await mkdir(join(root, 'memory'), { recursive: true })
  await writeFile(join(root, 'projects', 'project-a', 'session-1.jsonl'), [
    JSON.stringify({ type: 'message', version: 2, role: 'user', content: 'hello' }),
    JSON.stringify({ type: 'reasoning', content: 'private' }),
    JSON.stringify({ type: 'function_call', name: 'read_file' }),
    JSON.stringify({ type: 'function_call_result', name: 'read_file' }),
    JSON.stringify({ type: 'future_event' }),
    '{bad json',
  ].join('\n'))
  await writeFile(join(root, 'memory', 'user_memory.md'), '# memory\n- prefers Chinese\n')
  await writeFile(join(root, 'workbuddy.db'), 'SQLite format 3\u0000fixture')
  return root
}

describe('WorkBuddy P0 probe', () => {
  it('scans JSONL, memory candidates and legacy database without writing targets', async () => {
    const root = await fixture()
    const report = await probeWorkBuddy({ root })
    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]?.validLines).toBe(5)
    expect(report.sessions[0]?.invalidLines).toBe(1)
    expect(report.sessions[0]?.eventCounts.future_event).toBe(1)
    expect(report.memoryCandidates[0]?.kind).toBe('markdown')
    expect(report.memoryPaths).toEqual([join(root, 'memory')])
    expect(report.legacyDatabase?.sqliteHeader).toBe(true)
    expect(summarizeProbe(report)).toEqual({ projectCount: 1, sessionCount: 1, memoryCount: 1, warningCount: 3 })
  })

  it('returns a warning and no files for a missing root', async () => {
    const report = await probeWorkBuddy({ root: join(tmpdir(), 'does-not-exist-mwb') })
    expect(report.sessions).toEqual([])
    expect(report.warnings[0]?.code).toBe('missing-root')
  })

  it('scans the root MEMORY.md alongside the memory directory', async () => {
    // The curated notes live at <root>/MEMORY.md; `memory/` only holds the
    // per-account scaffolding. Missing the root file made import report a
    // handful of JSON-brace "memories" and never see the real ones.
    const root = await fixture()
    await writeFile(join(root, 'MEMORY.md'), '# MEMORY.md\n\n## 经验\n\n- 真实笔记\n')
    const report = await probeWorkBuddy({ root })
    const scanned = report.memoryCandidates.map(candidate => candidate.path)
    expect(scanned).toContain(join(root, 'MEMORY.md'))
    expect(summarizeProbe(report).memoryCount).toBe(2)
  })

  it('does not treat persona templates as memory candidates', async () => {
    const root = await fixture()
    for (const name of ['USER.md', 'IDENTITY.md', 'SOUL.md', 'BOOTSTRAP.md']) {
      await writeFile(join(root, name), `# ${name}\n\n- 尚未告知\n`)
    }
    const report = await probeWorkBuddy({ root })
    const scanned = report.memoryCandidates.map(candidate => candidate.path)
    expect(scanned).not.toContain(join(root, 'USER.md'))
    expect(summarizeProbe(report).memoryCount).toBe(1)
  })

  it('redacts a home prefix for preview display', () => {
    expect(displayPath('/Users/alice/.workbuddy/projects', '/Users/alice')).toBe('~/.workbuddy/projects')
    expect(displayPath('/var/tmp/workbuddy', '/Users/alice')).toBe('/var/tmp/workbuddy')
    // A POSIX-recorded source previewed on Windows must keep POSIX separators
    // and still collapse to the familiar ~ form even though homedir() is a
    // Windows path there.
    expect(displayPath('/Users/alice/.workbuddy/projects', 'C:\\Users\\alice')).toBe('~/.workbuddy/projects')
    // The reverse: a Windows-recorded source with a POSIX home.
    expect(displayPath('C:\\Users\\alice\\.workbuddy\\projects', '/Users/alice')).toBe('~\\.workbuddy\\projects')
    // Windows source on a Windows home stays native.
    expect(displayPath('C:\\Users\\alice\\.workbuddy\\projects', 'C:\\Users\\alice')).toBe('~\\.workbuddy\\projects')
    // Only a whole segment counts as the home directory.
    expect(displayPath('/data/alice-notes/x', 'C:\\Users\\alice')).toBe('/data/alice-notes/x')
    expect(displayPath('/var/alice/work', 'C:\\Users\\alice')).toBe('~/work')
  })
})
