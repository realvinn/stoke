/**
 * Installing an SSH key on a host that has just asked for a password.
 *
 * The impure half of the feature whose rules live in `src/shared/sshAuth.ts`
 * (detection) and `src/main/ssh.ts` (argv). Everything that spawns is here, and
 * nothing here decides anything: what may be offered is `shouldOfferKey`'s
 * answer, what a command looks like is `buildCopyIdArgs` /
 * `buildEnrollFallbackArgs` / `buildPubkeyProbeArgs`, and both of those files
 * are pure and tested without a host.
 *
 * Three properties are not negotiable, and each is a line of code rather than a
 * paragraph of intent:
 *
 * 1. **Nothing runs without a press.** The only caller is `CH.sshEnroll`, which
 *    the renderer sends from a button. The detector reaches nothing here.
 * 2. **Stoke never sees the password.** The install runs in a PTY the user types
 *    into directly — no password field, no password on IPC, no `SSH_ASKPASS`,
 *    nothing on argv. ssh reads it with echo off, so it is not even in the
 *    stream this module forwards: there is nothing to redact because there is
 *    nothing there.
 * 3. **A success is claimed only when a connection proves it.** `ssh-copy-id`
 *    exiting 0 says the bytes arrived, not that pubkey auth works; only
 *    `verifyPubkeyAuth`'s `BatchMode=yes` probe may set `keyEnrolled` (gotcha
 *    75, and CLAUDE.md's "never print a diagnosis the tool can disprove").
 *
 * Every side effect is injectable, with real defaults, so a suite can drive the
 * whole orchestrator without spawning anything — the shape
 * `fetchRemoteTranscript` already uses for its `run`.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SshEnrollEvent, SshHost } from '@shared/types'
// Relative and with the extension, like the rest of src/main: this module is
// loaded directly under `node --experimental-strip-types`, which resolves no
// aliases. The type-only import above is erased, so it may use either.
import { isEnrollableAlias } from '../shared/sshAuth.ts'
import {
  buildCopyIdArgs,
  buildEnrollFallbackArgs,
  buildPubkeyProbeArgs,
  expandTilde,
  sshCopyIdExecutable,
  sshExecutable
} from './ssh.ts'
import { buildPtyEnv } from './pty.ts'
import { describeExecError } from './updates.ts'

/* ------------------------------------------------------------------ budgets */

/**
 * `execFile` buffers output in memory and defaults to 1 MB (gotcha 13). Nothing
 * here prints anything like that much — `ssh -G` is a few hundred lines — but
 * the default is a cliff rather than a limit: crossing it kills the child and
 * throws away the answer it had already given.
 */
const MAX_BUFFER = 8 * 1024 * 1024

/** `ssh -G` resolves config only; it opens no connection. */
const CONFIG_TIMEOUT_MS = 10_000

/** ssh-keygen writes two small files. */
const KEYGEN_TIMEOUT_MS = 30_000

/** The probe carries its own `ConnectTimeout=10`; this is the backstop. */
const PROBE_TIMEOUT_MS = 25_000

/**
 * How long the install may sit there.
 *
 * Generous on purpose: a person has to read the prompt, find the password and
 * type it. The deadline exists so a host that never prompts and never exits
 * cannot leave a PTY and its ssh child alive for the rest of the session, not
 * to hurry anybody.
 */
const INSTALL_TIMEOUT_MS = 180_000

/** How long a killed install gets to actually die before we stop waiting. */
const KILL_GRACE_MS = 5_000

/** `access` under a deadline, never `existsSync` (gotcha 40). */
const EXISTS_DEADLINE_MS = 1500

/** Lines of tool output forwarded per install, so a chatty MOTD cannot flood. */
const MAX_OUTPUT_LINES = 200

/* ----------------------------------------------------------------- the deps */

/** What one spawned program printed, and why it failed if it did. */
export interface ExecResult {
  ok: boolean
  stdout: string
  stderr: string
  /** `describeExecError`'s sentence, or null on success. */
  error: string | null
}

