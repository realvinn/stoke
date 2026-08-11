import { isBudgetExhausted, runHeadless, type HeadlessOptions, type HeadlessResult } from '../agent.ts'
import { asRecord, clip, oneLine, parsedCandidates } from './json.ts'
import { WORKLOG_TARGETS } from '../../shared/worklog.ts'
import type { WorklogExistingItem, WorklogScanOutcome, WorklogTarget } from '@shared/types'

/**
 * Recall: what is *already* on the boards.
 *
 * Without this the scan can only ever propose new records, so finishing a task
 * the user filed last week files a second, near-identical task beside the first
 * and leaves the original sitting open. That is the failure mode that makes a
 * task board worse than no task board, and no amount of prompt wording fixes it
 * — the model has to be told what exists.
 *
 * Three constraints shape the design, and each one is why this is a *separate*
 * run from the scan rather than part of it:
 *
 *  - **The scan is hermetic and must stay that way.** It runs `--safe-mode` with
 *    an empty `--mcp-config`, and safe mode switches MCP servers off entirely.
 *    Reading a board needs those servers, so the two cannot be one call.
 *  - **Recall is shared.** Both destinations are a single fixed list and a
 *    single fixed data source, so one read serves every session on the machine.
 *    It is cached with a TTL and the marginal cost per scan tends to zero.
 *  - **It is read-only by allowlist.** Three tools, all of them queries. The
 *    write tools of the very same servers are one name away, which is exactly
 *    why the list is exact rather than a prefix.
 *
 * Nothing here imports electron, so scripts/verify-worklog-recall.mts exercises
 * it under `node --experimental-strip-types`.
 */

/* ------------------------------------------------------------------- tools */

/**
 * The exact queries recall may run, per destination.
 *
 * Two for Notion because the data source id is a `collection://` URI:
 * `query-data-sources` is the direct route and `search` is the fallback when
 * that id will not resolve, and a recall that silently returns nothing is
 * indistinguishable from a board with nothing on it — which would quietly turn
 * every update back into a duplicate.
 *
 * Two for ClickUp because a list's own status vocabulary is NOT derivable from
 * the tasks it holds: recall reads open tasks, so "complete" appears on none of
 * them, and without asking the list directly the agent could read a board but
 * never close anything on it (CLAUDE.md gotcha 16).
 */
const TOOLS_FOR: Record<WorklogTarget, string[]> = {
  notion: [
    'mcp__claude_ai_Notion__notion-query-data-sources',
    'mcp__claude_ai_Notion__notion-search'
  ],
  clickup: [
    'mcp__claude_ai_ClickUp__clickup_filter_tasks',
    'mcp__claude_ai_ClickUp__clickup_get_list'
  ]
}

/**
 * The read tools for a set of destinations, in canonical order.
 *
 * A board that is switched off must not even be reachable. An allowlist is the
 * only thing standing between this run and the write tools of the very same
 * servers, so narrowing it is worth more than narrowing the prompt.
 */
export function recallToolsFor(targets: readonly WorklogTarget[]): string[] {
  return WORKLOG_TARGETS.filter((t) => targets.includes(t)).flatMap((t) => TOOLS_FOR[t])
}

/** Every read tool. The allowlist when nothing narrows it. */
export const RECALL_TOOLS = recallToolsFor(WORKLOG_TARGETS)

/** Records kept per destination. Beyond this the prompt stops being small. */
export const MAX_RECALL_ITEMS = 30

/** Whole-recall ceiling once rendered into the scan prompt. */
export const MAX_RECALL_CHARS = 2400

/** How long a reading stays good. Boards do not move fast; scans do. */
export const RECALL_TTL_MS = 10 * 60_000

/* -------------------------------------------------------------- the shape */

