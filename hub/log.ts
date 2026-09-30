/*
 * The hub's structured log: one JSON object per line on stdout, which is what
 * the systemd journal and `docker logs` keep.
 *
 * Nothing secret is ever written, and that is enforced here rather than hoped
 * for at every call site: a field whose NAME says it is secret (token,
 * password, secret, invite, authorization, signature, nonce, ciphertext, wrap)
 * is replaced before the line is built, and so is any string VALUE shaped like
 * a session token or an invite. The one deliberate exception is the bootstrap
 * invite, printed once as plain text by `server.ts` through a separate sink
 * (spec §3.1: the owner reads it from the journal) and never through this.
 *
 * A request log names the route, never the raw path, so no query value ends up
 * in the journal either. Refusals from strangers (a scanner that found the
 * tunnel hostname) are rate-limited per minute, so a flood costs a summary
 * line, not a full disk.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Field names whose values never reach the log, whatever they hold. */
const SECRET_NAME = /token|password|passwd|secret|invite|authorization|cookie|^sig$|signature|nonce|^ct$|ciphertext|wrap|kit|recovery/i
/** Values that are a credential whatever field carries them. */
const SECRET_VALUE = /^(sht_|INV-|RK1-|Bearer\s)/i

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[redacted]' : value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (value === null || typeof value !== 'object') return value
  if (depth > 4) return '[deep]'
  if (value instanceof Error) return { name: value.name, message: String(value.message).slice(0, 500) }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_NAME.test(k) ? '[redacted]' : redact(v, depth + 1)
  return out
}

export class HubLog {
  private readonly sink: (line: string) => void
  private readonly min: number
  private readonly now: () => number

  constructor(sink: (line: string) => void, opts: { level?: LogLevel; now?: () => number } = {}) {
    this.sink = sink
    this.min = LEVELS[opts.level ?? 'info']
    this.now = opts.now ?? Date.now
  }

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (LEVELS[level] < this.min) return
    const safe = redact(fields) as Record<string, unknown>
    let line: string
    try {
      line = JSON.stringify({ t: new Date(this.now()).toISOString(), level, msg, ...safe })
    } catch {
      line = JSON.stringify({ t: new Date(this.now()).toISOString(), level, msg, note: 'fields could not be encoded' })
    }
    this.sink(line)
  }

  debug(msg: string, fields?: LogFields): void {
    this.log('debug', msg, fields)
  }
  info(msg: string, fields?: LogFields): void {
    this.log('info', msg, fields)
  }
  warn(msg: string, fields?: LogFields): void {
    this.log('warn', msg, fields)
  }
  error(msg: string, fields?: LogFields): void {
    this.log('error', msg, fields)
  }
}

/**
 * At most `perMinute` lines per key per minute; the rest are counted and
 * reported in one `suppressed` line when the minute rolls over.
 */
export class LogThrottle {
  private readonly perMinute: number
  private windowStart = 0
  private counts = new Map<string, number>()

  constructor(perMinute: number) {
    this.perMinute = perMinute
  }

  /** Whether to write this line now. `log` receives the summary of the minute that just ended. */
  allow(key: string, now: number, log: HubLog): boolean {
    if (now - this.windowStart >= 60_000) {
      const dropped = [...this.counts].filter(([, n]) => n > this.perMinute).map(([k, n]) => ({ key: k, dropped: n - this.perMinute }))
      if (dropped.length > 0) log.warn('log lines suppressed', { window: '1m', dropped })
      this.counts.clear()
      this.windowStart = now
    }
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    return n <= this.perMinute
  }
}
