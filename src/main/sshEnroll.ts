/**
 * Setting up key login for a host that asks for a password.
 *
 * The impure half of the feature whose rules live in `src/shared/sshAuth.ts`
 * (detection, the remote command) and `src/main/ssh.ts` (argv, the config
 * block). Everything that touches the disk or runs ssh is here; nothing here
 * decides what may be offered (`shouldOfferKey`) or what a command looks like.
 *
 * The work is split around the one step Stoke cannot do for the user:
 *
 *   prepareEnroll   find or make a key, make plain `ssh <alias>` offer it,
 *                   read its public half, build the install argv
 *   (the install)   `ssh-copy-id` in a VISIBLE Stoke tab — a PtyManager
 *                   session launched by `launchSession` with `opts.enroll` —
 *                   where the user types the password, once
 *   finishEnroll    when that tab's process exits: prove the tab's own
 *                   connection now gets in without a password
 *
 * **Why the install is a tab, and why that is the whole fix (gotcha 109).** The
 * first version ran `ssh-copy-id` in a private node-pty that "nothing is ever
 * written INTO". ssh reads a password from its controlling terminal and from
 * nowhere else, so that prompt could never be answered: it sat for 180 s and
 * was killed, on every host, every time. Every suite passed, because every one
 * injected a fake spawner that exited on cue. A tab is a terminal the user can
 * type into, the keystrokes travel on the existing `pty:write` path, and no
 * new channel ever carries a secret.
 *
 * Three properties are not negotiable:
 *
 * 1. **The renderer names a host by id and nothing else.** `planEnrollLaunch`
 *    takes `opts.enroll.hostId` and the size, looks the host up in settings,
 *    and builds every other field itself — so no argv, path or alias from the
 *    renderer (or from what the far end printed) reaches a spawn.
 * 2. **Stoke never sees the password.** ssh reads it with echo off in the tab.
 * 3. **Success is claimed only when a connection proves it** — the connection
 *    the tab itself will make (`buildLoginProbeArgs`: no `-i`, no
 *    `IdentitiesOnly`). A key the server accepts but plain ssh never offers is
 *    a failure, and says so.
 *
 * Every side effect is injectable, with real defaults — paths included, so a
 * suite never writes the real `~/.ssh` (gotcha 74).
 */