export type ExecRun = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>

/**
 * The slice of node-pty this module uses.
 *
 * Declared with method syntax rather than function-typed properties so an
 * `IPty` is assignable to it, and so a suite's fake needs three functions
 * rather than a terminal.
 */
export interface EnrollPty {
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown
  kill(signal?: string): void
}

export type SpawnPty = (
  file: string,
  args: string[],
  env: Record<string, string>,
  cwd: string
) => EnrollPty | Promise<EnrollPty>

export interface EnrollDeps {
  /** Progress, verbatim where there is tool output. The only channel out. */
  emit?: (event: SshEnrollEvent) => void
  exec?: ExecRun
  spawnPty?: SpawnPty
  exists?: (path: string) => Promise<boolean>
  readText?: (path: string) => Promise<string>
  makeDir?: (path: string) => Promise<void>
  /** Home directory, so a suite can point the key candidates at a fixture. */
  home?: () => string
}

/** What `enroll` tells its caller — index.ts, which persists `keyEnrolled`. */
export interface EnrollResult {
  /** Pubkey auth was PROVEN to work. The only thing that may set keyEnrolled. */
  ok: boolean
  /** True once the install command ran to completion, whatever it achieved. */
  installed: boolean
  /** The private key involved, when there was one. */
  keyPath: string | null
  message: string
}

/* ---------------------------------------------------------------- defaults */

function defaultExec(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        const out = stdout ?? ''
        const errOut = stderr ?? ''
        if (!err) {
          resolve({ ok: true, stdout: out, stderr: errOut, error: null })
          return
        }
        /*
         * describeExecError checks `killed` BEFORE a numeric `code` (gotcha
         * 25), which is the whole reason it is borrowed rather than rewritten:
         * a timed-out run arrives as `killed: true, signal: 'SIGTERM',
         * code: null`, and the obvious ordering reports that as "exited with
         * code null" — throwing away the one fact that explains it.
         */
        resolve({
          ok: false,
          stdout: out,
          stderr: errOut,
          // Narrowed the way updates.ts's own caller does: ExecFileException
          // types `code` as `string | number | null`, and describeExecError
          // reads a null code only after `killed`, which is the point of it.
          error: describeExecError(
            err as { code?: string | number; killed?: boolean; signal?: string | null; message?: string },
            basename(file),
            timeoutMs
          )
        })
      }
    )
  })
}