export interface RecallSnapshot {
  items: Partial<Record<WorklogTarget, WorklogExistingItem[]>>
  /**
   * Every state each board offers, as that board words them.
   *
   * Read separately from the tasks because it cannot be inferred from them:
   * recall lists *open* records, so the statuses in use are exactly the ones a
   * finished piece of work does not need. Without this the agent could see a
   * board and never be able to close anything on it.
   */
  statuses?: Partial<Record<WorklogTarget, string[]>>
  /** When it was read. 0 for the empty snapshot. */
  readAt: number
  /**
   * Set when the read failed or returned nothing usable. The scan still runs —
   * proposing new records without recall is degraded, not broken — but the
   * prompt says so, so the model is not told an empty board is a fact.
   */
  error?: string
  /**
   * The read stopped at its budget ceiling. A separate flag from `error`
   * because it is the one failure with a fix the user can act on, and because
   * it is what the scan report turns into the outcome `budget`.
   */
  budget?: true
}

export const EMPTY_RECALL: RecallSnapshot = { items: {}, readAt: 0 }

/* ------------------------------------------------------------- the prompt */

/** What each destination is asked for. One entry per configured board. */
const RECALL_ASK: Record<WorklogTarget, (opts: RecallOptions) => string[]> = {
  notion: (o) => [
    `Notion: the pages in data source ${o.notionDataSource}, using`,
    'notion-query-data-sources. If that id will not resolve, fall back to',
    'notion-search over the same workspace. Report every value its status',
    'property allows, not only the ones in use.'
  ],
  clickup: (o) => [
    `ClickUp: the tasks in list ${o.clickupListId}, using clickup_filter_tasks.`,
    'Include every task that is not closed or archived. Then call clickup_get_list',
    'on the same list and report every status it offers, including the closed ones.'
  ]
}

/** The reply shape for one destination. Only configured boards are shown one. */
const RECALL_EXAMPLE: Record<WorklogTarget, string> = {
  notion:
    '"notion":[{"id":"...","title":"...","status":"...","url":"https://www.notion.so/..."}],' +
    '"notionStatuses":["Not started","In progress","Done"]',
  clickup:
    '"clickup":[{"id":"abc123","title":"Fix the context meter","status":"in progress",' +
    '"url":"https://app.clickup.com/t/abc123"}],"clickupStatuses":["open","in progress","complete"]'
}

/**
 * Read the configured boards, and only those.
 *
 * `targets` narrows both the prompt and the allowlist. Naming a board the run
 * cannot reach is not harmless: the model spends turns trying, which is the
 * budget this feature has never had enough of.
 */
export function buildRecallPrompt(opts: RecallOptions): string {
  const targets = configuredTargets(opts)
  const asks = targets.flatMap((t, i) => {
    const lines = RECALL_ASK[t](opts)
    return [`${i + 1}. ${lines[0]}`, ...lines.slice(1).map((l) => `   ${l}`)]
  })

  return [
    'List what is currently on your task boards. Read only — create nothing, change nothing.',
    '',
    ...asks,
    '',
    `At most ${MAX_RECALL_ITEMS} of the most recent records from each. For every record give`,
    'its own id, its title, its status exactly as that board words it, and its URL.',
    '',
    'Reply with JSON and nothing else — no prose, no code fence:',
    `{${targets.map((t) => RECALL_EXAMPLE[t]).join(',')}}`,
    '',
    'A board you cannot reach gets an empty array, not an invented one.'
  ].join('\n')
}

/** The destinations this read covers. Absent means both, which is what shipped. */
function configuredTargets(opts: RecallOptions): WorklogTarget[] {
  const wanted = opts.targets ?? WORKLOG_TARGETS
  return WORKLOG_TARGETS.filter((t) => wanted.includes(t))
}

/* -------------------------------------------------------------- the parse */

