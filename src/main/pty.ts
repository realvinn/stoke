import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { access, realpath, rm, writeFile } from 'node:fs/promises'
import * as nodePty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import type { LaunchOptions } from '@shared/types'
import { cliIdOf, isClaudeCode } from '../shared/codingClis.ts'
import { installScript, type LaunchPlan } from '../shared/agents.ts'
import { homedir, tmpdir } from 'node:os'
import {
  applyProviderEnv,
  validateClaudeAuth,
  type ProviderSettings,
  DEFAULT_PROVIDERS
} from '../shared/providers.ts'
import {
  buildArgs,
  buildEnvPath,
  findCli,
  loginPathProbeFailed,
  notFoundError,
  setPathKey,
  spawnSpec
} from './cli.ts'
import { windowFromBanner } from './sessionFile.ts'
import { buildSshArgs, sshExecutable } from './ssh.ts'
import { claimSessionFiles, releaseSessionFiles } from './statusLine.ts'
import type { RegistryTarget } from '../shared/claudeRegistry.ts'
import {
  isEndedExpired,
  isTerminalReport,
  SubmitQueue,
  submitFrames,
  trackBracketedPaste
} from '../shared/remotePhone.ts'

/**
 * How long after `submit()` writes the last chunk of text before it writes the
 * bare `\r` that submits it — see CLAUDE.md gotchas 85 and 86. Started at
 * the audit's own measurement; adjust here if a real `claude` needs longer.
 */
const SUBMIT_ENTER_DELAY_MS = 80

/**
 * The gap between two typed chunks of a phone's submit (`submitFrames`,
 * gotcha 86): 64-character chunks 10ms apart were read as typing by Claude
 * Code 2.1.278; one 1287-character write was read as a paste.
 */
const SUBMIT_CHUNK_GAP_MS = 10

/**
 * After one submit's Enter, before the next queued submit starts typing
 * (`SubmitQueue`). The same margin as the Enter delay: Claude Code has to take
 * the `\r` and clear its box before the next message's first chunk lands.
 */
const SUBMIT_AFTER_ENTER_MS = 80

export interface StartResult {
  ptyId: string
  sessionId: string
  command: string
  args: string[]
}

interface Session {
  ptyId: string
  /**
   * The Claude session the process is on NOW — not necessarily the one it was
   * launched with. `/clear` and the in-TUI `/resume` move it, and a
   * `--continue` starts at '' and learns its id late; `rebind` is how the
   * registry poller (`sessionRegistry.ts`) keeps this true. `statusKey` never
   * moves, because the statusLine files are owned by launch (gotcha 73).
   */
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
  /**
   * `cwd` through symlinks, once resolved (`/tmp` is `/private/tmp` on macOS,
   * and the CLI records the resolved one). Only the registry fallback reads it.
   */
  realCwd: string
  /** A local Claude Code session: the only kind with a registry file to read. */
  instrumented: boolean
  exited: boolean
  /**
   * When the process exited, or null while it is still running.
   *
   * Set once, alongside `exited`, and never cleared: it is what lets an
   * exited session stay in `sessions` for `ENDED_RETENTION_MS` (phone contract
   * point 3 / audit F1) instead of being deleted the instant `proc.onExit`
   * fires, which used to make a real crash or a plain `/exit` indistinguishable
   * from the session never having existed.
   */
  endedAt: number | null
  /** The process's own exit code, once it has one. */
  exitCode: number | null
  /** Settles when the process has actually exited. */
  exitedPromise: Promise<void>
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
  /** Last pty output, or the last registry state change reported via `touch`. */
  lastActivityAt: number
  cols: number
  rows: number
  /** The coding CLI this session runs, e.g. `'claude'`, `'codex'`. */
  cli: string
  /**
   * DECSET 2004 (bracketed paste), tracked from the pty's own output stream.
   *
   * `submit()` uses this to decide whether a phone's text needs the paste
   * brackets — see `submitFrames` and CLAUDE.md gotcha 85 / audit PX-1.
   */
  bracketedPaste: boolean
  /**
   * This session's phone submits, one at a time (`SubmitQueue`). Two submits
   * used to type interleaved into one garbled turn.
   */
  submits: SubmitQueue
  /**
   * The last time anything a person (or the phone) typed was written to the
   * pty, epoch ms, or null. Automatic terminal replies are not typing
   * (`isTerminalReport`). The phone's one-tap answer refuses a prompt that
   * has had input since it appeared (`answerVerdict`): whoever typed may have
   * answered it already.
   */
  lastInputAt: number | null
}

