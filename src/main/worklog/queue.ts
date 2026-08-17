import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  WorklogExistingItem,
  WorklogKind,
  WorklogProposal,
  WorklogTarget
} from '@shared/types'

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
export interface Identity {
  sessionId: string
  title: string
  kind?: WorklogKind
  existing?: Partial<Record<WorklogTarget, WorklogExistingItem>>
  /**
   * The status this update moves the record to, if any. Part of the key — see
   * `dedupeKey`.
   */
  newStatus?: Partial<Record<WorklogTarget, string>>
}

/**
 * The state an update is moving its records to, normalised for keying.
 *
 * Case-blind and trimmed, so the same move worded "Done" and "done" across two
 * scans stays one proposal. Empty for a note-only update, which is a state of
 * its own rather than a missing value: "add a note" and "close it" are two
 * different asks about one record and both deserve to reach the user.
 */
function statusRef(p: Identity, targets: readonly WorklogTarget[]): string {
  return targets.map((t) => (p.newStatus?.[t] ?? '').trim().toLowerCase()).join(',')
}

export function dedupeKey(p: Identity): string {
  /*
   * An update is identified by the record it changes and the state it moves it
   * to — not by its wording.
   *
   * Two scans of one session should never queue two "mark this task complete"
   * entries for the same task just because the model phrased the second one
   * differently — unlike a create, where two differently-worded entries really
   * might be two different pieces of work.
   *
   * The status has to be in the key, and leaving it out is why finished work
   * stayed open. A long session is scanned repeatedly, and the prompt asks for
   * an update whenever an item was finished, started *or blocked* — so the
   * first scan queues "started work on X", which takes the record's key, and the
   * later "X is done" collapses onto it and is dropped. Silently: `add` merely
   * `continue`s, nothing is counted and nothing is logged. Accepting the first
   * does not release the key either, since `accept` only patches `status`.
   *
   * Keying on the pair is safe against gotcha 17 because the create key below is
   * untouched byte for byte, and update keys already had a shape of their own.
   */
  if (p.kind === 'update') {
    const named = TARGETS.filter((t) => !!p.existing?.[t]?.id)
    const ref = named.map((t) => `${t}:${(p.existing?.[t]?.id ?? '').toLowerCase()}`).join(',')
    if (ref) return `${p.sessionId}|update|${ref}|${statusRef(p, named)}`
    // No record named, so there is nothing to key on but the words. Falls
    // through to the create key deliberately: such a proposal is written as a
    // create anyway (see groundProposals).
  }

  const title = p.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  /*
   * The create key is byte-for-byte what it was before updates existed, and has
   * to stay that way. Ids are the sha1 of it and rejections are tombstones
   * keyed on it, so any change here silently resurrects every proposal the user
   * has ever said no to.
   */
  return `${p.sessionId}|${title}`
}

/** Stable id, so the same proposal keeps its identity across rescans. */
export function proposalId(p: Identity): string {
  return createHash('sha1').update(dedupeKey(p)).digest('hex').slice(0, 12)
}

/**
 * Every key a proposal answers to, for the purposes of "already known".
 *
 * `dedupeKey` returns exactly one string, `proposalId` is its sha1, and both
 * are frozen byte for byte — CLAUDE.md gotcha 17. This does not touch either.
 *
 * The problem it solves is that an update's key is a COMPOSITE of every board
 * record the proposal names, and that composite is not stable when the user
 * changes which boards are switched on. With ClickUp off, recall reads only
 * Notion, so `existing` carries only Notion and the very same update arrives
 * as `s1|update|notion:x` where it was `s1|update|notion:x,clickup:y`. It
 * matches nothing already queued, so it is queued again and accepting it
 * applies the same write to the same page twice.
 *
 * So an update also answers to one key per record it names, and "already
 * known" becomes "any record of mine is already spoken for". That is stable
 * both ways — switching a board off and switching it back on — and it needs no
 * migration, because nothing on disk stores a key: `dedupeKey` is recomputed
 * from `existing` every time the file is loaded.
 *
 * A create answers to its one key and nothing else. Its only identity is its
 * flattened title, and a second key there would collapse two genuinely
 * different pieces of work, which is the one error this file will not make.
 */
