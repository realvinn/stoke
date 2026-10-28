/*
 * "Keep a connection log" (src/main/hub/connectionLog.ts, the rules in
 * src/shared/hub/connectionTrace.ts), with no Electron and no network:
 *
 *   node scripts/verify-connection-log.mts
 *
 * - OFF writes nothing: not a line, not a file, not a stat.
 * - ON, two `HubRemote`s through a fake hub (scripts/hub-relay-fakes.mts)
 *   write the guest's connect / open / handshake / ready / attached, a close
 *   the hub sent as 1006 "host left", the lost line and the reconnect, and the
 *   host's notice / handshake / decision / close / end; presence writes its
 *   connect / open / round trip / close / retry / heartbeat miss / error.
 * - The never-written list: a planted session token, device label, typed
 *   text, hub URL, email, session title, the account id and the full device
 *   ids — each built from pieces at run time (gotcha 157) and fed through every
 *   path that could carry it (an error, a close reason, a refusal, a typed
 *   frame, the hub address) — appear in no byte of any log.
 * - Rotation at the cap into `.1`, the burst limit, the toggle taking effect
 *   at the next event, the `closeReasonTag`/`errorCodeOf`/`hubViaOf` tables,
 *   and the real file system: `connections.log` appears only once it is on.
 * - Every close reason the hub, its edge Worker and this client send, read out
 *   of their source, has a tag of its own (none is `other`); a real `ws` close
 *   hands its reason as bytes and is still tagged; and the row stays in reach
 *   outside the vault while the log is on.
 *
 * Every input is synthetic (gotcha 74); the real-fs part writes only under the
 * suite's own scratch TMPDIR (scripts/suite-tmpdir.mts, imported first).
 */
import './suite-tmpdir.mts'
import { inScratch } from './suite-tmpdir.mts'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { nodeLogFs, type LogFs } from '../src/main/diagnosticsLog.ts'
import { CONNECTION_EVENT_BURST, CONNECTION_LOG_NAME, ConnectionLog } from '../src/main/hub/connectionLog.ts'
import { HubPresence, type PresenceSocket } from '../src/main/hub/presence.ts'
import {
  CLOSE_REASON_TAGS,
  closeReasonFields,
  closeReasonTag,
  DEVICE_ID_CHARS,
  errorCodeOf,
  hubViaOf,
  traceFields
} from '../src/shared/hub/connectionTrace.ts'
import { idFromBytes } from '../src/shared/hub/codec.ts'
import { HUB_SETTINGS_DEFAULTS, hydrateHubSettings, t1ValuesFrom } from '../src/shared/hub/settings.ts'
import { LOCAL_KEYS, portableSettings } from '../src/shared/setupFile.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { randomU8 } from '../src/main/hub/crypto.ts'
import { dev, lastView, machine, makeHub, stubRow, tabOf, tick, until, type Machine } from './hub-relay-fakes.mts'

