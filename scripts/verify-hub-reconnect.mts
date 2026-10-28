/*
 * How a remote tab ("Other machines", src/main/hub/remote.ts) gets back after
 * a drop, against a fake hub (scripts/hub-relay-fakes.mts) and, for the
 * upgrade deadline, a real `ws` client and a TCP server that never answers:
 *
 *   node scripts/verify-hub-reconnect.mts
 *
 * - F2, the join deadline (`RELAY_JOIN_WAIT_MS`): a host that never picks the
 *   relay up is given up on at the deadline and the next try asks for a fresh
 *   relay; one that picks it up just before is kept; and the host's "let this
 *   device in?" question, which comes after the handshake, is never cut.
 * - F3, `onOnline`: a tab waiting on a machine that has just come online
 *   (given up on, or waiting out a backoff) connects again at once, exactly
 *   once; a refused tab, a tab whose machine left the chain, and a machine that
 *   was online all along get nothing.
 * - F4, the relay upgrade deadline (`RELAY_HANDSHAKE_MS`, `relaySocketOptions`).
 * - F5, `HubRemote.wake`: after a sleep a dead link is found in seconds, a live
 *   one is left alone, a tab already owed a pong is judged on the wake's shorter
 *   wait and is not closed by the keepalive's old one once it answers; and the
 *   wire from powerMonitor `resume` to it.
 * - A channel close whose reason passes a close frame's 123 bytes still closes
 *   the real `ws` socket (`closeFrameReason`).
 *
 * Every input is synthetic (gotcha 74): nothing reaches the network but
 * 127.0.0.1, nothing is written to disk. Imports are relative with `.ts`.
 */
import { readFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { mock } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { closeFrameReason, RelayChannel } from '../src/main/hub/channel.ts'
import { generateDeviceKeys, randomU8 } from '../src/main/hub/crypto.ts'
import { relaySocketOptions } from '../src/main/hub/service.ts'
import { idFromBytes } from '../src/shared/hub/codec.ts'
import { RELAY_HANDSHAKE_MS, RELAY_JOIN_WAIT_MS, RELAY_MAX_FRAME_BYTES, RELAY_WAKE_PONG_MS } from '../src/shared/hub/relay.ts'
import { dev, machine, makeHub, stubRow, tabOf, tick, until, type FakeHub, type Machine } from './hub-relay-fakes.mts'

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

interface Pair {
  hub: FakeHub
  host: Machine
  guest: Machine
  traces: { e: string; f: Record<string, unknown> }[]
  A: ReturnType<typeof dev>
  B: ReturnType<typeof dev>
}
/** A host A sharing two sessions, a guest B; `grant`: B holds Always on A. */
function pair(o: { grant?: boolean; joinWaitMs?: number; keepAlive?: { pingMs: number; pongWaitMs: number } } = {}): Pair {
  const hub = makeHub()
  const A = dev('Studio')
  const B = dev('Laptop')
  const traces: Pair['traces'] = []
  const host = machine(hub, A, [A, B])
  const guest = machine(hub, B, [A, B], { joinWaitMs: o.joinWaitMs, keepAlive: o.keepAlive, trace: (e, f) => traces.push({ e, f: f ?? {} }) })
  host.sharing = true
  if (o.grant !== false) host.grants = { [B.id]: { mode: 'full', label: B.label, at: 1 } }
  host.sessions = [stubRow('pty-a1', 'one'), stubRow('pty-a2', 'two')]
  host.remote.onOnline([A.id, B.id])
  guest.remote.onOnline([A.id, B.id])
  return { hub, host, guest, traces, A, B }
}
const attachedCount = (m: Machine, tab: string): number => m.frames.filter((f) => f.tab === tab && f.frame.type === 'attached').length
function done(p: Pair): void {
  p.guest.remote.reset()
  p.host.remote.reset()
}

/* =============================================== F2: the join deadline */

console.log('\nF2: a host that never picks the relay up')
check('the deadline is 10 s, beside the relay’s own time to live', RELAY_JOIN_WAIT_MS, 10_000)
{
  const p = pair({ joinWaitMs: 200 })
  p.hub.hearRelays = false
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => p.hub.relays.get(p.hub.created[0])?.guest.readyState === 1)
  await tick(100)
  check('before the deadline it is still connecting, on one relay', [tabOf(p.guest, tab)?.state, p.hub.created.length], ['connecting', 1])
  await until(() => p.traces.some((t) => t.e === 'relay-join-timeout'), 1500)
  const first = p.hub.relays.get(p.hub.created[0])
  check('at the deadline the channel is closed, and the tab says why', [first?.guest.readyState, tabOf(p.guest, tab)?.state, tabOf(p.guest, tab)?.message], [3, 'reconnecting', 'the other machine did not pick up'])
  check('it counts as a try', p.traces.filter((t) => t.e === 'relay-lost').map((t) => t.f.tries), [1])
  p.hub.hearRelays = true
  await until(() => p.hub.created.length >= 2 && tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 4000)
  check('the next try asks for a FRESH relay, and that one is served', [p.hub.created.length, p.hub.created[0] !== p.hub.created[1], tabOf(p.guest, tab)?.state], [2, true, 'open'])
  done(p)
}