/** Summary of a live session, used by the remote UI's session list. */
export interface SessionInfo {
  ptyId: string
  sessionId: string
  cwd: string
  exited: boolean
  /** When the process exited, epoch ms, or null while it is still running. */
  endedAt: number | null
  /** The process's exit code, once it has one. */
  exitCode: number | null
  startedAt: number
  /** Last pty output, or the last registry state change `touch()` reported. */
  lastActivityAt: number
  cols: number
  rows: number
  /** The coding CLI this session runs — `'claude'` unless another agent launched it. */
  cli: string
  /** A local Claude Code session: the only kind the registry poller can read. */
  instrumented: boolean
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
 * through untouched, then Settings > Providers may overlay them for a
 * local session via applyProviderEnv.
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
    sessionSettings: (statusKey: string) => string | null = () => null,
    providers: ProviderSettings = DEFAULT_PROVIDERS,
    /**
     * A non-Claude CLI's arguments and environment for this launch — its
     * endpoint, its MCP servers, its continue flag — built by `agentLaunchPlan`
     * in main from settings. Ignored for Claude Code, SSH and installs.
     */
    agentPlan: LaunchPlan | null = null
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
    /*
     * Two independent reasons the instrumentation may be off, and they are not
     * the same reason.
     *
     * `remote` is gotcha 18's: the session runs on another machine, so its
     * transcript, its settings and its `claude` are all over there.
     * `instrumented` is the new one: the session is another BINARY, so
     * Claude's transcript format, its `--session-id`, its `--settings` file and
     * its statusLine hook do not describe it at all.
     *
     * They differ on exactly one gate below — the cwd check — because a Codex
     * session has a real local working directory and a remote one does not.
     */
    const cliId = cliIdOf(opts.cli)
    const remote = !!opts.host
    /*
     * An install tab runs the vendors' own install commands in a shell instead
     * of a CLI. The script is built here, in main, from the shared table and
     * ids it validates — `opts.install` carries ids, never command text.
     */
    const script = !remote && opts.install?.length ? installScript(opts.install, process.platform) : null
    if (!remote && opts.install?.length && !script) {
      throw new Error('Stoke has no install command for those agents on this platform. Their websites say how.')
    }
    const installing = script !== null
    const instrumented = !remote && !installing && isClaudeCode(cliId)