let failures = 0
let passes = 0
function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (pass) passes++
  else failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${JSON.stringify(got)?.slice(0, 600)}, want ${JSON.stringify(want)?.slice(0, 400)}`))
}
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) passes++
  else failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail.slice(0, 900)}`}`)
}

/* ------------------------------------------------------------ fakes */

/** An in-memory `LogFs`, counting every call. */
function memFs(): { fs: LogFs; files: Map<string, string>; calls: () => number; renames: () => number } {
  const files = new Map<string, string>()
  let calls = 0
  let renames = 0
  const fs: LogFs = {
    append: async (f, t) => {
      calls++
      files.set(f, (files.get(f) ?? '') + t)
    },
    rename: async (a, b) => {
      calls++
      const v = files.get(a)
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      files.set(b, v)
      files.delete(a)
      renames++
    },
    size: async (f) => {
      calls++
      return Buffer.byteLength(files.get(f) ?? '')
    },
    tail: async (f, n) => {
      calls++
      const b = Buffer.from(files.get(f) ?? '')
      return { text: b.subarray(Math.max(0, b.length - n)).toString('utf8'), whole: b.length <= n }
    },
    appendSync: (f, t) => {
      calls++
      files.set(f, (files.get(f) ?? '') + t)
    }
  }
  return { fs, files, calls: () => calls, renames: () => renames }
}

interface Line {
  at: string
  event: string
  f: Record<string, string>
}
function parse(text: string): Line[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [at, event, ...rest] = l.split(' ')
      return { at, event, f: Object.fromEntries(rest.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])) }
    })
}

/* ------------------------------------------- planted secrets (gotcha 157) */

const piece = (...p: string[]): string => p.join('')
const TOKEN = piece('stk', '_sess_', randomBytes(12).toString('hex'))
const LABEL = piece('Quokka', 'Laptop', 'Zz9')
const TYPED = piece('typed', 'Secret', 'W0rds', '\r')
const HUB_URL = piece('https://', 'hub.', 'plantedhost', '.example', '/hub')
const EMAIL = piece('owner', '@', 'plantedmail', '.example')
const TITLE = piece('Pelican', 'Plan', 'Title')
const ABOUT = { version: '1.0.0-beta.20', os: 'darwin', arch: 'arm64', hubUrl: HUB_URL }

/* ====================================================== the setting */

console.log('\nthe setting: hub.connectionLog, off by default, this computer only')
{
  check('off by default, and a fresh profile hydrates it off', [HUB_SETTINGS_DEFAULTS.connectionLog, hydrateHubSettings({}).connectionLog, hydrateSettings(null).hub.connectionLog], [false, false, false])
  check('only the literal true turns it on', [hydrateHubSettings({ connectionLog: true }).connectionLog, hydrateHubSettings({ connectionLog: 'yes' }).connectionLog, hydrateHubSettings({ connectionLog: 1 }).connectionLog], [true, false, false])
  const on = hydrateSettings({ hub: { connectionLog: true } })
  check('kept through a whole-settings hydrate', on.hub.connectionLog, true)
  check(
    'never synced or exported: `hub` is local, so neither the hub upload nor a setup file carries it',
    [(LOCAL_KEYS as readonly string[]).includes('hub'), 'hub' in portableSettings(on), JSON.stringify(t1ValuesFrom(on)).includes('connectionLog')],
    [true, false, false]
  )
  // On, the log goes on writing outside the vault (its log-start at every start, sleep, wake, screen lock), and
  // the Other machines section that holds its row is drawn only inside it: so the row is drawn there too.
  const page = readFileSync(new URL('../src/renderer/src/components/AccountSyncSettings.tsx', import.meta.url), 'utf8')
  ok(
    'on, its row is drawn outside the vault too, so the switch stays in reach (signed out, or out of the vault)',
    /\{view\.phase !== 'active' && connectionLog && <ConnectionLogRow on=\{connectionLog\} \/>\}/.test(page)
  )
}

/* ================================================== the tables (pure) */

console.log('\nthe close reason table')
{
  const known: [string, string][] = [
    ['host left', 'host-left'],
    ['guest left', 'guest-left'],
    ['the other end never joined', 'never-joined'],
    ['idle', 'idle'],
    ['WebSocket disconnected without sending Close frame.', 'cf-no-close'],
    ['CloudFlare WebSocket proxy restarting', 'cf-restarting'],
    ['edge error', 'edge-error'],
    ['hub error', 'hub-error'],
    ['the hub is restarting', 'hub-restarting'],
    ['the tab was closed', 'tab-closed'],
    ['refused', 'refused'],
    ['the other machine stopped answering', 'pong-timeout'],
    ['the other machine did not pick up', 'join-timeout'],
    ['signed out', 'signed-out'],
    ['could not deliver a frame', 'undeliverable'],
    ['the other end is not reading', 'not-reading'],
    ['the relay closed', 'relay-closed'],
    ['a frame did not open: dropped, repeated, reordered or changed on the way', 'frame-unopened'],
    ['', 'none']
  ]
  check('each known reason maps to its tag', known.map(([r]) => closeReasonTag(r)), known.map(([, t]) => t))
  check('case and surrounding space do not matter', [closeReasonTag('  Host Left '), closeReasonTag('IDLE')], ['host-left', 'idle'])
  check(
    'a reason that names the other machine keeps only its tag',
    [closeReasonTag(`The chat on ${LABEL} did not send its terminal screen. Other chats may still be available.`), closeReasonTag(`${LABEL} is not online.`), closeReasonTag(`${LABEL} is no longer one of your devices.`)],
    ['snapshot-timeout', 'offline-local', 'not-a-device']
  )
  const unknown = `bad token ${TOKEN}`
  check('an unknown reason is `other` with its length, never its text', closeReasonFields(unknown), { why: 'other', whyLen: unknown.length })
  check('a non-string reason is `other`', [closeReasonTag(undefined), closeReasonTag(1006)], ['other', 'other'])
  ok('every tag is a short word (no spaces, no text)', [...CLOSE_REASON_TAGS].every((t) => /^[a-z][a-z0-9-]{1,31}$/.test(t)))
}

console.log('\nevery close reason the hub, its edge and this client send has a tag of its own')
{
  /** The top-level arguments of every `name(` call in `src`, as source text (quotes and brackets respected). */
  const callsOf = (src: string, name: string): string[][] => {
    const out: string[][] = []
    for (const m of src.matchAll(new RegExp(`(?<![\\w$])${name}\\(`, 'g'))) {
      const args: string[] = []
      let depth = 0
      let cur = ''
      let quote: string | null = null
      for (let i = (m.index ?? 0) + m[0].length; i < src.length; i++) {
        const c = src[i]
        if (quote) {
          cur += c
          if (c === '\\') cur += src[++i]
          else if (c === quote) quote = null
          continue
        }
        if (c === "'" || c === '"' || c === '`') quote = c
        else if ('([{'.includes(c)) depth++
        else if (')]}'.includes(c)) {
          if (depth === 0) {
            if (cur.trim()) args.push(cur.trim())
            break
          }
          depth--
        } else if (c === ',' && depth === 0) {
          args.push(cur.trim())
          cur = ''
          continue
        }
        cur += c
      }
      out.push(args)
    }
    return out
  }
  /** The reason a call passes in `at` (its last string literal: `reason || 'fallback'` gives the fallback), `${role}` as both roles and any other name as a label. */
  const reasonsAt = (args: string[], at: number | 'any'): string[] => {
    const literal = (arg: string): string | null => {
      const all = [...arg.matchAll(/'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)]
      const last = all[all.length - 1]
      return last ? (last[1] ?? last[2]) : null
    }
    const picked = at === 'any' ? args.map(literal) : [args[at] === undefined ? null : literal(args[at])]
    return picked
      .filter((r): r is string => r !== null)
      .flatMap((r) => (r.includes('${role}') ? ['guest', 'host'].map((role) => r.replace('${role}', role)) : [r]))
      .map((r) => r.replace(/\$\{[^}]*\}/g, LABEL))
  }
  const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  // Where each sender names its reason: the hub's closes (presence and relays), its edge Worker's, and this client's own.
  const senders: [string, string, number | 'any'][] = [
    ['hub/sockets.ts', 'closeQuietly', 2],
    ['hub/sockets.ts', 'closeRelay', 2],
    ['hub/sockets.ts', 'kickDevice', 2],
    ['hub/sockets.ts', 'kickSession', 1],
    ['hub/app.ts', 'closeQuietly', 2],
    ['hub/app.ts', 'closeRelay', 2],
    ['hub/app.ts', 'closeDevice', 3],
    ['hub/app.ts', 'closeSession', 2],
    ['hub/app.ts', 'closeWhere', 2],
    ['hub/app.ts', 'closeAll', 'any'],
    ['hub/app.ts', 'kickDevice', 2],
    ['hub/app.ts', 'kickSession', 1],
    ['hub/app.ts', 'refuse', 1],
    ['worker/hub-edge.ts', 'shut', 2],
    ['worker/hub-edge.ts', 'pipe', 2],
    ['src/main/hub/remote.ts', 'close', 'any'],
    ['src/main/hub/channel.ts', 'fail', 0],
    ['src/main/hub/channel.ts', 'Error', 0]
  ]
  const found: [string, string][] = []
  for (const [file, name, at] of senders) {
    const src = read(file)
    for (const args of callsOf(src, name)) for (const r of reasonsAt(args, at)) found.push([file, r])
  }
  ok('the audit read the senders (the hub’s "host left", the edge’s "edge error", the client’s join deadline)', ['host left', 'edge error', 'the other machine did not pick up'].every((r) => found.some(([, f]) => f === r)), JSON.stringify(found.length))
  const untagged = [...new Set(found.filter(([, r]) => closeReasonTag(r) === 'other').map(([f, r]) => `${f}: ${r}`))]
  check('none of them is `other`: a drop the hub or the edge explains is said as its tag', untagged, [])
  check(
    'and the host’s pty socket closing, as the guest hears it',
    ['the other machine closed the session', 'exit', 'terminated', 'Too many sockets.', 'replaced', 'guest socket error'].map(closeReasonTag),
    ['pty-closed', 'pty-exit', 'pty-terminated', 'too-many-sockets', 'replaced', 'guest-socket-error']
  )
}

