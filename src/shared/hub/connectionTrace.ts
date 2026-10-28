/*
 * What the opt-in connection log may write, decided in one place.
 *
 * "Keep a connection log" (Settings › Account & sync › Other machines,
 * `hub.connectionLog`, off by default) records when this computer's
 * connections to its other computers open, drop and reconnect, so a drop can
 * be traced from both ends. The writer is src/main/hub/connectionLog.ts; the
 * events come from `HubRemote` (guest and host) and `HubPresence` through an
 * optional `trace` hook, which the account website never passes.
 *
 * Everything here is pure and is the whole of the log's privacy rule:
 *
 * - `traceFields` keeps only the field names it knows, each checked for its
 *   own shape (`TRACE_FIELD_RULES`): numbers for times, sizes and counts, a
 *   relay id in full (random per relay, needed to match the hub's own log
 *   line), a device id cut to `DEVICE_ID_CHARS`, a tab as a local counter, and
 *   short words from fixed sets. Anything else — a sentence, a name, a URL, a
 *   key — is dropped, whatever the caller passed.
 * - `closeReasonTag` turns a close or failure reason into a short tag from a
 *   fixed table. A reason it does not know is `other` with its length only: a
 *   peer's reasons are free text, and one of ours names the other machine
 *   (the snapshot wait's).
 * - `errorCodeOf` keeps an error's code (ECONNRESET, a hub error code, an
 *   HTTP status), never its message.
 * - `hubViaOf` says what KIND of address the hub is at (Cloudflare's edge, a
 *   private network, or something else), never the address.
 *
 * Never written, by construction: session tokens, signed headers, any key,
 * the Recovery Kit, the website's ticket, anything inside a frame (terminal
 * output, keystrokes, dictation, the attach replay, session status), session
 * titles, folder and project names, device labels, emails, the account id,
 * the hub URL, refusal sentences, free-text errors, chat queries and hits, and
 * per-frame sizes or times (per-relay totals only: per-frame data would leak
 * typing rhythm).
 *
 * The writer's `formatLine` is NOT a redactor (its tokens keep `:`, `/`, `@`):
 * this file is the whole guarantee (CLAUDE.md gotcha 171).
 *
 * Pure (gotcha 27); imports only src/shared by relative `.ts` path (gotcha 78).
 */
import { isId } from './codec.ts'

/** Values a trace hook may be handed; `traceFields` decides what of them is written. */
export type TraceValue = string | number | boolean | null | undefined
export type TraceFields = Record<string, TraceValue>
/** The optional hook `HubRemote` and `HubPresence` call. Absent: nothing is traced. */
export type TraceFn = (event: string, fields?: TraceFields) => void

/** A device id is cut to this many characters (`d` and four more): enough to tell three machines apart. */
export const DEVICE_ID_CHARS = 5

/** Every event the log writes. Any other name is dropped whole. */
export const CONNECTION_EVENTS = new Set<string>([
  // the machine
  'log-start',
  'suspend',
  'resume',
  'lock-screen',
  'unlock-screen',
  // guest: a remote tab here
  'relay-connect',
  'relay-created',
  'relay-create-failed',
  'relay-socket-open',
  'relay-socket-error',
  'relay-handshake',
  'relay-join-timeout',
  'relay-ready',
  'relay-attached',
  'relay-refused',
  'relay-close',
  'relay-lost',
  'relay-rtt',
  'relay-pong-timeout',
  'relay-snapshot-timeout',
  'relay-tab-close',
  'relay-retry',
  'relay-revive',
  'relay-wake',
  // host: another machine's tab on this one
  'host-relay-notice',
  'host-relay-skip',
  'host-relay-open-failed',
  'host-relay-error',
  'host-handshake',
  'host-attach-timeout',
  'host-decision',
  'host-relay-close',
  'host-relay-end',
  // presence
  'presence-connect',
  'presence-open',
  'presence-heartbeat-miss',
  'presence-close',
  'presence-error',
  'presence-retry',
  'presence-rtt',
  'presence-online'
])

/* ------------------------------------------------------- close reasons */

/**
 * Known reasons, lower-cased, to their tag. From the hub (hub/sockets.ts,
 * hub/app.ts), its edge Worker (worker/hub-edge.ts), Cloudflare itself, and
 * this client (remote.ts, channel.ts). verify:connection-log reads those
 * senders' source and fails on any reason they send that has no tag here, so
 * a new hub close is never logged as a bare `other` (CLAUDE.md gotcha 171).
 */
