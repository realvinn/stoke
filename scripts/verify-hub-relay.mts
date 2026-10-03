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
 * - What a review found (2026-10-01): a device removed from the chain while
 *   its relay is open (either end), a quiet tab the hub would close as idle,
 *   a status replayed after a presence reconnect, a status too large for the
 *   hub, and what "Always" reaches.
 * - Last active wins (shared/sizeClaim.ts, 2026-10-02): when a side's use
 *   counts, the settle and echo rules on a fake clock with two sides on one
 *   pty (no use, no resize — ever), a remote tab's resize reaching only its
 *   own session's pty, and the host's status frame: the attached session's
 *   model, effort, context and usage, and nothing about any other session.
 *
 * Every input is synthetic (gotcha 74): keys, ids, clocks, sessions. Nothing
 * reaches the network, no agent CLI runs, and nothing in ~ is read. Imports
 * are relative with `.ts` (gotcha 78).
 */
import { readFileSync } from 'node:fs'
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
import { answerChatsRoute, matchedOnlyInKeys, sharedChats, type ChatIndexAccess } from '../src/main/hub/chatShare.ts'
import { keyShapedQuery, keyShapedRun, redactKeyShaped } from '../src/shared/keyShaped.ts'
import { redactSecrets } from '../src/main/chatIndex/parse.ts'
import { VirtualSocket } from '../src/main/remote/socket.ts'
import type { ChatSearchHit, ChatTranscript } from '../src/shared/chatIndex.ts'
import { chatsRouteFor } from '../src/shared/remotePhone.ts'
import {
  chatRefusalCodeOf,
  chatSharersStep,
  chatsSearchAgain,
  namesList,
  NO_CHAT_SHARERS,
  remoteChatGroups,
  remoteChatWhere,
  remoteOpenLine,
  remoteReadLine,
  remoteReadWatch,
  shareChatsBlock,
  shareChatsRow,
  sharePausedOf,
  SHARE_CHATS_STOPPED,
  type ChatSharers
} from '../src/shared/remoteChatsView.ts'
import { b64uDecode, b64uEncode, idFromBytes } from '../src/shared/hub/codec.ts'
import { HUB_LABELS } from '../src/shared/hub/labels.ts'
import { HUB_LIMITS, parsePresenceClientFrame, parsePresenceServerFrame, sealedStatusProblem, type PresenceClientFrame, type SealedStatus } from '../src/shared/hub/protocol.ts'
import {
  attachDecision,
  chatsAttachDecision,
  chatsRefusalSentence,
  chatsRefusalState,
  chatsShareBlock,
  chatsSharingEffective,
  CHATS_ONCE_KEY,
  CHATS_PAUSED_SENTENCE,
  CHATS_REDACTION_BLOCK,
  CHATS_REFUSAL_CODES,
  isChatsRefusalCode,
  folderName,
  parseRemoteChat,
  parseRemoteChatHits,
  remoteChatFrom,
  remoteChatHitFrom,
  REMOTE_CHAT_MAX_BYTES,
  type RemoteChatPeerState,
  type RemoteChatsResult,
  holdOnce,
  onceHolds,
  ONCE_GRACE_MS,
  otherMachines,
  parseRemoteStatus,
  pruneOnce,
  relayScopeVerdict,
  releaseOnce,
  remoteStatusFrom,
  parseRemoteSessionStatus,
  remoteSessionStatusFrom,
  remoteTypeVerdict,
  REMOTE_TYPE_MAX,
  REMOTE_MAX_SESSIONS,
  REMOTE_USAGE_MAX,
  type HubRemoteView,
  type RemoteRowLike,
  type RemoteSessionStatus,
  type RemoteTabFrame
} from '../src/shared/hub/remote.ts'
import {
  CLAIM_DEBOUNCE_MS,
  CLAIM_SETTLE_MS,
  claimCounts,
  claimVerdict,
  foreignSize,
  SizeClaimer,
  type ClaimTrigger,
  type Grid
} from '../src/shared/sizeClaim.ts'
import {
  parseRelayInner,
  relayFrameVerdict,
  RELAY_CHUNK_CHARS,
  RELAY_IDLE_MS,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PING_MS,
  RELAY_PONG_WAIT_MS,
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
  // A pty-socket frame is judged by the socket it rides: a resize reaches the grant's session only.
  const resizeFrame: RelayInnerFrame = { t: 'ws-msg', id: 1, data: JSON.stringify({ type: 'resize', cols: 120, rows: 40, force: true }) }
  const onSocket = (path?: string): string => (relayScopeVerdict(one, resizeFrame, path).ok ? 'ok' : 'no')
  check('a resize on that session’s pty socket', onSocket('/ws?ptyId=pty-1'), 'ok')
  check('not on another session’s, the events socket, or no known socket', [onSocket('/ws?ptyId=pty-2'), onSocket('/ws/events'), onSocket(undefined)], ['no', 'no', 'no'])
  // "Always" is the same scope (the relay's own session): held live below, against a rogue guest.
}

/* ============================================================ two machines */

console.log('\ntwo machines through a fake hub: list, ask, type, see it echo')

/**
 * A fake hub: relays pair two sockets and forward verbatim; every byte is kept
 * to search for the canary. Like `RelayBroker`, a relay's activity is the
 * (fake) time it last forwarded a frame, and `hubTick` closes one idle for
 * `RELAY_IDLE_MS`; a muted socket's frames are lost on the way.
 */
const hubBytes: Buffer[] = []
const activity = new Map<string, number>()
const forwarded = new Map<string, { guest: number; host: number }>()
class FakeSocket implements RelaySocket {
  readyState = 0
  peer: FakeSocket | null = null
  relay: string | null = null
  role: 'guest' | 'host' | null = null
  mute = false
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
    if (this.mute) return
    if (this.relay && this.role) {
      activity.set(this.relay, clock)
      const n = forwarded.get(this.relay) ?? { guest: 0, host: 0 }
      n[this.role]++
      forwarded.set(this.relay, n)
    }
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
let lastRelay = ''
/** `RelayBroker.tick`'s idle rule, on the fake clock: the relays it closed. */
function hubTick(): string[] {
  const closed: string[] = []
  for (const [id, r] of relays) {
    if (r.guest.readyState !== 1 || r.host.readyState !== 1) continue
    if (clock - (activity.get(id) ?? 0) < RELAY_IDLE_MS) continue
    r.guest.close(1000)
    r.host.close(1000)
    closed.push(id)
  }
  return closed
}
const presence: { from: string; frame: PresenceClientFrame }[] = []
interface Machine {
  dev: Dev
  remote: HubRemote
  /** The chain THIS machine verified: every device it holds as active. */
  active: Dev[]
  /** This machine is out of the vault (revoked, signed out): no remote context at all. */
  out: boolean
  sharing: boolean
  grants: Record<string, HubGrant>
  views: HubRemoteView[]
  frames: { tab: string; frame: RemoteTabFrame }[]
  ptyInput: string[]
  sockets: VirtualSocket[]
  requests: string[]
  sessions: RemoteRowLike[]
  /** Every resize frame the fake pty behind the phone socket got. */
  resizes: { ptyId: string | null; cols: number; rows: number; force: boolean }[]
  /** Every submit frame it got: what the phone server would type (PtyManager.submit), and whether Enter follows. */
  submits: { ptyId: string | null; text: string; enter: boolean }[]
  /** What this machine's status bar would say per session, and every session the relay asked about. */
  status: Record<string, RemoteSessionStatus>
  statusAsked: string[]
  /** `hub.shareChats`, `hub.chatGrants`, `settings.chatIndex === 'on'` and `chatIndexOptions.redact` on THIS machine. */
  shareChats: boolean
  chatGrants: Record<string, 'always'>
  indexOn: boolean
  redactOn: boolean
  /** Its chat index: what `ChatIndexHost` would answer, behind the real `sharedChats`. */
  chats: FakeChat[]
  hidden: string[]
  /** Runs inside a grant write, before it lands (`setGrant`/`setChatGrant`): the world moving during the await. */
  duringGrant?: () => void
  /**
   * A chats grant being taken back is written slowly: `setChatGrant(…, false)` takes the grant out at once,
   * as `HubService.setChatGrant`'s first step does, and resolves only once this does.
   */
  chatGrantOffWrite?: Promise<void>
  /** Runs (once) while a relayed request is being answered: the world moving during the handler's await. */
  duringRequest?: () => void
  /** What this machine calls itself now, when it differs from what the others last heard (a rename not yet published). */
  selfLabel?: string
}
/** One chat in a fake index: its search hit's fields and its transcript. */
interface FakeChat {
  chatId: number
  source: string
  nativeId: string
  title: string | null
  cwd: string | null
  text: string
}
const machines = new Map<string, Machine>()
const vkShared = randomU8(32)

/** The real `sharedChats` over a machine's fake index, as `chatIndexForGuests` (index.ts) wires the real one. */
function chatAccess(m: Machine): ChatIndexAccess {
  return {
    indexOn: () => m.indexOn,
    // Absent on a bare test machine means on: the cases that turn it off say so.
    redactOn: () => m.redactOn !== false,
    hidden: (cwd) => m.hidden.some((h) => cwd === h || cwd.startsWith(`${h}/`)),
    search: async (q, limit) =>
      m.chats
        .filter((c) => c.text.toLowerCase().includes(q.toLowerCase()))
        .slice(0, limit)
        .map((c): ChatSearchHit => {
          const at = c.text.toLowerCase().indexOf(q.toLowerCase())
          return {
            chatId: c.chatId,
            source: c.source as ChatSearchHit['source'],
            nativeId: c.nativeId,
            title: c.title,
            firstPrompt: null,
            cwd: c.cwd,
            updatedMs: 1_700_000_000_000,
            subagent: false,
            role: 'user',
            snippet: { text: c.text, ranges: [[at, at + q.length]] }
          }
        }),
    open: async (source, nativeId) => {
      const c = m.chats.find((x) => x.source === source && x.nativeId === nativeId)
      return c
        ? { chatId: c.chatId, source: c.source as ChatTranscript['source'], title: c.title, cwd: c.cwd, createdMs: 1, updatedMs: 2, messages: [{ role: 'user', text: c.text, atMs: 1 }, { role: 'assistant', text: `re: ${c.text}`, atMs: 2 }], from: 'source', fallback: null, partial: false }
        : null
    },
    redact: redactSecrets
  }
}

function machine(d: Dev, opts: { keepAlive?: { pingMs: number; pongWaitMs: number }; olderHost?: boolean; noTyping?: boolean; chatsTiming?: { idleMs?: number; waitMs?: number; retryMs?: number; requestMs?: number } } = {}): Machine {
  const m = { dev: d, active: [...ACTIVE], out: false, sharing: false, grants: {}, views: [], frames: [], ptyInput: [], sockets: [], requests: [], sessions: [], resizes: [], submits: [], status: {}, statusAsked: [], shareChats: false, chatGrants: {}, indexOn: true, redactOn: true, chats: [], hidden: [] } as unknown as Machine
  const chatShare = sharedChats(chatAccess(m))
  /** A give that is being written: the hook (once) runs while it is in flight, as a sync pass or a click would. */
  const writing = async (): Promise<void> => {
    const during = m.duringGrant
    if (!during) return
    m.duringGrant = undefined
    await tick()
    during()
  }
  const ctx = (): RemoteContext | null => m.out ? null : ({
    account: ACCOUNT,
    epoch: 1,
    me: { id: d.id, label: m.selfLabel ?? d.label, platform: d.platform, signPriv: d.keys.signPriv },
    active: m.active.map((a) => ({ id: a.id, label: a.label, platform: a.platform, sign: a.keys.signPub }))
  })
  m.remote = new HubRemote({
    keepAlive: opts.keepAlive,
    chatsTiming: opts.chatsTiming,
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
      guest.relay = hostSock.relay = relay
      guest.role = 'guest'
      hostSock.role = 'host'
      activity.set(relay, clock)
      lastRelay = relay
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
      if (grant) {
        m.grants = { ...m.grants, [device]: grant }
        await writing()
      } else {
        const next = { ...m.grants }
        delete next[device]
        m.grants = next
      }
    },
    shareChats: () => m.shareChats,
    chatGrants: () => m.chatGrants,
    setChatGrant: async (device, on) => {
      // As HubService.setChatGrant: never given while the chats tick is off.
      if (on && !m.shareChats) return
      const next = { ...m.chatGrants }
      if (on) next[device] = 'always'
      else delete next[device]
      m.chatGrants = next
      if (on) await writing()
      else if (m.chatGrantOffWrite) await m.chatGrantOffWrite
    },
    chatIndexOn: () => m.indexOn,
    chatRedactOn: () => m.redactOn,
    log: () => {},
    sessions: async () => m.sessions,
    request: async (method, path) => {
      m.requests.push(`${method} ${path}`)
      const during = m.duringRequest
      if (during) {
        m.duringRequest = undefined
        await tick()
        during()
      }
      // The relay instance's own routing (server.ts `api`): chats only through `chatsRouteFor('relay', …)`.
      const url = new URL(path, 'http://localhost')
      const route = chatsRouteFor('relay', method, url.pathname)
      if (route === 'search' || route === 'open') return answerChatsRoute(chatShare, route, url.searchParams)
      if (route === 'none') return { status: 404, body: { error: 'No such endpoint or method.' } }
      return { status: 200, body: { machine: d.label } }
    },
    socket: (path, sock) => {
      // A fake pty behind the phone socket: the attach replay, then an echo of whatever is typed.
      m.sockets.push(sock as VirtualSocket)
      const ptyId = new URLSearchParams(path.split('?')[1] ?? '').get('ptyId')
      sock.send(JSON.stringify({ type: 'attached', ptyId, cols: 100, rows: 30, desktopCols: 100, desktopRows: 30, status: 'idle', history: 'stub$ ' }))
      sock.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; data?: string; text?: string; enter?: boolean; cols?: number; rows?: number; force?: boolean }
        if (msg.type === 'input' && msg.data) {
          m.ptyInput.push(msg.data)
          sock.send(JSON.stringify({ type: 'data', ptyId, data: msg.data.replace('\r', '\r\n') }))
        }
        if (msg.type === 'resize') m.resizes.push({ ptyId, cols: msg.cols ?? 0, rows: msg.rows ?? 0, force: msg.force === true })
        // server.ts: `manager.submit(ptyId, text, { enter: msg.enter !== false })`.
        if (msg.type === 'submit' && typeof msg.text === 'string') m.submits.push({ ptyId, text: msg.text, enter: msg.enter !== false })
      })
    },
    emit: (view) => m.views.push(view),
    frame: (tab, frame) => m.frames.push({ tab, frame }),
    sessionStatus: (ptyId) => {
      m.statusAsked.push(ptyId)
      return m.status[ptyId] ?? null
    },
    // A host from before last active wins says nothing about sizes in its `ready`.
    followsResize: !opts.olderHost,
    // Nor about typing without an Enter, and neither does one from before dictation over remote tabs.
    typeOnly: !opts.olderHost && !opts.noTyping
  })
  machines.set(d.id, m)
  return m
}

/** A raw guest channel into `host`, as `as`: a guest that sends whatever it likes once the handshake is done. */
async function rogueChannel(host: Machine, as: Dev): Promise<{ ch: RelayChannel; got: RelayInnerFrame[]; closed: () => string | null }> {
  const relay = idFromBytes('relay', randomU8(15))
  const gs = new FakeSocket()
  const hs = new FakeSocket()
  gs.peer = hs
  hs.peer = gs
  relays.set(relay, { guest: gs, host: hs, hostDevice: host.dev.id, guestDevice: as.id })
  const got: RelayInnerFrame[] = []
  let open = false
  let closedWhy: string | null = null
  const ch = new RelayChannel({
    role: 'guest',
    relay,
    account: ACCOUNT,
    me: { id: as.id, signPriv: as.keys.signPriv },
    peer: host.dev.id,
    peerKey: keyOf,
    io: { send: (x) => gs.send(x), close: (c) => gs.close(c) },
    events: { onOpen: () => (open = true), onFrame: (f) => got.push(f), onClose: (r) => (closedWhy = r) }
  })
  gs.on('message', (data: unknown, binary: boolean) => ch.receive(binary ? new Uint8Array(data as Buffer) : String(data), binary))
  gs.on('close', () => ch.close('the relay closed'))
  gs.open()
  void host.remote.onRelay(relay, as.id)
  ch.start()
  await until(() => open)
  return { ch, got, closed: () => closedWhy }
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

  // The status on show is cleared by a presence reconnect and by "offline"; the replay mark is not.
  const fromA = presence.filter((p) => p.from === A.id && p.frame.t === 'status').map((p) => (p.frame as { status: SealedStatus }).status)
  const newestFromA = fromA[fromA.length - 1]
  guestB.remote.presenceClosed()
  guestB.remote.presenceOpened()
  guestB.remote.onOnline([A.id, B.id])
  await guestB.remote.onStatus(A.id, fromA[0])
  check('after B’s presence reconnects, the hub handing back A’s older status is refused', last(guestB).machines[0]?.status, null)
  await guestB.remote.onStatus(A.id, newestFromA)
  check('while A’s latest, which the hub hands back on every connect, is taken', last(guestB).machines[0]?.status?.sessions.length, 1)
  guestB.remote.onOnline([B.id])
  guestB.remote.onOnline([A.id, B.id])
  await guestB.remote.onStatus(A.id, fromA[0])
  check('after the hub says A went offline and came back, the older one is still refused', last(guestB).machines[0]?.status, null)
  await guestB.remote.onStatus(A.id, newestFromA)
  ok('(A’s latest again, so the rest runs on a full list)', last(guestB).machines[0]?.status?.sessions.length === 1)
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

  // "Always" stops the question; it does not widen the relay past its own session.
  hostA.remote.dropGuests() // the Allow once above is still in its grace: ask afresh
  const always = await rogueChannel(hostA, B)
  always.ch.send({ t: 'attach', ptyId: 'pty-a1' })
  const askAlways = await until(() => last(hostA).asks[0])
  await hostA.remote.answer(askAlways!.id, 'always')
  await until(() => always.got.some((f) => f.t === 'ready'))
  const socketsAlways = hostA.sockets.length
  const requestsAlways = hostA.requests.length
  always.ch.send({ t: 'ws-open', id: 3, path: '/ws?ptyId=pty-other' })
  always.ch.send({ t: 'req', id: 4, method: 'POST', path: '/api/sessions', body: { cwd: '/tmp' } })
  always.ch.send({ t: 'req', id: 5, method: 'POST', path: '/api/projects', body: { name: 'x' } })
  always.ch.send({ t: 'req', id: 6, method: 'GET', path: '/api/projects' })
  always.ch.send({ t: 'req', id: 7, method: 'GET', path: '/api/history?cwd=/' })
  always.ch.send({ t: 'req', id: 8, method: 'GET', path: '/api/transcript?id=00000000-0000-0000-0000-000000000000' })
  always.ch.send({ t: 'req', id: 9, method: 'GET', path: '/api/sessions' })
  always.ch.send({ t: 'ws-open', id: 10, path: '/ws?ptyId=pty-a1' })
  always.ch.send({ t: 'req', id: 11, method: 'GET', path: '/api/host' })
  await until(() => always.got.some((f) => f.t === 'res' && f.id === 11))
  const statusOf = (id: number): number | undefined => (always.got.find((f) => f.t === 'res' && f.id === id) as { status?: number } | undefined)?.status
  check('under Always too: new sessions, folders, project paths, history, transcripts and the session list get 403', [4, 5, 6, 7, 8, 9].map(statusOf), [403, 403, 403, 403, 403, 403])
  check('another session’s socket is refused, its own opens, the host’s name is served', [!!always.got.find((f) => f.t === 'ws-close' && f.id === 3), hostA.sockets.length - socketsAlways, statusOf(11)], [true, 1, 200])
  check('and only that reached the phone handlers', hostA.requests.slice(requestsAlways), ['GET /api/host'])
  always.ch.close('done')
  await hostA.remote.revokeGrant(B.id)

  // A removed device (not in the chain A verified) is never taken at all.
  const xRelay = idFromBytes('relay', randomU8(15))
  relays.set(xRelay, { guest: new FakeSocket(), host: new FakeSocket(), hostDevice: A.id, guestDevice: X.id })
  await hostA.remote.onRelay(xRelay, X.id)
  await tick(30)
  check('a relay from a device the chain does not hold as active is not even opened', [relays.get(xRelay)?.host.readyState, last(hostA).guests.some((g) => g.device === X.id), last(hostA).asks.length], [0, false, 0])

  hostA.remote.reset()
  guestB.remote.reset()
}