console.log('\nerror codes, never messages')
check(
  'errno, hub code, fetch cause, HTTP status, our deadlines, anything else',
  [
    errorCodeOf(Object.assign(new Error(`reset by ${HUB_URL}`), { code: 'ECONNRESET' })),
    errorCodeOf(Object.assign(new Error(`refused for ${EMAIL}`), { code: 'rate-limited' })),
    errorCodeOf(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })),
    errorCodeOf(new Error('Unexpected server response: 502')),
    errorCodeOf(new Error('Opening handshake has timed out')),
    errorCodeOf(new Error('The hub presence connection timed out. Reconnecting.')),
    errorCodeOf(new Error('The hub stopped answering presence heartbeats. Reconnecting.')),
    errorCodeOf(new Error(`token ${TOKEN} refused`)),
    errorCodeOf(Object.assign(new Error('x'), { code: `has space ${TOKEN}` }))
  ],
  ['ECONNRESET', 'rate-limited', 'UND_ERR_CONNECT_TIMEOUT', 'http-502', 'handshake-timeout', 'handshake-timeout', 'heartbeat-miss', 'other', 'other']
)

console.log('\nthe kind of hub address, never the address')
check(
  'the edge, a tailnet / LAN / mDNS / loopback address, anything else, none',
  [
    hubViaOf('https://stoke.vinn.dev/hub'),
    hubViaOf('https://hub-edge.someone.workers.dev/hub'),
    hubViaOf('http://100.82.168.7:8788/hub'),
    hubViaOf('http://192.168.1.20:8788'),
    hubViaOf('http://nuc.local:8788'),
    hubViaOf('https://nuc.tailnet-x.ts.net/hub'),
    hubViaOf('http://localhost:8788'),
    hubViaOf('http://[fd7a:115c:a1e0::1]:8788'),
    hubViaOf(HUB_URL),
    hubViaOf(''),
    hubViaOf('not a url')
  ],
  ['cloudflare', 'cloudflare', 'lan', 'lan', 'lan', 'lan', 'lan', 'lan', 'other', 'none', 'other']
)