function item(v: unknown): WorklogExistingItem | null {
  const record = asRecord(v)
  if (!record) return null
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  // No id means nothing can be addressed to it, so it is not a record we can
  // ever propose an update against — and listing it would only tempt the scan
  // into referencing something the write path cannot find.
  if (!id || !title) return null

  const out: WorklogExistingItem = { id: clip(id, 120), title: clip(oneLine(title), 200) }
  const status = typeof record.status === 'string' ? oneLine(record.status).trim() : ''
  if (status) out.status = clip(status, 60)
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  if (/^https?:\/\//i.test(url)) out.url = clip(url, 500)
  return out
}

function list(v: unknown): WorklogExistingItem[] {
  if (!Array.isArray(v)) return []
  const out: WorklogExistingItem[] = []
  const seen = new Set<string>()
  for (const entry of v) {
    const parsed = item(entry)
    // The same task arriving twice — a board that paginates oddly, a model that
    // repeats itself — would otherwise be shown to the scan as two records and
    // invite two updates to one task.
    if (!parsed || seen.has(parsed.id)) continue
    seen.add(parsed.id)
    out.push(parsed)
    if (out.length >= MAX_RECALL_ITEMS) break
  }
  return out
}

/** A board's status vocabulary: strings, deduplicated case-blind, bounded. */
function statusList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of v) {
    if (typeof entry !== 'string') continue
    const s = clip(oneLine(entry).trim(), 60)
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
    if (out.length >= 24) break
  }
  return out
}

/**
 * Read a recall reply. Never throws.
 *
 * Deliberately unlike `parseProposals`, which throws on an unreadable reply.
 * There, "nothing to log" and "the parse failed" must stay tellable apart or the
 * feature dies silently. Here the worst case of a bad parse is a scan that
 * proposes creates where it could have proposed updates, which is the behaviour
 * the feature already shipped with — so a failed recall degrades rather than
 * takes the scan down with it.
 */
export function parseRecall(reply: string, now: number): RecallSnapshot {
  const text = (reply ?? '').trim()
  if (!text) return { items: {}, readAt: now, error: 'the recall run returned an empty reply' }

  for (const value of parsedCandidates(text)) {
    const record = asRecord(value)
    if (!record) continue
    const clickup = list(record.clickup)
    const notion = list(record.notion)
    // An object that mentions neither key is some other JSON in the reply, not
    // the answer; keep looking rather than reporting an empty board.
    if (!('clickup' in record) && !('notion' in record)) continue
    const items: RecallSnapshot['items'] = {}
    if (clickup.length) items.clickup = clickup
    if (notion.length) items.notion = notion

    const statuses: NonNullable<RecallSnapshot['statuses']> = {}
    const clickupStatuses = statusList(record.clickupStatuses)
    const notionStatuses = statusList(record.notionStatuses)
    if (clickupStatuses.length) statuses.clickup = clickupStatuses
    if (notionStatuses.length) statuses.notion = notionStatuses

    const snapshot: RecallSnapshot = { items, readAt: now }
    if (Object.keys(statuses).length) snapshot.statuses = statuses
    return snapshot
  }

  return {
    items: {},
    readAt: now,
    error: `the recall reply held no readable JSON: ${clip(oneLine(text), 200)}`
  }
}

/* ---------------------------------------------------------------- the run */

export interface RecallOptions {
  clickupListId: string
  notionDataSource: string
  /**
   * Which boards to read. Absent reads both, which is what shipped; the live
   * caller passes `Settings.worklogBoards.targets`.
   */
  targets?: readonly WorklogTarget[]
  /**
   * Project directory to run in, matching `applyRunOptions`.
   *
   * MCP servers can be configured per project, so a read from a neutral scratch
   * folder can fail to see connectors the *write* would have found — and a
   * failed recall degrades silently into proposing creates for work that is
   * already tracked. The two runs have to look at the same servers or the
   * asymmetry only shows up as duplicates on somebody's board.
   */
  cwd?: string
  claudePath?: string | null
  timeoutMs?: number
  maxBudgetUsd?: number
  /** Override the runner, so the read path can be tested without a live board. */
  run?: typeof runHeadless
}

/**
 * The ceiling one recall may spend.
 *
 * Measured, not provisional: a Notion-only recall against the real board on
 * 2026-08-07 cost `costUsd 0.5144943` for 30 records returned (statuses
 * "To Do", "Approved", "Done", "Ideas"). The previous $0.15 was well below
 * that single figure, so every recall aborted before its first turn (spec
 * §2.4.1) and the feature could never work regardless of configuration.
 *
 * $2.00 is roughly 4x that measured Notion-only read, and roughly 2x an
 * estimated both-boards read — headroom over a *Notion-only* read of ~30
 * records specifically. Turning ClickUp on as well, or letting either board
 * grow well past that count, is what would eat into this margin and is the
 * reason to re-measure rather than assume it still holds.
 */
