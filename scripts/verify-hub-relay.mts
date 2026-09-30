/*
 * "Other machines": remote between the owner's own signed-in devices through
 * the hub (spec §6), everything but the sockets to a real hub and a real pty.
 *
 *   node scripts/verify-hub-relay.mts
 *
 * - The CHANNEL (src/main/hub/channel.ts): two ends talking through an
 *   in-memory relay that plays the hub — forwarding, and also dropping,
 *   repeating, reordering, reflecting and rewriting frames, swapping keys,
 *   naming the wrong device. Every one of those must close the channel.
 * - The STATUS a device seals for the others (crypto.ts `sealStatus`,
 *   remote.ts): relabelled, re-epoched or edited, it does not open; what
 *   does open is cut to size.
 * - The HOST's RULES (remote.ts `attachDecision`, `relayScopeVerdict`, the
 *   "Allow once" grace).
 * - Two `HubRemote`s wired through a fake hub, a fake pty on the host: list,
 *   ask, Allow once / Always / Deny, type and see the echo, a guest that
 *   reaches outside what it was allowed, a canary the relay must never see.
 *
 * Every input is synthetic (gotcha 74): keys, ids, clocks, sessions. Nothing
 * reaches the network, no agent CLI runs, and nothing in ~ is read. Imports
 * are relative with `.ts` (gotcha 78).
 */
import { RelayChannel, type ChannelIO } from '../src/main/hub/channel.ts'
import {
  generateDeviceKeys,
  openStatus,
  presenceKey,
  randomU8,
  relayAnswer,
  relayEphemeral,
  sealStatus,
  type DeviceKeys
} from '../src/main/hub/crypto.ts'
import { HubRemote, type RelaySocket, type RemoteContext } from '../src/main/hub/remote.ts'
import { VirtualSocket } from '../src/main/remote/socket.ts'
import { b64uDecode, b64uEncode, idFromBytes } from '../src/shared/hub/codec.ts'
import { HUB_LABELS } from '../src/shared/hub/labels.ts'
import { parsePresenceClientFrame, parsePresenceServerFrame, sealedStatusProblem, type PresenceClientFrame, type SealedStatus } from '../src/shared/hub/protocol.ts'
import {
  attachDecision,
  holdOnce,
  onceHolds,
  ONCE_GRACE_MS,
  otherMachines,
  parseRemoteStatus,
  pruneOnce,
  relayScopeVerdict,
  releaseOnce,
  remoteStatusFrom,
  REMOTE_MAX_SESSIONS,
  type HubRemoteView,
  type RemoteRowLike,
  type RemoteTabFrame
} from '../src/shared/hub/remote.ts'
import {
  parseRelayInner,
  RELAY_CHUNK_CHARS,
  RELAY_MAX_FRAME_BYTES,
  relayFrameParts,
  type HubGrant,
  type RelayHs1,
  type RelayInnerFrame
} from '../src/shared/hub/relay.ts'

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
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) return undefined
    await tick(10)
  }
}

const ACCOUNT = idFromBytes('account', randomU8(10))
interface Dev {
  id: string
  label: string
  platform: string
  keys: DeviceKeys
}
const dev = (label: string, platform = 'darwin'): Dev => ({ id: idFromBytes('device', randomU8(10)), label, platform, keys: generateDeviceKeys() })
const A = dev('Studio', 'darwin')
const B = dev('Laptop', 'win32')
const X = dev('Removed', 'linux')
/** The chain every honest device verified: A and B active, X not. */
const ACTIVE = [A, B]
const keyOf = (id: string): string | null => ACTIVE.find((d) => d.id === id)?.keys.signPub ?? null
const CANARY = 'canary-7f3a9-do-not-log'

/* ============================================================ the channel */

type Wire = { data: string | Uint8Array; binary: boolean }
interface Pair {
  guest: RelayChannel
  host: RelayChannel
  g2h: Wire[]
  h2g: Wire[]
  gFrames: RelayInnerFrame[]
  hFrames: RelayInnerFrame[]
  gClosed: string | null
  hClosed: string | null
  gOpen: boolean
  hOpen: boolean
  /** Deliver everything queued each way (through `tamper`, which may rewrite, repeat or drop). */
  flush(): void
}