const REASON_TAGS: Record<string, string> = {
  '': 'none',
  // the hub
  'host left': 'host-left',
  'guest left': 'guest-left',
  'the other end never joined': 'never-joined',
  idle: 'idle',
  'the hub is restarting': 'hub-restarting',
  'could not deliver a frame': 'undeliverable',
  'the other end is not reading': 'not-reading',
  'session ended': 'session-ended',
  'your hub session ended': 'session-ended',
  'signed out': 'signed-out',
  'a device was removed': 'device-removed',
  'this device was removed from the account': 'device-removed',
  'replaced by a newer connection from this device': 'replaced',
  'too many frames': 'too-many-frames',
  'presence frames are json text': 'not-text',
  'not json': 'not-json',
  // its presence close for a socket a newer one from the same device replaced (the `bye` above says it in full)
  replaced: 'replaced',
  'that end of the relay is taken': 'end-taken',
  'too much sent before the other end joined': 'queue-full',
  'guest socket error': 'guest-socket-error',
  'host socket error': 'host-socket-error',
  // the edge Worker and Cloudflare
  'edge error': 'edge-error',
  'hub error': 'hub-error',
  'the edge could not forward a frame': 'edge-forward',
  'the hub went away': 'hub-went-away',
  'the device went away': 'device-went-away',
  'websocket disconnected without sending close frame.': 'cf-no-close',
  'cloudflare websocket proxy restarting': 'cf-restarting',
  // this client
  'the relay closed': 'relay-closed',
  'the tab was closed': 'tab-closed',
  refused: 'refused',
  closed: 'closed',
  disconnected: 'disconnected',
  'the other machine stopped answering': 'pong-timeout',
  'the other machine did not pick up': 'join-timeout',
  'no session was named': 'attach-timeout',
  'stopped sharing': 'stopped-sharing',
  'not a device of this account': 'not-a-device',
  'the device is no longer one of yours': 'not-a-device',
  'that device is no longer one of this account’s devices.': 'not-a-device',
  'this computer is no longer in your hub’s vault.': 'not-in-vault',
  'the search ended': 'search-ended',
  'trying again': 'retrying',
  offline: 'offline',
  'it says it shares again': 'shares-again',
  'the hub did not open a relay.': 'no-relay',
  'sign in first.': 'signed-out',
  // the host's pty socket (its `ws-close`), as the guest hears it
  'the other machine closed the session': 'pty-closed',
  exit: 'pty-exit',
  terminated: 'pty-terminated',
  'too many sockets.': 'too-many-sockets',
  // the channel (channel.ts): protocol failures, each its own tag
  'a frame did not open: dropped, repeated, reordered or changed on the way': 'frame-unopened',
  'a text frame arrived after the handshake': 'text-after-handshake',
  'a frame was not a relay frame': 'not-relay-frame',
  'the handshake was not finished': 'handshake-unfinished',
  'the handshake was not started': 'handshake-unstarted',
  'a handshake frame was not json': 'handshake-not-json',
  'a frame grew past the largest one a relay carries': 'frame-too-large',
  'a joined frame was not a relay frame': 'bad-join',
  'a frame arrived in the middle of another': 'interleaved',
  'a relay frame part came out larger than the hub carries': 'part-too-large',
  'the remote connection is not keeping up; reconnect to refresh the screen': 'backpressure',
  'that machine is not in your verified device list any more.': 'peer-unknown',
  'that device is not in this computer’s verified device list': 'peer-unknown',
  'the guest is not the device the hub named': 'wrong-guest',
  'the guest did not sign this handshake with its own key': 'bad-signature',
  'the host’s key did not agree': 'key-mismatch',
  'the guest’s key did not agree': 'key-mismatch'
}

/** Reasons that carry a name in the middle: matched by shape, and only the tag is kept. */
const REASON_SHAPES: [RegExp, string][] = [
  [/did not send its terminal screen\./i, 'snapshot-timeout'],
  [/ is not online\.$/i, 'offline-local'],
  [/ is no longer one of your devices\.$/i, 'not-a-device']
]

/** Every tag `closeReasonTag` can answer, `other` included. */
export const CLOSE_REASON_TAGS: ReadonlySet<string> = new Set([...Object.values(REASON_TAGS), ...REASON_SHAPES.map(([, t]) => t), 'other'])

/** A close or failure reason as a short tag; one it does not know is `other`. Never the reason itself. */
export function closeReasonTag(reason: unknown): string {
  if (typeof reason !== 'string') return 'other'
  const r = reason.trim()
  const known = REASON_TAGS[r.toLowerCase()]
  if (known !== undefined) return known
  for (const [shape, tag] of REASON_SHAPES) if (shape.test(r)) return tag
  return 'other'
}

/** `why`, plus `whyLen` for a reason the table does not know (its length, never its text). */
export function closeReasonFields(reason: unknown): { why: string; whyLen?: number } {
  const why = closeReasonTag(reason)
  return why === 'other' ? { why, whyLen: typeof reason === 'string' ? reason.length : 0 } : { why }
}

/** A WebSocket close event's reason as text: `ws` hands a Buffer, a browser a string. */
export function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(reason)
    } catch {
      return ''
    }
  }
  return ''
}

/* ------------------------------------------------------------ errors */

const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/

/**
 * An error's code, never its message: a Node errno (`ECONNRESET`), a hub
 * error code (`HubRequestError.code`), a fetch cause's code, `http-<status>`
 * for a refused upgrade, `handshake-timeout` and `heartbeat-miss` for the
 * deadlines that are ours, else `other`.
 */