export const RECALL_MAX_BUDGET_USD = 2.0

/**
 * The exact run recall performs.
 *
 * No `strictMcp` and no `safeMode` on the ordinary path: it needs the user's
 * own claude.ai connectors, which is the whole reason the allowlist is exact
 * names rather than a prefix. `effort: 'low'` because this is a listing, not a
 * judgement — the thinking tokens that dominated the first measured scan buy
 * nothing here.
 *
 * Zero configured targets is the one exception, and it is handled *here*
 * rather than trusted to a caller's early return. `agent.ts`'s
 * `--allowedTools` flag is only pushed when the array is non-empty
 * (`opts.allowedTools?.length`) — an empty array omits the flag entirely, and
 * a run with no `--allowedTools` inherits the CLI's default permissions,
 * which include every Notion and ClickUp *write* tool. So an allowlist of
 * `[]` is not "no tools", it is "no restriction" — the opposite of what an
 * empty target list is supposed to mean. `safeMode` closes that gap
 * unconditionally: it switches every MCP server off, so no tool of either
 * server — read or write — is reachable regardless of what `allowedTools`
 * says. Scoped to only this path, per the binding constraint that the
 * ordinary recall run must stay non-hermetic.
 */
export function recallRunOptions(opts: RecallOptions): HeadlessOptions {
  const targets = configuredTargets(opts)
  return {
    prompt: buildRecallPrompt(opts),
    cwd: opts.cwd,
    allowedTools: recallToolsFor(targets),
    // See the comment above: this is what actually makes a zero-target run
    // incapable of reaching a write tool, independent of the allowlist array
    // being empty.
    safeMode: targets.length === 0,
    effort: 'low',
    timeoutMs: opts.timeoutMs,
    maxBudgetUsd: opts.maxBudgetUsd ?? RECALL_MAX_BUDGET_USD,
    claudePath: opts.claudePath ?? null
  }
}

/** Read both boards once. Never throws — a failure comes back as `error`. */
export async function readExisting(opts: RecallOptions, now = Date.now()): Promise<RecallSnapshot> {
  /*
   * No destination is not a failure.
   *
   * Reporting an error here would tell the scan prompt the boards "could not be
   * read", and the model's documented response to that is to propose creates
   * for everything — which is the duplication recall exists to prevent. An
   * empty, successful reading says the true thing: there is nothing tracked
   * anywhere the worklog writes.
   */
  if (configuredTargets(opts).length === 0) return { items: {}, readAt: now }

  let result: HeadlessResult
  try {
    result = await (opts.run ?? runHeadless)(recallRunOptions(opts))
  } catch (err) {
    return { items: {}, readAt: now, error: err instanceof Error ? err.message : String(err) }
  }
  if (result.isError) {
    if (isBudgetExhausted(result)) {
      const limit = opts.maxBudgetUsd ?? RECALL_MAX_BUDGET_USD
      return {
        items: {},
        readAt: now,
        budget: true,
        // Plain English on purpose, not "the recall run stopped…": "recall"
        // is vocabulary from inside this file, not a sentence a person
        // outside it wrote. Named actor ("The worklog scan"), and the same
        // wording ("budget ceiling") as WorklogBudgetError's message
        // (runner.ts) — both land in the same banner and should not read
        // like two different features. Deliberately states the fact alone,
        // with no consequence clause: this string reaches the user from two
        // different reports — a 'budget' outcome when the scan drafted
        // nothing, and a 'proposed' one when it drafted proposals anyway
        // — and "so nothing was
        // logged" is only true in the first of those. It is also what
        // `console.warn` below prints on every failed read, including the
        // 'proposed' case, so it cannot assume either consequence.
        error: `The worklog scan could not check what is already on your boards before hitting its $${limit.toFixed(2)} budget ceiling.`
      }
    }
    return {
      items: {},
      readAt: now,
      error: clip(oneLine(result.text), 200) || result.subtype || 'the recall run reported an error'
    }
  }
  return parseRecall(result.text, now)
}

