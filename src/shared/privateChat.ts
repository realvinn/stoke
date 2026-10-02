/**
 * Private chat: a local Claude Code tab whose conversation is not kept, and
 * whose folder and per-session files are deleted when the tab closes — the
 * temporary chat of claude.ai and ChatGPT, done for a real `claude` in a pty.
 *
 * The pure half: what the CLI is told, what Stoke deletes afterwards, and the
 * three decisions on the way (a rebind, a close, a stored tab). Main's
 * `privateChat.ts` does the disk; the renderer draws the ghost. No `node:`
 * imports (gotcha 27): `join` is passed in where a path is built, and every
 * comparison goes through `paths.ts`'s rules, so `verify:private` can run all
 * of it under strip-types with a fake platform.
 *
 * WHAT THE CLI IS TOLD. Read out of the installed 2.1.287 binary (strings,
 * never run), 2026-10-02:
 *
 * - `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is the interactive switch. The
 *   persistence predicate is `eln(){… if(a.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
 *   return"skip_prompt_history" …}`, `Ha(){return eln()!==null}`, and the
 *   transcript writer's `shouldSkipPersistence(){return Ha()||…}`; the
 *   prompt-history writer returns early on the same variable. The documented
 *   `--no-session-persistence` is print-only. The TUI pins its own line for it,
 *   "Transcript saving is off — CLAUDE_CODE_SKIP_PROMPT_HISTORY is set".
 * - `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`: `VR()` is
 *   `fileCheckpointingEnabled && !CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`, so
 *   no `file-history/<id>` (and no /rewind code restore).
 * - `CLAUDE_CODE_DISABLE_AGENT_VIEW` (setting `disableAgentView`): no
 *   `/background`, `--bg` or daemon. It matters because the daemon hand-off
 *   scrubs `CLAUDE_CODE_SKIP_PROMPT_HISTORY` from the env it passes on, so a
 *   chat sent to the background would start saving again.
 * - `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (setting `autoMemoryEnabled: false`).
 *
 * Set LAST in pty.ts, after the provider or account env, so nothing a
 * provider or an account carries can switch persistence back on. Gotcha 148.
 */
import { pathKey, pathRulesFor, type PathRules } from './paths.ts'
import type { StoredTabs } from './types.ts'

/** The environment a private chat's `claude` gets on top of everything else. */
export const PRIVATE_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
  CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
})

/**
 * Where plan files go, RELATIVE to the project root — which for a private chat
 * is its own folder, so they are deleted with it. Unset, plans are written to
 * `~/.claude/plans/`, shared by every session and kept. The CLI refuses a
 * `plansDirectory` outside the project root ("plansDirectory must be within
 * project root").
 */
export const PRIVATE_PLANS_DIR = 'plans'

/**
 * Merged into Stoke's ONE `--settings` file for a private launch (gotcha 2: a
 * second `--settings` silently discards the first). Each key's description in
 * the 2.1.287 schema: `autoMemoryEnabled` "When false, Claude will not read
 * from or write to the auto-memory directory"; `autoDreamEnabled` "background
 * memory consolidation"; `fileCheckpointingEnabled` "Snapshot files before
 * edits so /rewind can restore them"; `disableAgentView` "Equivalent to
 * CLAUDE_CODE_DISABLE_AGENT_VIEW=1"; `disableRemoteControl` "Disable Remote
 * Control (claude.ai/code …, auto-start, and the in-session toggle)" — the
 * schema says "Typically set in managed settings", and whether a flag layer
 * honours it is unverified, so `remoteControlAtStartup: false` (gotcha 37) is
 * there too.
 */
export const PRIVATE_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
  autoMemoryEnabled: false,
  autoDreamEnabled: false,
  fileCheckpointingEnabled: false,
  disableAgentView: true,
  disableRemoteControl: true,
  remoteControlAtStartup: false,
  plansDirectory: PRIVATE_PLANS_DIR
})

/* ----------------------------------------------------------------- launch */

/**
 * Why a private chat may not start from this request, or null. Claude Code on
 * THIS computer, from this computer: never from the phone or another machine
 * (whose relay is the phone's API), never over SSH (the far machine's `claude`
 * would save there, and gotcha 19 forbids adding to its command), never as an
 * install, a key enrollment or a sign-in.
 */
export function privateLaunchProblem(input: {
  origin: 'desktop' | 'remote'
  host: boolean
  install: boolean
  enroll: boolean
  accountLogin: boolean
}): string | null {
  if (input.origin !== 'desktop') return 'A private chat can only be started on this computer.'
  if (input.host || input.install || input.enroll || input.accountLogin) {
    return 'A private chat runs Claude Code on this computer only.'
  }
  return null
}