/* ============================================================ what a review found */

const stubRow = (): RemoteRowLike => ({ ptyId: 'pty-a1', project: 'stoke', title: 'Stub session', status: 'idle', agentName: 'Claude Code', exited: false, lastActivityAt: clock, context: null })
const tabOf = (m: Machine, id: string): HubRemoteView['tabs'][number] | undefined => last(m).tabs.find((t) => t.id === id)

/** B opens A's pty-a1 and A allows it once (or serves it under a grant or a held once): the tab id. */
async function served(hostM: Machine, guestM: Machine): Promise<string> {
  const o = guestM.remote.open(A.id, 'pty-a1')
  const tab = o.ok ? o.tab : ''
  const ask = await until(() => last(hostM).asks[0] ?? (tabOf(guestM, tab)?.state === 'open' ? 'open' : null))
  if (ask && ask !== 'open') await hostM.remote.answer(ask.id, 'once')
  await until(() => tabOf(guestM, tab)?.state === 'open' && guestM.frames.some((f) => f.tab === tab && f.frame.type === 'attached'))
  return tab
}

console.log('\na device removed from the chain while its relay is open')
{
  const hostM = machine(A)
  const guestM = machine(B)
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])

  // A's chain drops B while B is typing into A's session, and the hub keeps the relay open.
  const tab1 = await served(hostM, guestM)
  guestM.remote.input(tab1, 'before-revoke\r')
  await until(() => hostM.ptyInput.includes('before-revoke\r'))
  ok('(B is attached and typing)', hostM.ptyInput.includes('before-revoke\r') && last(hostM).guests.length === 1)
  const relay1 = lastRelay
  hostM.active = [A]
  hostM.remote.chainChanged()
  await until(() => tabOf(guestM, tab1)?.state === 'refused')
  check('A’s chain drops B mid-serve: B’s tab is told why, and not reconnected', [tabOf(guestM, tab1)?.state, /no longer one of this account/.test(tabOf(guestM, tab1)?.message ?? '')], ['refused', true])
  check('A’s indicator goes, and its relayed pty socket closes', [last(hostM).guests.length, hostM.sockets.every((x) => x.readyState === 3)], [0, true])
  ok('A closed the relay itself: the hub never did', relays.get(relay1)?.host.readyState === 3)
  guestM.remote.input(tab1, 'after-revoke\r')
  await tick(30)
  check('nothing typed after it reaches A’s pty', hostM.ptyInput.includes('after-revoke\r'), false)
  guestM.remote.close(tab1)
  hostM.active = [...ACTIVE]

  // The chain moves and no hook has run yet: B's next frame is refused anyway.
  hostM.remote.dropGuests()
  const r2 = await rogueChannel(hostM, B)
  r2.ch.send({ t: 'attach', ptyId: 'pty-a1' })
  const ask2 = await until(() => last(hostM).asks[0])
  await hostM.remote.answer(ask2!.id, 'once')
  await until(() => r2.got.some((f) => f.t === 'ready'))
  hostM.active = [A]
  const requests2 = hostM.requests.length
  r2.ch.send({ t: 'req', id: 1, method: 'GET', path: '/api/host' })
  r2.ch.send({ t: 'ws-open', id: 2, path: '/ws?ptyId=pty-a1' })
  await until(() => r2.closed())
  check('with no hook run, B’s next frames are refused and the relay closed', [r2.got.some((f) => f.t === 'res'), r2.got.some((f) => f.t === 'refused'), !!r2.closed(), hostM.requests.length - requests2], [false, true, true, 0])
  hostM.active = [...ACTIVE]

  // Removed while the question waited: the answer serves nothing and grants nothing.
  hostM.remote.dropGuests()
  const o3 = guestM.remote.open(A.id, 'pty-a1')
  const tab3 = o3.ok ? o3.tab : ''
  const ask3 = await until(() => last(hostM).asks[0])
  hostM.active = [A]
  const answered = await hostM.remote.answer(ask3!.id, 'always')
  await until(() => tabOf(guestM, tab3)?.state === 'refused')
  check('Always pressed after B left the chain: nothing served, nothing granted', [answered.ok, Object.keys(hostM.grants), tabOf(guestM, tab3)?.state], [false, [], 'refused'])
  guestM.remote.close(tab3)
  hostM.active = [...ACTIVE]

  // The hook, while the question waits.
  const o4 = guestM.remote.open(A.id, 'pty-a1')
  const tab4 = o4.ok ? o4.tab : ''
  await until(() => last(hostM).asks[0])
  hostM.active = [A]
  hostM.remote.chainChanged()
  await until(() => tabOf(guestM, tab4)?.state === 'refused')
  check('a question still waiting when B leaves the chain goes, and B is refused', [last(hostM).asks.length, tabOf(guestM, tab4)?.state], [0, 'refused'])
  guestM.remote.close(tab4)

  // An Always for a device the chain no longer holds is deleted.
  hostM.grants = { [B.id]: { mode: 'full', label: 'Laptop', at: 1 } }
  hostM.remote.chainChanged()
  await until(() => Object.keys(hostM.grants).length === 0)
  check('A’s Always for B goes with B', Object.keys(hostM.grants), [])
  hostM.active = [...ACTIVE]

  // The other end: B's chain drops A (a stolen laptop) while B has A's session open.
  hostM.remote.dropGuests()
  const tab6 = await served(hostM, guestM)
  const relaysBefore = relays.size
  guestM.active = [B]
  guestM.remote.chainChanged()
  await until(() => last(hostM).guests.length === 0)
  check('B’s chain drops A: B’s tab ends and says why, and A’s end goes too', [tabOf(guestM, tab6)?.state, /no longer one of your devices/.test(tabOf(guestM, tab6)?.message ?? ''), last(hostM).guests.length], ['lost', true, 0])
  guestM.remote.input(tab6, 'to-a-removed-host\r')
  await tick(1500)
  check('and it is neither reconnected nor typed into', [relays.size - relaysBefore, tabOf(guestM, tab6)?.state, hostM.ptyInput.includes('to-a-removed-host\r')], [0, 'lost', false])
  guestM.remote.close(tab6)
  guestM.active = [...ACTIVE]

  // B itself leaves the vault (its context goes): its tab ends, blaming this computer, not A.
  hostM.remote.dropGuests()
  const tab7 = await served(hostM, guestM)
  guestM.out = true
  guestM.remote.chainChanged()
  await until(() => last(hostM).guests.length === 0)
  check('B leaves the vault itself: its tab ends, saying so, and A’s end goes', [tabOf(guestM, tab7)?.state, tabOf(guestM, tab7)?.message, last(hostM).guests.length], ['lost', 'This computer is no longer in your hub’s vault.', 0])
  check('and its banner still names A, though B’s chain no longer can', tabOf(guestM, tab7)?.deviceLabel, 'Studio')
  // Try again cannot help while THIS computer is out: it stays final, never "Reconnecting…" for
  // eight rounds that cannot succeed (review, 2026-10-02).
  const relaysOut = relays.size
  guestM.remote.retry(tab7)
  await tick(300)
  check('Try again while this computer is out of the vault stays final, asks the hub for nothing', [tabOf(guestM, tab7)?.state, tabOf(guestM, tab7)?.message, relays.size - relaysOut], ['lost', 'This computer is no longer in your hub’s vault.', 0])
  guestM.remote.close(tab7)
  guestM.out = false
  hostM.remote.reset()
  guestM.remote.reset()
}

console.log('\na quiet remote tab: the guest pings, so the hub never closes it as idle')
{
  check('a ping and its wait fit well inside the hub’s idle close', [RELAY_PING_MS + RELAY_PONG_WAIT_MS < RELAY_IDLE_MS, RELAY_PING_MS * 2 <= RELAY_IDLE_MS], [true, true])
  // Real milliseconds for the keepalive; the hub's idle rule runs on the fake clock, one ping interval per step.
  const fast = { pingMs: 20, pongWaitMs: 400 }
  let hostM = machine(A, { keepAlive: fast })
  let guestM = machine(B, { keepAlive: fast })
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])
  const tab = await served(hostM, guestM)
  const relay = lastRelay
  const start = clock
  const pongsBefore = forwarded.get(relay)?.host ?? 0
  const closed: string[] = []
  for (let step = 0; step < 4; step++) {
    clock += RELAY_PING_MS
    await until(() => activity.get(relay) === clock)
    closed.push(...hubTick())
  }
  check(`${(clock - start) / 60_000} quiet minutes on, past the hub’s ${RELAY_IDLE_MS / 60_000}: the relay and the tab are open`, [closed, tabOf(guestM, tab)?.state], [[], 'open'])
  // The last pong may still be on its way when the fourth step ends: wait for it, never race it.
  const pongs = await until(() => ((forwarded.get(relay)?.host ?? 0) - pongsBefore >= 4 ? (forwarded.get(relay)?.host ?? 0) - pongsBefore : 0))
  ok('and the host answered the pings', (pongs ?? 0) >= 4, `${pongs ?? 0} frames back`)

  // The host stops answering (its frames are lost on the way): no pong, so the guest closes and reconnects.
  const host = relays.get(relay)?.host
  if (host) host.mute = true
  await until(() => tabOf(guestM, tab)?.state === 'reconnecting', 3000)
  check('a ping with no pong inside the wait: the guest closes the channel and reconnects', [tabOf(guestM, tab)?.state, relays.get(relay)?.guest.readyState], ['reconnecting', 3])
  await until(() => tabOf(guestM, tab)?.state === 'open', 5000)
  check('(on a fresh relay, inside the Allow once grace)', [tabOf(guestM, tab)?.state, lastRelay !== relay], ['open', true])
  guestM.remote.close(tab)
  hostM.remote.reset()
  guestM.remote.reset()

  // Control: with no ping, the same fake hub does close a quiet relay, so the check above can fail.
  const never = { pingMs: 2 ** 30, pongWaitMs: 2 ** 30 }
  hostM = machine(A, { keepAlive: never })
  guestM = machine(B, { keepAlive: never })
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])
  hostM.remote.dropGuests()
  const quiet = await served(hostM, guestM)
  const quietRelay = lastRelay
  clock += RELAY_IDLE_MS
  const idle = hubTick()
  await until(() => tabOf(guestM, quiet)?.state === 'reconnecting')
  check('(control: unpinged, the fake hub closes it as idle and the tab drops to reconnecting)', [idle.includes(quietRelay), tabOf(guestM, quiet)?.state], [true, 'reconnecting'])
  guestM.remote.close(quiet)
  hostM.remote.reset()
  guestM.remote.reset()
}

console.log('\na status too large for the hub is cut to fit, not dropped by it')
{
  const BIG = dev('大きな机', 'darwin')
  const bigM = machine(BIG)
  bigM.sharing = true
  bigM.sessions = Array.from({ length: REMOTE_MAX_SESSIONS }, (_, i) => ({
    ptyId: `pty-${i}`,
    project: '项目'.repeat(40),
    title: (i % 2 ? '会话标题' : '😀🧪').repeat(60),
    status: 'busy',
    agentName: '🤖'.repeat(40),
    exited: false,
    lastActivityAt: clock - i,
    context: { contextTokens: 123_456, contextLimit: 1_000_000, ready: true }
  }))
  const fBig = { account: ACCOUNT, epoch: 1, device: BIG.id }
  const naive = sealStatus(presenceKey(vkShared, ACCOUNT, 1), fBig, JSON.stringify(remoteStatusFrom({ at: clock, name: BIG.label, platform: 'darwin', open: true, rows: bigM.sessions })))
  check(`24 sessions of CJK and emoji titles seal past the hub’s ${HUB_LIMITS.statusBytes}-character cap`, sealedStatusProblem(naive), 'too large')
  const n0 = presence.length
  bigM.remote.presenceOpened()
  const sent = await until(() => presence.slice(n0).find((p) => p.from === BIG.id && p.frame.t === 'status'))
  const sealed = (sent?.frame as { status: SealedStatus } | undefined)?.status
  check('what is sent passes the hub’s own check, and its parser takes the frame', [sealed ? sealedStatusProblem(sealed) : 'nothing sent', parsePresenceClientFrame(JSON.parse(JSON.stringify(sent?.frame ?? null)))?.t], [null, 'status'])
  const opened = sealed ? parseRemoteStatus(openStatus(presenceKey(vkShared, ACCOUNT, 1), fBig, sealed) ?? '') : null
  const n = opened?.sessions.length ?? 0
  ok(`it lists the first sessions that fit, in the phone’s order (${n} of ${REMOTE_MAX_SESSIONS})`, n > 0 && n < REMOTE_MAX_SESSIONS && (opened?.sessions ?? []).every((x, i) => x.ptyId === `pty-${i}`))
  bigM.remote.reset()
}

/* ============================================================ last active wins */

console.log('\nwho sizes the pty: the side being used, last active wins (sizeClaim.ts)')
{
  const g = (cols: number, rows: number): Grid => ({ cols, rows })
  const kinds: ClaimTrigger[] = ['focus', 'key', 'click', 'pane']
  const all = { shown: true, focused: true, windowFocused: true, recentInput: true }
  check('a focus, a key or a click on a terminal on show is use, wherever the keyboard is', (['focus', 'key', 'click'] as const).map((k) => claimCounts(k, { shown: true, focused: false, windowFocused: false, recentInput: false })), [true, true, true])
  check('nothing counts while the terminal is not on show', kinds.map((k) => claimCounts(k, { ...all, shown: false })), [false, false, false, false])
  check('a pane resize counts only while its terminal holds the keyboard in a focused window', [claimCounts('pane', all), claimCounts('pane', { ...all, focused: false }), claimCounts('pane', { ...all, windowFocused: false })], [true, false, false])
  check('and only just after someone acted on that window: a strip appearing over a terminal nobody is at is not use', claimCounts('pane', { ...all, recentInput: false }), false)
  check('a due claim with nothing to measure, or already the pty’s grid, sends nothing', [claimVerdict({ want: null, have: g(100, 30), now: 0, foreignAt: null }).t, claimVerdict({ want: g(100, 30), have: g(100, 30), now: 0, foreignAt: null }).t], ['none', 'none'])
  check('the other side resized 300 ms ago: the claim waits out the rest of the settle', claimVerdict({ want: g(120, 40), have: g(100, 30), now: 1300, foreignAt: 1000 }), { t: 'wait', ms: CLAIM_SETTLE_MS - 300 })
  check('settled, or never resized by the other side: this pane’s grid is sent', [claimVerdict({ want: g(120, 40), have: g(100, 30), now: 1000 + CLAIM_SETTLE_MS, foreignAt: 1000 }), claimVerdict({ want: g(120, 40), have: null, now: 5, foreignAt: null })], [{ t: 'send', grid: g(120, 40) }, { t: 'send', grid: g(120, 40) }])
  check('this side’s own claim coming back is not the other side; anything else is', [foreignSize(g(120, 40), g(120, 40)), foreignSize(g(100, 30), g(120, 40)), foreignSize(g(100, 30), null)], [false, true, true])

  /*
   * Two sides on one pty, on a fake clock: a remote tab whose pane fits
   * 120x40 and the session's own tab whose pane fits 100x30. A resize takes
   * RELAY_MS to reach the pty, and both sides hear the new grid then.
   */
  const RELAY_MS = 40
  let now = 0
  let nextId = 1
  const timers: { at: number; id: number; fn: () => void }[] = []
  const setTimer = (fn: () => void, ms: number): number => {
    const id = nextId++
    timers.push({ at: now + ms, id, fn })
    return id
  }
  const clearTimer = (id: unknown): void => {
    const i = timers.findIndex((t) => t.id === id)
    if (i >= 0) timers.splice(i, 1)
  }
  const advance = (ms: number): void => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
    }
    now = end
  }
  interface Side {
    claimer: SizeClaimer
    heard: Grid
  }
  let pty = g(100, 30)
  const sent: { side: string; at: number; grid: Grid }[] = []
  const sides: Side[] = []
  const side = (name: string, pane: () => Grid | null): Side => {
    const me = { heard: pty } as Side
    me.claimer = new SizeClaimer({
      now: () => now,
      setTimer,
      clearTimer,
      want: pane,
      have: () => me.heard,
      send: (grid) => {
        sent.push({ side: name, at: now, grid })
        setTimer(() => {
          pty = grid
          for (const s of sides) {
            s.heard = grid
            s.claimer.sized(grid)
          }
        }, RELAY_MS)
      }
    })
    sides.push(me)
    return me
  }
  let guestPane: Grid | null = g(120, 40)
  const guest = side('guest', () => guestPane)
  const host = side('host', () => g(100, 30))
  const use = (s: Side, kind: ClaimTrigger, f = all): boolean => s.claimer.trigger(kind, f)

  for (let i = 0; i < 5; i++) {
    use(guest, 'key')
    advance(20)
  }
  advance(1000)
  check('a burst of keys on the remote tab is ONE resize, to its pane’s grid, after the debounce', sent.map((x) => [x.side, x.at, x.grid]), [['guest', CLAIM_DEBOUNCE_MS, g(120, 40)]])
  check('and the pty has it', pty, g(120, 40))
  advance(10 * 60_000)
  check('ten idle minutes later, neither side has resized it back: no use, no resize', sent.length, 1)
  check('a terminal not on show, or a pane resize with the keyboard elsewhere, claims nothing', [use(host, 'focus', { ...all, shown: false }), use(host, 'pane', { ...all, focused: false })], [false, false])
  advance(1000)
  check('(nothing was sent)', sent.length, 1)

  use(host, 'click')
  advance(5000)
  check('a click at the host takes the grid back to its own pane', sent.slice(1).map((x) => [x.side, x.grid]), [['host', g(100, 30)]])
  check('and the remote tab now draws the host’s grid', guest.heard, g(100, 30))
  advance(10 * 60_000)
  check('ten more idle minutes: still two resizes, so the two sides never ping-pong', sent.length, 2)

  // The host is used 100 ms after the guest's resize reached it: the claim waits out the settle, then wins.
  use(guest, 'focus')
  advance(CLAIM_DEBOUNCE_MS + RELAY_MS)
  const reached = now
  check('(the remote tab took it back on its next focus)', [sent.length, pty], [3, g(120, 40)])
  advance(100)
  use(host, 'key')
  advance(5000)
  const hostClaim = sent[sent.length - 1]
  check('used inside the settle of the other side’s resize: the claim waits for it, then wins', [hostClaim.side, hostClaim.at - reached], ['host', CLAIM_SETTLE_MS])

  // The remote tab's own resize echoing back is not "the other side": a key right after it does not wait.
  guestPane = g(126, 42)
  use(guest, 'click')
  advance(CLAIM_DEBOUNCE_MS + RELAY_MS)
  const echoAt = now
  guestPane = g(130, 42)
  use(guest, 'key')
  advance(CLAIM_DEBOUNCE_MS)
  const last1 = sent[sent.length - 1]
  check('after its own resize echoes back, the remote tab’s next claim goes after the debounce alone', [last1.side, last1.grid, last1.at - echoAt], ['guest', g(130, 42), CLAIM_DEBOUNCE_MS])
  guest.claimer.dispose()
  host.claimer.dispose()
}

