/*
 * The Stoke Hub end to end, against a REAL hub: the deployed one behind the
 * stoke-hub-edge Worker (https://stoke.vinn.dev/hub), or one started in this
 * process for a rehearsal. Every device is the real desktop client
 * (src/main/hub/service.ts, with its presence socket and its "Other machines"
 * relay, src/main/hub/remote.ts) running under plain node, with `ws` for the
 * sockets — no Electron, no window, no agent CLI.
 *
 *   node scripts/hub-e2e.mts --url https://stoke.vinn.dev/hub --invite INV-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
 *   node scripts/hub-e2e.mts --local                  a hub on 127.0.0.1 in this process (a rehearsal)
 *   node scripts/hub-e2e.mts --url <base> --resume <dir>
 *                                                     reuse device A (the owner) from an earlier run's
 *                                                     scratch dir: no invite needed (an invite is one use)
 *       [--idle-ms 130000]  hold a quiet relay this long, to see what the path does to it (0: skip)
 *       [--flood-mb 24]     what A writes at B's paused relay socket (the flow-control check)
 *       [--no-ip-lockout]   skip the last check, which locks THIS machine's address out of sign-in and
 *                           sign-up on that hub for 15 minutes
 *       [--keep]            keep the scratch dir after a clean run (always kept after a failure)
 *
 * NOT a verify suite and never in `check`: it creates accounts on the hub it is
 * pointed at, signs in from this machine's address, and (unless told not to)
 * locks that address out of sign-in for 15 minutes. Point it only at a hub
 * whose data you mean to throw away. Run it in the background: with the idle
 * hold it takes about five minutes.
 *
 * What it proves, each against the real hub:
 *   0 edge       health; an unsigned WebSocket upgrade comes back as the hub's own JSON refusal
 *   1 signup     device A signs up with the invite, makes the vault (a Recovery Kit), its session works
 *   2 pairing    device B signs in (pending) and asks to join; both screens show the same code; A
 *                approves, the owner confirms on B; B takes the vault key and opens A's settings
 *   3 items      A seals an API key and an SSH private key (ssh-keygen ed25519); B opens both and
 *                installs the key 0600 beside a same-named file it leaves alone; a stale put is refused
 *                by the hub's compare-and-swap; two devices' edits end in a conflict note
 *   4 presence   A and B online to each other over the WebSocket; A's sealed status reaches B and
 *                follows a change
 *   5 relay      B opens A's (stub) session; A is asked and allows once; typed text both ways; a
 *                >256 KB frame each way (relayFrameParts); a flood at a paused reader; latency.
 *                Account C (7) probes the open relay meanwhile
 *     idle       the relay held quiet for --idle-ms, and every socket's life over the run
 *   6 revoke     A removes B with the Kit: B's item read, open relay and presence all end
 *   7 isolation  A mints a member invite, C signs up (7a, before the relay; it also asks whether a
 *                binary frame crosses the edge AS binary, on C's presence socket); C reads none of
 *                A's items, devices or relays; replayed and forged signed requests are refused
 *   8 lockout    six wrong passwords lock C's email; C's own device, proving itself, still signs in;
 *                a stranger's address is throttled after thirty failures
 *
 * Every secret sealed carries a canary (`E2ECANARY-<run>`), printed at the end so the operator can
 * grep the hub's database for it (--local greps its own). Every path is synthetic (gotcha 74):
 * userData, ~/.ssh and the local hub's data all live under one temp dir; nothing in ~ is read or
 * written. Imports are relative with `.ts` (gotcha 78).
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'
import type { Settings } from '../src/shared/types.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { HubService } from '../src/main/hub/service.ts'
import { HubFiles } from '../src/main/hub/files.ts'
import { generateDeviceKeys, randomU8, signRequest } from '../src/main/hub/crypto.ts'
import { hubEndpoint, hubSocketUrl, hubUrlVerdict } from '../src/shared/hub/edge.ts'
import { HUB_LIMITS } from '../src/shared/hub/protocol.ts'
import { RELAY_CHUNK_CHARS, RELAY_MAX_FRAME_BYTES } from '../src/shared/hub/relay.ts'
import { idFromBytes } from '../src/shared/hub/codec.ts'
import { DEVICE_CAPS } from '../src/shared/hub/chain.ts'
import type { RemoteRowLike } from '../src/shared/hub/remote.ts'
import type { SecretBackend } from '../src/main/secrets.ts'
import type { ExecRun } from '../src/main/sshEnroll.ts'

/* ============================================================ arguments */

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const flag = (name: string): boolean => process.argv.includes(name)
const LOCAL = flag('--local')
const RESUME = arg('--resume')
const KEEP = flag('--keep')
const IDLE_MS = Number(arg('--idle-ms') ?? 130_000)
const IP_LOCKOUT = !flag('--no-ip-lockout')
/** Megabytes A's pty writes at B's paused relay socket: past the kernel's buffers and the hub's 4 MiB high water. */
const FLOOD_MB = Number(arg('--flood-mb') ?? 24)
let URL_ = arg('--url') ?? ''
let INVITE = arg('--invite') ?? ''
if ((!LOCAL && !URL_) || (!LOCAL && !RESUME && !INVITE) || (LOCAL && RESUME)) {
  console.error('usage: node scripts/hub-e2e.mts --url <hub base> --invite <INV-…> | --url <hub base> --resume <dir> | --local')
  process.exit(2)
}

/* ============================================================ the tally */

let failures = 0
let passes = 0
function check(name: string, got: unknown, want: unknown): boolean {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (pass) passes++
  else failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${JSON.stringify(got)?.slice(0, 600)}, want ${JSON.stringify(want)?.slice(0, 600)}`))
  return pass
}
function ok(name: string, condition: boolean, detail = ''): boolean {
  if (condition) passes++
  else failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail.slice(0, 900)}`}`)
  return condition
}
/** Evidence, printed whatever the verdict. */
function note(text: string): void {
  console.log(`        · ${text.slice(0, 900)}`)
}
class Skip extends Error {}
function need(cond: unknown, what: string): void {
  if (!cond) throw new Skip(what)
}
async function phase(title: string, fn: () => Promise<void>): Promise<boolean> {
  const t0 = performance.now()
  console.log(`\n${title}`)
  const before = failures
  try {
    await fn()
  } catch (err) {
    failures++
    if (err instanceof Skip) console.log(`  FAIL  not run: ${err.message}`)
    else console.log(`  FAIL  the phase stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  }
  console.log(`        (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  return failures === before
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | null | undefined | false, ms: number, every = 100): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    let v: T | null | undefined | false = null
    try {
      v = fn()
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
const sha = (t: string): string => createHash('sha256').update(t).digest('base64url').slice(0, 16)
function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/* ============================================================ the run */

const RUN = randomBytes(5).toString('hex')
const T0 = Date.now()
const at = (t: number | null): string => (t === null ? '—' : `+${((t - T0) / 1000).toFixed(1)}s`)
/** Every sealed secret carries `E2ECANARY-<run>`: grep the hub's database for it. */
const CANARY = {
  apiKey: `sk-ant-api03-E2ECANARY-${RUN}-apikey`,
  sshComment: `E2ECANARY-${RUN}-sshkey@e2e`,
  relayText: `E2ECANARY-${RUN}-relaytext`,
  bigFrame: `E2ECANARY-${RUN}-bigframe`,
  sessionTitle: `E2ECANARY-${RUN}-sessiontitle`,
  afterRevoke: `sk-or-v1-E2ECANARY-${RUN}-after-revoke`
}
const PTY = 'pty-e2e-1'
const HISTORY = `stub$ echo ready\r\nready\r\nstub$ `

const watchdog = setTimeout(() => {
  console.log('\nWATCHDOG: the run took longer than 30 minutes; stopping.')
  process.exit(2)
}, 30 * 60_000)
watchdog.unref()

/* ============================================================ scratch, and the saved owner */

interface RunState {
  url: string
  emailA: string
  passwordA: string
  kit: string
  aDir: string
  settingsA: unknown
}
const TMP = RESUME ?? mkdtempSync(join(tmpdir(), 'stoke-hub-e2e-'))
const STATE_FILE = join(TMP, 'e2e-state.json')
let saved: RunState | null = null
if (RESUME) {
  if (!existsSync(STATE_FILE)) {
    console.error(`--resume: ${STATE_FILE} does not exist`)
    process.exit(2)
  }
  saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState
  if (!URL_) URL_ = saved.url
}
const EMAIL_A = saved?.emailA ?? `e2e-owner-${RUN}@example.com`
const PW_A = saved?.passwordA ?? `e2e-owner-pw-${randomBytes(9).toString('base64url')}`
let KIT = saved?.kit ?? ''
const A_DIR = saved?.aDir ?? `A-${RUN}`
const EMAIL_C = `e2e-member-${RUN}@example.com`
const PW_C = `e2e-member-pw-${randomBytes(9).toString('base64url')}`

/* ============================================================ the hub */

let localHub: { close(): Promise<void> } | null = null
const HUB_DATA = join(TMP, 'hub')
if (LOCAL) {
  const { startHub } = await import('../hub/app.ts')
  const { HubLog } = await import('../hub/log.ts')
  mkdirSync(HUB_DATA, { recursive: true, mode: 0o700 })
  const announced: string[] = []
  const logFile = join(TMP, 'hub.log')
  const h = await startHub(
    { dataDir: HUB_DATA, mount: '/hub', edge: null, lan: { host: '127.0.0.1', port: 0 }, edgeSecret: null },
    { log: new HubLog((line) => appendFileSync(logFile, `${line}\n`), { level: 'debug' }), announce: (t) => announced.push(t) }
  )
  localHub = h
  URL_ = `http://127.0.0.1:${h.lanPort}/hub`
  INVITE = /(INV(?:-[0-9A-Z]{4}){6})/.exec(announced.join(''))?.[1] ?? ''
}
const verdict = hubUrlVerdict(URL_)
if (!verdict.ok) {
  console.error(`--url: ${verdict.problem}`)
  process.exit(2)
}
const BASE = verdict.base