/* ------------------------------------------------------------------ words */

export const PRIVATE_CHAT_NAME = 'Private chat'
/** The ghost button's tooltip, and the launcher row's. */
export const PRIVATE_BUTTON_TITLE = 'Private chat: nothing is saved, closing the tab deletes it'
/** The strip above a private tab's terminal. */
export const PRIVATE_STRIP_TEXT =
  'Private chat. Nothing is saved on this computer and closing this tab deletes it. Anthropic still receives what you send.'
/** The strip once the watchdog has found a transcript the CLI wrote anyway. */
export const PRIVATE_LEAK_TEXT =
  'Claude Code wrote a transcript for this private chat anyway. Closing this tab still deletes it; until then it is on this computer.'
/** The strip once the tab has `/resume`d into a conversation that was saved before. */
export const PRIVATE_FOREIGN_TEXT =
  'This tab is now on a saved conversation (it was resumed). That conversation is not private, and closing the tab will not delete it.'
/** The exit card. */
export const PRIVATE_ENDED_TEXT = 'Private chat ended. Nothing was kept.'
/** The OS notification's title for a private tab: never the tab's own title. */
export const PRIVATE_NOTIFY_TITLE = 'Private chat'

/* -------------------------------------------------------------------- ids */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A session id Stoke may build a path to delete from: a lowercase uuid, as
 * `randomUUID` mints and as the CLI's own `/clear` mints. Anything else — a
 * `..`, a separator, an empty string — is refused before it reaches a `join`.
 */