console.log('\na remote tab’s resize reaches its own session’s pty; the host’s status bar comes with it')
{
  const statusA1: RemoteSessionStatus = remoteSessionStatusFrom({
    model: 'claude-opus-5[1m]-statuscanary',
    effort: 'high',
    agent: 'claude',
    context: { used: 41_000.4, limit: 1_000_000 },
    usage: [
      { kind: 'session', label: '5 hours', percent: 23.4, severity: 'normal', resetsAt: clock + 3_600_000, elapsed: 0.40123, active: true },
      { kind: 'weekly', label: 'Weekly', percent: 41, severity: 'normal', resetsAt: clock + 86_400_000, elapsed: 0.2, active: true }
    ],
    usageAt: clock
  })
  check('the host rounds what it sends, so a pace marker creeping on is not a change every pass', [statusA1.context, statusA1.usage[0].percent, statusA1.usage[0].elapsed], [{ used: 41000, limit: 1_000_000 }, 23, 0.4])
  check('a default effort is no effort', remoteSessionStatusFrom({ model: null, effort: 'default', agent: 'claude', context: null, usage: [], usageAt: null }).effort, null)
  const hostileRaw = {
    model: `opus\u001b]0;pwn\u0007${'x'.repeat(200)}`,
    effort: 'max\nhigh',
    agent: 7,
    context: { used: 5, limit: 0 },
    usage: [
      { kind: 'session', label: '5h\u0000', percent: 250, severity: 'x', resetsAt: -1, elapsed: 9, active: 'yes' },
      { kind: 'bogus', label: 'nope', percent: 1 },
      { kind: 'weekly', label: '', percent: 1 },
      ...Array.from({ length: 6 }, () => ({ kind: 'other', label: 'more', percent: 1, severity: '', resetsAt: null, elapsed: null, active: true }))
    ],
    usageAt: 'soon'
  }
  const hostile = parseRemoteSessionStatus(hostileRaw)
  check(
    'another machine’s status is cut and bounded: control characters out, a window of nothing dropped, at most four read',
    [
      hostile?.model?.length,
      /[\u0000-\u001f]/.test(hostile?.model ?? ''),
      hostile?.effort,
      hostile?.agent,
      hostile?.context,
      hostile?.usage.length,
      hostile?.usage[0] && [hostile.usage[0].label, hostile.usage[0].percent, hostile.usage[0].resetsAt, hostile.usage[0].elapsed, hostile.usage[0].active],
      hostile?.usageAt
    ],
    [80, false, 'max high', 'claude', null, 2, ['5h', 100, null, 1, false], null]
  )
  ok('(at most REMOTE_USAGE_MAX windows are even looked at)', REMOTE_USAGE_MAX === 4)
  check('not a status at all: null', [parseRemoteSessionStatus(null), parseRemoteSessionStatus([1])], [null, null])
  check('the frame parses only around a record', [parseRelayInner(JSON.stringify({ t: 'status', status: statusA1 }))?.t, parseRelayInner(JSON.stringify({ t: 'status', status: 'x' }))], ['status', null])
  check('and a host takes none from a guest', relayFrameVerdict('full', { t: 'status', status: statusA1 }).ok, false)

  const hostM = machine(A)
  const guestM = machine(B)
  hostM.sessions = [stubRow(), { ...stubRow(), ptyId: 'pty-a2', title: 'Other session' }]
  hostM.sharing = true
  hostM.status = { 'pty-a1': statusA1, 'pty-a2': { ...statusA1, model: 'opus-other-session-canary' } }
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])
  const tab = await served(hostM, guestM)
  check('a remote tab in use asks for its pane’s grid', guestM.remote.resize(tab, 132, 41), true)
  await until(() => hostM.resizes.length)
  check('the host’s pty socket gets the phone’s own resize frame, forced, for that session', hostM.resizes, [{ ptyId: 'pty-a1', cols: 132, rows: 41, force: true }])
  check('a grid out of bounds, or a tab that is not open, sends nothing', [guestM.remote.resize(tab, 0, 40), guestM.remote.resize(tab, 1001, 40), guestM.remote.resize(tab, 80.5, 40), guestM.remote.resize('rt-nope', 80, 24)], [false, false, false, false])

  const got = await until(() => tabOf(guestM, tab)?.session)
  check('on attach the host says the session’s model, effort, context and usage, as its own bar reads them', got, statusA1)
  check('it was asked only about the session the relay attached to', [...new Set(hostM.statusAsked)], ['pty-a1'])
  ok('and nothing about the other session reached the guest', !JSON.stringify(guestM.remote.view()).includes('opus-other-session-canary') && !JSON.stringify(guestM.views).includes('opus-other-session-canary'))
  ok('the hub carried none of it in the clear', !hubBytes.some((b) => b.includes(Buffer.from('statuscanary'))))
  hostM.status['pty-a1'] = { ...statusA1, context: { used: 90_000, limit: 1_000_000 } }
  hostM.remote.sessionsChanged()
  await until(() => tabOf(guestM, tab)?.session?.context?.used === 90_000)
  check('a change on the host reaches the guest’s bar', tabOf(guestM, tab)?.session?.context, { used: 90_000, limit: 1_000_000 })
  // A host that sends whatever it likes (its own code changed, or not Stoke's): the guest draws only the parsed status.
  hostM.status['pty-a1'] = hostileRaw as unknown as RemoteSessionStatus
  hostM.remote.sessionsChanged()
  await until(() => tabOf(guestM, tab)?.session?.effort === 'max high')
  check('a hostile status from the host is drawn only as parsed: cut, bounded, at most four windows', tabOf(guestM, tab)?.session, hostile)
  hostM.status['pty-a1'] = { ...statusA1, context: { used: 90_000, limit: 1_000_000 } }
  hostM.remote.sessionsChanged()
  await until(() => tabOf(guestM, tab)?.session?.context?.used === 90_000)
  const relayNow = lastRelay
  const hostFramesBefore = forwarded.get(relayNow)?.host ?? 0
  const viewsBefore = guestM.views.length
  hostM.remote.sessionsChanged()
  hostM.remote.sessionsChanged()
  await tick(30)
  check('an unchanged one is not sent again: no frame from the host, and the guest’s view does not move', [(forwarded.get(relayNow)?.host ?? 0) - hostFramesBefore, guestM.views.length - viewsBefore], [0, 0])

  // A guest that sends a status of its own, or a resize on a socket it never opened: the host takes neither.
  hostM.remote.dropGuests()
  const rogue = await rogueChannel(hostM, B)
  rogue.ch.send({ t: 'attach', ptyId: 'pty-a1' })
  const askR = await until(() => last(hostM).asks[0])
  await hostM.remote.answer(askR!.id, 'once')
  await until(() => rogue.got.some((f) => f.t === 'ready'))
  const resizesBefore = hostM.resizes.length
  rogue.ch.send({ t: 'status', status: { model: 'forged' } })
  rogue.ch.send({ t: 'ws-msg', id: 42, data: JSON.stringify({ type: 'resize', cols: 50, rows: 20, force: true }) })
  rogue.ch.send({ t: 'ws-open', id: 43, path: '/ws?ptyId=pty-a2' })
  rogue.ch.send({ t: 'ws-msg', id: 43, data: JSON.stringify({ type: 'resize', cols: 51, rows: 21, force: true }) })
  rogue.ch.send({ t: 'req', id: 44, method: 'GET', path: '/api/host' })
  await until(() => rogue.got.some((f) => f.t === 'res' && f.id === 44))
  check('a resize on no socket, or on another session’s refused socket, reaches no pty', hostM.resizes.length - resizesBefore, 0)
  check('and the status it sent changed nothing on the host', [rogue.closed(), last(hostM).guests.length], [null, 1])
  rogue.ch.close('done')
  guestM.remote.close(tab)
  hostM.remote.reset()
  guestM.remote.reset()
}

console.log('\na host from before last active wins is never resized: its own tab would not follow')
{
  // Its `ready` carries no `sizes`. Such a host would apply the phone's resize to the pty while the
  // tab at its desk kept its old grid, drawing every redraw wrong for whoever sits there.
  const hostM = machine(A, { olderHost: true })
  const guestM = machine(B)
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])
  const tab = await served(hostM, guestM)
  check('a used remote tab asks nothing of it', guestM.remote.resize(tab, 132, 41), false)
  guestM.remote.input(tab, 'still-typing\r')
  await until(() => hostM.ptyInput.includes('still-typing\r'))
  check('and its pty gets no resize, while keys still reach it', [hostM.resizes.length, hostM.ptyInput.includes('still-typing\r')], [0, true])
  guestM.remote.close(tab)
  hostM.remote.reset()
  guestM.remote.reset()
}

/*
 * Dictation on a remote tab (2026-10-04, the owner: "if I remote to another one
 * and want to use claude /voice it should work over the remote"). The words are
 * dictated HERE — this computer's microphone and speech service — and typed
 * THERE by the host's phone server as the phone's own submit frame with
 * `enter: false`: Claude Code's typing rules (gotchas 85, 86), paced on the
 * host, and no Enter. Refused, with the sentence the strip shows over the kept
 * words, on a link that is not open, a grant that only watches, and a host that
 * never said `typeOnly` (it would press Enter after the words).
 */
console.log('\ndictation on a remote tab: typed by the host with no Enter, refused where it cannot go')
{
  const v = (over: Partial<{ state: 'connecting' | 'asking' | 'open' | 'reconnecting' | 'refused' | 'ended' | 'lost'; mode: 'view' | 'full' | null; typeOnly: boolean }> = {}) => ({ state: 'open' as const, mode: 'full' as const, typeOnly: true, deviceLabel: 'Studio', ...over })
  check('an open link under a full grant to a host that types: it goes', remoteTypeVerdict(v(), 'hello'), null)
  check('a link that is not open says so, naming the machine', [remoteTypeVerdict(v({ state: 'reconnecting' })), remoteTypeVerdict(v({ state: 'lost' }))], ['The link to Studio is not open, so nothing was typed there.', 'The link to Studio is not open, so nothing was typed there.'])
  ok('a session that ended says that instead', /session ended on Studio/.test(remoteTypeVerdict(v({ state: 'ended' })) ?? ''))
  ok('a grant that only watches is refused, and says watching is what it may do', /watch this session, not type into it/.test(remoteTypeVerdict(v({ mode: 'view', typeOnly: false })) ?? ''))
  ok('a host that never said typeOnly is asked to update, never sent words it would Enter', /older Stoke that cannot take dictation/.test(remoteTypeVerdict(v({ typeOnly: false })) ?? ''))
  check('the rule can be asked before there are words', remoteTypeVerdict(v()), null)
  ok('a runaway transcript is refused whole rather than typed for minutes', /too long/.test(remoteTypeVerdict(v(), 'x'.repeat(REMOTE_TYPE_MAX + 1)) ?? '') && remoteTypeVerdict(v(), 'x'.repeat(REMOTE_TYPE_MAX)) === null)
  ok('no tab at all: no longer linked', /no longer linked/.test(remoteTypeVerdict(null) ?? ''))
  const submitFrame = (enter: boolean): RelayInnerFrame => ({ t: 'ws-msg', id: 1, data: JSON.stringify({ type: 'submit', text: 'hi', enter }) })
  check('a host lets a typed transcript through a full grant only', [relayFrameVerdict('full', submitFrame(false), '/ws?ptyId=pty-a1').ok, relayFrameVerdict('view', submitFrame(false), '/ws?ptyId=pty-a1').ok], [true, false])

  const hostM = machine(A)
  const guestM = machine(B)
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])
  const tab = await served(hostM, guestM)
  check('the tab knows its grant and that the host types', [tabOf(guestM, tab)?.mode, tabOf(guestM, tab)?.typeOnly], ['full', true])
  const words = 'make the button blue\nand the border thinner'
  check('a transcript is sent', guestM.remote.type(tab, words), { ok: true })
  await until(() => hostM.submits.length)
  check('the host’s pty socket gets the phone’s submit frame with enter: false, for that session', hostM.submits, [{ ptyId: 'pty-a1', text: words, enter: false }])
  check('and nothing raw: no keystrokes, so no bracketed paste and no Enter of the guest’s own', hostM.ptyInput, [])
  ok('the hub carried none of it in the clear', !hubBytes.some((b) => b.includes(Buffer.from('button blue'))))
  check('nothing to type sends nothing', [guestM.remote.type(tab, '   '), hostM.submits.length], [{ ok: true }, 1])
  check('a runaway is refused and sends nothing', [guestM.remote.type(tab, 'y'.repeat(REMOTE_TYPE_MAX + 1)).ok, hostM.submits.length], [false, 1])
  check('an unknown tab is refused', guestM.remote.type('rt-nope', 'hello').ok, false)

  // The link drops while the speech service is still working: the words come back to a tab that is not open.
  const r = relays.get(lastRelay)!
  r.host.close(1000)
  await until(() => tabOf(guestM, tab)?.state !== 'open')
  const dropped = guestM.remote.type(tab, 'spoken while the link was down')
  check('a link that dropped mid-transcript refuses it with the sentence, for the strip to keep the words', [dropped.ok, dropped.ok ? '' : dropped.message], [false, 'The link to Studio is not open, so nothing was typed there.'])
  await tick(50)
  check('and never queues them for a later connection', hostM.submits.length, 1)
  guestM.remote.close(tab)
  hostM.remote.reset()
  guestM.remote.reset()
}
{
  // A grant to watch only: served, but nothing dictated is ever sent.
  const hostM = machine(A)
  const guestM = machine(B)
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  hostM.grants = { [B.id]: { mode: 'view', label: 'Laptop', at: clock } }
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])
  const tab = await served(hostM, guestM)
  check('a tab served to watch says so', [tabOf(guestM, tab)?.state, tabOf(guestM, tab)?.mode, tabOf(guestM, tab)?.typeOnly], ['open', 'view', false])
  const res = guestM.remote.type(tab, 'let me in')
  check('dictation there is refused with the watching sentence', [res.ok, !res.ok && /watch this session, not type into it/.test(res.message)], [false, true])
  await tick(50)
  check('and the host typed nothing', hostM.submits, [])
  guestM.remote.close(tab)
  hostM.remote.reset()
  guestM.remote.reset()
}
{
  // A host from before dictation over remote tabs: it would type the words and then press Enter.
  const hostM = machine(A, { noTyping: true })
  const guestM = machine(B)
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  for (const m of [hostM, guestM]) m.remote.onOnline([A.id, B.id])
  const tab = await served(hostM, guestM)
  const res = guestM.remote.type(tab, 'do not send this')
  check('a host that never said typeOnly is sent no transcript', [tabOf(guestM, tab)?.typeOnly, res.ok, !res.ok && /older Stoke/.test(res.message)], [false, false, true])
  guestM.remote.input(tab, 'keys-still-work\r')
  await until(() => hostM.ptyInput.includes('keys-still-work\r'))
  check('while keys still reach it', [hostM.submits.length, hostM.ptyInput.includes('keys-still-work\r')], [0, true])
  guestM.remote.close(tab)
  hostM.remote.reset()
  guestM.remote.reset()
}