console.log(`Stoke Hub end to end: ${BASE}${LOCAL ? ' (in this process)' : ''}`)
console.log(`run ${RUN}, scratch ${TMP}${RESUME ? ' (resumed)' : ''}, started ${new Date(T0).toISOString()}`)

/* ============================================================ latency */

const lat: Record<string, number[]> = {}
const record = (k: string, ms: number): void => {
  ;(lat[k] ??= []).push(ms)
}
function stats(xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return s.length === 1 ? `${s[0].toFixed(0)} ms` : `n=${s.length} min ${s[0].toFixed(0)} · median ${q(0.5).toFixed(0)} · p95 ${q(0.95).toFixed(0)} · max ${s[s.length - 1].toFixed(0)} ms`
}

/* ============================================================ raw requests, as any device */

interface Creds {
  id: string
  signPriv: string
  signPub: string
  boxPub: string
  token: string
  account: string
}
interface Reply {
  status: number
  body: Record<string, any> | null
  text: string
  ms: number
}

async function sendRaw(method: 'GET' | 'POST', pathV1: string, headers: Record<string, string>, text = ''): Promise<Reply> {
  const t = performance.now()
  const h: Record<string, string> = { accept: 'application/json', ...headers }
  if (text && !h['content-type']) h['content-type'] = 'application/json'
  const res = await fetch(hubEndpoint(BASE, pathV1), { method, headers: h, body: text || undefined, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  const body = await res.text()
  return { status: res.status, body: safeJson(body), text: body, ms: performance.now() - t }
}

/**
 * One request. `as` signs it with a session (bearer + signature); `proof`
 * signs it with a device key and no bearer (an active device's sign-in).
 * `signPath`/`signBody`/`ts`/`deviceHeader`/`signKey` forge one part of it.
 */
async function raw(
  method: 'GET' | 'POST',
  pathV1: string,
  body?: unknown,
  o: { as?: Creds; proof?: Creds; signPath?: string; signBody?: string; ts?: number; deviceHeader?: string; signKey?: string; headers?: Record<string, string> } = {}
): Promise<Reply> {
  const text = body === undefined ? '' : JSON.stringify(body)
  const headers: Record<string, string> = {}
  const who = o.as ?? o.proof
  if (who) {
    Object.assign(
      headers,
      signRequest({
        method,
        pathFromV1: o.signPath ?? pathV1,
        device: o.deviceHeader ?? who.id,
        signPriv: o.signKey ?? who.signPriv,
        token: o.as ? o.as.token : undefined,
        body: o.signBody ?? text,
        now: o.ts ?? Date.now()
      })
    )
  }
  Object.assign(headers, o.headers ?? {})
  return sendRaw(method, pathV1, headers, text)
}

function signedHeaders(method: 'GET' | 'POST', pathV1: string, c: Creds, body = ''): Record<string, string> {
  return signRequest({ method, pathFromV1: pathV1, device: c.id, signPriv: c.signPriv, token: c.token, body, now: Date.now() })
}

/** A WebSocket upgrade, and what came back: 101, or the hub's refusal (status and body). */
function wsProbe(pathV1: string, headers: Record<string, string>, ms = 20_000): Promise<{ opened: boolean; status: number | null; body: string; error: string | null; ms: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const ws = new WebSocket(hubSocketUrl(BASE, pathV1), { headers })
    let done = false
    const finish = (r: { opened: boolean; status: number | null; body: string; error: string | null }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ...r, ms: performance.now() - t0 })
    }
    const timer = setTimeout(() => {
      finish({ opened: false, status: null, body: '', error: 'no answer in time' })
      ws.terminate()
    }, ms)
    ws.on('open', () => {
      finish({ opened: true, status: 101, body: '', error: null })
      ws.close(1000)
    })
    ws.on('unexpected-response', (req, res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        finish({ opened: false, status: res.statusCode ?? null, body: Buffer.concat(chunks).toString('utf8'), error: null })
        req.destroy()
      })
      res.on('error', () => finish({ opened: false, status: res.statusCode ?? null, body: '', error: 'the refusal broke off' }))
    })
    ws.on('error', (err) => finish({ opened: false, status: null, body: '', error: err.message }))
  })
}

/**
 * Send `{"t":"ping"}` as a BINARY frame on a presence socket and report how the
 * hub closed it. The hub takes presence frames as JSON text only: a frame that
 * arrives binary is closed 1003, one that arrived as text but is not JSON 1007
 * (an edge that stringified it), and a text ping is answered with a pong.
 */
function binaryOnPresence(c: Creds, ms = 15_000): Promise<{ code: number | null; reason: string; got: string[] }> {
  return new Promise((resolve) => {
    const path = '/v1/ws/presence'
    const ws = new WebSocket(hubSocketUrl(BASE, path), { headers: signedHeaders('GET', path, c) })
    const got: string[] = []
    let done = false
    const finish = (code: number | null, reason: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, reason, got })
    }
    const timer = setTimeout(() => {
      finish(null, 'still open: the hub neither refused nor answered')
      ws.terminate()
    }, ms)
    ws.on('open', () => ws.send(Buffer.from('{"t":"ping"}'), { binary: true }))
    ws.on('message', (data: Buffer, isBinary: boolean) => got.push(`${isBinary ? 'binary' : 'text'} ${String(data).slice(0, 60)}`))
    ws.on('close', (code: number, reason: Buffer) => finish(code, reason.toString('utf8')))
    ws.on('error', (err: Error) => got.push(`error ${err.message}`))
  })
}

/* ============================================================ devices */

