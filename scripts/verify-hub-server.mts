/*
 * Stoke Hub's SERVER (hub/), driven over real sockets: the HTTP routes, the
 * presence and relay WebSockets, the SQLite file it leaves behind, the edge
 * Worker's forwarding into it, and the `stoke-hub` command as a child process
 * — from source under strip-types and as the one-file bundle the NUC runs.
 *
 *   node scripts/verify-hub-server.mts
 *
 * Every input is synthetic (gotcha 74): the data directories are fresh temp
 * dirs, the clock the server judges by is a fake one this file advances, and
 * every key, invite and password is made here. Nothing reaches the network
 * beyond 127.0.0.1, no real agent CLI runs, and nothing in ~ is read.
 *
 * The contract itself (codecs, chain rules, the crypto) is verify:hub's; this
 * suite is about whether the server built on it does what the spec says a hub
 * does — and refuses what it says a hub refuses.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startHub, type HubHandle } from '../hub/app.ts'
import { configFrom, parseListen, parseMount, readEdgeSecret } from '../hub/config.ts'
import { HubLog } from '../hub/log.ts'
import { HubStore } from '../hub/store.ts'
import { forwardHttp } from '../worker/hub-edge.ts'
import {
  generateDeviceKeys,
  itemKeys,
  newVaultKey,
  nodeChainCrypto,
  openItem,
  openRecoveryWrap,
  openStatus,
  pairCode,
  pairCommit,
  presenceKey,
  randomB64u,
  randomU8,
  RelayCipher,
  recoveryKeys,
  relayAccept,
  relayAnswer,
  relayEphemeral,
  relayFinish,
  relayHello,
  relayKeys,
  sealItem,
  sealRecoveryWrap,
  sealStatus,
  sha256B64u,
  signRequest,
  signText,
  unwrapVaultKey,
  vaultKeyCommit,
  wrapVaultKey,
  type DeviceKeys
} from '../src/main/hub/crypto.ts'
import { isSessionToken, LOGIN_REFUSED, SESSION_TTL_MS } from '../src/shared/hub/auth.ts'
import { chainLinkText, chainSigningText, DEVICE_CAPS, verifyChain, type ChainEntry, type DeviceRecord } from '../src/shared/hub/chain.ts'
import { idFromBytes } from '../src/shared/hub/codec.ts'
import { hubEndpoint } from '../src/shared/hub/edge.ts'
import { formatRecoverySecret, parseRecoverySecret } from '../src/shared/hub/pairing.ts'
import { HUB_HEADERS, HUB_LIMITS, readHubResponse } from '../src/shared/hub/protocol.ts'
import { hs1Problem, RELAY_IDLE_MS, RELAY_MAX_FRAME_BYTES, RELAY_OPEN_TTL_MS, RELAYS_PER_ACCOUNT, type RelayHs1, type RelayHs2, type RelayHs3 } from '../src/shared/hub/relay.ts'
import { RELAY_HIGH_WATER } from '../hub/sockets.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${JSON.stringify(got)?.slice(0, 400)}, want ${JSON.stringify(want)?.slice(0, 400)}`))
}
function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail.slice(0, 600)}`}`)
}

const TMP = mkdtempSync(join(tmpdir(), 'stoke-hub-server-'))
let clock = Date.parse('2026-10-01T09:00:00Z')
const now = (): number => clock
const SECRET = randomB64u(32)
const logLines: string[] = []
const announced: string[] = []
const secretsSeen: string[] = [SECRET]

/* ------------------------------------------------------------- the client */

interface Dev {
  name: string
  keys: DeviceKeys
  id: string
  platform: string
  token: string
  account: string
}

function newDevice(name: string, platform = 'darwin'): Dev {
  return { name, keys: generateDeviceKeys(), id: idFromBytes('device', randomU8(10)), platform, token: '', account: '' }
}

function draftOf(d: Dev): { id: string; label: string; platform: string; sign: string; box: string } {
  return { id: d.id, label: d.name, platform: d.platform, sign: d.keys.signPub, box: d.keys.boxPub }
}

function recordOf(d: Dev): DeviceRecord {
  return { ...draftOf(d), caps: [...DEVICE_CAPS], addedAt: clock }
}

interface Reply {
  status: number
  body: any
  text: string
  headers: Headers
  ms: number
}

let hub: HubHandle
let EDGE = ''
let LAN = ''

interface CallOpts {
  dev?: Dev
  /** Go through the edge listener as this client IP (with the secret); default: the LAN listener. */
  ip?: string
  /** The edge secret to present (edge calls only); null for none. */
  secret?: string | null
  headers?: Record<string, string>
  ts?: number
  nonce?: string
  /** Sign this body but send `body`. */
  signBody?: string
  /** Sign this path but send the real one. */
  signPath?: string
  base?: string
  raw?: string
  /** Sign this request with the device's key but no bearer: an active device proving itself at sign-in. */
  proof?: Dev
}

async function call(method: 'GET' | 'POST', pathV1: string, body?: unknown, o: CallOpts = {}): Promise<Reply> {
  const text = o.raw ?? (body === undefined ? '' : JSON.stringify(body))
  const viaEdge = o.ip !== undefined || o.secret !== undefined
  const base = o.base ?? (viaEdge ? EDGE : LAN)
  const headers: Record<string, string> = {}
  if (text) headers['content-type'] = 'application/json'
  if (viaEdge && o.secret !== null) headers[HUB_HEADERS.edge] = o.secret ?? SECRET
  if (viaEdge && o.ip) headers[HUB_HEADERS.clientIp] = o.ip
  if (o.dev?.token) {
    Object.assign(
      headers,
      signRequest({
        method,
        pathFromV1: o.signPath ?? pathV1,
        device: o.dev.id,
        signPriv: o.dev.keys.signPriv,
        token: o.dev.token,
        body: o.signBody ?? text,
        now: o.ts ?? clock,
        nonce: o.nonce
      })
    )
  } else if (o.proof) {
    Object.assign(headers, signRequest({ method, pathFromV1: pathV1, device: o.proof.id, signPriv: o.proof.keys.signPriv, body: text, now: o.ts ?? clock, nonce: o.nonce }))
  }
  Object.assign(headers, o.headers)
  const started = performance.now()
  const res = await fetch(hubEndpoint(base, pathV1), { method, headers, body: text || undefined })
  const t = await res.text()
  let parsed: unknown = null
  try {
    parsed = t ? JSON.parse(t) : null
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed, text: t, headers: res.headers, ms: performance.now() - started }
}

/** A raw request (no URL normalisation, any header), for what fetch will not send. */
function rawRequest(port: number, method: string, path: string, headers: Record<string, string>, body?: Buffer | string, chunked = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let answered = false
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      answered = true
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    // A server that answers 413 and closes mid-upload leaves the rest of our write to fail: that is the point.
    req.on('error', () => {
      if (!answered) resolve({ status: -1, body: '' })
    })
    if (body !== undefined) {
      if (chunked) {
        const b = Buffer.isBuffer(body) ? body : Buffer.from(body)
        for (let i = 0; i < b.length; i += 64 * 1024) req.write(b.subarray(i, i + 64 * 1024))
      } else req.write(body)
    }
    req.end()
  })
}

async function signup(invite: string, email: string, password: string, o: CallOpts = {}): Promise<Reply> {
  return call('POST', '/v1/auth/signup', { invite, email, password }, o)
}

async function login(d: Dev, email: string, password: string, o: CallOpts & { prove?: boolean } = {}): Promise<Reply> {
  const r = await call('POST', '/v1/auth/login', { email, password, device: draftOf(d) }, { ...o, proof: o.prove ? d : undefined })
  if (r.status === 200) {
    d.token = r.body.token
    d.account = r.body.accountId
    secretsSeen.push(d.token)
  }
  return r
}

/* ------------------------------------------------------------ sockets */

class Probe {
  readonly ws: WebSocket
  readonly frames: { data: Buffer; binary: boolean }[] = []
  closed: { code: number; reason: string } | null = null
  private waiters: (() => void)[] = []

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (d: Buffer, binary: boolean) => {
      this.frames.push({ data: Buffer.from(d), binary })
      this.wake()
    })
    ws.on('close', (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString('utf8') }
      this.wake()
    })
    ws.on('error', () => {})
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async until<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T | undefined> {
    const deadline = performance.now() + ms
    for (;;) {
      const v = fn()
      if (v) return v
      const left = deadline - performance.now()
      if (left <= 0) return undefined
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 200))
        this.waiters.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  json(): any[] {
    return this.frames.filter((f) => !f.binary).map((f) => {
      try {
        return JSON.parse(f.data.toString('utf8'))
      } catch {
        return null
      }
    })
  }

  /** The first JSON frame matching, waiting for it. */
  async frame(pred: (f: any) => boolean, ms = 3000): Promise<any> {
    return this.until(() => this.json().find((f) => f && pred(f)), ms)
  }
}

/** Open a signed hub socket; a refused upgrade answers its HTTP status and JSON body instead. */
function openSocket(pathV1: string, d: Dev, o: { base?: string; ts?: number } = {}): Promise<{ probe: Probe } | { status: number; body: any }> {
  const base = (o.base ?? LAN).replace(/^http/, 'ws')
  const headers = signRequest({ method: 'GET', pathFromV1: pathV1, device: d.id, signPriv: d.keys.signPriv, token: d.token, body: '', now: o.ts ?? clock })
  return new Promise((resolve) => {
    const ws = new WebSocket(hubEndpoint(base, pathV1), { headers, maxPayload: 4 * 1024 * 1024 })
    const probe = new Probe(ws)
    ws.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        let body: unknown = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          body = null
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    ws.on('open', () => resolve({ probe }))
    ws.on('error', () => resolve({ status: -1, body: null }))
  })
}

async function mustOpen(pathV1: string, d: Dev, what: string): Promise<Probe> {
  const r = await openSocket(pathV1, d)
  if ('probe' in r) return r.probe
  ok(what, false, `refused with ${r.status} ${JSON.stringify(r.body)}`)
  throw new Error(`could not open ${pathV1}`)
}

function sendOn(p: Probe, data: string | Buffer, binary: boolean): Promise<void> {
  return new Promise((resolve, reject) => p.ws.send(data, { binary }, (err) => (err ? reject(err) : resolve())))
}

/* ------------------------------------------------------------ chains */

function entry(account: string, prev: ChainEntry | null, fields: Omit<ChainEntry, 'v' | 'account' | 'seq' | 'prev' | 'ts' | 'sig'>, signPriv: string): ChainEntry {
  const bare: Omit<ChainEntry, 'sig'> = {
    v: 1,
    account,
    seq: prev ? prev.seq + 1 : 0,
    prev: prev ? sha256B64u(chainLinkText(prev)) : '',
    ts: clock,
    ...fields
  }
  return { ...bare, sig: signText(signPriv, chainSigningText(bare)) }
}

function wrapFor(vk: Uint8Array, account: string, epoch: number, d: Dev): { device: string; wrap: ReturnType<typeof wrapVaultKey> } {
  return { device: d.id, wrap: wrapVaultKey(vk, { account, epoch, device: d.id, boxPub: d.keys.boxPub }) }
}

/**
 * What a device does before it trusts any wrap: fetch the chain, verify it
 * itself, and take the epoch's vault-key commitment from THAT — never from
 * anything the hub says beside the wrap. '' (which matches no key) when the
 * chain does not verify.
 */
async function commitFromChain(d: Dev, epoch: number): Promise<string> {
  const c = await call('GET', '/v1/chain', undefined, { dev: d })
  const v = verifyChain(c.body?.entries ?? [], nodeChainCrypto, { account: d.account })
  return v.ok ? (v.vkCommits[epoch] ?? '') : ''
}

/* =================================================================== */

