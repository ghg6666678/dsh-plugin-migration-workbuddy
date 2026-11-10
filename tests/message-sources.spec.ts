import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { convertWorkBuddySession, normalizeMessageSources } from '../src/converter.js'

type AnyEvent = { type: string; data: Record<string, unknown> }

function fake(type: string, data: Record<string, unknown>): AnyEvent {
  return { type, data }
}

function messageOf(item: AnyEvent): Record<string, unknown> {
  return item.type === 'user/message' ? item.data : item.data.message as Record<string, unknown>
}

function assertAdmissible(events: AnyEvent[]): void {
  const durable = events.filter(item => ['user/message', 'assistant/message', 'tool/result'].includes(item.type))
  expect(durable.length).toBeGreaterThan(0)
  for (const item of durable) {
    const source = messageOf(item).source as Record<string, unknown> | undefined
    expect(source, item.type).toBeTruthy()
    expect(typeof source?.kind, item.type).toBe('string')
    expect(String(source?.kind ?? '').length, item.type).toBeGreaterThan(0)
  }
}

/** normalizeMessageSources replaces array entries, so the caller's array is updated. */
function normalize(events: AnyEvent[]): void {
  normalizeMessageSources(events as unknown as SessionEvent[])
}

describe('normalizeMessageSources', () => {
  it('adds a producer-owned kind to assistant/tool messages with V3 sources', () => {
    const events = [
      fake('assistant/message', { message: { source: { provider: 'workbuddy', model: 'imported' } } }),
      fake('tool/result', { message: { callId: 'c1' } }),
      fake('user/message', { source: { kind: '' } }),
    ]
    normalize(events)
    assertAdmissible(events)
    const assistant = messageOf(events[0]!).source as Record<string, unknown>
    expect(assistant.provider).toBe('workbuddy')
    expect(assistant.kind).toBe('workbuddy-migration')
    expect((messageOf(events[2]!).source as Record<string, unknown>).kind).toBe('workbuddy-migration')
  })

  it('preserves an already valid kind and leaves unrelated events untouched', () => {
    const events = [
      fake('user/message', { source: { kind: 'user' } }),
      fake('turn/start', { turn: 1 }),
    ]
    normalize(events)
    expect(messageOf(events[0]!).source).toEqual({ kind: 'user' })
    expect(events[1]!.data).toEqual({ turn: 1 })
  })
})

describe('converter output under session format v4', () => {
  it('emits admissible sources for user, assistant, context and tool messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-sources-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: '<system-reminder>context</system-reminder>hello', timestamp: 1000, cwd: root }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'hi', timestamp: 2000 }),
      JSON.stringify({ type: 'reasoning', rawContent: 'think', timestamp: 3000 }),
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: {}, timestamp: 4000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'ok', status: 'success', timestamp: 5000 }),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root)
    assertAdmissible(converted.events as unknown as AnyEvent[])
  })
})