function fakeBackend(tag: string): SecretBackend {
  return {
    isEncryptionAvailable: () => true,
    selectedBackend: () => null,
    encrypt: (plain) => Buffer.from(`${tag}|${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decrypt: (sealed) => {
      const t = sealed.toString('utf8')
      if (!t.startsWith(`${tag}|`)) throw new Error('sealed by another key')
      return Buffer.from(t.slice(tag.length + 1), 'base64').toString('utf8')
    }
  }
}

/** `ssh -G` as far as IdentityFile goes: the lines of the config it is given with -F, nothing else read. */
function fakeSshG(): ExecRun {
  return async (_file, args) => {
    const f = args.indexOf('-F')
    const cfg = f >= 0 ? args[f + 1] : ''
    const alias = args[args.length - 1]
    let out = ''
    if (cfg && existsSync(cfg)) {
      let on = false
      for (const line of readFileSync(cfg, 'utf8').split('\n')) {
        const host = /^\s*Host\s+(.+)$/.exec(line)
        if (host) on = host[1].split(/\s+/).includes(alias)
        const idf = /^\s*IdentityFile\s+"?([^"]+)"?\s*$/.exec(line)
        if (idf && on) out += `identityfile ${idf[1]}\n`
      }
    }
    return { ok: true, stdout: `hostname ${alias}\n${out}`, stderr: '', error: null }
  }
}

interface SockRec {
  kind: 'presence' | 'relay'
  url: string
  ws: WebSocket
  startedAt: number
  openedAt: number | null
  closedAt: number | null
  code: number | null
  reason: string
  error: string | null
  sentSizes: number[]
  textSent: number
  binarySent: number
  /** Sends whose bytes held any canary in the clear: must stay 0 (the relay sees only sealed frames). */
  canaryHits: number
}

interface PtyStub {
  rows: RemoteRowLike[]
  sockets: { readyState: number; send(text: string): void }[]
  inputs: string[]
  requests: string[]
}

interface Box {
  name: string
  dir: string
  svc: HubService
  backend: SecretBackend
  userData: string
  ssh: { dir: string; config: string; home: string }
  settings(): Settings
  set(patch: Partial<Settings>): void
  logs: string[]
  requests: string[]
  presenceSocks: SockRec[]
  relaySocks: SockRec[]
  pty: PtyStub
  frames: { tab: string; frame: Record<string, any>; at: number }[]
  tabLog: string[]
}

const canaryBytes = Object.values(CANARY).map((c) => Buffer.from(c))

function track(box: Box, kind: 'presence' | 'relay', url: string, headers: Record<string, string>, maxPayload: number): WebSocket {
  const ws = new WebSocket(url, { headers, maxPayload })
  const rec: SockRec = { kind, url, ws, startedAt: Date.now(), openedAt: null, closedAt: null, code: null, reason: '', error: null, sentSizes: [], textSent: 0, binarySent: 0, canaryHits: 0 }
  const send = ws.send.bind(ws) as (data: unknown, ...rest: unknown[]) => void
  ;(ws as unknown as { send: (data: unknown, ...rest: unknown[]) => void }).send = (data: unknown, ...rest: unknown[]) => {
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as Uint8Array)
    rec.sentSizes.push(buf.length)
    if (typeof data === 'string') rec.textSent++
    else rec.binarySent++
    if (canaryBytes.some((c) => buf.includes(c))) rec.canaryHits++
    return send(data, ...rest)
  }
  ws.on('open', () => (rec.openedAt = Date.now()))
  ws.on('close', (code: number, reason: Buffer) => {
    rec.closedAt = Date.now()
    rec.code = code
    rec.reason = reason.toString('utf8')
  })
  ws.on('error', (err: Error) => (rec.error = err.message))
  ;(kind === 'presence' ? box.presenceSocks : box.relaySocks).push(rec)
  return ws
}

const boxes: Box[] = []

function device(name: string, initial: Partial<Settings>, dir = `${name}-${RUN}`): Box {
  const userData = join(TMP, `ud-${dir}`)
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  const home = join(TMP, `home-${dir}`)
  const ssh = { dir: join(home, '.ssh'), config: join(home, '.ssh', 'config'), home }
  mkdirSync(ssh.dir, { recursive: true, mode: 0o700 })
  let s = hydrateSettings(initial)
  const listeners = new Set<(x: Settings) => void>()
  const commit = (patch: Partial<Settings>): Settings => {
    s = hydrateSettings({ ...s, ...patch })
    for (const l of listeners) l(s)
    return s
  }
  const backend = fakeBackend(dir)
  const box = {
    name,
    dir,
    backend,
    userData,
    ssh,
    settings: () => s,
    set: (p: Partial<Settings>) => void commit(p),
    logs: [],
    requests: [],
    presenceSocks: [],
    relaySocks: [],
    pty: { rows: [], sockets: [], inputs: [], requests: [] },
    frames: [],
    tabLog: []
  } as unknown as Box
  const tabStates = new Map<string, string>()
  box.svc = new HubService({
    userData,
    backend,
    platform: 'darwin',
    hostname: `${name} e2e`,
    appVersion: '0.0.0-e2e',
    getSettings: () => s,
    commit,
    hydrate: hydrateSettings,
    onSettingsChanged: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit: () => undefined,
    ssh,
    exec: fakeSshG(),
    pairPollMs: 1000,
    log: (message, err) => box.logs.push(`${at(Date.now())} ${message}${err ? ` — ${err instanceof Error ? err.message : String(err)}` : ''}`),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace(/^.*?\/v1\//, '/v1/')
      try {
        const res = await fetch(input, init)
        box.requests.push(`${at(Date.now())} ${res.status} ${init?.method ?? 'GET'} ${path}`)
        return res
      } catch (err) {
        box.requests.push(`${at(Date.now())} ERR ${init?.method ?? 'GET'} ${path} ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }) as typeof fetch,
    presence: async (url, headers) => track(box, 'presence', url, headers, HUB_LIMITS.presenceFrameBytes) as never,
    relaySocket: async (url, headers) => track(box, 'relay', url, headers, RELAY_MAX_FRAME_BYTES + 1024) as never,
    remote: {
      sessions: async () => box.pty.rows,
      request: async (method, path) => {
        box.pty.requests.push(`${method} ${path}`)
        return { status: 200, body: { machine: name } }
      },
      socket: (path, sock) => {
        // A stub pty behind the phone socket: the attach replay, then an echo of whatever is typed
        // (a large input is answered with its length and digest instead of itself).
        const ptyId = new URLSearchParams(path.split('?')[1] ?? '').get('ptyId')
        box.pty.sockets.push(sock)
        sock.send(JSON.stringify({ type: 'attached', ptyId, cols: 100, rows: 30, desktopCols: 100, desktopRows: 30, status: 'idle', history: HISTORY }))
        sock.on('message', (rawMsg) => {
          const msg = safeJson(String(rawMsg))
          if (!msg || msg.type !== 'input' || typeof msg.data !== 'string') return
          box.pty.inputs.push(msg.data)
          const data = msg.data.length > 4096 ? `ack:${msg.data.length}:${sha(msg.data)}` : msg.data
          sock.send(JSON.stringify({ type: 'data', ptyId, data }))
        })
      },
      emit: (view) => {
        for (const t of view.tabs) {
          if (tabStates.get(t.id) === t.state) continue
          tabStates.set(t.id, t.state)
          box.tabLog.push(`${at(Date.now())} ${t.id} ${t.state}${t.message ? ` (${t.message})` : ''}`)
        }
      },
      frame: (tab, frame) => box.frames.push({ tab, frame: frame as Record<string, any>, at: performance.now() })
    }
  })
  boxes.push(box)
  return box
}

async function credsOf(b: Box): Promise<Creds> {
  const d = await new HubFiles(b.userData, b.backend, 'darwin').loadDevice()
  if (!d) throw new Error(`${b.name} has no hub-device.json`)
  return { id: d.id, signPriv: d.keys.signPriv, signPub: d.keys.signPub, boxPub: d.keys.boxPub, token: d.token, account: d.account }
}

const kitGroup = (r: { kit: string; group: number }): string => r.kit.split('-')[r.group]
const idOf = (b: Box): string => b.svc.view().device?.id ?? ''
const lastOpen = (socks: SockRec[]): SockRec | null => [...socks].reverse().find((r) => r.ws.readyState === 1) ?? null

function saveRunState(A: Box): void {
  const st: RunState = { url: URL_, emailA: EMAIL_A, passwordA: PW_A, kit: KIT, aDir: A_DIR, settingsA: A.settings() }
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 1), { mode: 0o600 })
}

/** The latest relay frames since `from`, as B's remote tab received them. */
function framesSince(b: Box, from: number, tab: string): { frame: Record<string, any>; at: number }[] {
  return b.frames.slice(from).filter((f) => f.tab === tab)
}

/* ============================================================ the phases */

let A: Box | null = null
let B: Box | null = null
let C: Box | null = null
let aId = ''
let bId = ''
let bCredsBeforeRevoke: Creds | null = null
let tab = ''
let openRelayId = ''
const observations: string[] = []

await phase('0. the address answers as a Stoke hub, through the edge', async () => {
  let first: Reply | null = null
  for (let i = 0; i < 5; i++) {
    const r = await raw('GET', '/v1/health')
    record('HTTP GET /v1/health (unsigned)', r.ms)
    first ??= r
  }
  check('GET /v1/health answers as the hub, protocol 1', [first?.status, first?.body?.server, first?.body?.protocol], [200, 'stoke-hub', 1])
  note(`answer: ${first?.text}`)
  if (!RESUME) check('it still needs its first account (the bootstrap invite is unused)', first?.body?.needsBootstrap, true)
  const probe = await wsProbe('/v1/ws/presence', {})
  check(
    'an unsigned WebSocket upgrade to /v1/ws/presence is refused with the hub’s own JSON (the edge passes the refusal through)',
    [probe.opened, probe.status, safeJson(probe.body)?.error],
    [false, 401, 'unauthorized']
  )
  note(`upgrade answered ${probe.status} in ${probe.ms.toFixed(0)} ms: ${probe.body || probe.error}`)
})

