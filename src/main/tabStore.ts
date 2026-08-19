import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EffortLevel, PermissionMode, StoredTab, StoredTabs } from '../shared/types.ts'

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
    sessionId: str(v.sessionId),
    cwd,
    projectName: str(v.projectName),
    title: str(v.title),
    permissionMode: str(v.permissionMode, 'default') as PermissionMode,
    model: str(v.model),
    effort: str(v.effort, 'default') as EffortLevel,
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

  const tabs = raw.tabs
    .map(tabOf)
    .filter((t): t is StoredTab => t !== null && now - t.lastActiveAt < STORED_TAB_MAX_AGE_MS)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_STORED_TABS)

  const wanted = typeof raw.activeIndex === 'number' ? raw.activeIndex : 0
  return {
    version: 1,
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    activeIndex: Number.isInteger(wanted) && wanted >= 0 && wanted < tabs.length ? wanted : 0,
    tabs
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
