import { appendFileSync } from 'node:fs'
import { appendFile, open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHistogram, performance, type RecordableHistogram } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

/**
 * Freeze telemetry: what it records, how often, and the file it keeps.
 *
 * Before this a freeze left no trace anywhere. Stoke wrote no log, had no
 * handler for a window going unresponsive or a renderer or GPU process dying,
 * and nothing watched its own event loop, so "the window froze", "main froze"
 * and "the `claude` in the tab is stuck" could not be told apart afterwards.
 * The one freeze macOS recorded this week (a Keychain prompt holding main for
 * 8-18 s before the window existed) was found in spindump, not here.
 *
 * What is written, one line each, to `<userData>/diagnostics.log`:
 *   start / quit                 the build, Electron, OS and arch; uptime at quit.
 *                                `previous=unclean` on a start whose last run never
 *                                reached its quit line (a crash, a Force Quit)
 *   window-unresponsive / -responsive   with how long, per window id
 *   renderer-gone / child-gone   Chromium's reason and exit code (GPU, utility)
 *   suspend / resume             so a gap across sleep is not read as a freeze
 *   stall                        the main event loop held past `STALL_MS`, with
 *                                when the worst one began (`worstAt`)
 *   main-stalled / -recovered    from the watchdog THREAD, while main is still
 *                                held: the one line a hang ended by Force Quit leaves
 *                                (a burst of them per window, then only long holds)
 *
 * Nothing personal: no path but the log's own, no URL, no title, no terminal
 * text. Every string value is cut to a short token (`formatLine`).
 *
 * Electron-free, so `verify:freeze` drives all of it with a fake app, a fake
 * clock and a fake file system, and runs the watchdog on a real thread;
 * `diagnostics.ts` hands it Electron's objects.
 */

export const LOG_NAME = 'diagnostics.log'
/** One file to this size, then it becomes `.1` (the previous `.1` is replaced): at most two caps on disk. */
export const LOG_CAP_BYTES = 1_000_000
/** Lines held while a write is slow; past it they are counted and the count is logged instead. */
export const PENDING_MAX = 500
/** How much of the old log's end is read at start, for its last run's last lines. */
export const TAIL_BYTES = 4096
/** A line this much later than a `quit` above it is a later run's, not an append that was in flight at quit. */
export const QUIT_SLACK_MS = 1_000

/** How often the main loop is sampled. Ten wakeups a second; each costs microseconds. */
export const SAMPLE_MS = 100
/** A window of samples, summarised once. */
export const WINDOW_MS = 10_000
/** A sample this late is a stall: well past a frame, short of what a person calls a freeze. */
export const STALL_MS = 500
/** At most one stall line this often; the windows in between are folded into the next line, never dropped. */
export const STALL_LINE_MS = 60_000
/** Other events: at most this many lines of one kind per `EVENT_WINDOW_MS` (a GPU crash loop), the rest counted. */
export const EVENT_BURST = 10
export const EVENT_WINDOW_MS = 10 * 60_000
/** Main's sampler tells the watchdog whether a window is focused and visible once per this many samples (1 s). */
export const PUBLISH_EVERY = 10

const FIELD_MAX = 64

export type Field = string | number | boolean | null | undefined

/** A short token: letters, digits and a few separators, cut to `FIELD_MAX`. No spaces, so a line splits on them. */
function token(value: string): string {
  return value.replace(/[^\w.:/@+-]/g, '_').slice(0, FIELD_MAX) || '_'
}

/** `<ISO time> <event> key=value …`, values cut to tokens and numbers rounded; empty fields left out. */
export function formatLine(at: number, event: string, fields: Record<string, Field> = {}): string {
  let line = `${new Date(at).toISOString()} ${token(event)}`
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    const shown = typeof value === 'number' ? String(Math.round(value)) : typeof value === 'boolean' ? String(value) : token(value)
    line += ` ${token(key)}=${shown}`
  }
  return line
}

/** Whether appending `adding` bytes to a file of `size` must rotate it first. An empty file never rotates. */
export function needsRotation(size: number, adding: number, cap: number = LOG_CAP_BYTES): boolean {
  return size > 0 && size + adding > cap
}

/** The end of a file: `whole` when it starts at byte 0 (else its first line is cut and is not a line). */
export interface LogTail {
  text: string
  whole: boolean
}