await phase('1. device A signs up with the invite and makes the vault', async () => {
  A = RESUME && saved ? device('A', saved.settingsA as Partial<Settings>, A_DIR) : device('A', {
    themeId: 'moss',
    fontSize: 15,
    hosts: [{ id: 'host-1', label: 'E2E NUC', alias: 'e2e-nuc', command: '', persist: 'off' }]
  } as Partial<Settings>, A_DIR)
  await A.svc.start()
  if (RESUME) {
    await A.svc.syncNow()
    if (A.svc.view().phase !== 'active') {
      const back = await A.svc.signIn({ email: EMAIL_A, password: PW_A })
      note(`A signed in again: ${back.ok ? back.state : back.message}`)
    }
    await until(() => A!.svc.view().phase === 'active' && A!.svc.view().lastSyncAt !== null, 20_000)
    check(`A (resumed from ${TMP}) is active in its vault`, [A.svc.view().phase, A.svc.view().role], ['active', 'owner'])
  } else {
    const c = await A.svc.checkUrl(URL_)
    check('Stoke’s own check of the address: a hub that needs its first account', [c.ok, c.ok && c.needsBootstrap], [true, true])
    check('A points at it', (await A.svc.setUrl(URL_)).ok, true)
    const up = await A.svc.signIn({ invite: INVITE, email: EMAIL_A, password: PW_A, label: 'E2E Mac (A)' })
    check('A signs up with the invite and is signed in, as the owner, with no vault yet', [up.ok, up.ok ? '' : up.message, A.svc.view().phase, A.svc.view().role], [true, '', 'new-account', 'owner'])
    need(up.ok, 'A could not sign up')
    saveRunState(A)
    const made = await A.svc.createVault()
    ok('A makes the vault: a Recovery Kit is returned', made.ok && /^RK1(-[0-9A-Z*~$=U]{3,4}){7}$/.test(made.ok ? made.kit : ''), JSON.stringify(made))
    need(made.ok, 'no Kit')
    KIT = (made as { kit: string }).kit
    saveRunState(A)
    check('typing a group of the Kit back posts the genesis', (await A.svc.confirmKit(kitGroup(made as { kit: string; group: number }))).ok, true)
    await until(() => A!.svc.view().lastSyncAt !== null, 30_000)
    check('A is active, alone, at epoch 1', [A.svc.view().phase, A.svc.view().devices.length, A.svc.view().epoch], ['active', 1, 1])
  }
  aId = idOf(A)
  const ca = await credsOf(A)
  const acct = await raw('GET', '/v1/account', undefined, { as: ca })
  record('HTTP signed GET /v1/account', acct.ms)
  check('the session works: a signed GET /v1/account names this account, as owner', [acct.status, acct.body?.email, acct.body?.role, acct.body?.accountId === ca.account], [200, EMAIL_A, 'owner', true])
  note(`account ${ca.account}, device ${aId}, chain ${JSON.stringify(acct.body?.chain)}`)
  for (let i = 0; i < 4; i++) record('HTTP signed GET /v1/account', (await raw('GET', '/v1/account', undefined, { as: ca })).ms)
  saveRunState(A)
})

await phase('2. device B signs in, pairs, and is approved on both screens', async () => {
  need(A && A.svc.view().phase === 'active', 'A is not active')
  const a = A as Box
  B = device('B', { themeId: 'ember' } as Partial<Settings>)
  const b = B
  await b.svc.start()
  check('B points at the hub', (await b.svc.setUrl(URL_)).ok, true)
  const bIn = await b.svc.signIn({ email: EMAIL_A, password: PW_A, label: 'E2E Windows (B)' })
  check('B signs in to the same account: pending, outside the vault', [bIn.ok, bIn.ok ? '' : bIn.message, b.svc.view().phase], [true, '', 'locked'])
  need(bIn.ok, 'B could not sign in')
  bId = idOf(b)
  check('B asks to join', (await b.svc.joinStart()).ok, true)
  const t = performance.now()
  const viaPresence = await until(() => a.svc.view().pairs.some((p) => p.device.id === bId), 8000)
  if (viaPresence) record('presence: a pairing request reaching A (the `pair` frame)', performance.now() - t)
  else await a.svc.syncNow()
  note(`A learned of B’s request ${viaPresence ? `from a presence frame, ${(performance.now() - t).toFixed(0)} ms after it was made` : 'only on its next sync: no presence frame arrived'}`)
  const req = a.svc.view().pairs.find((p) => p.device.id === bId)
  check('A lists the request, naming the device', [req?.device.label, req?.state], ['E2E Windows (B)', 'waiting'])
  need(req, 'A never saw the request')
  check('A answers it', (await a.svc.approveStart(req!.pair)).ok, true)
  await until(() => !!b.svc.view().join?.code && !!a.svc.view().pairs.find((p) => p.pair === req!.pair)?.code, 30_000)
  const codeA = a.svc.view().pairs.find((p) => p.pair === req!.pair)?.code ?? null
  const codeB = b.svc.view().join?.code ?? null
  ok(`both screens show the same six digits (A shows ${codeA}, B shows ${codeB})`, !!codeA && codeA === codeB && /^\d{3} \d{3}$/.test(codeA))
  check('A confirms the codes match and adds B', (await a.svc.approveConfirm(req!.pair)).ok, true)
  await until(() => b.svc.view().join?.state === 'approved', 30_000)
  check('B takes nothing on the hub’s word: still outside until the code is confirmed ON B', [b.svc.view().join?.state, b.svc.view().phase], ['approved', 'locked'])
  check('the owner confirms the code on B', (await b.svc.joinConfirm(true)).ok, true)
  await until(() => b.svc.view().phase === 'active' && b.svc.view().lastSyncAt !== null, 30_000)
  check('B is active beside A, at the same epoch', [b.svc.view().phase, b.svc.view().devices.some((d) => d.id === aId), b.svc.view().epoch === a.svc.view().epoch], ['active', true, true])
  const bState = JSON.parse(readFileSync(join(b.userData, 'hub-state.json'), 'utf8')) as { vaultKeys: Record<string, string> }
  check('B unwrapped the vault key (it holds a sealed copy for the epoch) and opened A’s settings with it', [Object.keys(bState.vaultKeys).includes(String(b.svc.view().epoch)), b.settings().themeId, b.settings().fontSize], [true, a.settings().themeId, a.settings().fontSize])
})

await phase('3. items: an API key and an SSH private key, sealed by A and opened by B; a version conflict', async () => {
  need(A && B && B.svc.view().phase === 'active', 'A and B are not both active')
  const a = A as Box
  const b = B as Box
  a.set({ providers: { ...a.settings().providers, anthropicApiKey: CANARY.apiKey } } as Partial<Settings>)
  check('A turns on key sync for the account', (await a.svc.setAccountKeys(true)).ok, true)
  await a.svc.syncNow()
  check('A sealed and put the API key item', a.svc.view().counts.keys >= 1, true)

  const keyName = `id_e2e_${RUN}`
  const keyPath = join(a.ssh.dir, keyName)
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', CANARY.sshComment, '-f', keyPath], { stdio: 'ignore' })
  writeFileSync(a.ssh.config, `Host e2e-nuc\n  IdentityFile ${keyPath}\n`, { mode: 0o600 })
  const priv = readFileSync(keyPath, 'utf8')
  const local = await a.svc.localKeys()
  check('A’s picker lists the ssh-keygen ed25519 pair', local.some((k) => k.name === keyName), true)
  const shared = await a.svc.shareKey(keyName)
  check('A seals and puts the SSH private key item', [shared.ok, shared.ok ? '' : shared.message], [true, ''])

  const bystander = `-----BEGIN OPENSSH PRIVATE KEY-----\nbystander-${RUN}\n-----END OPENSSH PRIVATE KEY-----\n`
  writeFileSync(join(b.ssh.dir, keyName), bystander, { mode: 0o600 })
  await b.svc.syncNow()
  check('B gets the API key item and opens it: the canary key is in B’s settings', b.settings().providers.anthropicApiKey, CANARY.apiKey)
  const onB = b.svc.view().sshKeys.find((k) => k.name === keyName)
  check(
    'B gets the SSH key item and opens it: offered by A, its comment intact, nothing written yet',
    [!!onB, onB?.mine, onB?.comment, onB?.installedAs ?? null, existsSync(join(b.ssh.dir, `${keyName}-stoke-2`))],
    [true, false, CANARY.sshComment, null, false]
  )
  need(onB, 'B never saw the key')
  const inst = await b.svc.installKey(onB!.keyId)
  check('B installs it under a free name, beside the same-named file already there', [inst.ok, inst.ok && inst.name], [true, `${keyName}-stoke-2`])
  if (inst.ok) note(inst.message)
  const written = join(b.ssh.dir, `${keyName}-stoke-2`)
  check('the key B wrote is byte for byte the one A generated', existsSync(written) && readFileSync(written, 'utf8') === priv, true)
  check('written owner-only (0600)', existsSync(written) ? statSync(written).mode & 0o777 : null, 0o600)
  check('the same-named file B already had is untouched', readFileSync(join(b.ssh.dir, keyName), 'utf8'), bystander)

  // The hub's compare-and-swap: a put on a version that is no longer current.
  const ca = await credsOf(a)
  const all = await raw('GET', '/v1/items?since=0', undefined, { as: ca })
  const items = (all.body?.items ?? []) as { seq: number; envelope: { id: string; version: number; author: string } }[]
  const target = [...items].reverse().find((i) => i.envelope.author === ca.id)
  need(target, 'A has no item of its own on the hub')
  const stale = await raw('POST', '/v1/items', { puts: [{ baseVersion: target!.envelope.version - 1, envelope: target!.envelope }] }, { as: ca })
  const r0 = stale.body?.results?.[0]
  check(
    'a put on a stale version is refused by the hub’s compare-and-swap, which answers with the current copy',
    [stale.status, r0?.ok, r0?.error, r0?.current?.envelope?.version],
    [200, false, 'conflict', target!.envelope.version]
  )
  note(`item ${target!.envelope.id.slice(0, 12)}… at version ${target!.envelope.version}; put with baseVersion ${target!.envelope.version - 1} → ${JSON.stringify({ ok: r0?.ok, error: r0?.error })}`)

  // Two devices change one setting: the later edit wins, and the loser's device says so.
  a.set({ themeId: 'lagoon' } as Partial<Settings>)
  await sleep(1200)
  b.set({ themeId: 'rose' } as Partial<Settings>)
  await sleep(1200)
  await a.svc.syncNow()
  await b.svc.syncNow()
  const noted = await until(() => b.svc.view().notes.find((n) => n.path === 't1/settings/themeId'), 15_000)
  check('two devices changed the theme: the later edit (B’s) wins and B reports the conflict', [b.settings().themeId, noted?.kept, noted?.otherDevice], ['rose', 'mine', 'E2E Mac (A)'])
  await a.svc.syncNow()
  check('A converges on it', (await until(() => a.settings().themeId === 'rose', 15_000)) ?? false, true)
})