function pair(o: {
  relay?: string
  hostRelay?: string
  guestAs?: Dev
  hubNames?: string
  hostKeyOf?: (id: string) => string | null
  guestKeyOf?: (id: string) => string | null
  tamper?: (dir: 'g2h' | 'h2g', w: Wire, n: number) => Wire[]
} = {}): Pair {
  const relay = o.relay ?? idFromBytes('relay', randomU8(15))
  const gDev = o.guestAs ?? B
  const p = { g2h: [] as Wire[], h2g: [] as Wire[], gFrames: [] as RelayInnerFrame[], hFrames: [] as RelayInnerFrame[], gClosed: null as string | null, hClosed: null as string | null, gOpen: false, hOpen: false } as Pair
  const counts = { g2h: 0, h2g: 0 }
  const io = (dir: 'g2h' | 'h2g'): ChannelIO => ({
    send: (data) => (dir === 'g2h' ? p.g2h : p.h2g).push({ data, binary: typeof data !== 'string' }),
    close: () => {}
  })
  p.guest = new RelayChannel({
    role: 'guest',
    relay,
    account: ACCOUNT,
    me: { id: gDev.id, signPriv: gDev.keys.signPriv },
    peer: A.id,
    peerKey: o.guestKeyOf ?? keyOf,
    io: io('g2h'),
    events: { onOpen: () => (p.gOpen = true), onFrame: (f) => p.gFrames.push(f), onClose: (r) => (p.gClosed = r) }
  })
  p.host = new RelayChannel({
    role: 'host',
    relay: o.hostRelay ?? relay,
    account: ACCOUNT,
    me: { id: A.id, signPriv: A.keys.signPriv },
    peer: o.hubNames ?? gDev.id,
    peerKey: o.hostKeyOf ?? keyOf,
    io: io('h2g'),
    events: { onOpen: () => (p.hOpen = true), onFrame: (f) => p.hFrames.push(f), onClose: (r) => (p.hClosed = r) }
  })
  p.flush = () => {
    for (let guard = 0; guard < 1000 && (p.g2h.length || p.h2g.length); guard++) {
      for (const dir of ['g2h', 'h2g'] as const) {
        const q = dir === 'g2h' ? p.g2h : p.h2g
        const w = q.shift()
        if (!w) continue
        const out = o.tamper ? o.tamper(dir, w, counts[dir]++) : [w]
        for (const x of out) (dir === 'g2h' ? p.host : p.guest).receive(x.data, x.binary)
      }
    }
  }
  p.host.start()
  p.guest.start()
  p.flush()
  return p
}

const text = (w: Wire): string => (typeof w.data === 'string' ? w.data : Buffer.from(w.data).toString('latin1'))

console.log('\nthe channel: key agreement and framing')
{
  const seen: Wire[] = []
  const p = pair({ tamper: (_d, w) => (seen.push(w), [w]) })
  check('both ends verify the handshake and open', [p.gOpen, p.hOpen, p.gClosed, p.hClosed], [true, true, null, null])
  p.guest.send({ t: 'attach', ptyId: 'pty-1' })
  p.guest.send({ t: 'ws-msg', id: 1, data: JSON.stringify({ type: 'input', data: `echo ${CANARY}\r` }) })
  p.host.send({ t: 'ready', mode: 'full', host: { label: 'Studio', platform: 'darwin' } })
  p.flush()
  check('guest → host frames arrive in order', p.hFrames.map((f) => f.t), ['attach', 'ws-msg'])
  check('host → guest frames arrive', p.gFrames.map((f) => f.t), ['ready'])
  check('the typed text arrives whole', (p.hFrames[1] as { data: string }).data, JSON.stringify({ type: 'input', data: `echo ${CANARY}\r` }))
  const binary = seen.filter((w) => w.binary)
  ok('after the handshake every frame is binary', binary.length === 3 && seen.filter((w) => !w.binary).length === 3, `${seen.length} frames`)
  ok('the relay never sees the canary, in any frame', !seen.some((w) => text(w).includes(CANARY) || Buffer.from(typeof w.data === 'string' ? w.data : w.data).includes(Buffer.from(CANARY))))
  ok('nor a frame label, the ptyId or a JSON key in the clear after the handshake', !binary.some((w) => /pty-1|attach|ws-msg|"t"/.test(text(w))))

  // A replay of 512 K characters of scrollback, JSON inside JSON: past one frame, so cut and joined.
  const history = `\u001b[1m${'x'.repeat(300_000)}\u001b[0m${'é'.repeat(200_000)}"quoted"\\ ${'😀'.repeat(40_000)}`
  const big = JSON.stringify({ type: 'attached', ptyId: 'pty-1', history })
  const before = p.h2g.length
  p.host.send({ t: 'ws-msg', id: 1, data: big })
  const parts = p.h2g.slice(before)
  ok('a frame past one part goes as several', parts.length > 1, `${parts.length} parts`)
  ok(`every part is under the hub’s ${RELAY_MAX_FRAME_BYTES} byte cap`, parts.every((w) => (w.data as Uint8Array).length <= RELAY_MAX_FRAME_BYTES), parts.map((w) => (w.data as Uint8Array).length).join(','))
  p.flush()
  const joined = p.gFrames[p.gFrames.length - 1] as { t: string; data: string }
  check('and it arrives joined, byte for byte (escapes, accents, emoji)', [joined.t, joined.data === big], ['ws-msg', true])
  check('a small frame is one part', relayFrameParts('{"t":"ping"}').length, 1)
  const cut = relayFrameParts('x'.repeat(RELAY_CHUNK_CHARS * 2 + 5))
  check('a large one is parts, all but the last saying more', cut.map((c) => (JSON.parse(c) as { more?: boolean }).more ?? false), [true, true, false])
  check('a part never holds a part', parseRelayInner(JSON.stringify({ t: 'part', data: '{"t":"part","data":"x"}' }))?.t, 'part')
}

