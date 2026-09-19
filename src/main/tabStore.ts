import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EffortLevel, PermissionMode, StoredTab, StoredTabs } from '../shared/types.ts'
import { cliIdOf } from '../shared/codingClis.ts'

/**
 * The tabs that were open when Stoke last quit.
 *
 * Quitting runs `ptys.killAll()` and a restarted app cannot reattach to a CLI
 * child that outlived it, so this file is the only record of what was open.
 * Restoring from it is a relaunch (`claude --resume`), not a reattach.
 *
 * A sibling of worklog/sessionStore.ts and deliberately not part of it: that one
 * is an address book the worklog reads, this one is a UI snapshot, and a corrupt
 * snapshot must not cost the worklog its placements.
 *
 * Imports no electron, so scripts/verify-restore.mts exercises it directly.
 */

export const TAB_STATE_FILENAME = 'tabs.json'

/** More tabs than the strip stays legible at, and more than anyone opens. */
export const MAX_STORED_TABS = 20

/** Roughly one 120x50 screen of text. The tail is kept, trimmed on whole lines. */
export const MAX_SCREEN_BYTES = 8192

/**
 * Past two weeks the folder is likely a different piece of work wearing the same
 * path — the same reasoning STORED_SESSION_MAX_AGE_MS already uses.
 */
export const STORED_TAB_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const EMPTY: StoredTabs = { version: 1, savedAt: 0, activeIndex: 0, tabs: [] }

export function tabStateFile(userDataDir: string): string {
  return join(userDataDir, TAB_STATE_FILENAME)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions']
const EFFORT_LEVELS: readonly EffortLevel[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max']

/** A stored value wearing the right type is not the same as a validated one. */
function permissionModeOf(v: unknown): PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)
    ? (v as PermissionMode)
    : 'default'
}

function effortOf(v: unknown): EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : 'default'
}

/**
 * Keep the END of the text, not the start.
 *
 * The last thing on screen is the thing you were looking at, and a screen cut
 * from the top would show a paused tab its own scrollback header. Cut on a line
 * boundary so the first surviving line is never half a line.
 */
export function trimScreen(text: string): string {
  if (text.length <= MAX_SCREEN_BYTES) return text
  const tail = text.slice(text.length - MAX_SCREEN_BYTES)
  const nl = tail.indexOf('\n')
  return nl < 0 ? tail : tail.slice(nl + 1)
}

function tabOf(v: unknown): StoredTab | null {
  if (!isRecord(v)) return null
  const kind = v.kind === 'new' ? 'new' : 'session'
  const cwd = str(v.cwd)
  /*
   * A session tab with no folder can never be resumed — `--resume` needs a cwd —
   * so it would restore as a card whose only working button is Close. A New tab
   * legitimately has none.
   */
  if (kind === 'session' && !cwd) return null
  const ctx = isRecord(v.context) ? v.context : null
  return {
    kind,
    // Hydrated, never taken raw: this value chooses which binary a restore
    // spawns, and the file it comes from is one a user can edit.
    cliId: cliIdOf(v.cliId),
    sessionId: str(v.sessionId),
    cwd,
    projectName: str(v.projectName),
    title: str(v.title),
    permissionMode: permissionModeOf(v.permissionMode),
    model: str(v.model),
    effort: effortOf(v.effort),
    // Strictly true: a file written before this field existed, or edited by
    // hand, restores without it rather than with a truthy leftover.
    ultracode: v.ultracode === true,
    hostId: nullableStr(v.hostId),
    selectedPath: nullableStr(v.selectedPath),
    expandedPath: nullableStr(v.expandedPath),
    lastActiveAt: typeof v.lastActiveAt === 'number' && Number.isFinite(v.lastActiveAt) ? v.lastActiveAt : 0,
    context:
      ctx && typeof ctx.tokens === 'number' && typeof ctx.limit === 'number'
        ? { tokens: ctx.tokens, limit: ctx.limit }
        : null,
    screen: trimScreen(str(v.screen))
  }
}

/**
 * The pure core, so the suite can drive it without touching a disk.
 *
 * Anything unrecognisable becomes EMPTY rather than throwing: losing the tab
 * list is a nuisance, failing to start is not.
 */
