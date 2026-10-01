/*
 * The hub's own limits, the ones the contract leaves to the server: a
 * request-rate bucket per client IP, a cap on concurrent scrypt runs, and a
 * per-key in-flight claim for sign-in.
 *
 * Why sign-in needs the in-flight claim (gotcha 20): the throttle is judged
 * BEFORE scrypt and a failure recorded AFTER it, so without a claim taken
 * before the await, a hundred concurrent guesses for one email all pass the
 * check and all get scrypted — a hundred guesses where the rule allows five.
 * One attempt per email may be in flight at a time; a second is refused
 * `rate-limited` at once, costing nothing.
 *
 * Why scrypt needs a global cap: N = 2^17, r = 8 is 128 MiB per run. Four
 * clients guessing at once is half a gigabyte on a NUC, so runs past the cap
 * queue, and a queue past its own cap is refused.
 *
 * Every per-client limit is keyed by `clientKey`, never the raw address: one
 * IPv6 subscriber holds a whole /64 and can send from a fresh address per
 * request, so a /128 key gave a single sender unlimited buckets, IP throttles
 * and log allowances (found in review, 2026-10-02: 30 loops rotating the low
 * 64 bits filled the scrypt queue and every proven sign-in of the owner's
 * device came back "busy").
 */
import { isIP } from 'node:net'

/** The eight hextets of an IPv6 address `isIP` accepted (zone already stripped). */
function hextets(a: string): number[] | null {
  // A trailing dotted quad (`::ffff:1.2.3.4`) is the last two hextets written another way.
  const text = a.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (_m, b0, b1, b2, b3) =>
    `${((Number(b0) << 8) | Number(b1)).toString(16)}:${((Number(b2) << 8) | Number(b3)).toString(16)}`
  )
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)))
  const at = text.indexOf('::')
  let groups: number[]
  if (at >= 0) {
    const head = parse(text.slice(0, at))
    const rest = parse(text.slice(at + 2))
    const fill = 8 - head.length - rest.length
    if (fill < 0) return null
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest]
  } else groups = parse(text)
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/**
 * What one client is counted as: an IPv4 address as it is (an IPv4-mapped
 * IPv6 address as its IPv4), an IPv6 address as its /64 — the block one
 * subscriber is handed — and anything that is not an address as it came.
 */
export function clientKey(ip: string): string {
  let a = ip.trim().toLowerCase()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  const kind = isIP(a)
  if (kind === 4) return a
  if (kind !== 6) return ip
  const g = hextets(a)
  if (!g) return a
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
  }
  return `${g
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(':')}::/64`
}

/** A token bucket per key: `capacity` requests at once, refilled at `refillPerSec`. */
export class RateBuckets {
  private readonly capacity: number
  private readonly refillPerSec: number
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  constructor(opts: { capacity: number; refillPerSec: number }) {
    this.capacity = Math.max(1, opts.capacity)
    this.refillPerSec = Math.max(0.001, opts.refillPerSec)
  }

  take(key: string, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now }
    const tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec)
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now })
      return { ok: false, retryAfterMs: Math.ceil(((1 - tokens) / this.refillPerSec) * 1000) }
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now })
    return { ok: true }
  }

  /** Drop buckets that have refilled completely; they hold no information. */
  sweep(now: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k)
    }
  }
}

/** At most `slots` holders at once; up to `queue` more wait; beyond that `acquire` answers null. */
export class Semaphore {
  private readonly slots: number
  private readonly maxQueue: number
  private held = 0
  private readonly waiting: (() => void)[] = []

  constructor(slots: number, maxQueue: number) {
    this.slots = slots
    this.maxQueue = maxQueue
  }

  /** A release function once a slot is free, or null at once when the queue is full. */
  acquire(): Promise<() => void> | null {
    const release = (): void => {
      this.held--
      const next = this.waiting.shift()
      if (next) next()
    }
    if (this.held < this.slots) {
      this.held++
      return Promise.resolve(once(release))
    }
    if (this.waiting.length >= this.maxQueue) return null
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.held++
        resolve(once(release))
      })
    })
  }
}

function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

/** Claims per key, at most `max` at a time. `claim` is synchronous: take it before the first await. */
export class InFlight {
  private readonly max: number
  private readonly counts = new Map<string, number>()

  constructor(max: number) {
    this.max = max
  }

  claim(key: string): (() => void) | null {
    const n = this.counts.get(key) ?? 0
    if (n >= this.max) return null
    this.counts.set(key, n + 1)
    return once(() => {
      const left = (this.counts.get(key) ?? 1) - 1
      if (left <= 0) this.counts.delete(key)
      else this.counts.set(key, left)
    })
  }
}