console.log('\nthe channel: order, replay, and tampering all close it')
{
  const drop = pair({ tamper: (d, w, n) => (d === 'g2h' && n === 2 ? [] : [w]) })
  drop.guest.send({ t: 'ping' })
  drop.guest.send({ t: 'pong' })
  drop.flush()
  check('a dropped frame: the next one does not open, and the host closes', [drop.hFrames.length, !!drop.hClosed], [0, true])
  ok('with a reason that says so', /did not open/.test(drop.hClosed ?? ''), drop.hClosed ?? '')

  const replay = pair({ tamper: (d, w, n) => (d === 'g2h' && n === 2 ? [w, w] : [w]) })
  replay.guest.send({ t: 'ping' })
  replay.flush()
  check('a repeated frame is refused after the first', [replay.hFrames.length, !!replay.hClosed], [1, true])

  let held: Wire | null = null
  const reorder = pair({
    tamper: (d, w, n) => {
      if (d !== 'g2h' || n < 2) return [w]
      if (n === 2) {
        held = w
        return []
      }
      return held ? [w, held] : [w]
    }
  })
  reorder.guest.send({ t: 'ping' })
  reorder.guest.send({ t: 'pong' })
  reorder.flush()
  check('two frames swapped: refused at the first', [reorder.hFrames.length, !!reorder.hClosed], [0, true])

  const flip = pair({
    tamper: (d, w, n) => {
      if (d !== 'g2h' || n !== 2) return [w]
      const b = new Uint8Array(w.data as Uint8Array)
      b[5] ^= 1
      return [{ data: b, binary: true }]
    }
  })
  flip.guest.send({ t: 'ping' })
  flip.flush()
  check('one flipped bit: refused', [flip.hFrames.length, !!flip.hClosed], [0, true])

  const reflect = pair()
  reflect.host.send({ t: 'ping' })
  const own = reflect.h2g.shift() as Wire
  reflect.host.receive(own.data, true)
  check('a host frame sent back to the host (reflected) does not open', [reflect.hFrames.length, !!reflect.hClosed], [0, true])

  const other = pair()
  const second = pair()
  second.guest.send({ t: 'ping' })
  const foreign = second.g2h.shift() as Wire
  other.host.receive(foreign.data, true)
  check('a frame from ANOTHER relay does not open', [other.hFrames.length, !!other.hClosed], [0, true])

  const plain = pair()
  plain.host.receive(JSON.stringify({ t: 'ping' }), false)
  check('a text frame after the handshake closes the channel', !!plain.hClosed, true)
  const early = pair({ tamper: (d, w, n) => (d === 'g2h' && n === 0 ? [{ data: new Uint8Array(40), binary: true }] : [w]) })
  check('bytes before the handshake close it', [!!early.hClosed, early.hOpen], [true, false])
  const notFrame = pair()
  // A well-sealed frame whose plaintext is not a relay frame: made with the guest's own cipher, by sending a raw value.
  notFrame.guest.send({ t: 'nonsense' } as unknown as RelayInnerFrame)
  notFrame.flush()
  check('a sealed frame that is not a relay frame closes it', [notFrame.hFrames.length, !!notFrame.hClosed], [0, true])
  ok('and a closed channel sends nothing more', notFrame.host.send({ t: 'ping' }) === false)
}

console.log('\nthe channel: only the devices the chain vouches for')
{
  const named = pair({ hubNames: X.id })
  check('the hub names one guest and another answers: refused', [named.hOpen, named.hClosed], [false, 'the guest is not the device the hub named'])

  const removed = pair({ guestAs: X, hubNames: X.id })
  check('a device the chain does not hold as active is refused by the host', [removed.hOpen, removed.hClosed], [false, 'that device is not in this computer’s verified device list'])

  // An impostor claims B's id but can only sign with its own key: the host checks hs3 against B's.
  const impostor = pair({ guestAs: { ...X, id: B.id }, guestKeyOf: keyOf })
  check('a guest claiming another device’s id, signing with its own key: refused', [impostor.hOpen, impostor.hClosed], [false, 'the guest did not sign this handshake with its own key'])

  // The hub swaps the host's ephemeral key (a man in the middle): the guest checks hs2 against A's key.
  const mitm = relayEphemeral()
  const swapped = pair({
    tamper: (d, w) => {
      if (d !== 'h2g' || w.binary) return [w]
      const hs2 = JSON.parse(w.data as string)
      return [{ data: JSON.stringify({ ...hs2, eph: mitm.pub }), binary: false }]
    }
  })
  check('a relay that swaps the host’s ephemeral key: the guest refuses', [swapped.gOpen, swapped.gClosed], [false, 'the host did not sign this handshake'])

  // A hub that answers the guest as the host, with a key of its own.
  const hubKeys = generateDeviceKeys()
  let seenHs1: RelayHs1 | null = null
  const fake = pair({
    tamper: (d, w) => {
      if (w.binary) return [w]
      const v = JSON.parse(w.data as string) as { t: string }
      if (d === 'g2h' && v.t === 'hs1') seenHs1 = v as RelayHs1
      if (d === 'h2g' && v.t === 'hs2' && seenHs1) return [{ data: JSON.stringify(relayAnswer(seenHs1, relayEphemeral(), hubKeys.signPriv).hs2), binary: false }]
      return [w]
    }
  })
  check('a hub answering as the host with its own key: the guest refuses', [fake.gOpen, fake.gClosed], [false, 'the host did not sign this handshake'])
  const honest = pair()
  ok('(control: an honest pair opens)', honest.gOpen && honest.hOpen)

  const noKey = pair({ guestKeyOf: () => null })
  check('a guest whose chain no longer holds the host does not even start', [noKey.gOpen, noKey.gClosed], [false, 'That machine is not in your verified device list any more.'])

  const otherRelay = pair({ hostRelay: idFromBytes('relay', randomU8(15)) })
  check('an hs1 for another relay is refused', otherRelay.hClosed, 'another relay')
}