/* -------------------------------------------------------------- the cache */

/**
 * The cache key for a target set: `configuredTargets` already filters and
 * orders by the canonical `WORKLOG_TARGETS` list, so two callers who name the
 * same boards in a different order — or one who omits `targets` entirely —
 * land on the same key.
 *
 * Keyed on the target set, not merely on time. `targets` narrows both the
 * prompt and the allowlist (see `recallRunOptions`), so a snapshot read for
 * one target set is not a valid answer for another: a Notion-only reading has
 * no ClickUp items in it at all, and serving it to a caller asking about both
 * boards makes every ClickUp record look like it does not exist — which turns
 * a real update into a duplicate create. The mirror direction is just as
 * wrong: a two-board reading served to a Notion-only caller offers ClickUp
 * ids nothing downstream is allowed to write to.
 *
 * The alternative — leave the cache keyed on time alone and invalidate it
 * wherever `worklogBoards.targets` changes — was rejected on purpose. That
 * makes correctness depend on every future caller of the settings remembering
 * to call `invalidateRecall`, in a module the cache itself does not import.
 * Keying on the input makes a stale cross-target read impossible by
 * construction instead of by discipline.
 */
function cacheKey(opts: RecallOptions): string {
  return configuredTargets(opts).join(',')
}

const cached = new Map<string, RecallSnapshot>()
const inFlight = new Map<string, Promise<RecallSnapshot>>()
/**
 * Bumped by every invalidation, so a read that was already running when the
 * boards changed cannot install its now-stale answer. See `invalidateRecall`.
 * Shared across every key: a write can affect any board, so every cached
 * target set has to be treated as stale, not only the one the write touched.
 */
let generation = 0

/**
 * Recall, reused.
 *
 * The single-flight promise matters more than the TTL: auto-scan can fire for
 * two sessions in the same second, and without it that is two live reads of the
 * same two boards, billed twice, for one answer. Single-flighted per target
 * set, same as the cache: two scans reading different boards must not be
 * collapsed into serving one of them the other's answer.
 *
 * A failed read is cached too, and on purpose. Retrying a broken connector once
 * per scan turns one misconfiguration into a steady drip of failing runs; the
 * TTL bounds how wrong that can stay.
 */
