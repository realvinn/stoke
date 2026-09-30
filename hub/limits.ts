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
 */

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
