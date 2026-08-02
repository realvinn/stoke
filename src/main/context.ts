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

  // Written as an explicit field rather than a TS parameter property so this
  // module runs directly under `node --experimental-strip-types`, which is what
  // scripts/verify-context.mts uses to test it without a build step.
  constructor(emit: (snap: ContextSnapshot) => void) {
    this.emit = emit
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

    if (!w.file) {
      w.file = await findSessionFile(w.sessionId)
      if (!w.file) {
        // Claude has not written the transcript yet — report an empty meter so
        // the tab renders something instead of staying blank.
        this.publish(emptySnapshot(w.sessionId))
        this.schedule(w, DISCOVER_MS)
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
          contextLimit: contextLimitFor(parsed.model, used),
          inputTokens: parsed.inputTokens,
          cacheReadTokens: parsed.cacheReadTokens,
          cacheCreationTokens: parsed.cacheCreationTokens,
          outputTokens: parsed.outputTokens,
          model: parsed.model,
          messageCount: parsed.messageCount,
          title: parsed.title,
          updatedAt: st.mtimeMs,
          ready: true
        })
      }
    } catch {
      // File disappeared (session deleted, or a fork changed the id) — go back
      // to discovery rather than giving up on this session for good.
      w.file = null
      w.lastMtime = 0
    }

    this.schedule(w, POLL_MS)
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
    ready: false
  }
}
