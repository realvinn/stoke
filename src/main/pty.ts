import { randomUUID } from 'node:crypto'
import * as nodePty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import type { LaunchOptions } from '@shared/types'
import { buildArgs, buildEnvPath, findClaude, spawnSpec } from './cli.ts'

export interface StartResult {
  ptyId: string
  sessionId: string
  command: string
  args: string[]
}

interface Session {
  ptyId: string
  sessionId: string
  proc: IPty
  cwd: string
  exited: boolean
  /** Retained output so a client joining late can replay the session. */
  chunks: string[]
  length: number
  startedAt: number
  cols: number
  rows: number
}

/** Summary of a live session, used by the remote UI's session list. */
export interface SessionInfo {
  ptyId: string
  sessionId: string
  cwd: string
  exited: boolean
  startedAt: number
  cols: number
  rows: number
}

/**
 * Retained output per session. The desktop renderer keeps its own copy, but the
 * remote client needs one held in the main process — a phone attaching to a
 * session that started an hour ago has no other way to see what happened.
 */
const MAX_HISTORY = 512 * 1024

/**
 * Environment variables that must never reach the spawned CLI.
 *
 * The Electron entries stop Node from re-launching itself as Electron.
 *
 * The CLAUDE_* entries matter more than they look: if Stoke is itself started
 * from inside a Claude Code session, those markers are inherited, and the
 * session we spawn is treated as a *nested child*. Claude then disables
 * transcript saving entirely ("Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker"), which silently breaks both session resume
 * and Stoke's own context meter, since both read the transcript.
 *
 * Only session/runtime markers are stripped. Configuration and credentials
 * (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, proxy settings, ...) are passed
 * through untouched.
 */
const STRIP_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'GDK_BACKEND',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID'
]

export class PtyManager {
  private sessions = new Map<string, Session>()
  private readonly onData: (ptyId: string, data: string) => void
  private readonly onExit: (ptyId: string, code: number, signal?: number) => void

  // Explicit fields rather than TS parameter properties, matching ContextWatcher
  // so the main-process modules stay runnable under node's type stripping.
  constructor(
    onData: (ptyId: string, data: string) => void,
    onExit: (ptyId: string, code: number, signal?: number) => void
  ) {
    this.onData = onData
    this.onExit = onExit
  }

  async start(
    opts: LaunchOptions,
    claudePathOverride: string | null,
    mcpConfigPath?: string | null
  ): Promise<StartResult> {
    const exe = await findClaude(claudePathOverride)
    if (!exe) {
      throw new Error(
        'Could not find the `claude` executable. Install Claude Code, or set an explicit path in Settings.'
      )
    }

    // For brand-new sessions we mint the id ourselves and pass --session-id, so
    // the transcript path is known before the process even starts. That is what
    // lets the context meter attach immediately.
    const sessionId =
      opts.resume || opts.continueLast ? (opts.sessionId ?? '') : (opts.sessionId ?? randomUUID())

    const args = buildArgs({ ...opts, sessionId })

    // Hand the session Stoke's own browser tools. A file path rather than an
    // inline JSON string: quoting JSON through a shell differs per platform and
    // fails silently when it goes wrong.
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath)

    // Ultracode needs nothing here: buildArgs has already turned it into
    // `--settings <file>`. Do not be tempted to write `/effort ultracode` into
    // the pty after start instead — a write races the TUI's warmup, so the text
    // lands in the prompt buffer as often as it is interpreted, and from out here
    // the two outcomes are indistinguishable. That is the same hazard the voice
    // work hit. The settings key exists so the choice can be made before the
    // process starts, which is the only moment that is reliable.

    const spec = spawnSpec(exe, args)

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (STRIP_ENV.includes(k)) continue
      env[k] = v
    }
    env.PATH = await buildEnvPath()
    if (process.platform !== 'win32') env.Path = env.PATH
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // Tell Claude Code it is inside a wrapper, in case that ever matters to it.
    env.TERM_PROGRAM = 'Stoke'

    const proc = nodePty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(20, opts.cols || 120),
      rows: Math.max(5, opts.rows || 30),
      cwd: opts.cwd,
      env,
      useConpty: process.platform === 'win32' ? true : undefined
    })

    const ptyId = randomUUID()
    const session: Session = {
      ptyId,
      sessionId,
      proc,
      cwd: opts.cwd,
      exited: false,
      chunks: [],
      length: 0,
      startedAt: Date.now(),
      cols: Math.max(20, opts.cols || 120),
      rows: Math.max(5, opts.rows || 30)
    }
    this.sessions.set(ptyId, session)

    proc.onData((data) => {
      session.chunks.push(data)
      session.length += data.length
      // Drop whole chunks so a replay never starts mid-escape-sequence.
      while (session.length > MAX_HISTORY && session.chunks.length > 1) {
        session.length -= (session.chunks.shift() as string).length
      }
      this.onData(ptyId, data)
      for (const fn of this.subscribers) fn(ptyId, data)
    })

    proc.onExit(({ exitCode, signal }) => {
      session.exited = true
      this.sessions.delete(ptyId)
      this.onExit(ptyId, exitCode, signal)
      for (const fn of this.exitSubscribers) fn(ptyId, exitCode)
    })

    return { ptyId, sessionId, command: spec.file, args: spec.args }
  }

  write(ptyId: string, data: string): void {
    const s = this.sessions.get(ptyId)
    if (!s || s.exited) return
    try {
      s.proc.write(data)
    } catch {
      /* process died between the renderer's keystroke and here */
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const s = this.sessions.get(ptyId)
    if (!s || s.exited) return
    const c = Math.max(20, Math.floor(cols))
    const r = Math.max(5, Math.floor(rows))
    try {
      s.proc.resize(c, r)
      s.cols = c
      s.rows = r
    } catch {
      /* resizing a dead pty throws on Windows */
    }
  }

  kill(ptyId: string): void {
    const s = this.sessions.get(ptyId)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
    this.sessions.delete(ptyId)
  }

  sessionIdFor(ptyId: string): string | null {
    return this.sessions.get(ptyId)?.sessionId ?? null
  }

  /* ------------------------------------------------------ remote clients */

  private subscribers = new Set<(ptyId: string, data: string) => void>()
  private exitSubscribers = new Set<(ptyId: string, code: number) => void>()

  /** Extra output sink, used by the remote server to fan out to phones. */
  subscribe(fn: (ptyId: string, data: string) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  subscribeExit(fn: (ptyId: string, code: number) => void): () => void {
    this.exitSubscribers.add(fn)
    return () => this.exitSubscribers.delete(fn)
  }

  /** Everything this session has printed so far, for replay on attach. */
  historyFor(ptyId: string): string {
    const s = this.sessions.get(ptyId)
    return s ? s.chunks.join('') : ''
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      ptyId: s.ptyId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      exited: s.exited,
      startedAt: s.startedAt,
      cols: s.cols,
      rows: s.rows
    }))
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