{
  /*
   * The wire the fake pty socket above stands in for (gotcha 31): the phone
   * server really honours `enter: false`, this machine really says `typeOnly`,
   * and the renderer's request really reaches HubRemote.type.
   */
  const src = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const server = src('src/main/remote/server.ts')
  const mainSrc = src('src/main/index.ts')
  const serviceSrc = src('src/main/hub/service.ts')
  check('the phone server types a submit with no Enter when the frame says enter: false', /msg\.type === 'submit' && typeof msg\.text === 'string'\)[\s\S]{0,240}manager\.submit\(ptyId, msg\.text, \{ enter: msg\.enter !== false \}\)/.test(server), true)
  check('this machine’s ready says typeOnly (main wires the dep)', /followsResize: true,[\s\S]{0,200}typeOnly: true,/.test(mainSrc), true)
  check('the renderer’s request reaches HubRemote.type through the service, and answers', /ipcMain\.handle\(CH\.hubRemoteType,[\s\S]{0,120}hubClient\.remoteType\(str\(tab\), str\(text\)\)/.test(mainSrc) && /remoteType\(tab: string, text: string\): HubResult \{[\s\S]{0,200}return this\.remote\.type\(tab, text\)/.test(serviceSrc), true)
}

/* ============================================================ chat history (spec 2026-10-03 §3) */

console.log('\nchat history: the host’s rules, the scope, and what may leave')
{
  const base = { sharing: true, indexOn: true, redactOn: true, grant: null as 'always' | null, once: [] as ReturnType<typeof holdOnce>, device: B.id, hostName: 'Studio', now: 1000 }
  check('not sharing: refused as not-sharing, whatever was granted', chatsAttachDecision({ ...base, sharing: false, grant: 'always' }), { t: 'refuse', code: 'not-sharing', reason: 'Studio isn’t sharing its chat history.' })
  check('chat history off: refused as history-off, whatever was granted', [chatsAttachDecision({ ...base, indexOn: false, grant: 'always' }).t, (chatsAttachDecision({ ...base, indexOn: false }) as { code?: string }).code], ['refuse', 'history-off'])
  check(
    'redaction off: refused as redaction-off (sharing paused), whatever was granted or held',
    [chatsAttachDecision({ ...base, redactOn: false, grant: 'always' }), chatsAttachDecision({ ...base, redactOn: false, once: holdOnce([], B.id, CHATS_ONCE_KEY) }).t],
    [{ t: 'refuse', code: 'redaction-off', reason: 'Studio has paused sharing its chat history: “Leave out anything that looks like an API key” is off there.' }, 'refuse']
  )
  check('a chats Always: served', chatsAttachDecision({ ...base, grant: 'always' }), { t: 'allow', via: 'always' })
  check('nothing yet: ask', chatsAttachDecision(base).t, 'ask')
  check('a chats Allow once held for this device: served', chatsAttachDecision({ ...base, once: holdOnce([], B.id, CHATS_ONCE_KEY) }), { t: 'allow', via: 'once' })
  check('a SESSION’s Allow once is not one (it is another list, keyed by pty)', chatsAttachDecision({ ...base, once: holdOnce([], B.id, 'pty-a1') }).t, 'ask')
  check('a malformed device: refused', chatsAttachDecision({ ...base, device: 'nope' }).t, 'refuse')
  check('effective only with the tick, chat history, its redaction and the vault', [
    chatsSharingEffective({ share: true, indexOn: true, redactOn: true, inVault: true }),
    chatsSharingEffective({ share: false, indexOn: true, redactOn: true, inVault: true }),
    chatsSharingEffective({ share: true, indexOn: false, redactOn: true, inVault: true }),
    chatsSharingEffective({ share: true, indexOn: true, redactOn: false, inVault: true }),
    chatsSharingEffective({ share: true, indexOn: true, redactOn: true, inVault: false })
  ], [true, false, false, false, false])
  check('what stands in the way, first one first, whatever the tick says', [
    chatsShareBlock({ indexOn: true, redactOn: true, inVault: true }),
    chatsShareBlock({ indexOn: false, redactOn: false, inVault: false }),
    chatsShareBlock({ indexOn: false, redactOn: false, inVault: true }),
    chatsShareBlock({ indexOn: true, redactOn: false, inVault: true })
  ], [null, 'not-in-vault', 'history-off', 'redaction-off'])

  // The codes a guest words itself (spec 2026-10-03; the host's sentence is only a fallback).
  check('every chats refusal code is one the wire carries, and a stray one is not a code', [CHATS_REFUSAL_CODES.every((c) => parseRelayInner(JSON.stringify({ t: 'refused', reason: 'x', code: c }))?.t === 'refused' && (parseRelayInner(JSON.stringify({ t: 'refused', reason: 'x', code: c })) as { code?: string }).code === c), isChatsRefusalCode('root'), isChatsRefusalCode(undefined)], [true, false, false])
  check(
    'the guest’s words name the HOST, never “this computer” for it',
    CHATS_REFUSAL_CODES.map((c) => chatsRefusalSentence(c, 'Studio')).filter((s) => !s.includes('Studio') || /^This computer/.test(s)),
    []
  )
  check('took back and already asking read from the guest’s side', [chatsRefusalSentence('revoked', 'Studio'), chatsRefusalSentence('busy', 'Studio')], ['Studio took back this computer’s access to its chat history.', 'Studio is already asking whether to let this computer in.'])
  check(
    'each code’s state: paused reads as not sharing, revoked and no answer as denied, the rest as errors',
    CHATS_REFUSAL_CODES.map((c) => [c, chatsRefusalState(c)]),
    [['not-sharing', 'not-sharing'], ['history-off', 'not-sharing'], ['redaction-off', 'not-sharing'], ['denied', 'denied'], ['no-answer', 'denied'], ['revoked', 'denied'], ['busy', 'error'], ['not-a-device', 'error'], ['not-in-vault', 'error'], ['disconnected', 'error'], ['query-key-shaped', 'error']]
  )

  const chats = { kind: 'chats' } as const
  const cv = (f: RelayInnerFrame): string => (relayScopeVerdict(chats, f).ok ? 'ok' : 'no')
  const get = (path: string): RelayInnerFrame => ({ t: 'req', id: 1, method: 'GET', path })
  check('a chats scope reaches the search and the open', [cv(get('/api/chats/search?q=relay&limit=50')), cv(get('/api/chats/search?q=relay')), cv(get('/api/chats/open?source=claude&id=abc-123'))], ['ok', 'ok', 'ok'])
  check('and nothing else: not the host’s name or theme, sessions, transcripts (unredacted), history, folders, projects', ['/api/host', '/api/theme', '/api/sessions', '/api/transcript?id=00000000-0000-0000-0000-000000000000', '/api/history?cwd=/', '/api/folders', '/api/projects'].map((p) => cv(get(p))), ['no', 'no', 'no', 'no', 'no', 'no', 'no'])
  check('no write, and no socket: no pty, no events', [cv({ t: 'req', id: 1, method: 'POST', path: '/api/chats/search?q=relay' }), cv({ t: 'req', id: 1, method: 'POST', path: '/api/sessions' }), cv({ t: 'ws-open', id: 1, path: '/ws?ptyId=pty-a1' }), cv({ t: 'ws-open', id: 1, path: '/ws/events' }), cv({ t: 'ws-msg', id: 1, data: '{"type":"input","data":"x"}' })], ['no', 'no', 'no', 'no', 'no'])
  check('a query outside the shape is refused: too long, limit past 50 or 0, a stray or repeated key, no q', [
    cv(get(`/api/chats/search?q=${'x'.repeat(201)}`)),
    cv(get('/api/chats/search?q=relay&limit=51')),
    cv(get('/api/chats/search?q=relay&limit=0')),
    cv(get('/api/chats/search?q=relay&cwd=/')),
    cv(get('/api/chats/search?q=a&q=b')),
    cv(get('/api/chats/search?limit=5'))
  ], ['no', 'no', 'no', 'no', 'no', 'no'])
  check('an open needs exactly a source and an id, the source a name and never a path', [cv(get('/api/chats/open?source=claude')), cv(get('/api/chats/open?source=../x&id=1')), cv(get('/api/chats/open?source=claude&id=1&x=2')), cv(get('/api/chats/open?source=claude&id=a%0Ab'))], ['no', 'no', 'no', 'no'])
  const one = { kind: 'session', ptyId: 'pty-a1' } as const
  check('a SESSION scope reaches neither chats route, under any grant', [relayScopeVerdict(one, get('/api/chats/search?q=relay')).ok, relayScopeVerdict(one, get('/api/chats/open?source=claude&id=x')).ok], [false, false])
  check('the grant’s mode lets a GET of either through: the scope is what holds', [relayFrameVerdict('view', get('/api/chats/search?q=relay')).ok, relayFrameVerdict('view', get('/api/chats/open?source=claude&id=x')).ok], [true, true])

  check('a chats attach parses; one carrying a pty, or another kind, does not', [parseRelayInner('{"t":"attach","kind":"chats"}'), parseRelayInner('{"t":"attach","kind":"chats","ptyId":"pty-a1"}'), parseRelayInner('{"t":"attach","kind":"files"}'), parseRelayInner('{"t":"attach","ptyId":"pty-a1"}')], [{ t: 'attach', kind: 'chats' }, null, null, { t: 'attach', ptyId: 'pty-a1' }])
  check('a refusal keeps a known code and drops an unknown one', [parseRelayInner('{"t":"refused","reason":"no","code":"denied"}'), parseRelayInner('{"t":"refused","reason":"no","code":"root"}')], [{ t: 'refused', reason: 'no', code: 'denied' }, { t: 'refused', reason: 'no' }])

  check('the status says chats only as the literal true; an older status reads as not sharing', [
    remoteStatusFrom({ at: 1, name: 'A', platform: 'darwin', open: false, rows: [], chats: true }).chats,
    parseRemoteStatus(JSON.stringify({ v: 1, at: 1, name: 'A', platform: 'darwin', open: false, sessions: [] }))?.chats,
    parseRemoteStatus(JSON.stringify({ v: 1, at: 1, name: 'A', platform: 'darwin', open: false, sessions: [], chats: 'yes' }))?.chats
  ], [true, false, false])

  check('a folder leaves by its last segment only, on either separator; a root names none', [folderName('/Users/v/dev/stoke'), folderName('C:\\Users\\v\\work\\proj\\'), folderName('/'), folderName('C:\\'), folderName(null)], ['stoke', 'proj', null, null, null])
  const hit = remoteChatHitFrom({ source: 'claude', nativeId: 'abc-1', title: null, firstPrompt: 'Fix the relay', cwd: '/Users/v/secret-client/stoke', updatedMs: 5, role: 'assistant', snippet: { text: 'the relay\u0007 frame', ranges: [[4, 9], [2, 3], [8, 99]] } })
  check('a hit as it leaves: folder name, the first prompt standing in for a title, a control a space, bad ranges dropped', hit, { source: 'claude', nativeId: 'abc-1', title: 'Fix the relay', folder: 'stoke', updatedMs: 5, role: 'assistant', snippet: 'the relay  frame', ranges: [[4, 9]] })
  {
    // Re-review of 62b4ae6: shaping DELETED controls, so text moved under its ranges, and a key split by one was joined.
    const moved = remoteChatHitFrom({ source: 'claude', nativeId: 'abc-1', title: null, firstPrompt: null, cwd: null, updatedMs: 5, role: 'user', snippet: { text: 'a\u0007b\rc the relay', ranges: [[10, 15]] } }, 'relay')
    check('a control before the hit: the text keeps its length and the highlight still marks the word', [moved.snippet, moved.ranges.map(([x, y]) => moved.snippet.slice(x, y))], ['a b c the relay', ['relay']])
    const long = `${'x'.repeat(994)} relaying`
    const cut = remoteChatHitFrom({ source: 'claude', nativeId: 'abc-1', title: null, firstPrompt: null, cwd: null, updatedMs: 5, role: 'user', snippet: { text: long, ranges: [[995, long.length]] } }, 'relay')
    check('a snippet cut at its cap is marked afresh: the word the cut left is still the hit', [cut.snippet.length, cut.ranges], [1000, [[995, 1000]]])
    const guest = parseRemoteChatHits({ hits: [{ ...cut, snippet: long, ranges: [[995, long.length]] }] }, 'relay')?.[0]
    check('...and the same on the guest, which marks what its own cut left', guest?.ranges, [[995, 1000]])
    const CR = `sk-ant-api03-\r${'Q7xK2m'.repeat(7).slice(0, 40)}`
    check(
      'the guest never joins what a control split: a snippet, a message',
      [parseRemoteChatHits({ hits: [{ ...hit, snippet: `key ${CR}` }] })?.[0].snippet.includes('api03- Q7xK'), parseRemoteChat({ source: 'claude', nativeId: 'abc-1', messages: [{ role: 'user', text: CR, atMs: 1 }] })?.messages[0].text.includes('api03- Q7xK')],
      [true, true]
    )
    // Review of 166e84f: an invisible character inside a word is dropped, never made a space; one that joins an emoji or a script is kept.
    const inv = remoteChatHitFrom({ source: 'claude', nativeId: 'abc-1', title: 'T\u200bitle', firstPrompt: null, cwd: null, updatedMs: 5, role: 'user', snippet: { text: 'a\u200bb c\u00add \ufeffthe relay \u{1f469}\u200d\u{1f4bb} \u0645\u06cc\u200c\u062e', ranges: [[17, 22]] } }, 'relay')
    check(
      'shaping drops an invisible character inside a word, title too, keeps an emoji’s and a script’s joiner, and marks the hit afresh',
      [inv.snippet, inv.title, inv.ranges.map(([x, y]) => inv.snippet.slice(x, y))],
      ['ab cd the relay \u{1f469}\u200d\u{1f4bb} \u0645\u06cc\u200c\u062e', 'Title', ['relay']]
    )
  }
  ok('and nothing of its path', !JSON.stringify(hit).includes('/Users') && !JSON.stringify(hit).includes('secret-client'))
  const parsed = parseRemoteChatHits({ hits: [hit, { ...hit, source: '../etc' }, { ...hit, nativeId: 'a\nb' }, { ...hit, role: 'system' }, ...Array.from({ length: 60 }, () => hit)] })
  check('another machine’s hits are checked: a bad source, id or role dropped, and only the first 50 looked at', [parsed?.length, parseRemoteChatHits({ hits: 'x' }), parseRemoteChatHits(null)], [47, null, null])
  check('a folder another machine sends as a path is cut to its name here too', parseRemoteChatHits({ hits: [{ ...hit, folder: '/home/them/very/private' }] })?.[0].folder, 'private')
  const big = 'x'.repeat(1024 * 1024)
  const chat = remoteChatFrom({ source: 'claude', title: 'T', cwd: '/Users/v/proj', createdMs: 1, updatedMs: 2, messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}${big}`, atMs: i })), partial: false, fallback: null }, 'abc-1')
  const bytes = chat.messages.reduce((n, m) => n + m.text.length, 0)
  check('a chat past 4 MiB keeps its opening and its newest, says it is partial, and fits', [chat.partial, bytes <= REMOTE_CHAT_MAX_BYTES, chat.messages[0].text[0], chat.messages[chat.messages.length - 1].text[0], chat.folder], [true, true, '0', '5', 'proj'])
  check('and comes back the same through the guest’s parse', parseRemoteChat(JSON.parse(JSON.stringify(chat)))?.messages.length, chat.messages.length)
}

console.log('\nchat history: what the relay instance reads is redacted, named by folder, and kept from hidden folders')
{
  const KEY = 'sk-ant-api03-chatcanary0123456789abcdef'
  const m = { indexOn: true, hidden: ['/Users/v/hidden'], chats: [
    { chatId: 1, source: 'claude', nativeId: 'c-1', title: `About ${KEY}`, cwd: '/Users/v/dev/stoke', text: `use the key ${KEY} for the relay` },
    { chatId: 2, source: 'codex', nativeId: 'c-2', title: 'Hidden one', cwd: '/Users/v/hidden/proj', text: 'the relay in a hidden folder' }
  ] } as unknown as Machine
  const share = sharedChats(chatAccess(m))
  const found = await answerChatsRoute(share, 'search', new URLSearchParams({ q: 'relay', limit: '50' }))
  const body = found.body as { hits: RemoteChatsResult['hits'] }
  check('a search answers its hits, the hidden folder’s left out', [found.status, body.hits.map((h) => h.nativeId)], [200, ['c-1']])
  ok('the key in the snippet and the title never leaves; folders by name', !JSON.stringify(body).includes('chatcanary') && body.hits[0].snippet.includes('[redacted]') && body.hits[0].title === 'About [redacted]' && body.hits[0].folder === 'stoke', JSON.stringify(body))
  const h0 = body.hits[0]
  check('the highlight is marked afresh on the redacted text', h0.ranges.map(([a, b]) => h0.snippet.slice(a, b)), ['relay'])
  const opened = await answerChatsRoute(share, 'open', new URLSearchParams({ source: 'claude', id: 'c-1' }))
  ok('an open answers the chat, every message redacted, the folder by name, no path', opened.status === 200 && !JSON.stringify(opened.body).includes('chatcanary') && !JSON.stringify(opened.body).includes('/Users') && (opened.body as { folder: string }).folder === 'stoke', JSON.stringify(opened.body).slice(0, 300))
  {
    const asked: string[] = []
    const base = chatAccess(m)
    const watched = sharedChats({ ...base, open: async (source, nativeId) => (asked.push(source), base.open(source, nativeId)) })
    const status = (await answerChatsRoute(watched, 'open', new URLSearchParams({ source: 'claude-x', id: 'c-1' }))).status
    check('a source no chat index knows is a missing chat, never handed to the index', [status, asked], [404, []])
  }
  check('a hidden folder’s chat answers exactly as a missing one: 404, no existence probe', [(await answerChatsRoute(share, 'open', new URLSearchParams({ source: 'codex', id: 'c-2' }))).status, (await answerChatsRoute(share, 'open', new URLSearchParams({ source: 'claude', id: 'nope' }))).status], [404, 404])
  check('bad queries are 400 at the handler too', [(await answerChatsRoute(share, 'search', new URLSearchParams({ q: 'x'.repeat(201) }))).status, (await answerChatsRoute(share, 'search', new URLSearchParams({ q: 'relay', limit: '0' }))).status, (await answerChatsRoute(share, 'open', new URLSearchParams({ source: 'claude' }))).status], [400, 400, 400])
  m.indexOn = false
  check('chat history off: nothing is read, 503', [(await answerChatsRoute(share, 'search', new URLSearchParams({ q: 'relay' }))).status, (await answerChatsRoute(share, 'open', new URLSearchParams({ source: 'claude', id: 'c-1' }))).status], [503, 503])
  m.indexOn = true
  {
    // Redaction off on this computer (review of db1ae51): rows stored then are raw and the cleaned search
    // finds none of them, so a search answered "nothing here" for a chat that is. Nothing is served instead.
    const asked: string[] = []
    const base = chatAccess(m)
    const watched = sharedChats({ ...base, search: async (q, limit) => (asked.push(q), base.search(q, limit)), open: async (s, id) => (asked.push(id), base.open(s, id)) })
    m.redactOn = false
    const s = await answerChatsRoute(watched, 'search', new URLSearchParams({ q: 'relay' }))
    const o = await answerChatsRoute(watched, 'open', new URLSearchParams({ source: 'claude', id: 'c-1' }))
    check('redaction off: search and open are 503 redaction-off, and the index is never asked', [s.status, (s.body as { code?: string }).code, o.status, (o.body as { code?: string }).code, asked], [503, 'redaction-off', 503, 'redaction-off', []])
    m.redactOn = true
  }
  {
    // Switched off WHILE the index reads (re-review of c5bfae5): dropping sharedChats' own re-check after its
    // await stayed green, as only HubRemote's check after `request` was ever driven. Here sharedChats stands
    // alone — no HubRemote, no grant — so what it read must not leave on its own word.
    const base = chatAccess(m)
    const during = (flip: () => void): ReturnType<typeof sharedChats> =>
      sharedChats({
        ...base,
        search: async (q, limit) => {
          const hits = await base.search(q, limit)
          flip()
          return hits
        },
        open: async (s, id) => {
          const t = await base.open(s, id)
          flip()
          return t
        }
      })
    const refusal = (r: { status: number; body: unknown }): [number, string | undefined, boolean] => [r.status, (r.body as { code?: string }).code, JSON.stringify(r.body).includes('relay')]
    const paused = during(() => (m.redactOn = false))
    const pausedSearch = refusal(await answerChatsRoute(paused, 'search', new URLSearchParams({ q: 'relay' })))
    m.redactOn = true
    const pausedOpen = refusal(await answerChatsRoute(paused, 'open', new URLSearchParams({ source: 'claude', id: 'c-1' })))
    m.redactOn = true
    check('redaction goes off while the index searches, then opens: each answers 503 redaction-off, and nothing it read', [pausedSearch, pausedOpen], [[503, 'redaction-off', false], [503, 'redaction-off', false]])
    const off = during(() => (m.indexOn = false))
    const offSearch = refusal(await answerChatsRoute(off, 'search', new URLSearchParams({ q: 'relay' })))
    m.indexOn = true
    const offOpen = refusal(await answerChatsRoute(off, 'open', new URLSearchParams({ source: 'claude', id: 'c-1' })))
    m.indexOn = true
    check('chat history goes off while the index searches, then opens: each answers 503 history-off, and nothing it read', [offSearch, offOpen], [[503, 'history-off', false], [503, 'history-off', false]])
    const still = during(() => undefined)
    check('(nothing switched: the same reader answers the hit and the chat)', [(await answerChatsRoute(still, 'search', new URLSearchParams({ q: 'relay' }))).status, (await answerChatsRoute(still, 'open', new URLSearchParams({ source: 'claude', id: 'c-1' }))).status], [200, 200])
  }
  check('the phone’s instance serves no chats route; only the relay’s does', [chatsRouteFor('phone', 'GET', '/api/chats/search'), chatsRouteFor('relay', 'GET', '/api/chats/search'), chatsRouteFor('relay', 'POST', '/api/chats/search')], ['none', 'search', 'none'])
}

console.log('\nchat history: a hidden chat takes no place in the answer, and nothing that looks like a key leaves as a name')
{
  // Review of db1ae51: the guest's limit was applied in the index BEFORE hidden folders were dropped, so
  // limit=1 answered nothing where limit=2 answered one hit — a hidden chat matched, and ranked first.
  const m = { indexOn: true, hidden: ['/Users/v/hidden'], chats: [
    { chatId: 1, source: 'claude', nativeId: 'h-1', title: 'Hidden first', cwd: '/Users/v/hidden/acme', text: 'quokka in a hidden folder' },
    { chatId: 2, source: 'claude', nativeId: 'v-2', title: 'Visible', cwd: '/Users/v/dev/stoke', text: 'quokka out in the open' },
    { chatId: 3, source: 'codex', nativeId: 'v-3', title: 'Visible too', cwd: '/Users/v/dev/other', text: 'another quokka' },
    { chatId: 4, source: 'claude', nativeId: 'v-4', title: 'Visible three', cwd: null, text: 'a third quokka' }
  ] } as unknown as Machine
  const share = sharedChats(chatAccess(m))
  const ids = async (limit: number): Promise<string[]> => ((await answerChatsRoute(share, 'search', new URLSearchParams({ q: 'quokka', limit: String(limit) }))).body as { hits: { nativeId: string }[] }).hits.map((h) => h.nativeId)
  check('limit=1 with the hidden chat ranked first answers the visible hit', await ids(1), ['v-2'])
  check('and every limit answers as many visible hits as there are, the hidden one never counted', [await ids(2), await ids(3), await ids(50)], [['v-2', 'v-3'], ['v-2', 'v-3', 'v-4'], ['v-2', 'v-3', 'v-4']])

  // Folder names and the tool's own ids go through the patterns too.
  const KEY = 'sk-ant-api03-foldercanary0123456789abcd'
  const n = { indexOn: true, hidden: [], chats: [
    { chatId: 5, source: 'claude', nativeId: 'n-5', title: 'Named folder', cwd: `/Users/v/${KEY}`, text: 'the wombat' },
    { chatId: 6, source: 'claude', nativeId: KEY, title: 'Keyed id', cwd: '/Users/v/dev/stoke', text: 'the wombat again' }
  ] } as unknown as Machine
  const keyed = sharedChats(chatAccess(n))
  const found = await answerChatsRoute(keyed, 'search', new URLSearchParams({ q: 'wombat' }))
  const hits = (found.body as { hits: { nativeId: string; folder: string | null }[] }).hits
  check('a folder named like a key leaves redacted; a chat whose id looks like one is not sent at all', [hits.map((h) => [h.nativeId, h.folder])], [[['n-5', '[redacted]']]])
  ok('and the key is in no byte of the answer', !JSON.stringify(found.body).includes('foldercanary'))
  const opened = await answerChatsRoute(keyed, 'open', new URLSearchParams({ source: 'claude', id: 'n-5' }))
  check('an opened chat’s folder is redacted the same way', [opened.status, (opened.body as { folder?: string }).folder], [200, '[redacted]'])
  check('and an id that looks like a key opens nothing: the 404 of a missing chat', (await answerChatsRoute(keyed, 'open', new URLSearchParams({ source: 'claude', id: KEY }))).status, 404)
}

console.log('\nchat history: what leaves goes through a generic net, and a search that looks like a key is refused')
{
  /*
   * Review of 10b0840: four rounds of provider shapes (rule set 5) still let 44 of 46 fresh secret shapes
   * through to the other computer, so the share path carries a net that knows a key by its shape alone
   * (shared/keyShaped.ts), and refuses a search shaped like one. Every key here is built at run time from a
   * seeded generator, never written out (gotcha 157).
   */
  const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const HEXA = '0123456789abcdef'
  const gen = (seed: number, n: number, alphabet = B62): string => {
    let x = (seed * 2654435761) >>> 0
    let out = ''
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x >>>= 0
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      out += alphabet[x % alphabet.length]
    }
    return out
  }
  const WG = 'Q' + gen(11, 42, B62 + '+') + '='
  const TW1 = gen(12, 32, HEXA)
  const TW2 = gen(13, 32, HEXA)
  const PYPI = 'pypi' + '-AgEIcHlwaS5vcmc' + gen(14, 120, B62 + '_-')
  const ATL = 'ATA' + 'TT3x' + gen(15, 180, B62 + '_-=')
  const AGE = 'AGE-SECRET' + '-KEY-1' + gen(16, 58, 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L')
  const ETH = '0x' + gen(17, 64, HEXA)
  const PMAK = 'PM' + 'AK-' + gen(18, 24, HEXA) + '-' + gen(19, 34, HEXA)
  const LOWER = gen(20, 24, 'abcdefghijklmnopqrstuvwxyz0123456789')
  const UPPER = gen(21, 20, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')
  const AUTH = Buffer.from('me:' + gen(22, 30)).toString('base64')
  check(
    'the net takes shapes no pattern knows: a WireGuard key, a Twilio pair, PyPI, Atlassian, age, an Ethereum key, Postman, lower- and upper-case tokens, a docker auth',
    [
      redactKeyShaped(`[Peer]\nPresharedKey = ${WG}`),
      redactKeyShaped(`client = Client("AC${TW1}", "${TW2}")`),
      redactKeyShaped(`pass ${PYPI} and jira ${ATL}`),
      redactKeyShaped(`${AGE} / my wallet key is ${ETH} / key ${PMAK}`),
      redactKeyShaped(`t=${LOWER} u=${UPPER}`),
      redactKeyShaped(`{"auths":{"ghcr.io":{"auth":"${AUTH}"}}}`)
    ],
    [
      '[Peer]\nPresharedKey = [redacted]',
      'client = Client("[redacted]", "[redacted]")',
      'pass [redacted] and jira [redacted]',
      '[redacted] / my wallet key is [redacted] / key [redacted]',
      't=[redacted] u=[redacted]',
      '{"auths":{"ghcr.io":{"auth":"[redacted]"}}}'
    ]
  )
  check(
    'a SHA-256 goes too, which a shared view accepts losing; 32+ hex goes whatever its rate; the marker is a fixed point',
    [redactKeyShaped(`sha256:${gen(23, 64, HEXA)}`), redactKeyShaped(`key 0x${'0'.repeat(30)}ab here`), redactKeyShaped('a [redacted] b')],
    ['sha256:[redacted]', 'key [redacted] here', 'a [redacted] b']
  )
  const GIT = gen(24, 40, HEXA)
  const UUID = `${gen(25, 8, HEXA)}-${gen(26, 4, HEXA)}-${gen(27, 4, HEXA)}-${gen(28, 4, HEXA)}-${gen(29, 12, HEXA)}`
  const leftAlone = [
    `commit ${GIT}, short 9ea4f06`,
    `session ${UUID}, file codex-clipboard-${UUID}.png and rollout-2026-09-28T16-02-23-${UUID}.jsonl`,
    'docs/superpowers/specs/2026-10-03-cross-machine-chats.md and node_modules/@lydell/node-pty-darwin-arm64/lib',
    'node --max-old-space-size=4096 build.js',
    'base64urlToUint8Array, pbeWithSHAAnd40BitRC2CBC, uniformMatrix2x3fv, writeBigUInt64BE, legacyFp32OnlyRanked',
    'COSC3045_Week2Lectorial_2026.pdf, realstock_20260901T080513Z, protech_windows11_usb_labels_150x100mm',
    'branch lena-full-audit-wf_3cf08d0a-e2b and 6000282863-asth24kmte-aoth24kmte-service-instructions',
    'v1.2.3-beta.4+build.567 at 2026-10-04T12:34:56.789Z',
    'TERMINAL_DEFAULTS and HTTP2_SERVER_PORT_8080 and getServerSidePropsForTheWholePage',
    'a ---------------------------------------------------------------- line'
  ]
  check('the net leaves a git commit, UUIDs, paths, flags, names with numbers, versions, dates and a rule of dashes', leftAlone.map((t) => redactKeyShaped(t)), leftAlone)
  check(
    'a base64 key cut by a / goes whole; a path beside a taken hash keeps its names; 40 hex as a URL’s user is a token, not a commit',
    [
      redactKeyShaped(`type("${'Ss' + gen(34, 5)}/${gen(35, 32)}") and type("${gen(37, 32)}/${'Xy' + gen(38, 5)}")`),
      redactKeyShaped(`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/${gen(36, 64, HEXA)}.sqlite`),
      redactKeyShaped(`git clone https://${GIT}@git.example.com/team/app.git`)
    ],
    ['type("[redacted]/[redacted]") and type("[redacted]/[redacted]")', '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/[redacted].sqlite', 'git clone https://[redacted]@git.example.com/team/app.git']
  )
  const KEY = 'Q' + gen(30, 40)
  check(
    'a run a cut end left is judged as a key’s part: a snippet that opens or closes inside a key',
    [redactKeyShaped(`…${KEY.slice(25)} said so`, { start: true, end: false }), redactKeyShaped(`it is ${KEY.slice(0, 12)}…`, { start: false, end: true }), redactKeyShaped(`…${KEY.slice(25)} said so`)],
    ['…[redacted] said so', 'it is [redacted]…', `…${KEY.slice(25)} said so`]
  )
  check('a plain name before a taken value stays: NAME=, --flag=', [redactKeyShaped(`DB_PASSWORD=${KEY} and --token=${KEY}`), redactKeyShaped(`${KEY}=${KEY}`)], ['DB_PASSWORD=[redacted] and --token=[redacted]', '[redacted]'])
  {
    // Linear: no run, separator or mixture backtracks (the suite's 64 KB rule, gotcha 156's measurements).
    const K = 64 * 1024
    const fill = (unit: string): string => unit.repeat(Math.ceil(K / unit.length)).slice(0, K)
    const worst = [gen(31, K), fill('a-'), fill('-'), fill('aA1'), fill(' '), fill('0123456789abcdef'), fill('Ab3-'), fill('a=b '), fill('…'), `${gen(32, K - 40)}${'-'.repeat(40)}`, fill('Ab3x/'), fill('a=b'), fill('a1'), 'a'.repeat(K - 1) + '1', fill('0123abcd-')]
    let slowest = 0
    for (const t of worst) {
      const t0 = performance.now()
      redactKeyShaped(t, { start: true, end: true })
      keyShapedQuery(t.slice(0, 200))
      slowest = Math.max(slowest, performance.now() - t0)
    }
    ok(`every 64 KB worst case is judged in well under a second (slowest ${slowest.toFixed(1)} ms)`, slowest < 250)
  }

  // The query: refused while it looks like a key or a code; words, file names, short ids and a 7-character git id pass.
  const refused = [KEY.slice(0, 8), 'ab3de9xy', '9f8e7d6c5b4a3210', 'deadbeefcafe0000', GIT.slice(0, 16), `${PYPI}`, `word ${KEY.slice(0, 10)} word`, KEY, `DB_PASSWORD=${KEY}`]
  const allowed = ['relay', 'stoke sessions', 'verify-hub-relay.mts', 'index2.html', 'c-1', 'PR-1234', 'issue 42', '9ea4f06', 'windows11', 'es2022', 'utf8mb4_unicode_ci', 'win32-x64', 'useState2', 'sha256 checksum', 'node20 x86_64', '2026-10-03', 'v0.9.91', 'tiếng Việt 2024', 'base64UrlEncode']
  check('a search shaped like a key or a code is refused: an opening of 8 as pasted, three changes of letter and digit, hex of 16, a key pasted whole', refused.filter((q) => !keyShapedQuery(q)), [])
  check('words, file names, short ids, a 7-character git id and names with a number are searched', allowed.filter((q) => keyShapedQuery(q)), [])
  // A key whose every word is short: only the run, judged as a shared text's would be, says it is one.
  const DASHED = [gen(41, 7), gen(42, 7), gen(43, 7), gen(44, 7)].join('-')
  check(
    '(the run test is the net’s own: what a shared text loses, a search may not ask, though each word alone could be)',
    [keyShapedRun(KEY), keyShapedQuery(KEY), keyShapedQuery(DASHED), DASHED.split('-').some((w) => keyShapedQuery(w))],
    [true, true, true, false]
  )

  // Through sharedChats: a fake index holding keys of shapes no pattern knows.
  const m = { indexOn: true, hidden: [], chats: [
    { chatId: 21, source: 'claude', nativeId: 'k-21', title: `WireGuard ${WG}`, cwd: '/Users/v/dev/vpn', text: `the netkeys peer has PresharedKey = ${WG} in it` },
    { chatId: 22, source: 'claude', nativeId: 'k-22', title: 'Twilio', cwd: '/Users/v/dev/sms', text: `netkeys client = Client("AC${TW1}", "${TW2}")` }
  ] } as unknown as Machine
  const base = chatAccess(m)
  const asked: string[] = []
  const share = sharedChats({ ...base, search: async (q, l) => (asked.push(q), base.search(q, l)) })
  const found = await answerChatsRoute(share, 'search', new URLSearchParams({ q: 'netkeys' }))
  const opened = await Promise.all(['k-21', 'k-22'].map((id) => answerChatsRoute(share, 'open', new URLSearchParams({ source: 'claude', id }))))
  const sent = JSON.stringify([found, opened])
  const runsOf = (k: string): string[] => Array.from({ length: Math.max(0, k.length - 11) }, (_, i) => k.slice(i, i + 12))
  check(
    'search and open answer, and no 12 characters in a row of any of the keys is in a byte of either',
    [found.status, (found.body as { hits: { nativeId: string }[] }).hits.map((h) => h.nativeId), opened.map((o) => o.status), [WG, TW1, TW2].flatMap(runsOf).filter((r) => sent.includes(r))],
    [200, ['k-21', 'k-22'], [200, 200], []]
  )
  check('the title and the snippet say [redacted] where the key was', [(found.body as { hits: { title: string; snippet: string }[] }).hits[0].title, (found.body as { hits: { snippet: string }[] }).hits[0].snippet], ['WireGuard [redacted]', 'the netkeys peer has PresharedKey = [redacted] in it'])
  {
    // Judged whole before the cut to shape: a title is cut at 200, which here leaves 15 of a key's 40 — too few for any test after.
    const LONG = 'Q' + gen(40, 39)
    const title = `${'word '.repeat(37)}${LONG} and more`
    const n = { indexOn: true, hidden: [], chats: [{ chatId: 23, source: 'claude', nativeId: 'k-23', title, cwd: '/Users/v/dev/long', text: 'longtitle chat' }] } as unknown as Machine
    const longShare = sharedChats(chatAccess(n))
    const hit = ((await answerChatsRoute(longShare, 'search', new URLSearchParams({ q: 'longtitle' }))).body as { hits: { title: string }[] }).hits[0]
    const read = (await answerChatsRoute(longShare, 'open', new URLSearchParams({ source: 'claude', id: 'k-23' }))).body as { title: string }
    check(
      'a key the title’s 200-character cut runs through is judged whole before the cut: none of it is sent',
      [title.indexOf(LONG) < 200 && title.indexOf(LONG) + LONG.length > 200, [hit?.title, read?.title].map((t) => runsOf(LONG).some((r) => t.includes(r.slice(0, 8)))), hit?.title.includes(' [redacted] ')],
      [true, [false, false], true]
    )
  }
  {
    // FTS cuts a snippet at any word, so one may open past a key's `-` with too little of it for the net: its `…` says so.
    const part = `${gen(45, 15)}`
    const cutShare = sharedChats({
      ...base,
      search: async () => [{ chatId: 24, source: 'claude', nativeId: 'k-24', title: 'Cut', firstPrompt: null, cwd: '/Users/v/dev/cut', updatedMs: 1, subagent: false, role: 'user', snippet: { text: `…${part} said snipcut here…`, ranges: [] } }]
    })
    const cutHit = ((await answerChatsRoute(cutShare, 'search', new URLSearchParams({ q: 'snipcut' }))).body as { hits: { snippet: string; ranges: [number, number][] }[] }).hits[0]
    check('a snippet FTS opened inside a key: what its cut left is judged as a part, and the match is marked on what is sent', [cutHit?.snippet, cutHit?.ranges.map(([x, y]) => cutHit.snippet.slice(x, y))], ['…[redacted] said snipcut here…', ['snipcut']])
  }
  asked.length = 0
  const keyAsk = await answerChatsRoute(share, 'search', new URLSearchParams({ q: WG.slice(0, 9) }))
  check('a search for a key’s opening: 400 query-key-shaped, in words for an older guest, and the index is never asked', [keyAsk.status, (keyAsk.body as { code?: string }).code, (keyAsk.body as { error?: string }).error, asked], [400, 'query-key-shaped', 'That search looks like a key or a code — search with words instead.', []])
  check('the guest says it from its side, naming the computer', chatsRefusalSentence('query-key-shaped', 'Studio'), 'That search looks like a key or a code — search Studio with words instead.')
  // The walk: every opening of the key, one character more at a time, either refused or answered with no hit on its chat.
  const walk: string[] = []
  for (let n = 3; n <= WG.length; n++) {
    for (const q of [WG.slice(0, n), WG.slice(0, n).toLowerCase()]) {
      const r = await answerChatsRoute(share, 'search', new URLSearchParams({ q }))
      const hits = r.status === 200 ? (r.body as { hits: { nativeId: string }[] }).hits.map((h) => h.nativeId) : []
      if (hits.includes('k-21')) walk.push(q.length + ':' + r.status)
    }
  }
  check('walking a key’s openings one character at a time finds its chat at no length (refused, or matched only inside [redacted])', walk, [])
  check(
    'a word seen outside a key keeps its hit; a word marked only inside one drops it',
    [matchedOnlyInKeys(`the peer ${WG} peer`, 'peer'), matchedOnlyInKeys(`the peer ${WG}`, WG.slice(0, 5)), matchedOnlyInKeys(`the peer ${WG}`, 'zzz')],
    [false, true, false]
  )
}