async function defaultExists(path: string): Promise<boolean> {
  /*
   * The same shape as projects.ts's `pathExists`: async, and bounded. A key
   * candidate is under ~/.ssh so it is on the internal disk in practice, but
   * this runs on the main thread and a sync call there is a bet on that being
   * true of every machine (gotcha 40).
   */
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), EXISTS_DEADLINE_MS)
  })
  try {
    return await Promise.race([
      access(path).then(
        () => true,
        () => false
      ),
      deadline
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const defaultSpawnPty: SpawnPty = async (file, args, env, cwd) => {
  // Imported here rather than at module scope so a suite that injects its own
  // spawner never loads the native binding at all.
  const nodePty = await import('@lydell/node-pty')
  return nodePty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env,
    useConpty: process.platform === 'win32' ? true : undefined
  })
}

/* ------------------------------------------------------------ the identity */

/**
 * The key this host should be enrolled with, or null if there is not one yet.
 *
 * `ssh -G <alias>` is ssh's own answer to "which identity files apply here",
 * including everything a `Host` block, an `IdentityFile` line or a `Match`
 * contributes — so a user who already has a key and has already pointed the
 * config at it gets THAT key installed, rather than a second one minted beside
 * it and a config that still names the first. The order is ssh's order, and the
 * first candidate with a `.pub` beside it wins: without the public half there is
 * nothing to install, and deriving one would mean reading a private key Stoke
 * has no business opening.
 */
export async function resolveIdentity(alias: string, deps: EnrollDeps = {}): Promise<string | null> {
  const name = alias.trim()
  if (!isEnrollableAlias(name)) return null
  const exec = deps.exec ?? defaultExec
  const exists = deps.exists ?? defaultExists

  const res = await exec(sshExecutable(), ['-G', name], CONFIG_TIMEOUT_MS)
  if (!res.ok && !res.stdout) return null

  for (const line of res.stdout.split(/\r?\n/)) {
    // `ssh -G` prints every keyword lower-cased, one per line, value after a
    // single space. Anything else in the output is another setting.
    if (!line.startsWith('identityfile ')) continue
    const path = expandTilde(line.slice('identityfile '.length).trim())
    if (!path) continue
    if (await exists(`${path}.pub`)) return path
  }
  return null
}

/* ------------------------------------------------------------- the new key */

export interface GeneratedKey {
  ok: boolean
  path: string | null
  message: string
}

/**
 * An ssh-keygen comment safe to put in a public key line.
 *
 * `isSafePublicKeyLine` — which the no-`ssh-copy-id` fallback gates on — allows
 * `[A-Za-z0-9._@-]` in the trailing comment tokens, so a label with a bracket,
 * a slash or an apostrophe in it would produce a key Stoke then refuses to
 * install through its own fallback. Sanitised rather than rejected: the label is
 * the user's own text for a machine, and mangling it costs nothing.
 */
export function keyComment(label: string): string {
  const cleaned = `${label} (Stoke)`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'Stoke'
}

/**
 * `ssh-keygen` from the same OpenSSH as the `ssh` that will use the key.
 *
 * Derived from `sshExecutable()` rather than looked up on PATH for the reason
 * `sshCandidates` pins the native build on Windows: the native and MSYS builds
 * disagree about path syntax, and a key written by one for the other is a
 * translation bug that presents as "the key did nothing".
 */
export function sshKeygenExecutable(): string {
  const name = process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'
  const dir = dirname(sshExecutable())
  return dir && dir !== '.' ? join(dir, name) : name
}

/**
 * Mint an ed25519 key, only when `resolveIdentity` found nothing.
 *
 * Two candidates and no more. `~/.ssh/id_ed25519` is the name every other tool
 * already looks for; `~/.ssh/stoke_ed25519` is for the machine that has one but
 * with no `.pub` beside it. If both private files exist this STOPS and says so,
 * because a third invented name is a key the user will find later and not
 * recognise. The PRIVATE file decides: `id_ed25519` with no `id_ed25519.pub` is
 * still somebody's key.
 *
 * **No passphrase, deliberately, and this is the reason rather than an
 * oversight.** ssh-keygen takes one from the tty or from `-N` on argv, and argv
 * is world-readable through `ps` on every machine this runs on — gotcha 13's
 * rule one step further: not "it gets mangled" but "it gets read". Doing it
 * properly means driving ssh-keygen in a PTY the way the install below is
 * driven, which is a clean follow-up and not a line to squeeze in here.
 * `Overwrite (y/n)?` is never relied on either: under execFile there is no tty
 * to answer it with, so the candidates are checked first and a taken name is
 * never passed.
 */
export async function generateKey(label: string, deps: EnrollDeps = {}): Promise<GeneratedKey> {
  const exec = deps.exec ?? defaultExec
  const exists = deps.exists ?? defaultExists
  const home = (deps.home ?? homedir)()
  const sshDir = join(home, '.ssh')
  const makeDir =
    deps.makeDir ?? ((p: string) => mkdir(p, { recursive: true, mode: 0o700 }).then(() => undefined))

  const candidates = [join(sshDir, 'id_ed25519'), join(sshDir, 'stoke_ed25519')]
  let target: string | null = null
  for (const candidate of candidates) {
    if (await exists(candidate)) continue
    target = candidate
    break
  }
  if (!target) {
    return {
      ok: false,
      path: null,
      message: `Both ${candidates[0]} and ${candidates[1]} already exist, and neither has a public half Stoke could install. Write the missing .pub with \`ssh-keygen -y -f <key>\`, or run \`ssh-copy-id\` by hand.`
    }
  }

  try {
    await makeDir(sshDir)
  } catch (err) {
    return {
      ok: false,
      path: null,
      message: `Could not create ${sshDir}: ${(err as Error).message}`
    }
  }

  let keygen = sshKeygenExecutable()
  // Fall back to the bare name so a miss is the OS's own "not found" rather
  // than a path Stoke invented — the rule `sshExecutable` ends on.
  if (!(await exists(keygen))) keygen = process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'

  const res = await exec(
    keygen,
    ['-t', 'ed25519', '-f', target, '-N', '', '-C', keyComment(label)],
    KEYGEN_TIMEOUT_MS
  )
  if (!res.ok) {
    return {
      ok: false,
      path: null,
      message: res.error ?? `ssh-keygen failed. ${res.stderr}`.trim()
    }
  }
  if (!(await exists(`${target}.pub`))) {
    return {
      ok: false,
      path: null,
      message: `ssh-keygen reported success but ${target}.pub is not there.`
    }
  }
  return { ok: true, path: target, message: `Created ${target}.` }
}

/* --------------------------------------------------------------- the probe */

/**
 * Does public-key authentication actually work for this host?
 *
 * `BatchMode=yes` guarantees the connection cannot prompt, so it either
 * succeeds on the key or exits non-zero — which is what makes this the only
 * evidence allowed to set `keyEnrolled`.
 */
export async function verifyPubkeyAuth(
  host: SshHost,
  keyPath: string,
  deps: EnrollDeps = {}
): Promise<{ ok: boolean; message: string }> {
  const args = buildPubkeyProbeArgs(host, keyPath)
  if (!args) {
    return { ok: false, message: `Stoke will not use "${host.alias.trim()}" as an ssh destination.` }
  }
  const res = await (deps.exec ?? defaultExec)(sshExecutable(), args, PROBE_TIMEOUT_MS)
  if (res.ok) return { ok: true, message: '' }
  return { ok: false, message: (res.stderr || res.error || '').trim() }
}

/* ------------------------------------------------------------- the install */

/**
 * Escape sequences, so what reaches the pane is text rather than half a
 * repaint. Written with `\u001b` rather than a raw byte for sshAuth.ts's
 * reason: a literal control character in source survives npm but not every
 * editor, diff or paste.
 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g

function clean(text: string): string {
  return text.replace(ANSI, '').replace(/\r/g, '').trim()
}

/**
 * Run the install in a PTY and forward what it prints.
 *
 * A PTY rather than `execFile` for exactly one reason: ssh reads a password
 * from a terminal and refuses to take one any other way, so this is what lets
 * the user type it somewhere Stoke is not. Nothing is ever written INTO this
 * PTY from here — no keystroke this process invents reaches it — and it is not
 * a `PtyManager` session, so it is in no tab, in no `tabs:save` state (gotcha
 * 35 would otherwise bring an `ssh-copy-id` back at the next launch), in no
 * `statusKeys()`, and carries no `sshAuth` scan: its own password prompt would
 * otherwise offer to fix itself, forever (gotcha 75).
 */
async function runInstall(
  file: string,
  args: string[],
  emit: (line: string) => void,
  deps: EnrollDeps
): Promise<{ exitCode: number; timedOut: boolean; error: string | null }> {
  const spawn = deps.spawnPty ?? defaultSpawnPty
  // buildPtyEnv, not a second copy of the env list: gotcha 1's whole lesson is
  // that the copies drift.
  const env = await buildPtyEnv()
  const pty = await spawn(file, args, env, (deps.home ?? homedir)())

  return await new Promise((resolve) => {
    let pending = ''
    let lines = 0
    let lastPartial = ''
    let timedOut = false
    let settled = false
    let deadline: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined

    const say = (text: string): void => {
      const line = clean(text)
      if (!line) return
      if (lines >= MAX_OUTPUT_LINES) return
      lines += 1
      emit(line)
    }

    const finish = (exitCode: number, error: string | null): void => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      if (grace) clearTimeout(grace)
      say(pending)
      resolve({ exitCode, timedOut, error })
    }

    pty.onData((data) => {
      pending += data
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ''
      for (const part of parts) say(part)
      /*
       * The password prompt is the one line that matters here and it never
       * arrives with a newline — that is gotcha 75's tail rule seen from the
       * other side. Emitted once, when the held remainder is prompt-shaped, so
       * the pane shows what is being asked instead of an empty box the user is
       * supposed to guess at.
       */
      const partial = clean(pending)
      if (partial && partial !== lastPartial && partial.endsWith(':')) {
        lastPartial = partial
        say(partial)
        pending = ''
      }
    })

    pty.onExit(({ exitCode }) => finish(exitCode, null))

    deadline = setTimeout(() => {
      timedOut = true
      try {
        pty.kill()
      } catch {
        /* already gone */
      }
      // The canonical timeout sentence, from the function that gets the
      // `killed: true, code: null` shape right (gotcha 25).
      const error = describeExecError(
        { killed: true, signal: 'SIGTERM' },
        basename(file),
        INSTALL_TIMEOUT_MS
      )
      // Resolve even if the exit never arrives: a PTY whose child ignored the
      // kill must not hold this promise, and the caller has to be able to say
      // so rather than spin.
      grace = setTimeout(() => finish(-1, error), KILL_GRACE_MS)
    }, INSTALL_TIMEOUT_MS)
  })
}

