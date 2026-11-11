import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkBuddyCatalog, readWorkBuddySessionMetadata } from '../src/workbuddy-db.js'

describe('WorkBuddy catalog metadata', () => {
  it('reads title precedence and playground mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-workbuddy-db-'))
    await mkdir(root, { recursive: true })
    const db = new DatabaseSync(join(root, 'workbuddy.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, is_playground INTEGER)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('a', '/workspace/a', 'generated', 'custom', 0)
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('b', '/workbuddy/b', 'playground', null, 1)
    db.close()
    const metadata = readWorkBuddySessionMetadata(root)
    expect(metadata.get('a')).toMatchObject({ title: 'custom', mode: 'workspace', cwd: '/workspace/a' })
    expect(metadata.get('b')).toMatchObject({ title: 'playground', mode: 'session' })
  })

  it('degrades to an empty catalog for a missing or malformed database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-workbuddy-db-empty-'))
    expect(readWorkBuddySessionMetadata(root)).toEqual(new Map())
    expect(readWorkBuddyCatalog(root)).toEqual({ sessions: new Map(), deletedSessionIds: new Set(), liveWorkspacePaths: new Set(), available: false, unavailableReason: 'missing' })
  })

  it('reports an unreadable database instead of pretending nothing is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-workbuddy-db-broken-'))
    await writeFile(join(root, 'workbuddy.db'), 'not a sqlite database')
    const catalog = readWorkBuddyCatalog(root)
    expect(catalog.available).toBe(false)
    expect(catalog.unavailableReason).toBe('unreadable')
  })

  it('excludes sessions the user deleted in WorkBuddy and keeps the live workspace list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mwb-workbuddy-db-deleted-'))
    await mkdir(root, { recursive: true })
    const db = new DatabaseSync(join(root, 'workbuddy.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, is_playground INTEGER, deleted_at INTEGER)')
    db.exec('CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('live', '/workspace/live', 't', null, 0, null)
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('gone', '/workspace/gone', 't', null, 0, 1735689600000)
    db.prepare('INSERT INTO workspaces VALUES (?, ?)').run('/workspace/live', 1)
    db.close()

    const catalog = readWorkBuddyCatalog(root)
    expect(catalog.available).toBe(true)
    expect([...catalog.sessions.keys()]).toEqual(['live'])
    expect([...catalog.deletedSessionIds]).toEqual(['gone'])
    expect([...catalog.liveWorkspacePaths]).toEqual(['/workspace/live'])
  })
})
