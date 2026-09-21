import type { LiveSessionState, PromptOrigin, SessionBackgroundTask } from './types.ts'

/**
 * What a session's activity indicator shows — the tab strip's dot, the status
 * bar's line — and whether a Stop raises the "Finished" notification.
 *
 * Two sources, and neither is enough alone (gotcha 104):
 *
 *  - **The hooks** (`SessionEvent`): a prompt went in, a turn stopped, the CLI
 *    asked for permission. Edge-triggered and prompt, but a Stop fires at the
 *    end of every TURN — including one that ends while a workflow or a
 *    background subagent is still running — and a permission prompt fires once
 *    and is answered with no hook at all.
 *  - **The CLI's own session registry** (`LiveSessionState`, gotcha 80):
 *    level-triggered, once a second. `busy` is the CLI's own "a turn is loading
 *    OR a subagent/workflow/teammate is live", so it stays busy through a
 *    background workflow; `shell` is a background shell with nothing else
 *    running, which can last forever (a dev server); `waiting` is a question
 *    on screen, cleared when it is answered.
 *
 * So the registry decides whether anything is running and whether the user is
 * being asked something, and the hooks decide what finished and name it. With
 * no registry reading at all (another CLI, the first second of a session, a
 * CLI too old to write one) the hooks decide alone, exactly as they always did.
 *
 * Pure and in `src/shared` so the suite runs the whole table under
 * strip-types; no `node:` imports (gotcha 27). Derived at render time from
 * state App already holds — never stored, because `activity` already has five
 * writers and a sixth would be a cache with no invalidation (gotcha 57).
 */

/**
 * `working` a turn is running; `background` the turn ended but a workflow or
 * subagent it started is still running; `waiting` the CLI is asking the user
 * something; `done` a turn finished since the tab was last looked at.
 */
export type ActivityDot = 'working' | 'background' | 'waiting' | 'done'

/**
 * The last hook event for a session, as App keeps it (`SessionActivity`).
 * `background` is the running/pending work the last Stop listed.
 */
export interface HookActivity {
  state: 'working' | 'done' | 'attention'
  /** Epoch ms the event was READ (main's clock), not when the CLI wrote it. */
  at: number
  message: string | null
  background?: readonly SessionBackgroundTask[]
  /**
   * A `done` or `attention` the user has looked at (`afterLooking`): it draws
   * no dot of its own, but it is KEPT, because it is still the last thing the
   * hooks said. Deleting it instead left a lagging registry `busy` with
   * nothing to weigh it against, so the front tab read "Claude is working…"
   * and pulsed for up to a second after almost every turn (gotcha 104).
   */
  seen?: boolean
}

export interface ActivityInput {
  /** The last hook activity for the tab's CURRENT session id, or null. */
  hook: HookActivity | null
  /** The registry reading for the tab's pty (keyed by ptyId), or null. */
  live: Pick<LiveSessionState, 'status' | 'waitingFor' | 'statusUpdatedAt'> | null
  /** The tab's process is running — not exited, not paused. */
  running: boolean
}

export interface ActivityView {
  dot: ActivityDot | null
  /** One line for the status bar, and the tooltip's lead. '' with no dot. */
  label: string
  /** The last reply or the CLI's own message, for a tooltip. */
  detail: string | null
  /** Whether a Stop that produced this reading raises "Finished". */
  notify: boolean
}

/**
 * The background work a finished turn is still waiting on: the two kinds whose
 * running state keeps the registry `busy` unconditionally and whose end wakes
 * the session with a `<task-notification>` turn. A `teammate` counts as busy
 * only while not idle and a `cloud session` not at all when long-running, and
 * the hook cannot say which — so neither holds back "Finished", which would
 * otherwise never come for a teammate that idles for an hour.
 */
const AGENT_WORK: ReadonlySet<string> = new Set(['workflow', 'subagent'])

export function agentWork(
  background: readonly SessionBackgroundTask[] | undefined
): SessionBackgroundTask[] {
  return (background ?? []).filter((t) => AGENT_WORK.has(t.type))
}

/**
 * Whether a Stop raises the "Finished" notification: not while a workflow or
 * subagent it started is still running. That turn is not the end of anything
 * the user is waiting for; the one that answers the task's notification is,
 * and its own Stop (with nothing left running) notifies then.
 */
export function stopNotifies(background: readonly SessionBackgroundTask[] | undefined): boolean {
  return agentWork(background).length === 0
}

export const WORKING_LABEL = 'Claude is working…'
export const DONE_LABEL = 'Finished — your move'
/** The hook-only attention line when the CLI's message was empty. */
export const ATTENTION_LABEL = 'Needs your attention'

