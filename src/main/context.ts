import { stat } from 'node:fs/promises'
import type { ContextSnapshot } from '@shared/types'
import { findSessionFile } from './projects.ts'
import {
  advanceCursor,
  contextLimitFor,
  contextUsed,
  finishFold,
  type TranscriptCursor
} from './sessionFile.ts'

/**
 * Watches the transcripts of live sessions and publishes context-window
 * readings.
 *
 * Polling beats fs.watch here: transcripts are appended to constantly, watch
 * semantics for appends differ across macOS and Windows, and we only ever track
 * the handful of sessions that have an open tab.
 *
 * Incremental, not a re-parse (gotcha 103). A tick whose transcript moved used to
 * run `parseSession` over the whole file — 40-130 ms of blocked main process per
 * tick for a 16-22 MB transcript, several times a minute per busy tab, and every
 * pty byte and keystroke waited behind it. Each `Watch` now keeps a
 * `TranscriptCursor`: the first tick streams the file once (yielding between
 * 1 MB chunks), and every later one reads only the bytes appended since.
 *
 * No `FULL_READ_LIMIT` sampling here, deliberately. Sampling existed to bound a
 * whole-file read's time and memory; a streamed pass bounds both on its own, and
 * after it the cost is the append. Sampling cost the meter an exact message
 * count (a 38 MB transcript read as 87 messages) and could miss the newest
 * usage record — both worse than one streamed first pass of a huge file.
 */

const POLL_MS = 1500
/** Retry cadence while waiting for a brand-new session's file to appear. */
const DISCOVER_MS = 2000

interface Watch {
  sessionId: string
  file: string | null
  lastMtime: number
  /**
   * The stated context window as of the last publish, so a window that becomes
   * known *after* the transcript stopped changing still reaches the meter.
   *
   * Undefined means "never published", which is deliberately distinct from
   * `null` ("published, and no window was stated") — otherwise the first tick
   * of a session with no payload yet would compare equal to itself and the
   * initial publish would be skipped.
   */
  lastWindow?: number | null
  /**
   * How far into `file` this watch has folded, or null before the first read
   * and after anything that invalidates it (a new file, a vanished one). Per
   * watch rather than per path on purpose: it is only trustworthy while the
   * watch that built it is the one checking the file is still the same.
   */
  cursor: TranscriptCursor | null
  timer: NodeJS.Timeout | null
  /** A tick is in flight. Claimed before its first await (gotcha 20). */
  busy: boolean
  /** `refresh()` arrived while `busy`: tick again as soon as this one ends. */
  again: boolean
  disposed: boolean
}

export class ContextWatcher {
  private watches = new Map<string, Watch>()
  /** Most recent snapshot per session, so a late joiner gets a meter at once. */
  private latest = new Map<string, ContextSnapshot>()
  private readonly emit: (snap: ContextSnapshot) => void
  /**
   * The stated context window for a session, if one has been stated. Despite
   * the field's name, this is no longer only the startup banner: index.ts
   * wires it to `statusLine.ts`'s `windowFor`, which reads the statusLine
   * payload first and falls back to the banner only for a CLI old enough to
   * still print one (see CLAUDE.md gotcha 2 — 2.1.221 dropped "(1M context)"
   * from its startup output). Injected rather than imported so this module
   * stays free of the PTY layer and keeps running under node's type stripping.
   *
   * It exists because the transcript cannot say: a 1M session records its model
   * as plain `claude-opus-5`, so with no statement at all the meter reads a 1M
   * session against 200k until it crosses over - showing 92% full at 182k when
   * 82% of the window was still free.
   */
  private readonly bannerWindow: (sessionId: string) => number | null

  /**
   * Where a session's transcript is. Injected because it is not always here:
   * an SSH session's `claude` runs on the far machine and writes its JSONL
   * there, so the resolver for one fetches a copy back rather than looking in
   * `~/.claude/projects`. Defaults to the local lookup.
   */
  private readonly resolve: (sessionId: string) => Promise<string | null>
  /**
   * True when the resolved path is a copy that goes stale — a remote fetch,
   * where the file exists locally but stops changing unless it is re-fetched.
   * A stale copy is the failure that looks most like everything working.
   */
  private readonly volatile: (sessionId: string) => boolean
  /**
   * Poll cadence per session, or null for the local default. A network round
   * trip cannot run at 1.5s, and the caller returning null rather than 1500
   * keeps the default owned here instead of copied into index.ts.
   */
  private readonly pollFor: (sessionId: string) => number | null

  // Written as explicit fields rather than TS parameter properties so this
  // module runs directly under `node --experimental-strip-types`, which is what
  // scripts/verify-context.mts uses to test it without a build step.
  constructor(
    emit: (snap: ContextSnapshot) => void,
    bannerWindow: (sessionId: string) => number | null = () => null,
    opts: {
      resolve?: (sessionId: string) => Promise<string | null>
      volatile?: (sessionId: string) => boolean
      pollMs?: (sessionId: string) => number | null
    } = {}
  ) {
    this.emit = emit
    this.bannerWindow = bannerWindow
    this.resolve = opts.resolve ?? findSessionFile
    this.volatile = opts.volatile ?? (() => false)
    this.pollFor = opts.pollMs ?? (() => null)
  }

  /** The cadence for a session, with the local default applied. */
  private interval(sessionId: string): number {
    return this.pollFor(sessionId) ?? POLL_MS
  }

  /** Last known reading for a session, or null if it has not reported yet. */
  snapshot(sessionId: string): ContextSnapshot | null {
    return this.latest.get(sessionId) ?? null
  }

  private publish(snap: ContextSnapshot): void {
    this.latest.set(snap.sessionId, snap)
    this.emit(snap)
  }