console.log('\nchat history between two machines: ask, allow, search, open; every request re-checked')
{
  const T = { idleMs: 60_000, waitMs: 400, retryMs: 50 }
  const hostM = machine(A, { chatsTiming: T })
  const guestM = machine(B, { chatsTiming: T })
  const SECRET = 'sk-ant-api03-searchcanary0123456789abcd'
  hostM.chats = [
    { chatId: 7, source: 'claude', nativeId: 'n-7', title: 'Relay notes', cwd: '/Users/owner/clients/acme/stoke', text: `the relay key is ${SECRET}` },
    { chatId: 8, source: 'codex', nativeId: 'n-8', title: 'Other', cwd: '/Users/owner/dev/other', text: 'nothing about it' }
  ]
  for (const mm of [hostM, guestM]) {
    mm.remote.onOnline([A.id, B.id])
    mm.remote.presenceOpened()
  }
  await until(() => last(guestM).machines[0]?.status)
  const relaysAt = (): number => relays.size
  const byDevice = (rs: RemoteChatsResult[], id: string): RemoteChatsResult | undefined => rs.find((r) => r.device === id)

  // Not sharing: said from presence, and no relay is opened for it.
  let before = relaysAt()
  let res = await guestM.remote.searchChats('relay')
  check('A not sharing: B’s search says so for A, and opens nothing', [byDevice(res, A.id)?.state, relaysAt() - before], ['not-sharing', 0])
  // What the renderer has seen of who shares, stepped from B's real view as App steps it.
  let sharers: ChatSharers = chatSharersStep(NO_CHAT_SHARERS, last(guestM)).next
  check('A online, not sharing: B has seen no computer share', [[...sharers.live], [...sharers.seen]], [[], []])
  check('so the sidebar draws no “On Studio” group at all, never an “isn’t sharing” line', remoteChatGroups({ query: 'relay', results: res }, 'relay', sharers.seen), [])
  check('even a computer that once shared gets no group while it says it does not', remoteChatGroups({ query: 'relay', results: res }, 'relay', new Set([A.id])).map((g) => g.device), [])
  check('a query under three characters asks nobody', await guestM.remote.searchChats('re'), [])

  // A ticks it: its status says chats.
  hostM.shareChats = true
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).machines[0]?.status?.chats)
  check('A shares its chat history: its status says so (and its sessions still do not show)', [last(guestM).machines[0]?.status?.chats, last(guestM).machines[0]?.status?.open], [true, false])
  let step = chatSharersStep(sharers, last(guestM))
  check('the renderer sees A start sharing: listed, and the search on screen is asked again', [[...step.next.live], [...step.next.seen], step.changed], [[A.id], [A.id], true])
  sharers = step.next
  check('the same view again moves nothing and asks nothing', [chatSharersStep(sharers, last(guestM)).next === sharers, chatSharersStep(sharers, last(guestM)).changed], [true, false])
  ok('what went over presence was sealed: no chats flag in the clear', presence.filter((p) => p.from === A.id && p.frame.t === 'status').every((p) => !JSON.stringify(p.frame).includes('"chats"')))

  // No grant: A asks, B waits, nothing is served before the answer.
  before = hostM.requests.length
  res = await guestM.remote.searchChats('relay')
  check('no grant: B’s search says waiting for A', byDevice(res, A.id)?.state, 'waiting')
  check('and the sidebar says so in the spec’s words, with no hits', remoteChatGroups({ query: 'relay', results: res }, 'relay', sharers.seen).find((g) => g.device === A.id), { device: A.id, computer: 'Studio', state: 'waiting', failed: false, hits: [], stale: false, line: 'Waiting for Studio to allow…' })
  // The viewer, opened on a hit while A's owner is still being asked: it fails as waiting, and is watched.
  const waitingOpen = await guestM.remote.openRemoteChat(A.id, 'claude', 'n-7')
  check(
    'an open while A is still reaching or asking fails as waiting, in main’s own words',
    [waitingOpen.ok, !waitingOpen.ok && waitingOpen.state, !waitingOpen.ok && remoteOpenLine('Studio', waitingOpen) === waitingOpen.message && /Studio/.test(waitingOpen.message)],
    [false, 'waiting', true]
  )
  let watch = remoteReadWatch(false, { failed: false, peer: last(guestM).chatPeers[0]?.state ?? null })
  watch = remoteReadWatch(watch.awaited, { failed: true, peer: last(guestM).chatPeers[0]?.state ?? null })
  check('the failed read waits on A’s peer: nothing read again while it is still asking', watch.reload, false)
  let cue = chatsSearchAgain(new Set(), last(guestM).chatPeers, res)
  check('while A is still asking, nothing to search again', cue.again, false)
  const ask = await until(() => last(hostM).asks[0])
  check('A asks its own question: chats, naming the device, a fingerprint, no session', [ask?.kind, ask?.label, ask?.title, ask?.ptyId, ask?.fingerprint.split(' ').length], ['chats', 'Laptop', 'chat history', '', 4])
  check('nothing reached A’s handlers before the answer', hostM.requests.length - before, 0)
  await hostM.remote.answer(ask!.id, 'once')
  await until(() => last(guestM).chatPeers[0]?.state === 'open')
  check('Allow once: B’s chats peer opens (its cue to search again)', last(guestM).chatPeers.map((p) => [p.label, p.state]), [['Studio', 'open']])
  check('and the viewer’s failed read is read again by itself, once', remoteReadWatch(watch.awaited, { failed: true, peer: last(guestM).chatPeers[0]?.state ?? null }).reload, true)
  const reopened = await guestM.remote.openRemoteChat(A.id, 'claude', 'n-7')
  check('the read again opens the chat', [reopened.ok, reopened.ok && reopened.chat.nativeId], [true, 'n-7'])
  cue = chatsSearchAgain(cue.seen, last(guestM).chatPeers, res)
  check('the renderer reads the cue: A answered, so the waiting search is asked again', cue.again, true)
  check('Allow once stored nothing, in either grant list', [hostM.chatGrants, hostM.grants], [{}, {}])
  res = await guestM.remote.searchChats('relay')
  const a = byDevice(res, A.id)
  check('once answered, the cue is spent: an open peer it has seen asks nothing more', chatsSearchAgain(cue.seen, last(guestM).chatPeers, res).again, false)
  check('the sidebar lists A’s hit under A, never merged', remoteChatGroups({ query: 'relay', results: res }, 'relay', sharers.seen).filter((g) => g.device === A.id).map((g) => [g.computer, g.line, g.hits.map((h) => h.nativeId)]), [['Studio', null, ['n-7']]])
  check(
    'typed on to a new query, A’s answer is pending: dimmed, never shown as the new query’s',
    remoteChatGroups({ query: 'relay', results: res }, 'relay notes', sharers.seen).map((g) => [g.device, g.stale]),
    [[A.id, true]]
  )
  check('B’s search answers A’s hit: folder by name, title, the match marked', [a?.state, a?.hits.map((h) => [h.nativeId, h.folder, h.title]), a?.hits[0] && a.hits[0].ranges.map(([x, y]) => a.hits[0].snippet.slice(x, y))], ['ok', [['n-7', 'stoke', 'Relay notes']], ['relay']])
  ok('the key in A’s chat never reached B, nor any path', !JSON.stringify(res).includes('searchcanary') && !JSON.stringify(res).includes('/Users') && !JSON.stringify(res).includes('acme'), JSON.stringify(res).slice(0, 400))
  ok('and the hub carried none of A’s chat text', !hubBytes.some((b) => b.includes(Buffer.from('Relay notes')) || b.includes(Buffer.from('searchcanary'))))
  check('A shows B searching its chat history, not attached to a session', last(hostM).guests.map((g) => [g.kind, g.label, g.ptyId, g.via]), [['chats', 'Laptop', null, 'once']])
  const opened = await guestM.remote.openRemoteChat(A.id, 'claude', 'n-7')
  ok('B opens the chat: read-only text, redacted, folder by name, no path', opened.ok && opened.chat.messages.length === 2 && opened.chat.folder === 'stoke' && !JSON.stringify(opened).includes('searchcanary') && !JSON.stringify(opened).includes('/Users'), JSON.stringify(opened).slice(0, 300))
  check('a chat A does not have: an error, not a crash', [(await guestM.remote.openRemoteChat(A.id, 'claude', 'missing')).ok, (await guestM.remote.openRemoteChat(A.id, '../x', 'n-7')).ok], [false, false])
  check('both went through the relay instance’s two routes only', hostM.requests.filter((r) => !r.startsWith('GET /api/chats/')).length, 0)

  // Every request is re-checked on the host: chat history switched off with no word to HubRemote.
  hostM.indexOn = false
  res = await guestM.remote.searchChats('relay')
  check('chat history off on A, unannounced: the next request is refused, not served', [byDevice(res, A.id)?.state, last(hostM).guests.length], ['not-sharing', 0])
  hostM.indexOn = true
  await tick(T.retryMs + 10)
  res = await guestM.remote.searchChats('relay')
  check('back on inside the grace, the Allow once still holds: served without a new question', [byDevice(res, A.id)?.state, last(hostM).asks.length], ['ok', 0])
  guestM.remote.endChatSearch()
  await until(() => last(hostM).guests.length === 0)
  clock += ONCE_GRACE_MS + 1

  // Always: kept on A only; then removed behind HubRemote's back, and the next request is refused.
  res = await guestM.remote.searchChats('relay')
  const askAlways = await until(() => last(hostM).asks[0])
  ok('past the grace the Allow once has lapsed: the next search asks again', !!askAlways)
  if (askAlways) await hostM.remote.answer(askAlways.id, 'always')
  await until(() => last(guestM).chatPeers[0]?.state === 'open')
  check('Always: kept in A’s chatGrants only — never A’s session grants, never on B', [hostM.chatGrants, hostM.grants, guestM.chatGrants, guestM.grants], [{ [B.id]: 'always' }, {}, {}, {}])
  check('Settings lists it with the device’s name and fingerprint', last(hostM).chatGrants.map((g) => [g.device, g.label, g.fingerprint.split(' ').length]), [[B.id, 'Laptop', 4]])
  {
    /*
     * Re-review of 62b4ae6: the index keeps a bare `\r`, so a key stored split by one is two words to every
     * secret pattern; the host's shaping then DELETED the `\r` after its patterns had run, and the key reached
     * B's viewer whole. Shaping makes a control a space now, and the patterns judge the shaped bytes:
     * `password=\r…` reads `password= …` once shaped, which the patterns take.
     *
     * Review of 166e84f: a space kept the halves apart but sent both, and split right after its prefix the
     * second "half" was the whole body (`sk-ant-api03- <40>`). The `split-key` rule takes a known prefix, a
     * line break or space and the run after it; and an invisible character inside a key (a zero-width
     * space, a soft hyphen) is dropped by shaping BEFORE the patterns judge, as a reader sees one word there.
     */
    const ANT = `sk-ant-api03-${'Q7xK2mZp9L'.repeat(4)}`
    const GH = `ghp_${'Ab1Cd2Ef3G'}${'h4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Y'.slice(0, 26)}`
    // Built from pieces (gotcha 157), each body distinct so a half of one is never found in another.
    const ZW = `${'gh' + 'p_'}${'Zq8Wv6Ut4S'}${'r2Qp0On8Ml6Kj4Ih2Gf0Ed8Cb6'.slice(0, 26)}`
    const SHY = `${'np' + 'm_'}${'Yx7Wv5Ut3Sr1Qp9On7Ml5Kj3Ih1Gf9Ed7Cb5'.slice(0, 36)}`
    const split = (k: string, at: number, by = '\r'): string => `${k.slice(0, at)}${by}${k.slice(at)}`
    hostM.chats.push({
      chatId: 9,
      source: 'claude',
      nativeId: 'n-9',
      title: `Keys password=\nCrTitle9pw ${split(SHY, 20, '\u00ad')}`,
      cwd: '/Users/owner/dev/keys',
      text: `the keys ${split(ANT, 13)} and ${split(GH, 14)} and ${split(ZW, 14, '\u200b')} and ${split(SHY, 20, '\u00ad')} then password=\rCrBelt9pw for crsplit`
    })
    res = await guestM.remote.searchChats('crsplit')
    const crHit = byDevice(res, A.id)?.hits[0]
    const crOpen = await guestM.remote.openRemoteChat(A.id, 'claude', 'n-9')
    const seen = JSON.stringify([res, crOpen])
    check(
      'a key stored split by a bare CR right after its prefix, or inside its body, reaches B in neither half: search and open',
      [crHit?.nativeId, seen.includes(ANT), seen.includes(GH), seen.includes(ANT.slice(13, 25)), seen.includes(ANT.slice(-12)), seen.includes(GH.slice(4, 14)), seen.includes(GH.slice(14))],
      ['n-9', false, false, false, false, false, false]
    )
    check(
      'a key split by an invisible character (a zero-width space, a soft hyphen) reaches B in neither half: search, open and title',
      [seen.includes(ZW.slice(4, 14)), seen.includes(ZW.slice(14)), seen.includes(SHY.slice(4, 20)), seen.includes(SHY.slice(20)), /[\u00ad\u200b]/.test(seen)],
      [false, false, false, false, false]
    )
    check(
      'what the patterns judged is what was sent: a value a CR kept from its name is taken once shaped, title too',
      [seen.includes('CrBelt9pw'), seen.includes('CrTitle9pw'), crHit?.snippet.includes('password= [redacted]'), crHit?.title, crOpen.ok && crOpen.chat.title],
      [false, false, true, 'Keys password= [redacted] [redacted]', 'Keys password= [redacted] [redacted]']
    )
    check('and the hit is marked on the text that was sent', crHit && crHit.ranges.map(([x, y]) => crHit.snippet.slice(x, y)), ['crsplit'])
    hostM.chats.pop()
  }
  {
    // Review of 10b0840: a search shaped like a key is refused by A per request, and B words it from its side.
    const before = hostM.requests.length
    res = await guestM.remote.searchChats(`${'Ab3d' + 'E9xYq2'}`)
    const r = byDevice(res, A.id)
    check(
      'a search that looks like a key reaches A and is refused there: B says so in its own words, naming A, and the relay stays open',
      [r?.state, r?.code, r?.message, remoteChatGroups({ query: 'x', results: res }, 'x', new Set([A.id]))[0]?.line, hostM.requests.length - before, last(guestM).chatPeers[0]?.state],
      ['error', 'query-key-shaped', 'That search looks like a key or a code — search Studio with words instead.', 'That search looks like a key or a code — search Studio with words instead.', 1, 'open']
    )
  }
  hostM.chatGrants = {}
  res = await guestM.remote.searchChats('relay')
  check('the grant gone from A’s settings: the next request is refused as denied', byDevice(res, A.id)?.state, 'denied')
  await tick(T.retryMs + 10)
  check('and a denial stands for the rest of the search, past the retry wait: no new question for A', [byDevice(await guestM.remote.searchChats('relay'), A.id)?.state, last(hostM).asks.length], ['denied', 0])
  guestM.remote.endChatSearch()
  check('the search box closed: B holds no chats relay', last(guestM).chatPeers.length, 0)

  // A session grant never opens chats, and a chats grant never a session.
  hostM.grants = { [B.id]: { mode: 'full', label: 'Laptop', at: 1 } }
  hostM.sharing = true
  hostM.sessions = [stubRow()]
  hostM.remote.sharingChanged()
  await guestM.remote.searchChats('relay')
  const askWithSessionGrant = await until(() => last(hostM).asks[0])
  check('B holding a SESSION Always: a chats relay is still asked about', askWithSessionGrant?.kind, 'chats')
  await hostM.remote.answer(askWithSessionGrant!.id, 'deny')
  guestM.remote.endChatSearch()
  hostM.grants = {}
  hostM.chatGrants = { [B.id]: 'always' }
  const sessionTab = guestM.remote.open(A.id, 'pty-a1')
  const askSession = await until(() => last(hostM).asks[0])
  check('B holding a CHATS Always: opening a session is still asked about', [askSession?.kind, askSession?.ptyId], ['session', 'pty-a1'])
  await hostM.remote.answer(askSession!.id, 'deny')
  if (sessionTab.ok) guestM.remote.close(sessionTab.tab)

  // A rogue guest under a chats grant reaching past its two routes; and a session relay reaching for chats.
  const rogue = await rogueChannel(hostM, B)
  rogue.ch.send({ t: 'attach', kind: 'chats' })
  await until(() => rogue.got.some((f) => f.t === 'ready'))
  check('under a chats Always the host serves at once, read-only', (rogue.got.find((f) => f.t === 'ready') as { mode?: string } | undefined)?.mode, 'view')
  const requestsBefore = hostM.requests.length
  const socketsBefore = hostM.sockets.length
  rogue.ch.send({ t: 'ws-open', id: 1, path: '/ws?ptyId=pty-a1' })
  rogue.ch.send({ t: 'req', id: 2, method: 'GET', path: '/api/host' })
  rogue.ch.send({ t: 'req', id: 3, method: 'GET', path: '/api/sessions' })
  rogue.ch.send({ t: 'req', id: 4, method: 'GET', path: '/api/transcript?id=00000000-0000-0000-0000-000000000000' })
  rogue.ch.send({ t: 'req', id: 5, method: 'POST', path: '/api/sessions', body: { cwd: '/tmp' } })
  rogue.ch.send({ t: 'req', id: 6, method: 'GET', path: '/api/chats/search?q=relay&cwd=/' })
  rogue.ch.send({ t: 'req', id: 7, method: 'GET', path: '/api/chats/search?q=relay' })
  await until(() => rogue.got.some((f) => f.t === 'res' && f.id === 7))
  const st = (id: number): number | undefined => (rogue.got.find((f) => f.t === 'res' && f.id === id) as { status?: number } | undefined)?.status
  check('a chats relay gets no pty socket and 403 for the host, sessions, transcripts, a new session and a bent query', [!!rogue.got.find((f) => f.t === 'ws-close' && f.id === 1), [2, 3, 4, 5, 6].map(st), st(7)], [true, [403, 403, 403, 403, 403], 200])
  check('and only its one search reached the handlers', [hostM.requests.slice(requestsBefore), hostM.sockets.length - socketsBefore], [['GET /api/chats/search?q=relay'], 0])
  rogue.ch.close('done')
  hostM.chatGrants = {}
  hostM.grants = { [B.id]: { mode: 'full', label: 'Laptop', at: 1 } }
  const sessionRogue = await rogueChannel(hostM, B)
  sessionRogue.ch.send({ t: 'attach', ptyId: 'pty-a1' })
  await until(() => sessionRogue.got.some((f) => f.t === 'ready'))
  const before2 = hostM.requests.length
  sessionRogue.ch.send({ t: 'req', id: 9, method: 'GET', path: '/api/chats/search?q=relay' })
  sessionRogue.ch.send({ t: 'req', id: 10, method: 'GET', path: '/api/chats/open?source=claude&id=n-7' })
  sessionRogue.ch.send({ t: 'req', id: 11, method: 'GET', path: '/api/host' })
  await until(() => sessionRogue.got.some((f) => f.t === 'res' && f.id === 11))
  const st2 = (id: number): number | undefined => (sessionRogue.got.find((f) => f.t === 'res' && f.id === id) as { status?: number } | undefined)?.status
  check('a SESSION relay under a session Always gets 403 for both chats routes', [st2(9), st2(10), hostM.requests.slice(before2)], [403, 403, ['GET /api/host']])
  sessionRogue.ch.close('done')
  hostM.grants = {}

  // The switch off closes every chats relay, at once, without the guest searching again.
  hostM.chatGrants = { [B.id]: 'always' }
  await guestM.remote.searchChats('relay')
  await until(() => last(guestM).chatPeers[0]?.state === 'open' && last(hostM).guests.some((g) => g.kind === 'chats'))
  ok('(B is searching A under Always)', last(hostM).guests.some((g) => g.kind === 'chats'))
  // The SESSIONS tick and a session Always are another scope: neither ends a chats search.
  hostM.grants = { [B.id]: { mode: 'full', label: 'Laptop', at: 1 } }
  await hostM.remote.revokeGrant(B.id)
  hostM.sharing = false
  hostM.remote.sharingChanged()
  await tick(30)
  const okRes = await guestM.remote.searchChats('relay')
  check('the sessions tick off, and a session Always taken back, leave B’s chats search open', [last(guestM).chatPeers[0]?.state, last(hostM).guests.filter((g) => g.kind === 'chats').length, byDevice(okRes, A.id)?.state], ['open', 1, 'ok'])
  sharers = chatSharersStep(sharers, last(guestM)).next
  hostM.shareChats = false
  hostM.chatGrants = {} // as HubService.setShareChats(false) commits it
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).chatPeers[0]?.state === 'not-sharing')
  check('A turns it off: B’s relay is closed by A, not at B’s next keystroke', [last(guestM).chatPeers[0]?.state, last(hostM).guests.filter((g) => g.kind === 'chats').length], ['not-sharing', 0])
  await until(() => last(guestM).machines[0]?.status?.chats === false)
  step = chatSharersStep(sharers, last(guestM))
  check(
    'A seen to stop sharing mid-search: its group with hits goes at once, and the search is asked again',
    [remoteChatGroups({ query: 'relay', results: okRes }, 'relay', sharers.seen).map((g) => g.device), remoteChatGroups({ query: 'relay', results: okRes }, 'relay', step.next.seen), step.changed],
    [[A.id], [], true]
  )
  sharers = step.next
  before = relaysAt()
  await tick(T.retryMs + 10)
  res = await guestM.remote.searchChats('relay')
  check('and A’s status says so: B’s next search opens nothing', [byDevice(res, A.id)?.state, relaysAt() - before], ['not-sharing', 0])

  // A question waiting when the switch goes off goes with it.
  hostM.shareChats = true
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).machines[0]?.status?.chats === true)
  await tick(T.retryMs + 10)
  void guestM.remote.searchChats('relay')
  await until(() => last(hostM).asks[0])
  hostM.shareChats = false
  hostM.remote.chatSharingChanged()
  check('the tick off with a question up: the question goes too', last(hostM).asks.length, 0)

  // A device the chain no longer holds: refused at its next request even before the hook, and its grant taken back by it.
  hostM.shareChats = true
  hostM.chatGrants = { [B.id]: 'always' }
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).machines[0]?.status?.chats === true)
  await tick(T.retryMs + 10)
  await guestM.remote.searchChats('relay')
  await until(() => last(guestM).chatPeers[0]?.state === 'open')
  hostM.active = [A]
  before = hostM.requests.length
  res = await guestM.remote.searchChats('relay')
  check('B removed from A’s chain, before any hook ran: its next search is refused and reads nothing', [byDevice(res, A.id)?.state !== 'ok', hostM.requests.length - before], [true, 0])
  hostM.remote.chainChanged()
  await until(() => Object.keys(hostM.chatGrants).length === 0)
  check('the chain moved: B’s chats Always is taken back', hostM.chatGrants, {})
  hostM.active = [...ACTIVE]

  // Offline: said from presence, never reached.
  sharers = chatSharersStep(sharers, last(guestM)).next
  guestM.remote.onOnline([B.id])
  step = chatSharersStep(sharers, last(guestM))
  check('A goes offline while sharing: still listed as seen sharing, and the search is asked again', [[...step.next.live], [...step.next.seen], step.changed], [[], [A.id], true])
  sharers = step.next
  before = relaysAt()
  res = await guestM.remote.searchChats('relay')
  check('the sidebar: “Studio is offline — not searched”', remoteChatGroups({ query: 'relay', results: res }, 'relay', sharers.seen).find((g) => g.device === A.id)?.line, 'Studio is offline — not searched')
  check('but no offline line for a computer this window never saw share', remoteChatGroups({ query: 'relay', results: res }, 'relay', new Set()), [])
  const offlineOpen = await guestM.remote.openRemoteChat(A.id, 'claude', 'n-7')
  check(
    'opening A’s chat while it is offline has its own sentence, not the search’s',
    [offlineOpen.ok, !offlineOpen.ok && offlineOpen.state, !offlineOpen.ok && remoteOpenLine('Studio', offlineOpen)],
    [false, 'offline', 'Studio is offline — open it again when it’s back.']
  )
  check('A offline: B says so for A, opens nothing, and keeps nothing', [byDevice(res, A.id)?.state, byDevice(res, A.id)?.message, relaysAt() - before, byDevice(res, A.id)?.hits], ['offline', 'Studio is offline — not searched.', 0, []])
  guestM.remote.onOnline([A.id, B.id])

  // Idle: the relays close by themselves.
  const idleHost = machine(A, { chatsTiming: T })
  const idleGuest = machine(B, { chatsTiming: { ...T, idleMs: 150 } })
  idleHost.chats = hostM.chats
  idleHost.shareChats = true
  idleHost.chatGrants = { [B.id]: 'always' }
  for (const mm of [idleHost, idleGuest]) {
    mm.remote.onOnline([A.id, B.id])
    mm.remote.presenceOpened()
  }
  await until(() => last(idleGuest).machines[0]?.status?.chats)
  const fresh = await idleGuest.remote.searchChats('relay')
  check('(a fresh pair: B searches A under Always)', byDevice(fresh, A.id)?.state, 'ok')
  check('a peer the search itself opened, already answered ok, asks for no second search', [last(idleGuest).chatPeers.map((p) => p.state), chatsSearchAgain(new Set(), last(idleGuest).chatPeers, fresh).again], [['open'], false])
  await until(() => last(idleGuest).chatPeers.length === 0 && last(idleHost).guests.length === 0, 2000)
  check('left idle, B closes its chats relay and A stops showing it', [last(idleGuest).chatPeers.length, last(idleHost).guests.length], [0, 0])
  check('and a relay closed for idleness asks for no search: a query left in the box keeps nothing open', chatsSearchAgain(new Set([`${A.id}:open`]), last(idleGuest).chatPeers, [{ device: A.id, label: 'Studio', platform: 'darwin', state: 'waiting', message: null, hits: [] }]).again, false)

  for (const mm of [hostM, guestM, idleHost, idleGuest]) mm.remote.reset()
}

