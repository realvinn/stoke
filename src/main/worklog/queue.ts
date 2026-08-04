import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorklogProposal, WorklogTarget } from '@shared/types'

/**
 * The review queue: everything the worklog agent has proposed, and what became
 * of it.
 *
 * The queue is the safety property of the whole feature. Nothing reaches Notion
 * or ClickUp until a proposal in here is accepted, so this file is what stands
 * between an unattended Sonnet run and the user's real task boards.
 *
 * Two rules drive the design and both are about *not* annoying the user into
 * turning the feature off:
 *
 *  - Re-scanning a session must not pile up duplicates. Sessions are scanned
 *    when they end and can be scanned again by hand, and a queue that grows a
 *    fresh copy each time is worthless.
 *  - A rejected proposal must never come back. "No, don't log that" has to be
 *    permanent, which means rejections are kept as tombstones rather than
 *    deleted.
 *
 * Nothing here imports electron, so `scripts/verify-worklog-runner.mts` can
 * exercise it under `node --experimental-strip-types`. The userData directory is
 * passed in by the caller instead — see getWorklogQueue.
 */

export const WORKLOG_QUEUE_FILENAME = 'worklog-queue.json'

/**
 * Beyond this the oldest entries fall off. The queue is a review surface, not an
 * archive; the destinations themselves are the record of what was written.
 */
export const MAX_ENTRIES = 200

/** What a scan produces. The queue owns id, status, createdAt, urls and error. */
export type ProposalDraft = Omit<WorklogProposal, 'id' | 'status' | 'createdAt' | 'urls' | 'error'>

const STATUSES: WorklogProposal['status'][] = ['pending', 'accepted', 'rejected', 'failed']
const TARGETS: WorklogTarget[] = ['notion', 'clickup']

export function worklogQueueFile(userDataDir: string): string {
  return join(userDataDir, WORKLOG_QUEUE_FILENAME)
}

/**
 * The identity of a proposal, for deduplication.
 *
 * Session plus a flattened title. The title is normalised because a second scan
 * of the same session will not reproduce the first one's wording exactly —
 * "Fix the context meter" and "Fix context meter." are the same proposal — while
 * the session id keeps two genuinely different pieces of work apart even when a
 * model reaches for the same phrasing twice.
 *
 * The trade is deliberate and known: a rescan that renames a proposal outright
 * produces a second entry, which is visible and dismissable. The opposite error
 * — collapsing two distinct proposals — silently loses work.
 */
export function dedupeKey(p: { sessionId: string; title: string }): string {
  const title = p.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return `${p.sessionId}|${title}`
}