export function isPrivateId(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

/**
 * Claude Code's name for a project's folder under `projects/`: every
 * character that is not a letter or a digit becomes `-`, and past 200
 * characters the CLI cuts and appends a hash (`Jx` in 2.1.287). Stoke never
 * reproduces the hash, so a longer folder has no slug here and its private
 * chat is refused (`privateSlug`). Byte-for-byte the rule `projects.ts`'s
 * `encodePath` applies; `verify:private` holds the two together.
 */
export function encodeProjectDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The longest slug the CLI writes unhashed. */
export const MAX_PLAIN_SLUG = 200

/** The private folder's `projects/` slug, or null when the CLI would hash it. */
export function privateSlug(folder: string): string | null {
  const slug = encodeProjectDir(folder.replace(/[\\/]+$/, ''))
  return slug && slug.length <= MAX_PLAIN_SLUG ? slug : null
}

/* ------------------------------------------------------------------ paths */

/** `child` is strictly inside `base` — never `base` itself, never a sibling sharing a prefix. */
export function strictlyInside(base: string, child: string, rules: PathRules): boolean {
  const b = pathKey(base, rules)
  const c = pathKey(child, rules)
  if (!b || !c || b === c) return false
  return c.startsWith(b.endsWith(rules.sep) ? b : b + rules.sep)
}

/** Is this path a private chat's folder, or anything in one? `roots` are the private root(s), raw and real. */
export function isPrivatePath(path: string, roots: readonly string[], platform: string): boolean {
  const rules = pathRulesFor(platform)
  return roots.some((r) => strictlyInside(r, path, rules))
}

/**
 * Is this `projects/` folder name a private chat's? The CLI names it after the
 * cwd (`encodeProjectDir`), so every private folder's slug starts with its
 * root's slug and a dash. Case-folded, as `listProjects` keys the folders.
 * Hides a folder from lists; never decides a deletion (that is
 * `privateCleanupTargets`, by exact slug).
 */
export function isPrivateProjectDir(name: string, roots: readonly string[]): boolean {
  const n = name.toLowerCase()
  return roots.some((r) => {
    const slug = encodeProjectDir(r.replace(/[\\/]+$/, '')).toLowerCase()
    return slug.length > 1 && n.startsWith(slug + '-')
  })
}

/* ----------------------------------------------------------------- marker */

/**
 * What Stoke writes to `<userData>/private/<id>.json` BEFORE the folder exists,
 * and what the boot sweep reads after a crash. The folder's path is never
 * stored: it is derived from the root and the id (`<root>/<id>`), so a marker
 * that was edited or half-written can point at nothing but a private folder.
 */
export interface PrivateMarker {
  version: 1
  /** The id the chat was launched with: the marker's and the folder's name. */
  id: string
  /** Every id this chat has been on (a `/clear` adds one), the first included. */
  ids: string[]
  /** The `CLAUDE_CONFIG_DIR`s the CLI could have written to: the default, and an account's. */
  configDirs: string[]
  createdAt: number
}

const MAX_MARKER_IDS = 64
const MAX_CONFIG_DIRS = 4

function absolute(p: unknown): p is string {
  return typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'))
}

/** A marker read back, checked field by field; null when anything is off. */
export function parseMarker(raw: string, fileId: string): PrivateMarker | null {
  if (!isPrivateId(fileId)) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const m = v as Record<string, unknown>
  if (m.version !== 1 || m.id !== fileId) return null
  if (!Array.isArray(m.ids) || !m.ids.length || m.ids.length > MAX_MARKER_IDS) return null
  if (!m.ids.every(isPrivateId) || !m.ids.includes(fileId)) return null
  if (!Array.isArray(m.configDirs) || m.configDirs.length > MAX_CONFIG_DIRS || !m.configDirs.every(absolute)) return null
  const createdAt = typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : 0
  return {
    version: 1,
    id: fileId,
    ids: [...new Set(m.ids as string[])],
    configDirs: [...new Set(m.configDirs as string[])],
    createdAt
  }
}

export function markerText(m: PrivateMarker): string {
  return `${JSON.stringify(m, null, 2)}\n`
}

/* ---------------------------------------------------------------- cleanup */

export interface CleanupTarget {
  /** What to remove (recursively, forced). */
  path: string
  /** The folder it must resolve inside, through symlinks, before it is removed. */
  within: string
}

/**
 * Every path a private chat can have left, built by exact join from validated
 * parts — never by listing a folder and deleting what is there.
 *
 * Per config dir (the default and an account's): `projects/<slug>` (the
 * transcripts, `memory/` and `subagents/` of THIS folder only — its slug is
 * unique to it), and per id `file-history/<id>`, `session-env/<id>`,
 * `image-cache/<id>`, `tasks/<id>`, `debug/<id>.txt`. Under each per-uid temp
 * root the CLI's per-cwd folder, `<tmp>/claude-<uid>/<slug>`. Then the private
 * folder itself. Files whose NAME carries the id (`telemetry/`, `todos/`) are
 * matched by `idFileMatches` against a listing of that one folder.
 */
export function privateCleanupTargets(input: {
  ids: readonly string[]
  /** The private folder, as the CLI saw it (its realpath). */
  folder: string
  /** The private root it sits in (realpath). */
  privateRoot: string
  configDirs: readonly string[]
  /** `<tmp>/claude-<uid>` folders the CLI may have used. */
  tmpRoots: readonly string[]
  join: (...parts: string[]) => string
}): CleanupTarget[] {
  const ids = [...new Set(input.ids.filter(isPrivateId))]
  const slug = privateSlug(input.folder)
  const out: CleanupTarget[] = []
  for (const cfg of [...new Set(input.configDirs.filter(absolute))]) {
    if (slug) out.push({ path: input.join(cfg, 'projects', slug), within: cfg })
    for (const id of ids) {
      for (const dir of ['file-history', 'session-env', 'image-cache', 'tasks']) {
        out.push({ path: input.join(cfg, dir, id), within: cfg })
      }
      out.push({ path: input.join(cfg, 'debug', `${id}.txt`), within: cfg })
    }
  }
  if (slug) for (const tmp of [...new Set(input.tmpRoots.filter(absolute))]) out.push({ path: input.join(tmp, slug), within: tmp })
  out.push({ path: input.folder, within: input.privateRoot })
  return out
}

/** The folders whose files are named after a session id rather than kept in a folder of it. */
export const ID_NAMED_DIRS = ['telemetry', 'todos'] as const

const FIRST_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/**
 * Names in such a folder that belong to one of the ids: the session id is the
 * FIRST uuid in the name (`1p_failed_events.<session>.<event uuid>.json`,
 * `<session>-agent-<agent>.json`). Not "contains the id anywhere": another
 * session's telemetry file carries a second, random uuid, and a chat must never
 * delete a file because that random uuid happened to be one of its ids — the
 * suite's own fixture caught exactly that (gotcha 148).
 */
export function idFileMatches(names: readonly string[], ids: readonly string[]): string[] {
  const valid = ids.filter(isPrivateId)
  return names.filter((n) => {
    if (n.includes('/') || n.includes('\\')) return false
    const first = FIRST_UUID.exec(n)
    return first !== null && valid.includes(first[0])
  })
}

/**
 * May a target be removed? Its parent's REALPATH must lie inside the realpath
 * of the folder it was built under, or of another allowed base — an account's
 * `projects` is a link into the default tree (accounts.ts), which resolves
 * into the default config dir and is allowed for that reason. A parent that
 * resolves anywhere else (a link someone pointed out of the tree) is left alone.
 */
export function cleanupAllowed(realParent: string, realBases: readonly string[], platform: string): boolean {
  const rules = pathRulesFor(platform)
  return realBases.some((b) => pathKey(b, rules) === pathKey(realParent, rules) || strictlyInside(b, realParent, rules))
}

/* ----------------------------------------------------------------- rebind */

/**
 * A private pty's `claude` moved to another session id (the registry rebind,
 * gotcha 80). `adopt` adds it to what is deleted at close: a `/clear` mints a
 * fresh id with no transcript, or (persistence leaking) one written under this
 * chat's own folder. `foreign` is a conversation that was saved before, under
 * another folder, which the user `/resume`d into: never deleted — its
 * file-history and session-env are a real conversation's — and the tab says the
 * chat is no longer private. `same` changes nothing; `invalid` is refused.
 */
export type PrivateRebind = 'same' | 'adopt' | 'foreign' | 'invalid'

export function privateRebindVerdict(input: {
  newId: string
  known: readonly string[]
  /** Where a transcript for `newId` was found, or null for none. */
  transcript: string | null
  /** This chat's `projects/` slug. */
  slug: string | null
}): PrivateRebind {
  if (!isPrivateId(input.newId)) return 'invalid'
  if (input.known.includes(input.newId)) return 'same'
  if (input.transcript === null) return 'adopt'
  const parts = input.transcript.split(/[\\/]+/).filter(Boolean)
  const parent = parts.length >= 2 ? parts[parts.length - 2] : ''
  return input.slug && parent.toLowerCase() === input.slug.toLowerCase() ? 'adopt' : 'foreign'
}

/* ------------------------------------------------------------------ close */

/**
 * Closing a private tab deletes it, so it asks first only when that loses
 * something: files in its folder (`files`, null when main could not count
 * them — asked, since a delete cannot be undone), or a turn running (the
 * registry's `busy`, gotcha 82's reading). An idle chat with an empty folder
 * closes at once.
 */
export function privateCloseAsks(input: { files: number | null; busy: boolean | null }): boolean {
  return input.busy === true || input.files === null || input.files > 0
}

/* ------------------------------------------------------------- hook event */

/** How much of a prompt a private chat's hook keeps: enough for `promptOrigin`'s openings. */
export const PRIVATE_PROMPT_KEEP = 48

const PRIVATE_EVENT_KEYS = ['hook_event_name', 'session_id', 'notification_type', 'cwd', 'source', 'background_tasks']

/**
 * The hook event a private chat's shim writes to its events file: the fields
 * the dot and the draft guard read (gotcha 104), never the reply
 * (`last_assistant_message`), the notification text or the transcript path,
 * and only the opening of a prompt. The generated wrapper carries the same
 * rule as text (statusLine.ts `WRAPPER_JS`); `verify:private` runs the real
 * wrapper and compares the two.
 */
export function reducePrivateHookEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PRIVATE_EVENT_KEYS) if (k in raw) out[k] = raw[k]
  if (typeof raw.prompt === 'string') out.prompt = raw.prompt.slice(0, PRIVATE_PROMPT_KEEP)
  return out
}