console.log('\nchat history: redaction off pauses sharing; a Remove, a grant taken back, and the guest’s own words (review of db1ae51)')
{
  const T = { idleMs: 60_000, waitMs: 400, retryMs: 50, requestMs: 2000 }
  const hostM = machine(A, { chatsTiming: T })
  const guestM = machine(B, { chatsTiming: T })
  hostM.chats = [{ chatId: 9, source: 'claude', nativeId: 'p-9', title: 'Paused notes', cwd: '/Users/owner/dev/stoke', text: 'the platypus plan' }]
  hostM.shareChats = true
  hostM.chatGrants = { [B.id]: 'always' }
  for (const mm of [hostM, guestM]) {
    mm.remote.onOnline([A.id, B.id])
    mm.remote.presenceOpened()
  }
  await until(() => last(guestM).machines[0]?.status?.chats)
  const byA = (rs: RemoteChatsResult[]): RemoteChatsResult | undefined => rs.find((r) => r.device === A.id)
  const chatsGuests = (): number => last(hostM).guests.filter((g) => g.kind === 'chats').length
  const servedNow = async (): Promise<void> => {
    await guestM.remote.searchChats('platypus')
    await until(() => last(guestM).chatPeers[0]?.state === 'open' && chatsGuests() === 1)
  }

  // 2. Redaction off: before, A still said `chats: true`, served the relay, and the cleaned search found
  // nothing — B was told "Nothing on Studio says …" while A's row said On.
  await servedNow()
  ok('(B is searching A under Always)', chatsGuests() === 1)
  check('with everything on, A says sharing is in force and nothing is in the way', [last(hostM).chatsEffective, last(hostM).chatsBlocked], [true, null])
  hostM.redactOn = false
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).chatPeers[0]?.state === 'not-sharing')
  check('redaction off on A: B’s relay is closed by A at once, as a pause, in B’s own words', [chatsGuests(), last(guestM).chatPeers.map((p) => [p.state, p.code, p.message])], [0, [['not-sharing', 'redaction-off', 'Studio has paused sharing its chat history: “Leave out anything that looks like an API key” is off there.']]])
  check('A’s own view: the tick still on, not in force, paused by redaction (what the row shows)', [last(hostM).sharingChats, last(hostM).chatsEffective, last(hostM).chatsBlocked], [true, false, 'redaction-off'])
  const pausedRow = shareChatsRow({ phase: 'active', chatIndexOn: true, redactOn: hostM.redactOn, sharing: last(hostM).sharingChats, grants: ['Laptop'], paused: sharePausedOf(last(hostM)) })
  check('and the row, reading main’s pause off that view (sharePausedOf), says it in the spec’s words', [pausedRow.paused, pausedRow.hint], [true, CHATS_PAUSED_SENTENCE])
  await until(() => last(guestM).machines[0]?.status?.chats === false)
  check('A advertises nothing: its status stops saying chats', last(guestM).machines[0]?.status?.chats, false)
  let before = relays.size
  const reqBefore = hostM.requests.length
  await tick(T.retryMs + 10)
  const res = await guestM.remote.searchChats('platypus')
  check('B’s next search opens nothing and reads nothing on A', [byA(res)?.state, relays.size - before, hostM.requests.length - reqBefore], ['not-sharing', 0, 0])
  const rogue = await rogueChannel(hostM, B)
  rogue.ch.send({ t: 'attach', kind: 'chats' })
  await until(() => rogue.got.some((f) => f.t === 'refused'))
  check('a guest that asks anyway, under its Always, is refused as redaction-off and served nothing', [(rogue.got.find((f) => f.t === 'refused') as { code?: string } | undefined)?.code, rogue.got.some((f) => f.t === 'ready'), hostM.requests.length - reqBefore], ['redaction-off', false, 0])
  // A question waiting when redaction goes off goes with it.
  hostM.redactOn = true
  hostM.chatGrants = {}
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).machines[0]?.status?.chats === true)
  await tick(T.retryMs + 10)
  void guestM.remote.searchChats('platypus')
  await until(() => last(hostM).asks[0])
  hostM.redactOn = false
  hostM.remote.chatSharingChanged()
  check('redaction off with a question up: the question goes too', last(hostM).asks.length, 0)
  // Unannounced (no hook): the next request on a served relay is refused, not answered.
  hostM.redactOn = true
  hostM.chatGrants = { [B.id]: 'always' }
  hostM.remote.chatSharingChanged()
  guestM.remote.endChatSearch()
  await until(() => last(guestM).machines[0]?.status?.chats === true)
  await servedNow()
  hostM.redactOn = false
  const unannounced = await guestM.remote.searchChats('platypus')
  check('redaction off with no word to HubRemote: the next request is refused, said as a pause', [byA(unannounced)?.state, byA(unannounced)?.code, chatsGuests()], ['not-sharing', 'redaction-off', 0])
  hostM.redactOn = true
  hostM.remote.chatSharingChanged()
  guestM.remote.endChatSearch()
  await until(() => last(guestM).machines[0]?.status?.chats === true)
  // And while the handler is reading: the grant goes from A's settings (no hook told HubRemote). What the
  // handler read is not sent, and the guest is told why at once rather than left to time out.
  await servedNow()
  hostM.duringRequest = () => {
    hostM.chatGrants = {}
  }
  // A silent drop would leave B to time out (`requestMs`) and read `error` with no code: the state and code say which.
  const midway = await guestM.remote.searchChats('platypus')
  check('the grant gone while a search is being answered: nothing it read is sent, refused as revoked', [byA(midway)?.state, byA(midway)?.code, byA(midway)?.hits.length], ['denied', 'revoked', 0])
  hostM.chatGrants = { [B.id]: 'always' }
  guestM.remote.endChatSearch()
  await tick(T.retryMs + 10)

  // 3a. Remove (Settings): a served relay to that device ends at once, with no new search from it — with the press,
  // not when the settings write lands (re-review of c5bfae5: awaiting the write first stayed green while every
  // write here resolved at once, so the write is held open until the relay is seen gone).
  await servedNow()
  // A renamed itself since B last heard: the host's fallback sentence names "Studio (desk)", and B words the code itself.
  hostM.selfLabel = 'Studio (desk)'
  let landWrite: () => void = () => undefined
  hostM.chatGrantOffWrite = new Promise<void>((r) => (landWrite = r))
  let written = false
  const removing = hostM.remote.revokeChatGrant(B.id).then(() => (written = true))
  await tick(20)
  check('Remove ends B’s live relay while its settings write is still pending: A shows no guest', [written, chatsGuests()], [false, 0])
  await until(() => last(guestM).chatPeers[0]?.state === 'denied')
  check(
    'and B’s peer is denied as revoked, in B’s own words for the code, without B searching again — the write still pending',
    [written, last(guestM).chatPeers.map((p) => [p.state, p.code, p.message])],
    [false, [['denied', 'revoked', 'Studio took back this computer’s access to its chat history.']]]
  )
  landWrite()
  await removing
  hostM.chatGrantOffWrite = undefined
  check('and once the write lands, the grant is gone from A', [written, hostM.chatGrants], [true, {}])
  hostM.selfLabel = undefined
  guestM.remote.endChatSearch()

  // 3b. Always answered, and the chain moves while the grant is being written: taken back, nothing served.
  void guestM.remote.searchChats('platypus')
  const ask = await until(() => last(hostM).asks[0])
  hostM.duringGrant = () => {
    hostM.active = [A]
  }
  const answered = ask ? await hostM.remote.answer(ask.id, 'always') : { ok: true }
  check('B removed from A’s chain during the Always write: the grant is taken back, nothing served', [answered.ok, hostM.chatGrants, chatsGuests()], [false, {}, 0])
  hostM.active = [...ACTIVE]
  guestM.remote.endChatSearch()
  await tick(T.retryMs + 10)
  // The same with redaction going off during the write.
  void guestM.remote.searchChats('platypus')
  const ask2 = await until(() => last(hostM).asks[0])
  hostM.duringGrant = () => {
    hostM.redactOn = false
  }
  const answered2 = ask2 ? await hostM.remote.answer(ask2.id, 'always') : { ok: true }
  await until(() => last(guestM).chatPeers[0]?.state === 'not-sharing')
  check('redaction off during the Always write: taken back, refused as a pause', [answered2.ok, hostM.chatGrants, chatsGuests(), last(guestM).chatPeers[0]?.code], [false, {}, 0, 'redaction-off'])
  hostM.redactOn = true
  guestM.remote.endChatSearch()

  // Its sessions twin: a session Always answered while the chain drops the guest.
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  hostM.remote.sharingChanged()
  const tabOpen = guestM.remote.open(A.id, 'pty-a1')
  const askSession = await until(() => last(hostM).asks.find((a) => a.kind === 'session'))
  hostM.duringGrant = () => {
    hostM.active = [A]
  }
  const answered3 = askSession ? await hostM.remote.answer(askSession.id, 'always') : { ok: true }
  check('a session Always written while the chain drops B: taken back, never served', [answered3.ok, hostM.grants, last(hostM).guests.length], [false, {}, 0])
  hostM.active = [...ACTIVE]
  if (tabOpen.ok) guestM.remote.close(tabOpen.tab)

  // "Already asking": the host's code, not its sentence about itself.
  hostM.chatGrants = {}
  const first = await rogueChannel(hostM, B)
  first.ch.send({ t: 'attach', kind: 'chats' })
  await until(() => last(hostM).asks.some((a) => a.kind === 'chats'))
  const second = await rogueChannel(hostM, B)
  second.ch.send({ t: 'attach', kind: 'chats' })
  await until(() => second.got.some((f) => f.t === 'refused'))
  const busy = second.got.find((f) => f.t === 'refused') as { code?: string; reason?: string } | undefined
  check('a second chats relay while one is asked about: refused with the busy code, its fallback naming the host', [busy?.code, busy?.reason], ['busy', 'Studio is already asking whether to let this computer in.'])
  first.ch.close('done')
  second.ch.close('done')
  for (const mm of [hostM, guestM]) mm.remote.reset()
}