export function errorCodeOf(err: unknown): string {
  const o = err && typeof err === 'object' ? (err as { code?: unknown; cause?: unknown; message?: unknown }) : null
  if (o && typeof o.code === 'string' && CODE_SHAPE.test(o.code)) return o.code
  const cause = o && o.cause && typeof o.cause === 'object' ? (o.cause as { code?: unknown }) : null
  if (cause && typeof cause.code === 'string' && CODE_SHAPE.test(cause.code)) return cause.code
  const message = o && typeof o.message === 'string' ? o.message : typeof err === 'string' ? err : ''
  const status = /Unexpected server response: (\d{3})/.exec(message)
  if (status) return `http-${status[1]}`
  if (/handshake has timed out|connection timed out/i.test(message)) return 'handshake-timeout'
  if (/stopped answering presence heartbeats/i.test(message)) return 'heartbeat-miss'
  return 'other'
}

/* ------------------------------------------------------- the hub's address */

/** The hosts of Cloudflare's edge a Stoke hub is reached through: the Stoke edge Worker and Cloudflare's own names. */
const CLOUDFLARE_HOSTS = ['stoke.vinn.dev']
const CLOUDFLARE_SUFFIXES = ['.workers.dev', '.trycloudflare.com', '.cfargotunnel.com']

function privateHost(h: string): boolean {
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.ts.net') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.internal')) return true
  if (!h.includes('.') && !h.includes(':')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
}

/** What kind of address the hub is at: `cloudflare`, `lan`, `other`, or `none` (no hub). Never the address. */
export function hubViaOf(url: unknown): 'cloudflare' | 'lan' | 'other' | 'none' {
  if (typeof url !== 'string' || url.trim() === '') return 'none'
  let host: string
  try {
    host = new URL(url.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return 'other'
  }
  if (!host) return 'other'
  if (CLOUDFLARE_HOSTS.includes(host) || CLOUDFLARE_SUFFIXES.some((s) => host.endsWith(s))) return 'cloudflare'
  return privateHost(host) ? 'lan' : 'other'
}

/* ------------------------------------------------------------- fields */

const oneOf =
  (...words: string[]) =>
  (v: TraceValue): string | undefined =>
    typeof v === 'string' && words.includes(v) ? v : undefined
const count = (v: TraceValue): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined)
const word = (shape: RegExp) => (v: TraceValue): string | undefined => (typeof v === 'string' && shape.test(v) ? v : undefined)
const device = (v: TraceValue): string | undefined => (isId('device', v) ? v.slice(0, DEVICE_ID_CHARS) : undefined)
const flag = (v: TraceValue): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/** Tags a `why` may be: a close reason's, or a host's reason for skipping a relay. */
const WHY_WORDS = new Set([...CLOSE_REASON_TAGS, 'max', 'repeat', 'not-device'])

/**
 * Every field the log writes, and what its value must be. A field not named
 * here is never written; a value that fails its rule is left out.
 */
export const TRACE_FIELD_RULES: Record<string, (v: TraceValue) => string | number | boolean | undefined> = {
  // ids
  relay: (v) => (isId('relay', v) ? v : undefined),
  peer: device,
  tab: count,
  // times (ms) and counts
  ms: count,
  lifeMs: count,
  quietMs: count,
  delayMs: count,
  silentMs: count,
  asleepMs: count,
  try: count,
  tries: count,
  code: count,
  tx: count,
  rx: count,
  txB: count,
  rxB: count,
  count: count,
  offlineTabs: count,
  hosted: count,
  sockets: count,
  messages: count,
  open: count,
  whyLen: count,
  suppressed: count,
  // words from fixed sets
  why: (v) => (typeof v === 'string' && WHY_WORDS.has(v) ? v : undefined),
  err: word(CODE_SHAPE),
  refusal: word(/^[a-z][a-z-]{1,31}$/),
  side: oneOf('guest', 'host'),
  by: oneOf('local', 'remote'),
  mode: oneOf('view', 'full'),
  kind: oneOf('session', 'chats'),
  via: oneOf('once', 'always'),
  decision: oneOf('serve', 'ask', 'refuse'),
  state: oneOf('connecting', 'asking', 'open', 'reconnecting', 'lost', 'refused', 'ended'),
  phase: oneOf('handshake', 'attach', 'asking', 'serving', 'closed'),
  hubVia: oneOf('cloudflare', 'lan', 'other', 'none'),
  wake: flag,
  // the machine (log-start only)
  version: word(/^[0-9A-Za-z.+-]{1,40}$/),
  os: word(/^[a-z0-9]{1,16}$/),
  arch: word(/^[a-z0-9_]{1,16}$/)
}

/** What of `fields` may be written for `event`: null for an event the log does not know. */
export function traceFields(event: string, fields: TraceFields = {}): Record<string, string | number | boolean> | null {
  if (!CONNECTION_EVENTS.has(event)) return null
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(fields)) {
    const rule = Object.prototype.hasOwnProperty.call(TRACE_FIELD_RULES, key) ? TRACE_FIELD_RULES[key] : undefined
    if (!rule) continue
    const kept = rule(value)
    if (kept !== undefined) out[key] = kept
  }
  return out
}