console.log('\nF2: a host that picks it up just before the deadline')
{
  const p = pair({ joinWaitMs: 500 })
  p.hub.joinDelayMs = 330
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  await tick(700)
  check('kept: one relay, open, no join timeout', [p.hub.created.length, tabOf(p.guest, tab)?.state, p.traces.some((t) => t.e === 'relay-join-timeout')], [1, 'open', false])
  done(p)
}

console.log('\nF2: the host’s question comes after the handshake and is never cut')
{
  const p = pair({ grant: false, joinWaitMs: 150 })
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => p.host.remote.view().asks.length === 1, 3000)
  await until(() => tabOf(p.guest, tab)?.state === 'asking', 3000)
  await tick(150 * 4)
  const relay = p.hub.relays.get(p.hub.created[0])
  check(
    'four deadlines later: still asking, on the one relay, nothing closed',
    [tabOf(p.guest, tab)?.state, p.hub.created.length, relay?.guest.readyState, p.host.remote.view().asks.length, p.traces.some((t) => t.e === 'relay-join-timeout')],
    ['asking', 1, 1, 1, false]
  )
  const ask = p.host.remote.view().asks[0]
  await p.host.remote.answer(ask.id, 'once')
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  check('answered: the tab opens on that same relay', [tabOf(p.guest, tab)?.state, p.hub.created.length], ['open', 1])
  done(p)
}

/* ================================== F3: a machine that comes back online */

console.log('\nF3: a tab waiting out a backoff, when its machine comes online')
{
  const p = pair()
  p.guest.remote.onOnline([p.B.id])
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await tick(20)
  check('the machine is offline: the tab waits to try again, and no relay was asked for', [tabOf(p.guest, tab)?.state, p.hub.created.length], ['reconnecting', 0])
  p.guest.remote.onOnline([p.A.id, p.B.id])
  await until(() => p.hub.created.length > 0, 300)
  check('it comes online: one relay, at once, well before the backoff', p.hub.created.length, 1)
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  await tick(1400)
  check('the backoff that was waiting does not fire a second connect', [p.hub.created.length, tabOf(p.guest, tab)?.state], [1, 'open'])
  check('the revive is a line of its own', p.traces.filter((t) => t.e === 'relay-revive').map((t) => [t.f.state, t.f.tries]), [['reconnecting', 1]])
  p.guest.remote.onOnline([p.A.id, p.B.id])
  await tick(50)
  check('a machine that was online all along: nothing more', p.hub.created.length, 1)
  done(p)
}
{
  // Online all along, and a try failed for another reason: its backoff stands, a presence update does not cut it short.
  const p = pair()
  p.hub.failNext = Object.assign(new Error('rate limited'), { code: 'rate-limited' })
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => tabOf(p.guest, tab)?.state === 'reconnecting', 1000)
  p.guest.remote.onOnline([p.A.id, p.B.id])
  await tick(150)
  check('a machine that did not just come online: the backoff runs its course', [p.hub.created.length, tabOf(p.guest, tab)?.state, p.traces.some((t) => t.e === 'relay-revive')], [0, 'reconnecting', false])
  await until(() => tabOf(p.guest, tab)?.state === 'open', 3000)
  check('and then connects as before', [p.hub.created.length, tabOf(p.guest, tab)?.state], [1, 'open'])
  done(p)
}