/** Stable id, so the same proposal keeps its identity across rescans. */
export function proposalId(p: { sessionId: string; title: string }): string {
  return createHash('sha1').update(dedupeKey(p)).digest('hex').slice(0, 12)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Repair a stored record, or drop it.
 *
 * Structural only. A proposal missing its body is still reviewable; one missing
 * an id or a title is not a proposal at all.
 */
function hydrate(v: unknown): WorklogProposal | null {
  if (!isRecord(v)) return null
  const id = typeof v.id === 'string' ? v.id : ''
  const sessionId = typeof v.sessionId === 'string' ? v.sessionId : ''
  const title = typeof v.title === 'string' ? v.title.trim() : ''
  if (!id || !sessionId || !title) return null

  const targets = Array.isArray(v.targets)
    ? (v.targets.filter((t): t is WorklogTarget => TARGETS.includes(t as WorklogTarget)) as WorklogTarget[])
    : []

  const urls: Partial<Record<WorklogTarget, string>> = {}
  if (isRecord(v.urls)) {
    for (const t of TARGETS) {
      const u = v.urls[t]
      if (typeof u === 'string' && u) urls[t] = u
    }
  }

  const status = STATUSES.includes(v.status as WorklogProposal['status'])
    ? (v.status as WorklogProposal['status'])
    : 'pending'

  const proposal: WorklogProposal = {
    id,
    sessionId,
    cwd: typeof v.cwd === 'string' ? v.cwd : '',
    group: typeof v.group === 'string' ? v.group : '',
    title,
    body: typeof v.body === 'string' ? v.body : '',
    targets: targets.length ? targets : [...TARGETS],
    status,
    createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : 0
  }
  if (Object.keys(urls).length) proposal.urls = urls
  if (typeof v.error === 'string' && v.error) proposal.error = v.error
  return proposal
}

/** Fields the app is allowed to change after a proposal exists. */
export type ProposalPatch = Partial<
  Pick<WorklogProposal, 'status' | 'urls' | 'error' | 'title' | 'body' | 'targets'>
>

export class WorklogQueue {
  private readonly file: string
  /** Oldest first: insertion order is the only ordering the cap can trust. */
  private items: WorklogProposal[]
  private readonly listeners = new Set<(items: WorklogProposal[]) => void>()

  // Explicit assignment rather than TS parameter properties, matching the other
  // main-process classes so this stays runnable under node's type stripping.
  constructor(file: string) {
    this.file = file
    this.items = this.load()
  }

  /** Never throws. A queue file that cannot be read is an empty queue. */
  private load(): WorklogProposal[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : []
      return list.map(hydrate).filter((p): p is WorklogProposal => p !== null)
    } catch {
      // Missing (the normal first run) or corrupt. Either way there is nothing
      // to review, and refusing to start would take the app down over a cache.
      return []
    }
  }

  /** Temp file + rename, so a crash mid-write cannot truncate the queue. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[stoke] failed to persist the worklog queue', err)
    }
  }

  private changed(): void {
    this.persist()
    const snapshot = this.list()
    for (const fn of this.listeners) fn(snapshot)
  }

  /**
   * Enforce the cap, oldest first within a status, and by status in this order:
   *
   *  - `accepted` goes first. It is already written and visible in Notion and
   *    ClickUp, which are a better record of it than this file.
   *  - `pending` next. It is the bulk, and rescanning the session brings it back.
   *  - `failed` next, because it carries an error the user has not seen yet.
   *  - `rejected` last, and this is the point of the whole ordering. A rejection
   *    is the *only* record that the user said no; evict it and the next scan
   *    proposes the same thing again, which is how a feature gets switched off.
   */
  private trim(): void {
    const order: WorklogProposal['status'][] = ['accepted', 'pending', 'failed', 'rejected']
    while (this.items.length > MAX_ENTRIES) {
      let victim = -1
      for (const status of order) {
        victim = this.items.findIndex((p) => p.status === status)
        if (victim >= 0) break
      }
      this.items.splice(victim >= 0 ? victim : 0, 1)
    }
  }

  /** Newest first, which is the order the review panel wants. */
  list(): WorklogProposal[] {
    return this.items.map((p) => ({ ...p })).reverse()
  }

  get(id: string): WorklogProposal | null {
    const found = this.items.find((p) => p.id === id)
    return found ? { ...found } : null
  }

  /**
   * Add what a scan produced, skipping anything already known.
   *
   * "Already known" is deliberately blind to status: a rejected proposal is
   * still known, which is exactly what stops it coming back.
   *
   * Returns only what was actually added, so a caller can tell a scan that found
   * nothing new from one that found nothing at all.
   */
  add(drafts: ProposalDraft[], now = Date.now()): WorklogProposal[] {
    const seen = new Set(this.items.map((p) => dedupeKey(p)))
    const added: WorklogProposal[] = []

    for (const draft of drafts) {
      const title = draft.title.trim()
      if (!title || !draft.sessionId) continue
      const key = dedupeKey({ sessionId: draft.sessionId, title })
      if (seen.has(key)) continue
      seen.add(key)

      added.push({
        id: proposalId({ sessionId: draft.sessionId, title }),
        sessionId: draft.sessionId,
        cwd: draft.cwd,
        group: draft.group,
        title,
        body: draft.body,
        targets: draft.targets.length ? [...draft.targets] : [...TARGETS],
        status: 'pending',
        createdAt: now
      })
    }

    if (!added.length) return []
    this.items.push(...added)
    this.trim()
    this.changed()
    return added.map((p) => ({ ...p }))
  }

  update(id: string, patch: ProposalPatch): WorklogProposal | null {
    const found = this.items.find((p) => p.id === id)
    if (!found) return null

    if (patch.status) found.status = patch.status
    if (typeof patch.title === 'string' && patch.title.trim()) found.title = patch.title.trim()
    if (typeof patch.body === 'string') found.body = patch.body
    if (patch.targets) found.targets = [...patch.targets]
    // URLs merge rather than replace: ClickUp is written first and its URL is
    // stored before Notion is attempted, so the second write must not wipe it.
    if (patch.urls) found.urls = { ...(found.urls ?? {}), ...patch.urls }
    if (patch.error === undefined) {
      /* leave it */
    } else if (patch.error) {
      found.error = patch.error
    } else {
      delete found.error
    }

    this.changed()
    return { ...found }
  }

  /**
   * Mark a proposal accepted. This records the decision only — the writes are
   * runner.applyProposal's job, and their URLs come back through update().
   */
  accept(id: string): WorklogProposal | null {
    return this.update(id, { status: 'accepted', error: '' })
  }

  reject(id: string): WorklogProposal | null {
    return this.update(id, { status: 'rejected' })
  }

  onChanged(fn: (items: WorklogProposal[]) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

let shared: WorklogQueue | null = null

/**
 * The process-wide queue.
 *
 * `userDataDir` is passed in rather than read from electron's `app` here,
 * because importing electron would stop this module loading under plain node and
 * take the tests with it. Call it once at startup with
 * `app.getPath('userData')`; later calls ignore the argument.
 */
export function getWorklogQueue(userDataDir: string): WorklogQueue {
  if (!shared) shared = new WorklogQueue(worklogQueueFile(userDataDir))
  return shared
}
