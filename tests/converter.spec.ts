import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { convertWorkBuddySession } from '../src/converter.js'

describe('WorkBuddy converter', () => {
  it('keeps message order, reasoning and tool events in a contiguous DSH log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'hello', timestamp: 1000, cwd: root }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'hi', timestamp: 2000 }),
      JSON.stringify({ type: 'reasoning', rawContent: 'think', timestamp: 3000 }),
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: { path: 'a' }, timestamp: 4000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'ok', status: 'success', timestamp: 5000 }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Demo' }),
      JSON.stringify({ type: 'file-history-snapshot' }),
    ].join('\n'))
    const converted = await convertWorkBuddySession(path, root)
    expect(converted.title).toBe('Demo')
    expect(converted.events.map(event => (event as { type: string }).type)).toContain('tool/call')
    expect(converted.events.map(event => (event as { type: string }).type)).toContain('tool/result')
    expect(converted.events.every((event, index) => Number((event as { seq: number }).seq) === index)).toBe(true)
    expect(converted.events.filter(event => (event as { type: string }).type === 'turn/start').every(event => Number((event as { data: { turn: number } }).data.turn) >= 1)).toBe(true)
    expect(converted.events.filter(event => (event as { type: string }).type === 'step/start').every(event => Number((event as { data: { step: number } }).data.step) >= 1)).toBe(true)
    expect(converted.events.filter(event => ['user/message', 'assistant/message', 'tool/result'].includes((event as { type?: string }).type ?? '')).every(event => (event as { surfaceOp?: string }).surfaceOp === 'append')).toBe(true)
    expect(converted.loss.map(item => item.code)).toContain('file-history')
  })

  it('projects tool calls and results as a provider-valid paired transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-tools-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: { path: 'a' }, timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'ok', status: 'success', timestamp: 1100 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'continue', timestamp: 1200 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-tool-pair'), converted.events as never[])
    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['assistant', 'user', 'user'])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-call', id: 'c1', name: 'read' })
    expect(messages[1]?.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'c1' })
    expect(messages[2]?.content[0]).toMatchObject({ type: 'text', text: 'continue' })
  })

  it('synthesizes a call for orphan results and a result for dangling calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-tool-repair-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call_result', callId: 'orphan', name: 'lookup', output: 'missing call', timestamp: 1000 }),
      JSON.stringify({ type: 'function_call', callId: 'dangling', name: 'write', arguments: '{}', timestamp: 1100 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-tool-repair'), converted.events as never[])
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls.map(block => block.type === 'tool-call' ? block.id : '')).toEqual(['orphan', 'dangling'])
    expect(results.map(block => block.type === 'tool-result' ? block.toolCallId : '')).toEqual(['orphan', 'dangling'])
    expect(converted.loss.map(item => item.code)).toEqual(expect.arrayContaining(['orphan-tool-result', 'unpaired-tool-call']))
  })

  it('keeps the authoritative workspace cwd from WorkBuddy records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-cwd-'))
    const project = 'Users-example-Workspace-Projects-acme-dashboard'
    await mkdir(join(root, 'projects', project), { recursive: true })
    const path = join(root, 'projects', project, 's.jsonl')
    const cwd = '/Users/example/Workspace/Projects/acme-dashboard'
    await writeFile(path, JSON.stringify({ type: 'message', role: 'user', content: 'hello', cwd, timestamp: 1000 }))
    const converted = await convertWorkBuddySession(path, root)
    expect(converted.cwd).toBe(cwd)
  })

  it('renders WorkBuddy context as a collapsible snapshot and keeps the query clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-context-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, JSON.stringify({
      type: 'message', role: 'user', timestamp: 1000,
      content: '<system-reminder data-role="user-context"><user_info>OS Version: darwin</user_info><user_query>你好</user_query></system-reminder>',
    }))
    const converted = await convertWorkBuddySession(path, root)
    const messages = converted.events.filter(event => (event as { type?: string }).type === 'user/message') as Array<{ data: { content: Array<{ text?: string }>; source: Record<string, unknown> } }>
    expect(messages).toHaveLength(2)
    expect(messages[0]?.data.source).toMatchObject({ kind: 'plugin', plugin: 'WorkBuddy 上下文', form: 'snapshot' })
    expect(messages[1]?.data.content[0]?.text).toBe('你好')
    expect(messages[1]?.data.content[0]?.text).not.toContain('system-reminder')
  })

  it('uses catalog metadata for the title, mode and canonical cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-metadata-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 'session.jsonl')
    await writeFile(path, JSON.stringify({ type: 'message', role: 'user', content: 'hello', cwd: '/wrong', timestamp: 1000 }))
    const converted = await convertWorkBuddySession(path, root, {
      sourceSessionId: 'session', mode: 'session', cwd: '/target/session-mode', title: '正式标题',
    })
    expect(converted.title).toBe('正式标题')
    expect(converted.mode).toBe('session')
    expect(converted.cwd).toBe('/target/session-mode')
    expect(converted.events[0]).toMatchObject({ type: 'session/title', data: { title: '正式标题', messageSeqs: [], source: { kind: 'user' } } })
    expect(converted.events.map(event => Number((event as { seq: number }).seq))).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('emits one tool output per call id when WorkBuddy repeats a result row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-dup-result-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'read', arguments: { path: 'a' }, timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'first', status: 'success', timestamp: 1100 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'retried', status: 'success', timestamp: 1200 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'continue', timestamp: 1300 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-dup-result'), converted.events as never[])
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls.map(block => (block.type === 'tool-call' ? block.id : ''))).toEqual(['c1'])
    expect(results.map(block => (block.type === 'tool-result' ? block.toolCallId : ''))).toEqual(['c1'])
    expect(converted.loss.map(item => item.code)).toContain('duplicate-tool-result')
  })

  it('flattens tool calls and results into plain text in narrative mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-narrative-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call', callId: 'c1', name: 'Read', arguments: { file_path: 'a.md' }, timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'c1', output: 'file contents', status: 'success', timestamp: 1100 }),
      JSON.stringify({ type: 'message', role: 'user', content: 'continue', timestamp: 1200 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root, undefined, { toolMode: 'narrative' })
    const session = Session.create(SessionId('workbuddy-narrative'), converted.events as never[])
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls).toHaveLength(0)
    expect(results).toHaveLength(0)
    const texts = messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : ''))
    expect(texts.join('\n')).toContain('【工具调用 Read】')
    expect(texts.join('\n')).toContain('【工具结果】file contents')
    expect(converted.loss.map(item => item.code)).toEqual(expect.arrayContaining(['tool-flattened', 'tool-result-flattened']))
  })

  it('deduplicates orphan pairing and repeated call rows for the same call id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-dup-call-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'function_call_result', callId: 'orphan', name: 'lookup', output: 'a', timestamp: 1000 }),
      JSON.stringify({ type: 'function_call_result', callId: 'orphan', name: 'lookup', output: 'b', timestamp: 1100 }),
      JSON.stringify({ type: 'function_call', callId: 'twice', name: 'write', arguments: '{}', timestamp: 1200 }),
      JSON.stringify({ type: 'function_call', callId: 'twice', name: 'write', arguments: '{}', timestamp: 1300 }),
      JSON.stringify({ type: 'function_call_result', callId: 'twice', output: 'ok', timestamp: 1400 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const session = Session.create(SessionId('workbuddy-dup-call'), converted.events as never[])
    const messages = session.deriveMessages()
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    expect(calls.map(block => (block.type === 'tool-call' ? block.id : ''))).toEqual(['orphan', 'twice'])
    expect(results.map(block => (block.type === 'tool-result' ? block.toolCallId : ''))).toEqual(['orphan', 'twice'])
    expect(converted.loss.map(item => item.code)).toEqual(expect.arrayContaining(['duplicate-tool-result', 'duplicate-tool-call']))
  })

  it('settles assistant messages with an explicit stream member for current persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-converter-settlement-'))
    await mkdir(join(root, 'projects', 'p'), { recursive: true })
    const path = join(root, 'projects', 'p', 's.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', role: 'user', content: 'hi', timestamp: 1000 }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'hello', timestamp: 1100 }),
    ].join('\n'))

    const converted = await convertWorkBuddySession(path, root)
    const assistant = (converted.events as Array<{ type?: string; data?: { stream?: unknown } }>)
      .filter(event => event.type === 'assistant/message')
    expect(assistant.length).toBeGreaterThan(0)
    for (const item of assistant) {
      expect(Array.isArray(item.data?.stream)).toBe(true)
    }
  })
})
