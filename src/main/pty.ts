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
}

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
    const session: Session = { ptyId, sessionId, proc, cwd: opts.cwd, exited: false }
    this.sessions.set(ptyId, session)

    proc.onData((data) => this.onData(ptyId, data))
    proc.onExit(({ exitCode, signal }) => {
      session.exited = true
      this.sessions.delete(ptyId)
      this.onExit(ptyId, exitCode, signal)
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
    try {
      s.proc.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
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

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