/* ============================================================ the status */

console.log('\nthe status: sealed for the vault, opened only as what it is')
{
  const vk = randomU8(32)
  const k1 = presenceKey(vk, ACCOUNT, 1)
  const k2 = presenceKey(vk, ACCOUNT, 2)
  const rows: RemoteRowLike[] = [
    { ptyId: 'pty-1', project: 'stoke', title: 'Fix the relay', status: 'busy', agentName: 'Claude Code', exited: false, lastActivityAt: 5, context: { contextTokens: 41_000, contextLimit: 200_000, ready: true } },
    { ptyId: 'pty-2', project: 'gone', title: null, status: 'ended', agentName: 'Claude Code', exited: true, lastActivityAt: 1, context: null }
  ]
  const status = remoteStatusFrom({ at: 1000, name: 'Studio', platform: 'darwin', open: true, rows })
  check('a status lists the live sessions only, with no path', status.sessions.map((s) => [s.ptyId, s.project, s.title, s.context]), [['pty-1', 'stoke', 'Fix the relay', { used: 41000, limit: 200000 }]])
  check('not sharing: the status names the machine and no session', remoteStatusFrom({ at: 1, name: 'Studio', platform: 'darwin', open: false, rows }).sessions, [])
  const f = { account: ACCOUNT, epoch: 1, device: A.id }
  const sealed = sealStatus(k1, f, JSON.stringify(status))
  check('the envelope is what the hub may forward', sealedStatusProblem(sealed), null)
  ok('and holds nothing readable', !JSON.stringify(sealed).includes('stoke') && !JSON.stringify(sealed).includes('Fix'))
  const opened = openStatus(k1, f, sealed)
  check('it opens for a device of the vault', parseRemoteStatus(opened ?? '')?.sessions[0]?.title, 'Fix the relay')
  check('relabelled as another device’s: does not open', openStatus(k1, { ...f, device: B.id }, sealed), null)
  check('under another epoch’s key: does not open', openStatus(k2, f, sealed), null)
  check('with its epoch field edited: does not open', openStatus(k1, f, { ...sealed, epoch: 2 }), null)
  check('for another account: does not open', openStatus(k1, { ...f, account: idFromBytes('account', randomU8(10)) }, sealed), null)
  const ct = b64uDecode(sealed.ct) as Uint8Array
  ct[0] ^= 1
  check('one flipped bit: does not open', openStatus(k1, f, { ...sealed, ct: b64uEncode(ct) }), null)
  check('an envelope with an extra field is not one', sealedStatusProblem({ ...sealed, device: A.id }), 'unknown fields')
  check('an oversize one is not one', sealedStatusProblem({ ...sealed, ct: 'A'.repeat(30_000) }), 'too large')
  check('the hub parses a client status frame only when it is well formed', [parsePresenceClientFrame({ t: 'status', status: sealed })?.t, parsePresenceClientFrame({ t: 'status', status: { v: 1 } }), parsePresenceClientFrame({ t: 'status', status: null })?.t], ['status', null, 'status'])
  check('and a device parses the hub’s forward', parsePresenceServerFrame(JSON.stringify({ t: 'status', device: A.id, status: sealed }))?.t, 'status')
  check('presence labels are their own', [HUB_LABELS.presenceKey, HUB_LABELS.presenceStatus], ['stoke-hub/v1/presence-key', 'stoke-hub/v1/presence-status'])
  const hostile = JSON.stringify({
    v: 1,
    at: 7,
    name: 'Stu\u001b]0;pwn\u0007dio\n',
    platform: 'darwin',
    open: true,
    sessions: [
      ...Array.from({ length: 40 }, (_, i) => ({ ptyId: `p${i}`, project: 'x'.repeat(500), title: 't', status: 'busy', agent: 'a', context: null, lastActivityAt: 1 })),
      { ptyId: '../../etc', project: 'x' }
    ]
  })
  const parsed = parseRemoteStatus(hostile)
  check('another machine’s text is cut to size and stripped of control characters', [parsed?.name, parsed?.sessions.length, parsed?.sessions[0].project.length], ['Stu ]0;pwn dio', REMOTE_MAX_SESSIONS, 80])
  check('a status that says closed lists nothing, whatever it carries', parseRemoteStatus(JSON.stringify({ v: 1, at: 1, name: 'n', platform: 'p', open: false, sessions: [{ ptyId: 'p1' }] }))?.sessions, [])
  check('not a status at all: null', [parseRemoteStatus('{}'), parseRemoteStatus('nope')], [null, null])
  const list = otherMachines({
    me: A.id,
    active: [
      { id: A.id, label: 'Studio', platform: 'darwin' },
      { id: B.id, label: 'Laptop', platform: 'win32' }
    ],
    online: [A.id, B.id, X.id],
    statuses: { [B.id]: { ...status, name: 'Laptop' }, [X.id]: status }
  })
  check('the list: other active devices that are online, never this one, never a removed one', list.map((m) => [m.id === B.id, m.label, m.status?.sessions.length]), [[true, 'Laptop', 1]])
  // A pinned vector: a changed label or AAD layout fails here before two devices of different builds stop reading each other.
  const vector = sealStatus(presenceKey(new Uint8Array(32).fill(7), 'a0000000000000000', 3), { account: 'a0000000000000000', epoch: 3, device: 'd0000000000000000' }, '{"v":1}', new Uint8Array(12).fill(9))
  check('vector: a sealed status', vector.ct, 'WtmASJrpXxraP99BmiFGLrrQElTJbaA')
}