console.log('\nthe chain moves under a serving host: the guest removed is told so, and a host that left the vault says it left (re-review of c5bfae5)')
{
  // `chainChanged` words the refusal by whose leaving it is: `not-a-device` while this host is in the vault and its
  // chain dropped the guest, `not-in-vault` once this host itself has no context. Forced to always send
  // `not-a-device`, every case stayed green: the codes were never read.
  const T = { idleMs: 60_000, waitMs: 400, retryMs: 50, requestMs: 2000 }
  const hostM = machine(A, { chatsTiming: T })
  const guestM = machine(B, { chatsTiming: T })
  hostM.chats = [{ chatId: 11, source: 'claude', nativeId: 'v-11', title: 'Vault notes', cwd: '/Users/owner/dev/stoke', text: 'the numbat notes' }]
  hostM.sessions = [stubRow()]
  hostM.sharing = true
  hostM.shareChats = true
  for (const mm of [hostM, guestM]) {
    mm.remote.onOnline([A.id, B.id])
    mm.remote.presenceOpened()
  }
  await until(() => last(guestM).machines[0]?.status?.chats)
  const byA = (rs: RemoteChatsResult[]): RemoteChatsResult | undefined => rs.find((r) => r.device === A.id)
  /** B searching A's chats under Always, and a raw B attached to A's session under Always (the raw end keeps every frame, codes included). */
  const servedBoth = async (): Promise<Awaited<ReturnType<typeof rogueChannel>>> => {
    hostM.chatGrants = { [B.id]: 'always' }
    hostM.grants = { [B.id]: { mode: 'full', label: 'Laptop', at: 1 } }
    guestM.remote.endChatSearch()
    await tick(T.retryMs + 10)
    check('(B searches A under Always)', byA(await guestM.remote.searchChats('numbat'))?.state, 'ok')
    const raw = await rogueChannel(hostM, B)
    raw.ch.send({ t: 'attach', ptyId: 'pty-a1' })
    await until(() => raw.got.some((f) => f.t === 'ready'))
    check('(and B is attached to A’s session: A serves both)', last(hostM).guests.map((g) => g.kind).sort(), ['chats', 'session'])
    return raw
  }
  const refusedOf = (raw: Awaited<ReturnType<typeof rogueChannel>>): [string | undefined, string | undefined] => {
    const f = raw.got.find((x) => x.t === 'refused') as { code?: string; reason?: string } | undefined
    return [f?.code, f?.reason]
  }

  // A's chain drops B: it is B that is no longer a device.
  const raw1 = await servedBoth()
  hostM.active = [A]
  hostM.remote.chainChanged()
  await until(() => last(guestM).chatPeers[0]?.state === 'error' && raw1.got.some((f) => f.t === 'refused'))
  check('B dropped from A’s chain: B’s chats peer is told B is no longer a device, by code, in B’s own words', last(guestM).chatPeers.map((p) => [p.state, p.code, p.message]), [['error', 'not-a-device', 'Studio no longer counts this computer as one of your devices.']])
  const [code1, reason1] = refusedOf(raw1)
  check('and B’s session relay is refused as not-a-device', [code1, /no longer one of this account/.test(reason1 ?? '')], ['not-a-device', true])
  check('A serves neither any more', last(hostM).guests.length, 0)
  hostM.active = [...ACTIVE]

  // A itself leaves the vault (revoked, signed out): no context. It is A that went, not B.
  const raw2 = await servedBoth()
  hostM.out = true
  hostM.remote.chainChanged()
  await until(() => last(guestM).chatPeers[0]?.state === 'error' && raw2.got.some((f) => f.t === 'refused'))
  check('A leaves the vault: B’s chats peer is told A left, by code, in B’s own words — never that B was removed', last(guestM).chatPeers.map((p) => [p.state, p.code, p.message]), [['error', 'not-in-vault', 'Studio is no longer in your hub’s vault.']])
  check('and B’s session relay is refused as not-in-vault, its sentence about A', refusedOf(raw2), ['not-in-vault', 'That computer is no longer in your hub’s vault.'])
  check('A serves neither any more', last(hostM).guests.length, 0)
  hostM.out = false
  for (const mm of [hostM, guestM]) mm.remote.reset()
}

console.log('\nchat history: a pause undone inside the retry wait is searched afresh (re-drive of 62b4ae6)')
{
  // A retry wait far longer than the case, so only a newer status can bring A back: the waits above use 50 ms,
  // which hid it. Driven end to end, redaction turned off and on again within CHATS_RETRY_MS left the
  // sidebar's open search answered from the old refusal — no group for A — until the owner typed again.
  const T = { idleMs: 60_000, waitMs: 400, retryMs: 60_000, requestMs: 2000 }
  const hostM = machine(A, { chatsTiming: T })
  const guestM = machine(B, { chatsTiming: T })
  hostM.chats = [{ chatId: 9, source: 'claude', nativeId: 'p-9', title: 'Paused notes', cwd: '/Users/owner/dev/stoke', text: 'the platypus plan' }]
  hostM.shareChats = true
  hostM.chatGrants = { [B.id]: 'always' }
  for (const mm of [hostM, guestM]) {
    mm.remote.onOnline([A.id, B.id])
    mm.remote.presenceOpened()
  }
  await until(() => last(guestM).machines[0]?.status?.chats)
  const byA = (rs: RemoteChatsResult[]): RemoteChatsResult | undefined => rs.find((r) => r.device === A.id)
  check('(B searches A under Always)', byA(await guestM.remote.searchChats('platypus'))?.state, 'ok')
  hostM.redactOn = false
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).chatPeers[0]?.state === 'not-sharing' && last(guestM).machines[0]?.status?.chats === false)
  const relaysBefore = relays.size
  hostM.redactOn = true
  hostM.remote.chatSharingChanged()
  await until(() => last(guestM).machines[0]?.status?.chats === true)
  check('A says it shares again: the refused peer goes with the newer status, not after the retry wait', last(guestM).chatPeers.length, 0)
  const back = await guestM.remote.searchChats('platypus')
  check('and the search asked again on that status reaches A afresh: its hit, over a new relay', [byA(back)?.state, byA(back)?.hits.length, relays.size > relaysBefore], ['ok', 1, true])
  // A Deny is not a status's to undo: it stands until the search ends, whatever A says next.
  hostM.chatGrants = {}
  hostM.remote.chatSharingChanged()
  guestM.remote.endChatSearch()
  void guestM.remote.searchChats('platypus')
  const ask = await until(() => last(hostM).asks.find((a) => a.kind === 'chats'))
  if (ask) await hostM.remote.answer(ask.id, 'deny')
  await until(() => last(guestM).chatPeers[0]?.state === 'denied')
  const atBefore = last(guestM).machines[0]?.status?.at ?? 0
  hostM.remote.chatSharingChanged() // a forced publish: a newer status, still saying chats
  await until(() => (last(guestM).machines[0]?.status?.at ?? 0) > atBefore && last(guestM).machines[0]?.status?.chats === true)
  await tick(30)
  check('a Deny stands through a newer status from A', [last(guestM).chatPeers[0]?.state, byA(await guestM.remote.searchChats('platypus'))?.state, last(hostM).asks.length], ['denied', 'denied', 0])
  for (const mm of [hostM, guestM]) mm.remote.reset()
}

