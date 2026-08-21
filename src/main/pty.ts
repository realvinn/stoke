import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import * as nodePty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import type { LaunchOptions } from '@shared/types'
import { buildArgs, buildEnvPath, findClaude, spawnSpec } from './cli.ts'
import { windowFromBanner } from './sessionFile.ts'
import { buildSshArgs, sshExecutable } from './ssh.ts'
import { clearSessionFiles } from './statusLine.ts'

export interface StartResult {
  ptyId: string
  sessionId: string
  command: string
  args: string[]
}

interface Session {
  ptyId: string
  sessionId: string
  /**
   * What this session's statusLine files are named after, or '' when it has
   * none.
   *
   * The same string as `sessionId` for every local session Stoke mints an id
   * for, a launch uuid for a `--continue` — whose id the CLI chooses after we
   * spawn it — and empty for a remote session, which gets no wrapper because
   * its `claude` runs on the far machine. Kept because the exit handler has to
   * delete the files it names, and `statusKeys()` has to list them.
   */
  statusKey: string
  proc: IPty
  cwd: string
  exited: boolean
  /** Retained output so a client joining late can replay the session. */
  chunks: string[]
  length: number
  /**
   * Context window as stated by the CLI's own startup banner, once seen.
   *
   * The transcript never records the tier - a session verified at 713k tokens
   * still wrote its model as plain `claude-opus-5` - so the banner is the only
   * statement of it, and the only one available before tokens are spent.
   */
  bannerWindow: number | null
  /** Bytes of output still worth scanning for the banner. */
  bannerScanned: number
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
 * How much output to search for the startup banner before giving up.
 *
 * The banner is in the first frames, so this only has to survive a slow start.
 * Bounding it stops a long-running session re-scanning its whole buffer on
 * every chunk for a line that is never coming - a resumed session, say, which
 * prints no banner at all.
 */
const BANNER_SCAN_LIMIT = 64 * 1024

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
  /**
   * `sessionId` is the fourth argument, not folded into a lookup the caller
   * does itself, because by the time this fires `proc.onExit` has already
   * removed the session from `this.sessions` (see below) — the caller has no
   * way left to ask `sessionIdFor(ptyId)` and get an answer. Passing it here,
   * straight out of the closure that still holds the session, is what lets
   * index.ts clean up its own per-session state (`statusLineSeen`) for a
   * session that ended on its own, not only one the user closed by hand.
   */
  private readonly onExit: (ptyId: string, code: number, signal: number | undefined, sessionId: string) => void

  // Explicit fields rather than TS parameter properties, matching ContextWatcher
  // so the main-process modules stay runnable under node's type stripping.
  constructor(
    onData: (ptyId: string, data: string) => void,
    onExit: (ptyId: string, code: number, signal: number | undefined, sessionId: string) => void
  ) {
    this.onData = onData
    this.onExit = onExit
  }