/** Drive a tab against an offline machine until it gives up ("lost"), on mocked timers so the eight backoffs take no time. */
function loseTab(p: Pair, ptyId: string): string {
  p.guest.remote.onOnline([p.B.id])
  mock.timers.enable({ apis: ['setTimeout'] })
  let tab = ''
  try {
    const o = p.guest.remote.open(p.A.id, ptyId)
    tab = o.ok ? o.tab : ''
    for (let i = 0; i < 12 && tabOf(p.guest, tab)?.state !== 'lost'; i++) mock.timers.tick(61_000)
  } finally {
    mock.timers.reset()
  }
  return tab
}

console.log('\nF3: a tab that gave up ("lost"), when its machine comes online')
{
  const p = pair()
  const tab = loseTab(p, 'pty-a1')
  check('eight tries later it gave up, having asked for no relay', [tabOf(p.guest, tab)?.state, p.hub.created.length], ['lost', 0])
  p.guest.remote.onOnline([p.B.id])
  await tick(30)
  check('a presence update that does not bring it back: nothing', p.hub.created.length, 0)
  p.guest.remote.onOnline([p.A.id, p.B.id])
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  check('it comes online: exactly one relay, and the tab is back without Try again', [p.hub.created.length, tabOf(p.guest, tab)?.state], [1, 'open'])
  check('its tries start again (a drop now waits one second, not a minute)', p.traces.filter((t) => t.e === 'relay-attached').map((t) => t.f.tries), [0])
  done(p)
}

console.log('\nF3: never a refused tab, nor one whose machine left the chain')
{
  const p = pair()
  p.host.sharing = false
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => tabOf(p.guest, tab)?.state === 'refused', 3000)
  const before = p.hub.created.length
  p.guest.remote.onOnline([p.B.id])
  p.guest.remote.onOnline([p.A.id, p.B.id])
  await tick(100)
  check('refused: it stays refused, and no relay is asked for', [tabOf(p.guest, tab)?.state, p.hub.created.length - before], ['refused', 0])
  done(p)
}
{
  const p = pair()
  const tab = loseTab(p, 'pty-a2')
  p.guest.active = [p.B]
  p.guest.remote.onOnline([p.A.id, p.B.id])
  await tick(100)
  check('a machine the chain no longer holds: it stays lost, no relay', [tabOf(p.guest, tab)?.state, p.hub.created.length], ['lost', 0])
  p.guest.active = [p.A, p.B]
  p.guest.out = true
  p.guest.remote.onOnline([p.B.id])
  p.guest.remote.onOnline([p.A.id, p.B.id])
  await tick(100)
  check('this computer out of the vault: nothing either', [p.hub.created.length, p.traces.filter((t) => t.e === 'relay-revive').length], [0, 0])
  done(p)
}

/* ================================ F4: the relay upgrade has a deadline */

