import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findCloudflared, installHint } from './tunnel.ts'

/**
 * Setting up a Cloudflare Tunnel, as five steps that can each be looked at.
 *
 * `tunnel.ts` supervises a tunnel that already exists. This is everything
 * before that: is cloudflared installed, are you logged in, does the tunnel
 * exist, does a hostname point at it. Stoke used to print those four commands
 * into a box and leave the user to it — which is fine if you know what
 * `cloudflared tunnel route dns` does and unhelpful otherwise, and gave no way
 * at all to find out WHICH step you were stuck on.
 *
 * Every claim this module makes about the CLI was measured against
 * cloudflared 2026.6.1 on a real account; the surprises are recorded at each
 * one, because most of them make a naive reading report the opposite of the
 * truth.
 */

const run = promisify(execFile)

/** cloudflared prints a version warning on stderr every run; stdout stays clean. */
const EXEC = { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 } as const

export type CloudflareStep = 'install' | 'login' | 'create' | 'route' | 'run'

/**
 * `unknown` is a real answer and the most important one here.
 *
 * `cloudflared tunnel list` is a live authenticated API call — it is not a
 * local cache — so a laptop with no network cannot tell "this tunnel does not
 * exist" from "I could not ask". Collapsing those two into `todo` sends someone
 * off to create a tunnel they already have, and `create` then fails on the
 * duplicate name.
 */
export type StepState = 'todo' | 'done' | 'failed' | 'unknown'

export interface CloudflareSetup {
  install: { state: StepState; path: string | null; hint: string }
  login: { state: StepState; certPath: string }
  /** `id` is the tunnel UUID once it exists, which is worth showing. */
  create: { state: StepState; id: string | null; detail: string }
  /**
   * Not detectable from the record itself — see `routeIsUndetectable` — but the
   * hostname can be ASKED, and its answer is the useful half: error 1033 means
   * it is routed to a tunnel other than the one running.
   */
  route: { state: StepState; detail: string; verdict: HostnameVerdict | null }
  run: { state: StepState; detail: string }
}

export interface StepResult {
  ok: boolean
  /** What the command printed, for the disclosure. Never carries a secret. */
  output: string
  /** The reason, quoted from cloudflared rather than paraphrased. */
  error: string | null
  /** Login only: the URL to finish in a browser. */
  url?: string
}

/**
 * Where the login certificate lives.
 *
 * `$TUNNEL_ORIGIN_CERT` overrides it, and cloudflared prints the resolved
 * default in every help screen — so this is the CLI's own rule rather than a
 * guess. Reading the file is never necessary and never done: its presence is
 * the whole signal, and it is a credential.
 */
export function originCertPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const explicit = env.TUNNEL_ORIGIN_CERT?.trim()
  return explicit || join(home, '.cloudflared', 'cert.pem')
}

/**
 * The tunnels in `cloudflared tunnel list --output json`. `[]` means the
 * account has none by that name; `null` means the output could not be read at
 * all, which is a different thing and must not be drawn as "none".
 *
 * Three measured traps in one function. With no match the command **exits 0**,
 * so the exit code cannot be the detector. With `--output json` and no match it
 * prints the literal string `null` — which `JSON.parse` accepts, yielding
 * `null`, so `.some(...)` throws on what looks like a successful parse. That
 * `null` is the CLI's way of writing "none", so it is normalised to `[]` here;
 * getting that wrong is not academic, it is what made this panel report
 * "Cloudflare answered with something this version could not read" for the
 * ordinary case of not having created the tunnel yet. And the version warning
 * goes to stderr, so stdout is safe to parse but only if the streams were never
 * merged.
 */
export function parseTunnelList(stdout: string): { id: string; name: string }[] | null {
  const text = stdout.trim()
  // The CLI's own spelling of "no tunnels matched".
  if (text === '' || text === 'null') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null) return []
  if (!Array.isArray(value)) return null
  return value
    .filter((t): t is { id: string; name: string } =>
      Boolean(t) && typeof (t as { id?: unknown }).id === 'string' && typeof (t as { name?: unknown }).name === 'string'
    )
    .map((t) => ({ id: t.id, name: t.name }))
}