/** The file operations the log needs, so a suite can hand it a fake. */
export interface LogFs {
  append(file: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** The file's size, 0 when it does not exist. */
  size(file: string): Promise<number>
  /** The last `bytes` of the file; an empty whole tail when it does not exist. */
  tail(file: string, bytes: number): Promise<LogTail>
  /** Only at quit, for the last few lines, when nothing waits on the main thread any more. */
  appendSync(file: string, text: string): void
}

async function readTail(file: string, bytes: number): Promise<LogTail> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', whole: true }
    throw err
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, bytes)
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, size - length)
    return { text: buf.toString('utf8', 0, bytesRead), whole: length === size }
  } finally {
    await handle.close()
  }
}

export const nodeLogFs: LogFs = {
  // Append mode, opened per call: the watchdog thread appends to the same file
  // with its own sync writes, and O_APPEND keeps each line whole between them.
  append: (file, text) => appendFile(file, text, 'utf8'),
  rename: (from, to) => rename(from, to),
  size: (file) =>
    stat(file).then(
      (s) => s.size,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return 0
        throw err
      }
    ),
  tail: readTail,
  appendSync: (file, text) => appendFileSync(file, text, 'utf8')
}

/**
 * An append-only log with one rotation, written asynchronously.
 *
 * A write only queues the line; one drain at a time appends whatever has
 * queued, so a burst becomes one append and nothing here ever blocks the main
 * thread. A failed write loses its lines rather than retrying forever. A failed
 * ROTATION does not: the lines are appended anyway and the rename is tried
 * again on the next write — Windows refuses the rename while a viewer or a
 * scanner holds `.1` open, and a file a little past the cap is better than
 * losing the freeze evidence to it.
 *
 * The size is read before EVERY append (one async stat per batch; batches are
 * rare), never counted on from one read: the watchdog thread appends to the
 * same file and only main rotates. Counting only main's own bytes let a main
 * that kept stalling and recovering grow the file without bound — measured
 * with a 2,000-byte cap, 200 of the thread's stalled/recovered pairs and then
 * ten main writes left a 25,246-byte file never rotated. Now the file passes
 * the cap by at most what the thread appended since main's last write (the
 * thread is held to `WATCHDOG_BURST` stalls a window, and main writes a stall
 * line within a minute of any stall the thread can see), plus one batch: about
 * two caps on disk, the old one in `.1`.
 */
export class DiagnosticsLog {
  readonly file: string
  readonly rotated: string
  private fs: LogFs
  private cap: number
  private clock: () => number
  private pending: string[] = []
  private dropped = 0
  private draining: Promise<void> | null = null
  private head: { line: Promise<string>; fallback: string } | null = null

  constructor(dir: string, fs: LogFs = nodeLogFs, cap: number = LOG_CAP_BYTES, clock: () => number = Date.now) {
    this.file = join(dir, LOG_NAME)
    this.rotated = `${this.file}.1`
    this.fs = fs
    this.cap = cap
    this.clock = clock
  }

  write(line: string): void {
    if (this.pending.length >= PENDING_MAX) {
      this.dropped++
      return
    }
    this.pending.push(line)
    if (!this.draining) this.draining = this.drain()
  }

  /**
   * The first line, which waits on `line` — the start line, which waits on the
   * read of the old log's end, so nothing of this run may be appended before
   * that read. Every write queues behind it. `fallback` goes instead if `line`
   * fails, or if a sync flush (quit) comes first.
   */
  first(line: Promise<string>, fallback: string): void {
    this.head = { line, fallback }
    if (!this.draining) this.draining = this.drain()
  }

  /** Resolves once everything written so far is on disk (or lost to a failed write). For tests and quit. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining
  }

  /** At quit: whatever is still queued, synchronously, so the last lines (the quit line) are not lost. */
  flushSync(): void {
    if (this.head) {
      this.pending.unshift(this.head.fallback)
      this.head = null
    }
    const text = this.take()
    if (!text) return
    try {
      this.fs.appendSync(this.file, text)
    } catch {
      /* the last lines are lost; nothing waits on them */
    }
  }

  private take(): string {
    if (this.dropped) {
      this.pending.push(formatLine(this.clock(), 'log-dropped', { lines: this.dropped }))
      this.dropped = 0
    }
    const lines = this.pending.splice(0)
    return lines.length ? lines.map((l) => `${l}\n`).join('') : ''
  }

