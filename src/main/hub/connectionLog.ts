/*
 * "Keep a connection log": `<userData>/connections.log`, and `.1` before it.
 *
 * Off by default (`hub.connectionLog`, this computer's own, never synced).
 * On, it records when this computer's connections to its other computers
 * open, drop and reconnect — the guest's and the host's relay lifecycle and
 * the presence socket's (`HubRemote`, `HubPresence`, through their `trace`
 * hooks) — plus sleep, wake and screen lock, so a drop can be traced. Turn it
 * on on BOTH machines: a drop is explained only from both ends.
 *
 * What a line may hold is decided by `traceFields` (shared/hub/connectionTrace.ts):
 * ids, times, counts and tags, never text. A line is
 * `<ISO time> <event> key=value …` (`formatLine`), for example
 *
 *   2026-10-28T03:00:01.234Z relay-close side=guest relay=r… peer=dsvt0 tab=3 code=1006 why=host-left lifeMs=8432 …
 *
 * The setting is read on every event, so the toggle takes effect at once, and
 * nothing is created or written while it is off. A `log-start` line (version,
 * OS, arch and `hubVia`, the KIND of hub address) opens every stretch of
 * logging: at start when on, and whenever it is turned on.
 *
 * Files: `DiagnosticsLog` (diagnosticsLog.ts), the freeze log's writer, under
 * another name — async appends, one rotation at `CONNECTION_LOG_CAP_BYTES`, so
 * at most about two caps on disk. `EventLimiter` holds a burst of one kind (a
 * reconnect loop) to `CONNECTION_EVENT_BURST` lines per window and counts the
 * rest onto the next line of that kind (`suppressed=`).
 *
 * No electron import (src/main/connections.ts hands it Electron's objects), so
 * `verify:connection-log` drives it with a fake file system and clock.
 */
import { DiagnosticsLog, EventLimiter, formatLine, nodeLogFs, type Emitter, type LogFs } from '../diagnosticsLog.ts'
import { hubViaOf, traceFields, type TraceFields } from '../../shared/hub/connectionTrace.ts'

export const CONNECTION_LOG_NAME = 'connections.log'
export const CONNECTION_LOG_CAP_BYTES = 1_000_000
/** Lines of one kind per `CONNECTION_EVENT_WINDOW_MS`, the rest counted: a reconnect loop runs at about one cycle a second. */
export const CONNECTION_EVENT_BURST = 60
export const CONNECTION_EVENT_WINDOW_MS = 10 * 60_000

export interface ConnectionLogAbout {
  version: string
  /** `process.platform`. */
  os: string
  arch: string
  /** The hub URL, read only to say what kind of address it is (`hubViaOf`); never written. */
  hubUrl: string
}

export interface ConnectionLogOptions {
  dir: string
  /** `settings.hub.connectionLog`, read on every event. */
  enabled(): boolean
  about(): ConnectionLogAbout
  fs?: LogFs
  now?: () => number
  cap?: number
  burst?: number
  windowMs?: number
}

export class ConnectionLog {
  readonly file: string
  readonly rotated: string
  private readonly o: ConnectionLogOptions
  private readonly now: () => number
  private readonly fs: LogFs
  private log: DiagnosticsLog | null
  private limiter: EventLimiter
  /** Whether the last look at the setting found it on: a look that finds it newly on writes `log-start` first. */
  private on: boolean
  /** Remote tab ids (`rt-…`, random) as a local counter: the log needs to tell tabs apart, not name them. */
  private readonly tabs: Map<string, number>

  constructor(o: ConnectionLogOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.fs = o.fs ?? nodeLogFs
    // The paths only: `DiagnosticsLog` touches no file until something is written.
    const probe = new DiagnosticsLog(o.dir, this.fs, o.cap ?? CONNECTION_LOG_CAP_BYTES, this.now, CONNECTION_LOG_NAME)
    this.file = probe.file
    this.rotated = probe.rotated
    this.log = null
    this.limiter = new EventLimiter(o.burst ?? CONNECTION_EVENT_BURST, o.windowMs ?? CONNECTION_EVENT_WINDOW_MS)
    this.on = false
    this.tabs = new Map()
  }