/**
 * Whether a failed `tunnel create` actually means "it is already there".
 *
 * Creating a tunnel whose name is taken exits non-zero with `tunnel with name
 * already exists`. Reported as an error that is a dead end: the wizard would
 * sit on a red step for a tunnel the user has. It is a success for our purpose.
 */
export function createdAlready(output: string): boolean {
  return /already exists/i.test(output)
}

/** The UUID cloudflared prints as `Created tunnel <name> with id <uuid>`. */
export function createdId(output: string): string | null {
  return /with id ([0-9a-f-]{36})/i.exec(output)?.[1] ?? null
}

/**
 * Why the route step has no detector, stated once so nobody goes looking.
 *
 * `cloudflared tunnel route` has no `list` subcommand, and the record it writes
 * is a PROXIED CNAME to `<uuid>.cfargotunnel.com` — so public DNS answers with
 * flattened Cloudflare anycast A records and no CNAME at all. A lookup can tell
 * you something answers, never which tunnel. Reading it authoritatively needs
 * the Cloudflare DNS API and an API token, which the login certificate is not.
 * An HTTP probe is worse than useless: a routed hostname whose tunnel is down
 * returns Cloudflare's own 1033 error page, and one behind Access returns a 302
 * to the login screen, so neither a 200 nor a failure means anything.
 *
 * So this step is idempotent-by-retry rather than detect-then-skip, and running
 * it twice is safe: the second run fails with "already exists", which the panel
 * offers to resolve with --overwrite-dns.
 */
export const routeIsUndetectable =
  'Cloudflare does not publish a way to read this back: the record is a proxied CNAME, so DNS shows only Cloudflare addresses. Run it and read what it says.'

/**
 * What a request to the public hostname actually meets.
 *
 * Cloudflare serves error **1033** — "the hostname is routed to a tunnel with
 * no connections" — as HTTP **530**, and that is the single most useful thing
 * this panel can tell anyone: it means the DNS record points at a tunnel that
 * is not the one running. Which is a state Stoke can produce all by itself,
 * because `tunnel route dns` refuses to overwrite an existing record, so a
 * hostname that has ever pointed anywhere keeps pointing there while Stoke
 * cheerfully runs a different tunnel and draws a QR code for the name.
 *
 * `access` is not a failure: an Access policy in front of the hostname answers
 * a programmatic request with a redirect to its own login, so Stoke cannot see
 * past it. Saying "there is an Access policy here" is the honest end of the
 * check, and notably 1033 can still be waiting on the other side of it — which
 * is why the panel offers the remedy rather than claiming the route is fine.
 */
export type HostnameVerdict = 'ok' | 'tunnel-not-found' | 'access' | 'dns' | 'other'

/**
 * Pure, so the mapping can be asserted without a network. 530 is Cloudflare's
 * status for the whole 1000-series origin errors, so the body decides which.
 */
export function classifyHostname(
  status: number,
  location: string | null,
  body: string
): HostnameVerdict {
  if (status === 530 || /\berror 1033\b/i.test(body) || /argo tunnel error/i.test(body)) {
    return 'tunnel-not-found'
  }
  if (status >= 300 && status < 400 && /cloudflareaccess\.com/i.test(location ?? '')) return 'access'
  // 401 is ours: the server answered and asked for the key, which is a success
  // for this question — something on the other end is Stoke.
  if (status === 401 || (status >= 200 && status < 400)) return 'ok'
  return 'other'
}

/** One line the panel can show, per verdict. */
export function hostnameDetail(verdict: HostnameVerdict, host: string): string {
  switch (verdict) {
    case 'ok':
      return `${host} reaches this machine.`
    case 'tunnel-not-found':
      return `${host} answers with Cloudflare error 1033, which means it is routed to a different tunnel than the one running. Replace the record below.`
    case 'access':
      return `${host} is behind a Cloudflare Access policy, so Stoke cannot check past the login. If your browser shows error 1033 after signing in, the record points at a different tunnel — replace it below.`
    case 'dns':
      return `${host} did not resolve, or nothing answered. Add the DNS record below.`
    default:
      return `${host} answered, but not with anything Stoke recognises.`
  }
}