/* ---------------------------------------------------------------- restore */

/**
 * A stored tab main may keep in `tabs.json`. The renderer never sends a
 * private tab (`toStored`); this is main's own check, by what it knows — the
 * ids it minted and the folder every private chat runs in — so a renderer that
 * forgot cannot write a private chat's screen to disk, and one written by an
 * older build is not restored.
 */
export function keepStoredTab(
  tab: { sessionId: string; cwd: string },
  privateIds: ReadonlySet<string>,
  roots: readonly string[],
  platform: string
): boolean {
  if (tab.sessionId && privateIds.has(tab.sessionId)) return false
  return !isPrivatePath(tab.cwd, roots, platform)
}

/**
 * `tabs.json` without any private tab, the selection kept on the tab it was
 * on (or the nearest one before it when that tab is the one dropped). The same
 * object back when nothing was dropped, so an ordinary save is unchanged.
 */
export function dropPrivateStoredTabs(
  state: StoredTabs,
  privateIds: ReadonlySet<string>,
  roots: readonly string[],
  platform: string
): StoredTabs {
  const keep = state.tabs.map((t) => keepStoredTab(t, privateIds, roots, platform))
  if (keep.every(Boolean)) return state
  const tabs = state.tabs.filter((_, i) => keep[i])
  let activeIndex = 0
  for (let i = 0, k = -1; i < state.tabs.length; i++) {
    if (keep[i]) k += 1
    if (i === state.activeIndex) {
      activeIndex = Math.max(0, k)
      break
    }
  }
  return { ...state, tabs, activeIndex: Math.min(activeIndex, Math.max(0, tabs.length - 1)) }
}