export async function recall(opts: RecallOptions, now = Date.now()): Promise<RecallSnapshot> {
  const key = cacheKey(opts)
  const hit = cached.get(key)
  if (hit && now - hit.readAt < RECALL_TTL_MS) return hit
  const running = inFlight.get(key)
  if (running) return running
  const started = generation
  const promise = readExisting(opts, now)
    .then((snap) => {
      /*
       * Only install the answer if the boards did not change under it.
       *
       * A read takes tens of seconds, and an accept during that window writes a
       * record this snapshot cannot contain. Assigning unconditionally let a
       * pre-write reading overwrite the invalidation and stay cached for the
       * full TTL — so the record just created was invisible to every scan for
       * ten minutes, and the same work came back as a create. That is exactly
       * the duplication recall exists to prevent.
       */
      if (generation === started) cached.set(key, snap)
      return snap
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, promise)
  return promise
}

/**
 * Drop every cached reading, for every target set.
 *
 * Called after a write, because the record just created is the one thing the
 * next scan most needs to know about: without this it stays invisible for up to
 * the TTL, and the next scan of the same session proposes it all over again.
 * Cleared wholesale rather than by key: a write to one board can change what a
 * *different* target set's next read ought to see too (an update moves a task
 * off the "open" list `clickup`-only recall reads), so nothing short of every
 * key is safe to keep.
 */
export function invalidateRecall(): void {
  cached.clear()
  // A read already in flight was started before the write and cannot know about
  // it, so it must not be allowed to install itself once it lands.
  generation++
}

/* -------------------------------------------------------------- rendering */

const LABEL: Record<WorklogTarget, string> = { clickup: 'ClickUp', notion: 'Notion' }

/**
 * The recall as the scan prompt sees it.
 *
 * Ids are included because an update proposal has to name one, and titles
 * because that is what the model matches its own findings against. Bounded
 * twice — per destination and overall — since this rides on every scan.
 */
export function formatRecall(snapshot: RecallSnapshot): string {
  const blocks: string[] = []
  for (const target of WORKLOG_TARGETS) {
    const items = snapshot.items[target]
    if (!items?.length) continue
    const lines = items.map(
      (i) => `- [${target}:${i.id}] ${i.title}${i.status ? ` (status: ${i.status})` : ''}`
    )
    // The vocabulary goes with the board it belongs to. Listing it apart from
    // the records invites a status from one board being offered to the other.
    const vocabulary = snapshot.statuses?.[target]
    const header = vocabulary?.length
      ? `${LABEL[target]} (statuses: ${vocabulary.join(', ')}):`
      : `${LABEL[target]}:`
    blocks.push(`${header}\n${lines.join('\n')}`)
  }
  if (!blocks.length) return ''
  return clip(blocks.join('\n'), MAX_RECALL_CHARS)
}

/**
 * The statuses this destination is known to use.
 *
 * The allowlist for `newStatus`. A model asked to move a task will happily
 * invent "Done" for a board whose states are "open" and "complete"; ClickUp
 * rejects that at the API with an error the user can do nothing about, and the
 * proposal reads as failed for no visible reason. Only a status recall actually
 * saw is ever written back.
 */
export function statusesFor(snapshot: RecallSnapshot, target: WorklogTarget): Set<string> {
  const out = new Set<string>()
  // The declared vocabulary first — it is the one that contains the closed
  // states, which is the whole reason a session ever wants to move a task.
  for (const s of snapshot.statuses?.[target] ?? []) out.add(s.toLowerCase())
  // Then the ones actually in use, so a board whose vocabulary could not be read
  // still permits a move between states that demonstrably exist.
  for (const i of snapshot.items[target] ?? []) {
    if (i.status) out.add(i.status.toLowerCase())
  }
  return out
}

/** The record with this id, if recall saw it. */
export function findExisting(
  snapshot: RecallSnapshot,
  target: WorklogTarget,
  id: string
): WorklogExistingItem | null {
  const wanted = id.trim().toLowerCase()
  if (!wanted) return null
  return snapshot.items[target]?.find((i) => i.id.toLowerCase() === wanted) ?? null
}

/* ---------------------------------------------------------- the scan's verdict */

/**
 * What a scan reports once recall and the drafting are both done: which
 * outcome, and whether a warning rides along.
 *
 * Proposals win even when the board could not be checked — the drafts are
 * real work worth reviewing, and hiding them behind an error-styled banner
 * would leave a session's genuinely new work unlogged with nothing to accept
 * — but a starved read is not proof there was nothing to log, and it is not
 * proof the drafts are safe to accept either: they were written against an
 * empty view of the board, so one of them may already be sitting there under
 * another name. `outcome` stays 'proposed' so the drafts still show up for
 * review; `message` is where the warning travels so the banner can say the
 * board could not be checked first instead of staying clean, overriding
 * the brief's pinned
 * conjunction that checked `added.length` before `snapshot.budget`).
 *
 * An ordinary successful scan — board read fine, proposals drafted or not —
 * carries no message at all.
 *
 * 'error' never comes out of here: that outcome only ever comes from
 * `runWorklogScan`'s own catch block, for a failure recall cannot see (a
 * missing transcript, a thrown `WorklogBudgetError` from the scan itself).
 */
export function scanOutcomeFor(
  snapshot: RecallSnapshot,
  added: number
): { outcome: WorklogScanOutcome; message: string | null } {
  if (added > 0) {
    return { outcome: 'proposed', message: snapshot.budget ? (snapshot.error ?? null) : null }
  }
  // Nothing added, and recall could not afford to look. Reported as `budget`
  // rather than `nothing`, because a scan that never saw the boards is not
  // evidence that there was nothing to log — it is the exact silent failure
  // spec §2.4.1 names.
  if (snapshot.budget) return { outcome: 'budget', message: snapshot.error ?? null }
  return { outcome: 'nothing', message: null }
}