/* ============================================================ the host's rules */

console.log('\nthe host’s rules: refuse, serve, or ask')
{
  const base = { sharing: true, grant: null as HubGrant | null, once: [], device: B.id, ptyId: 'pty-1', session: { exists: true, exited: false }, hostName: 'Studio', now: 1000 }
  check('not sharing: refused, whatever was granted', attachDecision({ ...base, sharing: false, grant: { mode: 'full', label: 'Laptop', at: 1 } }).t, 'refuse')
  check('no such session: refused', attachDecision({ ...base, session: { exists: false, exited: false } }).t, 'refuse')
  check('an ended session: refused', attachDecision({ ...base, session: { exists: true, exited: true } }).t, 'refuse')
  check('an Always grant: served in its mode', attachDecision({ ...base, grant: { mode: 'view', label: 'Laptop', at: 1 } }), { t: 'allow', mode: 'view', via: 'always' })
  check('nothing yet: ask', attachDecision(base).t, 'ask')
  let once = holdOnce([], B.id, 'pty-1')
  check('an Allow once held by a relay: served, for that session', attachDecision({ ...base, once }), { t: 'allow', mode: 'full', via: 'once' })
  check('but not for another session', attachDecision({ ...base, once, ptyId: 'pty-2' }).t, 'ask')
  check('nor for another device', attachDecision({ ...base, once, device: X.id }).t, 'ask')
  once = releaseOnce(once, B.id, 'pty-1', 1000)
  check('released, it lasts the grace for a reattach', [onceHolds(once, B.id, 'pty-1', 1000 + ONCE_GRACE_MS - 1), onceHolds(once, B.id, 'pty-1', 1000 + ONCE_GRACE_MS)], [true, false])
  check('then it is pruned, and the next attach asks again', [pruneOnce(once, 1000 + ONCE_GRACE_MS).length, attachDecision({ ...base, once, now: 1000 + ONCE_GRACE_MS }).t], [0, 'ask'])
  check('a malformed device or pty id is refused before anything', [attachDecision({ ...base, device: 'nope' }).t, attachDecision({ ...base, ptyId: '../x' }).t], ['refuse', 'refuse'])

  const one = { kind: 'session', ptyId: 'pty-1' } as const
  const v = (f: RelayInnerFrame): string => {
    const r = relayScopeVerdict(one, f)
    return r.ok ? 'ok' : 'no'
  }
  check('Allow once: that session’s pty socket', v({ t: 'ws-open', id: 1, path: '/ws?ptyId=pty-1' }), 'ok')
  check('and a peek of it', v({ t: 'ws-open', id: 1, path: '/ws?ptyId=pty-1&peek=1' }), 'ok')
  check('not another session’s', v({ t: 'ws-open', id: 1, path: '/ws?ptyId=pty-2' }), 'no')
  check('not the events socket', v({ t: 'ws-open', id: 1, path: '/ws/events' }), 'no')
  check('its own prompt’s answer', v({ t: 'req', id: 1, method: 'POST', path: '/api/sessions/pty-1/answer' }), 'ok')
  check('not another’s', v({ t: 'req', id: 1, method: 'POST', path: '/api/sessions/pty-2/answer' }), 'no')
  check('the host’s name and theme', [v({ t: 'req', id: 1, method: 'GET', path: '/api/host' }), v({ t: 'req', id: 1, method: 'GET', path: '/api/theme' })], ['ok', 'ok'])
  check('not the session list (paths), transcripts, history, folders or a new session', ['/api/sessions', '/api/transcript?id=x', '/api/history?cwd=/', '/api/folders', '/api/projects'].map((p) => v({ t: 'req', id: 1, method: 'GET', path: p })).concat(v({ t: 'req', id: 1, method: 'POST', path: '/api/sessions' })), ['no', 'no', 'no', 'no', 'no', 'no'])
  check('Always reaches every relayed route', relayScopeVerdict({ kind: 'any' }, { t: 'req', id: 1, method: 'GET', path: '/api/transcript?id=x' }).ok, true)
}

/* ============================================================ two machines */

console.log('\ntwo machines through a fake hub: list, ask, type, see it echo')

