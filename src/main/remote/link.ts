import { networkInterfaces } from 'node:os'
import type { RemoteReachPreference } from '../../shared/ui.ts'

/**
 * Where the phone link points, and how it gets there.
 *
 * Pure and electron-free so `scripts/verify-remote.mts` can hold the ranking
 * and the fallback order to fixed interface tables. server.ts re-exports what
 * it uses; nothing here touches a socket.
 */

/**
 * How the link on the phone reaches this machine.
 *
 * `loopback` is the one that does not: it is what `connectTarget` falls back
 * to when nothing else is configured, and the panel has to say so rather than
 * draw a QR code of 127.0.0.1 under "Open on your phone" — which is exactly
 * what shipped, and why phone access read as broken on a fresh install.
 */
export type Reach = 'tunnel' | 'tailnet' | 'lan' | 'loopback'

export interface ConnectTarget {
  url: string
  reach: Reach
  /** The address the URL names, without scheme, port or key. */
  address: string
  /**
   * Every other LAN address that could have been chosen, as full links. The
   * first non-internal IPv4 in interface order is a bridge or a VM adapter
   * often enough that the user has to be able to pick another.
   */
  candidates: string[]
}

/*
 * Tailscale gives every node an address in 100.64.0.0/10, the CGNAT range it
 * borrows for the tailnet. Matching the range rather than the interface name
 * keeps this working everywhere, since the interface is variously "Tailscale",
 * "tailscale0" and a "utun" device depending on the platform.
 */
/** True for an address in 100.64.0.0/10, the CGNAT range Tailscale uses. */
export function isTailnetAddress(address: string): boolean {
  // Node reports an IPv4 socket as ::ffff:100.x on a dual-stack listener.
  const plain = address.replace(/^::ffff:/i, '')
  const [first, second] = plain.split('.').map(Number)
  return first === 100 && second >= 64 && second <= 127
}

export function tailnetAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [first, second] = a.address.split('.').map(Number)
      if (first === 100 && second >= 64 && second <= 127) return a.address
    }
  }
  return null
}

/*
 * Interfaces that are almost never the one a phone can reach. Docker Desktop's
 * bridge100, a VM's vEthernet or vboxnet, any VPN's utun/tun/tap, and macOS's
 * awdl/llw peer-to-peer links all report a non-internal IPv4 and all sit
 * ahead of Wi-Fi in `networkInterfaces()` order often enough that "first
 * non-internal IPv4" handed the QR code an address nothing could dial.
 */
const UNLIKELY_IFACE = /^(bridge|utun|docker|vbox|vEthernet|vmnet|tun|tap|llw|awdl|zt|wg)/i
/** The names a machine's real Wi-Fi or Ethernet adapter usually has. */
const LIKELY_IFACE = /^(en0|en1|eth0|wlan0|wlp|Wi-Fi|Ethernet|WLAN)/i

/**
 * Every LAN address a phone might reach this machine on, best first.
 *
 * Exported so the ranking can be asserted against a fixed interface table
 * rather than whatever this machine happens to have.
 */
export function lanAddresses(
  nets: Record<string, { address: string; family: string | number; internal: boolean }[] | undefined> =
    networkInterfaces() as never
): string[] {
  const likely: string[] = []
  const plain: string[] = []
  const unlikely: string[] = []
  for (const [name, list] of Object.entries(nets)) {
    for (const a of list ?? []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue
      // The tailnet address is its own transport, not a LAN candidate.
      if (isTailnetAddress(a.address)) continue
      if (UNLIKELY_IFACE.test(name)) unlikely.push(a.address)
      else if (LIKELY_IFACE.test(name)) likely.push(a.address)
      else plain.push(a.address)
    }
  }
  return [...likely, ...plain, ...unlikely]
}

/**
 * The link to open on the phone, and how it gets there.
 *
 * A RUNNING tunnel first, whatever was chosen. Then the explicit choice, even
 * when it cannot be served — loopback with the panel saying why beats a silent
 * substitution. Then, for `auto`, whatever the socket is bound to: the tailnet
 * before the LAN, and loopback last, reported as such so the caller can refuse
 * to draw it as a phone link.
 */
export function connectTarget(opts: {
  hostname: string
  port: number
  token: string
  bindLan: boolean
  bindTailscale?: boolean
  /**
   * What the user CHOSE. Optional so the suite's older fixtures still read,
   * and because `auto` — fall back in this function's own order — is both the
   * default and the honest answer for a machine that has chosen nothing.
   */
  reach?: RemoteReachPreference
  /** The URL a running cloudflared announced, quick or named. Wins when set. */
  tunnelUrl?: string | null
  /** Injectable for the suite; defaults to this machine's interfaces. */
  lan?: string[]
  tailnet?: string | null
}): ConnectTarget {
  const key = `?k=${encodeURIComponent(opts.token)}`
  const lan = opts.lan ?? lanAddresses()
  const candidates = lan.map((a) => `http://${a}:${opts.port}/${key}`)

  const prefer = opts.reach ?? 'auto'
  const host = opts.hostname.trim()
  const tunnelHost = (): ConnectTarget | null => {
    const running = opts.tunnelUrl?.trim().replace(/\/+$/, '')
    if (running) {
      return {
        url: `${running}/${key}`,
        reach: 'tunnel',
        address: running.replace(/^https?:\/\//, ''),
        candidates
      }
    }
    return host ? { url: `https://${host}/${key}`, reach: 'tunnel', address: host, candidates } : null
  }
  const viaTailnet = (): ConnectTarget | null => {
    const tailnet = opts.tailnet === undefined ? tailnetAddress() : opts.tailnet
    return tailnet
      ? { url: `http://${tailnet}:${opts.port}/${key}`, reach: 'tailnet', address: tailnet, candidates }
      : null
  }
  const viaLan = (): ConnectTarget | null =>
    lan.length ? { url: candidates[0], reach: 'lan', address: lan[0], candidates: candidates.slice(1) } : null
  const loopback: ConnectTarget = {
    url: `http://127.0.0.1:${opts.port}/${key}`,
    reach: 'loopback',
    address: '127.0.0.1',
    candidates
  }

  /*
   * A RUNNING tunnel wins over every preference, and that is not the same as
   * the hostname doing so. A live cloudflared is a fact about this moment —
   * the phone can reach it right now — whereas a saved hostname is a fact
   * about a config file, and treating the two alike is what made a stored
   * `hostname` outrank a bound LAN forever: the QR code encoded
   * `https://<host>/` while the server listened on 192.168.x and nothing was
   * serving that name.
   */
  const running = opts.tunnelUrl?.trim() ? tunnelHost() : null
  if (running) return running

  /*
   * An explicit choice is honoured even when it cannot be served, because the
   * panel's job at that point is to say so — "you picked Cloudflare Tunnel and
   * no tunnel is running" is a sentence a user can act on, and silently
   * substituting the LAN is not.
   */
  if (prefer === 'tunnel') return tunnelHost() ?? loopback
  if (prefer === 'tailnet') return viaTailnet() ?? loopback
  if (prefer === 'lan') return viaLan() ?? loopback

  /*
   * `auto`: what the socket is actually bound to, in narrowest-first order.
   * The bare hostname is deliberately NOT consulted here — see above.
   */
  if (opts.bindTailscale && !opts.bindLan) {
    const tailnet = viaTailnet()
    if (tailnet) return tailnet
  }
  if (opts.bindLan) {
    const lanTarget = viaLan()
    if (lanTarget) return lanTarget
  }
  return loopback
}