console.log('\nwhat a line may hold (traceFields)')
{
  const device = idFromBytes('device', randomU8(10))
  const relay = idFromBytes('relay', randomU8(15))
  const kept = traceFields('relay-close', {
    relay,
    peer: device,
    tab: 3,
    code: 1006,
    why: 'host-left',
    lifeMs: 8432.4,
    title: TITLE,
    label: LABEL,
    url: HUB_URL,
    email: EMAIL,
    token: TOKEN,
    message: `Could not reach ${LABEL}`
  })
  check('only known fields, each in its shape', kept, { relay, peer: device.slice(0, DEVICE_ID_CHARS), tab: 3, code: 1006, why: 'host-left', lifeMs: 8432 })
  check(
    'a known field with free text in it is left out',
    traceFields('relay-lost', { why: `host left ${TOKEN}`, err: `ECONN ${EMAIL}`, relay: `r-${TOKEN}`, peer: LABEL, state: 'thinking', tab: 'rt-abc' as unknown as number }),
    {}
  )
  check('an event the log does not know is dropped whole', traceFields('relay-secret', { tab: 1 }), null)
}

/* ============================================================ OFF */

console.log('\noff: nothing is written, nothing is created')
{
  const mem = memFs()
  const log = new ConnectionLog({ dir: '/fake/userData', enabled: () => false, about: () => ABOUT, fs: mem.fs })
  const hub = makeHub()
  const A = dev('Studio')
  const B = dev('Laptop')
  const host = machine(hub, A, [A, B], { trace: (e, f) => log.trace(e, f) })
  const guest = machine(hub, B, [A, B], { trace: (e, f) => log.trace(e, f) })
  host.sharing = true
  host.grants = { [B.id]: { mode: 'full', label: B.label, at: 1 } }
  host.sessions = [stubRow('pty-a1', TITLE)]
  guest.remote.onOnline([A.id, B.id])
  host.remote.onOnline([A.id, B.id])
  const opened = guest.remote.open(A.id, 'pty-a1')
  const tab = opened.ok ? opened.tab : ''
  await until(() => tabOf(guest, tab)?.state === 'open' && guest.frames.some((f) => f.frame.type === 'attached'))
  guest.remote.input(tab, TYPED)
  await until(() => host.ptyInput.length > 0)
  const r = hub.relays.get(hub.created[0])
  r?.guest.drop(1006, 'host left')
  r?.host.drop(1000, 'guest left')
  await until(() => hub.created.length >= 2, 4000)
  log.settingChanged()
  log.watchPower(new EventEmitter())
  await log.idle()
  check('a whole connect, drop and reconnect with the log off: no file operation at all', [mem.calls(), mem.files.size], [0, 0])
  ok('(the run did connect and reconnect)', hub.created.length >= 2 && host.ptyInput.length > 0)
  guest.remote.reset()
  host.remote.reset()
}

/* ============================================================ ON */

console.log('\non: two machines through a fake hub')
const memA = memFs()
const memB = memFs()
const logA = new ConnectionLog({ dir: '/fake/a', enabled: () => true, about: () => ABOUT, fs: memA.fs })
const logB = new ConnectionLog({ dir: '/fake/b', enabled: () => true, about: () => ABOUT, fs: memB.fs })
const hub = makeHub()
const A = dev(LABEL)
const B = dev('Laptop')
const host: Machine = machine(hub, A, [A, B], { trace: (e, f) => logA.trace(e, f) })
const guest: Machine = machine(hub, B, [A, B], { trace: (e, f) => logB.trace(e, f), snapshotWaitMs: 300 })
host.sharing = true
host.grants = { [B.id]: { mode: 'full', label: B.label, at: 1 } }
host.sessions = [stubRow('pty-a1', TITLE), stubRow('pty-a2', TITLE)]
logA.settingChanged()
logB.settingChanged()
guest.remote.onOnline([A.id, B.id])
host.remote.onOnline([A.id, B.id])
const opened = guest.remote.open(A.id, 'pty-a1')
const tab = opened.ok ? opened.tab : ''
await until(() => tabOf(guest, tab)?.state === 'open' && guest.frames.some((f) => f.frame.type === 'attached'))
guest.remote.input(tab, TYPED)
await until(() => guest.frames.some((f) => f.frame.type === 'data'))
const first = hub.created[0]
// The hub's side of a drop: the guest's leg dies as 1006 "host left", the host hears "guest left".
hub.relays.get(first)?.guest.drop(1006, 'host left')
hub.relays.get(first)?.host.drop(1000, 'guest left')
await until(() => hub.created.length >= 2 && tabOf(guest, tab)?.state === 'open' && guest.frames.filter((f) => f.frame.type === 'attached').length >= 2, 5000)
await logA.idle()
await logB.idle()