    const exe = remote
      ? sshExecutable()
      : installing
        ? await installerShell()
        : await findCli(cliId, isClaudeCode(cliId) ? claudePathOverride : null)
    if (!exe) throw new Error(notFoundError(loginPathProbeFailed(), cliId))
    // An install has no project; it runs from home so a vendor script that
    // writes relative to the cwd lands somewhere harmless.
    const cwd = installing ? homedir() : opts.cwd

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
    if (!remote) {
      try {
        await access(cwd)
      } catch {
        throw new Error(
          `That folder is not there any more: ${cwd}. It may have been moved or deleted, or it may live on a drive that is not connected.`
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
    const statusKey = instrumented ? sessionId || randomUUID() : ''

    /*
     * Minted here rather than after the spawn because it is also this launch's
     * CLAIM on statusKey's files, and the claim has to be in place before they
     * are written: a relaunch reuses the same statusKey, and the outgoing PTY's
     * exit handler can fire at any point from here on (gotcha 73). randomUUID
     * has no side effects, so moving it earlier costs nothing.
     */
    const ptyId = randomUUID()
    if (statusKey) claimSessionFiles(statusKey, ptyId)

    // One --settings, holding both the ultracode key and the statusLine
    // wrapper: a second silently discards the first. Local only — a remote
    // session runs ssh, and this file is on this disk.
    const settingsFile = instrumented ? sessionSettings(statusKey) : null
    /*
     * A non-Claude CLI gets its bare name and the folder, and nothing else.
     *
     * `buildArgs` emits Claude Code's flags — `--session-id`, `--resume`,
     * `--permission-mode`, `--model`, `--effort`, `--settings`. Gotcha 19 is
     * what handing those to another binary costs: an older remote `claude`
     * EXITS on a flag it does not recognise, so the failure is not a flag
     * being ignored, it is a session that never starts.
     */
    const installFile = installing && process.platform === 'win32' ? join(tmpdir(), `stoke-install-${ptyId}.ps1`) : null
    if (installFile && script) await writeInstallerFile(installFile, script)
    const args = remote
      ? buildSshArgs(opts.host!)
      : installing
        ? installerArgs(script, installFile)
        : instrumented
          ? buildArgs({ ...opts, sessionId }, settingsFile)
          : [...(agentPlan?.args ?? [])]

    // Hand the session Stoke's own browser tools. A file path rather than an
    // inline JSON string: quoting JSON through a shell differs per platform and
    // fails silently when it goes wrong.
    // Only meaningful locally: the flags belong to claude, and a remote session
    // is running ssh. The remote's own CLI config governs there.
    if (mcpConfigPath && instrumented) args.push('--mcp-config', mcpConfigPath)

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
      // One PATH key, not two: on Windows the copied env already holds `Path`,
      // and a second `PATH` beside it lost to the stale one (cli.ts setPathKey).
      setPathKey(env, await buildEnvPath())
      env.TERM = 'xterm-256color'
      env.COLORTERM = 'truecolor'
      // Tell Claude Code it is inside a wrapper, in case that ever matters to it.
      env.TERM_PROGRAM = 'Stoke'
      /*
       * Which way round the colours are, in the one form a TUI already reads.
       *
       * `fg;bg` as colour indices. Claude Code parses the LAST field and calls
       * anything <= 6 or === 8 dark, so 15 means a light background and 0 a
       * dark one. It consults this only when its own OSC 11 query goes
       * unanswered, which is why this is a backstop rather than the mechanism:
       * xterm.js answers that query truthfully from the theme background, so
       * the query almost always wins. Setting it costs nothing and covers a
       * terminal-side failure that would otherwise leave the CLI guessing dark
       * inside a light window.
       *
       * Not set for an SSH session, where it would be a lie: the variable does
       * not cross ssh without SendEnv/AcceptEnv, so the far end would either
       * not see it or see it describing the wrong machine's terminal.
       */
      if (!remote && opts.appearance) {
        env.COLORFGBG = opts.appearance === 'light' ? '0;15' : '15;0'
      }

      /*
       * Provider keys from Settings. Local only: env does not cross ssh
       * without SendEnv/AcceptEnv, and a remote claude has its own credentials.
       * validateClaudeAuth fails closed with a message the launcher can show,
       * rather than spawning a session that will 401 on the first turn.
       */
      /*
       * Gated on `instrumented`, not `!remote`. These are ANTHROPIC_* variables
       * read by Claude Code, and `validateClaudeAuth` can REFUSE THE LAUNCH —
       * so leaving this on `!remote` meant a missing Anthropic key stopping a
       * Codex session from starting, and a configured one putting
       * ANTHROPIC_BASE_URL into a process that has never heard of it.
       */
      if (instrumented) {
        const check = validateClaudeAuth(providers)
        if (!check.ok) throw new Error(check.message)
        applyProviderEnv(env, providers)
      } else if (!remote && !installing && agentPlan) {
        // Last, so a key the plan sets wins over one inherited from a shell.
        Object.assign(env, agentPlan.env)
      }

      proc = nodePty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: Math.max(20, opts.cols || 120),
        rows: Math.max(5, opts.rows || 30),
        cwd,
        env,
        useConpty: process.platform === 'win32' ? true : undefined
      })
    } catch (err) {
      releaseSessionFiles(statusKey, ptyId)
      if (installFile) void rm(installFile, { force: true })
      throw err
    }
    if (installFile) proc.onExit(() => void rm(installFile, { force: true }))

