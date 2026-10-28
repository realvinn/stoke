/*
 * A fake hub and fake machines for driving `HubRemote` (src/main/hub/remote.ts)
 * end to end with no network: `verify:connection-log` and `verify:hub-reconnect`.
 *
 * The hub pairs two `FakeSocket`s per relay and forwards every frame on a
 * timer tick, the way `RelayBroker` does. It can cut one leg of a relay the
 * way the edge or the hub does (`drop(code, reason)`, which the other leg does
 * not hear), lose the host's relay notice (`hearRelays`), or deliver it late
 * (`joinDelayMs`). A machine's pty is a stub behind the phone socket: an
 * `attached` replay, then an echo of whatever is typed.
 *
 * Every input is synthetic (gotcha 74): keys, ids, clocks, sessions. Imports
 * are relative with `.ts` (gotcha 78).
 */
import { generateDeviceKeys, presenceKey, randomU8, type DeviceKeys } from '../src/main/hub/crypto.ts'
import { HubRemote, type HubRemoteDeps, type RelaySocket, type RemoteContext } from '../src/main/hub/remote.ts'
import { idFromBytes } from '../src/shared/hub/codec.ts'
import type { RemoteRowLike, HubRemoteView, RemoteTabFrame } from '../src/shared/hub/remote.ts'
import type { HubGrant } from '../src/shared/hub/relay.ts'

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
export async function until<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) return undefined
    await tick(10)
  }
}

export class FakeSocket implements RelaySocket {
  readyState = 0
  peer: FakeSocket | null = null
  /** Frames this end sends are lost on the way (a dead leg that still says open). */
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
    if (this.readyState !== 0) return
    this.readyState = 1
    this.fire('open')
    for (const [d, b] of this.pending.splice(0)) this.fire('message', d, b)
  }
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1 || this.mute) return
    const binary = typeof data !== 'string'
    const p = this.peer
    const copy = typeof data === 'string' ? data : Buffer.from(data)
    setTimeout(() => {
      if (!p || p.readyState === 3) return
      if (p.readyState !== 1) p.pending.push([copy, binary])
      else p.fire('message', copy, binary)
    }, 0)
  }
  /** This end closes; the hub tells the other end, with the same code and reason. */
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.fire('close', code, Buffer.from(reason))
    const p = this.peer
    if (p && p.readyState !== 3) setTimeout(() => p.drop(code, reason), 0)
  }
  /** The hub or the edge cuts THIS leg only: the other end hears nothing. */
  drop(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.fire('close', code, Buffer.from(reason))
  }
}

export interface Dev {
  id: string
  label: string
  platform: string
  keys: DeviceKeys
}
export const dev = (label: string, platform = 'darwin'): Dev => ({ id: idFromBytes('device', randomU8(10)), label, platform, keys: generateDeviceKeys() })

export interface Relay {
  id: string
  guest: FakeSocket
  host: FakeSocket
  hostDevice: string
  guestDevice: string
}

export interface FakeHub {
  account: string
  relays: Map<string, Relay>
  /** Every relay asked for, in order. */
  created: string[]
  machines: Map<string, Machine>
  /** False: the host never hears of the next relays (a lost presence notice). */
  hearRelays: boolean
  /** How late the host hears of a relay, in ms. */
  joinDelayMs: number
  /** Thrown by the next `createRelay`, once. */
  failNext: Error | null
}

export function makeHub(): FakeHub {
  return { account: idFromBytes('account', randomU8(10)), relays: new Map(), created: [], machines: new Map(), hearRelays: true, joinDelayMs: 0, failNext: null }
}

export interface Machine {
  dev: Dev
  remote: HubRemote
  active: Dev[]
  out: boolean
  sharing: boolean
  grants: Record<string, HubGrant>
  views: HubRemoteView[]
  frames: { tab: string; frame: RemoteTabFrame }[]
  ptyInput: string[]
  sessions: RemoteRowLike[]
  label: string
  /** Its pty sends no `attached` replay (a session that never draws its screen). */
  silent: boolean
}