/** A fake hub: relays pair two sockets and forward verbatim; every byte is kept to search for the canary. */
const hubBytes: Buffer[] = []
class FakeSocket implements RelaySocket {
  readyState = 0
  peer: FakeSocket | null = null
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
  private pending: [Uint8Array | string, boolean][] = []
  on(event: string, fn: (...a: never[]) => void): unknown {
    ;(this.handlers[event] ??= []).push(fn as (...a: unknown[]) => void)
    return this
  }
  fire(event: string, ...a: unknown[]): void {
    for (const fn of this.handlers[event] ?? []) fn(...a)
  }
  open(): void {
    this.readyState = 1
    this.fire('open')
    for (const [d, b] of this.pending.splice(0)) this.fire('message', d, b)
  }
  send(data: string | Uint8Array): void {
    const binary = typeof data !== 'string'
    hubBytes.push(Buffer.from(typeof data === 'string' ? data : data))
    const p = this.peer
    const copy = typeof data === 'string' ? data : Buffer.from(data)
    setTimeout(() => {
      if (!p || p.readyState === 3) return
      if (p.readyState !== 1) p.pending.push([copy, binary])
      else p.fire('message', copy, binary)
    }, 0)
  }
  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.fire('close', code)
    const p = this.peer
    if (p && p.readyState !== 3) setTimeout(() => p.close(code), 0)
  }
}

let clock = 1_000_000
const relays = new Map<string, { guest: FakeSocket; host: FakeSocket; hostDevice: string; guestDevice: string }>()
const presence: { from: string; frame: PresenceClientFrame }[] = []
interface Machine {
  dev: Dev
  remote: HubRemote
  sharing: boolean
  grants: Record<string, HubGrant>
  views: HubRemoteView[]
  frames: { tab: string; frame: RemoteTabFrame }[]
  ptyInput: string[]
  sockets: VirtualSocket[]
  requests: string[]
  sessions: RemoteRowLike[]
}
const machines = new Map<string, Machine>()
const vkShared = randomU8(32)

function machine(d: Dev): Machine {
  const m = { dev: d, sharing: false, grants: {}, views: [], frames: [], ptyInput: [], sockets: [], requests: [], sessions: [] } as unknown as Machine
  const ctx = (): RemoteContext => ({
    account: ACCOUNT,
    epoch: 1,
    me: { id: d.id, label: d.label, platform: d.platform, signPriv: d.keys.signPriv },
    active: ACTIVE.map((a) => ({ id: a.id, label: a.label, platform: a.platform, sign: a.keys.signPub }))
  })
  m.remote = new HubRemote({
    now: () => clock,
    context: ctx,
    presenceKey: async (epoch) => presenceKey(vkShared, ACCOUNT, epoch),
    sendPresence: (frame) => {
      presence.push({ from: d.id, frame })
      if (frame.t === 'status') for (const [id, other] of machines) if (id !== d.id) void other.remote.onStatus(d.id, frame.status as SealedStatus)
      return true
    },
    createRelay: async (host) => {
      const relay = idFromBytes('relay', randomU8(15))
      const guest = new FakeSocket()
      const hostSock = new FakeSocket()
      guest.peer = hostSock
      hostSock.peer = guest
      relays.set(relay, { guest, host: hostSock, hostDevice: host, guestDevice: d.id })
      const target = machines.get(host)
      setTimeout(() => void target?.remote.onRelay(relay, d.id), 0)
      return { relay }
    },
    openRelay: async (relay) => {
      const r = relays.get(relay)
      if (!r) throw new Error('no relay')
      const s = r.guestDevice === d.id ? r.guest : r.host
      setTimeout(() => s.open(), 0)
      return s
    },
    sharing: () => m.sharing,
    grants: () => m.grants,
    setGrant: async (device, grant) => {
      if (grant) m.grants = { ...m.grants, [device]: grant }
      else {
        const next = { ...m.grants }
        delete next[device]
        m.grants = next
      }
    },
    log: () => {},
    sessions: async () => m.sessions,
    request: async (method, path) => {
      m.requests.push(`${method} ${path}`)
      return { status: 200, body: { machine: d.label } }
    },
    socket: (path, sock) => {
      // A fake pty behind the phone socket: the attach replay, then an echo of whatever is typed.
      m.sockets.push(sock as VirtualSocket)
      const ptyId = new URLSearchParams(path.split('?')[1] ?? '').get('ptyId')
      sock.send(JSON.stringify({ type: 'attached', ptyId, cols: 100, rows: 30, desktopCols: 100, desktopRows: 30, status: 'idle', history: 'stub$ ' }))
      sock.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; data?: string }
        if (msg.type === 'input' && msg.data) {
          m.ptyInput.push(msg.data)
          sock.send(JSON.stringify({ type: 'data', ptyId, data: msg.data.replace('\r', '\r\n') }))
        }
      })
    },
    emit: (view) => m.views.push(view),
    frame: (tab, frame) => m.frames.push({ tab, frame })
  })
  machines.set(d.id, m)
  return m
}

const hostA = machine(A)
const guestB = machine(B)
const last = (m: Machine): HubRemoteView => m.remote.view()
hostA.sessions = [{ ptyId: 'pty-a1', project: 'stoke', title: 'Stub session', status: 'idle', agentName: 'Claude Code', exited: false, lastActivityAt: clock, context: null }]