console.log('\nF4: the relay upgrade deadline')
{
  const opts = relaySocketOptions({ 'x-test': '1' })
  check('the relay WebSocket is given 20 s for its upgrade, as presence is', [opts.handshakeTimeout, RELAY_HANDSHAKE_MS, opts.maxPayload, opts.headers], [20_000, 20_000, RELAY_MAX_FRAME_BYTES + 1024, { 'x-test': '1' }])
  const src = readFileSync(new URL('../src/main/hub/service.ts', import.meta.url), 'utf8')
  ok('openRelay builds its socket from those options', /new WebSocket\(url, relaySocketOptions\(headers\)\)/.test(src))
  // A server that takes the TCP connection and never answers the upgrade (an edge or tunnel that hangs).
  const held: Socket[] = []
  const server = createServer((s) => {
    held.push(s)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const url = `ws://127.0.0.1:${port}/v1/ws/relay/r0`
  const started = Date.now()
  const timed = new WebSocket(url, relaySocketOptions({}, 300))
  const outcome = await new Promise<{ err: string; ms: number }>((resolve) => {
    timed.on('error', (e: Error) => resolve({ err: e.message, ms: Date.now() - started }))
    setTimeout(() => resolve({ err: 'still waiting', ms: Date.now() - started }), 3000)
  })
  check('with the deadline: the hung upgrade fails, as the handshake timing out', outcome.err, 'Opening handshake has timed out')
  ok('and it fails at the deadline, not later', outcome.ms >= 250 && outcome.ms < 1500, String(outcome.ms))
  const control = new WebSocket(url, { ...relaySocketOptions({}), handshakeTimeout: undefined })
  control.on('error', () => undefined)
  await tick(1200)
  check('the control without it is still waiting', control.readyState, WebSocket.CONNECTING)
  control.terminate()
  timed.terminate()
  for (const s of held) s.destroy()
  await new Promise<void>((r) => server.close(() => r()))
}

console.log('\na close whose reason is longer than a close frame carries')
{
  // RFC 6455 gives a close frame's reason 123 bytes, and `ws` throws on more. The snapshot wait's reason names the
  // other machine, so a long or non-Latin device name passed it; the throw was swallowed and the socket was left
  // half-closed (CLOSING) under a channel that had already moved on to a fresh relay.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const heard = new Promise<{ code: number; reason: string }>((resolve) =>
    server.on('connection', (s) => s.on('close', (code: number, why: Buffer) => resolve({ code, reason: why.toString('utf8') })))
  )
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
  await new Promise<void>((resolve) => ws.once('open', () => resolve()))
  const me = generateDeviceKeys()
  let closedWith = ''
  const channel = new RelayChannel({
    role: 'guest',
    relay: idFromBytes('relay', randomU8(15)),
    account: idFromBytes('account', randomU8(10)),
    me: { id: idFromBytes('device', randomU8(10)), signPriv: me.signPriv },
    peer: idFromBytes('device', randomU8(10)),
    peerKey: () => null,
    io: { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
    events: { onOpen: () => undefined, onFrame: () => undefined, onClose: (reason) => (closedWith = reason) }
  })
  const name = '工作室'.repeat(5)
  const reason = `The chat on ${name} did not send its terminal screen. Other chats may still be available.`
  const shut = new Promise<void>((resolve) => ws.once('close', () => resolve()))
  channel.close(reason)
  const got = await Promise.race([Promise.all([heard, shut]).then(([h]) => h), tick(1500).then(() => null)])
  check(
    'the socket really closes, its reason cut to whole characters inside 123 bytes',
    [got?.code, got !== null && Buffer.byteLength(got.reason) <= 123, got?.reason.startsWith(`The chat on ${name}`), ws.readyState],
    [1000, true, true, WebSocket.CLOSED]
  )
  check('the channel still says the whole reason', closedWith, reason)
  const emoji = 'x' + '😀'.repeat(40)
  check(
    'the cut: a short reason whole, ASCII to 123 characters, an emoji never split',
    [closeFrameReason('host left'), closeFrameReason('a'.repeat(200)).length, Buffer.byteLength(closeFrameReason(emoji)), closeFrameReason(emoji) === emoji.slice(0, 61)],
    ['host left', 123, 121, true]
  )
  ws.terminate()
  for (const s of server.clients) s.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/* ======================================= F5: check every tab on wake */

console.log('\nF5: after a sleep, a dead link is found in seconds')
check('the wake check waits 10 s for its pong', RELAY_WAKE_PONG_MS, 10_000)
{
  const p = pair()
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  // The host's leg died asleep and says nothing: its frames never arrive.
  const relay = p.hub.relays.get(p.hub.created[0])
  if (relay) relay.host.mute = true
  p.guest.remote.wake(150)
  await until(() => p.traces.some((t) => t.e === 'relay-pong-timeout'), 1500)
  check('no pong inside the wait: the channel closes and the tab reconnects', [relay?.guest.readyState, tabOf(p.guest, tab)?.state, tabOf(p.guest, tab)?.message], [3, 'reconnecting', 'the other machine stopped answering'])
  check('said as the wake check', p.traces.find((t) => t.e === 'relay-pong-timeout')?.f.wake, true)
  await until(() => p.hub.created.length >= 2 && tabOf(p.guest, tab)?.state === 'open', 4000)
  check('and is back on a fresh relay', [p.hub.created.length, tabOf(p.guest, tab)?.state], [2, 'open'])
  done(p)
}
{
  const p = pair()
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  p.guest.remote.wake(150)
  await tick(450)
  check('a live link answers: left open, no new relay', [tabOf(p.guest, tab)?.state, p.hub.created.length, p.traces.some((t) => t.e === 'relay-pong-timeout')], ['open', 1, false])
  check('the round trip is logged', [p.traces.some((t) => t.e === 'relay-rtt'), p.traces.filter((t) => t.e === 'relay-wake').map((t) => t.f.open)], [true, [1]])
  done(p)
}

console.log('\nF5: a tab already owed a pong when the computer wakes')
/** Hold back what the host's leg sends (kept, in order: dropping a sealed frame would break the channel's sequence); `release` sends it. */
function holdHost(p: Pair): { release(): void } {
  const leg = p.hub.relays.get(p.hub.created[p.hub.created.length - 1])?.host
  if (!leg) return { release: () => undefined }
  const send = leg.send.bind(leg)
  const held: (string | Uint8Array)[] = []
  leg.send = (data) => void held.push(data)
  return {
    release: () => {
      leg.send = send
      for (const data of held.splice(0)) send(data)
    }
  }
}
{
  // The keepalive's ping went unanswered just before the sleep, its own wait (5 s here, 60 s for real) still
  // running: the wake asks again, and the SHORTER wait decides.
  const p = pair({ keepAlive: { pingMs: 60, pongWaitMs: 5000 } })
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  holdHost(p)
  await tick(150)
  const woke = Date.now()
  p.guest.remote.wake(200)
  await until(() => p.traces.some((t) => t.e === 'relay-pong-timeout'), 3000)
  const took = Date.now() - woke
  check('closed on the wake’s wait, not the keepalive’s', [p.hub.relays.get(p.hub.created[0])?.guest.readyState, p.traces.find((t) => t.e === 'relay-pong-timeout')?.f.wake], [3, true])
  ok('within the wake’s 200 ms, well before the keepalive’s 5 s', took < 1500, String(took))
  done(p)
}
{
  // The same owed ping, and this time the other machine answers: the keepalive's own wait must go with the
  // wake's ping, or, left running, it closes a link that has answered since.
  const p = pair({ keepAlive: { pingMs: 60, pongWaitMs: 500 } })
  const o = p.guest.remote.open(p.A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  await until(() => tabOf(p.guest, tab)?.state === 'open' && attachedCount(p.guest, tab) > 0, 3000)
  const hold = holdHost(p)
  await tick(150)
  p.guest.remote.wake(3000)
  hold.release()
  await tick(900)
  check(
    'answered: still open on its one relay after the keepalive’s old wait has passed',
    [tabOf(p.guest, tab)?.state, p.hub.created.length, p.traces.filter((t) => /relay-(close|pong-timeout)/.test(t.e)).map((t) => t.f.why ?? t.e)],
    ['open', 1, []]
  )
  done(p)
}
{
  const src = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8')
  ok('main checks the tabs on powerMonitor resume', /powerMonitor\.on\('resume'/.test(src('../src/main/connections.ts')) && /installHubWake\(\(\) => hubClient\?\.wake\(\)\)/.test(src('../src/main/index.ts')))
  ok('the hub service hands it to Other machines', /wake\(\): void \{\s*this\.remote\?\.wake\(\)/.test(src('../src/main/hub/service.ts')))
}

console.log(`\n${passes} passed, ${failures} failed`)
await tick(0)
process.exitCode = failures ? 1 : 0