  private async drain(): Promise<void> {
    try {
      // Let every line written in this tick join one append.
      await Promise.resolve()
      const head = this.head
      if (head) {
        const line = await head.line.catch(() => head.fallback)
        // A sync flush may have written the fallback meanwhile.
        if (this.head === head) {
          this.head = null
          this.pending.unshift(line)
        }
      }
      for (let text = this.take(); text; text = this.take()) {
        try {
          // Read now, not counted from an earlier read: the watchdog thread's lines are in it too.
          if (needsRotation(await this.fs.size(this.file), Buffer.byteLength(text), this.cap)) {
            try {
              await this.fs.rename(this.file, this.rotated)
            } catch {
              /* appended anyway; the next write tries the rotation again */
            }
          }
          await this.fs.append(this.file, text)
        } catch {
          /* these lines are lost; the next batch reads the size afresh */
        }
      }
    } finally {
      this.draining = null
    }
  }
}

/** The last line of the run before this one, and whether that run reached its quit line. */
export interface PreviousRun {
  clean: boolean
  /** The event of its last line, and that line's time. */
  lastEvent: string
  lastAt: string
}

/**
 * How the run before this one ended, from the end of the log as it was at
 * start. Only lines stamped before `startedAt` are its (the watchdog thread may
 * already have written one of this run's). Read backwards: its `start`, or the
 * read's beginning, with no `quit` after it, is an unclean end, and a `quit` is
 * a clean one — unless a line after it is stamped more than `QUIT_SLACK_MS`
 * later. An append in flight at quit lands after the quit line but was stamped
 * before it; a line stamped well after it is a later run's, one that died
 * before its own start line landed: the start line waits on this very read, so
 * a run held from boot (the Keychain freeze) and then Force Quit leaves only
 * its watchdog's `main-stalled`. Null when there is no earlier line.
 */
export function previousRun(tail: LogTail, startedAt: number): PreviousRun | null {
  const lines = tail.text.split('\n')
  if (!tail.whole) lines.shift()
  let last: { event: string; at: string } | null = null
  let latest = Number.NEGATIVE_INFINITY
  for (let i = lines.length - 1; i >= 0; i--) {
    const [at, event] = lines[i].split(' ')
    const t = Date.parse(at)
    if (!event || !Number.isFinite(t) || t >= startedAt) continue
    last ??= { event, at }
    if (event === 'quit') return { clean: latest - t <= QUIT_SLACK_MS, lastEvent: last.event, lastAt: last.at }
    if (event === 'start') break
    latest = Math.max(latest, t)
  }
  return last && { clean: false, lastEvent: last.event, lastAt: last.at }
}

/** The start line's fields for the previous run: only an unclean one is said. */
function previousFields(prev: PreviousRun | null): Record<string, Field> {
  return prev && !prev.clean ? { previous: 'unclean', lastEvent: prev.lastEvent, lastAt: prev.lastAt } : {}
}

/**
 * At most `burst` lines of one kind per window; the ones held back are counted
 * and reported on the next line of that kind (`suppressed`).
 */
export class EventLimiter {
  private burst: number
  private windowMs: number
  private seen = new Map<string, { times: number[]; held: number }>()

  constructor(burst: number = EVENT_BURST, windowMs: number = EVENT_WINDOW_MS) {
    this.burst = burst
    this.windowMs = windowMs
  }

  take(key: string, now: number): { ok: boolean; suppressed: number } {
    const s = this.seen.get(key) ?? { times: [], held: 0 }
    this.seen.set(key, s)
    s.times = s.times.filter((t) => now - t < this.windowMs)
    if (s.times.length >= this.burst) {
      s.held++
      return { ok: false, suppressed: s.held }
    }
    s.times.push(now)
    const suppressed = s.held
    s.held = 0
    return { ok: true, suppressed }
  }
}

/** One window of main-loop samples: the worst and the 99th percentile lateness, and how many samples stalled. */
export interface LoopWindow {
  maxMs: number
  /** Wall time the worst sample's tick was due, i.e. when that stall began (within one `SAMPLE_MS`). */
  maxAt: number
  p99Ms: number
  over: number
  samples: number
}

/**
 * How late each tick of a `SAMPLE_MS` timer fired, in a perf_hooks histogram.
 *
 * Not `monitorEventLoopDelay`, though it is the same measurement, for two
 * reasons measured with Node 26 here: its histogram's `reset()` also forgets
 * the previous tick, so a 600 ms block right after a reset recorded nothing
 * (max 22 ms), and its first tick after `enable()` records nothing either — a
 * main thread blocked straight after install (the Keychain decrypt in
 * `initSecretStore`, the one freeze measured this week) would be invisible. A
 * timer of its own keeps its previous tick across a reset and from the moment
 * it is made, so both are caught. Lateness is recorded rather than the gap, so
 * a sample reads as the stall itself, within one `SAMPLE_MS`.
 */
