import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { MemoryPreview, MemoryRecord } from './model.js'

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function clean(value: string): string {
  return value.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/\s+/g, ' ').trim()
}

/**
 * True for the scaffolding that surrounds real notes in WorkBuddy's markdown:
 * YAML front matter fences, `title: "..."` metadata, HTML comment markers such
 * as `<!-- RAW_JSON_START`, brace-only JSON wrappers, and the `> Last updated:`
 * quote lines the app rewrites on every launch.
 */
export function isMemoryScaffolding(value: string): boolean {
  const text = value.trim()
  if (text === '') return true
  if (text === '---' || text === '}' || text === '{') return true
  if (/^(?:<!--|-->|RAW_JSON_(?:START|END))/.test(text)) return true
  if (/^>/.test(text)) return true
  if (/^[\w.-]+\s*:\s*(".*"|'.*'|[|>[]?)\s*$/.test(text)) return true
  if (/^"[^"]*"\s*:/.test(text)) return true
  if (!/[\p{L}\p{N}]/u.test(text)) return true
  const meaningful = text.replace(/[^\p{L}\p{N}]/gu, '')
  if (meaningful.length < 2) return true
  if (/^_(?:[^_]*)_$/.test(text) && meaningful.length < 6) return true
  return false
}

/**
 * Collect the note lines of a WorkBuddy markdown memory file. When the file has
 * a `## Memory Block` section only that section is read, because the rest of the
 * per-account profile is machine-written scaffolding.
 */
function markdownMemoryLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/)
  const blockStart = lines.findIndex(line => /^\s*#{1,6}\s+Memory Block\b/i.test(line))
  const scoped = blockStart === -1 ? lines : lines.slice(blockStart + 1)
  const values: string[] = []
  for (const line of scoped) {
    // Any heading closes the memory block and opens a new, non-memory section.
    if (/^\s*#+\s+/.test(line)) {
      if (blockStart !== -1) break
      continue
    }
    const value = clean(line.replace(/^#+\s*/, ''))
    if (value && !value.endsWith(':') && !isMemoryScaffolding(value)) values.push(value)
  }
  return values
}

/** Parse unstable WorkBuddy memory candidates into reviewable atomic records. */
export async function parseMemoryCandidate(path: string, kind: MemoryPreview['kind']): Promise<MemoryPreview> {
  const raw = await readFile(path, 'utf8')
  const sourceHash = hash(raw)
  const values: string[] = []
  if (kind === 'markdown' || kind === 'unknown') {
    values.push(...markdownMemoryLines(raw))
  } else {
    try {
      const parsed: unknown = kind === 'jsonl'
        ? raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        : JSON.parse(raw)
      const visit = (value: unknown): void => {
        if (typeof value === 'string') { const item = clean(value); if (item && !isMemoryScaffolding(item)) values.push(item); return }
        if (Array.isArray(value)) { value.forEach(visit); return }
        if (typeof value === 'object' && value !== null) {
          const row = value as Record<string, unknown>
          for (const key of ['content', 'text', 'memory', 'fact', 'value', 'summary']) if (row[key] !== undefined) visit(row[key])
        }
      }
      visit(parsed)
    } catch (cause) {
      return { sourcePath: path, sourceHash, kind, records: [], skipped: 1, loss: [{ code: 'memory-parse', detail: cause instanceof Error ? cause.message : String(cause) }] }
    }
  }
  const unique = [...new Map(values.map(value => [value.toLocaleLowerCase(), value])).values()]
  return {
    sourcePath: path,
    sourceHash,
    kind,
    records: unique.map(content => ({ id: hash(`${sourceHash}:${content}`).slice(0, 24), content })),
    skipped: Math.max(0, values.length - unique.length),
    loss: [],
  }
}

export function toMemoryRecords(previews: readonly MemoryPreview[], existing: readonly MemoryRecord[] = []): { records: MemoryRecord[]; skipped: number } {
  const seen = new Set(existing.map(record => record.content.toLocaleLowerCase()))
  const records: MemoryRecord[] = []
  let skipped = 0
  for (const preview of previews) for (const candidate of preview.records) {
    const key = candidate.content.toLocaleLowerCase()
    if (seen.has(key)) { skipped += 1; continue }
    seen.add(key)
    records.push({ id: candidate.id, content: candidate.content, sourcePath: preview.sourcePath, sourceHash: preview.sourceHash, enabled: true, createdAt: new Date().toISOString() })
  }
  return { records, skipped }
}

/**
 * Drop records an earlier release imported from memory scaffolding. Builds
 * before the parser understood `RAW_JSON` blocks stored up to thirty rows that
 * were nothing but `{`, `---` and `"uid": "…"`. Keeping them would leave the
 * export board permanently full of noise, so they are pruned on the next
 * memory import.
 */
export function pruneScaffoldingRecords(existing: readonly MemoryRecord[]): { kept: MemoryRecord[]; removed: number } {
  const kept = existing.filter(record => !isMemoryScaffolding(record.content))
  return { kept, removed: existing.length - kept.length }
}