const linesB = parse(memB.files.get(logB.file) ?? '')
const linesA = parse(memA.files.get(logA.file) ?? '')
const eventsB = linesB.map((l) => l.event)
// Built with `join`, as the log builds it: Windows' separator is a backslash (gotcha 113).
check('the file is <userData>/connections.log', [logB.file, logB.rotated], [join('/fake/b', CONNECTION_LOG_NAME), join('/fake/b', CONNECTION_LOG_NAME) + '.1'])
check('the first line is log-start: version, os, arch and the KIND of hub address', linesB[0]?.event === 'log-start' ? linesB[0].f : null, { version: ABOUT.version, os: 'darwin', arch: 'arm64', hubVia: 'other' })
{
  const want = ['relay-connect', 'relay-created', 'relay-socket-open', 'relay-handshake', 'relay-ready', 'relay-attached', 'relay-close', 'relay-lost', 'relay-connect', 'relay-created', 'relay-socket-open', 'relay-handshake', 'relay-ready', 'relay-attached']
  check('the guest: connect, open, close, lost, reconnect, in order', eventsB.filter((e) => want.includes(e)), want)
}
{
  const close = linesB.find((l) => l.event === 'relay-close')?.f ?? {}
  check(
    'relay-close: the hub’s 1006 and its "host left" as a tag, said by the remote end, on this relay',
    [close.side, close.code, close.why, close.by, close.relay, close.peer, close.tab],
    ['guest', '1006', 'host-left', 'remote', first, A.id.slice(0, DEVICE_ID_CHARS), '1']
  )
  ok(
    'relay-close carries the totals each way, frames and bytes, and how long and how quiet',
    ['lifeMs', 'quietMs', 'tx', 'rx', 'txB', 'rxB'].every((k) => /^\d+$/.test(close[k] ?? '')) && Number(close.rxB) > Number(close.rx) && Number(close.tx) > 0,
    JSON.stringify(close)
  )
  const lost = linesB.find((l) => l.event === 'relay-lost')?.f ?? {}
  check('relay-lost: the try, the state, the delay, the reason tag', [lost.tries, lost.state, lost.why, /^\d+$/.test(lost.delayMs ?? '')], ['1', 'reconnecting', 'relay-closed', true])
  const again = linesB.filter((l) => l.event === 'relay-connect')[1]?.f ?? {}
  check('the reconnect is try 1 on a fresh relay', [again.try, linesB.filter((l) => l.event === 'relay-created')[1]?.f.relay === hub.created[1]], ['1', true])
  check('the ready line says the grant’s mode', linesB.find((l) => l.event === 'relay-ready')?.f.mode, 'full')
}
{
  const eventsA = linesA.map((l) => l.event)
  const want = ['log-start', 'host-relay-notice', 'host-handshake', 'host-decision', 'host-relay-close', 'host-relay-end', 'host-relay-notice']
  check('the host: notice, handshake, decision, close, end, and the next notice', eventsA.filter((e) => want.includes(e)).slice(0, want.length), want)
  const decision = linesA.find((l) => l.event === 'host-decision')?.f ?? {}
  check('host-decision: served under Always, for a session', [decision.decision, decision.via, decision.kind], ['serve', 'always', 'session'])
  const hclose = linesA.find((l) => l.event === 'host-relay-close')?.f ?? {}
  check('host-relay-close: the code and tag the host heard', [hclose.side, hclose.code, hclose.why, hclose.by, hclose.relay], ['host', '1000', 'guest-left', 'remote', first])
  const end = linesA.find((l) => l.event === 'host-relay-end')?.f ?? {}
  check('host-relay-end: from serving, with its socket count', [end.phase, end.sockets, /^\d+$/.test(end.ms ?? '')], ['serving', '1', true])
}

console.log('\non: the host’s silent refusals are said now')
{
  const relay = idFromBytes('relay', randomU8(15))
  const X = dev('Stranger')
  await host.remote.onRelay(relay, X.id)
  const live = hub.created[hub.created.length - 1]
  await host.remote.onRelay(live, B.id)
  await logA.idle()
  const skips = parse(memA.files.get(logA.file) ?? '').filter((l) => l.event === 'host-relay-skip')
  check('a device the chain does not hold, and a repeated notice', skips.map((l) => [l.f.why, l.f.relay]), [['not-device', relay], ['repeat', live]])
}