export function normaliseTabs(raw: unknown, now = Date.now()): StoredTabs {
  if (!isRecord(raw)) return EMPTY
  // A future version was written by a newer Stoke and may mean anything.
  if (raw.version !== 1) return EMPTY
  if (!Array.isArray(raw.tabs)) return EMPTY

  // Identity is the tab's position in the raw, unsorted file — carried through
  // so activeIndex can be remapped to wherever that same tab lands, and so the
  // survivors below can be re-assembled in file order rather than recency order.
  const valid = raw.tabs
    .map((v, i) => ({ i, t: tabOf(v) }))
    .filter((x): x is { i: number; t: StoredTab } => x.t !== null && now - x.t.lastActiveAt < STORED_TAB_MAX_AGE_MS)

  // Recency decides ONLY which tabs get dropped when over the cap — never the
  // order tabs come back in. The spec persists tab order: the restored strip
  // must look like the strip the user left.
  const keep = new Set(
    [...valid]
      .sort((a, b) => b.t.lastActiveAt - a.t.lastActiveAt)
      .slice(0, MAX_STORED_TABS)
      .map((x) => x.i)
  )
  const survivors = valid.filter((x) => keep.has(x.i))

  const wanted = typeof raw.activeIndex === 'number' ? raw.activeIndex : 0
  // Find the same tab the raw index pointed at, at whatever position it now
  // occupies. Not found — dropped by expiry or the cap, or the index was
  // garbage to begin with — falls back to 0.
  const activeIndex = survivors.findIndex((x) => x.i === wanted)

  return {
    version: 1,
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    activeIndex: activeIndex >= 0 ? activeIndex : 0,
    tabs: survivors.map((x) => x.t)
  }
}

/** Never throws. A file that cannot be read is an empty snapshot. */
export function readTabState(file: string, now = Date.now()): StoredTabs {
  try {
    return normaliseTabs(JSON.parse(readFileSync(file, 'utf8')), now)
  } catch {
    // Missing (the normal first run) or corrupt. Both mean nothing to restore.
    return EMPTY
  }
}

/** Temp file + rename, matching store.ts, so a crash mid-write cannot truncate it. */
export function writeTabState(file: string, state: StoredTabs): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[stoke] failed to persist the open tabs', err)
  }
}

/* ------------------------------------------------------ update restart */

/**
 * "The quit that is about to happen is Stoke installing its own update."
 *
 * A sibling file rather than a field in `tabs.json`, because `tabs.json` has
 * one writer — the renderer's `tabs:save` push, rewritten on every change
 * (gotcha 35) — and a flag main wrote into it would be erased by the next
 * debounce. Written by main immediately before `quitAndInstall`, read and
 * deleted by the next boot's `tabs:restore`: then, and only then, the restored
 * tabs come back resumed rather than paused. An ordinary quit never writes it,
 * so an ordinary launch is unchanged — including the silent install
 * `autoInstallOnAppQuit` performs on a normal quit, which the user did not ask
 * to have their sessions resumed for.
 */
export const UPDATE_RESTART_FILENAME = 'update-restart.json'

/**
 * How long the marker is honoured. An update restart relaunches within
 * seconds; a marker older than this is a restart that did not happen (the
 * installer failed to quit, say), and resuming every tab on some unrelated
 * launch hours later is exactly the surprise the marker exists to avoid.
 */
export const UPDATE_RESTART_MAX_AGE_MS = 10 * 60 * 1000

export interface UpdateRestartMarker {
  at: number
  from: string
  to: string | null
}

export function updateRestartFile(userDataDir: string): string {
  return join(userDataDir, UPDATE_RESTART_FILENAME)
}

/** Written synchronously: the very next call quits the process. Never throws. */
export function writeUpdateRestart(file: string, marker: UpdateRestartMarker): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(marker), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[stoke] failed to record the update restart', err)
  }
}

/**
 * Whether a marker's text says "resume the tabs", as of `now`. Pure, so the
 * suite holds the rule: a number `at`, not in the future (a clock skew is not
 * a licence), and no older than `UPDATE_RESTART_MAX_AGE_MS`.
 */
export function updateRestartHonoured(text: string, now: number): boolean {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return false
  }
  if (!isRecord(raw) || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return false
  const age = now - raw.at
  return age >= 0 && age <= UPDATE_RESTART_MAX_AGE_MS
}

/**
 * Read the marker and delete it, whatever it said: one marker, one boot. A
 * marker that could not be deleted is not honoured either, or it would resume
 * the tabs on every launch for the next ten minutes.
 */
export function consumeUpdateRestart(file: string, now = Date.now()): boolean {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  try {
    rmSync(file, { force: true })
  } catch {
    return false
  }
  return updateRestartHonoured(text, now)
}