export class LoopSampler {
  private h: RecordableHistogram = createHistogram()
  private mono: () => number
  private wall: () => number
  private last: number
  private windowStart: number
  private over = 0
  private samples = 0
  /** Exact: the histogram keeps three significant digits, so its max of a 9,900 ms stall reads 9,904. */
  private maxLate = 0
  private maxAt = 0

  constructor(mono: () => number = () => performance.now(), wall: () => number = Date.now) {
    this.mono = mono
    this.wall = wall
    this.last = mono()
    this.windowStart = this.last
  }

  /** One tick of the timer. A summary when the window has run `WINDOW_MS`, else null. */
  tick(): LoopWindow | null {
    const now = this.mono()
    const late = Math.max(0, now - this.last - SAMPLE_MS)
    this.last = now
    // Microseconds, and at least 1: `record` refuses anything below.
    this.h.record(Math.max(1, Math.round(late * 1000)))
    this.samples++
    if (late > this.maxLate || this.samples === 1) {
      this.maxLate = late
      this.maxAt = this.wall() - late
    }
    if (late >= STALL_MS) this.over++
    if (now - this.windowStart < WINDOW_MS) return null
    return this.summary(now)
  }

  /**
   * The window in progress, summarised now, or null when it has no samples. At
   * quit: without it a stall in the last seconds before quitting (up to a whole
   * `WINDOW_MS`) was never written — found driving the built app, where a 3 s
   * block 4 s before quit left the watchdog's lines and no `stall` line.
   */
  flush(): LoopWindow | null {
    return this.samples ? this.summary(this.mono()) : null
  }

  private summary(now: number): LoopWindow {
    const window: LoopWindow = {
      maxMs: this.maxLate,
      maxAt: this.maxAt,
      p99Ms: this.h.percentile(99) / 1000,
      over: this.over,
      samples: this.samples
    }
    this.restart(now)
    return window
  }

  /** Forget the window in progress (after a sleep, whose gap is not a stall). */
  restart(now: number = this.mono()): void {
    this.h.reset()
    this.last = now
    this.windowStart = now
    this.over = 0
    this.samples = 0
    this.maxLate = 0
    this.maxAt = 0
  }
}

/**
 * Whether a Stoke window had focus, and whether any was SHOWN: not hidden and
 * not minimized (`isVisible() && !isMinimized()`). Shown is not "on screen":
 * occlusion is not detected. Measured, a window wholly covered by another of
 * Stoke's own still read `isVisible() === true`; reasoned, so does one behind
 * another app or on another Space, which the OS may still throttle.
 */
export interface Presence {
  focused: boolean
  visible: boolean
}

/**
 * Which windows become a `stall` line. A window whose worst sample reached
 * `STALL_MS` is held; a line goes out when one may (the first at once, then at
 * most every `STALL_LINE_MS`), carrying every window held since the last: the
 * worst and when it began, the worst p99, how many samples stalled, how many
 * windows, and whether any Stoke window had focus, or was shown at all
 * (`Presence`), as a stalled window closed. A stall while nothing is focused
 * AND nothing is shown may be the OS throttling a background app's timers (App
 * Nap). `visible=true` narrows that only so far: a shown window may still be
 * covered or on another Space, and throttled there too, so a stall with
 * `focused=false visible=true` is not proof a person saw it.
 */
export class StallWatch {
  private lastLineAt = Number.NEGATIVE_INFINITY
  private held: { maxMs: number; maxAt: number; p99Ms: number; over: number; windows: number; focused: boolean; visible: boolean } | null = null

  observe(w: LoopWindow | null, now: number, seen: Presence): Record<string, Field> | null {
    if (w && w.maxMs >= STALL_MS) {
      const h = this.held ?? { maxMs: 0, maxAt: w.maxAt, p99Ms: 0, over: 0, windows: 0, focused: false, visible: false }
      if (w.maxMs > h.maxMs) {
        h.maxMs = w.maxMs
        h.maxAt = w.maxAt
      }
      h.p99Ms = Math.max(h.p99Ms, w.p99Ms)
      h.over += w.over
      h.windows++
      h.focused ||= seen.focused
      h.visible ||= seen.visible
      this.held = h
    }
    if (!this.held || now - this.lastLineAt < STALL_LINE_MS) return null
    this.lastLineAt = now
    return this.release()
  }

  /** What is held, whatever the rate: at quit. */
  drain(): Record<string, Field> | null {
    return this.held ? this.release() : null
  }

  private release(): Record<string, Field> {
    const h = this.held!
    this.held = null
    return {
      max: h.maxMs,
      worstAt: new Date(h.maxAt).toISOString(),
      p99: h.p99Ms,
      over: h.over,
      windows: h.windows,
      focused: h.focused,
      visible: h.visible
    }
  }
}