async function main(): Promise<void> {
  hub = await startHub(
    { dataDir: join(TMP, 'hub'), mount: '/hub', edge: { host: '127.0.0.1', port: 0 }, lan: { host: '127.0.0.1', port: 0 }, edgeSecret: SECRET, rate: { capacity: 100_000, refillPerSec: 1000 }, pingMs: 60 * 60_000 },
    { now, log: new HubLog((l) => logLines.push(l), { now, level: 'debug' }), announce: (t) => announced.push(t) }
  )
  EDGE = `http://127.0.0.1:${hub.edgePort}/hub`
  LAN = `http://127.0.0.1:${hub.lanPort}/hub`

  /* ------------------------------------------------ start, front door */
  console.log('\nfirst start: the bootstrap invite, and the two listeners')
  const boot = /^stoke-hub: no accounts yet\. Sign up from Stoke with this invite \(valid 24 h, one use\):\n {2}(INV(?:-[0-9A-Z]{4}){6})\n$/.exec(announced.join(''))
  ok('a fresh hub prints exactly one invite, in the spec’s words', announced.length === 1 && boot !== null, JSON.stringify(announced))
  const bootInvite = boot?.[1] ?? ''
  secretsSeen.push(bootInvite)
  {
    const h = await call('GET', '/v1/health')
    check('health on the LAN listener needs no secret', [h.status, h.body?.server, h.body?.protocol, h.body?.needsBootstrap], [200, 'stoke-hub', 1, true])
    const read = readHubResponse(h.status, h.headers.get('content-type'), h.text)
    ok('and reads as a hub (readHubResponse)', read.ok)
    const noSecret = await call('GET', '/v1/health', undefined, { secret: null })
    check('the edge listener refuses a request without the secret', [noSecret.status, noSecret.body?.error], [403, 'edge-refused'])
    const wrong = await call('GET', '/v1/health', undefined, { secret: randomB64u(32) })
    check('and one with a wrong secret of the right length', [wrong.status, wrong.body?.error], [403, 'edge-refused'])
    const prefix = await call('GET', '/v1/health', undefined, { secret: SECRET.slice(0, -1) })
    check('and one with the secret minus its last character', [prefix.status, prefix.body?.error], [403, 'edge-refused'])
    const right = await call('GET', '/v1/health', undefined, { secret: SECRET })
    check('and takes the right one', right.status, 200)
    const readRefusal = readHubResponse(noSecret.status, noSecret.headers.get('content-type'), noSecret.text)
    check('a refusal is still a hub error a Stoke can show', !readRefusal.ok && readRefusal.error.error, 'edge-refused')
    for (const h2 of ['cf-ray', 'cf-connecting-ip', 'cf-worker', 'tailscale-funnel-request', HUB_HEADERS.edge]) {
      const r = await call('GET', '/v1/health', undefined, { headers: { [h2]: 'x' } })
      check(`the LAN listener refuses a request carrying ${h2} (the public internet on the no-secret port)`, [r.status, r.body?.error], [403, 'edge-refused'])
    }
    const nf = await call('GET', '/v1/nothing-here')
    check('an unknown route is a JSON 404', [nf.status, nf.body?.error, nf.headers.get('content-type')], [404, 'not-found', 'application/json; charset=utf-8'])
    const outside = await rawRequest(hub.lanPort as number, 'GET', '/v1/health', {})
    check('a path outside the /hub mount is a 404', outside.status, 404)
    const dots = await rawRequest(hub.lanPort as number, 'GET', '/hub/v1/../v1/health', {})
    check('a dot segment is not normalised into a route', dots.status, 404)
    const absolute = await rawRequest(hub.lanPort as number, 'GET', 'http://evil.example/hub/v1/health', {})
    check('an absolute-form request target is refused', absolute.status, 404)
    const ws = await call('GET', '/v1/ws/presence')
    check('a plain GET to a socket route is refused', ws.status >= 400, true)
  }
  {
    const bare = await startHub(
      { dataDir: join(TMP, 'bare'), mount: '/hub', edge: { host: '127.0.0.1', port: 0 }, lan: null, edgeSecret: null },
      { now, log: new HubLog(() => {}), announce: () => {} }
    )
    const b1 = await call('GET', '/v1/health', undefined, { base: `http://127.0.0.1:${bare.edgePort}/hub`, secret: '', headers: { [HUB_HEADERS.edge]: '' } })
    const b2 = await call('GET', '/v1/health', undefined, { base: `http://127.0.0.1:${bare.edgePort}/hub`, secret: SECRET })
    check('an edge listener with NO secret configured refuses everything, even an empty header', [b1.status, b2.status], [403, 403])
    await bare.close()
    const short = await startHub(
      { dataDir: join(TMP, 'short'), mount: '/hub', edge: { host: '127.0.0.1', port: 0 }, lan: null, edgeSecret: 'too-short' },
      { now, log: new HubLog(() => {}), announce: () => {} }
    )
    const s1 = await call('GET', '/v1/health', undefined, { base: `http://127.0.0.1:${short.edgePort}/hub`, secret: 'too-short' })
    check('and so does one whose secret is under 32 characters, even when presented', s1.status, 403)
    await short.close()
  }

  /* ------------------------------------------------------- sign-up */
  console.log('\nsign-up: invite only')
  const OWNER_EMAIL = 'Owner@Example.COM '
  const OWNER_PW = `correct horse ${randomB64u(6)} staple`
  secretsSeen.push(OWNER_PW)
  {
    const badEmail = await signup(bootInvite, 'not-an-email', OWNER_PW)
    check('a malformed email is refused', [badEmail.status, badEmail.body?.error], [400, 'bad-request'])
    const weak = await signup(bootInvite, OWNER_EMAIL, 'short')
    check('a short password is weak-password, with the reason', [weak.status, weak.body?.error, /12 characters/.test(weak.body?.message ?? '')], [400, 'weak-password', true])
    const bogus = await signup('INV-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', OWNER_EMAIL, OWNER_PW)
    check('an invite the hub never minted is refused', [bogus.status, bogus.body?.error], [400, 'invite-invalid'])
    const typed = bootInvite.toLowerCase().replace(/-/g, ' ')
    const first = await signup(typed, OWNER_EMAIL, OWNER_PW)
    check('the bootstrap invite, typed in lower case with spaces, makes the owner', [first.status, first.body?.role], [200, 'owner'])
    const again = await signup(bootInvite, 'second@example.com', OWNER_PW)
    check('it is one use', [again.status, again.body?.error], [400, 'invite-invalid'])
    const h = await call('GET', '/v1/health')
    check('health no longer asks for a bootstrap', h.body?.needsBootstrap, false)
  }

  /* ------------------------------------------------ sign-in, lockout */
  console.log('\nsign-in, the email lockout and the per-IP counter')
  const A = newDevice('Vinh’s Mac')
  {
    const r = await login(A, OWNER_EMAIL, OWNER_PW)
    check('the owner signs in; with no chain yet the device is told to make one', [r.status, r.body?.state], [200, 'new-account'])
    ok('the session is an sht_ token bound to 30 days', isSessionToken(r.body?.token) && r.body?.expiresAt === clock + SESSION_TTL_MS)
    const ip = '198.51.100.7'
    const fails: number[] = []
    for (let i = 0; i < 5; i++) {
      const w = await login(newDevice('x'), OWNER_EMAIL, `wrong password ${i} ....`, { ip })
      fails.push(w.status)
      if (i === 0) check('a wrong password gets the one sentence that names no account', w.body?.message, LOGIN_REFUSED)
    }
    check('five wrong passwords are five refusals', fails, [401, 401, 401, 401, 401])
    const locked = await login(newDevice('x'), OWNER_EMAIL, OWNER_PW, { ip })
    check('then even the right password is locked out for 15 minutes', [locked.status, locked.body?.error, locked.body?.retryAfterMs], [429, 'locked', 15 * 60_000])
    ok(`and the lockout costs the hub no scrypt (${locked.ms.toFixed(0)} ms)`, locked.ms < 150)
    ok('with a Retry-After header', locked.headers.get('retry-after') === String(15 * 60))
    const otherIp = await login(newDevice('x'), OWNER_EMAIL, OWNER_PW, { ip: '198.51.100.99' })
    check('the lock is on the email, not the address', otherIp.body?.error, 'locked')
    clock += 15 * 60_000 + 1
    for (let i = 0; i < 5; i++) await login(newDevice('x'), OWNER_EMAIL, `wrong again ${i} ......`, { ip: '198.51.100.8' })
    const doubled = await login(newDevice('x'), OWNER_EMAIL, OWNER_PW, { ip: '198.51.100.8' })
    check('a second lockout doubles to 30 minutes', [doubled.status, doubled.body?.retryAfterMs], [429, 30 * 60_000])
    clock += 30 * 60_000 + 1
    const back = await login(A, OWNER_EMAIL, OWNER_PW, { ip: '198.51.100.8' })
    check('after it, the right password signs in', back.status, 200)
    const unknown = await login(newDevice('x'), 'nobody@example.com', OWNER_PW, { ip: '198.51.100.9' })
    check('an unknown email gets the same refusal as a wrong password', [unknown.status, unknown.body?.message], [401, LOGIN_REFUSED])
    ok(`and costs a scrypt all the same, so timing names no account (${unknown.ms.toFixed(0)} ms)`, unknown.ms > 100)
    const race = await Promise.all([0, 1, 2].map((i) => login(newDevice('x'), 'race@example.com', `guess number ${i} ....`, { ip: '198.51.100.10' })))
    check(
      'three guesses in flight for one email: one is checked, two are refused before scrypt (gotcha 20)',
      race.map((r) => r.status).sort(),
      [401, 429, 429]
    )
    const ipOnly = '198.51.100.20'
    const codes: string[] = []
    for (let i = 0; i < 30; i++) codes.push((await signup(`INV-${'B'.repeat(4)}-${'C'.repeat(4)}-DDDD-EEEE-FFFF-${String(1000 + i)}`, 'x@example.com', OWNER_PW, { ip: ipOnly })).body?.error)
    ok('thirty bad invites from one address are thirty refusals', codes.every((c) => c === 'invite-invalid'), codes.join(','))
    const ipLocked = await signup(bootInvite, 'x@example.com', OWNER_PW, { ip: ipOnly })
    check('the thirty-first is the address being refused', [ipLocked.status, ipLocked.body?.error], [429, 'rate-limited'])
    const ipLogin = await login(newDevice('x'), OWNER_EMAIL, OWNER_PW, { ip: ipOnly })
    check('which covers sign-in from it too (the shared IP counter)', [ipLogin.status, ipLogin.body?.error], [429, 'rate-limited'])
  }

  /* ------------------------------------------------- signed requests */
  console.log('\nevery request after sign-in is device-signed')
  {
    const bare = await call('GET', '/v1/account', undefined, { headers: { authorization: `Bearer ${A.token}` } })
    check('the bearer token alone is refused', [bare.status, bare.body?.error], [401, 'bad-signature'])
    const nonce = randomB64u(16)
    const good = await call('GET', '/v1/account', undefined, { dev: A, nonce })
    check('signed, it is served', [good.status, good.body?.role, good.body?.email, good.body?.chain], [200, 'owner', 'owner@example.com', null])
    const replay = await call('GET', '/v1/account', undefined, { dev: A, nonce })
    check('the same nonce twice is a replay', [replay.status, replay.body?.error], [401, 'replayed'])
    const skew = await call('GET', '/v1/account', undefined, { dev: A, ts: clock - 5 * 60_000 - 1 })
    check('a clock more than five minutes off is refused', [skew.status, skew.body?.error], [401, 'clock-skew'])
    const q = await call('GET', '/v1/chain?since=1', undefined, { dev: A, signPath: '/v1/chain?since=0' })
    check('the query is covered by the signature', [q.status, q.body?.error], [401, 'bad-signature'])
    const b = await call('POST', '/v1/auth/logout', { x: 1 }, { dev: A, signBody: '{"x":2}' })
    check('so is the body', [b.status, b.body?.error], [401, 'bad-signature'])
    const thief = newDevice('thief')
    const stolen = await call('GET', '/v1/account', undefined, { dev: { ...thief, id: A.id, token: A.token } })
    check('a stolen token signed by another key is refused', [stolen.status, stolen.body?.error], [401, 'bad-signature'])
    const made = await call('GET', '/v1/account', undefined, { dev: { ...A, token: `sht_${randomB64u(32)}` } })
    check('a token the hub never issued is unauthorized', [made.status, made.body?.error], [401, 'unauthorized'])
    const items = await call('GET', '/v1/items', undefined, { dev: A })
    check('a device with no chain yet may not read items', [items.status, items.body?.error], [403, 'pending'])
  }

  /* --------------------------------------------------- the chain */
  console.log('\nthe device chain: genesis, wraps, the Recovery Kit')
  const ACCOUNT = A.account
  const VK1 = newVaultKey()
  const RS = randomU8(16)
  const KIT = formatRecoverySecret(RS)
  secretsSeen.push(KIT, Buffer.from(VK1).toString('base64url'))
  const R1 = recoveryKeys(RS, ACCOUNT)
  const g0 = entry(ACCOUNT, null, { kind: 'genesis', epoch: 1, signer: A.id, device: recordOf(A), recovery: R1.signPub, vk: vaultKeyCommit(VK1, { account: ACCOUNT, epoch: 1 }) }, A.keys.signPriv)
  const B = newDevice('Windows PC', 'win32')
  {
    const noWraps = await call('POST', '/v1/chain', { entries: [g0] }, { dev: A })
    check('a genesis with no wrap for its device is refused', [noWraps.status, /not wrapped to/.test(noWraps.body?.message ?? '')], [400, true])
    const noRecovery = await call('POST', '/v1/chain', { entries: [g0], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, A)] } }, { dev: A })
    check('and one with no Recovery Kit wrap', [noRecovery.status, /Recovery Kit/.test(noRecovery.body?.message ?? '')], [400, true])
    await login(B, OWNER_EMAIL, OWNER_PW)
    const byOther = await call(
      'POST',
      '/v1/chain',
      { entries: [g0], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, A)], recovery: sealRecoveryWrap(VK1, R1.wrapKey, { account: ACCOUNT, epoch: 1 }) } },
      { dev: B }
    )
    check('another signed-in device may not post somebody else’s genesis', [byOther.status, byOther.body?.error], [403, 'forbidden'])
    const forged = { ...g0, sig: signText(B.keys.signPriv, chainSigningText(g0)) }
    const bad = await call('POST', '/v1/chain', { entries: [forged], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, A)], recovery: sealRecoveryWrap(VK1, R1.wrapKey, { account: ACCOUNT, epoch: 1 }) } }, { dev: A })
    check('a genesis the hub cannot verify is refused (the hub runs verifyChain)', [bad.status, /bad signature/.test(bad.body?.message ?? '')], [400, true])
    const genesis = await call(
      'POST',
      '/v1/chain',
      { entries: [g0], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, A)], recovery: sealRecoveryWrap(VK1, R1.wrapKey, { account: ACCOUNT, epoch: 1 }) } },
      { dev: A }
    )
    check('the genesis with both wraps lands', [genesis.status, genesis.body?.seq, genesis.body?.epoch], [200, 0, 1])
    const twice = await call('POST', '/v1/chain', { entries: [g0] }, { dev: A })
    check('appending at a taken seq is chain-conflict (rebase and retry)', [twice.status, twice.body?.error], [409, 'chain-conflict'])
    const acct = await call('GET', '/v1/account', undefined, { dev: A })
    check('the account now reports its chain head', [acct.body?.chain?.seq, acct.body?.chain?.epoch, acct.body?.chain?.head], [0, 1, genesis.body?.head])
    const chain = await call('GET', '/v1/chain', undefined, { dev: A })
    const v = verifyChain(chain.body?.entries ?? [], nodeChainCrypto, { account: ACCOUNT })
    ok('the served chain verifies on the device, to the same head', v.ok && v.head === genesis.body?.head)
    const wrap = await call('GET', '/v1/vault/wrap', undefined, { dev: A })
    const vk = wrap.status === 200 ? unwrapVaultKey(wrap.body.wrap, { account: ACCOUNT, epoch: 1, device: A.id, boxPriv: A.keys.boxPriv, commit: await commitFromChain(A, 1) }) : null
    ok('the device unwraps the vault key it uploaded', !!vk && Buffer.from(vk).equals(Buffer.from(VK1)))
  }

  /* ------------------------------ the lockout vs the owner's devices */
  console.log('\na stranger guessing the email cannot lock out the account’s own devices')
  {
    for (let i = 0; i < 5; i++) await login(newDevice('x'), OWNER_EMAIL, `a stranger's guess ${i} ....`, { ip: '203.0.113.66' })
    const stranger = await login(newDevice('x'), OWNER_EMAIL, OWNER_PW, { ip: '198.51.100.70' })
    check('five wrong guesses from anywhere lock the email, the right password included', [stranger.status, stranger.body?.error], [429, 'locked'])
    const proven = await login(A, OWNER_EMAIL, OWNER_PW, { prove: true })
    check('but an active device that signs its sign-in with the key the chain lists gets in', [proven.status, proven.body?.state], [200, 'active'])
    const provenWrong = await login(A, OWNER_EMAIL, 'not the password at all', { prove: true })
    check('and a wrong password from it is a plain refusal (401), not the email’s lock', [provenWrong.status, provenWrong.body?.message], [401, LOGIN_REFUSED])
    const nonce = randomB64u(16)
    await login(A, OWNER_EMAIL, OWNER_PW, { prove: true, nonce })
    const replayed = await login(A, OWNER_EMAIL, OWNER_PW, { prove: true, nonce })
    check('a replayed proof proves nothing: the email lock applies', [replayed.status, replayed.body?.error], [429, 'locked'])
    const posing: Dev = { ...A, keys: { ...A.keys, signPriv: generateDeviceKeys().signPriv } }
    const forged = await login(posing, OWNER_EMAIL, OWNER_PW, { prove: true })
    check('nor does one signed by another key than the chain’s for that id', [forged.status, forged.body?.error], [429, 'locked'])
    const impostor = await login({ ...newDevice('x'), id: A.id }, OWNER_EMAIL, OWNER_PW, { prove: true })
    check('nor one that signs well with its OWN key under that id: the key must be the chain’s', [impostor.status, impostor.body?.error], [429, 'locked'])
    const unlisted = await login(B, OWNER_EMAIL, OWNER_PW, { prove: true })
    check('nor one from a device the chain does not list (pending)', [unlisted.status, unlisted.body?.error], [429, 'locked'])
    for (let i = 0; i < 5; i++) await login(A, OWNER_EMAIL, `the device guessing ${i} ......`, { prove: true })
    const deviceLocked = await login(A, OWNER_EMAIL, OWNER_PW, { prove: true })
    check('five wrong passwords from the device lock ITS counter: a stolen device key cannot guess freely either', [deviceLocked.status, deviceLocked.body?.error], [429, 'locked'])
    const still = await login(newDevice('x'), OWNER_EMAIL, OWNER_PW, { ip: '198.51.100.71' })
    check('and the device getting in left the email locked for strangers', still.body?.error, 'locked')
    clock += Math.max(still.body?.retryAfterMs ?? 0, deviceLocked.body?.retryAfterMs ?? 0) + 1
    const later = await login(B, OWNER_EMAIL, OWNER_PW)
    const deviceBack = await login(A, OWNER_EMAIL, OWNER_PW, { prove: true })
    check('both unlock on their own time', [later.status, deviceBack.status], [200, 200])
  }

  /* ----------------------------------------------------- items */
  console.log('\nitems: compare-and-swap, epochs, the change feed')
  const K1 = itemKeys(VK1, ACCOUNT, 1)
  const CANARY = `sk-ant-api03-stoke-canary-${randomB64u(18)}`
  secretsSeen.push(CANARY)
  const keyPath = 't2/secret/providers.anthropicApiKey'
  let keyItemId = ''
