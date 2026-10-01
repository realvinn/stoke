/*
 * `stoke-hub`: the command the NUC runs. Node 24, no dependencies beyond the
 * repo's own `ws`:
 *
 *   node --experimental-strip-types hub/server.ts serve     (from a checkout)
 *   node stoke-hub.mjs serve                                (the bundle: npm run build:hub)
 *
 * Subcommands (hub/README.md has the runbook):
 *   serve                         run the hub (SIGTERM/SIGINT stop it gracefully)
 *   invite [--role member|owner]  mint an invite and print it
 *   backup <dir> [--keep 14]      a consistent copy of the database (VACUUM INTO), keeping the newest N
 *   reset-password <email> [--sign-out]   new password from stdin, or a generated one on a terminal
 *   health [--url <hub base>]     ask a hub whether it is up (the local edge listener by default)
 *   version | help
 *
 * Every subcommand but `health` needs the data directory: --data <dir>,
 * STOKE_HUB_DATA, or systemd's STATE_DIRECTORY.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { emailThrottleKey, ensureBootstrapInvite, bootstrapAnnouncement, HUB_SERVER_VERSION, mintInvite, startHub, type HubHandle } from './app.ts'
import { configFrom, dataDirFrom, DEFAULT_EDGE_LISTEN, parseListen, parseMount, readEdgeSecret } from './config.ts'
import { HubLog, type LogLevel } from './log.ts'
import { DB_FILE, HubStore } from './store.ts'
import { INVITE_TTL_MS, normalizeEmail, passwordProblem } from '../src/shared/hub/auth.ts'
import { base32Encode, groupsOf } from '../src/shared/hub/codec.ts'
import { hubEndpoint } from '../src/shared/hub/edge.ts'
import { HUB_HEADERS, readHubResponse } from '../src/shared/hub/protocol.ts'
import { hashPassword, randomU8 } from '../src/main/hub/crypto.ts'

const BOOLEAN_FLAGS = new Set(['sign-out', 'help'])

function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Record<string, string | undefined> } {
  const flags: Record<string, string | undefined> = {}
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq)
      if (eq >= 0) flags[name] = a.slice(eq + 1)
      else if (BOOLEAN_FLAGS.has(name)) flags[name] = 'true'
      else flags[name] = argv[++i]
    } else args.push(a)
  }
  return { cmd: args.shift() ?? 'serve', args, flags }
}

const HELP = `stoke-hub ${HUB_SERVER_VERSION} — Stoke's sync and remote hub

  stoke-hub serve                          run it (env: STOKE_HUB_DATA, STOKE_HUB_LISTEN,
                                           STOKE_HUB_LAN, STOKE_HUB_MOUNT, HUB_EDGE_SECRET[_FILE])
  stoke-hub invite [--role member|owner]   mint a one-use invite (7 days)
  stoke-hub backup <dir> [--keep 14]       consistent copy of the database into <dir>
  stoke-hub reset-password <email> [--sign-out]
  stoke-hub health [--url <hub base>]
  stoke-hub version

Every command but health takes --data <dir> (or STOKE_HUB_DATA / STATE_DIRECTORY).
`

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

/**
 * A command's refusal. Thrown, never `process.exit`: stdout and stderr are
 * asynchronous on a macOS pipe, so an exit here could drop the very sentence
 * saying why. `main` sets the exit code and lets the loop drain.
 */
class CliExit extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

function fail(message: string, code = 1): never {
  throw new CliExit(message, code)
}

/** Exit once stdout has drained, or after `graceMs` if something still holds the loop open. */
function exitSoon(code: number, graceMs = 2000): void {
  process.exitCode = code
  setTimeout(() => process.exit(code), graceMs).unref()
}

async function serve(flags: Record<string, string | undefined>): Promise<void> {
  // Everything the hub writes (the database, its WAL) is the owner's alone.
  process.umask(0o077)
  const env = process.env
  const log = new HubLog((line) => process.stdout.write(`${line}\n`), { level: (env.STOKE_HUB_LOG_LEVEL as LogLevel) || 'info' })
  let hub: HubHandle
  try {
    hub = await startHub(configFrom(env, flags), { log, announce: (text) => process.stdout.write(text) })
  } catch (err) {
    log.error('could not start', { err })
    exitSoon(1)
    return
  }
  let stopping = false
  const stop = (why: string, code: number): void => {
    if (stopping) {
      log.warn('asked again while stopping: exiting without waiting', { why })
      process.exit(1)
    }
    stopping = true
    log.info('stopping on request', { why })
    hub.close().then(
      () => exitSoon(code),
      (err) => {
        log.error('shutdown failed', { err })
        exitSoon(1)
      }
    )
  }
  process.on('SIGTERM', () => stop('SIGTERM', 0))
  process.on('SIGINT', () => stop('SIGINT', 0))
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err })
    stop('uncaughtException', 1)
  })
}

function openStore(flags: Record<string, string | undefined>): HubStore {
  const dir = dataDirFrom(process.env, flags.data)
  if (!existsSync(join(dir, DB_FILE))) fail(`there is no hub database in ${dir} (start the hub once with serve first).`)
  return HubStore.open(dir)
}