/* ------------------------------------------------------------ the watchdog
 *
 * Main's own sampler writes a stall line only once the loop is back, and
 * Chromium's `unresponsive` is main's event too, so a main thread that never
 * comes back — a hang the owner ends with Force Quit — left a `start` line and
 * nothing else. The watchdog is a worker thread: main's 100 ms tick stores the
 * time into a SharedArrayBuffer (`beat`), and the thread, ticking on its own
 * loop, appends `main-stalled` once that is `stallMs` old, then
 * `main-recovered` when it moves again. Its appends are sync, on its own
 * thread, reopened per line in append mode; main alone rotates.
 *
 * Throttling is not a stall: App Nap, a stopped process or a sleep holds the
 * watchdog's own timer as well as main's. A watchdog tick that came `gapMs`
 * late means it saw nothing meanwhile, so it starts watching again from that
 * tick, and main gets a whole `stallMs` from there to beat. A main still held
 * then is a stall, and is said late rather than never.
 *
 * A main that keeps stalling and recovering is held to `burst` stalls said per
 * `windowMs`. Past it, a stall is said only once main has been held `longMs`
 * (a hang heading for Force Quit still leaves its line, just later), and the
 * short ones held back are counted onto the next `main-stalled`
 * (`suppressed=`); main's own `stall` lines keep counting them meanwhile.
 * Unlimited, a 2 s stall every 2.25 s is 123 bytes a pair, ~4.7 MB a day,
 * which rotates every earlier line out of both files within half a day;
 * limited, ~180 KB. Only a main held past `longMs` nearly all the time still
 * writes MBs a day (at most one pair per 5 s, ~2.1 MB): an app frozen all day.
 *
 * The thread is built from a string (`watchdogSource`, `eval: true`), so it
 * needs no file of its own in the bundle: the three functions below are its
 * code, stringified, and must use nothing but their parameters and globals.
 * It reaches built-ins through `process.getBuiltinModule`, never `require`: a
 * Worker inherits the parent's `execArgv`, and under `--input-type=module`
 * (measured, Node 26) eval'd code is ESM, `require` is undefined and the
 * thread died on its first line without a word. A thread that dies or exits
 * unasked is said (`watchdog-gone`), so a silent watchdog is never mistaken
 * for a calm main.
 */

export const WATCHDOG_TICK_MS = 250
export const WATCHDOG_STALL_MS = 2_000
export const WATCHDOG_GAP_MS = 1_000
export const WATCHDOG_BURST = 10
export const WATCHDOG_WINDOW_MS = 10 * 60_000
export const WATCHDOG_LONG_MS = 5_000

export interface WatchdogConfig {
  tickMs: number
  stallMs: number
  /** A watchdog tick this late means the whole process was held (throttled, stopped, asleep). */
  gapMs: number
  /** At most this many stalls said per `windowMs` at `stallMs`… */
  burst: number
  windowMs: number
  /** …past which a stall is said only once main has been held this long. */
  longMs: number
}
export const WATCHDOG_CONFIG: WatchdogConfig = {
  tickMs: WATCHDOG_TICK_MS,
  stallMs: WATCHDOG_STALL_MS,
  gapMs: WATCHDOG_GAP_MS,
  burst: WATCHDOG_BURST,
  windowMs: WATCHDOG_WINDOW_MS,
  longMs: WATCHDOG_LONG_MS
}

/** Bits of the flags slot main publishes. */
export const FLAG_SUSPENDED = 1
export const FLAG_FOCUSED = 2
export const FLAG_VISIBLE = 4
/** Set once main has published presence at all; until then focused/visible are left off the line. */
export const FLAG_KNOWN = 8

/** What the watchdog keeps between ticks (monotonic ms). */
export interface WatchdogState {
  last: number
  watchedFrom: number
  /** The beat the stall in progress waits on, or -1. */
  stalledBeat: number
  /** That stall was held back by the burst: not said yet, and no `main-recovered` for it. */
  quiet: boolean
  /** When each stall said in the last `windowMs` was said. */
  said: number[]
  /** Stalls held back and recovered unsaid since the last `main-stalled`. */
  held: number
}

/** A watchdog state starting at monotonic `t`. Also the thread's code (stringified, like `watchdogStep`): nothing outside itself. */
export function freshWatchdog(t: number): WatchdogState {
  return { last: t, watchedFrom: t, stalledBeat: -1, quiet: false, said: [], held: 0 }
}