/**
 * Ask the hostname what it is. Never throws; a failure is a verdict.
 *
 * `redirect: 'manual'` because the whole point is to SEE the Access redirect
 * rather than follow it into a login page and report whatever that says.
 */
export async function checkHostname(host: string): Promise<HostnameVerdict> {
  const name = host.trim()
  if (!name) return 'dns'
  try {
    const res = await fetch(`https://${name}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'stoke-setup-check' }
    })
    // Only read a body when the status suggests an error page worth reading.
    const body = res.status >= 400 ? (await res.text().catch(() => '')).slice(0, 4000) : ''
    return classifyHostname(res.status, res.headers.get('location'), body)
  } catch {
    return 'dns'
  }
}

/** The last line that looks like a reason, for a message worth reading. */
function reasonFrom(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // The version warning is on stderr on EVERY invocation and is not an error.
    .filter((l) => !/is outdated\. We recommend upgrading/i.test(l))
  const said = lines.filter((l) => /ERR|error|fail|not found|required|exists/i.test(l)).at(-1)
  return (said ?? lines.at(-1) ?? '').replace(/^\S+T\S+\s+(ERR|INF|WRN)\s+/, '').trim()
}

/** stdout and stderr, in the order a reader expects, with the noise dropped. */
function transcript(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .join('\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/is outdated\. We recommend upgrading/i.test(l))
    .join('\n')
}

/**
 * The state of all five steps, without changing anything.
 *
 * Order matters: a missing certificate makes every `list`/`info` call fail with
 * a message about the tunnel ID rather than about the login, so the cert is
 * checked first and the account is not asked about at all until it exists.
 * Otherwise the wizard tells you your tunnel does not exist when the truth is
 * that you are not logged in.
 */
export async function probeSetup(opts: {
  tunnelName: string
  hostname: string
  /** Whether Stoke's own cloudflared child is up, which `info` cannot tell apart. */
  running: boolean
}): Promise<CloudflareSetup> {
  const certPath = originCertPath()
  const exe = await findCloudflared()
  const setup: CloudflareSetup = {
    install: {
      state: exe ? 'done' : 'todo',
      path: exe,
      hint: installHint()
    },
    login: { state: 'todo', certPath },
    create: { state: 'todo', id: null, detail: '' },
    route: { state: 'unknown', detail: routeIsUndetectable, verdict: null },
    run: {
      state: opts.running ? 'done' : 'todo',
      detail: opts.running ? 'Stoke is running it.' : 'Stoke runs this for you once the steps above are done.'
    }
  }
  if (!exe) {
    setup.install.state = 'todo'
    return setup
  }

  try {
    await access(certPath)
    setup.login.state = 'done'
  } catch {
    setup.login.state = 'todo'
    setup.create.detail = 'Log in first — every account lookup needs the certificate.'
    return setup
  }

  /*
   * The hostname is asked what it is, in parallel with the account lookup —
   * they are independent, and doing them in series doubled the wait on a panel
   * that opens on every visit to this section.
   */
  const asking = opts.hostname.trim()
    ? checkHostname(opts.hostname)
    : Promise.resolve<HostnameVerdict | null>(null)

  const name = opts.tunnelName.trim()
  if (!name) {
    setup.create.detail = 'Name the tunnel first.'
    setup.route = await routeStep(await asking, opts.hostname)
    return setup
  }
  try {
    // NOT 2>&1: the version warning and the JSON must stay in separate streams.
    const { stdout } = await run(exe, ['tunnel', 'list', '--name', name, '--output', 'json'], EXEC)
    const list = parseTunnelList(stdout)
    if (list === null) {
      // Reached the API and got something unreadable rather than a list.
      setup.create.state = 'unknown'
      setup.create.detail = 'Cloudflare answered with something this version could not read.'
    } else if (list.length > 0) {
      setup.create.state = 'done'
      setup.create.id = list[0].id
      setup.create.detail = `Tunnel ${name} exists.`
    } else {
      setup.create.state = 'todo'
      setup.create.detail = `No tunnel named ${name} in this account yet.`
    }
  } catch (err) {
    /*
     * A network failure looks exactly like "not created" and must not be drawn
     * as one — that is what sends someone to create a duplicate.
     */
    setup.create.state = 'unknown'
    setup.create.detail = `Could not ask Cloudflare: ${reasonFrom(String(err))}`
  }
  setup.route = await routeStep(await asking, opts.hostname)
  return setup
}

/**
 * The route step, from what the hostname answered.
 *
 * `access` stays `unknown` rather than becoming `done`: a redirect to the
 * Access login means Stoke could not see past it, and 1033 is perfectly capable
 * of waiting on the other side. Claiming success there is how a panel tells you
 * everything is fine while your phone shows an error page.
 */
async function routeStep(
  verdict: HostnameVerdict | null,
  hostname: string
): Promise<CloudflareSetup['route']> {
  const host = hostname.trim()
  if (!host || verdict === null) {
    return { state: 'todo', detail: 'Set a public hostname first.', verdict: null }
  }
  const detail = hostnameDetail(verdict, host)
  const state: StepState =
    verdict === 'ok' ? 'done' : verdict === 'tunnel-not-found' ? 'failed' : verdict === 'dns' ? 'todo' : 'unknown'
  return { state, detail, verdict }
}

/**
 * Run one setup step.
 *
 * `login` is the odd one and cannot be an `execFile`: it prints a URL, opens a
 * browser, and then BLOCKS until the callback completes, writing the
 * certificate when it does. So it is spawned, the URL is scraped from stderr
 * and handed back for the caller to open, and completion is the certificate
 * appearing rather than the process exiting. It also refuses outright when a
 * certificate is already present, which is why the caller checks first.
 */
export async function runSetupStep(
  step: 'create' | 'route',
  opts: { tunnelName: string; hostname: string; overwriteDns?: boolean }
): Promise<StepResult> {
  const exe = (await findCloudflared()) ?? 'cloudflared'
  const args =
    step === 'create'
      ? ['tunnel', 'create', opts.tunnelName]
      : [
          'tunnel',
          'route',
          'dns',
          ...(opts.overwriteDns ? ['--overwrite-dns'] : []),
          opts.tunnelName,
          opts.hostname
        ]
  try {
    const { stdout, stderr } = await run(exe, args, EXEC)
    return { ok: true, output: transcript(stdout, stderr), error: null }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: unknown }
    const output = transcript(e.stdout ?? '', e.stderr ?? e.message ?? '')
    // A name that is taken is the thing we wanted, not a failure to report.
    if (step === 'create' && createdAlready(output)) {
      return { ok: true, output, error: null }
    }
    return { ok: false, output, error: reasonFrom(output) || String(e.message ?? 'failed') }
  }
}

/**
 * Start `cloudflared tunnel login` and return the URL to finish it at.
 *
 * Resolves as soon as the URL is known — the child keeps running, because it
 * is what downloads the certificate when the browser is done. `waitForCert`
 * below is the other half. The URL is on **stderr**, with every other
 * diagnostic line, which is why stdout is not scraped for it.
 */
export function startLogin(exe: string): {
  url: Promise<string | null>
  stop: () => void
  output: () => string
} {
  const proc = spawn(exe, ['tunnel', 'login'], { windowsHide: true })
  let text = ''
  let settle: (v: string | null) => void = () => {}
  const url = new Promise<string | null>((resolve) => {
    settle = resolve
  })
  const absorb = (buf: Buffer): void => {
    text += buf.toString('utf8')
    const found = /https:\/\/dash\.cloudflare\.com\/argotunnel\S*/.exec(text)
    if (found) settle(found[0])
  }
  proc.stdout?.on('data', absorb)
  proc.stderr?.on('data', absorb)
  proc.on('error', () => settle(null))
  // It exits without a URL when a certificate is already there, which the
  // caller has checked for — but resolve rather than hang if it happens.
  proc.on('exit', () => settle(null))
  return {
    url,
    stop: () => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    },
    output: () => transcript(text, '')
  }
}

/** Poll for the certificate the browser login writes. Resolves false on timeout. */
export async function waitForCert(certPath: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await access(certPath)
      return true
    } catch {
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