await phase('4. presence over the WebSocket, through the edge', async () => {
  need(A && B && B.svc.view().phase === 'active', 'A and B are not both active')
  const a = A as Box
  const b = B as Box
  const both = await until(() => a.svc.view().devices.find((d) => d.id === bId)?.online && b.svc.view().devices.find((d) => d.id === aId)?.online, 30_000)
  check('A and B see each other online', !!both, true)
  for (const x of [a, b]) {
    const s = x.presenceSocks[0]
    note(`${x.name}: ${x.presenceSocks.length} presence socket(s); the first asked ${at(s?.startedAt ?? null)}, opened ${at(s?.openedAt ?? null)}${s?.closedAt ? `, closed ${at(s.closedAt)} (${s.code} ${s.reason})` : ', still open'}`)
  }
  a.pty.rows = [{ ptyId: PTY, project: 'e2e', title: `Stub ${CANARY.sessionTitle}`, status: 'idle', agentName: 'Stub agent', exited: false, lastActivityAt: Date.now(), context: null }]
  const t = performance.now()
  await a.svc.setSharing(true)
  const seen = await until(() => b.svc.remoteView().machines.find((m) => m.id === aId)?.status?.sessions.find((s) => s.title === `Stub ${CANARY.sessionTitle}`), 20_000)
  if (seen) record('presence: A’s sealed status reaching B', performance.now() - t)
  check('A shares its sessions: B opens A’s sealed status and lists the session', [seen?.ptyId, seen?.status, seen?.project], [PTY, 'idle', 'e2e'])
  a.pty.rows = [{ ...a.pty.rows[0], status: 'busy', title: `Stub ${CANARY.sessionTitle} (renamed)`, lastActivityAt: Date.now() }]
  const t2 = performance.now()
  a.svc.remoteSessionsChanged()
  const moved = await until(() => b.svc.remoteView().machines.find((m) => m.id === aId)?.status?.sessions.find((s) => s.title?.endsWith('(renamed)') && s.status === 'busy'), 25_000)
  if (moved) record('presence: a changed status reaching B (rate-limited to one per 3 s, polled every 4 s)', performance.now() - t2)
  check('statuses update: A’s session turns busy and is renamed, and B’s list follows', !!moved, true)
  const statusFrames = a.presenceSocks.flatMap((p) => p.sentSizes)
  ok('nothing A sent on presence carried a canary in the clear (statuses are sealed)', a.presenceSocks.every((p) => p.canaryHits === 0), `${statusFrames.length} frames`)
})

await phase('7a. a second account: A mints a member invite, C signs up and makes its own vault', async () => {
  need(A && A.svc.view().phase === 'active', 'A is not active')
  const ca = await credsOf(A as Box)
  const inv = await raw('POST', '/v1/auth/invites', {}, { as: ca })
  check('A (the owner) mints a member invite', [inv.status, /^INV(-[0-9A-Z]{4}){6}$/.test(String(inv.body?.invite ?? ''))], [200, true])
  need(inv.status === 200, `no invite: ${inv.text}`)
  C = device('C', { themeId: 'lagoon' } as Partial<Settings>)
  const c = C
  await c.svc.start()
  await c.svc.setUrl(URL_)
  const up = await c.svc.signIn({ invite: String(inv.body?.invite), email: EMAIL_C, password: PW_C, label: 'E2E Linux (C)' })
  check('C signs up with it: a separate account, a member', [up.ok, up.ok ? '' : up.message, c.svc.view().role], [true, '', 'member'])
  need(up.ok, 'C could not sign up')
  const made = await c.svc.createVault()
  need(made.ok, 'C made no Kit')
  check('C makes its own vault', (await c.svc.confirmKit(kitGroup(made as { kit: string; group: number }))).ok, true)
  await until(() => c.svc.view().phase === 'active' && c.svc.view().lastSyncAt !== null, 30_000)
  const cc = await credsOf(c)
  check('C is active in a vault of its own, under another account id', [c.svc.view().phase, cc.account !== ca.account, c.svc.view().devices.length], ['active', true, 1])
  // The relay is binary after its handshake, so first the plainest question about the path: does a
  // binary frame arrive as one? (C's own presence socket is replaced for a moment; it reconnects.)
  const bin = await binaryOnPresence(cc)
  check('a binary frame crosses the edge as binary: the hub refuses it on presence as binary (1003), not as broken text (1007 “not JSON”)', [bin.code, bin.reason], [1003, 'presence frames are JSON text'])
  note(`a binary {"t":"ping"} on presence → received [${bin.got.join(' | ')}], closed ${bin.code} "${bin.reason}"`)
})