/**
 * One watchdog tick: the line to append, or null. `t` and `beat` are the same
 * monotonic clock in ms (`process.hrtime`, one clock for every thread), `wall`
 * is for the timestamp. Pure, so `verify:freeze` drives it on a fake clock; it
 * is ALSO the thread's code (stringified), so it may use nothing outside itself.
 */
export function watchdogStep(s: WatchdogState, t: number, beat: number, flags: number, wall: number, cfg: WatchdogConfig): string | null {
  const late = t - s.last - cfg.tickMs
  s.last = t
  // Held itself, or main says the machine is going to sleep: nothing before now was watched.
  if (late >= cfg.gapMs || (flags & 1) !== 0) s.watchedFrom = t
  const stamp = new Date(wall).toISOString()
  const heldFor = t - Math.max(beat, s.watchedFrom)
  const stalled = (): string => {
    s.quiet = false
    s.said.push(t)
    let line = stamp + ' main-stalled ms=' + Math.round(t - beat)
    if ((flags & 8) !== 0) line += ' focused=' + ((flags & 2) !== 0) + ' visible=' + ((flags & 4) !== 0)
    if (s.held > 0) line += ' suppressed=' + s.held
    s.held = 0
    return line
  }
  if (s.stalledBeat >= 0) {
    // Still held. One held back by the burst is said after all once it has lasted `longMs`.
    if (beat === s.stalledBeat) return s.quiet && heldFor >= cfg.longMs ? stalled() : null
    const after = Math.round(beat - s.stalledBeat)
    s.stalledBeat = -1
    if (s.quiet) {
      s.quiet = false
      s.held++
      return null
    }
    return stamp + ' main-recovered after=' + after
  }
  if (heldFor < cfg.stallMs) return null
  s.stalledBeat = beat
  s.said = s.said.filter((at) => t - at < cfg.windowMs)
  if (s.said.length < cfg.burst) return stalled()
  s.quiet = true
  return null
}

/** What the thread is handed. */
export interface WatchdogData extends WatchdogConfig {
  buffer: SharedArrayBuffer
  file: string
}

/** The thread's loop. Stringified into `watchdogSource`: parameters and globals only. */
function runWatchdog(
  data: WatchdogData,
  append: (file: string, text: string) => void,
  mono: () => number,
  step: typeof watchdogStep,
  fresh: typeof freshWatchdog
): void {
  const slots = new BigInt64Array(data.buffer)
  const s = fresh(mono())
  // Ref'd: it is what keeps this thread alive. Main unrefs the Worker, so it never keeps the app.
  setInterval(() => {
    const line = step(s, mono(), Number(Atomics.load(slots, 0)) / 1e6, Number(Atomics.load(slots, 1)), Date.now(), data)
    if (line === null) return
    try {
      append(data.file, line + '\n')
    } catch {
      /* the folder is gone or full; the next line may land */
    }
  }, data.tickMs)
}

/** The worker's whole program, for `new Worker(source, { eval: true })`: built-ins only, and runs as CommonJS or ESM. */
export function watchdogSource(): string {
  return [
    "'use strict'",
    "const { workerData } = process.getBuiltinModule('node:worker_threads')",
    "const { appendFileSync } = process.getBuiltinModule('node:fs')",
    'const step = (' + watchdogStep.toString() + ')',
    'const fresh = (' + freshWatchdog.toString() + ')',
    ';(' + runWatchdog.toString() + ')(workerData, (file, text) => appendFileSync(file, text, { flag: "a" }), () => Number(process.hrtime.bigint()) / 1e6, step, fresh)'
  ].join('\n')
}

/** Main's end of the watchdog. */
export interface WatchdogLink {
  /** Main is alive now: called from every sampler tick. */
  beat(): void
  /** Whether a window is focused, and whether one is shown (`Presence`), for the watchdog's line. */
  presence(seen: Presence): void
  /** The machine is going to sleep (true) or has woken (false). */
  suspended(on: boolean): void
  /** At Electron's `quit`; also safe twice. */
  stop(): void
}

/** The monotonic clock both threads read, in ns: `process.hrtime` is one clock process-wide. */
const hrNow = (): bigint => process.hrtime.bigint()

/**
 * Start the watchdog thread on `file`. Null when a thread cannot be made: the
 * rest of the telemetry goes on without it. The Worker is unref'd, so it never
 * keeps the process from exiting, and its errors are caught, so it never takes
 * main down with it; `gone` hears, once, of a thread that ended unasked.
 */