console.log('\non: a reason or an error that carries a name, a token or an email keeps only its tag')
{
  // A snapshot that never comes: the close reason names the host (LABEL).
  host.silent = true
  const o2 = guest.remote.open(A.id, 'pty-a2')
  const tab2 = o2.ok ? o2.tab : ''
  await until(() => parse(memB.files.get(logB.file) ?? '').some((l) => l.event === 'relay-snapshot-timeout'), 4000)
  host.silent = false
  // A hub that refuses the relay, with a token and an email in its words.
  hub.failNext = Object.assign(new Error(`signed request for ${EMAIL} refused: ${TOKEN}`), { code: 'rate-limited' })
  await until(() => parse(memB.files.get(logB.file) ?? '').some((l) => l.event === 'relay-create-failed'), 5000)
  // A close whose reason holds the token.
  await until(() => tabOf(guest, tab2)?.state === 'open', 5000)
  const live = hub.relays.get(hub.created[hub.created.length - 1])
  live?.guest.drop(1008, `bad token ${TOKEN}`)
  await until(() => parse(memB.files.get(logB.file) ?? '').filter((l) => l.event === 'relay-close').some((l) => l.f.why === 'other'), 4000)
  guest.remote.close(tab2)
  await logB.idle()
  const lines = parse(memB.files.get(logB.file) ?? '')
  check('the snapshot wait: its own line and the tag, not the sentence naming the machine', [lines.some((l) => l.event === 'relay-snapshot-timeout'), lines.some((l) => l.event === 'relay-close' && l.f.why === 'snapshot-timeout')], [true, true])
  check('a refused relay: the hub’s code only', lines.find((l) => l.event === 'relay-create-failed')?.f.err, 'rate-limited')
  const other = lines.find((l) => l.event === 'relay-close' && l.f.why === 'other')?.f ?? {}
  check('an unknown close reason: `other` and its length', [other.code, other.whyLen], ['1008', String(`bad token ${TOKEN}`.length)])
  check('the tab closed here', lines.filter((l) => l.event === 'relay-tab-close').length, 1)
}

console.log('\non: presence')
const memP = memFs()
const logP = new ConnectionLog({ dir: '/fake/p', enabled: () => true, about: () => ABOUT, fs: memP.fs })
{
  class Sock extends EventEmitter implements PresenceSocket {
    sent: string[] = []
    send(text: string): void {
      this.sent.push(text)
    }
    close(): void {
      this.emit('close', 1000, Buffer.from(''))
    }
    terminate(): void {
      this.close()
    }
  }
  const sockets: Sock[] = []
  let clock = 1_000_000
  let opens = 0
  const p = new HubPresence({
    open: async () => {
      opens++
      if (opens === 3) throw Object.assign(new Error(`connect ECONNREFUSED for ${EMAIL} at ${HUB_URL}`), { code: 'ECONNREFUSED' })
      const s = new Sock()
      sockets.push(s)
      return s
    },
    enabled: () => true,
    opened: () => {},
    message: () => {},
    closed: () => {},
    error: () => {},
    now: () => clock,
    pingMs: 20,
    handshakeMs: 2000,
    retryMs: () => 5,
    trace: (e, f) => logP.trace(e, f)
  })
  p.start()
  await until(() => sockets[0]?.listenerCount('open'))
  clock += 40
  sockets[0].emit('open')
  await until(() => sockets[0].sent.some((t) => t.includes('"ping"')), 2000)
  clock += 7
  sockets[0].emit('message', '{"t":"pong"}')
  // Cloudflare's own words for a socket that vanished.
  sockets[0].emit('close', 1006, Buffer.from('WebSocket disconnected without sending Close frame.'))
  await until(() => sockets[1]?.listenerCount('open'))
  sockets[1].emit('open')
  // Nothing heard for longer than 2.5 pings: the heartbeat gives up.
  await until(() => sockets[1].sent.length > 0, 2000)
  clock += 1000
  await until(() => opens >= 3, 2000)
  await until(() => sockets[2]?.listenerCount('open'), 2000)
  p.stop()
  await logP.idle()
  const lines = parse(memP.files.get(logP.file) ?? '')
  const events = lines.map((l) => l.event)
  check(
    'connect, open, round trip, close, retry, heartbeat miss, error',
    ['presence-connect', 'presence-open', 'presence-rtt', 'presence-close', 'presence-retry', 'presence-heartbeat-miss', 'presence-error'].map((e) => events.includes(e)),
    [true, true, true, true, true, true, true]
  )
  const close = lines.find((l) => l.event === 'presence-close')?.f ?? {}
  check('presence-close: 1006 and Cloudflare’s reason as its tag, with its life and message count', [close.code, close.why, close.messages, close.lifeMs], ['1006', 'cf-no-close', '1', '7'])
  check('presence-rtt: ping to the next frame', lines.find((l) => l.event === 'presence-rtt')?.f.ms, '7')
  check('presence-open: how long the upgrade took', lines.find((l) => l.event === 'presence-open')?.f.ms, '40')
  check('presence-error: the error code only', lines.filter((l) => l.event === 'presence-error').map((l) => l.f.err), ['heartbeat-miss', 'ECONNREFUSED'])
}
{
  // A real `ws` client against a real `ws` server that closes the way the hub closes a replaced presence
  // socket (hub/sockets.ts: 4001 "replaced"): the reason crosses as bytes, and the line still says its tag.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const port = (server.address() as AddressInfo).port
  server.on('connection', (ws) => setTimeout(() => ws.close(4001, 'replaced'), 20))
  const memR = memFs()
  const logR = new ConnectionLog({ dir: '/fake/ws', enabled: () => true, about: () => ABOUT, fs: memR.fs })
  let reason: unknown = null
  const p = new HubPresence({
    open: async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.once('close', (_code: number, why: unknown) => (reason ??= why))
      return ws as unknown as PresenceSocket
    },
    enabled: () => true,
    opened: () => {},
    message: () => {},
    closed: () => {},
    error: () => {},
    handshakeMs: 2000,
    retryMs: () => 60_000,
    trace: (e, f) => logR.trace(e, f)
  })
  p.start()
  await until(() => [...memR.files.values()].join('').includes('presence-close'), 3000)
  p.stop()
  for (const ws of server.clients) ws.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await logR.idle()
  const close = parse(memR.files.get(logR.file) ?? '').find((l) => l.event === 'presence-close')?.f ?? {}
  check('a real ws close: 4001 and the hub’s "replaced" as its tag', [close.code, close.why], ['4001', 'replaced'])
  ok('(ws handed the reason as bytes, not text)', reason instanceof Uint8Array && !(typeof reason === 'string'), typeof reason)
}
{
  guest.remote.onOnline([B.id])
  await logB.idle()
  const online = parse(memB.files.get(logB.file) ?? '').filter((l) => l.event === 'presence-online').pop()?.f ?? {}
  check('presence-online: how many are online, and how many open tabs’ machines are not', [online.count, online.offlineTabs], ['1', '1'])
  guest.remote.onOnline([A.id, B.id])
}