    let markExited: () => void = () => {}
    const now = Date.now()
    const session: Session = {
      ptyId,
      sessionId,
      statusKey,
      proc,
      cwd,
      realCwd: cwd,
      instrumented,
      exited: false,
      endedAt: null,
      exitCode: null,
      exitedPromise: new Promise<void>((resolve) => {
        markExited = resolve
      }),
      chunks: [],
      length: 0,
      bannerWindow: null,
      bannerScanned: 0,
      startedAt: now,
      lastActivityAt: now,
      cols: Math.max(20, opts.cols || 120),
      rows: Math.max(5, opts.rows || 30),
      cli: cliId,
      bracketedPaste: false,
      submits: new SubmitQueue({
        chunkGapMs: SUBMIT_CHUNK_GAP_MS,
        enterDelayMs: SUBMIT_ENTER_DELAY_MS,
        afterEnterMs: SUBMIT_AFTER_ENTER_MS
      }),
      lastInputAt: null
    }
    this.sessions.set(ptyId, session)
    // Off the spawn path: nothing waits on it, and the fallback that reads it
    // is not consulted until the session is seconds old.
    if (instrumented) {
      void realpath(opts.cwd).then(
        (p) => {
          session.realCwd = p
        },
        () => {}
      )
    }

    proc.onData((data) => {
      session.chunks.push(data)
      session.length += data.length
      session.lastActivityAt = Date.now()
      session.bracketedPaste = trackBracketedPaste(data, session.bracketedPaste)
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
      session.endedAt = Date.now()
      session.exitCode = exitCode
      markExited()
      /*
       * Left in `this.sessions`, not deleted — CLAUDE.md gotcha 84 / audit F1.
       * A session that exits on its own (a crash, `/exit`, a fatal error) used
       * to disappear from the map in this same tick, which meant `list()`
       * could never report `exited: true` for a real exit and a phone
       * watching it got nothing: no error, no final output, the row simply
       * gone. It now stays, read-only (`write`/`resize` already refuse an
       * exited session), until `list()` prunes it past `ENDED_RETENTION_MS`.
       * `kill()`/`stop()` — an explicit close, a tab the user closed by hand —
       * still delete at once; that half of the old behaviour was correct and
       * phone contract point 3 keeps it. ids are uuids and never reused, so
       * this is unambiguously this session's own entry.
       */
      // The payload, the pass-through command and the settings file are all
      // per-session temp files, named after the launch key rather than the
      // session id — a --continue has no id here. Nothing reads them once the
      // process is gone, and leaving them would accumulate one set per session
      // ever started. Also called from kill() for the app-quit path, where
      // this callback cannot be trusted to run in time — a second call here
      // for the same key is a no-op, not a double-delete.
      //
      // BY OWNER, because this fires when the child actually dies rather than
      // when it was asked to: on a relaunch the replacement session already
      // holds this very key, and clearing it unconditionally deletes the new
      // session's settings file out from under a CLI that has not read it yet
      // (gotcha 73).
      releaseSessionFiles(session.statusKey, session.ptyId)
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
      if (data && !isTerminalReport(data)) s.lastInputAt = Date.now()
    } catch {
      /* process died between the renderer's keystroke and here */
    }
  }

  /** When input last reached this pty (`Session.lastInputAt`), or null. */
  lastInputAt(ptyId: string): number | null {
    return this.sessions.get(ptyId)?.lastInputAt ?? null
  }

  /**
   * The ptyId of a RUNNING session on `sessionId`, or null. For refusing a
   * second `claude` on a transcript that is already open (the phone's Resume
   * on a session a desktop tab or another phone is running).
   */
  liveFor(sessionId: string): string | null {
    if (!sessionId) return null
    for (const s of this.sessions.values()) if (!s.exited && s.sessionId === sessionId) return s.ptyId
    return null
  }