await phase('5. relay through the edge: B opens A’s session, A allows once, frames both ways', async () => {
  need(A && B && B.svc.view().phase === 'active', 'A and B are not both active')
  const a = A as Box
  const b = B as Box
  need(b.svc.remoteView().machines.find((m) => m.id === aId)?.status?.sessions.some((s) => s.ptyId === PTY), 'B does not list A’s session')
  const t0 = performance.now()
  const opened = b.svc.remoteOpen(aId, PTY)
  check('B opens a remote tab on A’s session', opened.ok, true)
  need(opened.ok, 'no tab')
  tab = (opened as { tab: string }).tab
  const ask = await until(() => a.svc.remoteView().asks[0], 30_000)
  check('A’s host check runs: nothing is served, A asks its owner, naming B, the session and B’s key fingerprint', [ask?.device, ask?.ptyId, ask?.title?.includes(CANARY.sessionTitle), ask?.fingerprint.split(' ').length, a.pty.sockets.length], [bId, PTY, true, 4, 0])
  need(ask, 'A never asked')
  record('relay: open → A asked (create, both ends join, handshake, attach)', performance.now() - t0)
  const tAns = performance.now()
  check('A answers Allow once', (await a.svc.remoteAnswer(ask!.id, 'once')).ok, true)
  const attached = await until(() => b.svc.remoteView().tabs.find((x) => x.id === tab)?.state === 'open' && b.frames.find((f) => f.tab === tab && f.frame.type === 'attached'), 20_000)
  if (attached) record('relay: Allow once → the pty’s attach replay at B', performance.now() - tAns)
  check('B’s tab opens and gets the pty’s attach replay', [b.svc.remoteView().tabs.find((x) => x.id === tab)?.state, attached ? attached.frame.history : null], ['open', HISTORY])
  check('A shows B attached to that session, by Allow once, and saved no grant', [a.svc.remoteView().guests.map((g) => [g.device, g.ptyId, g.via]), Object.keys(a.settings().hub.grants)], [[[bId, PTY, 'once']], []])
  const bRelay = lastOpen(b.relaySocks)
  const aRelay = lastOpen(a.relaySocks)
  openRelayId = /\/v1\/ws\/relay\/([a-z0-9]+)/.exec(bRelay?.url ?? '')?.[1] ?? ''
  note(`relay ${openRelayId}: B’s socket opened ${at(bRelay?.openedAt ?? null)}, A’s ${at(aRelay?.openedAt ?? null)}`)

  // C, another account, at this open relay and at A.
  if (C && C.svc.view().phase === 'active' && openRelayId) {
    const cc = await credsOf(C)
    const rc = await raw('POST', '/v1/relays', { host: aId }, { as: cc })
    check('C (another account) cannot open a relay to A: the hub has no such device for it', [rc.status, rc.body?.error], [404, 'not-found'])
    note(`POST /v1/relays {host: A} as C → ${rc.status} ${rc.text}`)
    const pathV1 = `/v1/ws/relay/${openRelayId}`
    const join_ = await wsProbe(pathV1, signedHeaders('GET', pathV1, cc))
    check('nor join A and B’s open relay by its id: refused before the upgrade', [join_.opened, join_.status, safeJson(join_.body)?.error], [false, 404, 'not-found'])
    note(`GET ${pathV1} (upgrade) as C → ${join_.status} ${join_.body || join_.error}`)
  } else ok('C is active, and the open relay’s id is known, to probe it', false, `C ${C ? C.svc.view().phase : 'missing'}, relay id "${openRelayId}"`)

  // Typed text, both ways.
  const from = b.frames.length
  b.svc.remoteInput(tab, `echo ${CANARY.relayText}\r`)
  const echo = await until(() => framesSince(b, from, tab).find((f) => f.frame.type === 'data' && String(f.frame.data).includes(CANARY.relayText)), 15_000)
  check('B types; A’s pty gets exactly it, and B sees A’s echo', [a.pty.inputs.includes(`echo ${CANARY.relayText}\r`), echo?.frame.data], [true, `echo ${CANARY.relayText}\r`])
  for (let i = 0; i < 20; i++) {
    const text = `rtt-${i}-${RUN}\r`
    const f0 = b.frames.length
    const t = performance.now()
    b.svc.remoteInput(tab, text)
    const back = await until(() => framesSince(b, f0, tab).find((f) => f.frame.type === 'data' && f.frame.data === text), 10_000, 2)
    if (back) record('relay: keystroke round trip (B → hub → A’s pty → hub → B)', back.at - t)
  }
  check('20 keystroke round trips completed', lat['relay: keystroke round trip (B → hub → A’s pty → hub → B)']?.length ?? 0, 20)

  // A frame past one part, each way.
  const lines: string[] = []
  for (let i = 0, n = 0; n < 700_000; i++) {
    const line = `\u001b[2K\u001b[1A│ ${i} é ünï "q" \\ ─┼─ 😀 ${i % 97 === 0 ? CANARY.bigFrame : ''}\r\n`
    lines.push(line)
    n += line.length
  }
  const BIG = `\u001b[1m${CANARY.bigFrame}\u001b[0m ${lines.join('')}`
  const aSock = a.pty.sockets.filter((s) => s.readyState === 1).at(-1)
  need(aSock, 'A has no open pty socket for B')
  const aSentBefore = aRelay?.sentSizes.length ?? 0
  const f1 = b.frames.length
  const tBig = performance.now()
  aSock!.send(JSON.stringify({ type: 'data', ptyId: PTY, data: BIG }))
  const bigBack = await until(() => framesSince(b, f1, tab).find((f) => f.frame.type === 'data' && typeof f.frame.data === 'string' && f.frame.data.length > 100_000), 60_000, 20)
  if (bigBack) record(`relay: a ${(BIG.length / 1024).toFixed(0)} K-character frame A → B`, bigBack.at - tBig)
  const parts = (aRelay?.sentSizes ?? []).slice(aSentBefore)
  check(`a ${(BIG.length / 1024).toFixed(0)} K-character frame A → B arrives byte for byte (escapes, accents, emoji)`, [bigBack ? sha(bigBack.frame.data) : null, bigBack ? bigBack.frame.data.length : null], [sha(BIG), BIG.length])
  ok(`it crossed as ${parts.length} sealed parts, each under the hub’s ${RELAY_MAX_FRAME_BYTES}-byte cap (relayFrameParts, ${RELAY_CHUNK_CHARS} chars a part)`, parts.length > 1 && parts.every((n) => n <= RELAY_MAX_FRAME_BYTES), parts.join(','))
  note(`part sizes on A’s socket: ${parts.join(', ')} bytes`)
  const BIG2 = `${CANARY.bigFrame} ` + randomBytes(450_000).toString('base64') + ' é😀\u001b[0m'
  const f2 = b.frames.length
  const tBig2 = performance.now()
  const bSentBefore = bRelay?.sentSizes.length ?? 0
  b.svc.remoteInput(tab, BIG2)
  const ack = await until(() => framesSince(b, f2, tab).find((f) => f.frame.type === 'data' && String(f.frame.data).startsWith('ack:')), 60_000, 20)
  if (ack) record(`relay: a ${(BIG2.length / 1024).toFixed(0)} K-character input B → A, acknowledged`, ack.at - tBig2)
  check(`a ${(BIG2.length / 1024).toFixed(0)} K-character input B → A arrives byte for byte`, [a.pty.inputs.some((x) => x === BIG2), ack?.frame.data], [true, `ack:${BIG2.length}:${sha(BIG2)}`])
  note(`B sent it as ${(bRelay?.sentSizes ?? []).slice(bSentBefore).length} sealed parts`)

  // A flood at a reader that stopped reading: B's relay socket is paused (it reads nothing from
  // its TCP connection), A's stub pty writes FLOOD_MB, and A's own socket queue says where the
  // bytes went — drained to nothing (the path between them took it all), or stuck (pushed back).
  const bSock = lastOpen(b.relaySocks)
  const aSock2 = lastOpen(a.relaySocks)
  need(bSock && aSock2, 'no open relay sockets')
  const filler = randomBytes(384 * 1024).toString('base64')
  const K = Math.max(4, Math.round((FLOOD_MB * 1048576) / filler.length))
  const relaysBefore = b.relaySocks.length
  const attachedBefore = b.frames.filter((f) => f.tab === tab && f.frame.type === 'attached').length
  const f3 = b.frames.length
  const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`
  bSock!.ws.pause()
  const tFlood = performance.now()
  for (let i = 0; i < K; i++) aSock!.send(JSON.stringify({ type: 'data', ptyId: PTY, data: `FLOOD:${RUN}:${i}:${filler}` }))
  const queued0 = aSock2!.ws.bufferedAmount
  const samples: { t: number; q: number }[] = [{ t: Date.now(), q: queued0 }]
  const tPause = Date.now()
  let how: 'absorbed' | 'pushed back' | 'still sending' = 'still sending'
  for (;;) {
    await sleep(200)
    const now = Date.now()
    const q = aSock2!.ws.bufferedAmount
    samples.push({ t: now, q })
    if (q === 0) {
      how = 'absorbed'
      break
    }
    const fourAgo = samples.find((s) => s.t >= now - 4000)
    if (now - tPause > 4500 && fourAgo && fourAgo.q - q < 64 * 1024) {
      how = 'pushed back'
      break
    }
    if (now - tPause > 40_000) break
  }
  const paused = Date.now() - tPause
  const atResume = aSock2!.ws.bufferedAmount
  const delivered = framesSince(b, f3, tab).length
  bSock!.ws.resume()
  const all = await until(() => framesSince(b, f3, tab).filter((f) => f.frame.type === 'data' && String(f.frame.data).startsWith(`FLOOD:${RUN}:`)).length >= K, 180_000, 50)
  const drained = performance.now() - tFlood
  const flood = framesSince(b, f3, tab).filter((f) => f.frame.type === 'data' && String(f.frame.data).startsWith(`FLOOD:${RUN}:`))
  const order = flood.map((f) => Number(String(f.frame.data).split(':')[2]))
  const intact = flood.every((f) => String(f.frame.data).endsWith(filler))
  const total = K * (filler.length + 30)
  check(
    `a flood of ${K} × ${(filler.length / 1024).toFixed(0)} K characters (${mb(total)}) at B while B read nothing for ${(paused / 1000).toFixed(1)} s: every frame arrives, in order, intact, on the same relay`,
    [!!all, order, intact, b.relaySocks.length - relaysBefore, b.frames.filter((f) => f.tab === tab && f.frame.type === 'attached').length - attachedBefore, bSock!.closedAt === null],
    [true, Array.from({ length: K }, (_, i) => i), true, 0, 0, true]
  )
  if (all) record(`relay: a ${mb(total)} flood at a reader paused ${(paused / 1000).toFixed(0)} s, until B had it all`, drained)
  note(`A’s socket queue: ${mb(queued0)} right after writing, ${mb(atResume)} when B resumed ${(paused / 1000).toFixed(1)} s later (${how}); B had ${delivered} of the frames before it resumed`)
  if (LOCAL) {
    const hubLog = existsSync(join(TMP, 'hub.log')) ? readFileSync(join(TMP, 'hub.log'), 'utf8').split('\n') : []
    const mine = hubLog.filter((l) => l.includes(openRelayId))
    const held = mine.filter((l) => l.includes('"relay held"'))
    const released = mine.filter((l) => l.includes('"relay released"'))
    check('the hub’s flow control engaged: it paused A’s end and released it once B drained (its own debug log)', [held.length > 0, released.length > 0], [true, true])
    note(`hub log: ${held.length} "relay held", ${released.length} "relay released"; first: ${held[0]?.slice(0, 200) ?? '—'}`)
  }
  observations.push(
    how === 'pushed back'
      ? `flow control: with B paused, A's own socket stopped draining at ${mb(atResume)} of the ${mb(total)} flood — the back-pressure reached the sender (${LOCAL ? 'the hub held A’s end' : 'through cloudflared, the Worker and Cloudflare'})`
      : how === 'absorbed'
        ? `flow control: with B paused, A's socket drained completely in ${(paused / 1000).toFixed(1)} s — the path between A and B (${LOCAL ? 'the hub and the kernel’s socket buffers' : 'cloudflared, the edge Worker and Cloudflare’s network'}) buffered all ${mb(total)} for the paused reader instead of pushing back on A`
        : `flow control: after 40 s with B paused, A's socket was still draining (${mb(atResume)} left): the uplink, not the path, was the limit`
  )
  ok('nothing either relay socket sent carried a canary in the clear (frames are sealed end to end)', [a, b].every((x) => x.relaySocks.every((r) => r.canaryHits === 0)), [a, b].map((x) => x.relaySocks.map((r) => r.canaryHits).join(',')).join(' / '))
  const bText = b.relaySocks.reduce((n, r) => n + r.textSent, 0)
  const aText = a.relaySocks.reduce((n, r) => n + r.textSent, 0)
  note(`text frames sent on relay sockets (the handshake only): B ${bText}, A ${aText}; binary: B ${b.relaySocks.reduce((n, r) => n + r.binarySent, 0)}, A ${a.relaySocks.reduce((n, r) => n + r.binarySent, 0)}`)
})