console.log('\nchat history: a read lost mid-way, and how the viewer says it once that computer is offline (re-drive of 62b4ae6)')
{
  // Driven end to end: A quit while B read one of its chats, and B's viewer said "the relay closed" — the
  // channel's diagnostic, lower case, naming no one — while the sidebar beside it said A was offline.
  const T = { idleMs: 60_000, waitMs: 400, retryMs: 50, requestMs: 2000 }
  const hostM = machine(A, { chatsTiming: T })
  const guestM = machine(B, { chatsTiming: T })
  hostM.chats = [{ chatId: 9, source: 'claude', nativeId: 'p-9', title: 'Lost notes', cwd: '/Users/owner/dev/stoke', text: 'the platypus plan' }]
  hostM.shareChats = true
  hostM.chatGrants = { [B.id]: 'always' }
  for (const mm of [hostM, guestM]) {
    mm.remote.onOnline([A.id, B.id])
    mm.remote.presenceOpened()
  }
  await until(() => last(guestM).machines[0]?.status?.chats)
  await guestM.remote.searchChats('platypus')
  await until(() => last(guestM).chatPeers[0]?.state === 'open')
  hostM.duringRequest = () => {
    // A quits mid-read: its end of the relay goes, and the hub closes B's.
    for (const r of relays.values()) if (r.hostDevice === A.id && r.host.readyState === 1) r.host.close(1001)
  }
  const lost = await guestM.remote.openRemoteChat(A.id, 'claude', 'p-9')
  check(
    'a read whose relay ends mid-way: an error in this computer’s words, naming A, with no refusal code',
    [lost.ok, !lost.ok && lost.state, !lost.ok && lost.message, !lost.ok && lost.code],
    [false, 'error', 'Lost the connection to Studio: the relay closed', null]
  )
  const failed = lost.ok ? { state: 'error' as const, message: '', code: null } : lost
  check(
    'the viewer’s line: main’s sentence while A is online or unknown, the offline one once presence says A left',
    [remoteReadLine('Studio', failed, true), remoteReadLine('Studio', failed, null), remoteReadLine('Studio', failed, false)],
    ['Lost the connection to Studio: the relay closed', 'Lost the connection to Studio: the relay closed', 'Studio is offline — open it again when it’s back.']
  )
  check(
    'a refusal and a wait stand as they are, offline or not',
    [
      remoteReadLine('Studio', { state: 'denied', message: 'x', code: 'revoked' }, false),
      remoteReadLine('Studio', { state: 'not-sharing', message: 'x', code: 'redaction-off' }, false),
      remoteReadLine('Studio', { state: 'waiting', message: 'Waiting for Studio to allow it…', code: null }, false)
    ],
    [chatsRefusalSentence('revoked', 'Studio'), chatsRefusalSentence('redaction-off', 'Studio'), 'Waiting for Studio to allow it…']
  )
  for (const mm of [hostM, guestM]) mm.remote.reset()
}

console.log('\nchat history across computers: what the renderer says (spec 2026-10-03 §4)')
{
  check('a name list reads as a sentence', [namesList([]), namesList(['Studio']), namesList(['Studio', 'Laptop']), namesList(['Studio', 'Laptop', 'NUC'])], ['', 'Studio', 'Studio and Laptop', 'Studio, Laptop and NUC'])
  check(
    'the tick is blocked with its reason: signed out, not in the vault, chat history off, its redaction off',
    [
      shareChatsBlock('off', true, true),
      shareChatsBlock('signed-out', true, true),
      shareChatsBlock('revoked', true, true),
      shareChatsBlock('locked', true, true),
      shareChatsBlock('new-account', true, true),
      shareChatsBlock('active', false, true),
      shareChatsBlock('active', false, false),
      shareChatsBlock('active', true, false),
      shareChatsBlock('active', true, true)
    ],
    [
      'Sign in to Stoke Hub first.',
      'Sign in to Stoke Hub first.',
      'Sign in to Stoke Hub first.',
      'Join this computer to your vault first.',
      'Join this computer to your vault first.',
      'Turn on Chat history first.',
      'Turn on Chat history first.',
      CHATS_REDACTION_BLOCK,
      null
    ]
  )
  check('the row’s reason is main’s refusal, word for word', CHATS_REDACTION_BLOCK, 'Turn on “Leave out anything that looks like an API key” in Chat history first.')
  check('chat history off is said before redaction', shareChatsBlock('active', false, false), 'Turn on Chat history first.')
  const row = (f: Partial<Parameters<typeof shareChatsRow>[0]>): ReturnType<typeof shareChatsRow> =>
    shareChatsRow({ phase: 'active', chatIndexOn: true, redactOn: true, sharing: false, grants: [], paused: null, ...f })
  const off = row({})
  check('off: the spec’s words, and the tick may go on', [off.checked, off.enabled, off.hint, off.paused], [false, true, 'Off. Other computers can’t see chats on this one.', false])
  const offBlocked = row({ chatIndexOn: false })
  check('off with chat history off: disabled, and says why', [offBlocked.checked, offBlocked.enabled, offBlocked.hint], [false, false, 'Turn on Chat history first.'])
  const offRaw = row({ redactOn: false })
  check(
    'off with chat history’s redaction off: disabled, and names the tick to turn on',
    [offRaw.checked, offRaw.enabled, offRaw.blocked, offRaw.hint],
    [false, false, CHATS_REDACTION_BLOCK, CHATS_REDACTION_BLOCK]
  )
  check('off and signed out: disabled, and says why', [row({ phase: 'signed-out' }).enabled, row({ phase: 'signed-out' }).hint], [false, 'Sign in to Stoke Hub first.'])
  const on = row({ sharing: true, grants: ['Studio', 'Laptop'] })
  check('on: names who can read, says it is read-only, redacted and by folder name', [on.checked, on.enabled, on.hint, on.paused], [true, true, 'On. Studio and Laptop can search and read, but not change, chats on this computer. Secrets are redacted; folders show by name.', false])
  ok('on with no Always: says each computer asks first', /ask here first/.test(row({ sharing: true }).hint))
  const onBlocked = row({ chatIndexOn: false, sharing: true, grants: ['Studio'] })
  check('on while chat history is off: still untickable (off is never refused), and says nothing is shared', [onBlocked.checked, onBlocked.enabled, /nothing is shared/.test(onBlocked.hint) && /Turn on Chat history first/.test(onBlocked.hint)], [true, true, true])
  const paused = row({ sharing: true, grants: ['Studio'], redactOn: false, paused: 'redaction-off' })
  check(
    'on, paused by main because redaction is off: says paused in the spec’s words, and may still go off',
    [paused.checked, paused.enabled, paused.paused, paused.hint, paused.blocked],
    [true, true, true, CHATS_PAUSED_SENTENCE, CHATS_REDACTION_BLOCK]
  )
  check('the paused copy, word for word', CHATS_PAUSED_SENTENCE, 'Paused: turn on “Leave out anything that looks like an API key” in Chat history to share it.')
  const onRaw = row({ sharing: true, grants: ['Studio'], redactOn: false, paused: null })
  check('on with redaction off but main not saying paused: the row never claims a pause main has not made', [onRaw.paused, /^On\. Studio can search/.test(onRaw.hint)], [false, true])
  check(
    'main’s pause is read off its view’s `chatsBlocked`, and no other block counts as one',
    [
      sharePausedOf({ chatsBlocked: 'redaction-off' }),
      sharePausedOf({ chatsBlocked: null }),
      sharePausedOf({ chatsBlocked: 'history-off' }),
      sharePausedOf({ chatsBlocked: 'not-in-vault' }),
      sharePausedOf({} as Pick<HubRemoteView, 'chatsBlocked'>)
    ],
    ['redaction-off', null, null, null, null]
  )
  check('off says what it did', SHARE_CHATS_STOPPED, 'Stopped. Searches from other computers were closed.')

  // Who shares, as the window has seen it.
  const m = (id: string, chats: boolean | null): { id: string; status: { at: number; open: boolean; sessions: []; chats: boolean } | null } => ({
    id,
    status: chats === null ? null : { at: 1, open: false, sessions: [], chats }
  })
  let sh = chatSharersStep(NO_CHAT_SHARERS, { available: true, machines: [m('d1', true), m('d2', false), m('d3', null)] })
  check('a computer saying chats is live and seen; one saying not, or nothing yet, is neither', [[...sh.next.live], [...sh.next.seen], sh.changed], [['d1'], ['d1'], true])
  const same = chatSharersStep(sh.next, { available: true, machines: [m('d1', true), m('d2', false), m('d3', null)] })
  check('the same machines again: the same object back, no cue', [same.next === sh.next, same.changed], [true, false])
  sh = chatSharersStep(sh.next, { available: true, machines: [m('d2', false)] })
  check('d1 goes offline: no longer live, still seen sharing, and the search is cued', [[...sh.next.live], [...sh.next.seen], sh.changed], [[], ['d1'], true])
  sh = chatSharersStep(sh.next, { available: true, machines: [m('d1', null), m('d2', false)] })
  check('d1 back with no status yet: keeps what it last said, no cue', [[...sh.next.live], [...sh.next.seen], sh.changed], [[], ['d1'], false])
  sh = chatSharersStep(sh.next, { available: true, machines: [m('d1', false), m('d2', false)] })
  check('d1 back saying it stopped sharing: dropped from seen (its offline line goes with it)', [[...sh.next.live], [...sh.next.seen]], [[], []])
  sh = chatSharersStep(sh.next, { available: true, machines: [m('d1', false), m('d2', true)] })
  check('d2 starts sharing mid-search: live, and the search is cued', [[...sh.next.live], sh.changed], [['d2'], true])
  sh = chatSharersStep(sh.next, { available: false, machines: [] })
  check('signed out: nothing shares', [sh.next === NO_CHAT_SHARERS, sh.changed], [true, true])

  // The groups: only computers that share.
  const r = (device: string, label: string, state: RemoteChatsResult['state'], message: string | null = null, extra: object = {}): RemoteChatsResult =>
    ({ device, label, platform: 'darwin', state, message, code: null, hits: [], ...extra }) as RemoteChatsResult
  const groups = remoteChatGroups(
    {
      query: 'relay',
      results: [
        r('d1', 'Studio', 'ok'),
        r('d2', 'NUC', 'denied'),
        r('d3', 'Laptop', 'error', 'Laptop did not answer in time.'),
        r('d4', 'Mini', 'not-sharing', 'Mini isn’t sharing chat history.'),
        r('d5', 'Air', 'offline', 'Air is offline — not searched.'),
        r('d6', 'Old', 'offline', 'Old is offline — not searched.'),
        r('d7', 'Pi', 'waiting', 'Waiting for Pi to allow it…'),
        r('d8', 'Mac', 'ok', null, { hits: [{ source: 'claude', nativeId: 'n-1', title: 'x', folder: null, updatedMs: null, role: 'user', snippet: 'relay', ranges: [[0, 5]] }] })
      ]
    },
    '  relay  ',
    new Set(['d1', 'd2', 'd3', 'd4', 'd5', 'd7'])
  )
  check(
    'one line each, in main’s order: found nothing, said no, failed, offline (seen sharing), waiting — none for a computer not sharing, never seen sharing, or seen to stop',
    groups.map((g) => [g.device, g.line, g.failed, g.stale]),
    [
      ['d1', 'Nothing on Studio says “relay”.', false, false],
      ['d2', 'NUC said no.', true, false],
      ['d3', 'Laptop did not answer in time.', true, false],
      ['d5', 'Air is offline — not searched', false, false],
      ['d7', 'Waiting for Pi to allow…', false, false]
    ]
  )
  check(
    'no computer shares: no group at all',
    remoteChatGroups({ query: 'relay', results: [r('d4', 'Mini', 'not-sharing'), r('d6', 'Old', 'offline')] }, 'relay', new Set()),
    []
  )
  const older = remoteChatGroups({ query: 'rel', results: [r('d1', 'Studio', 'ok'), r('d2', 'NUC', 'waiting')] }, 'relay', new Set(['d1', 'd2']))
  check(
    'an answer to an older query is pending under the new one, and quotes the query it answered',
    older.map((g) => [g.device, g.stale, g.line]),
    [['d1', true, 'Nothing on Studio says “rel”.'], ['d2', true, 'Waiting for NUC to allow…']]
  )
  check('the same query with other spaces is not older', remoteChatGroups({ query: 'relay', results: [r('d1', 'Studio', 'ok')] }, ' relay ', new Set(['d1']))[0]?.stale, false)

  // A refusal is reworded by its code, from this side; no code (a host older than the codes) keeps the host's sentence.
  const hostSaid = 'This computer’s owner took back this device’s access to its chat history.'
  check('no code: the host’s sentence, as before', remoteChatGroups({ query: 'relay', results: [r('d2', 'NUC', 'denied', hostSaid)] }, 'relay', new Set(['d2']))[0]?.line, hostSaid)
  check(
    'a code: the guest’s own sentence, by the name it knows the host by',
    remoteChatGroups({ query: 'relay', results: [r('d2', 'NUC', 'denied', hostSaid, { code: 'revoked' })] }, 'relay', new Set(['d2']))[0]?.line,
    'NUC took back this computer’s access to its chat history.'
  )
  check('an unknown code is no code', [chatRefusalCodeOf({ code: 'gone-fishing' }), chatRefusalCodeOf({}), chatRefusalCodeOf({ code: 'busy' })], [null, null, 'busy'])
  check(
    'every code the host sends reads from this computer’s side, naming the other, in a group and in the viewer',
    CHATS_REFUSAL_CODES.filter((c) => {
      const line = chatsRefusalSentence(c, 'NUC')
      const group = remoteChatGroups({ query: 'q', results: [r('d2', 'NUC', 'denied', hostSaid, { code: c })] }, 'q', new Set(['d2']))[0]?.line
      const open = remoteOpenLine('NUC', { state: 'denied', message: hostSaid, code: c })
      return !(line.includes('NUC') && !/This computer’s owner|this device/.test(line) && group === line && open === line)
    }),
    []
  )

  // The viewer's errors.
  check(
    'an open says its own sentence for offline; main’s for waiting and failures; a code reworded; a fallback for nothing',
    [
      remoteOpenLine('Studio', { state: 'offline', message: 'Studio is offline — not searched.' }),
      remoteOpenLine('Studio', { state: 'waiting', message: 'Waiting for Studio to allow it…' }),
      remoteOpenLine('Studio', { state: 'error', message: 'Studio did not answer in time.' }),
      remoteOpenLine('Studio', { state: 'denied', message: hostSaid, code: 'denied' } as { state: 'denied'; message: string }),
      remoteOpenLine('Studio', { state: 'error', message: '' })
    ],
    ['Studio is offline — open it again when it’s back.', 'Waiting for Studio to allow it…', 'Studio did not answer in time.', 'Studio said no.', 'Studio could not open this chat.']
  )
  check('the viewer’s header: computer and folder name', [remoteChatWhere('Studio', 'stoke'), remoteChatWhere('Studio', null)], ['On Studio · stoke', 'On Studio'])

  // When the viewer reads a failed chat again by itself.
  const watchRun = (start: RemoteChatPeerState | null, steps: { failed: boolean; peer: RemoteChatPeerState | null }[]): boolean[] => {
    let w = remoteReadWatch(false, { failed: false, peer: start })
    return steps.map((st) => {
      w = remoteReadWatch(w.awaited, st)
      return w.reload
    })
  }
  check('failed while its owner was asked, then allowed: read again', watchRun('waiting', [{ failed: true, peer: 'waiting' }, { failed: true, peer: 'open' }]), [false, true])
  check('allowed before the failure landed: read again when it lands', watchRun('waiting', [{ failed: false, peer: 'open' }, { failed: true, peer: 'open' }]), [false, true])
  check('failed while the relay stayed open (no answer in time): never by itself — that is “Try again”', watchRun('open', [{ failed: true, peer: 'open' }, { failed: true, peer: 'open' }]), [false, false])
  check(
    'the relay dropped and came back after a failure: read again',
    watchRun('open', [{ failed: true, peer: 'open' }, { failed: true, peer: null }, { failed: true, peer: 'waiting' }, { failed: true, peer: 'open' }]),
    [false, false, false, true]
  )
  check('offline, with no relay: nothing to wait on', watchRun(null, [{ failed: true, peer: null }]), [false])
  check('a read that did not fail is never read again', watchRun('waiting', [{ failed: false, peer: 'open' }, { failed: false, peer: 'open' }]), [false, false])
  check('denied stays denied: no read again', watchRun('waiting', [{ failed: true, peer: 'denied' }]), [false])
}

console.log('\nchat history across computers: the wire from the renderer to those rules (what no pure case sees, gotcha 31)')
{
  const src = (rel: string): string => readFileSync(new URL(`../src/renderer/src/${rel}`, import.meta.url), 'utf8')
  const app = src('App.tsx')
  const viewer = src('components/ChatViewer.tsx')
  const sidebar = src('components/Sidebar.tsx')
  const account = src('components/AccountSyncSettings.tsx')
  check(
    'App mounts the viewer under a key counted per open, from both opens, so the same hit clicked again reads again',
    [/<ChatViewer\s+key=\{chatViewOpen\}/.test(app), (app.match(/setChatViewOpen\(\(n\) => n \+ 1\)/g) ?? []).length],
    [true, 2]
  )
  check('App hands the viewer its computer’s chats peer', /<ChatViewer[\s\S]*?peer=\{chatView\.kind === 'remote' \? \(hubRemote\.chatPeers\.find/.test(app), true)
  check(
    'the viewer reads again on a new attempt, watches the peer, and offers “Try again” for a remote failure',
    [/\}, \[key, attempt\]\)/.test(viewer), /remoteReadWatch\(awaited\.current, \{ failed, peer \}\)/.test(viewer), /\{remote && \([\s\S]{0,200}data-chat-retry/.test(viewer)],
    [true, true, true]
  )
  check('the viewer words a remote failure through remoteOpenLine', /error: remoteOpenLine\(target\.computer, r\)/.test(viewer), true)
  check(
    'and draws it as things stand now: through remoteReadLine with the computer’s presence, which App reads off the machines list',
    [
      /failure: r \}/.test(viewer),
      /remote && state\.failure \? remoteReadLine\(remote\.computer, state\.failure, online\) : state\.error/.test(viewer),
      /<ChatViewer[\s\S]*?online=\{chatView\.kind === 'remote' && hubRemote\.available \? hubRemote\.machines\.some\(\(m\) => m\.id === chatView\.device\) : null\}/.test(app)
    ],
    [true, true, true]
  )
  check(
    'App keeps each answer with its query, groups by who shares, and asks again when sharing moves',
    [
      /setRemoteChats\(\{ query: q, results \}\)/.test(app),
      /remoteChatGroups\(remoteChats, query, chatSharers\.seen\)/.test(app),
      /if \(r\.changed\) setRemoteChatsCue/.test(app),
      /const remoteChatsOn = hubRemote\.available && chatSharers\.seen\.size > 0/.test(app)
    ],
    [true, true, true, true]
  )
  check('the sidebar draws an older query’s group as pending', [/data-stale=\{g\.stale/.test(sidebar), /aria-busy=\{g\.stale/.test(sidebar)], [true, true])
  check(
    'the share row reads chat history’s redaction and main’s pause',
    [/redactOn,\n\s+sharing: remote\.sharingChats/.test(account), /paused: sharePausedOf\(remote\)/.test(account)],
    [true, true]
  )
  check(
    'after the sheet, focus waits for “Turn on” to finish (a disabled tick refuses focus), never a frame that races it',
    [/if \(!refocus\.current \|\| confirming \|\| busy !== null\) return/.test(account), /\}, \[confirming, busy\]\)/.test(account), !/setConfirming\(false\)\s*\n\s*\/\/[^\n]*\n\s*requestAnimationFrame/.test(account)],
    [true, true, true]
  )
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