/**
 * `waitingFor` as the registry states it (measured on 2.1.278), in the words
 * the status bar uses. An unknown value is shown as the CLI wrote it; parseRegistry
 * has already clipped it to 200 characters.
 */
const WAITING_WORDS: Readonly<Record<string, string>> = {
  'permission prompt': 'permission',
  'input needed': 'question',
  'sandbox request': 'sandbox access',
  'worker request': 'worker request',
  'goal proposal': 'goal proposal'
}

/**
 * A `waiting` the user did not start: every value but `dialog open`, which is
 * a panel the user opened themselves (a slash command's) — not worth an alert.
 */
export function waitingAlerts(waitingFor: string | null | undefined): boolean {
  return waitingFor !== 'dialog open'
}

export function waitingLabel(waitingFor: string | null | undefined): string {
  if (!waitingFor) return 'Waiting for you'
  return `Waiting for you — ${WAITING_WORDS[waitingFor] ?? waitingFor}`
}

/** `workflow “name”`, or the bare type when the entry named nothing. */
function taskPhrase(t: SessionBackgroundTask): string {
  return t.name ? `${t.type} “${t.name}”` : t.type
}

/**
 * What is running in the background, agents first, for one status-bar line:
 * `Running in the background: workflow “x”`, or two named and a count.
 */
export function backgroundLabel(background: readonly SessionBackgroundTask[] | undefined): string {
  const all = background ?? []
  const agents = agentWork(all)
  const ordered = [...agents, ...all.filter((t) => !AGENT_WORK.has(t.type))]
  if (!ordered.length) return 'Running in the background'
  const shown = ordered.slice(0, 2).map(taskPhrase).join(', ')
  const more = ordered.length - 2
  return `Running in the background: ${shown}${more > 0 ? `, and ${more} more` : ''}`
}

/**
 * Whether the registry stated its current status AFTER this hook event was
 * read — i.e. the registry is describing something newer than the hook, not
 * lagging behind it. Both polls run once a second on their own phase, so
 * either can be up to a second behind the other; the registry's own
 * `statusUpdatedAt` is the tie-breaker. Unknown counts as "not after", which
 * leaves the hook in charge, as before the registry existed.
 */
function statedAfter(live: ActivityInput['live'], hook: HookActivity): boolean {
  const at = live?.statusUpdatedAt
  return typeof at === 'number' && Number.isFinite(at) && at > hook.at
}

/**
 * Whether an `attention` hook belongs to the waiting the registry states now.
 * The Notification fires once, when a dialog is first shown, and nothing fires
 * when it is answered — so after one permission prompt is answered, its
 * attention entry outlives it, and a LATER wait in the same turn (a question)
 * showed "Waiting for you — question: Claude needs your permission to use
 * Bash" (seen driving the built app over CDP). The hook is read up to a poll
 * after the dialog appears, the registry stamps the wait when it appears, so a
 * hook read more than ATTENTION_MATCH_MS before that stamp is an earlier
 * dialog's. With no stamp, only an entry nobody has looked at yet counts.
 */
const ATTENTION_MATCH_MS = 2000
function attentionFor(hook: HookActivity, live: ActivityInput['live']): boolean {
  const at = live?.statusUpdatedAt
  if (typeof at !== 'number' || !Number.isFinite(at)) return !hook.seen
  return hook.at >= at - ATTENTION_MATCH_MS
}

const NONE = (notify: boolean): ActivityView => ({ dot: null, label: '', detail: null, notify })

/** The hooks alone: the behaviour before the registry was read. */
function fromHooks(hook: HookActivity | null, notify: boolean): ActivityView {
  if (!hook) return NONE(notify)
  if (hook.state === 'working') return { dot: 'working', label: WORKING_LABEL, detail: null, notify }
  if (hook.seen) return NONE(notify)
  if (hook.state === 'done') return { dot: 'done', label: DONE_LABEL, detail: hook.message, notify }
  return { dot: 'waiting', label: hook.message ?? ATTENTION_LABEL, detail: null, notify }
}

/** "Finished" — or nothing, once the user has looked at it. */
function done(hook: HookActivity, notify: boolean, shellRunning: boolean): ActivityView {
  if (hook.seen) return NONE(notify)
  let label = DONE_LABEL
  if (shellRunning) {
    const shell = (hook.background ?? []).find((t) => t.type === 'shell')
    label += shell?.name ? ` · shell “${shell.name}” still running` : ' · a shell is still running'
  }
  return { dot: 'done', label, detail: hook.message, notify }
}

/**
 * The decision. See the table in `scripts/verify-registry.mts`, which asserts
 * every row, and gotcha 104 for why each one is what it is.
 */