  /**
   * @param sessionSettings builds this session's `--settings` file, given its
   *   statusLine key — which is minted here, so it cannot be passed in
   *   ready-made. Injected rather than read from the store so this module
   *   stays free of electron, like every other dependency it takes.
   */
  async start(
    opts: LaunchOptions,
    claudePathOverride: string | null,
    mcpConfigPath?: string | null,
    sessionSettings: (statusKey: string) => string | null = () => null
  ): Promise<StartResult> {
    /*
     * A remote session is the same machinery with a different argv: ssh instead
     * of claude. Nothing else changes - the PTY, the scrollback and the fan-out
     * to the phone all work identically, which is the whole reason this is small.
     *
     * What does NOT carry over is anything that reads a transcript, because a
     * remote session's transcript lives on the far machine: no context meter and
     * no Stoke-side resume. A multiplexer in `host.command` is the only resume
     * such a session can have.
     */
    const exe = opts.host ? sshExecutable() : await findClaude(claudePathOverride)
    if (!exe) {
      throw new Error(
        'Could not find the `claude` executable. Install Claude Code, or set an explicit path in Settings.'
      )
    }

    /*
     * The folder has to exist, and node-pty will not tell us if it does not.
     *
     * `spawn` resolves happily for a nonexistent `cwd`: the failure happens in
     * the forked child, at `chdir`, after this function has already returned a
     * ptyId. So `startSession`'s try/catch never fires, a tab opens on a blank
     * pane, the process exits, and the user gets "Session ended (exit 1)" with
     * nothing anywhere naming the folder — and "Start again" repeats it forever.
     * That is what every one of the sidebar's `missing` rows does when started.
     *
     * Checked only for a local session: a remote one runs `ssh` here and its
     * real working directory is on the far machine (gotcha 18), so `opts.cwd`
     * is a local path that has nothing to do with where the session will land.
     */
    if (!opts.host) {
      try {
        await access(opts.cwd)
      } catch {
        throw new Error(
          `That folder is not there any more: ${opts.cwd}. It may have been moved or deleted, or it may live on a drive that is not connected.`
        )
      }
    }

    // For brand-new sessions we mint the id ourselves and pass --session-id, so
    // the transcript path is known before the process even starts. That is what
    // lets the context meter attach immediately.
    const sessionId =
      opts.resume || opts.continueLast ? (opts.sessionId ?? '') : (opts.sessionId ?? randomUUID())

    /*
     * The statusLine files are named after THIS, not after the session id.
     *
     * A --continue session has no id here: the CLI chooses it after launch, so
     * `sessionId` above is ''. Keying the wrapper on the id would leave that
     * one launch path with no --settings at all, which means it keeps printing
     * the user's own status line with suppression on and never writes a
     * payload — and both failures look exactly like the feature working.
     *
     * For every local session that does have an id, this IS that id, byte for
     * byte. The payload carries `session_id` itself, so `toSnapshot` can name
     * the real session even when the file is named after a launch key.
     *
     * Empty for a remote session, which gets no wrapper at all: it runs ssh,
     * and its `claude` and its settings live on the far machine. That is what
     * makes `statusKeys()` below able to mean "has a payload to read".
     */
    const statusKey = opts.host ? '' : sessionId || randomUUID()

    // One --settings, holding both the ultracode key and the statusLine
    // wrapper: a second silently discards the first. Local only — a remote
    // session runs ssh, and this file is on this disk.
    const settingsFile = opts.host ? null : sessionSettings(statusKey)
    const args = opts.host
      ? buildSshArgs(opts.host)
      : buildArgs({ ...opts, sessionId }, settingsFile)

    // Hand the session Stoke's own browser tools. A file path rather than an
    // inline JSON string: quoting JSON through a shell differs per platform and
    // fails silently when it goes wrong.
    // Only meaningful locally: the flags belong to claude, and a remote session
    // is running ssh. The remote's own CLI config governs there.
    if (mcpConfigPath && !opts.host) args.push('--mcp-config', mcpConfigPath)

    // Ultracode and the statusLine wrapper both need nothing here: buildArgs
    // has already folded them into the single `--settings <file>` above. Do
    // not be tempted to write `/effort ultracode` into the pty after start
    // instead — a write races the TUI's warmup, so the text
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

    // buildEnvPath and the native spawn are the only things between here and
    // proc.onExit being registered below that can throw - and settingsFile
    // above has already written statusKey's .settings.json (and maybe .cmd)
    // to disk by this point. A project folder deleted since the launcher
    // listed it, or a resource limit, would otherwise leave those ownerless:
    // nothing else will ever clean them up, since clearSessionFiles only
    // ever runs from an exit handler this session never gets to register.
    let proc: IPty
    try {
      env.PATH = await buildEnvPath()
      if (process.platform !== 'win32') env.Path = env.PATH
      env.TERM = 'xterm-256color'
      env.COLORTERM = 'truecolor'
      // Tell Claude Code it is inside a wrapper, in case that ever matters to it.
      env.TERM_PROGRAM = 'Stoke'

      proc = nodePty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: Math.max(20, opts.cols || 120),
        rows: Math.max(5, opts.rows || 30),
        cwd: opts.cwd,
        env,
        useConpty: process.platform === 'win32' ? true : undefined
      })
    } catch (err) {
      clearSessionFiles(statusKey)
      throw err
    }

    const ptyId = randomUUID()
    const session: Session = {
      ptyId,
      sessionId,
      statusKey,
      proc,
      cwd: opts.cwd,
      exited: false,
      chunks: [],
      length: 0,
      bannerWindow: null,
      bannerScanned: 0,
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
      /*
       * Read the context window off the banner, which the CLI prints in its
       * first frames. Scanning the joined buffer rather than this chunk alone
       * because the banner is styled and routinely arrives split across chunks
       * mid-escape-sequence. Bounded so a long session is not re-scanned
       * forever, and stops entirely once found.
       */
      if (session.bannerWindow === null && session.bannerScanned < BANNER_SCAN_LIMIT) {
        session.bannerScanned += data.length
        session.bannerWindow = windowFromBanner(session.chunks.join(''))
      }
      this.onData(ptyId, data)
      for (const fn of this.subscribers) fn(ptyId, data)
    })

    proc.onExit(({ exitCode, signal }) => {
      session.exited = true
      this.sessions.delete(ptyId)
      // The payload, the pass-through command and the settings file are all
      // per-session temp files, named after the launch key rather than the
      // session id — a --continue has no id here. Nothing reads them once the
      // process is gone, and leaving them would accumulate one set per session
      // ever started. Also called from kill() for the app-quit path, where
      // this callback cannot be trusted to run in time — a second call here
      // for the same key is a no-op, not a double-delete.
      clearSessionFiles(session.statusKey)
      this.onExit(ptyId, exitCode, signal, session.sessionId)
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
    /*
     * Quitting the app is the ordinary way a session ends, and it does not
     * give proc.onExit a reliable chance to run: killAll() calls this
     * synchronously from `before-quit`, in the same tick chain Electron then
     * tears the process down in, while onExit needs the child to actually
     * die *and* the event loop to still be alive to fire it. Clearing here
     * closes that race instead of leaving cleanup to a callback that might
     * never get scheduled.
     *
     * Harmless to run twice: proc.onExit below still fires later - for a
     * session that exits on its own, this is the only cleanup that runs -
     * and clearSessionFiles' rmSync already tolerates a file that is already
     * gone.
     */
    clearSessionFiles(s.statusKey)
  }

  /**
   * Context window stated by the banner of the session with this id, or null
   * when none was seen. Keyed on the Claude session id rather than the pty id,
   * because that is what the context watcher knows about.
   */
  bannerWindowFor(sessionId: string): number | null {
    for (const s of this.sessions.values()) {
      if (s.sessionId === sessionId && s.bannerWindow) return s.bannerWindow
    }
    return null
  }

  sessionIdFor(ptyId: string): string | null {
    return this.sessions.get(ptyId)?.sessionId ?? null
  }

  /**
   * The statusLine key of every live local session.
   *
   * Exists for one caller: Task 13's `statusline:last` handler, which has to
   * find the payload of a session whose id it does not know. That is the
   * `--continue` case — the CLI names the session, we name the file, and only
   * the payload joins the two. A session with no key (an SSH session, which
   * gets no wrapper because its `claude` runs on the far machine) is skipped.
   */
  statusKeys(): string[] {
    const keys: string[] = []
    for (const s of this.sessions.values()) if (s.statusKey) keys.push(s.statusKey)
    return keys
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