import { execFile } from 'node:child_process'
import { access, chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { LaunchOptions, SshEnrollEvent, SshHost } from '@shared/types'
// Relative and with the extension, like the rest of src/main: this module is
// loaded directly under `node --experimental-strip-types`, which resolves no
// aliases. The type-only import above is erased, so it may use either.
import { isEnrollableAlias } from '../shared/sshAuth.ts'
import {
  appendIdentityBlock,
  buildCopyIdArgs,
  buildEnrollFallbackArgs,
  buildIdentityBlock,
  buildLoginProbeArgs,
  buildPubkeyProbeArgs,
  identityFilesFromSshG,
  sshConfigHostPattern,
  sshConfigPath,
  sshChildEnv,
  sshCopyIdExecutable,
  sshExecutable
} from './ssh.ts'
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

/** `access` under a deadline, never `existsSync` (gotcha 40). */
const EXISTS_DEADLINE_MS = 1500

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

export interface EnrollDeps {
  /** Progress, for the strip. The only channel out. */
  emit?: (event: SshEnrollEvent) => void
  exec?: ExecRun
  exists?: (path: string) => Promise<boolean>
  readText?: (path: string) => Promise<string>
  /** Where a new key is made. Default `~/.ssh`. */
  sshDir?: string
  /** The file an `IdentityFile` block is appended to. Default `~/.ssh/config`. */
  configFile?: string
  /** For `~` in `ssh -G`'s output. Default `homedir()`. */
  home?: string
  /** `ssh-copy-id`, or null for the plain-ssh fallback. Default: looked up. */
  copyId?: string | null
}

/** The program the enrollment tab runs, built here and nowhere else. */
export interface EnrollCommand {
  file: string
  args: string[]
}

/* ---------------------------------------------------------------- defaults */

/**
 * Every program run here is OpenSSH's (`ssh -G`, `ssh-keygen`, the probes), so
 * each gets `sshChildEnv` (gotcha 153).
 */
function defaultExec(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true, env: sshChildEnv() },
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
  // Async and bounded, like projects.ts's `pathExists` (gotcha 40).
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

function sshDirOf(deps: EnrollDeps): string {
  return deps.sshDir ?? join(homedir(), '.ssh')
}

/** Is `path` one of `list`? Case-folded on Windows, whose paths are. */
function listed(list: string[], path: string): boolean {
  if (process.platform !== 'win32') return list.includes(path)
  const want = path.toLowerCase()
  return list.some((p) => p.toLowerCase() === want)
}

/* ------------------------------------------------------ the launch, by id */

/**
 * The only way a renderer request becomes an enrollment launch.
 *
 * Takes `hostId`, `cols` and `rows` from the request and NOTHING else: not
 * `host` (an alias a renderer could have typed), not `extraArgs`, not
 * `install`, not `cli`, not `cwd`. The host comes from settings by id, and the
 * options handed to `PtyManager.start` are built here from scratch, so the
 * program the tab runs is always `prepareEnroll`'s, against a destination the
 * user typed into Settings themselves (gotcha 75).
 */
export function planEnrollLaunch(
  requested: LaunchOptions,
  hosts: SshHost[]
): { ok: true; host: SshHost; opts: LaunchOptions } | { ok: false; message: string } {
  const hostId = requested.enroll?.hostId
  if (typeof hostId !== 'string' || !hostId) return { ok: false, message: 'No host was named.' }
  const host = hosts.find((h) => h.id === hostId)
  if (!host) return { ok: false, message: 'That host is no longer in Settings.' }
  const cols = typeof requested.cols === 'number' && Number.isFinite(requested.cols) ? requested.cols : 120
  const rows = typeof requested.rows === 'number' && Number.isFinite(requested.rows) ? requested.rows : 30
  return {
    ok: true,
    host,
    opts: {
      // pty.ts runs an enrollment from the home folder whatever this says.
      cwd: '',
      permissionMode: 'default',
      model: '',
      effort: 'default',
      cols,
      rows,
      enroll: { hostId: host.id }
    }
  }
}

/* ------------------------------------------------------------ the identity */

/**
 * What `ssh -G <alias>` says plain ssh will offer, and the first of those with
 * a `.pub` beside it.
 *
 * Preferring a key ssh already names means a user who has a key and has pointed
 * the config at it gets THAT key installed, rather than a second one minted
 * beside it. Without the public half there is nothing to install, and deriving
 * one would mean reading a private key Stoke has no business opening.
 */
export async function resolveIdentity(
  alias: string,
  deps: EnrollDeps = {}
): Promise<{ key: string | null; identityFiles: string[]; ok: boolean }> {
  const name = alias.trim()
  if (!isEnrollableAlias(name)) return { key: null, identityFiles: [], ok: false }
  const exec = deps.exec ?? defaultExec
  const exists = deps.exists ?? defaultExists

  const res = await exec(sshExecutable(), ['-G', name], CONFIG_TIMEOUT_MS)
  if (!res.ok && !res.stdout) return { key: null, identityFiles: [], ok: false }
  const identityFiles = identityFilesFromSshG(res.stdout, deps.home)
  for (const path of identityFiles) {
    if (await exists(`${path}.pub`)) return { key: path, identityFiles, ok: true }
  }
  return { key: null, identityFiles, ok: true }
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
 * `~/.ssh/id_ed25519` first, because it is one of ssh's default identities —
 * with no `IdentityFile` in the config, plain ssh offers it with no help. Then
 * `~/.ssh/stoke_ed25519`, for the machine whose `id_ed25519` has no `.pub`
 * beside it; that name is not a default, so `saveKeyLocally` then adds it to
 * the config. If both private files exist this STOPS, because a third invented
 * name is a key the user will find later and not recognise.
 *
 * **No passphrase, deliberately.** ssh-keygen takes one from the tty or from
 * `-N` on argv, and argv is world-readable through `ps` (gotcha 13, one step
 * further: not "it gets mangled" but "it gets read"). `Overwrite (y/n)?` is
 * never relied on either: under execFile there is no tty to answer it, so the
 * candidates are checked first and a taken name is never passed.
 */
export async function generateKey(label: string, deps: EnrollDeps = {}): Promise<GeneratedKey> {
  const exec = deps.exec ?? defaultExec
  const exists = deps.exists ?? defaultExists
  const sshDir = sshDirOf(deps)

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
    await mkdir(sshDir, { recursive: true, mode: 0o700 })
  } catch (err) {
    return { ok: false, path: null, message: `Could not create ${sshDir}: ${(err as Error).message}` }
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
    return { ok: false, path: null, message: res.error ?? `ssh-keygen failed. ${res.stderr}`.trim() }
  }
  if (!(await exists(`${target}.pub`))) {
    return { ok: false, path: null, message: `ssh-keygen reported success but ${target}.pub is not there.` }
  }
  return { ok: true, path: target, message: `Created ${target}.` }
}

/* ------------------------------------------------- the key, saved locally */

/**
 * Append `block` to the ssh config at `file`, atomically, keeping a backup.
 *
 * Append-only: the bytes already in the file are written back unchanged, as
 * bytes — decoding and re-encoding could alter a file that is not valid UTF-8
 * — with the block after them. The previous file is copied to
 * `<file>.stoke.bak` first (`.stoke.bak`, not `.bak`, so a backup the user
 * made themselves is never overwritten), and the new one is written to a
 * temporary sibling and renamed over, so a crash leaves the old file or the new
 * one, never half of either. A symlinked config (a dotfiles repo) is followed
 * and its TARGET rewritten, so the link survives. The file's own mode is kept,
 * `0600` for a new one: ssh refuses a config others can write.
 */
export async function appendToSshConfig(file: string, block: string): Promise<{ target: string; backup: string | null }> {
  let target = file
  try {
    target = await realpath(file)
  } catch {
    /* No file yet — it is created below. */
  }
  let existing = Buffer.alloc(0)
  let mode = 0o600
  let had = false
  try {
    existing = await readFile(target)
    mode = (await stat(target)).mode & 0o777
    had = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })

  // The pure rule decides the suffix; latin1 maps every byte to one char, so
  // the prefix check below is a byte-for-byte check.
  const before = existing.toString('latin1')
  const joined = appendIdentityBlock(before, block)
  if (!joined.startsWith(before)) throw new Error('refusing a config write that would change existing lines')
  const next = Buffer.concat([existing, Buffer.from(joined.slice(before.length), 'utf8')])

  let backup: string | null = null
  if (had) {
    backup = `${target}.stoke.bak`
    await copyFile(target, backup)
  }
  const tmp = `${target}.stoke-tmp-${process.pid}`
  try {
    await writeFile(tmp, next, { mode })
    if (process.platform !== 'win32') await chmod(tmp, mode)
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return { target, backup }
}

/**
 * Make plain `ssh <alias>` offer `keyPath`, and prove it did.
 *
 * Nothing is written when `ssh -G` already lists the key — the common case,
 * `~/.ssh/id_ed25519` on a config that names no identity. Otherwise one
 * `Host <pattern>` / `IdentityFile` block is appended (`buildIdentityBlock`:
 * append-only, refuses an alias it cannot express safely), and `ssh -G` is
 * asked again: a config ssh does not actually read — an `ssh -F` wrapper, a
 * `Match` that excludes the block — has to fail here rather than as a password
 * prompt on the next connect.
 */
export async function saveKeyLocally(
  host: SshHost,
  keyPath: string,
  identityFiles: string[],
  deps: EnrollDeps = {}
): Promise<{ ok: boolean; wrote: string | null; message: string }> {
  if (listed(identityFiles, keyPath)) return { ok: true, wrote: null, message: '' }
  const alias = host.alias.trim()
  const block = buildIdentityBlock(alias, keyPath)
  if (!block) {
    const pattern = sshConfigHostPattern(alias)
    return {
      ok: false,
      wrote: null,
      message: pattern
        ? `Stoke will not write ${keyPath} into your ssh config (the path has a character ssh would read differently). Add \`IdentityFile\` for it under \`Host ${pattern}\` yourself, then try again.`
        : `Stoke cannot write a \`Host\` line for "${alias}" safely. Add \`IdentityFile ${keyPath}\` for that host in your ssh config yourself, then try again.`
    }
  }
  const file = deps.configFile ?? sshConfigPath()
  let wrote: string
  try {
    wrote = (await appendToSshConfig(file, block)).target
  } catch (err) {
    return { ok: false, wrote: null, message: `Could not add ${keyPath} to ${file}: ${(err as Error).message}` }
  }
  const again = await resolveIdentity(alias, deps)
  if (!listed(again.identityFiles, keyPath)) {
    return {
      ok: false,
      wrote,
      message: `Stoke added ${keyPath} to ${wrote}, but \`ssh -G ${alias}\` still does not list it, so ssh would not offer it. Something else decides this host's identities (a Match block, or ssh run with -F).`
    }
  }
  return { ok: true, wrote, message: `Added ${keyPath} to ${wrote} for ${alias}.` }
}

/* -------------------------------------------------------------- prepare */

export type PrepareResult =
  | { ok: true; command: EnrollCommand; keyPath: string; fallback: boolean }
  | { ok: false; message: string }

/**
 * Everything before the password: a key, a config that offers it, and the
 * install command for the tab. Emits each stage; on failure emits `failed`.
 */
export async function prepareEnroll(host: SshHost, deps: EnrollDeps = {}): Promise<PrepareResult> {
  const emit = deps.emit ?? ((): void => {})
  const say = (stage: SshEnrollEvent['stage'], message: string): void => emit({ hostId: host.id, stage, message })
  const fail = (message: string): PrepareResult => {
    say('failed', message)
    return { ok: false, message }
  }
  const alias = host.alias.trim()
  const readText = deps.readText ?? ((p: string) => readFile(p, 'utf8'))

  /*
   * Refuse, never escape. `isEnrollableAlias` is stricter than the predicate
   * that decides what to offer in a list: `ssh-copy-id` has no `--` in its
   * usage line, so an alias that looks like an option becomes one (gotcha 75).
   */
  if (!isEnrollableAlias(alias)) {
    return fail(
      `Stoke will not hand "${alias}" to ssh-copy-id as a destination. Run \`ssh-copy-id\` yourself if that really is the machine you mean.`
    )
  }

  say('starting', `Looking for a key to use for ${alias}.`)
  const found = await resolveIdentity(alias, deps)
  if (!found.ok) return fail(`\`ssh -G ${alias}\` did not answer, so Stoke cannot tell which key ssh would use.`)

  let keyPath = found.key
  if (!keyPath) {
    say('generating', 'No key with a public half yet. Making one.')
    const made = await generateKey(host.label || alias, deps)
    if (!made.ok || !made.path) return fail(made.message)
    keyPath = made.path
    say('generating', made.message)
  }

  const saved = await saveKeyLocally(host, keyPath, found.identityFiles, deps)
  if (!saved.ok) return fail(saved.message)
  if (saved.wrote) say('generating', saved.message)

  const pubPath = `${keyPath}.pub`
  let pubLine = ''
  try {
    pubLine = (await readText(pubPath)).split(/\r?\n/)[0]?.trim() ?? ''
  } catch (err) {
    return fail(`Could not read ${pubPath}: ${(err as Error).message}`)
  }

  /*
   * ssh-copy-id where there is one, plain ssh where there is not — Windows
   * ships none, because it is a `#!/bin/sh` script. The fallback embeds the key
   * in a remote shell command, so it is the one `isSafePublicKeyLine` gates.
   */
  const copyId = deps.copyId !== undefined ? deps.copyId : sshCopyIdExecutable()
  const file = copyId ?? sshExecutable()
  const args = copyId ? buildCopyIdArgs(host, pubPath) : buildEnrollFallbackArgs(host, pubLine)
  if (!args) {
    return fail(
      copyId
        ? `Stoke will not hand "${alias}" to ssh-copy-id as a destination.`
        : `This machine has no ssh-copy-id, and ${pubPath} is not in a form Stoke will put inside a remote command. Run \`ssh-copy-id\` from Git Bash instead.`
    )
  }

  say(
    'installing',
    `Type the password for ${alias} in the “Add key” tab. It goes straight to ssh; Stoke never sees it.`
  )
  return { ok: true, command: { file, args }, keyPath, fallback: !copyId }
}

/* --------------------------------------------------------------- finish */

/** What `finishEnroll` tells index.ts, which persists `keyEnrolled`. */
export interface EnrollResult {
  /** The tab's own connection got in on a key. The only thing that may set keyEnrolled. */
  ok: boolean
  /** The server accepts the key (the login probe, or failing that the `-i` probe). */
  installed: boolean
  message: string
}

async function probe(args: string[] | null, deps: EnrollDeps): Promise<{ ok: boolean; message: string }> {
  if (!args) return { ok: false, message: 'Stoke will not use that alias as an ssh destination.' }
  const res = await (deps.exec ?? defaultExec)(sshExecutable(), args, PROBE_TIMEOUT_MS)
  if (res.ok) return { ok: true, message: '' }
  return { ok: false, message: (res.stderr || res.error || '').trim() }
}

/**
 * The install tab has exited. Did it work — for the tab, not just the server?
 *
 * Runs whatever the exit code said: `ssh-copy-id` can fail having appended the
 * key on an earlier attempt, succeed against a server that will never accept
 * it, or be closed by the user after it already finished. Only a connection
 * knows, and only `buildLoginProbeArgs`' connection may report success.
 */
export async function finishEnroll(
  host: SshHost,
  keyPath: string,
  exitCode: number,
  fallback: boolean,
  deps: EnrollDeps = {},
  /** The signal the tab's process died of — set when the user closed the tab. */
  signal?: number
): Promise<EnrollResult> {
  const emit = deps.emit ?? ((): void => {})
  const alias = host.alias.trim()
  const say = (stage: SshEnrollEvent['stage'], message: string, ok?: boolean): void =>
    emit(ok === undefined ? { hostId: host.id, stage, message } : { hostId: host.id, stage, message, ok })

  say('verifying', `Checking that \`ssh ${alias}\` now gets in without a password.`)
  const login = await probe(buildLoginProbeArgs(host), deps)
  if (login.ok) {
    const message = `${alias} now lets you in with ${keyPath}. No password next time.`
    say('done', message, true)
    return { ok: true, installed: true, message }
  }

  // Only to word the failure: does the SERVER take this key at all?
  const direct = await probe(buildPubkeyProbeArgs(host, keyPath), deps)
  if (direct.ok) {
    const message = [
      `The key is on ${alias} and the server accepts it, but \`ssh ${alias}\` does not offer ${keyPath}, so it would still ask for a password.`,
      `Check \`ssh -G ${alias} | grep identityfile\`; an \`IdentitiesOnly yes\` with another key, or an agent offering too many keys first, are the usual causes.`,
      login.message ? `ssh said: ${login.message}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    say('done', message, false)
    return { ok: false, installed: true, message }
  }

  if (signal) {
    // The user closed the "Add key" tab. Its exit code then says nothing, and
    // "the install reported success" below would be a sentence about a kill.
    const message = `The “Add key” tab was closed before ssh-copy-id finished, so no key was added to ${alias}.`
    say('failed', message)
    return { ok: false, installed: false, message }
  }

  if (exitCode !== 0) {
    const message = [
      fallback
        ? `Adding the key to ${alias} did not finish (exit ${exitCode}). If that machine's login shell is not a POSIX shell — a Windows OpenSSH server, say — run \`ssh-copy-id\` from Git Bash, or add ${keyPath}.pub to its authorized_keys by hand.`
        : `ssh-copy-id did not finish (exit ${exitCode}); what it printed is in the “Add key” tab.`,
      direct.message ? `ssh said: ${direct.message}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    say('failed', message)
    return { ok: false, installed: false, message }
  }

  const message = [
    `The install reported success, but ${alias} still will not take ${keyPath}.`,
    'The usual causes are `PubkeyAuthentication no` in the remote sshd_config, an `AuthorizedKeysFile` pointing somewhere else, or a group-writable home directory — sshd ignores the file silently in that last case. A key with a passphrase also cannot be tried here unless ssh-agent holds it.',
    direct.message ? `ssh said: ${direct.message}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  say('done', message, false)
  return { ok: false, installed: false, message }
}