  /**
   * A phone's `{type:'submit', text}` — CLAUDE.md gotchas 85 and 86 / audit PX-1.
   *
   * Typed, not pasted: the text goes as `submitFrames`' chunks
   * `SUBMIT_CHUNK_GAP_MS` apart (no bracketed paste for Claude Code — its box
   * records a bracketed paste as `<pasted_content>` and the model will not act
   * on it), and the bare `\r` that submits follows on its own after
   * `SUBMIT_ENTER_DELAY_MS`. Folding the `\r` into the text is the original
   * PX-1 bug: it lands as a newline inside the box. Submits to one session
   * run one at a time (`SubmitQueue`); this returns as soon as it is queued.
   */
  submit(ptyId: string, text: string): boolean {
    const s = this.sessions.get(ptyId)
    if (!s || s.exited) return false
    const frames = submitFrames(text, {
      bracketedPaste: s.bracketedPaste,
      claude: isClaudeCode(cliIdOf(s.cli))
    })
    /*
     * Queued behind this session's previous submit, never started beside it:
     * two chains of timed writes interleave (review of PX-3's queued flush,
     * which sends several submits back to back). Each write re-checks the
     * session, so a job queued behind an `/exit` stops at its first write.
     */
    void s.submits.push(frames, (data) => {
      const cur = this.sessions.get(ptyId)
      if (!cur || cur.exited) return false
      try {
        cur.proc.write(data)
        cur.lastInputAt = Date.now()
        return true
      } catch {
        return false
      }
    })
    return true
  }

  /**
   * Stamp a session's last-activity time from something other than its own
   * pty output — the registry poller, when a session's status changes with
   * no bytes written (a permission dialog appearing is a state change, not
   * output). A no-op past exit or for an unknown ptyId.
   */
  touch(ptyId: string): void {
    const s = this.sessions.get(ptyId)
    if (s && !s.exited) s.lastActivityAt = Date.now()
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
     * gone. It is the LATE one that needed care, not the second one: see
     * gotcha 73 and the owner argument here.
     */
    releaseSessionFiles(s.statusKey, s.ptyId)
  }