export function lastView(m: Machine): HubRemoteView {
  return m.views[m.views.length - 1] ?? m.remote.view()
}
export function tabOf(m: Machine, tab: string): HubRemoteView['tabs'][number] | undefined {
  return m.remote.view().tabs.find((t) => t.id === tab)
}

export function stubRow(ptyId: string, title: string): RemoteRowLike {
  return { ptyId, project: 'proj', title, status: 'idle', agentName: 'Claude Code', exited: false, lastActivityAt: 1, context: null }
}

/** One machine on `hub`: its own `HubRemote` over the fake hub, with `extra` deps (trace, timings). */
export function machine(hub: FakeHub, d: Dev, active: Dev[], extra: Partial<HubRemoteDeps> = {}): Machine {
  const m: Machine = { dev: d, remote: null as unknown as HubRemote, active: [...active], out: false, sharing: false, grants: {}, views: [], frames: [], ptyInput: [], sessions: [], label: d.label, silent: false }
  const vk = randomU8(32)
  const ctx = (): RemoteContext | null =>
    m.out
      ? null
      : {
          account: hub.account,
          epoch: 1,
          me: { id: d.id, label: m.label, platform: d.platform, signPriv: d.keys.signPriv },
          active: m.active.map((a) => ({ id: a.id, label: hub.machines.get(a.id)?.label ?? a.label, platform: a.platform, sign: a.keys.signPub }))
        }
  m.remote = new HubRemote({
    now: () => Date.now(),
    context: ctx,
    presenceKey: async (epoch) => presenceKey(vk, hub.account, epoch),
    sendPresence: () => true,
    createRelay: async (host) => {
      const fail = hub.failNext
      if (fail) {
        hub.failNext = null
        throw fail
      }
      const id = idFromBytes('relay', randomU8(15))
      const guest = new FakeSocket()
      const hostSock = new FakeSocket()
      guest.peer = hostSock
      hostSock.peer = guest
      hub.relays.set(id, { id, guest, host: hostSock, hostDevice: host, guestDevice: d.id })
      hub.created.push(id)
      if (hub.hearRelays) {
        const target = hub.machines.get(host)
        setTimeout(() => void target?.remote.onRelay(id, d.id), hub.joinDelayMs)
      }
      return { relay: id }
    },
    openRelay: async (relay) => {
      const r = hub.relays.get(relay)
      if (!r) throw new Error('no relay')
      const s = r.guestDevice === d.id ? r.guest : r.host
      setTimeout(() => s.open(), 0)
      return s
    },
    sharing: () => m.sharing,
    grants: () => m.grants,
    setGrant: async (device, grant) => {
      const next = { ...m.grants }
      if (grant) next[device] = grant
      else delete next[device]
      m.grants = next
    },
    shareChats: () => false,
    chatGrants: () => ({}),
    setChatGrant: async () => undefined,
    log: () => {},
    sessions: async () => m.sessions,
    request: async () => ({ status: 404, body: {} }),
    socket: (path, sock) => {
      const ptyId = new URLSearchParams(path.split('?')[1] ?? '').get('ptyId')
      if (!m.silent) sock.send(JSON.stringify({ type: 'attached', ptyId, cols: 100, rows: 30, desktopCols: 100, desktopRows: 30, status: 'idle', history: 'stub$ ' }))
      sock.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; data?: string }
        if (msg.type === 'input' && msg.data) {
          m.ptyInput.push(msg.data)
          sock.send(JSON.stringify({ type: 'data', ptyId, data: msg.data }))
        }
      })
    },
    emit: (view) => m.views.push(view),
    frame: (tab, frame) => m.frames.push({ tab, frame }),
    ...extra
  })
  hub.machines.set(d.id, m)
  return m
}