console.log('\non: sleep, wake and screen lock')
{
  const power = new EventEmitter()
  logB.watchPower(power)
  power.emit('suspend')
  power.emit('resume')
  power.emit('lock-screen')
  power.emit('unlock-screen')
  await logB.idle()
  const events = parse(memB.files.get(logB.file) ?? '').map((l) => l.event)
  check('suspend, resume, lock-screen, unlock-screen', ['suspend', 'resume', 'lock-screen', 'unlock-screen'].map((e) => events.includes(e)), [true, true, true, true])
}

console.log('\nthe never-written list')
{
  guest.remote.reset()
  host.remote.reset()
  await logA.idle()
  await logB.idle()
  const all = [...memA.files.values(), ...memB.files.values(), ...memP.files.values()].join('\n')
  ok('the logs hold something to search', all.length > 2000, String(all.length))
  const planted: [string, string][] = [
    ['the session token', TOKEN],
    ['the device label', LABEL],
    ['the typed text', TYPED.trim()],
    ['the hub URL', HUB_URL],
    ['the hub host', 'plantedhost'],
    ['the email', EMAIL],
    ['the email’s domain', 'plantedmail'],
    ['the session title', TITLE],
    ['the account id', hub.account],
    ['the guest’s full device id', B.id],
    ['the host’s full device id', A.id]
  ]
  for (const [name, value] of planted) ok(`${name} appears in no log`, !all.includes(value))
  ok('the typed text reached the other machine (the canary was live)', host.ptyInput.join('').includes(TYPED.trim()))
  ok('the device label was live (it names the host in the snapshot sentence)', lastView(guest) !== undefined && hub.machines.get(A.id)?.label === LABEL)
  ok(
    'every line is `<ISO time> <event> key=value…` with no spaces inside a value',
    all.split('\n').filter(Boolean).every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z [a-z-]+( [A-Za-z]+=[^\s=]+)*$/.test(l)),
    all.split('\n').filter((l) => l && !/^\d{4}-\d\d-\d\dT[\d:.]+Z [a-z-]+( [A-Za-z]+=[^\s=]+)*$/.test(l)).slice(0, 3).join('\n')
  )
}

/* ====================================================== the toggle */