  /** The hook `HubRemote` and `HubPresence` are handed. Never throws. */
  trace(event: string, fields: TraceFields = {}): void {
    try {
      if (!this.look()) return
      const tab = fields.tab
      const mapped = typeof tab === 'string' ? { ...fields, tab: this.tabNumber(tab) } : fields
      const kept = traceFields(event, mapped)
      if (!kept) return
      const at = this.now()
      const { ok, suppressed } = this.limiter.take(event, at)
      if (!ok) return
      this.writer().write(formatLine(at, event, suppressed ? { ...kept, suppressed } : kept))
    } catch {
      /* the log never breaks a connection */
    }
  }

  /** At start, and on every settings change: turned on writes `log-start` now. */
  settingChanged(): void {
    try {
      this.look()
    } catch {
      /* as above */
    }
  }

  /** Sleep, wake and screen lock, from Electron's `powerMonitor` (or a suite's fake). */
  watchPower(power: Emitter): void {
    let suspendedAt = 0
    power.on('suspend', () => {
      suspendedAt = this.now()
      this.trace('suspend')
    })
    power.on('resume', () => {
      const asleepMs = suspendedAt ? this.now() - suspendedAt : undefined
      suspendedAt = 0
      this.trace('resume', { asleepMs })
    })
    power.on('lock-screen', () => this.trace('lock-screen'))
    power.on('unlock-screen', () => this.trace('unlock-screen'))
  }

  /** Resolves once every line written so far is on disk. */
  async idle(): Promise<void> {
    await this.log?.idle()
  }

  /** Whether either file exists, and their bytes together. */
  async state(): Promise<{ exists: boolean; bytes: number }> {
    await this.idle()
    const sizes = await Promise.all([this.fs.size(this.rotated).catch(() => 0), this.fs.size(this.file).catch(() => 0)])
    const bytes = sizes[0] + sizes[1]
    return { exists: bytes > 0, bytes }
  }

  /** The file to show: the current one, else `.1` (just rotated), else null (no log yet). */
  async newest(): Promise<string | null> {
    await this.idle()
    if ((await this.fs.size(this.file).catch(() => 0)) > 0) return this.file
    if ((await this.fs.size(this.rotated).catch(() => 0)) > 0) return this.rotated
    return null
  }

  /** Both files' text, the older (`.1`) first. */
  async text(): Promise<string> {
    await this.idle()
    const read = async (file: string): Promise<string> => {
      const size = await this.fs.size(file).catch(() => 0)
      if (!size) return ''
      const tail = await this.fs.tail(file, size)
      return tail.text
    }
    const [older, newer] = await Promise.all([read(this.rotated), read(this.file)])
    return older + newer
  }

  /** The setting, read now; on after off writes the `log-start` line first. */
  private look(): boolean {
    if (!this.o.enabled()) {
      this.on = false
      return false
    }
    if (!this.on) {
      this.on = true
      this.writeStart()
    }
    return true
  }

  private writeStart(): void {
    const a = this.o.about()
    const kept = traceFields('log-start', { version: a.version, os: a.os, arch: a.arch, hubVia: hubViaOf(a.hubUrl) }) ?? {}
    this.writer().write(formatLine(this.now(), 'log-start', kept))
  }

  private writer(): DiagnosticsLog {
    this.log ??= new DiagnosticsLog(this.o.dir, this.fs, this.o.cap ?? CONNECTION_LOG_CAP_BYTES, this.now, CONNECTION_LOG_NAME)
    return this.log
  }

  private tabNumber(id: string): number {
    let n = this.tabs.get(id)
    if (n === undefined) {
      n = this.tabs.size + 1
      this.tabs.set(id, n)
    }
    return n
  }
}