let liveItemId = ''
  {
    const e1 = sealItem(K1, { version: 1, author: A.id, path: keyPath, editedAt: clock, deleted: false, value: CANARY })
    keyItemId = e1.id
    const p1 = await call('POST', '/v1/items', { puts: [{ baseVersion: 0, envelope: e1 }] }, { dev: A })
    check('a new item is taken at version 1', [p1.status, p1.body?.results?.[0]?.ok, p1.body?.results?.[0]?.version], [200, true, 1])
    const p1b = await call('POST', '/v1/items', { puts: [{ baseVersion: 0, envelope: e1 }] }, { dev: A })
    const c = p1b.body?.results?.[0]
    check('the same put again is a conflict carrying what the hub holds', [c?.ok, c?.error, c?.current?.envelope?.version], [false, 'conflict', 1])
    const e2 = sealItem(K1, { version: 2, author: A.id, path: keyPath, editedAt: clock + 1, deleted: false, value: CANARY })
    const p2 = await call('POST', '/v1/items', { puts: [{ baseVersion: 1, envelope: e2 }] }, { dev: A })
    check('on top of version 1 it becomes version 2', [p2.body?.results?.[0]?.ok, p2.body?.results?.[0]?.version], [true, 2])
    const replayOld = await call('POST', '/v1/items', { puts: [{ baseVersion: 2, envelope: e1 }] }, { dev: A })
    check('an old envelope replayed on top is refused (its version is inside the AAD)', replayOld.body?.results?.[0]?.error, 'invalid')
    const other = newDevice('other')
    const e3 = sealItem(K1, { version: 3, author: other.id, path: keyPath, editedAt: clock + 2, deleted: false, value: 'x' })
    const wrongAuthor = await call('POST', '/v1/items', { puts: [{ baseVersion: 2, envelope: e3 }] }, { dev: A })
    check('an envelope naming another author than the signer is refused', wrongAuthor.body?.results?.[0]?.reason, 'author is not the signing device')
    const K2x = itemKeys(newVaultKey(), ACCOUNT, 2)
    const future = await call('POST', '/v1/items', { puts: [{ baseVersion: 0, envelope: sealItem(K2x, { version: 1, author: A.id, path: 't1/settings/themeId', editedAt: clock, deleted: false, value: 'x' }) }] }, { dev: A })
    check('an envelope under another epoch is stale-epoch, naming the current one', [future.body?.results?.[0]?.error, future.body?.results?.[0]?.epoch], ['stale-epoch', 1])
    const ghost = await call('POST', '/v1/items', { puts: [{ baseVersion: 4, envelope: sealItem(K1, { version: 5, author: A.id, path: 't1/settings/fontSize', editedAt: clock, deleted: false, value: 13 }) }] }, { dev: A })
    check('a put on top of a version the hub never had is refused', ghost.body?.results?.[0]?.error, 'invalid')
    const many = ['themeId', 'fontFamily', 'fontSize'].map((k, i) => ({ baseVersion: 0, envelope: sealItem(K1, { version: 1, author: A.id, path: `t1/settings/${k}`, editedAt: clock + i, deleted: false, value: `v-${k}` }) }))
    const pm = await call('POST', '/v1/items', { puts: many }, { dev: A })
    check('three puts in one request, each decided on its own', pm.body?.results?.map((r: any) => r.ok), [true, true, true])
    const page1 = await call('GET', '/v1/items?since=0&limit=2', undefined, { dev: A })
    check('the feed pages: two items, more to come', [page1.body?.items?.length, page1.body?.more, page1.body?.epoch], [2, true, 1])
    const page2 = await call('GET', `/v1/items?since=${page1.body?.next}&limit=2`, undefined, { dev: A })
    check('the next page picks up from `next`', [page2.body?.items?.length, page2.body?.more], [2, false])
    const all = [...(page1.body?.items ?? []), ...(page2.body?.items ?? [])]
    check('an item appears once, at its latest version', all.filter((s: any) => s.envelope.id === keyItemId).map((s: any) => s.envelope.version), [2])
    const back = all.find((s: any) => s.envelope.id === keyItemId)
    const opened = back ? openItem(K1, back.envelope) : null
    ok('what comes back opens on the device to the value it sealed', opened?.ok === true && opened.item.value === CANARY)
    const tooMany = await call('POST', '/v1/items', { puts: Array.from({ length: HUB_LIMITS.putsPerRequest + 1 }, () => many[0]) }, { dev: A })
    check(`more than ${HUB_LIMITS.putsPerRequest} puts in a request is too-large`, [tooMany.status, tooMany.body?.error], [413, 'too-large'])
  }

  /* ------------------------------------------------ presence, pairing */
  console.log('\na second device: presence, pairing by the six digits')
  const presA = await mustOpen('/v1/ws/presence', A, 'the owner’s device opens presence')
  const welcome = await presA.frame((f) => f.t === 'welcome')
  check('presence says welcome with who is online', [welcome?.device, welcome?.online], [A.id, [A.id]])
  let pairId = ''
  {
    const pendingSocket = await openSocket('/v1/ws/presence', B)
    check('a pending device may not open presence', 'status' in pendingSocket ? [pendingSocket.status, pendingSocket.body?.error] : 'opened', [403, 'pending'])
    const bItems = await call('GET', '/v1/items', undefined, { dev: B })
    check('a pending device may not read items', bItems.body?.error, 'pending')
    const bChain = await call('GET', '/v1/chain', undefined, { dev: B })
    check('but may read the chain, to pin it', [bChain.status, bChain.body?.entries?.length], [200, 1])
    const nN = randomB64u(32)
    const recB = recordOf(B)
    const commit = pairCommit({ account: ACCOUNT, device: recB, nonce: nN })
    const created = await call('POST', '/v1/pair', { commit, device: { id: B.id, label: B.name, platform: B.platform } }, { dev: B })
    check('the new device asks to join with a commitment', [created.status, typeof created.body?.pair], [200, 'string'])
    pairId = created.body?.pair
    const pushed = await presA.frame((f) => f.t === 'pair' && f.pair === pairId && f.state === 'waiting')
    ok('the owner’s device is told at once over presence', !!pushed)
    const list = await call('GET', '/v1/pair', undefined, { dev: A })
    check('and lists it, with no keys before the reveal', [list.body?.pairs?.length, list.body?.pairs?.[0]?.state, list.body?.pairs?.[0]?.reveal], [1, 'waiting', undefined])
    const bList = await call('GET', '/v1/pair', undefined, { dev: B })
    check('a pending device may not list the account’s requests', bList.body?.error, 'pending')
    const nE = randomB64u(32)
    const nonced = await call('POST', `/v1/pair/${pairId}/nonce`, { nonce: nE }, { dev: A })
    check('the approver answers with its nonce', [nonced.body?.state, nonced.body?.approver?.id], ['nonce', A.id])
    const early = await call('POST', `/v1/pair/${pairId}/nonce`, { nonce: nE }, { dev: A })
    check('a second nonce is out of order', [early.status, early.body?.error], [409, 'conflict'])
    const seen = await call('GET', `/v1/pair/${pairId}`, undefined, { dev: B })
    check('the new device sees the approver’s nonce and keys', [seen.body?.nonceE, seen.body?.approver?.sign], [nE, A.keys.signPub])
    {
      // Gotcha 140's squatter, at pairing: the password, signed in under B's id before B has joined.
      const squatB: Dev = { ...newDevice('squatter'), id: B.id }
      check('a password holder may sign in under the joining device’s id (not listed yet: pending)', (await login(squatB, OWNER_EMAIL, OWNER_PW)).body?.state, 'pending')
      const peekB = await call('GET', `/v1/pair/${pairId}`, undefined, { dev: squatB })
      check('but B’s pair does not exist for it: a pair is its id AND the key that opened it', [peekB.status, peekB.body?.error], [404, 'not-found'])
      const revealB = await call('POST', `/v1/pair/${pairId}/reveal`, { device: recordOf(squatB), nonce: randomB64u(32) }, { dev: squatB })
      const refuseB = await call('POST', `/v1/pair/${pairId}/refuse`, {}, { dev: squatB })
      check('so it can neither reveal into B’s pair (which would refuse it) nor refuse it', [revealB.status, refuseB.status], [404, 404])
      const own = await call('POST', '/v1/pair', { commit: randomB64u(32), device: { id: B.id, label: 'squatter', platform: 'darwin' } }, { dev: squatB })
      const stillB = await call('GET', `/v1/pair/${pairId}`, undefined, { dev: B })
      check('and opening one of its own under that id does not expire B’s', [own.status, stillB.status, stillB.body?.state], [200, 200, 'nonce'])
      await call('POST', `/v1/pair/${own.body?.pair}/refuse`, {}, { dev: A })
    }
    const revealed = await call('POST', `/v1/pair/${pairId}/reveal`, { device: recB, nonce: nN }, { dev: B })
    check('the reveal matches the commitment', [revealed.status, revealed.body?.state], [200, 'revealed'])
    const onA = await call('GET', `/v1/pair/${pairId}`, undefined, { dev: A })
    ok('the approver re-derives the commitment from the reveal', pairCommit({ account: ACCOUNT, device: onA.body?.reveal?.device, nonce: onA.body?.reveal?.nonce }) === onA.body?.commit)
    const codeA = pairCode({ account: ACCOUNT, pair: pairId, device: onA.body.reveal.device, approver: recordOf(A), nonceN: onA.body.reveal.nonce, nonceE: nE })
    const codeB = pairCode({ account: ACCOUNT, pair: pairId, device: recB, approver: seen.body.approver, nonceN: nN, nonceE: seen.body.nonceE })
    ok(`both screens show the same six digits (${codeA})`, codeA === codeB && /^\d{3} \d{3}$/.test(codeA))
    const add = entry(ACCOUNT, g0, { kind: 'add', epoch: 1, signer: A.id, device: onA.body.reveal.device }, A.keys.signPriv)
    // Wraps are written once: an append may not replace another device's, or the Kit's.
    const junk = newVaultKey()
    const overA = await call('POST', '/v1/chain', { entries: [add], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, B), wrapFor(junk, ACCOUNT, 1, A)] } }, { dev: A })
    check('an add carrying a second, different wrap for a device that has one is refused', [overA.status, overA.body?.error, /never replaces/.test(overA.body?.message ?? '')], [409, 'conflict', true])
    const overKit = await call(
      'POST',
      '/v1/chain',
      { entries: [add], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, B)], recovery: sealRecoveryWrap(junk, R1.wrapKey, { account: ACCOUNT, epoch: 1 }) } },
      { dev: A }
    )
    check('and so is an add carrying a recovery wrap over the Kit’s', [overKit.status, overKit.body?.error], [409, 'conflict'])
    const aWrap = await call('GET', '/v1/vault/wrap', undefined, { dev: A })
    const aStill = unwrapVaultKey(aWrap.body?.wrap, { account: ACCOUNT, epoch: 1, device: A.id, boxPriv: A.keys.boxPriv, commit: await commitFromChain(A, 1) })
    const kitWrap = await call('GET', '/v1/vault/recovery', undefined, { dev: A })
    const kitStill = openRecoveryWrap(kitWrap.body?.wrap, R1.wrapKey, { account: ACCOUNT, epoch: 1, commit: await commitFromChain(A, 1) })
    ok(
      'after both, the device’s wrap and the Kit’s still open the real key, and the chain did not move',
      !!aStill && Buffer.from(aStill).equals(Buffer.from(VK1)) && !!kitStill && Buffer.from(kitStill).equals(Buffer.from(VK1)) && (await call('GET', '/v1/account', undefined, { dev: A })).body?.chain?.seq === 0
    )
    const approved = await call('POST', '/v1/chain', { entries: [add], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, B), { device: A.id, wrap: aWrap.body?.wrap }] } }, { dev: A })
    check('the approver appends the add with the wrap for the new device (repeating its own, byte for byte, is harmless)', [approved.status, approved.body?.seq], [200, 1])
    const after = await call('GET', `/v1/pair/${pairId}`, undefined, { dev: B })
    check('and the pair reads approved', after.body?.state, 'approved')
    ok('presence carried the new chain head', !!(await presA.frame((f) => f.t === 'chain' && f.seq === 1)))
    const relogin = await login(B, OWNER_EMAIL, OWNER_PW)
    check('the new device is active from its next sign-in', relogin.body?.state, 'active')
    const wrapB = await call('GET', '/v1/vault/wrap', undefined, { dev: B })
    const vkB = unwrapVaultKey(wrapB.body?.wrap, { account: ACCOUNT, epoch: 1, device: B.id, boxPriv: B.keys.boxPriv, commit: await commitFromChain(B, 1) })
    ok('it unwraps the same vault key', !!vkB && Buffer.from(vkB).equals(Buffer.from(VK1)))
    const feed = await call('GET', '/v1/items?since=0', undefined, { dev: B })
    const mine = feed.body?.items?.find((s: any) => s.envelope.id === keyItemId)
    const openedB = mine && vkB ? openItem(itemKeys(vkB, ACCOUNT, 1), mine.envelope) : null
    ok('and reads the key the first device synced', openedB?.ok === true && openedB.item.value === CANARY)
    const bPut = await call('POST', '/v1/items', { puts: [{ baseVersion: 0, envelope: sealItem(K1, { version: 1, author: B.id, path: 't1/settings/zoomTarget', editedAt: clock, deleted: false, value: 'terminal' }) }] }, { dev: B })
    check('the new device writes', bPut.body?.results?.[0]?.ok, true)
    ok('and the first hears about it over presence', !!(await presA.frame((f) => f.t === 'items' && f.seq === bPut.body?.results?.[0]?.seq)))
  }
  {
    const X = newDevice('Unknown laptop', 'linux')
    await login(X, OWNER_EMAIL, OWNER_PW)
    const nN = randomB64u(32)
    const p = await call('POST', '/v1/pair', { commit: pairCommit({ account: ACCOUNT, device: recordOf(X), nonce: nN }), device: { id: X.id, label: X.name, platform: X.platform } }, { dev: X })
    await call('POST', `/v1/pair/${p.body?.pair}/nonce`, { nonce: randomB64u(32) }, { dev: A })
    const swapped = { ...recordOf(X), box: generateDeviceKeys().boxPub }
    const sub = await call('POST', `/v1/pair/${p.body?.pair}/reveal`, { device: swapped, nonce: nN }, { dev: X })
    check('a reveal whose keys differ from the commitment is refused', [sub.status, /commitment/.test(sub.body?.message ?? '')], [400, true])
    const state = await call('GET', `/v1/pair/${p.body?.pair}`, undefined, { dev: A })
    check('and the pair is over', state.body?.state, 'refused')
    const peek = await call('GET', `/v1/pair/${pairId}`, undefined, { dev: X })
    check('a pending device cannot read another device’s pair', peek.status, 404)
    for (let i = 0; i < 2; i++) {
      const q = await call('POST', '/v1/pair', { commit: randomB64u(32), device: { id: X.id, label: X.name, platform: X.platform } }, { dev: X })
      await call('POST', `/v1/pair/${q.body?.pair}/refuse`, {}, { dev: A })
    }
    const fourth = await call('POST', '/v1/pair', { commit: randomB64u(32), device: { id: X.id, label: X.name, platform: X.platform } }, { dev: X })
    check('three refused attempts in an hour and a fourth is refused', [fourth.status, fourth.body?.error], [429, 'rate-limited'])
    const X2: Dev = { ...newDevice('Unknown laptop, other key', 'linux'), id: X.id }
    await login(X2, OWNER_EMAIL, OWNER_PW)
    const otherKey = await call('POST', '/v1/pair', { commit: randomB64u(32), device: { id: X2.id, label: X2.name, platform: X2.platform } }, { dev: X2 })
    check('refusals count per id AND key: a squatter’s three do not lock the real device out of the id', otherKey.status, 200)
    await call('POST', `/v1/pair/${otherKey.body?.pair}/refuse`, {}, { dev: A })
    const Y = newDevice('Y')
    await login(Y, OWNER_EMAIL, OWNER_PW)
    const q = await call('POST', '/v1/pair', { commit: randomB64u(32), device: { id: Y.id, label: Y.name, platform: Y.platform } }, { dev: Y })
    clock += 10 * 60_000
    const expired = await call('GET', `/v1/pair/${q.body?.pair}`, undefined, { dev: Y })
    check('a request nobody answered in ten minutes has expired', expired.body?.state, 'expired')
    const late = await call('POST', `/v1/pair/${q.body?.pair}/nonce`, { nonce: randomB64u(32) }, { dev: A })
    check('and cannot be answered', late.status, 409)
    const imposter = newDevice('imposter')
    const clash = await login({ ...imposter, id: A.id }, OWNER_EMAIL, OWNER_PW)
    check('signing in with an active device’s id but other keys is refused', [clash.status, clash.body?.error], [403, 'forbidden'])
  }

  /* --------------------------------------------- the Recovery Kit */
  console.log('\njoining with the Recovery Kit, then rotating')
  const C = newDevice('Linux box', 'linux')
  const RS2 = randomU8(16)
  const R2 = recoveryKeys(RS2, ACCOUNT)
  const VK2 = newVaultKey()
  let chainNow: ChainEntry[] = []
  {
    await login(C, OWNER_EMAIL, OWNER_PW)
    // Someone with the password signs in FIRST under the id the real device is about to join with.
    const squatter: Dev = { ...newDevice('squatter'), id: C.id }
    const sq = await login(squatter, OWNER_EMAIL, OWNER_PW)
    check('a stranger with the password may sign in under a not-yet-listed id (pending)', sq.body?.state, 'pending')
    const rw = await call('GET', '/v1/vault/recovery', undefined, { dev: C })
    check('a pending device may fetch the recovery wrap (useless without the Kit)', rw.status, 200)
    const typed = parseRecoverySecret(KIT.toLowerCase().replace(/-/g, ' '))
    const vk = typed.ok ? openRecoveryWrap(rw.body?.wrap, recoveryKeys(typed.secret, ACCOUNT).wrapKey, { account: ACCOUNT, epoch: 1, commit: await commitFromChain(C, 1) }) : null
    ok('the Kit, typed back in lower case, opens it', !!vk && Buffer.from(vk).equals(Buffer.from(VK1)))
    chainNow = (await call('GET', '/v1/chain', undefined, { dev: C })).body?.entries ?? []
    const addC = entry(ACCOUNT, chainNow[chainNow.length - 1], { kind: 'add', epoch: 1, signer: 'recovery', device: recordOf(C) }, R1.signPriv)
    const joined = await call('POST', '/v1/chain', { entries: [addC], wraps: { epoch: 1, devices: [wrapFor(VK1, ACCOUNT, 1, C)] } }, { dev: C })
    check('it adds itself, signed as the recovery key', [joined.status, joined.body?.seq], [200, 2])
    chainNow.push(addC)
    const sqItems = await call('GET', '/v1/items', undefined, { dev: squatter })
    check('the squatter’s session stays pending: active means the listed id AND the key it signed in with', [sqItems.status, sqItems.body?.error], [403, 'pending'])
    const sqAgain = await login(squatter, OWNER_EMAIL, OWNER_PW)
    check('and it cannot sign in under that id again', [sqAgain.status, sqAgain.body?.error], [403, 'forbidden'])
    {
      // As after a restore (spec §7.3): entries an honest device signed that the
      // hub does not hold, in the hands of a session that is only the password.
      const E = newDevice('never joins')
      const signedByA = entry(ACCOUNT, addC, { kind: 'add', epoch: 1, signer: A.id, device: recordOf(E) }, A.keys.signPriv)
      const withWraps = await call(
        'POST',
        '/v1/chain',
        { entries: [signedByA], wraps: { epoch: 1, devices: [wrapFor(newVaultKey(), ACCOUNT, 1, E)], recovery: sealRecoveryWrap(newVaultKey(), randomU8(32), { account: ACCOUNT, epoch: 1 }) } },
        { dev: squatter }
      )
      check('a pending session republishing entries may not attach wraps (not a member before or after them)', [withWraps.status, withWraps.body?.error], [403, 'forbidden'])
      const bare = await call('POST', '/v1/chain', { entries: [signedByA] }, { dev: squatter })
      check('bare, an entry whose wraps the hub lacks does not land either', [bare.status, /not wrapped to/.test(bare.body?.message ?? '')], [400, true])
      // An entry needing no new wrap — a device with no vault cap (a phone, later) — may be republished bare by anyone.
      const P = newDevice('Phone', 'ios')
      const phoneAdd = entry(ACCOUNT, addC, { kind: 'add', epoch: 1, signer: A.id, device: { ...recordOf(P), caps: ['remote-guest'] } }, A.keys.signPriv)
      const republished = await call('POST', '/v1/chain', { entries: [phoneAdd] }, { dev: squatter })
      check('while a bare republish whose wraps are all there lands', [republished.status, republished.body?.seq], [200, 3])
      chainNow.push(phoneAdd)
    }
    const rot = entry(ACCOUNT, chainNow[chainNow.length - 1], { kind: 'rotate', epoch: 2, signer: C.id, recovery: R2.signPub, vk: vaultKeyCommit(VK2, { account: ACCOUNT, epoch: 2 }) }, C.keys.signPriv)
    const partial = await call('POST', '/v1/chain', { entries: [rot], wraps: { epoch: 2, devices: [wrapFor(VK2, ACCOUNT, 2, C)], recovery: sealRecoveryWrap(VK2, R2.wrapKey, { account: ACCOUNT, epoch: 2 }) } }, { dev: C })
    check('a rotate that leaves active devices without the new key is refused', [partial.status, new RegExp(`${A.id}.*${B.id}|${B.id}.*${A.id}`).test(partial.body?.message ?? '')], [400, true])
    const full = await call(
      'POST',
      '/v1/chain',
      { entries: [rot], wraps: { epoch: 2, devices: [A, B, C].map((d) => wrapFor(VK2, ACCOUNT, 2, d)), recovery: sealRecoveryWrap(VK2, R2.wrapKey, { account: ACCOUNT, epoch: 2 }) } },
      { dev: C }
    )
    check('with every device’s wrap and the new Kit’s, it lands at epoch 2', [full.status, full.body?.epoch], [200, 2])
    chainNow.push(rot)
    const stale = await call('POST', '/v1/items', { puts: [{ baseVersion: 0, envelope: sealItem(K1, { version: 1, author: A.id, path: 't1/settings/terminal', editedAt: clock, deleted: false, value: {} }) }] }, { dev: A })
    check('a put under the old epoch is now stale-epoch', [stale.body?.results?.[0]?.error, stale.body?.results?.[0]?.epoch], ['stale-epoch', 2])
    const w2 = await call('GET', '/v1/vault/wrap', undefined, { dev: A })
    const vk2 = unwrapVaultKey(w2.body?.wrap, { account: ACCOUNT, epoch: 2, device: A.id, boxPriv: A.keys.boxPriv, commit: await commitFromChain(A, 2) })
    ok('the first device fetches its epoch-2 wrap', !!vk2 && Buffer.from(vk2).equals(Buffer.from(VK2)))
    {
      // A compromised NUC — or anything that can answer GET /v1/vault/wrap —
      // boxes a key IT knows to A's PUBLIC key. Written straight into the
      // database, as the hub process itself could.
      const planted = newVaultKey()
      const db = new DatabaseSync(join(TMP, 'hub', 'hub.db'), { timeout: 5000 })
      const where = 'WHERE account_id = ? AND epoch = 2 AND device_id = ?'
      const original = (db.prepare(`SELECT wrap_json FROM wraps ${where}`).get(ACCOUNT, A.id) as { wrap_json: string }).wrap_json
      db.prepare(`UPDATE wraps SET wrap_json = ? ${where}`).run(JSON.stringify(wrapVaultKey(planted, { account: ACCOUNT, epoch: 2, device: A.id, boxPub: A.keys.boxPub })), ACCOUNT, A.id)
      const served = await call('GET', '/v1/vault/wrap', undefined, { dev: A })
      const commit2 = await commitFromChain(A, 2)
      check('a wrap the hub planted (its own key, boxed to the device’s public key) is refused', unwrapVaultKey(served.body?.wrap, { account: ACCOUNT, epoch: 2, device: A.id, boxPriv: A.keys.boxPriv, commit: commit2 }), null)
      const wouldHave = unwrapVaultKey(served.body?.wrap, { account: ACCOUNT, epoch: 2, device: A.id, boxPriv: A.keys.boxPriv, commit: vaultKeyCommit(planted, { account: ACCOUNT, epoch: 2 }) })
      ok('it opens fine as a box: only the signed commitment in the chain tells it apart', !!wouldHave && Buffer.from(wouldHave).equals(Buffer.from(planted)))
      db.prepare(`UPDATE wraps SET wrap_json = ? ${where}`).run(original, ACCOUNT, A.id)
      db.close()
    }
    const K2 = itemKeys(VK2, ACCOUNT, 2)
    const resealed = await call('POST', '/v1/items', { puts: [{ baseVersion: 0, envelope: sealItem(K2, { version: 1, author: A.id, path: keyPath, editedAt: clock, deleted: false, value: CANARY }) }] }, { dev: A })
    check('re-seals under epoch 2 (a new opaque id)', [resealed.body?.results?.[0]?.ok, resealed.body?.results?.[0]?.id !== keyItemId], [true, true])
    liveItemId = resealed.body?.results?.[0]?.id ?? ''
    const tooFar = await call('POST', '/v1/items/prune', { epochBelow: 3 }, { dev: A })
    check('pruning the current epoch is refused', tooFar.status, 400)
    const pruned = await call('POST', '/v1/items/prune', { epochBelow: 2 }, { dev: A })
    check('and prunes the epoch-1 envelopes', [pruned.status, pruned.body?.pruned], [200, 5])
    const left = await call('GET', '/v1/items?since=0', undefined, { dev: A })
    check('only epoch-2 items remain', [...new Set((left.body?.items ?? []).map((s: any) => s.envelope.epoch))], [2])
  }

  /* ------------------------------------------- a second account */
  console.log('\na second account, and invites from the owner')
  const D = newDevice('Friend’s Mac')
  const MEMBER_PW = `member password ${randomB64u(6)} xx`
  secretsSeen.push(MEMBER_PW)
  {
    const inv = await call('POST', '/v1/auth/invites', {}, { dev: A })
    check('the owner mints an invite for 7 days', [inv.status, inv.body?.expiresAt - clock], [200, 7 * 24 * 60 * 60_000])
    secretsSeen.push(inv.body?.invite)
    const race = await Promise.all([signup(inv.body?.invite, 'member@example.com', MEMBER_PW), signup(inv.body?.invite, 'member2@example.com', MEMBER_PW)])
    check('two sign-ups racing on one invite: exactly one gets it', race.map((r) => r.status).sort(), [200, 400])
    const mEmail = race[0].status === 200 ? 'member@example.com' : 'member2@example.com'
    check('as a member', race.find((r) => r.status === 200)?.body?.role, 'member')
    const dl = await login(D, mEmail, MEMBER_PW)
    check('the member signs in to an empty account', dl.body?.state, 'new-account')
    const vkD = newVaultKey()
    const rD = recoveryKeys(randomU8(16), D.account)
    const gD = entry(D.account, null, { kind: 'genesis', epoch: 1, signer: D.id, device: recordOf(D), recovery: rD.signPub, vk: vaultKeyCommit(vkD, { account: D.account, epoch: 1 }) }, D.keys.signPriv)
    const gd = await call('POST', '/v1/chain', { entries: [gD], wraps: { epoch: 1, devices: [wrapFor(vkD, D.account, 1, D)], recovery: sealRecoveryWrap(vkD, rD.wrapKey, { account: D.account, epoch: 1 }) } }, { dev: D })
    check('and starts its own chain', gd.status, 200)
    const dItems = await call('GET', '/v1/items?since=0', undefined, { dev: D })
    check('it sees none of the first account’s items', dItems.body?.items?.length, 0)
    const dChain = await call('GET', '/v1/chain', undefined, { dev: D })
    check('nor its chain', dChain.body?.entries?.length, 1)
    const cross = entry(ACCOUNT, chainNow[chainNow.length - 1], { kind: 'add', epoch: 2, signer: D.id, device: recordOf(newDevice('z')) }, D.keys.signPriv)
    const crossed = await call('POST', '/v1/chain', { entries: [cross] }, { dev: D })
    check('an entry for the other account is refused', crossed.status === 409 || crossed.status === 400, true)
    const dInvite = await call('POST', '/v1/auth/invites', {}, { dev: D })
    check('a member may not mint invites', [dInvite.status, dInvite.body?.error], [403, 'forbidden'])
    const cItem = await call('POST', '/v1/items', { puts: [{ baseVersion: 0, envelope: sealItem(itemKeys(vkD, D.account, 1), { version: 1, author: D.id, path: 't1/settings/themeId', editedAt: clock, deleted: false, value: 'd' }) }] }, { dev: D })
    check('its own items are its own', cItem.body?.results?.[0]?.ok, true)
  }

  /* ------------------------------------------------------ relay */
  console.log('\nthe relay: two sockets, frames forwarded as they are')
  {
    const presC = await mustOpen('/v1/ws/presence', C, 'the guest opens presence')
    ok('the host hears the guest come online', !!(await presA.frame((f) => f.t === 'presence' && f.online.includes(C.id))))
    const offline = await call('POST', '/v1/relays', { host: B.id }, { dev: C })
    check('a relay to a device that is not online is refused', [offline.status, offline.body?.error], [409, 'offline'])
    const self = await call('POST', '/v1/relays', { host: C.id }, { dev: C })
    check('and to itself', self.status, 400)
    const made = await call('POST', '/v1/relays', { host: A.id }, { dev: C })
    check('the guest asks for a relay to the host', [made.status, made.body?.expiresAt - clock], [200, RELAY_OPEN_TTL_MS])
    const relay = made.body?.relay as string
    const told = await presA.frame((f) => f.t === 'relay' && f.relay === relay)
    check('the host is told who wants it', told?.guest, C.id)
    const g = await mustOpen(`/v1/ws/relay/${relay}`, C, 'the guest opens its end')
    const ephG = relayEphemeral()
    const hs1 = relayHello({ relay, account: ACCOUNT, guest: C.id, host: A.id }, ephG)
    const hs1Text = JSON.stringify(hs1)
    await sendOn(g, hs1Text, false)
    const h = await mustOpen(`/v1/ws/relay/${relay}`, A, 'the host opens its end')
    const got1 = await h.until(() => h.frames[0])
    check('the frame sent before the host joined arrives, as the same text frame', [got1?.binary, got1?.data.toString('utf8') === hs1Text], [false, true])
    const hs1In = JSON.parse(got1?.data.toString('utf8') ?? '{}') as RelayHs1
    check('the host checks hs1', hs1Problem(hs1In, { relay, account: ACCOUNT, host: A.id }), null)
    const ephH = relayEphemeral()
    const { hs2, th } = relayAnswer(hs1In, ephH, A.keys.signPriv)
    await sendOn(h, JSON.stringify(hs2), false)
    const got2 = await g.until(() => g.frames[0])
    check('with both ends joined, a text frame crosses live as the same text frame', [got2?.binary, got2?.data.toString('utf8') === JSON.stringify(hs2)], [false, true])
    const hs2In = JSON.parse(got2?.data.toString('utf8') ?? '{}') as RelayHs2
    const fin = relayFinish(hs1, hs2In, A.keys.signPub, C.keys.signPriv)
    ok('the guest verifies the host against the key IT pinned from the chain', fin.ok)
    await sendOn(g, JSON.stringify((fin as { hs3: RelayHs3 }).hs3), false)
    const got3 = await h.until(() => h.frames[1])
    ok('the host verifies the guest the same way', relayAccept(th, hs2, JSON.parse(got3?.data.toString('utf8') ?? '{}'), C.keys.signPub))
    const kG = relayKeys(ephG, hs2In.eph, (fin as { th: string }).th)
    const kH = relayKeys(ephH, hs1In.eph, th)
    const gOut = new RelayCipher(kG!.g2h, 'g2h', relay)
    const hIn = new RelayCipher(kH!.g2h, 'g2h', relay)
    const hOut = new RelayCipher(kH!.h2g, 'h2g', relay)
    const gIn = new RelayCipher(kG!.h2g, 'h2g', relay)
    const req = gOut.seal(JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/api/sessions' }))
    await sendOn(g, Buffer.from(req), true)
    const got4 = await h.until(() => h.frames[2])
    check('a sealed frame crosses as binary, byte for byte', [got4?.binary, got4 ? Buffer.compare(got4.data, Buffer.from(req)) : -9], [true, 0])
    const plain = got4 ? hIn.open(new Uint8Array(got4.data)) : null
    check('and opens on the host', plain ? JSON.parse(Buffer.from(plain).toString('utf8')).path : null, '/api/sessions')
    const res = hOut.seal(JSON.stringify({ t: 'res', id: 1, status: 200, body: [] }))
    await sendOn(h, Buffer.from(res), true)
    const got5 = await g.until(() => g.frames[1])
    const back = got5 ? gIn.open(new Uint8Array(got5.data)) : null
    check('the answer crosses back and opens on the guest', back ? JSON.parse(Buffer.from(back).toString('utf8')).status : null, 200)
    const big = randomU8(RELAY_MAX_FRAME_BYTES)
    await sendOn(g, Buffer.from(big), true)
    const got6 = await h.until(() => h.frames[3], 5000)
    ok('a frame of exactly 1 MiB crosses intact', !!got6 && got6.data.length === big.length && sha256B64u(new Uint8Array(got6.data)) === sha256B64u(big))
    const third = await openSocket(`/v1/ws/relay/${relay}`, D)
    check('a device of ANOTHER account cannot join (the relay does not exist for it)', 'status' in third ? third.status : 'opened', 404)
    const bystander = await openSocket(`/v1/ws/relay/${relay}`, B)
    check('a device of this account that is neither end cannot join', 'status' in bystander ? [bystander.status, bystander.body?.error] : 'opened', [403, 'forbidden'])
    const dup = await openSocket(`/v1/ws/relay/${relay}`, C)
    check('a second socket for a taken end is refused', 'status' in dup ? dup.status : 'opened', 409)
    const over = randomU8(RELAY_MAX_FRAME_BYTES + 1)
    g.ws.send(Buffer.from(over), { binary: true })
    await g.until(() => g.closed, 5000)
    await h.until(() => h.closed, 5000)
    check('a frame over 1 MiB closes the relay: the sender with 1009, the other end too', [g.closed?.code, h.closed !== null], [1009, true])
    ok('and nothing of it reached the host', h.frames.length === 4)

    const r2 = (await call('POST', '/v1/relays', { host: A.id }, { dev: C })).body?.relay as string
    const g2 = await mustOpen(`/v1/ws/relay/${r2}`, C, 'guest end')
    const h2 = await mustOpen(`/v1/ws/relay/${r2}`, A, 'host end')
    clock += RELAY_IDLE_MS
    hub.tick()
    await g2.until(() => g2.closed)
    await h2.until(() => h2.closed)
    check('a relay idle for ten minutes is closed at both ends', [g2.closed?.reason, h2.closed?.reason], ['idle', 'idle'])
    const r3 = (await call('POST', '/v1/relays', { host: A.id }, { dev: C })).body?.relay as string
    const g3 = await mustOpen(`/v1/ws/relay/${r3}`, C, 'guest end')
    clock += RELAY_OPEN_TTL_MS
    hub.tick()
    await g3.until(() => g3.closed)
    check('a relay the host never joined closes after a minute', g3.closed?.reason, 'the other end never joined')
    const late = await openSocket(`/v1/ws/relay/${r3}`, A)
    check('and cannot be joined after', 'status' in late ? late.status : 'opened', 404)
    const open: string[] = []
    for (let i = 0; i < RELAYS_PER_ACCOUNT; i++) open.push((await call('POST', '/v1/relays', { host: A.id }, { dev: C })).body?.relay)
    const ninth = await call('POST', '/v1/relays', { host: A.id }, { dev: C })
    check(`at most ${RELAYS_PER_ACCOUNT} relays per account`, [open.every(Boolean), ninth.status, ninth.body?.error], [true, 429, 'rate-limited'])
    clock += RELAY_OPEN_TTL_MS
    hub.tick()

    /*
     * "Other machines" (spec §6.1): each device's sealed status, forwarded to
     * the account's other devices as it is, held in memory for a device that
     * comes online later, and never written or logged. The hub cannot open it;
     * what it must not do is keep it, echo it, relabel it, or hand it to
     * another account.
     */
    const statusPlain = JSON.stringify({ v: 1, at: clock, name: 'Linux box', platform: 'linux', open: true, sessions: [{ ptyId: 'pty-9', project: `status-canary-${randomB64u(9)}`, title: null, status: 'idle', agent: 'Claude Code', context: null, lastActivityAt: null }] })
    const pk = presenceKey(VK2, ACCOUNT, 2)
    const sealedC = sealStatus(pk, { account: ACCOUNT, epoch: 2, device: C.id }, statusPlain)
    secretsSeen.push(sealedC.ct, JSON.parse(statusPlain).sessions[0].project)
    await sendOn(presC, JSON.stringify({ t: 'status', status: sealedC }), false)
    const fwd = await presA.frame((f) => f.t === 'status' && f.device === C.id)
    check('a device’s sealed status reaches the account’s other devices exactly as sent', fwd?.status, sealedC)
    check('and it opens there, for a device of the vault', openStatus(pk, { account: ACCOUNT, epoch: 2, device: C.id }, fwd?.status)?.includes('Linux box'), true)
    ok('it is not echoed to the device that sent it', !(await presC.frame((f) => f.t === 'status', 300)))
    await sendOn(presC, JSON.stringify({ t: 'status', status: { v: 1, epoch: 2, nonce: 'x', ct: 'y', device: A.id } }), false)
    await new Promise((r) => setTimeout(r, 300))
    check('a malformed status is dropped, not forwarded', presA.json().filter((f) => f?.t === 'status').length, 1)
    const presD = await mustOpen('/v1/ws/presence', D, 'another account’s device opens presence')
    const presB = await mustOpen('/v1/ws/presence', B, 'a device of this account comes online later')
    const handed = await presB.frame((f) => f.t === 'status' && f.device === C.id)
    check('a device that comes online later is handed the status the hub holds', handed?.status, sealedC)
    ok('another account’s device never sees it', !(await presD.frame((f) => f.t === 'status', 300)))
    await sendOn(presC, JSON.stringify({ t: 'status', status: null }), false)
    check('a withdrawn status is forwarded as null', (await presA.frame((f) => f.t === 'status' && f.status === null))?.device, C.id)
    presB.ws.close()
    presD.ws.close()
    await presB.until(() => presB.closed)
    await presD.until(() => presD.closed)

    const big2 = Buffer.alloc(HUB_LIMITS.presenceFrameBytes + 1, 0x20)
    presC.ws.send(big2)
    await presC.until(() => presC.closed)
    check('a presence frame over 64 KiB closes that socket (1009)', presC.closed?.code, 1009)
  }

  /* ------------------------------------------- the relay under load */
  console.log('\nthe relay under load: flow control, and liveness a silent end cannot fake')
  {
    const r4 = (await call('POST', '/v1/relays', { host: A.id }, { dev: C })).body?.relay as string
    const g4 = await mustOpen(`/v1/ws/relay/${r4}`, C, 'guest end')
    const h4 = await mustOpen(`/v1/ws/relay/${r4}`, A, 'host end')
    h4.ws.pause() // the host stops reading its side at all
    const FRAMES = 64
    const sent: string[] = []
    for (let i = 0; i < FRAMES; i++) {
      const f = randomU8(RELAY_MAX_FRAME_BYTES)
      sent.push(sha256B64u(f))
      g4.ws.send(Buffer.from(f), { binary: true })
    }
    // Let the hub take what it will: wait until the guest's own queue stops shrinking.
    // That queue is coarse — Node hands a socket's whole backlog to libuv as ONE
    // writev and counts all of it until the writev completes — so it says only
    // whether the guest's write finished: with no flow control the hub reads it
    // all and it drops to 0. The hub's own peak (below) is the exact figure.
    let settled = -1
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (g4.ws.bufferedAmount === settled) break
      settled = g4.ws.bufferedAmount
    }
    const mib = (n: number): string => `${(n / 2 ** 20).toFixed(1)} MiB`
    ok('with the host not reading, the hub stops reading the guest', logLines.some((l) => l.includes('"msg":"relay held"') && l.includes(r4)))
    ok(`so the guest's write stalls on its own side (${mib(settled)} of ${FRAMES} MiB still pending there) instead of piling up in the hub`, settled > (FRAMES / 2) * 2 ** 20, mib(settled))
    check('and the relay is still open: held, not dropped', [g4.closed, h4.closed], [null, null])
    h4.ws.resume()
    await h4.until(() => h4.frames.length >= FRAMES, 30_000)
    check(`once the host reads again, all ${FRAMES} frames arrive, in order and intact`, h4.frames.map((f) => sha256B64u(new Uint8Array(f.data))), sent)
    ok('and the hub read the guest again', logLines.some((l) => l.includes('"msg":"relay released"') && l.includes(r4)))
    g4.ws.close(1000, 'done')
    await h4.until(() => h4.closed)
    const closed = logLines.find((l) => l.includes('"msg":"relay closed"') && l.includes(r4)) ?? '{}'
    const peak = Number(JSON.parse(closed).peakBuffered)
    ok(
      `while ${FRAMES} MiB crossed a stalled host, the most the hub ever queued toward it was ${mib(peak)}`,
      peak > RELAY_MAX_FRAME_BYTES && peak <= RELAY_HIGH_WATER + 2 * RELAY_MAX_FRAME_BYTES,
      closed
    )

    const r6 = (await call('POST', '/v1/relays', { host: A.id }, { dev: C })).body?.relay as string
    const g6 = await mustOpen(`/v1/ws/relay/${r6}`, C, 'guest end')
    const h6 = await mustOpen(`/v1/ws/relay/${r6}`, A, 'host end')
    h6.ws.pause()
    for (let i = 0; i < 16; i++) g6.ws.send(Buffer.from(randomU8(RELAY_MAX_FRAME_BYTES)), { binary: true })
    const held6 = await waitFor(() => logLines.some((l) => l.includes('"msg":"relay held"') && l.includes(r6)), 5000)
    h6.ws.terminate()
    const t6 = performance.now()
    await g6.until(() => g6.closed, 10_000)
    ok(
      `when the stalled end goes, the end the hub was holding closes at once (${(performance.now() - t6).toFixed(0)} ms), not after ws’s 30 s close timer`,
      held6 && g6.closed !== null && performance.now() - t6 < 5000
    )

    const r5 = (await call('POST', '/v1/relays', { host: A.id }, { dev: C })).body?.relay as string
    const g5 = await mustOpen(`/v1/ws/relay/${r5}`, C, 'guest end')
    const h5 = await mustOpen(`/v1/ws/relay/${r5}`, A, 'host end')
    h5.ws.pause() // reads nothing, so never sees a ping...
    const beat = setInterval(() => h5.ws.pong(Buffer.from('still here')), 20) // ...but keeps saying pong
    hub.ping()
    await new Promise((r) => setTimeout(r, 400))
    hub.ping()
    await g5.until(() => g5.closed, 3000)
    clearInterval(beat)
    check('an end that reads nothing is cut at the next round, unsolicited pongs notwithstanding (the relay goes with it)', g5.closed?.reason, 'host left')
    hub.ping()
    await new Promise((r) => setTimeout(r, 400))
    hub.ping()
    await new Promise((r) => setTimeout(r, 200))
    check('while a socket that reads echoes every ping and stays', [presA.closed, presA.ws.readyState], [null, WebSocket.OPEN])
  }

  /* ---------------------------------------------------- revocation */
  console.log('\nrevocation: the device loses its sessions, its sockets and the new key')
  {
    await login(B, OWNER_EMAIL, OWNER_PW)
    const presB = await mustOpen('/v1/ws/presence', B, 'the device to revoke is online')
    const VK3 = newVaultKey()
    const prev = chainNow[chainNow.length - 1]
    const rev = entry(ACCOUNT, prev, { kind: 'revoke', epoch: 3, signer: A.id, target: B.id, vk: vaultKeyCommit(VK3, { account: ACCOUNT, epoch: 3 }) }, A.keys.signPriv)
    const withB = await call(
      'POST',
      '/v1/chain',
      { entries: [rev], wraps: { epoch: 3, devices: [A, B, C].map((d) => wrapFor(VK3, ACCOUNT, 3, d)), recovery: sealRecoveryWrap(VK3, R2.wrapKey, { account: ACCOUNT, epoch: 3 }) } },
      { dev: A }
    )
    check('a revoke may not hand the new key to the device it removes', [withB.status, /will not be an active device/.test(withB.body?.message ?? '')], [400, true])
    const done = await call(
      'POST',
      '/v1/chain',
      { entries: [rev], wraps: { epoch: 3, devices: [A, C].map((d) => wrapFor(VK3, ACCOUNT, 3, d)), recovery: sealRecoveryWrap(VK3, R2.wrapKey, { account: ACCOUNT, epoch: 3 }) } },
      { dev: A }
    )
    check('with wraps for the devices that remain, the revoke lands at epoch 3', [done.status, done.body?.epoch], [200, 3])
    const bye = await presB.frame((f) => f.t === 'bye')
    await presB.until(() => presB.closed)
    check('the revoked device is told bye and its presence closed', [typeof bye?.reason, presB.closed?.code], ['string', 1008])
    const after = await call('GET', '/v1/account', undefined, { dev: B })
    check('its session is gone', [after.status, after.body?.error], [401, 'unauthorized'])
    const again = await login(B, OWNER_EMAIL, OWNER_PW)
    check('and it cannot sign in again as the same device', [again.status, again.body?.error], [403, 'forbidden'])
    const wrapGone = await call('GET', '/v1/vault/wrap?epoch=3', undefined, { dev: A })
    ok('the devices that remain hold epoch 3', wrapGone.status === 200)
  }

  /* ------------------------------------------------------ size caps */
  console.log('\nsize caps')
  {
    // Only the headers go out. The hub refuses on the declared length before it
    // reads a byte and closes; a client still WRITING the body then races its
    // own EPIPE against reading the 413, and fetch lost that race about one
    // run in four ("fetch failed", the suite stopped). Measured 2026-10-01.
    const declared = await rawRequest(hub.lanPort as number, 'POST', '/hub/v1/items', { 'content-type': 'application/json', 'content-length': String(HUB_LIMITS.bodyBytes + 1) })
    check('a body declared over 1 MiB is too-large before a byte of it is read', [declared.status, JSON.parse(declared.body || '{}').error], [413, 'too-large'])
    const chunked = await rawRequest(hub.lanPort as number, 'POST', '/hub/v1/auth/login', { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, Buffer.alloc(HUB_LIMITS.bodyBytes + 10, 0x20), true)
    check('and so is one streamed without a length', [chunked.status, JSON.parse(chunked.body || '{}').error], [413, 'too-large'])
    const notJson = await call('POST', '/v1/auth/login', undefined, { raw: '{nope', headers: { 'content-type': 'application/json' } })
    check('a body that is not JSON is bad-request', notJson.body?.error, 'bad-request')
    const notType = await rawRequest(hub.lanPort as number, 'POST', '/hub/v1/auth/login', { 'content-type': 'text/plain' }, '{}')
    check('and one that is not declared JSON', JSON.parse(notType.body).error, 'bad-request')
  }

  /* ---------------------------------------------------- rate limit */
  console.log('\nthe per-address request bucket')
  {
    const small = await startHub(
      { dataDir: join(TMP, 'rate'), mount: '/hub', edge: { host: '127.0.0.1', port: 0 }, lan: null, edgeSecret: SECRET, rate: { capacity: 5, refillPerSec: 0.01 } },
      { now, log: new HubLog(() => {}), announce: () => {} }
    )
    const base = `http://127.0.0.1:${small.edgePort}/hub`
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await call('GET', '/v1/health', undefined, { base, ip: '203.0.113.1' })).status)
    check('five requests from one address, then 429', codes, [200, 200, 200, 200, 200, 429])
    const r = await call('GET', '/v1/health', undefined, { base, ip: '203.0.113.1' })
    ok('the refusal says when to come back', r.body?.error === 'rate-limited' && r.body?.retryAfterMs > 0 && Number(r.headers.get('retry-after')) > 0)
    const other = await call('GET', '/v1/health', undefined, { base, ip: '203.0.113.2' })
    check('another address has its own bucket', other.status, 200)
    await small.close()
  }

  /* ------------------------------------------------- the edge Worker */
  console.log('\nthe edge Worker in front of it (worker/hub-edge.ts, run under node)')
  {
    const env = { HUB_ORIGIN: `http://127.0.0.1:${hub.edgePort}`, HUB_EDGE_SECRET: SECRET }
    const path = '/v1/account'
    const signed = signRequest({ method: 'GET', pathFromV1: path, device: A.id, signPriv: A.keys.signPriv, token: A.token, body: '', now: clock })
    const viaEdge = await forwardHttp(
      new Request(`https://stoke.vinn.dev/hub${path}`, { headers: { ...signed, [HUB_HEADERS.edge]: 'forged', [HUB_HEADERS.clientIp]: '1.2.3.4', 'cf-connecting-ip': '203.0.113.77' } }),
      env,
      fetch
    )
    const body = (await viaEdge.json()) as any
    check('a signed request through the Worker reaches the hub and verifies', [viaEdge.status, body?.accountId], [200, ACCOUNT])
    const line = logLines.filter((l) => l.includes('"route":"account"')).pop() ?? ''
    ok('the hub throttles it by the visitor’s address, not a forged one', line.includes('"ip":"203.0.113.77"') && !line.includes('1.2.3.4'), line)
    const putBody = JSON.stringify({ puts: [{ baseVersion: 0, envelope: sealItem(itemKeys(newVaultKey(), ACCOUNT, 3), { version: 1, author: A.id, path: 't1/settings/fontFamily', editedAt: clock, deleted: false, value: 'x' }) }] })
    const putHeaders = signRequest({ method: 'POST', pathFromV1: '/v1/items', device: A.id, signPriv: A.keys.signPriv, token: A.token, body: putBody, now: clock })
    const post = await forwardHttp(new Request('https://stoke.vinn.dev/hub/v1/items', { method: 'POST', headers: { ...putHeaders, 'content-type': 'application/json' }, body: putBody }), env, fetch)
    const postBody = (await post.json()) as any
    check('a POST body crosses byte for byte (its signature still verifies)', [post.status, postBody?.results?.[0]?.ok], [200, true])
    const unset = await forwardHttp(new Request(`https://stoke.vinn.dev/hub${path}`, { headers: signed }), { HUB_ORIGIN: env.HUB_ORIGIN }, fetch)
    const unsetRead = readHubResponse(unset.status, unset.headers.get('content-type'), await unset.text())
    check('with no secret configured the Worker forwards nothing and says so as a hub error', [unset.status, !unsetRead.ok && unsetRead.error.error], [503, 'server-error'])
    const down = await forwardHttp(new Request(`https://stoke.vinn.dev/hub${path}`), { HUB_ORIGIN: 'http://127.0.0.1:9', HUB_EDGE_SECRET: SECRET }, fetch)
    check('an origin that does not answer is a 502 hub error', [down.status, ((await down.json()) as any)?.error], [502, 'server-error'])
    const direct = await call('GET', path, undefined, { dev: A, secret: null })
    check('the same request straight to the edge listener, without the Worker, is refused', direct.status, 403)
  }

  /* ------------------------------------------------ nothing leaks */
  console.log('\nwhat the hub keeps and writes')
  {
    const text = logLines.join('\n')
    const leaked = secretsSeen.filter((s) => s && text.includes(s))
    check('no password, token, invite, Kit, vault key, API key or edge secret in the log', leaked.length, 0)
    ok('while the log does name routes, accounts and outcomes', /"msg":"request".*"route":"itemsPut"/.test(text) && text.includes(ACCOUNT) && text.includes('"msg":"account created"'))
    ok('every log line is one JSON object', logLines.every((l) => l.startsWith('{') && typeof JSON.parse(l).msg === 'string'))
    // The redaction itself, for the day a call site passes something it should not.
    const probe: string[] = []
    const plantedToken = `sht_${randomB64u(32)}`
    new HubLog((l) => probe.push(l)).info('probe', {
      token: 'named-a-token',
      password: 'named-a-password',
      nested: { edgeSecret: 'named-a-secret', list: [{ invite: 'named-an-invite' }] },
      innocentName: plantedToken,
      header: 'Bearer abc.def',
      kit: 'RK1-AAAA',
      route: 'itemsPut'
    })
    const line = probe.join('')
    ok(
      'the log redacts by field name at any depth, and by value shape under any name',
      !/named-a-|sht_|Bearer abc|RK1-AAAA/.test(line) && line.includes('"route":"itemsPut"'),
      line
    )
  }

  /* ---------------------------------------------------- shutdown */
  console.log('\ngraceful shutdown')
  {
    const inFlight = login(newDevice('late'), OWNER_EMAIL, OWNER_PW)
    await new Promise((r) => setTimeout(r, 30))
    const closing = hub.close()
    const bye = await presA.frame((f) => f.t === 'bye', 3000)
    await presA.until(() => presA.closed, 3000)
    const r = await inFlight
    await closing
    check('a sign-in in flight when shutdown began still gets its answer', r.status, 200)
    check('presence sockets are told bye and closed as going away (1001)', [typeof bye?.reason, presA.closed?.code], ['string', 1001])
    let refused = false
    try {
      await fetch(`${LAN}/v1/health`)
    } catch {
      refused = true
    }
    ok('after close the hub no longer answers', refused)
    ok('and leaves no log line after "stopped"', logLines[logLines.length - 1].includes('"msg":"stopped"'))
  }

  /* ------------------------------------------- ciphertext at rest */
  console.log('\nciphertext only at rest')
  {
    const dir = join(TMP, 'hub')
    const files = readdirSync(dir).filter((f) => f.startsWith('hub.db'))
    const bytes = Buffer.concat(files.map((f) => readFileSync(join(dir, f))))
    const found = secretsSeen.filter((s) => s && bytes.includes(Buffer.from(s, 'utf8')))
    check(`no planted plaintext in ${files.join(', ')} (canary, passwords, tokens, invites, Kit, vault key)`, found.length, 0)
    ok('while the positive controls are there: the email and an opaque item id', liveItemId !== '' && bytes.includes(Buffer.from('owner@example.com')) && bytes.includes(Buffer.from(liveItemId)))
    const db = new DatabaseSync(join(dir, 'hub.db'), { readOnly: true })
    const pw = db.prepare('SELECT pw_hash FROM accounts WHERE email = ?').get('owner@example.com') as { pw_hash: string }
    ok('the password is stored as scrypt N=2^17', /^scrypt\$17\$8\$1\$/.test(pw.pw_hash))
    const tokens = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]
    ok('sessions are stored as hashes of tokens', tokens.length > 0 && tokens.every((t) => !t.token_hash.startsWith('sht_')) && tokens.some((t) => t.token_hash === sha256B64u(A.token)))
    db.close()
    if (!WIN) {
      check('the data directory is 0700', statSync(dir).mode & 0o777, 0o700)
      check('the database is 0600', statSync(join(dir, 'hub.db')).mode & 0o777, 0o600)
    }
  }

  /* ------------------------------------------------ configuration */
  console.log('\nconfiguration')
  {
    // A database made before pairs recorded their creator's key gains the column on open.
    const oldDir = join(TMP, 'old-schema')
    mkdirSync(oldDir, { recursive: true })
    const before = new DatabaseSync(join(oldDir, 'hub.db'))
    before.exec('CREATE TABLE pairs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT NOT NULL, device_label TEXT NOT NULL, device_platform TEXT NOT NULL, state TEXT NOT NULL, commit_hash TEXT NOT NULL, approver_json TEXT, nonce_e TEXT, reveal_json TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER)')
    before.close()
    HubStore.open(oldDir).close()
    const after = new DatabaseSync(join(oldDir, 'hub.db'), { readOnly: true })
    const cols = (after.prepare('PRAGMA table_info(pairs)').all() as { name: string }[]).map((c) => c.name)
    after.close()
    ok('an older database gains pairs.device_sign when the hub opens it', cols.includes('device_sign'), cols.join(','))
    check('a listen address', parseListen('127.0.0.1:8787', 'x'), { host: '127.0.0.1', port: 8787 })
    check('an IPv6 one', parseListen('[::1]:8788', 'x'), { host: '::1', port: 8788 })
    check('off is no listener', parseListen('off', 'x'), null)
    let threw = false
    try {
      parseListen('8787', 'x')
    } catch {
      threw = true
    }
    ok('a bare port is refused with a sentence', threw)
    check('the mount defaults to /hub, trailing slash dropped', [parseMount(undefined), parseMount('/hub/'), parseMount('/')], ['/hub', '/hub', ''])
    check('the secret comes from the environment', readEdgeSecret({ HUB_EDGE_SECRET: ' s3cret ' }), 's3cret')
    check('or from systemd’s credential directory', readEdgeSecret({ CREDENTIALS_DIRECTORY: '/run/creds' }, (p) => (p === join('/run/creds', 'hub-edge-secret') ? 'from-file\n' : '')), 'from-file')
    const cfg = configFrom({ STATE_DIRECTORY: '/var/lib/stoke-hub' }, {})
    check('systemd’s StateDirectory is the data dir; the edge listener is loopback 8787; no LAN listener', [cfg.dataDir, cfg.edge, cfg.lan], ['/var/lib/stoke-hub', { host: '127.0.0.1', port: 8787 }, null])
    let noDir = false
    try {
      configFrom({}, {})
    } catch {
      noDir = true
    }
    ok('with no data directory named anywhere it refuses to guess', noDir)
  }

  /* ------------------------------------------------ the command */
  console.log('\nthe stoke-hub command: from source, and bundled')
  await commandChecks()
}