export function activityView({ hook, live, running }: ActivityInput): ActivityView {
  const notify = hook?.state === 'done' && stopNotifies(hook.background)

  // A process that is not running is doing nothing, whatever was last heard:
  // a pty that died mid-turn never sent its Stop, and its last registry
  // reading is kept (the file goes before the pty does), so neither may pulse.
  if (!running) return hook?.state === 'done' ? done(hook, notify, false) : NONE(notify)

  const status = live?.status ?? null

  // Level-triggered, from the registry, and cleared only when it is answered —
  // looking at the tab does not answer a permission prompt.
  if (status === 'waiting' && waitingAlerts(live?.waitingFor)) {
    return {
      dot: 'waiting',
      label: waitingLabel(live?.waitingFor),
      detail: hook?.state === 'attention' && attentionFor(hook, live) ? hook.message : null,
      notify
    }
  }

  // No reading, or a panel the user opened (which says nothing about a turn):
  // the hooks alone, exactly as before.
  if (status === null || status === 'waiting') return fromHooks(hook, notify)

  if (status === 'busy') {
    if (hook?.state === 'done') {
      // The turn ended and the session is still busy: a workflow or subagent
      // it started, named by the Stop. Keep pulsing, and say what runs.
      if (agentWork(hook.background).length) {
        return { dot: 'background', label: backgroundLabel(hook.background), detail: hook.message, notify }
      }
      // Busy stated after the Stop was read is a NEW busy period — a prompt
      // whose hook has not been read yet, or `/compact`, which fires none.
      if (statedAfter(live, hook)) return { dot: 'working', label: WORKING_LABEL, detail: null, notify }
      // Otherwise the registry has not caught up with the Stop yet: the Stop
      // is the newer word, seen or not — a seen one draws nothing, never the
      // registry's stale `working`.
      return done(hook, notify, false)
    }
    // A prompt, an answered permission prompt (waiting -> busy has no hook),
    // or a turn whose prompt hook has not been read yet.
    return { dot: 'working', label: WORKING_LABEL, detail: null, notify }
  }

  // `idle` or `shell`: no turn is running. `shell` never pulses — a background
  // shell can run for as long as the dev server it started.
  if (hook?.state === 'working') {
    if (statedAfter(live, hook)) return done(hook, notify, status === 'shell')
    // The registry has not seen the new turn yet. For `idle` that is today's
    // behaviour (and the busy -> idle settle in App ends it); a `shell` reading
    // may be a background shell that outlives everything, so it may not pulse.
    return status === 'idle' ? { dot: 'working', label: WORKING_LABEL, detail: null, notify } : NONE(notify)
  }
  if (hook?.state === 'done') return done(hook, notify, status === 'shell')
  // `attention` with the registry idle: the question was answered or
  // dismissed (Esc at a permission prompt ends the turn with no Stop).
  return NONE(notify)
}

/**
 * Whether looking at the tab clears what it shows: everything that means
 * "since you last looked" (`done`, a hook-only `waiting`, nothing at all) is
 * cleared; what is still running is not. A registry `waiting` survives the
 * clear anyway, because it is read from the registry, not from the entry.
 */
export function clearedByLooking(view: ActivityView): boolean {
  return view.dot !== 'working' && view.dot !== 'background'
}

/**
 * What looking at the tab (in front, window focused — App's `seenActive`)
 * leaves of its hook entry, given the view it produced. The same object when
 * nothing changes, so the caller can bail out without a render; null to drop
 * it.
 *
 * A `done` or `attention` is marked `seen`, never deleted: it is still the
 * newest thing the hooks said, and `activityView` needs it to tell a lagging
 * registry `busy` from a new turn and to name a workflow that runs on. A
 * `working` entry is dropped as before — its view is not `working` only when
 * the process is gone, a question is on screen or a shell is all that runs,
 * and in all three the registry, not the entry, says what comes next.
 */
export function afterLooking(hook: HookActivity, view: ActivityView): HookActivity | null {
  if (!clearedByLooking(view)) return hook
  if (hook.state === 'working') return null
  return hook.seen ? hook : { ...hook, seen: true }
}

/**
 * Whether a prompt hook means the prompt box was emptied (gotcha 82's typed
 * guard). A turn the CLI injected — a finished task's notification, a
 * teammate's message — submitted nothing the user typed. Null (an event from
 * before origins were read) keeps the old behaviour.
 */
export function promptClearsDraft(origin: PromptOrigin | null | undefined): boolean {
  return origin !== 'task-notification' && origin !== 'system'
}