/* --------------------------------------------------------- the orchestrator */

/**
 * Hosts with an enrollment running.
 *
 * Claimed BEFORE the first await and refused on re-entry (gotchas 20 and 66):
 * two presses of a button that spawns a terminal would otherwise produce two
 * terminals, both prompting, and a second `ssh-keygen` racing the first over
 * the same file name. index.ts keeps its own claim on the same host as well,
 * because `shouldOfferKey` has to read it synchronously from inside `onData`,
 * where awaiting a lazy import of this module is not an option.
 */
const inFlight = new Set<string>()

export function isEnrolling(hostId: string): boolean {
  return inFlight.has(hostId)
}

/**
 * Put a key on `host`, reporting every stage.
 *
 * The order is the argument: find or make a key, install it, then PROVE it.
 * Only the last step may report success, and it is a separate connection
 * precisely because the install's own exit status cannot answer the question.
 */
export async function enroll(host: SshHost, deps: EnrollDeps = {}): Promise<EnrollResult> {
  const emit = deps.emit ?? ((): void => {})
  const say = (stage: SshEnrollEvent['stage'], message: string, ok?: boolean): void => {
    emit(
      ok === undefined
        ? { hostId: host.id, stage, message }
        : { hostId: host.id, stage, message, ok }
    )
  }

  // Claimed before anything can await. A second press is refused rather than
  // queued: the first one owns a PTY the user is looking at.
  if (inFlight.has(host.id)) {
    return {
      ok: false,
      installed: false,
      keyPath: null,
      message: 'An enrollment for this host is already running.'
    }
  }
  inFlight.add(host.id)
  try {
    return await enrollOnce(host, deps, say)
  } finally {
    inFlight.delete(host.id)
  }
}

