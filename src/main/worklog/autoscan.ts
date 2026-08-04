/**
 * Auto-scan: notice that a work block finished, and offer to log it.
 *
 * The user's ask, verbatim: "it should auto scan while im working and it should
 * just pop up a should I add this task or update the status for this task".
 *
 * The signal is the transcript file itself. `ContextWatcher` already polls every
 * open session's JSONL at 1.5s to draw the context meter, and it already reports
 * the message count and the modification time — which is exactly "how much work
 * has happened" and "when did it last happen". So nothing new watches anything;
 * this module is fed the readings that were being taken anyway.
 *
 * Four rules keep it from being a nuisance or a bill, and each one is a real
 * failure it would otherwise have:
 *
 *  - **Quiet first.** Scanning mid-turn describes a job half done, and the
 *    prompt would interrupt the very work it is asking about.
 *  - **A baseline on first sight.** Opening a resumed session with 300 messages
 *    in it must not read as 300 messages of new work. Only what happens after
 *    Stoke starts watching counts.
 *  - **A floor and a cooldown.** One question and a one-line answer is not a
 *    work block, and the same session should not be re-proposed every few
 *    minutes.
 *  - **A ceiling per hour.** Every scan is a real Claude run. A loop here would
 *    be a bill rather than a bug report.
 *
 * The decision is a pure function so scripts/verify-worklog-autoscan.mts can
 * exercise every rule against a clock it controls; nothing in this file imports
 * electron.
 */

export interface AutoScanConfig {
  /** Quiet time since the last transcript write before a session counts as done. */
  idleMs: number
  /** New messages since the last scan before there is anything worth logging. */
  minNewMessages: number
  /** Shortest gap between two automatic scans of the same session. */
  cooldownMs: number
  /** Ceiling on automatic scans started in any rolling hour, across all sessions. */
  maxPerHour: number
  /** How often the tracked sessions are re-evaluated. */
  tickMs: number
}

export const DEFAULT_AUTOSCAN: AutoScanConfig = {
  idleMs: 120_000,
  minNewMessages: 6,
  cooldownMs: 20 * 60_000,
  maxPerHour: 6,
  tickMs: 15_000
}

export const HOUR_MS = 60 * 60_000

/**
 * Sessions tracked at once. Well past any real day's tabs; it exists so a run
 * left open for a fortnight cannot grow the map without bound.
 */
export const MAX_TRACKED = 64

/** One session, as the scanner sees it. */
export interface SessionActivity {
  sessionId: string
  /** Latest reading from the transcript. */
  messageCount: number
  /** Transcript mtime, in the same clock as `now`. */
  updatedAt: number
  /** Message count at the last scan, or at first sight if there has been none. */
  scannedMessages: number
  /** When the last automatic scan started. 0 for never. */
  lastScanAt: number
  /** A scan for this session is in flight. */
  scanning: boolean
  /**
   * Do not re-evaluate before this. Set when the gate says no, so an unwatched
   * session does not cost a project-list read on every tick.
   */
  mutedUntil: number
}

export type AutoScanReason =
  | 'scanning'
  | 'muted'
  | 'no-reading'
  | 'not-idle'
  | 'too-little-work'
  | 'cooldown'
  | 'hourly-limit'

export type AutoScanVerdict = { scan: true } | { scan: false; reason: AutoScanReason }

/**
 * Should this session be scanned right now?
 *
 * `recentScans` is the start time of every automatic scan in the recent past,
 * across all sessions; anything older than an hour is ignored here rather than
 * required to have been pruned by the caller.
 */
export function autoScanVerdict(
  s: SessionActivity,
  now: number,
  recentScans: readonly number[],
  cfg: AutoScanConfig = DEFAULT_AUTOSCAN
): AutoScanVerdict {
  if (s.scanning) return { scan: false, reason: 'scanning' }
  if (s.mutedUntil > now) return { scan: false, reason: 'muted' }
  // A session whose transcript has never been read has no mtime to be idle
  // since, and a zero would read as "idle since 1970".
  if (!s.updatedAt) return { scan: false, reason: 'no-reading' }
  if (now - s.updatedAt < cfg.idleMs) return { scan: false, reason: 'not-idle' }
  if (s.messageCount - s.scannedMessages < cfg.minNewMessages) {
    return { scan: false, reason: 'too-little-work' }
  }
  if (s.lastScanAt && now - s.lastScanAt < cfg.cooldownMs) return { scan: false, reason: 'cooldown' }
  if (recentScans.filter((t) => now - t < HOUR_MS).length >= cfg.maxPerHour) {
    return { scan: false, reason: 'hourly-limit' }
  }
  return { scan: true }
}

export interface AutoScannerOptions {
  config?: Partial<AutoScanConfig>
  /** Is auto-scanning switched on at all? Read fresh, so Settings takes effect at once. */
  enabled: () => boolean
  /**
   * Is this session's folder one the user asked to watch? Called only when every
   * other rule already says scan, because answering it costs a project-list read.
   */
  watched: (sessionId: string) => boolean | Promise<boolean>
  /** Run the scan. Resolves with how many proposals it added. Must not throw. */
  scan: (sessionId: string) => Promise<number>
  /** Called when a scan added something, so the UI can ask about it. */
  onProposed?: (sessionId: string, added: number) => void
  /** Injectable clock and timer, so the tests do not wait in real time. */
  now?: () => number
}

/**
 * Tracks live sessions and starts scans when they go quiet.
 *
 * Fed by `observe`, which is safe to call on every context reading — it is a
 * map write and nothing else. The evaluation runs on its own interval instead,
 * because "nothing has happened for two minutes" is precisely the case where no
 * reading arrives to trigger it.
 */