if (IDLE_MS > 0) {
  await phase(`5b. the relay held quiet for ${Math.round(IDLE_MS / 1000)} s, and every socket's life so far`, async () => {
    need(A && B && tab, 'no open relay tab')
    const a = A as Box
    const b = B as Box
    const bSock = lastOpen(b.relaySocks)
    need(bSock, 'no open relay socket at B')
    const quietFrom = Date.now()
    const closedAt = await until(() => bSock!.closedAt, IDLE_MS, 1000)
    if (closedAt) {
      observations.push(`idle: B's quiet relay socket was closed after ${((closedAt - quietFrom) / 1000).toFixed(0)} s with code ${bSock!.code} "${bSock!.reason}"`)
      note(`B’s relay socket closed after ${((closedAt - quietFrom) / 1000).toFixed(0)} s quiet: ${bSock!.code} ${bSock!.reason}; tab log: ${b.tabLog.slice(-4).join(' | ')}`)
    } else note(`B’s relay socket stayed open through ${Math.round(IDLE_MS / 1000)} s with nothing typed`)
    ok(`the quiet relay is still the one that was open ${Math.round(IDLE_MS / 1000)} s ago`, !closedAt, `closed ${bSock!.code} ${bSock!.reason}`)
    const back = await until(() => b.svc.remoteView().tabs.find((x) => x.id === tab)?.state === 'open', 60_000)
    const f0 = b.frames.length
    b.svc.remoteInput(tab, `after-idle-${RUN}\r`)
    const echo = await until(() => framesSince(b, f0, tab).find((f) => f.frame.type === 'data' && f.frame.data === `after-idle-${RUN}\r`), 20_000)
    check('after the quiet spell the tab still types and echoes', [!!back, !!echo], [true, true])
    for (const x of [a, b]) {
      for (const s of x.presenceSocks) note(`${x.name} presence: opened ${at(s.openedAt)}${s.closedAt ? `, closed ${at(s.closedAt)} ${s.code} ${s.reason}${s.error ? ` (${s.error})` : ''}` : ', open'}`)
    }
    const presenceDrops = [a, b].flatMap((x) => x.presenceSocks.filter((s) => s.closedAt !== null).map((s) => `${x.name} ${s.code} ${s.reason}`))
    ok(`A’s and B’s presence sockets stayed up the whole run so far (${((Date.now() - T0) / 1000).toFixed(0)} s, past the hub’s 25 s ping rounds)`, presenceDrops.length === 0, presenceDrops.join('; '))
  })
}

await phase('6. A revokes B: B’s item read, open relay and presence all end', async () => {
  need(A && B && KIT, 'A, B or the Kit is missing')
  const a = A as Box
  const b = B as Box
  bCredsBeforeRevoke = await credsOf(b)
  const bRelay = lastOpen(b.relaySocks)
  const bPresence = lastOpen(b.presenceSocks)
  note(`before: B’s tab ${b.svc.remoteView().tabs.find((x) => x.id === tab)?.state ?? 'none'}, relay socket ${bRelay ? 'open' : 'none'}, presence ${bPresence ? 'open' : 'none'}; A hosts ${a.svc.remoteView().guests.length} guest(s)`)
  const epoch = a.svc.view().epoch
  const tRevoke = Date.now()
  const gone = await a.svc.revokeDevice(bId, { kit: KIT })
  check('A removes B with the Kit: a new epoch, B gone from the list', [gone.ok, gone.ok ? '' : gone.message, a.svc.view().epoch, a.svc.view().devices.some((d) => d.id === bId)], [true, '', epoch + 1, false])
  const relayEnded = await until(() => !bRelay || bRelay.closedAt !== null, 20_000)
  if (relayEnded && bRelay?.closedAt) record('revoke: A’s request sent → B’s open relay socket closed', bRelay.closedAt - tRevoke)
  // Who closes first is a race: the hub (1008 "a device was removed"), or B itself on the presence `bye` it got a moment earlier.
  check('B’s open relay ends', [!!relayEnded, bRelay?.ws.readyState], [true, 3])
  note(`B’s relay socket closed ${bRelay?.closedAt ? `${bRelay.closedAt - tRevoke} ms after the revoke was sent` : '(never)'}: ${bRelay?.code} "${bRelay?.reason}"`)
  const tabEnded = await until(() => {
    const st = b.svc.remoteView().tabs.find((x) => x.id === tab)?.state
    return st === 'lost' || st === 'refused' || st === undefined ? st ?? 'gone' : null
  }, 20_000)
  check('B’s remote tab ends and is not reconnected', [tabEnded === 'lost' || tabEnded === 'refused' || tabEnded === 'gone'], [true])
  note(`B’s tab: ${b.tabLog.slice(-3).join(' | ')}`)
  check('A’s side: no guest attached, the relayed pty socket closed', [a.svc.remoteView().guests.length, a.pty.sockets.every((s) => s.readyState === 3)], [0, true])
  const presenceEnded = await until(() => !bPresence || bPresence.closedAt !== null, 20_000)
  check('B’s presence socket is closed by the hub, saying why', [!!presenceEnded, bPresence?.code, bPresence?.reason], [true, 1008, 'this device was removed from the account'])
  await until(() => b.svc.view().phase === 'revoked', 10_000)
  check('B knows it was removed', b.svc.view().phase, 'revoked')
  const items = await raw('GET', '/v1/items?since=0', undefined, { as: bCredsBeforeRevoke })
  check('B’s next item read fails: its session died with the revoke', [items.status, items.body?.error], [401, 'unauthorized'])
  note(`GET /v1/items as B → ${items.status} ${items.text}`)
  const pres = await wsProbe('/v1/ws/presence', signedHeaders('GET', '/v1/ws/presence', bCredsBeforeRevoke))
  check('B’s presence is refused at the upgrade', [pres.opened, pres.status, safeJson(pres.body)?.error], [false, 401, 'unauthorized'])
  note(`GET /v1/ws/presence (upgrade) as B → ${pres.status} ${pres.body || pres.error}`)
  const again = await b.svc.signIn({ email: EMAIL_A, password: PW_A })
  check('B cannot sign back in as the same device', [again.ok, b.svc.view().phase], [false, 'revoked'])
  a.set({ providers: { ...a.settings().providers, openrouterApiKey: CANARY.afterRevoke } } as Partial<Settings>)
  await a.svc.syncNow()
  const bSync = await b.svc.syncNow()
  check('a key A adds after the revoke never reaches B', [bSync.ok, b.settings().providers.openrouterApiKey === CANARY.afterRevoke], [false, false])
  if (A) saveRunState(A)
})

await phase('7b. isolation: account C reads nothing of A’s; forged and replayed requests are refused', async () => {
  need(A && C && C.svc.view().phase === 'active', 'C is not active')
  const ca = await credsOf(A as Box)
  const cc = await credsOf(C as Box)
  const aItems = await raw('GET', '/v1/items?since=0', undefined, { as: ca })
  const cItems = await raw('GET', '/v1/items?since=0', undefined, { as: cc })
  const aIds = new Set(((aItems.body?.items ?? []) as { envelope: { id: string } }[]).map((i) => i.envelope.id))
  const cIds = ((cItems.body?.items ?? []) as { envelope: { id: string } }[]).map((i) => i.envelope.id)
  check(`C’s change feed holds its own items only: none of A’s ${aIds.size}`, [cItems.status, cIds.length > 0, cIds.filter((id) => aIds.has(id)).length], [200, true, 0])
  const cChain = await raw('GET', '/v1/chain', undefined, { as: cc })
  const named = ((cChain.body?.entries ?? []) as { device?: { id: string }; signer: string; account: string }[]).flatMap((e) => [e.device?.id, e.signer, e.account])
  check('C’s device list is C’s: it names neither A nor B nor A’s account', [cChain.status, named.includes(aId), named.includes(bId), named.includes(ca.account), named.includes(cc.id)], [200, false, false, false, true])
  const cPairs = await raw('GET', '/v1/pair', undefined, { as: cc })
  check('C sees no pairing request of A’s account', [cPairs.status, (cPairs.body?.pairs ?? []).length], [200, 0])
  const cAcct = await raw('GET', '/v1/account', undefined, { as: cc })
  check('C’s account is not A’s', [cAcct.body?.accountId === cc.account, cAcct.body?.accountId !== ca.account, cAcct.body?.role], [true, true, 'member'])
  const cMint = await raw('POST', '/v1/auth/invites', {}, { as: cc })
  check('C, a member, may not mint invites', [cMint.status, cMint.body?.error], [403, 'forbidden'])

  const h = signedHeaders('GET', '/v1/account', cc)
  const first = await sendRaw('GET', '/v1/account', h)
  const replay = await sendRaw('GET', '/v1/account', h)
  check('a signed request sent twice: the second is a replay', [first.status, replay.status, replay.body?.error], [200, 401, 'replayed'])
  const body = await raw('POST', '/v1/items', { puts: [] }, { as: cc, signBody: JSON.stringify({ puts: [{ baseVersion: 0 }] }) })
  check('a body changed after signing is refused', [body.status, body.body?.error], [401, 'bad-signature'])
  const path = await raw('GET', '/v1/items?since=1', undefined, { as: cc, signPath: '/v1/items?since=0' })
  check('a query changed after signing is refused', [path.status, path.body?.error], [401, 'bad-signature'])
  const stolen = await raw('GET', '/v1/items?since=0', undefined, { as: ca, signKey: cc.signPriv })
  check('A’s token, signed with C’s key, reads nothing', [stolen.status, stolen.body?.error], [401, 'bad-signature'])
  const claim = await raw('GET', '/v1/items?since=0', undefined, { as: cc, deviceHeader: ca.id })
  check('C’s token claiming A’s device id reads nothing', [claim.status, claim.body?.error], [401, 'bad-signature'])
  const old = await raw('GET', '/v1/account', undefined, { as: cc, ts: Date.now() - 10 * 60_000 })
  check('a request signed ten minutes ago is refused', [old.status, old.body?.error], [401, 'clock-skew'])
  const bare = await sendRaw('GET', '/v1/account', { authorization: `Bearer ${cc.token}` })
  check('the bearer token alone, unsigned, is refused', [bare.status, bare.body?.error], [401, 'bad-signature'])
  const after = await raw('GET', '/v1/account', undefined, { as: cc })
  check('and C’s honest requests still work after all that', after.status, 200)
})