export function startWatchdog(
  file: string,
  cfg: WatchdogConfig = WATCHDOG_CONFIG,
  gone: (why: string) => void = () => {}
): WatchdogLink | null {
  try {
    const buffer = new SharedArrayBuffer(2 * BigInt64Array.BYTES_PER_ELEMENT)
    const slots = new BigInt64Array(buffer)
    Atomics.store(slots, 0, hrNow())
    const data: WatchdogData = { ...cfg, buffer, file }
    const worker = new Worker(watchdogSource(), { eval: true, workerData: data })
    worker.unref()
    let stopped = false
    let told = false
    const lost = (why: string): void => {
      if (stopped || told) return
      told = true
      gone(why)
    }
    worker.on('error', (err: Error & { code?: unknown }) => lost(typeof err.code === 'string' ? err.code : err.name))
    worker.on('exit', (code: number) => lost(`exit-${code}`))
    let flags = 0
    const setFlags = (next: number): void => {
      flags = next
      Atomics.store(slots, 1, BigInt(flags))
    }
    return {
      beat: () => {
        Atomics.store(slots, 0, hrNow())
      },
      presence: ({ focused, visible }) => {
        setFlags((flags & FLAG_SUSPENDED) | FLAG_KNOWN | (focused ? FLAG_FOCUSED : 0) | (visible ? FLAG_VISIBLE : 0))
      },
      suspended: (on) => {
        setFlags(on ? flags | FLAG_SUSPENDED : flags & ~FLAG_SUSPENDED)
        Atomics.store(slots, 0, hrNow())
      },
      stop: () => {
        if (stopped) return
        stopped = true
        worker.terminate().catch(() => {
          /* already gone */
        })
      }
    }
  } catch {
    return null
  }
}

/* --------------------------------------------------------- the whole watch */

/** What `startDiagnostics` listens to: Electron's `app` and `powerMonitor`, or a suite's fakes. */
export interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown
}
/** A BrowserWindow, as far as the watch needs one. */
export interface WatchedWindow extends Emitter {
  id: number
}

export interface DiagnosticsSources {
  app: Emitter
  powerMonitor: Emitter
  /** For the start line; nothing personal. */
  about: { version: string; electron: string; os: string; arch: string; packaged: boolean }
  /** Whether any Stoke window has focus (`BrowserWindow.getFocusedWindow()`). */
  focused(): boolean
  /** Whether any Stoke window is shown: not hidden and not minimized. Not "on screen": covered windows count (`Presence`). */
  visible(): boolean
  /** The watchdog thread on the log file (`startWatchdog`), told how to say it died; none in a suite that fakes the clock. */
  watchdog?: (file: string, gone: (why: string) => void) => WatchdogLink | null
  /** Wall clock, for timestamps and durations. */
  now?: () => number
  /** Monotonic, for the loop sampler. */
  mono?: () => number
  /** The sampling timer; a suite ticks it by hand. */
  every?: (fn: () => void, ms: number) => { stop(): void }
  fs?: LogFs
}

export interface Diagnostics {
  log: DiagnosticsLog
  /** Stop sampling and the watchdog (the listeners stay; they are the app's for its life). */
  stop(): void
}

function defaultEvery(fn: () => void, ms: number): { stop(): void } {
  const handle = setInterval(fn, ms)
  handle.unref?.()
  return { stop: () => clearInterval(handle) }
}

/** What a gone process's details are, read defensively: Electron's shape, but nothing here may throw. */
function detailsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Start the watch: the start line, the listeners, the sampler and the
 * watchdog. Call once, after `ready` (powerMonitor needs it) and before the
 * first window, so `browser-window-created` sees every window, and before
 * anything that can block, so a block at boot is measured too.
 */