{
  hostA.remote.onOnline([A.id, B.id])
  guestB.remote.onOnline([A.id, B.id])
  hostA.remote.presenceOpened()
  guestB.remote.presenceOpened()
  await until(() => last(guestB).machines[0]?.status)
  check('with sharing off, B sees A online with no sessions', last(guestB).machines.map((m) => [m.label, m.status?.open, m.status?.sessions.length]), [['Studio', false, 0]])
  hostA.sharing = true
  hostA.remote.sharingChanged()
  await until(() => last(guestB).machines[0]?.status?.open)
  check('A ticks the box: B sees its session (project, title, status), no path', last(guestB).machines[0]?.status?.sessions.map((s) => [s.ptyId, s.project, s.title, s.status]), [['pty-a1', 'stoke', 'Stub session', 'idle']])
  const sentStatus = presence.filter((p) => p.frame.t === 'status')
  ok('what went over presence was sealed: no title, no project in it', sentStatus.length > 0 && sentStatus.every((p) => !JSON.stringify(p.frame).includes('Stub session') && !JSON.stringify(p.frame).includes('stoke')))
  const firstFromA = sentStatus.find((p) => p.from === A.id)?.frame as { status: SealedStatus } | undefined
  await guestB.remote.onStatus(A.id, firstFromA?.status ?? null)
  check('a hub replaying A’s older status (sharing off) changes nothing', last(guestB).machines[0]?.status?.sessions.length, 1)
  await guestB.remote.onStatus(B.id, firstFromA?.status ?? null)
  await guestB.remote.onStatus(X.id, firstFromA?.status ?? null)
  check('nor does A’s status handed over as B’s own, or as a removed device’s', last(guestB).machines.map((m) => m.label), ['Studio'])
  const beforeRepeat = presence.length
  await hostA.remote.publish()
  check('an unchanged status is not sent again', presence.length, beforeRepeat)

  // B opens A's session: A asks.
  const opened = guestB.remote.open(A.id, 'pty-a1')
  ok('B opens a remote tab', opened.ok)
  const tabId = opened.ok ? opened.tab : ''
  const ask = await until(() => last(hostA).asks[0])
  check('A asks its owner, naming the device, the session and a key fingerprint', [ask?.label, ask?.title, ask?.fingerprint.split(' ').length], ['Laptop', 'Stub session', 4])
  await until(() => last(guestB).tabs[0]?.state === 'asking')
  check('B says it is waiting for A to allow it', last(guestB).tabs[0]?.state, 'asking')
  check('nothing is served before the answer', [hostA.sockets.length, hostA.requests.length], [0, 0])
  await hostA.remote.answer(ask!.id, 'once')
  await until(() => last(guestB).tabs[0]?.state === 'open')
  check('Allow once: B’s tab opens', last(guestB).tabs[0]?.state, 'open')
  await until(() => guestB.frames.some((f) => f.frame.type === 'attached'))
  check('B gets the pty’s attach replay', guestB.frames.find((f) => f.frame.type === 'attached')?.frame.history, 'stub$ ')
  check('A shows B attached to that session', last(hostA).guests.map((g) => [g.label, g.title, g.via]), [['Laptop', 'Stub session', 'once']])
  check('Allow once saved no grant', Object.keys(hostA.grants), [])
  guestB.remote.input(tabId, `echo ${CANARY}\r`)
  await until(() => guestB.frames.some((f) => f.frame.type === 'data'))
  check('B types; A’s pty gets it', hostA.ptyInput, [`echo ${CANARY}\r`])
  check('and B sees the echo', guestB.frames.find((f) => f.frame.type === 'data')?.frame.data, `echo ${CANARY}\r\n`)
  ok('the hub carried none of it in the clear', !hubBytes.some((b) => b.includes(Buffer.from(CANARY))) && !hubBytes.some((b) => b.includes(Buffer.from('Stub session'))), `${hubBytes.length} frames`)

  // B closes the tab: A's socket goes, the once lasts the grace.
  guestB.remote.close(tabId)
  await until(() => last(hostA).guests.length === 0)
  check('B closes the tab: A’s indicator goes', last(hostA).guests.length, 0)
  ok('and A’s relayed pty socket is closed, as when a phone leaves', hostA.sockets.every((s) => s.readyState === 3))
  const again = guestB.remote.open(A.id, 'pty-a1')
  await until(() => last(guestB).tabs[0]?.state === 'open')
  check('reopened inside the grace: served without asking again', [last(guestB).tabs[0]?.state, last(hostA).asks.length], ['open', 0])
  if (again.ok) guestB.remote.close(again.tab)
  await until(() => last(hostA).guests.length === 0)
  clock += ONCE_GRACE_MS + 1
  const third = guestB.remote.open(A.id, 'pty-a1')
  const ask2 = await until(() => last(hostA).asks[0])
  ok('after the grace, Allow once has lapsed: A asks again', !!ask2)
  await hostA.remote.answer(ask2!.id, 'deny')
  await until(() => last(guestB).tabs[0]?.state === 'refused')
  check('Deny: B’s tab says refused, with A’s reason', [last(guestB).tabs[0]?.state, /said no/.test(last(guestB).tabs[0]?.message ?? '')], ['refused', true])
  if (third.ok) guestB.remote.close(third.tab)

  // Always: saved on A, and the next open is not asked.
  const fourth = guestB.remote.open(A.id, 'pty-a1')
  const ask3 = await until(() => last(hostA).asks[0])
  await hostA.remote.answer(ask3!.id, 'always')
  await until(() => last(guestB).tabs[0]?.state === 'open')
  check('Always: served, and the grant is kept on A (only)', [last(guestB).tabs[0]?.state, Object.keys(hostA.grants), Object.keys(guestB.grants)], ['open', [B.id], []])
  check('Account & sync lists it', last(hostA).grants.map((g) => [g.label, g.mode]), [['Laptop', 'full']])
  await hostA.remote.revokeGrant(B.id)
  await until(() => last(guestB).tabs[0]?.state === 'refused')
  check('revoking it drops B at once', [last(guestB).tabs[0]?.state, Object.keys(hostA.grants)], ['refused', []])
  if (fourth.ok) guestB.remote.close(fourth.tab)

  // Disconnect, and sharing off.
  const fifth = guestB.remote.open(A.id, 'pty-a1')
  const ask4 = await until(() => last(hostA).asks[0])
  await hostA.remote.answer(ask4!.id, 'once')
  await until(() => last(guestB).tabs[0]?.state === 'open')
  hostA.remote.dropGuests()
  await until(() => last(guestB).tabs[0]?.state === 'refused')
  check('Disconnect on A: B is told, and not reconnected behind the owner’s back', [last(guestB).tabs[0]?.state, last(hostA).guests.length], ['refused', 0])
  if (fifth.ok) guestB.remote.close(fifth.tab)
  hostA.sharing = false
  hostA.remote.sharingChanged()
  const sixth = guestB.remote.open(A.id, 'pty-a1')
  await until(() => last(guestB).tabs[0]?.state === 'refused')
  check('sharing off on A: refused, and nothing asked', [last(guestB).tabs[0]?.state, last(hostA).asks.length], ['refused', 0])
  if (sixth.ok) guestB.remote.close(sixth.tab)
  hostA.sharing = true

  // A guest that reaches outside what it was allowed: a raw channel as B.
  const rogueRelay = idFromBytes('relay', randomU8(15))
  const gs = new FakeSocket()
  const hs = new FakeSocket()
  gs.peer = hs
  hs.peer = gs
  relays.set(rogueRelay, { guest: gs, host: hs, hostDevice: A.id, guestDevice: B.id })
  const got: RelayInnerFrame[] = []
  let rogueOpen = false
  const rogue = new RelayChannel({
    role: 'guest',
    relay: rogueRelay,
    account: ACCOUNT,
    me: { id: B.id, signPriv: B.keys.signPriv },
    peer: A.id,
    peerKey: keyOf,
    io: { send: (x) => gs.send(x), close: (c) => gs.close(c) },
    events: { onOpen: () => (rogueOpen = true), onFrame: (f) => got.push(f), onClose: () => {} }
  })
  gs.on('message', (data: unknown, binary: boolean) => rogue.receive(binary ? new Uint8Array(data as Buffer) : String(data), binary))
  gs.open()
  void hostA.remote.onRelay(rogueRelay, B.id)
  rogue.start()
  await until(() => rogueOpen)
  rogue.send({ t: 'attach', ptyId: 'pty-a1' })
  const ask5 = await until(() => last(hostA).asks[0])
  await hostA.remote.answer(ask5!.id, 'once')
  await until(() => got.some((f) => f.t === 'ready'))
  const socketsBefore = hostA.sockets.length
  rogue.send({ t: 'ws-open', id: 7, path: '/ws?ptyId=pty-other' })
  rogue.send({ t: 'req', id: 8, method: 'GET', path: '/api/transcript?id=00000000-0000-0000-0000-000000000000' })
  rogue.send({ t: 'req', id: 9, method: 'GET', path: '/api/sessions' })
  rogue.send({ t: 'req', id: 10, method: 'POST', path: '/api/transcribe' })
  rogue.send({ t: 'req', id: 11, method: 'GET', path: '/api/host' })
  await until(() => got.some((f) => f.t === 'res' && f.id === 11))
  check('under Allow once, another session’s socket is refused', got.find((f) => f.t === 'ws-close' && f.id === 7) ? 'refused' : 'opened', 'refused')
  check('and transcripts, the session list and dictation get 403', [8, 9, 10].map((id) => (got.find((f) => f.t === 'res' && f.id === id) as { status?: number } | undefined)?.status), [403, 403, 403])
  check('the host’s name is served', (got.find((f) => f.t === 'res' && f.id === 11) as { status?: number } | undefined)?.status, 200)
  check('none of the refused ones reached the phone handlers', [hostA.sockets.length - socketsBefore, hostA.requests.filter((r) => /transcript|sessions|transcribe/.test(r)).length], [0, 0])
  rogue.close('done')

  // A removed device (not in the chain A verified) is never taken at all.
  const xRelay = idFromBytes('relay', randomU8(15))
  relays.set(xRelay, { guest: new FakeSocket(), host: new FakeSocket(), hostDevice: A.id, guestDevice: X.id })
  await hostA.remote.onRelay(xRelay, X.id)
  await tick(30)
  check('a relay from a device the chain does not hold as active is not even opened', [relays.get(xRelay)?.host.readyState, last(hostA).guests.some((g) => g.device === X.id), last(hostA).asks.length], [0, false, 0])

  hostA.remote.reset()
  guestB.remote.reset()
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