console.log('\nthe toggle takes effect at the next event')
{
  const mem = memFs()
  let on = false
  const log = new ConnectionLog({ dir: '/fake/t', enabled: () => on, about: () => ABOUT, fs: mem.fs })
  log.trace('relay-retry', { tab: 'rt-1' })
  await log.idle()
  const offCalls = mem.calls()
  on = true
  log.trace('relay-retry', { tab: 'rt-1' })
  await log.idle()
  const afterOn = parse(mem.files.get(log.file) ?? '').map((l) => l.event)
  on = false
  log.trace('relay-retry', { tab: 'rt-1' })
  log.trace('relay-tab-close', { tab: 'rt-1' })
  await log.idle()
  const afterOff = parse(mem.files.get(log.file) ?? '').map((l) => l.event)
  on = true
  log.settingChanged()
  await log.idle()
  const afterSetting = parse(mem.files.get(log.file) ?? '').map((l) => l.event)
  check('off: nothing', offCalls, 0)
  check('on: log-start, then the event', afterOn, ['log-start', 'relay-retry'])
  check('off again: nothing more', afterOff, ['log-start', 'relay-retry'])
  check('on again by the setting alone: a fresh log-start at once', afterSetting, ['log-start', 'relay-retry', 'log-start'])
  check('a tab is a local counter, the same for the same tab', parse(mem.files.get(log.file) ?? '').filter((l) => l.event === 'relay-retry').map((l) => l.f.tab), ['1'])
}

/* ============================================================ rotation */

console.log('\nrotation at the cap')
{
  const mem = memFs()
  const cap = 1500
  const log = new ConnectionLog({ dir: '/fake/r', enabled: () => true, about: () => ABOUT, fs: mem.fs, cap, burst: 10_000 })
  const relay = idFromBytes('relay', randomU8(15))
  for (let i = 0; i < 80; i++) {
    log.trace('relay-rtt', { tab: 'rt-r', relay, ms: i })
    await log.idle()
  }
  const cur = mem.files.get(log.file) ?? ''
  const old = mem.files.get(log.rotated) ?? ''
  ok('it rotated, more than once', mem.renames() >= 2, String(mem.renames()))
  check('neither file passes the cap', [Buffer.byteLength(cur) <= cap, Buffer.byteLength(old) <= cap], [true, true])
  const ms = [...parse(old), ...parse(cur)].filter((l) => l.event === 'relay-rtt').map((l) => Number(l.f.ms))
  ok('the newest lines are kept, in order, none cut', ms.length > 10 && ms[ms.length - 1] === 79 && ms.every((v, i) => i === 0 || v === ms[i - 1] + 1), JSON.stringify(ms.slice(-12)))
}

/* =============================================================== bursts */

console.log('\na burst of one kind is held, then counted')
{
  const mem = memFs()
  let clock = 5_000_000
  const log = new ConnectionLog({ dir: '/fake/b2', enabled: () => true, about: () => ABOUT, fs: mem.fs, now: () => clock })
  for (let i = 0; i < CONNECTION_EVENT_BURST + 10; i++) log.trace('relay-lost', { tries: 1 })
  log.trace('relay-tab-close', { tab: 'rt-x' })
  await log.idle()
  clock += 10 * 60_000 + 1
  log.trace('relay-lost', { tries: 2 })
  await log.idle()
  const lines = parse(mem.files.get(log.file) ?? '')
  const lost = lines.filter((l) => l.event === 'relay-lost')
  check('at most the burst of one kind per window; another kind is not held', [lost.length, lines.some((l) => l.event === 'relay-tab-close')], [CONNECTION_EVENT_BURST + 1, true])
  check('the next one after the window says how many were held', lost[lost.length - 1]?.f.suppressed, '10')
}

/* ====================================================== the real fs */

console.log('\nthe real file system (in this run’s scratch TMPDIR)')
{
  const dir = mkdtempSync(join(tmpdir(), 'connlog-'))
  ok('the folder is in the scratch TMPDIR', inScratch(dir), dir)
  let on = false
  const log = new ConnectionLog({ dir, enabled: () => on, about: () => ABOUT, fs: nodeLogFs })
  log.trace('relay-retry', { tab: 'rt-1' })
  log.settingChanged()
  await log.idle()
  check('off: no file is created', [existsSync(join(dir, CONNECTION_LOG_NAME)), (await log.state()).exists, await log.newest()], [false, false, null])
  on = true
  log.trace('relay-retry', { tab: 'rt-1' })
  await log.idle()
  const text = readFileSync(join(dir, CONNECTION_LOG_NAME), 'utf8')
  check('on: connections.log, with the start line and the event', parse(text).map((l) => l.event), ['log-start', 'relay-retry'])
  check('what Show and Copy read: the file, its text, that it exists', [await log.newest() === join(dir, CONNECTION_LOG_NAME), await log.text() === text, (await log.state()).exists], [true, true, true])
}

console.log(`\n${passes} passed, ${failures} failed`)
await tick(0)
process.exitCode = failures ? 1 : 0