/**
 * Whether a registry push means something MAY have been submitted: the
 * session went from not busy (`idle`, or no reading yet) to `busy`. Not every
 * push that reads busy — `busy -> shell`, `waiting -> busy` (a permission
 * prompt answered) and a workflow keeping the session busy for an hour submit
 * nothing, and clearing on them threw away a draft typed meanwhile.
 *
 * Even this edge is only provisional (`draftOnRegistry`): the CLI starts turns
 * of its own on an idle session — a task's notification, a teammate's
 * message, a `/loop` or scheduled wake-up — and none of those emptied the
 * prompt box.
 */
export function registryClearsDraft(
  before: Pick<LiveSessionState, 'status'> | null | undefined,
  after: Pick<LiveSessionState, 'status'>
): boolean {
  if (after.status !== 'busy') return false
  return !before || before.status === null || before.status === 'idle'
}

/**
 * How far apart a registry idle -> busy edge and a prompt hook may be read and
 * still be one submission. Both are polled once a second on their own phase
 * (the registry file and the events file), and the hook shim writes its line
 * a moment after the CLI goes busy, so the two land up to ~1.5 s apart.
 */
export const DRAFT_EDGE_WINDOW_MS = 2000

/**
 * What gotcha 82's typed-draft guard needs remembered per pty, beside the
 * flag itself (ptyBus's `typedSinceSubmit`). Owned by App, one per ptyId.
 */
export interface DraftTrack {
  /**
   * The last registry idle -> busy edge: when it cleared the flag, and what the
   * flag held before, so a machine-injected prompt read just after it can put
   * the flag back.
   */
  edge: { at: number; previous: boolean } | null
  /**
   * A machine-injected prompt hook read before any edge claimed it: the edge
   * that follows within the window is that prompt's turn, and clears nothing.
   */
  injectedAt: number | null
  /**
   * The flag as the registry went INTO `waiting`, null while not waiting.
   * Keys typed at a dialog answer the dialog, not the prompt box, so the
   * edge back out puts this back.
   */
  beforeWaiting: boolean | null
}

export const NO_DRAFT_TRACK: DraftTrack = { edge: null, injectedAt: null, beforeWaiting: null }

export interface DraftStep {
  track: DraftTrack
  /** What the typed flag should read now. */
  typed: boolean
}

function within(at: number | null | undefined, now: number): boolean {
  return typeof at === 'number' && Math.abs(now - at) <= DRAFT_EDGE_WINDOW_MS
}

/**
 * A registry push for a pty: the flag is `typed` now; returns what it should
 * be. `now` is when the push was received; `draftOnPrompt` must be fed the
 * same clock.
 *
 * - Into `waiting` snapshots the flag; out of it (to anything) restores it.
 * - An idle -> busy edge clears the flag — unless a machine-injected prompt
 *   was read within the window before it (that is the turn it started) — and
 *   remembers what it cleared, for a machine-injected prompt read after it.
 */
export function draftOnRegistry(
  track: DraftTrack,
  before: Pick<LiveSessionState, 'status'> | null | undefined,
  after: Pick<LiveSessionState, 'status'>,
  typed: boolean,
  now: number
): DraftStep {
  let next = track
  let flag = typed
  const was = before?.status ?? null
  if (after.status === 'waiting' && was !== 'waiting') {
    next = { ...next, beforeWaiting: flag }
  } else if (was === 'waiting' && after.status !== 'waiting') {
    if (next.beforeWaiting !== null) flag = next.beforeWaiting
    next = { ...next, beforeWaiting: null }
  }
  if (registryClearsDraft(before, after)) {
    if (within(next.injectedAt, now)) {
      // The CLI's own turn, its prompt hook already read: nothing was submitted.
      next = { ...next, edge: null, injectedAt: null }
    } else {
      next = { ...next, edge: { at: now, previous: flag }, injectedAt: null }
      flag = false
    }
  }
  return { track: next, typed: flag }
}

/**
 * A prompt hook for a pty. A typed one empties the prompt box, and settles any
 * edge as a real submission. A machine-injected one read within the window of
 * an edge was that edge's turn, so the flag the edge cleared comes back (keys
 * typed since the edge keep it set too); with no edge yet, it is remembered for
 * the edge that follows. An edge no prompt hook claims — a slash command, which
 * fires none — keeps its clear.
 */
export function draftOnPrompt(
  track: DraftTrack,
  origin: PromptOrigin | null | undefined,
  typed: boolean,
  now: number
): DraftStep {
  if (promptClearsDraft(origin)) {
    // Emptied now, so a `waiting` it lands in must not bring the draft back.
    const beforeWaiting = track.beforeWaiting === null ? null : false
    return { track: { edge: null, injectedAt: null, beforeWaiting }, typed: false }
  }
  if (track.edge && within(track.edge.at, now)) {
    return { track: { ...track, edge: null }, typed: typed || track.edge.previous }
  }
  return { track: { ...track, injectedAt: now }, typed }
}
