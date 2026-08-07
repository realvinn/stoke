import { stat } from 'node:fs/promises'
import type { ContextSnapshot } from '@shared/types'
import { findSessionFile } from './projects.ts'
import { contextLimitFor, contextUsed, parseSession } from './sessionFile.ts'

/**
 * Watches the transcripts of live sessions and publishes context-window
 * readings.
 *
 * Polling beats fs.watch here: transcripts are appended to constantly, watch
 * semantics for appends differ across macOS and Windows, and we only ever track
 * the handful of sessions that have an open tab.
 */

const POLL_MS = 1500
/** Retry cadence while waiting for a brand-new session's file to appear. */
const DISCOVER_MS = 2000

interface Watch {
  sessionId: string
  file: string | null
  lastMtime: number
  timer: NodeJS.Timeout | null
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
    const w: Watch = { sessionId, file: null, lastMtime: 0, timer: null, disposed: false }
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

  /** Force an immediate re-read, e.g. right after a tab is focused. */
  refresh(sessionId: string): void {
    const w = this.watches.get(sessionId)
    if (!w) return
    w.lastMtime = 0
    if (w.timer) clearTimeout(w.timer)
    void this.tick(w)
  }

  private schedule(w: Watch, ms: number): void {
    if (w.disposed) return
    w.timer = setTimeout(() => void this.tick(w), ms)
  }

  private async tick(w: Watch): Promise<void> {
    if (w.disposed) return

    /*
     * A volatile source is re-resolved every tick, not just once.
     *
     * For a local session the path never changes, so resolving once is right and
     * cheap. For a remote one the "path" is a cache of somebody else's file, and
     * leaving it alone means the meter freezes at whatever the first fetch saw
     * while the session carries on — a stale reading that looks exactly like a
     * working one.
     */
    if (!w.file || this.volatile(w.sessionId)) {
      const found = await this.resolve(w.sessionId)
      // A refetch that failed keeps the last copy rather than blanking a meter
      // that was working: a remote machine is allowed to be briefly unreachable.
      if (found) w.file = found
      if (!w.file) {
        // Claude has not written the transcript yet — report an empty meter so
        // the tab renders something instead of staying blank.
        this.publish(emptySnapshot(w.sessionId))
        this.schedule(w, Math.max(DISCOVER_MS, this.interval(w.sessionId)))
        return
      }
    }

    try {
      const st = await stat(w.file)
      if (st.mtimeMs !== w.lastMtime) {
        w.lastMtime = st.mtimeMs
        const parsed = await parseSession(w.file)
        const used = contextUsed(parsed)
        this.publish({
          sessionId: w.sessionId,
          contextTokens: used,
          contextLimit: contextLimitFor(parsed.model, used, this.bannerWindow(w.sessionId)),
          inputTokens: parsed.inputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheCreationTokens: parsed.cacheCreationTokens,
          outputTokens: parsed.outputTokens,
          model: parsed.model,
          messageCount: parsed.messageCount,
          title: parsed.title,
          updatedAt: st.mtimeMs,
          ready: true,
          permissionMode: null
        })
      }
    } catch {
      // File disappeared (session deleted, or a fork changed the id) — go back
      // to discovery rather than giving up on this session for good.
      w.file = null
      w.lastMtime = 0
    }

    this.schedule(w, this.interval(w.sessionId))
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