export function dedupeKeys(p: Identity): string[] {
  const composite = dedupeKey(p)
  if (p.kind !== 'update') return [composite]
  // A Set, because a one-record update's composite IS its per-record key and
  // the two must not be reported as two.
  const keys = new Set<string>([composite])
  for (const t of TARGETS) {
    const id = p.existing?.[t]?.id
    if (id) keys.add(`${p.sessionId}|update|${t}:${id.toLowerCase()}|${statusRef(p, [t])}`)
  }
  return [...keys]
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
      /*
       * An EMPTY string is kept, and that is the whole point of this branch.
       *
       * `applyProposal` writes `urls[target] = ''` to mean "this destination was
       * reached but returned no link", and that marker is the only thing
       * stopping Try again creating a second real record. Dropping it here
       * because it is falsy made the marker survive until the next restart and
       * no longer: the guard then saw `undefined`, and a retry duplicated a live
       * ClickUp task. Presence is the signal; the value is only the link.
       */
      if (typeof u === 'string') urls[t] = u
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
  if (v.auto === true) proposal.auto = true

  /*
   * An update is only rebuilt as one if the record it points at survived too.
   * A stored `kind: "update"` with no readable `existing` names nothing that can
   * be changed, and the write path would have to guess — so it comes back as
   * the create it will be treated as anyway.
   */
  const existing = hydrateExisting(v.existing)
  if (v.kind === 'update' && Object.keys(existing).length) {
    proposal.kind = 'update'
    proposal.existing = existing
    const newStatus = hydrateStatuses(v.newStatus, existing)
    if (Object.keys(newStatus).length) proposal.newStatus = newStatus
  } else if (v.kind === 'update' || v.kind === 'create') {
    // Written down as a create rather than left blank. Every reader already
    // treats a missing kind as one, so recording it makes the stored record say
    // what it is instead of leaving the next reader to infer it.
    proposal.kind = 'create'
  }

  return proposal
}

function hydrateExisting(v: unknown): Partial<Record<WorklogTarget, WorklogExistingItem>> {
  const out: Partial<Record<WorklogTarget, WorklogExistingItem>> = {}
  if (!isRecord(v)) return out
  for (const t of TARGETS) {
    const entry = v[t]
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    if (!id || !title) continue
    const item: WorklogExistingItem = { id, title }
    if (typeof entry.status === 'string' && entry.status.trim()) item.status = entry.status.trim()
    if (typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url)) item.url = entry.url.trim()
    out[t] = item
  }
  return out
}

/** A status only survives for a destination this proposal actually addresses. */
function hydrateStatuses(
  v: unknown,
  existing: Partial<Record<WorklogTarget, WorklogExistingItem>>
): Partial<Record<WorklogTarget, string>> {
  const out: Partial<Record<WorklogTarget, string>> = {}
  if (!isRecord(v)) return out
  for (const t of TARGETS) {
    if (!existing[t]) continue
    const s = v[t]
    if (typeof s === 'string' && s.trim()) out[t] = s.trim()
  }
  return out
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
    const seen = new Set(this.items.flatMap((p) => dedupeKeys(p)))
    /*
     * A rejection also blocks the same work arriving under the other kind.
     *
     * An update and a create have deliberately different keys — the update is
     * keyed on the record it changes, so rewording it does not queue a second
     * one. The cost of that is a hole: reject "Finished the SSH work" as an
     * update, then let recall fail on the next scan, and the model proposes the
     * same sentence as a create under a completely different key. The user said
     * no once and gets asked again, which is how a feature gets switched off.
     *
     * So every rejection contributes its title-based key as well as its own.
     * Only rejections — a pending or accepted update must not block a genuinely
     * new create that happens to share its wording.
     */
    const refused = new Set(
      this.items
        .filter((p) => p.status === 'rejected')
        .map((p) => dedupeKey({ sessionId: p.sessionId, title: p.title }))
    )
    const added: WorklogProposal[] = []

    for (const draft of drafts) {
      const title = draft.title.trim()
      if (!title || !draft.sessionId) continue
      const identity: Identity = {
        sessionId: draft.sessionId,
        title,
        kind: draft.kind,
        existing: draft.existing,
        newStatus: draft.newStatus
      }
      const keys = dedupeKeys(identity)
      // Both ways round, and against `refused` rather than `seen`: a *rejected*
      // create blocks the same words arriving as an update and vice versa, but a
      // merely pending one must not — losing a better-informed update to an
      // earlier create would be a silent downgrade.
      //
      // `keys.some` rather than a single lookup so an update still matches when
      // the configured boards have changed under it; see dedupeKeys.
      if (
        keys.some((k) => seen.has(k)) ||
        refused.has(dedupeKey({ sessionId: draft.sessionId, title }))
      )
        continue
      for (const k of keys) seen.add(k)

      const proposal: WorklogProposal = {
        id: proposalId(identity),
        sessionId: draft.sessionId,
        cwd: draft.cwd,
        group: draft.group,
        title,
        body: draft.body,
        targets: draft.targets.length ? [...draft.targets] : [...TARGETS],
        status: 'pending',
        createdAt: now
      }
      if (draft.kind) proposal.kind = draft.kind
      if (draft.existing && Object.keys(draft.existing).length) proposal.existing = { ...draft.existing }
      if (draft.newStatus && Object.keys(draft.newStatus).length) {
        proposal.newStatus = { ...draft.newStatus }
      }
      if (draft.auto) proposal.auto = true
      added.push(proposal)
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