function invite(flags: Record<string, string | undefined>): void {
  process.umask(0o077)
  const role = flags.role ?? 'member'
  if (role !== 'member' && role !== 'owner') fail('--role is member or owner.')
  const store = openStore(flags)
  try {
    const now = Date.now()
    const boot = ensureBootstrapInvite(store, now)
    if (boot) {
      out(bootstrapAnnouncement(boot.invite))
      return
    }
    const minted = mintInvite(store, { role, kind: 'cli', createdBy: null, now, ttlMs: INVITE_TTL_MS })
    out(`Invite for a new ${role} (one use, until ${new Date(minted.expiresAt).toISOString()}):\n  ${minted.invite}`)
  } finally {
    store.close()
  }
}

/** `hub-YYYYMMDD-HHMM.db`, local time; seconds are added if two backups land in one minute. */
function backupName(d: Date, withSeconds: boolean): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `hub-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${withSeconds ? p(d.getSeconds()) : ''}.db`
}

function backup(args: string[], flags: Record<string, string | undefined>): void {
  process.umask(0o077)
  const dir = args[0]
  if (!dir) fail('backup needs a directory: stoke-hub backup /var/backups/stoke-hub')
  const keep = Number(flags.keep ?? 14)
  if (!Number.isInteger(keep) || keep < 1) fail('--keep is a whole number from 1.')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const store = openStore(flags)
  const now = new Date()
  let target = join(dir, backupName(now, false))
  if (existsSync(target)) target = join(dir, backupName(now, true))
  try {
    store.vacuumInto(target)
  } finally {
    store.close()
  }
  chmodSync(target, 0o600)
  const olds = readdirSync(dir)
    .filter((f) => /^hub-\d{8}-\d{4}(\d{2})?\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep)
  for (const f of olds) rmSync(join(dir, f), { force: true })
  out(`backup written: ${target}${olds.length ? ` (removed ${olds.length} older)` : ''}`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function resetPassword(args: string[], flags: Record<string, string | undefined>): Promise<void> {
  process.umask(0o077)
  const email = normalizeEmail(args[0])
  if (!email) fail('reset-password needs the account’s email.')
  let password: string
  let generated = false
  if (process.stdin.isTTY) {
    password = groupsOf(base32Encode(randomU8(15)), 4)
    generated = true
  } else {
    password = (await readStdin()).split(/\r?\n/, 1)[0]
  }
  const problem = passwordProblem(password)
  if (problem) fail(problem)
  const store = openStore(flags)
  try {
    const account = store.accountByEmail(email)
    if (!account) fail(`no account on this hub has the email ${email}.`, 2)
    store.setPasswordHash(account.id, await hashPassword(password))
    store.clearThrottle(emailThrottleKey(email))
    const ended = flags['sign-out'] ? store.deleteAccountSessions(account.id) : 0
    out(
      `Password reset for ${email}.` +
        (generated ? `\n  New password: ${password}` : '') +
        (flags['sign-out'] ? `\n  Signed out ${ended} session(s); a running hub closes their connections within a minute, and each device signs in again with the new password.` : '\n  Existing sessions were kept (--sign-out ends them).') +
        '\n  Nothing anyone can decrypt changed: the password opens no key.'
    )
  } finally {
    store.close()
  }
}

async function health(flags: Record<string, string | undefined>): Promise<void> {
  const env = process.env
  let base: string
  const headers: Record<string, string> = {}
  if (flags.url) base = flags.url.replace(/\/+$/, '')
  else {
    const at = parseListen(env.STOKE_HUB_LISTEN ?? DEFAULT_EDGE_LISTEN, 'STOKE_HUB_LISTEN')
    if (!at) fail('no edge listener is configured; pass --url.')
    const host = at.host === '0.0.0.0' || at.host === '::' ? '127.0.0.1' : at.host.includes(':') ? `[${at.host}]` : at.host
    base = `http://${host}:${at.port}${parseMount(env.STOKE_HUB_MOUNT)}`
    const secret = readEdgeSecret(env)
    if (secret) headers[HUB_HEADERS.edge] = secret
  }
  let res: Response
  try {
    res = await fetch(hubEndpoint(base, '/v1/health'), { headers, signal: AbortSignal.timeout(5000) })
  } catch (err) {
    fail(`${base} did not answer: ${(err as Error).message}`)
  }
  const read = readHubResponse(res.status, res.headers.get('content-type'), await res.text())
  if (!read.ok) fail(read.error.message)
  if (read.body.server !== 'stoke-hub') fail(`${base} answered JSON, but not as a Stoke hub.`)
  out(`${base}: stoke-hub ${String(read.body.version)}, protocol ${String(read.body.protocol)}${read.body.needsBootstrap ? ', waiting for its first account' : ''}`)
}

async function main(): Promise<void> {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2))
  if (flags.help) {
    out(HELP)
    return
  }
  try {
    switch (cmd) {
      case 'serve':
        return await serve(flags)
      case 'invite':
        return invite(flags)
      case 'backup':
        return backup(args, flags)
      case 'reset-password':
        return await resetPassword(args, flags)
      case 'health':
        return await health(flags)
      case 'version':
        return out(HUB_SERVER_VERSION)
      case 'help':
        return out(HELP)
      default:
        fail(`unknown command ${JSON.stringify(cmd)}.\n\n${HELP}`)
    }
  } catch (err) {
    process.stderr.write(`stoke-hub: ${(err as Error).message}\n`)
    process.exitCode = err instanceof CliExit ? err.code : 1
  }
}

void main()