export function startDiagnostics(dir: string, src: DiagnosticsSources): Diagnostics {
  const now = src.now ?? Date.now
  const fs = src.fs ?? nodeLogFs
  const log = new DiagnosticsLog(dir, fs, LOG_CAP_BYTES, now)
  const limiter = new EventLimiter()
  const stalls = new StallWatch()
  const sampler = new LoopSampler(src.mono, now)
  const startedAt = now()
  let suspendedAt = 0
  let quitting = false

  const presence = (): Presence => {
    try {
      return { focused: src.focused(), visible: src.visible() }
    } catch {
      return { focused: false, visible: false }
    }
  }

  const event = (name: string, fields: Record<string, Field> = {}): void => {
    const at = now()
    const { ok, suppressed } = limiter.take(name, at)
    if (!ok) return
    log.write(formatLine(at, name, suppressed ? { ...fields, suppressed } : fields))
  }

  // The read of the old log's end is issued now, before anything of this run
  // can be appended (`first` holds every write until it answers).
  const plainStart = formatLine(startedAt, 'start', { ...src.about })
  log.first(
    fs.tail(log.file, TAIL_BYTES).then((tail) => formatLine(startedAt, 'start', { ...src.about, ...previousFields(previousRun(tail, startedAt)) })),
    plainStart
  )

  let watchdog: WatchdogLink | null = null
  try {
    watchdog = src.watchdog?.(log.file, (why) => event('watchdog-gone', { why })) ?? null
  } catch {
    watchdog = null
  }

  src.app.on('browser-window-created', (_e: unknown, win: WatchedWindow) => {
    const id = win.id
    let since = 0
    win.on('unresponsive', () => {
      if (since) return
      since = now()
      event('window-unresponsive', { win: id })
    })
    win.on('responsive', () => {
      if (!since) return
      const after = now() - since
      since = 0
      event('window-responsive', { win: id, after })
    })
    win.on('closed', () => {
      if (since) event('window-closed-unresponsive', { win: id, after: now() - since })
    })
  })

  src.app.on('render-process-gone', (_e: unknown, contents: unknown, details: unknown) => {
    let kind: string | undefined
    try {
      kind = str((contents as { getType?: () => unknown } | null)?.getType?.())
    } catch {
      kind = undefined
    }
    const d = detailsOf(details)
    event('renderer-gone', { kind, reason: str(d.reason), code: num(d.exitCode), quitting })
  })

  src.app.on('child-process-gone', (_e: unknown, details: unknown) => {
    const d = detailsOf(details)
    // A process that ended by itself with 0 is not a crash, and every helper ends at quit.
    if (quitting || d.reason === 'clean-exit') return
    event('child-gone', {
      type: str(d.type),
      reason: str(d.reason),
      code: num(d.exitCode),
      service: str(d.serviceName),
      name: str(d.name)
    })
  })

  src.powerMonitor.on('suspend', () => {
    suspendedAt = now()
    watchdog?.suspended(true)
    event('suspend')
  })
  src.powerMonitor.on('resume', () => {
    const asleep = suspendedAt ? now() - suspendedAt : undefined
    suspendedAt = 0
    watchdog?.suspended(false)
    sampler.restart()
    event('resume', { asleep })
  })

  let ticks = 0
  /** Presence as of the last second, for a stall summarised at quit, when every window is already closed. */
  let lastSeen: Presence = { focused: false, visible: false }
  const timer = (src.every ?? defaultEvery)(() => {
    // First, whatever else this tick does: the watchdog reads only this.
    watchdog?.beat()
    if (ticks++ % PUBLISH_EVERY === 0) {
      lastSeen = presence()
      watchdog?.presence(lastSeen)
    }
    // Asleep: no sample means anything, and the first one after waking is the sleep itself.
    if (suspendedAt) {
      sampler.restart()
      return
    }
    const window = sampler.tick()
    if (!window) return
    const at = now()
    const line = stalls.observe(window, at, window.maxMs >= STALL_MS ? presence() : { focused: false, visible: false })
    if (line) log.write(formatLine(at, 'stall', line))
  }, SAMPLE_MS)

  src.app.on('before-quit', () => {
    quitting = true
  })
  src.app.on('will-quit', () => {
    quitting = true
  })
  /*
   * The last lines, and the watchdog's end, at Electron's `quit`, not at
   * `will-quit`. This listener is the first `will-quit` one registered (it is
   * installed first in `whenReady`), so ending there left every later
   * listener's work unwatched — selfUpdate's `armSwapOnQuit` starting the swap
   * helper — and a hang in it ended by Force Quit read as a clean quit on the
   * next start. `quit` is emitted right after the last `will-quit` listener
   * returns, once nothing can cancel the quit, so a block there is said by the
   * thread before this `quit` line, and a hang there leaves no `quit` line.
   * Still unwatched: Electron's own teardown after `quit`.
   */
  src.app.on('quit', () => {
    quitting = true
    watchdog?.stop()
    timer.stop()
    const at = now()
    // The window in progress too, folded with whatever is held into one last line.
    const last = stalls.observe(suspendedAt ? null : sampler.flush(), at, lastSeen) ?? stalls.drain()
    if (last) log.write(formatLine(at, 'stall', last))
    log.write(formatLine(at, 'quit', { uptime: (at - startedAt) / 1000 }))
    log.flushSync()
  })

  return {
    log,
    stop: () => {
      watchdog?.stop()
      timer.stop()
    }
  }
}