async function enrollOnce(
  host: SshHost,
  deps: EnrollDeps,
  say: (stage: SshEnrollEvent['stage'], message: string, ok?: boolean) => void
): Promise<EnrollResult> {
  const alias = host.alias.trim()
  const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'))

  /*
   * Refuse, never escape. `isEnrollableAlias` is stricter than the predicate
   * that decides what to offer in a list: `ssh-copy-id` has no `--` in its
   * usage line, so an alias that looks like an option becomes one (gotcha 75).
   */
  if (!isEnrollableAlias(alias)) {
    const message = `Stoke will not hand "${alias}" to ssh-copy-id as a destination. Run \`ssh-copy-id\` yourself if that really is the machine you mean.`
    say('failed', message)
    return { ok: false, installed: false, keyPath: null, message }
  }

  say('starting', `Looking for a key to use for ${alias}.`)

  let keyPath = await resolveIdentity(alias, deps)
  if (keyPath) {
    say('starting', `Using the key ssh already resolves for this host: ${keyPath}`)
  } else {
    say('generating', 'No key with a public half yet. Making one.')
    const made = await generateKey(host.label || alias, deps)
    if (!made.ok || !made.path) {
      say('failed', made.message)
      return { ok: false, installed: false, keyPath: null, message: made.message }
    }
    keyPath = made.path
    say('generating', made.message)
  }

  const pubPath = `${keyPath}.pub`
  let pubLine = ''
  try {
    pubLine = (await readText(pubPath)).split(/\r?\n/)[0]?.trim() ?? ''
  } catch (err) {
    const message = `Could not read ${pubPath}: ${(err as Error).message}`
    say('failed', message)
    return { ok: false, installed: false, keyPath, message }
  }

  /*
   * ssh-copy-id where there is one, plain ssh where there is not — Windows
   * ships none, because it is a `#!/bin/sh` script. The fallback is the path
   * that has to embed the key in a remote shell command, so it is the one
   * `isSafePublicKeyLine` gates; `buildEnrollFallbackArgs` returns null rather
   * than quoting anything it does not recognise.
   */
  const copyId = sshCopyIdExecutable()
  const file = copyId ?? sshExecutable()
  const args = copyId ? buildCopyIdArgs(host, pubPath) : buildEnrollFallbackArgs(host, pubLine)
  if (!args) {
    const message = copyId
      ? `Stoke will not hand "${alias}" to ssh-copy-id as a destination.`
      : `This machine has no ssh-copy-id, and ${pubPath} is not in a form Stoke will put inside a remote command. Run \`ssh-copy-id\` from a shell instead.`
    say('failed', message)
    return { ok: false, installed: false, keyPath, message }
  }

  say(
    'installing',
    `Running ${basename(file)} against ${alias}. Type your password when it asks — it goes straight to ssh, and Stoke never sees it.`
  )
  let run: { exitCode: number; timedOut: boolean; error: string | null }
  try {
    run = await runInstall(file, args, (line) => say('installing', line), deps)
  } catch (err) {
    const message = `Could not start ${basename(file)}: ${(err as Error).message}`
    say('failed', message)
    return { ok: false, installed: false, keyPath, message }
  }

  if (run.timedOut) {
    const message = run.error ?? `${basename(file)} did not finish and was stopped.`
    say('failed', message)
    return { ok: false, installed: false, keyPath, message }
  }
  if (run.exitCode !== 0) {
    say('installing', `${basename(file)} exited with code ${run.exitCode}.`)
  }

  /*
   * Verified even when the install exited non-zero. The two answers are
   * genuinely independent: ssh-copy-id can fail having already appended the key
   * on an earlier attempt, and it can succeed against a server that will never
   * accept it. Only this connection knows.
   */
  say('verifying', `Checking that ${alias} accepts the key without a password.`)
  const probe = await verifyPubkeyAuth(host, keyPath, deps)
  if (probe.ok) {
    const message = `${alias} now accepts ${keyPath}. No password next time.`
    say('done', message, true)
    return { ok: true, installed: true, keyPath, message }
  }

  const message = [
    `The key reached ${alias}, but it still will not authenticate with it.`,
    'The usual causes are `PubkeyAuthentication no` in the remote sshd_config, an `AuthorizedKeysFile` pointing somewhere else, or a group-writable home directory — sshd ignores the file silently in that last case.',
    probe.message ? `ssh said: ${probe.message}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  say('done', message, false)
  return { ok: false, installed: true, keyPath, message }
}