await phase('8. lockout: an email, a device that proves itself, and an address', async () => {
  need(C && C.svc.view().phase === 'active', 'C is not active')
  const c = C as Box
  const cc = await credsOf(c)
  const k = generateDeviceKeys()
  const stranger = { id: idFromBytes('device', randomU8(10)), label: 'Stranger', platform: 'linux', sign: k.signPub, box: k.boxPub, caps: [...DEVICE_CAPS] }
  const codes: string[] = []
  for (let i = 0; i < 6; i++) {
    const r = await raw('POST', '/v1/auth/login', { email: EMAIL_C, password: `wrong-password-${i}-${RUN}`, device: stranger })
    record('HTTP POST /v1/auth/login (a wrong password: one scrypt on the hub)', r.ms)
    codes.push(`${r.status} ${r.body?.error}`)
  }
  check('six wrong passwords for C’s email from a new device: five refusals, then locked', codes, [...Array(5).fill('401 unauthorized'), '429 locked'])
  const right = await raw('POST', '/v1/auth/login', { email: EMAIL_C, password: PW_C, device: stranger })
  check('now even the right password, from a device the account does not hold, is locked out', [right.status, right.body?.error], [429, 'locked'])
  note(`locked: ${right.text}`)
  const svcIn = await c.svc.signIn({ email: EMAIL_C, password: PW_C })
  check('C’s own, already-active device signs in through Stoke (it proves itself): not locked out', [svcIn.ok, svcIn.ok ? svcIn.state : svcIn.message], [true, 'active'])
  const proven = await raw('POST', '/v1/auth/login', { email: EMAIL_C, password: PW_C, device: { id: cc.id, label: 'E2E Linux (C)', platform: 'darwin', sign: cc.signPub, box: cc.boxPub, caps: [...DEVICE_CAPS] } }, { proof: cc })
  check('the same as a raw request signed by C’s device key: a session, state active', [proven.status, proven.body?.state, typeof proven.body?.token], [200, 'active', 'string'])
  if (!IP_LOCKOUT) {
    note('the address check was skipped (--no-ip-lockout)')
    return
  }
  let n = 0
  let locked: Reply | null = null
  for (let e = 0; e < 10 && !locked; e++) {
    for (let i = 0; i < 5 && !locked; i++) {
      const r = await raw('POST', '/v1/auth/login', { email: `stranger-${RUN}-${e}@example.com`, password: `guess-${e}-${i}`, device: stranger })
      if (r.status === 429 && /address/.test(String(r.body?.message))) locked = r
      else if (r.status === 401) n++
      else if (r.status === 429 && r.body?.error === 'rate-limited') await sleep(1500)
    }
  }
  check('a stranger guessing from one address is throttled: the address is refused after its failures', [locked?.status, locked?.body?.error], [429, 'rate-limited'])
  note(`refused after ${n} more failed sign-ins in this phase (plus the 5 above): ${locked?.text}`)
  const cAfter = await raw('POST', '/v1/auth/login', { email: EMAIL_C, password: PW_C, device: { id: cc.id, label: 'E2E Linux (C)', platform: 'darwin', sign: cc.signPub, box: cc.boxPub, caps: [...DEVICE_CAPS] } }, { proof: cc })
  observations.push(
    `address lock: once this address was refused, C's own proven device signing in FROM THE SAME ADDRESS got ${cAfter.status} ${cAfter.body?.error} — the per-address lock (unlike the email lock) applies to proven devices too; it only matters where a stranger shares the owner's address (NAT, CGNAT)`
  )
  observations.push(`this machine's address is now refused sign-in and sign-up on ${BASE} for 15 minutes`)
})

/* ============================================================ the report */

console.log('\n================ summary')
console.log('\ncanaries — sealed in every secret this run; the hub must hold none of them in the clear:')
for (const [k, v] of Object.entries(CANARY)) console.log(`  ${k.padEnd(13)} ${v}`)
console.log(`  grep the hub's database for:  E2ECANARY-${RUN}`)
console.log(`  passwords (never stored either): A ${PW_A}   C ${PW_C}`)
if (KIT) console.log(`  A's Recovery Kit (never sent to the hub): ${KIT}`)
if (LOCAL && existsSync(HUB_DATA)) {
  const files = readdirSync(HUB_DATA).filter((f) => f.startsWith('hub.db'))
  const bytes = Buffer.concat(files.map((f) => readFileSync(join(HUB_DATA, f))))
  const leaked = [...Object.values(CANARY), `E2ECANARY-${RUN}`, PW_A, PW_C, ...(KIT ? [KIT] : [])].filter((s) => bytes.includes(Buffer.from(s)))
  check(`the local hub’s database (${files.join(', ')}) holds no canary, password or Kit`, leaked, [])
}

console.log('\nlatency')
for (const [k, xs] of Object.entries(lat)) console.log(`  ${k}: ${stats(xs)}`)

console.log('\nsockets (times from the start of the run)')
for (const x of boxes) {
  for (const s of [...x.presenceSocks, ...x.relaySocks]) {
    const id = s.kind === 'relay' ? ` ${/relay\/([a-z0-9]+)/.exec(s.url)?.[1]?.slice(0, 8) ?? ''}…` : ''
    console.log(
      `  ${x.name} ${s.kind}${id}: asked ${at(s.startedAt)}, opened ${at(s.openedAt)}, ${s.closedAt ? `closed ${at(s.closedAt)} ${s.code} "${s.reason}"` : 'still open'}${s.error ? ` (error: ${s.error})` : ''}; sent ${s.textSent} text + ${s.binarySent} binary frames`
    )
  }
}

console.log('\nHTTP requests each device’s client made (all from this machine’s one address)')
for (const x of boxes) {
  const by: Record<string, number> = {}
  for (const r of x.requests) {
    const code = r.split(' ')[1]
    by[code] = (by[code] ?? 0) + 1
  }
  console.log(`  ${x.name}: ${x.requests.length} — ${Object.entries(by).map(([c, n]) => `${c}×${n}`).join(', ')}`)
}

if (LOCAL && existsSync(join(TMP, 'hub.log'))) {
  console.log('\nthe local hub’s own account of each relay')
  for (const l of readFileSync(join(TMP, 'hub.log'), 'utf8').split('\n')) if (l.includes('"relay closed"')) console.log(`  ${l}`)
}

if (observations.length) {
  console.log('\nobservations')
  for (const o of observations) console.log(`  - ${o}`)
}

/* ============================================================ cleanup */

for (const x of boxes) {
  try {
    x.svc.stop()
  } catch {
    /* already stopped */
  }
  for (const s of [...x.presenceSocks, ...x.relaySocks]) if (s.ws.readyState <= 1) s.ws.terminate()
}
if (failures > 0) {
  console.log('\nlogs of each device (last 15 lines) and its last HTTP answers:')
  for (const x of boxes) {
    console.log(`  ${x.name}:`)
    for (const l of x.logs.slice(-15)) console.log(`    ${l}`)
    for (const l of x.requests.slice(-8)) console.log(`    ${l}`)
  }
}
if (localHub) await localHub.close()
if (A && !RESUME) saveRunState(A)
if (failures === 0 && !KEEP && !RESUME) rmSync(TMP, { recursive: true, force: true })
else console.log(`\nscratch kept: ${TMP}${A && !LOCAL ? `  (rerun with --url ${URL_} --resume ${TMP} to reuse owner A)` : ''}`)
// Anything left holding the loop (a socket's close handshake, a keep-alive) must not keep a finished run alive.
setTimeout(() => process.exit(), 5000).unref()

console.log(`\n${passes} passed, ${failures} failed`)
process.exitCode = failures ? 1 : 0