/* ------------------------------------------------------------------ CLI */

interface Child {
  proc: ChildProcess
  out: string
  err: string
}

function startChild(args: string[], env: Record<string, string>): Child {
  // ELECTRON_RUN_AS_NODE passes through, so `ELECTRON_RUN_AS_NODE=1 electron scripts/verify-hub-server.mts`
  // runs every child under Electron's Node 24 too — the NUC's major version.
  const runAsNode = process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } : {}
  const proc = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...runAsNode, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const c: Child = { proc, out: '', err: '' }
  proc.stdout?.on('data', (d: Buffer) => (c.out += d.toString('utf8')))
  proc.stderr?.on('data', (d: Buffer) => (c.err += d.toString('utf8')))
  return c
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

function runChild(args: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = startChild(args, env)
    const t = setTimeout(() => c.proc.kill('SIGKILL'), 20_000)
    c.proc.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out: c.out, err: c.err })
    })
    c.proc.stdin?.end(stdin ?? '')
  })
}

async function commandChecks(): Promise<void> {
  const { build } = await import('esbuild')
  const { bundleOptions } = (await import('../hub/build.mjs')) as { bundleOptions: (outfile: string) => Record<string, unknown> }
  const bundle = join(TMP, 'stoke-hub.mjs')
  await build(bundleOptions(bundle) as never)
  ok('hub/build.mjs bundles the server into one file', existsSync(bundle) && statSync(bundle).size > 50_000)

  const variants: { name: string; entry: string[] }[] = [
    { name: 'source', entry: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(ROOT, 'hub', 'server.ts')] },
    { name: 'bundle', entry: ['--disable-warning=ExperimentalWarning', bundle] }
  ]
  for (const v of variants) {
    const data = join(TMP, `cli-${v.name}`)
    const env = { STOKE_HUB_DATA: data, STOKE_HUB_LISTEN: '127.0.0.1:0', STOKE_HUB_LAN: '127.0.0.1:0', HUB_EDGE_SECRET: SECRET }
    const c = startChild([...v.entry, 'serve'], env)
    const started = await waitFor(() => c.out.includes('"msg":"started"'), 15_000)
    ok(`${v.name}: serve starts`, started, c.err || c.out)
    if (!started) {
      c.proc.kill('SIGTERM')
      continue
    }
    const port = Number(/"listener":"lan","host":"127\.0\.0\.1","port":(\d+)/.exec(c.out)?.[1])
    const edgePort = Number(/"listener":"edge","host":"127\.0\.0\.1","port":(\d+)/.exec(c.out)?.[1])
    const printed = /this invite \(valid 24 h, one use\):\n {2}(INV[-0-9A-Z]+)\n/.exec(c.out)?.[1]
    ok(`${v.name}: prints the bootstrap invite on stdout`, !!printed)
    const h = await fetch(`http://127.0.0.1:${port}/hub/v1/health`)
    check(`${v.name}: answers health`, h.status, 200)
    if (v.name === 'bundle') {
      const cliEnv = { STOKE_HUB_DATA: data }
      const inv = await runChild([...v.entry, 'invite'], cliEnv)
      const reprinted = /one use\):\n {2}(INV[-0-9A-Z]+)/.exec(inv.out)?.[1]
      ok('invite with no account yet prints a fresh bootstrap invite', inv.code === 0 && !!reprinted && reprinted !== printed, inv.err)
      const base = `http://127.0.0.1:${port}/hub`
      const oldOne = await signup(printed ?? '', 'first@example.com', 'a password long enough', { base })
      check('which revokes the one serve printed', oldOne.body?.error, 'invite-invalid')
      const owner = await signup(reprinted ?? '', 'first@example.com', 'a password long enough', { base })
      check('and makes the owner', owner.body?.role, 'owner')
      const inv2 = await runChild([...v.entry, 'invite', '--data', data], {})
      const member = /new member[^\n]*\n {2}(INV[-0-9A-Z]+)/.exec(inv2.out)?.[1]
      const m = await signup(member ?? '', 'second@example.com', 'another long password', { base })
      check('then invite mints a member invite that works', [inv2.code, m.body?.role], [0, 'member'])
      const hc = await runChild([...v.entry, 'health'], { STOKE_HUB_LISTEN: `127.0.0.1:${edgePort}`, HUB_EDGE_SECRET: SECRET })
      ok('health checks the local edge listener with the secret', hc.code === 0 && /stoke-hub 0\.\d+\.\d+, protocol 1/.test(hc.out), hc.out + hc.err)
      const hcBad = await runChild([...v.entry, 'health'], { STOKE_HUB_LISTEN: `127.0.0.1:${edgePort}`, HUB_EDGE_SECRET: randomB64u(32) })
      ok('and fails, with the hub’s own sentence, on the wrong secret', hcBad.code !== 0 && /did not come through its edge/.test(hcBad.err), hcBad.err)
      const backups = join(TMP, 'backups')
      const b1 = await runChild([...v.entry, 'backup', backups], cliEnv)
      const made = existsSync(backups) ? readdirSync(backups).filter((f) => /^hub-\d{8}-\d{4}(\d{2})?\.db$/.test(f)) : []
      ok('backup writes hub-YYYYMMDD-HHMM.db while the hub serves', b1.code === 0 && made.length === 1, b1.err)
      if (made.length) {
        const copy = new DatabaseSync(join(backups, made[0]), { readOnly: true })
        const n = (copy.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n
        copy.close()
        check('and the copy holds both accounts', n, 2)
        if (!WIN) check('readable by the owner only', statSync(join(backups, made[0])).mode & 0o777, 0o600)
      }
      mkdirSync(backups, { recursive: true })
      for (let i = 1; i <= 3; i++) writeFileSync(join(backups, `hub-2020010${i}-0000.db`), 'old')
      const b2 = await runChild([...v.entry, 'backup', backups, '--keep', '2'], cliEnv)
      const kept = readdirSync(backups).filter((f) => f.startsWith('hub-')).sort()
      ok('--keep prunes the oldest', b2.code === 0 && kept.length === 2 && !kept.some((f) => f.startsWith('hub-2020')), kept.join(','))
      const reset = await runChild([...v.entry, 'reset-password', 'first@example.com'], cliEnv, 'a brand new password here\n')
      ok('reset-password takes the new one from stdin', reset.code === 0 && /Password reset for first@example\.com/.test(reset.out), reset.err)
      const dev = newDevice('cli')
      const oldPw = await login(dev, 'first@example.com', 'a password long enough', { base })
      const newPw = await login(dev, 'first@example.com', 'a brand new password here', { base })
      check('the old password no longer signs in, the new one does', [oldPw.status, newPw.status], [401, 200])
      const nobody = await runChild([...v.entry, 'reset-password', 'nobody@example.com'], cliEnv, 'whatever password 123\n')
      check('reset-password for an unknown email exits 2', nobody.code, 2)
    }
    if (WIN) {
      console.log(`  SKIP  ${v.name}: SIGTERM (Windows delivers no signal to catch; close() is exercised in-process above)`)
      c.proc.kill()
      continue
    }
    c.proc.kill('SIGTERM')
    const exited = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(-1), 10_000)
      c.proc.on('close', (code) => {
        clearTimeout(t)
        resolve(code)
      })
    })
    check(`${v.name}: SIGTERM stops it cleanly (exit 0, "stopped" logged)`, [exited, c.out.includes('"msg":"stopped"')], [0, true])
    if (v.name === 'bundle') check('the bundle prints nothing on stderr (no warning, no stack)', c.err.trim(), '')
    if (!WIN) {
      const f = join(data, 'hub.db')
      check(`${v.name}: its database is 0600 under the umask serve sets`, existsSync(f) ? statSync(f).mode & 0o777 : -1, 0o600)
    }
  }
}

try {
  await main()
} catch (err) {
  failures++
  console.log(`  FAIL  the suite stopped: ${(err as Error).stack ?? String(err)}`)
  try {
    await hub?.close()
  } catch {
    /* already closed */
  }
} finally {
  try {
    chmodSync(TMP, 0o700)
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* a temp dir */
  }
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