export class AutoScanner {
  readonly config: AutoScanConfig
  private readonly sessions = new Map<string, SessionActivity>()
  private readonly recentScans: number[] = []
  private readonly opts: AutoScannerOptions
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private disposed = false
  /** A pass is in flight. See evaluate() for why one at a time is the rule. */
  private evaluating = false

  // Explicit assignment rather than TS parameter properties, matching the other
  // main-process modules so this stays runnable under node's type stripping.
  constructor(opts: AutoScannerOptions) {
    this.opts = opts
    this.config = { ...DEFAULT_AUTOSCAN, ...opts.config }
    this.now = opts.now ?? Date.now
  }

  /** Start evaluating. Idempotent. */
  start(): void {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => void this.evaluate(), this.config.tickMs)
    // Never hold the app open for a poll; this is background housekeeping.
    this.timer.unref?.()
  }

  /**
   * Record a transcript reading.
   *
   * The first reading for a session sets the baseline rather than counting as
   * work: a resumed session arrives with its whole history already in it, and
   * treating that as new would fire a scan for a session nobody has touched.
   */
  observe(sessionId: string, messageCount: number, updatedAt: number): void {
    if (!sessionId || this.disposed) return
    const found = this.sessions.get(sessionId)
    if (!found) {
      this.sessions.set(sessionId, {
        sessionId,
        messageCount,
        updatedAt,
        scannedMessages: messageCount,
        lastScanAt: 0,
        scanning: false,
        mutedUntil: 0
      })
      this.evict()
      return
    }
    found.messageCount = messageCount
    // Never let a reading move the clock backwards: findSessionFile can land on
    // a different file after a fork, and an older mtime would read as a session
    // that has been quiet for longer than it has.
    if (updatedAt > found.updatedAt) found.updatedAt = updatedAt
  }

  /**
   * Drop the least recently active sessions once too many are tracked.
   *
   * Note what does *not* drop one: closing its tab. Finishing and closing is
   * the most natural end of a work block there is, and it happens seconds
   * before the idle timer would have fired — so a session keeps being tracked
   * after its PTY exits, and is scanned on the strength of the last reading
   * taken while it was alive.
   */
  private evict(): void {
    if (this.sessions.size <= MAX_TRACKED) return
    const byAge = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    for (const s of byAge) {
      if (this.sessions.size <= MAX_TRACKED) break
      // Never evict a session mid-scan: its `scanning` flag is the only thing
      // stopping a second run, and losing it would start one.
      if (s.scanning) continue
      this.sessions.delete(s.sessionId)
    }
  }

  /** The tracked state, for tests and for the verify suite. */
  state(sessionId: string): SessionActivity | null {
    const found = this.sessions.get(sessionId)
    return found ? { ...found } : null
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.sessions.clear()
  }

  /** One pass over every tracked session. Exposed so tests need no timers. */
  async evaluate(): Promise<void> {
    if (this.disposed || !this.opts.enabled()) return
    /*
     * One pass at a time.
     *
     * The gate is asynchronous — it reads the project list off disk — so a pass
     * can outlive the interval that started it. Two passes running at once would
     * each see the same session un-claimed and each start a run for it: two paid
     * Claude runs for one work block, and two prompts asking the same question.
     */
    if (this.evaluating) return
    this.evaluating = true
    try {
      const now = this.now()
      // Bounded: only the last hour ever matters to the ceiling.
      while (this.recentScans.length && now - this.recentScans[0] >= HOUR_MS) this.recentScans.shift()

      for (const session of [...this.sessions.values()]) {
        const verdict = autoScanVerdict(session, now, this.recentScans, this.config)
        if (!verdict.scan) continue

        /*
         * Claim the session before asking the gate, not after.
         *
         * `watched` is awaited, and anything awaited is a window. The reentrancy
         * guard above closes it for two interval ticks, but not for a direct
         * call arriving during that await — and `scanning` is the flag every
         * other path already checks, so setting it here makes the claim hold
         * against all of them rather than just one.
         */
        session.scanning = true
        let watched = false
        try {
          watched = await this.opts.watched(session.sessionId)
        } catch {
          // A gate that cannot answer is not a licence to scan.
          watched = false
        }
        if (!watched) {
          session.scanning = false
          session.mutedUntil = this.now() + this.config.cooldownMs
          continue
        }
        /*
         * Re-checked after the await, not only at the top. The gate is a disk
         * read; the window can close during it, and starting a paid `claude -p`
         * for a window that no longer exists produces a bill and no proposal
         * anyone will ever see.
         */
        if (this.disposed) {
          session.scanning = false
          return
        }

        void this.run(session)
      }
    } finally {
      this.evaluating = false
    }
  }

  private async run(session: SessionActivity): Promise<void> {
    const started = this.now()
    session.scanning = true
    session.lastScanAt = started
    /*
     * Bank the message count *before* the run, not after.
     *
     * A scan takes tens of seconds and the user carries on typing. Recording
     * the count on completion would swallow everything written during the run,
     * and that work would then never be logged by anything.
     */
    const banked = session.messageCount
    this.recentScans.push(started)

    try {
      const added = await this.opts.scan(session.sessionId)
      session.scannedMessages = Math.max(session.scannedMessages, banked)
      if (added > 0) this.opts.onProposed?.(session.sessionId, added)
    } catch {
      /*
       * A failed scan still counts as attempted. Leaving the baseline where it
       * was would re-fire the moment the cooldown lapsed, and a destination
       * that is down stays down — turning one failure into a slow, silent loop
       * of paid runs.
       */
      session.scannedMessages = Math.max(session.scannedMessages, banked)
    } finally {
      session.scanning = false
    }
  }
}
