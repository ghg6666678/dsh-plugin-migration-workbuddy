import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether WorkBuddy is still running.
 *
 * Writing into `~/.workbuddy` while the app is live is not a transient risk: it
 * keeps the SQLite catalog in WAL mode with its own connection and keeps
 * rewriting the transcript it is streaming, so an outside append can be
 * truncated by the next flush or leave `workbuddy.db` half-written. Every
 * mutating export therefore refuses to start until the app is gone.
 *
 * The check has to work from inside a sandboxed plugin process, where process
 * listing is blocked. WorkBuddy (an Electron app) creates well-known named
 * pipes in `\\.\pipe\` and those stay readable from any local process, so
 * enumerating them is the primary evidence. It also keeps working while the app
 * sits minimized in the tray — the case that matters most, because the user
 * believes it is closed.
 */

/** Named pipes WorkBuddy and its helpers create while alive. */
const PIPE_PATTERN = /workbuddy|codebuddy/i

export interface WorkBuddyActivity {
  /** True when evidence of a live instance was found. */
  running: boolean
  /** False when the probe itself could not run, so `running` proves nothing. */
  observed: boolean
  /** Human-readable evidence lines. */
  evidence: string[]
  /** Wall-clock time of the check. */
  checkedAt: string
}

/** Default WorkBuddy data directory; `WORKBUDDY_HOME` overrides it (tests). */
export function workBuddyRoot(): string {
  const override = process.env.WORKBUDDY_HOME
  return override !== undefined && override.trim() !== '' ? override : join(homedir(), '.workbuddy')
}

/**
 * Enumerate the named pipes WorkBuddy owns.
 *
 * `readdirSync` on the pipe namespace is an ordinary directory listing as far
 * as the OS is concerned, so it needs no process privileges and no WMI access.
 */
export function workBuddyPipes(): { names: string[]; error?: string } {
  try {
    const names = readdirSync('\\\\.\\pipe\\')
    return { names: names.filter(name => PIPE_PATTERN.test(name)) }
  } catch (cause) {
    return { names: [], error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Evidence that WorkBuddy is live, plus whether the probe actually ran. */
export function detectWorkBuddy(): WorkBuddyActivity {
  const pipes = workBuddyPipes()
  const evidence = pipes.names.map(name => `named pipe: ${name}`)
  if (pipes.error !== undefined) evidence.push(`无法枚举命名管道: ${pipes.error}`)
  return {
    running: pipes.names.length > 0,
    observed: pipes.error === undefined,
    evidence,
    checkedAt: new Date().toISOString(),
  }
}