  watch(sessionId: string): void {
    if (!sessionId || this.watches.has(sessionId)) return
    const w: Watch = {
      sessionId,
      file: null,
      lastMtime: 0,
      lastWindow: undefined,
      cursor: null,
      timer: null,
      busy: false,
      again: false,
      disposed: false
    }
    this.watches.set(sessionId, w)
    void this.tick(w)
  }

  unwatch(sessionId: string): void {
    const w = this.watches.get(sessionId)
    if (!w) return
    w.disposed = true
    if (w.timer) clearTimeout(w.timer)
    this.watches.delete(sessionId)
  }

  disposeAll(): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id)
  }

  /**
   * Force an immediate publish, e.g. right after a tab is focused. The cursor
   * is kept: nothing already folded is read again.
   */
  refresh(sessionId: string): void {
    const w = this.watches.get(sessionId)
    if (!w) return
    w.lastMtime = 0
    /*
     * Never a second tick beside one in flight. Two passes advancing one cursor
     * would fold the same appended lines twice, and each would schedule its own
     * timer, leaving two polling chains for the life of the watch.
     */
    if (w.busy) {
      w.again = true
      return
    }
    if (w.timer) clearTimeout(w.timer)
    void this.tick(w)
  }

  private schedule(w: Watch, ms: number): void {
    if (w.disposed) return
    w.timer = setTimeout(() => void this.tick(w), ms)
  }

  private async tick(w: Watch): Promise<void> {
    if (w.disposed || w.busy) return
    w.busy = true
    let next: number
    try {
      next = await this.pass(w)
    } catch {
      next = this.interval(w.sessionId)
    } finally {
      w.busy = false
    }
    if (w.again) {
      w.again = false
      next = 0
    }
    this.schedule(w, next)
  }

  /** One poll of one session. Returns the delay before the next. */
  private async pass(w: Watch): Promise<number> {
    const volatile = this.volatile(w.sessionId)

    /*
     * A volatile source is re-resolved every tick, not just once.
     *
     * For a local session the path never changes, so resolving once is right and
     * cheap. For a remote one the "path" is a cache of somebody else's file, and
     * leaving it alone means the meter freezes at whatever the first fetch saw
     * while the session carries on — a stale reading that looks exactly like a
     * working one.
     */
    if (!w.file || volatile) {
      const found = await this.resolve(w.sessionId)
      if (w.disposed) return 0
      // A refetch that failed keeps the last copy rather than blanking a meter
      // that was working: a remote machine is allowed to be briefly unreachable.
      if (found && found !== w.file) {
        w.file = found
        w.cursor = null
      }
      if (!w.file) {
        // Claude has not written the transcript yet — report an empty meter so
        // the tab renders something instead of staying blank.
        this.publish(emptySnapshot(w.sessionId))
        return Math.max(DISCOVER_MS, this.interval(w.sessionId))
      }
    }

    try {
      const st = await stat(w.file)
      /*
       * The stated window is a second trigger, not just an argument.
       *
       * Publishing only on a transcript change assumes the window is knowable
       * by the time the transcript first is, and on a **resumed** session it is
       * not: the payload naming this session was deleted when the old process
       * was killed (`clearSessionFiles`), and the new one does not write its
       * first until it renders a status line a second or two later. The first
       * tick therefore lands with no window and falls back to the 200k default,
       * and — because the transcript is not moving, nobody having typed
       * anything yet — nothing ever recomputed it. Measured end to end: a 1M
       * session resumed at 125k read `125k/200k · 63%` indefinitely while its
       * own payload sat on disk saying `context_window_size: 1000000`.
       *
       * Both the paused-tab Resume and the relaunch-on-a-new-CLI button walk
       * this path, so it is not specific to either.
       */
      const window = this.bannerWindow(w.sessionId)
      if (st.mtimeMs !== w.lastMtime || window !== w.lastWindow) {
        w.lastMtime = st.mtimeMs
        w.lastWindow = window
        /*
         * A volatile source always starts from byte 0. An SSH session's copy is
         * the remote file's last 4 MB (`MAX_REMOTE_TRANSCRIPT_BYTES`), rewritten
         * in place on every fetch: once the remote transcript outgrows the cap
         * the window slides, same inode and much the same size, so an offset
         * into the old copy means nothing in the new one. It is at most 4 MB,
         * streamed like any first pass.
         */
        const { cursor } = await advanceCursor(volatile ? null : w.cursor, w.file, {
          cancelled: () => w.disposed
        })
        // An unwatched session publishes nothing, and a cancelled pass's fold
        // is only part of the file.
        if (w.disposed) return 0
        w.cursor = cursor
        const parsed = finishFold(cursor.fold)
        const used = contextUsed(parsed)
        this.publish({
          sessionId: w.sessionId,
          contextTokens: used,
          contextLimit: contextLimitFor(parsed.model, used, window),
          inputTokens: parsed.inputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheCreationTokens: parsed.cacheCreationTokens,
          outputTokens: parsed.outputTokens,
          model: parsed.model,
          messageCount: parsed.messageCount,
          title: parsed.title,
          updatedAt: st.mtimeMs,
          ready: true,
          permissionMode: parsed.permissionMode
        })
      }
    } catch {
      // File disappeared (session deleted, or a fork changed the id) — go back
      // to discovery rather than giving up on this session for good.
      w.file = null
      w.lastMtime = 0
      w.cursor = null
    }

    return this.interval(w.sessionId)
  }
}

function emptySnapshot(sessionId: string): ContextSnapshot {
  return {
    sessionId,
    contextTokens: 0,
    contextLimit: 200_000,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    model: null,
    messageCount: 0,
    title: null,
    updatedAt: Date.now(),
    ready: false,
    permissionMode: null
  }
}