  /**
   * Kill, then wait for the process to actually exit — at most `capMs`.
   *
   * For a relaunch, which used to start the replacement straight after a
   * fire-and-forget `kill`. `claude` takes ~0.8-0.95s to exit after SIGHUP
   * (exit 129), so for that long two processes held one conversation, and two
   * concurrent writers can fork a transcript. Waiting closes that window.
   *
   * The file ownership of gotcha 73 still stands on its own and is not what
   * this is for: the cap means a replacement CAN still start before a
   * predecessor that will not die, and `releaseSessionFiles` is what keeps
   * that late exit from deleting the successor's files. Resolves true when the
   * exit landed inside the cap.
   */
  async stop(ptyId: string, capMs: number): Promise<boolean> {
    const s = this.sessions.get(ptyId)
    if (!s) return true
    const exited = s.exitedPromise.then(() => true)
    this.kill(ptyId)
    let timer: NodeJS.Timeout | null = null
    const capped = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, capMs))
    })
    try {
      return await Promise.race([exited, capped])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Move a live session onto the id its `claude` is actually on now.
   *
   * `statusKey` is deliberately left alone: the statusLine files are named
   * after the launch and owned by it (gotcha 73), and the payload inside them
   * states its own `session_id`, so readers find it through `statusKeyFor`.
   */
  rebind(ptyId: string, sessionId: string): string | null {
    const s = this.sessions.get(ptyId)
    if (!s || s.exited) return null
    const previous = s.sessionId
    s.sessionId = sessionId
    return previous
  }

  /**
   * The statusLine key of the live session now on `sessionId`, or null.
   *
   * The payload, the events file and the settings file are named after the
   * LAUNCH, so once a session has been rebound (`/clear`, `/resume`, a
   * `--continue`'s real id) its files are no longer named after its id. Every
   * reader that holds a session id goes through this.
   */
  statusKeyFor(sessionId: string): string | null {
    if (!sessionId) return null
    // Past exit too: an exited session stays in the map for the phone's ring
    // (gotcha 84), its files already released, and Map order puts it FIRST —
    // after a /clear then a Resume on the new id it would shadow the live key.
    for (const s of this.sessions.values()) {
      if (!s.exited && s.sessionId === sessionId && s.statusKey) return s.statusKey
    }
    return null
  }

  /** The pty child's pid, or null when there is no such live session. */
  pidFor(ptyId: string): number | null {
    const s = this.sessions.get(ptyId)
    return s && !s.exited && typeof s.proc.pid === 'number' ? s.proc.pid : null
  }

  /**
   * Every live LOCAL Claude session, as the registry poller wants it.
   *
   * An SSH tab has no local registry file — its `claude` is on the far machine
   * (gotcha 18) — and another CLI writes none at all, so both are left out.
   */
  registryTargets(): RegistryTarget[] {
    const out: RegistryTarget[] = []
    for (const s of this.sessions.values()) {
      if (s.exited || !s.instrumented) continue
      out.push({
        ptyId: s.ptyId,
        pid: typeof s.proc.pid === 'number' ? s.proc.pid : null,
        sessionId: s.sessionId,
        cwd: s.realCwd,
        startedAt: s.startedAt
      })
    }
    return out
  }

  /**
   * Context window stated by the banner of the session with this id, or null
   * when none was seen. Keyed on the Claude session id rather than the pty id,
   * because that is what the context watcher knows about.
   */
  bannerWindowFor(sessionId: string): number | null {
    for (const s of this.sessions.values()) {
      if (!s.exited && s.sessionId === sessionId && s.bannerWindow) return s.bannerWindow
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
    // Live only: an exited session in the phone's ring has released its files.
    for (const s of this.sessions.values()) if (!s.exited && s.statusKey) keys.push(s.statusKey)
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
    this.pruneEnded()
    return [...this.sessions.values()].map((s) => ({
      ptyId: s.ptyId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      exited: s.exited,
      endedAt: s.endedAt,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      cols: s.cols,
      rows: s.rows,
      cli: s.cli,
      instrumented: s.instrumented
    }))
  }

  /** Drop an exited session once it has sat in the ring past `ENDED_RETENTION_MS`. */
  private pruneEnded(now: number = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (s.exited && isEndedExpired(s.endedAt, now)) {
        this.sessions.delete(id)
      }
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}

/**
 * The shell an install tab runs in. bash where there is one, because every
 * vendor's POSIX installer is written for `| bash` or `| sh` and several use
 * bash-only syntax; `sh` otherwise. Checked with async `access`, never
 * `existsSync` (gotcha 40).
 */
async function installerShell(): Promise<string> {
  if (process.platform === 'win32') return 'powershell.exe'
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // try the next one
    }
  }
  return '/bin/sh'
}

/**
 * How the script reaches that shell.
 *
 * On Windows, as a FILE (`-File`), never as command-line text. Handed over as
 * `-Command` it would have to survive Windows' argv quoting, which node-pty's
 * conpty joins into one string (gotcha 13's class of mangling); handed over as
 * `-EncodedCommand` — which this was — it has to fit in one command line, and
 * every step inside is ITSELF an encoded command, so each step's text is
 * encoded twice and costs about seven times its length. Every agent at once
 * measured 25,024 characters of Windows' 32,767, and two small robustness fixes
 * (the winget guard, the Node.js step) took it to 29,640: the next agent would
 * have made "select all" a tab that dies on CreateProcess. A file has no limit.
 */
function installerArgs(script: string, file: string | null): string[] {
  if (process.platform === 'win32' && file) {
    return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]
  }
  return ['-c', script]
}

/**
 * The install script, written for Windows PowerShell 5.1 to read: UTF-8 WITH a
 * byte-order mark, because 5.1 reads a BOM-less script as the ANSI code page and
 * the table's notes carry em dashes. The file is the tab's own (named after its
 * pty id) and is removed when the tab's process exits.
 */
async function writeInstallerFile(file: string, script: string): Promise<void> {
  await writeFile(file, '\uFEFF' + script, 'utf8')
}
