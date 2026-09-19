/**
 * The new-session page's pure logic: which folders the switcher offers, how two
 * projects with one name are told apart, which conversations the list shows,
 * and what a key does. Kept out of Launcher.tsx so `verify:launcher` can hold
 * it — a React component's arithmetic is only checkable by clicking (gotcha 31).
 *
 * Imported by the renderer through `@shared/launcher` and by the suite by
 * relative path; runtime imports here must carry `.ts` (gotcha 78).
 */

/* --------------------------------------------------------- disambiguation */

export interface NamedPath {
  path: string
  /** What the row shows: the project's label, else its basename. */
  label: string
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function sepOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/**
 * For every entry whose label another entry shares (case-folded), the shortest
 * run of parent folders that tells it apart: `Laro` under `dev/work` and under
 * `dev/personal` become `work` and `personal`. Entries with a unique label get
 * no suffix. Keyed by path. (QA L14: the sidebar and the launcher both showed
 * two identical `proj-a` rows.)
 *
 * Each entry is compared at the same depth against every other in its group,
 * so `/tmp/x/proj-a` and `/private/tmp/x/proj-a` resolve to `tmp/x` and
 * `private/tmp/x` rather than both to `x`.
 */
export function disambiguate(items: readonly NamedPath[]): Record<string, string> {
  const groups = new Map<string, NamedPath[]>()
  for (const it of items) {
    const key = it.label.trim().toLowerCase()
    const g = groups.get(key)
    if (g) g.push(it)
    else groups.set(key, [it])
  }
  const out: Record<string, string> = {}
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const parents = group.map((it) => segments(it.path).slice(0, -1))
    const deepest = Math.max(...parents.map((p) => p.length))
    const suffix = (p: string[], k: number): string => p.slice(Math.max(0, p.length - k)).join('/')
    group.forEach((it, i) => {
      let k = 1
      for (; k <= deepest; k++) {
        const mine = suffix(parents[i], k)
        if (parents.every((other, j) => j === i || suffix(other, k) !== mine)) break
      }
      const sep = sepOf(it.path)
      const shown = parents[i].slice(Math.max(0, parents[i].length - Math.min(k, deepest)))
      out[it.path] = shown.join(sep) || sep
    })
  }
  return out
}

/* --------------------------------------------------------- folder switcher */

export interface ProjectLike {
  path: string
  name: string
  label: string | null
  exists: boolean
  pinned: boolean
  sessionCount: number
  lastModified: number | null
}

export interface HostLike {
  id: string
  label: string
  alias: string
}

export type FolderChoice =
  | {
      kind: 'project'
      path: string
      label: string
      /** The disambiguating parent path, or '' when the label is unique. */
      hint: string
      missing: boolean
      pinned: boolean
      lastModified: number | null
    }
  | { kind: 'default'; path: string; label: string }
  | { kind: 'scratch'; label: string }
  | { kind: 'open'; label: string }
  | { kind: 'host'; id: string; label: string; alias: string }

export interface FolderGroup {
  title: string
  items: FolderChoice[]
}

/** Pinned first, then most recently used. The order the launcher's list and the switcher share. */
export function rankProjects<T extends ProjectLike>(projects: readonly T[]): T[] {
  return [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastModified ?? 0) - (a.lastModified ?? 0)
  )
}

const hit = (q: string, ...fields: (string | null | undefined)[]): boolean =>
  fields.some((f) => !!f && f.toLowerCase().includes(q))

/**
 * Everything the folder switcher offers, grouped, filtered by `query`.
 *
 * With no query the recent list is capped (`limit`), because the switcher is
 * for getting back to something, not a second sidebar; with a query every
 * match is listed. "Open folder…" is always last and never filtered away: it is
 * the way out when nothing matches. `projects` should already be the
 * profile-scoped list (QA L18) — this function does no scoping of its own.
 */
export function folderChoices(input: {
  projects: readonly ProjectLike[]
  defaultCwd: string
  hosts: readonly HostLike[]
  query: string
  limit?: number
}): FolderGroup[] {
  const q = input.query.trim().toLowerCase()
  const ranked = rankProjects(input.projects)
  const hints = disambiguate(ranked.map((p) => ({ path: p.path, label: p.label ?? p.name })))
  const projects = ranked
    .filter((p) => !q || hit(q, p.label, p.name, p.path))
    .slice(0, q ? undefined : (input.limit ?? 8))
    .map(
      (p): FolderChoice => ({
        kind: 'project',
        path: p.path,
        label: p.label ?? p.name,
        hint: hints[p.path] ?? '',
        missing: !p.exists,
        pinned: p.pinned,
        lastModified: p.lastModified
      })
    )
  const places: FolderChoice[] = []
  if (input.defaultCwd && (!q || hit(q, 'default folder', input.defaultCwd))) {
    places.push({ kind: 'default', path: input.defaultCwd, label: 'Default folder' })
  }
  if (!q || hit(q, 'scratch session')) places.push({ kind: 'scratch', label: 'Scratch session' })
  const hosts = input.hosts
    .filter((h) => !q || hit(q, h.label, h.alias))
    .map((h): FolderChoice => ({ kind: 'host', id: h.id, label: h.label || h.alias, alias: h.alias }))

  const out: FolderGroup[] = []
  if (projects.length) out.push({ title: q ? 'Projects' : 'Recent projects', items: projects })
  if (places.length) out.push({ title: 'Elsewhere', items: places })
  if (hosts.length) out.push({ title: 'Remote machines', items: hosts })
  out.push({ title: '', items: [{ kind: 'open', label: 'Open folder…' }] })
  return out
}

/** The groups as one list, in display order — what the arrow keys walk. */
export function flatChoices(groups: readonly FolderGroup[]): FolderChoice[] {
  return groups.flatMap((g) => g.items)
}

/** A stable key for a choice, for React and for the active-descendant id. */
export function choiceKey(c: FolderChoice): string {
  switch (c.kind) {
    case 'project':
      return `p:${c.path}`
    case 'default':
      return `d:${c.path}`
    case 'host':
      return `h:${c.id}`
    default:
      return c.kind
  }
}

/* ----------------------------------------------------------- conversations */

export interface SessionLike {
  id: string
  title: string | null
  firstPrompt: string | null
  messageCount: number
  gitBranch?: string | null
}

export interface SessionView<T> {
  shown: T[]
  /** Matching rows not shown because the list is folded. */
  more: number
  /** Rows left out for having no messages, when they are hidden. */
  empty: number
  /** Every row that matched the filter (before folding). */
  matched: number
}

/**
 * Which conversations the launcher lists.
 *
 * Empty (0-message) sessions are hidden unless asked for — "Untitled session ·
 * 0 msgs" was taking one of only four slots (QA L12). The filter matches title,
 * first prompt and branch. `limit` folds the list; `all` unfolds it.
 */
export function sessionView<T extends SessionLike>(
  sessions: readonly T[],
  opts: { query: string; showEmpty: boolean; all: boolean; limit: number }
): SessionView<T> {
  const q = opts.query.trim().toLowerCase()
  const nonEmpty = opts.showEmpty ? sessions : sessions.filter((s) => s.messageCount > 0)
  const empty = sessions.length - nonEmpty.length
  const matched = q ? nonEmpty.filter((s) => hit(q, s.title, s.firstPrompt, s.gitBranch ?? null)) : nonEmpty
  const shown = opts.all ? matched : matched.slice(0, opts.limit)
  return { shown: [...shown], more: matched.length - shown.length, empty, matched: matched.length }
}

/** How a conversation row names itself. */
export function sessionTitle(s: { title: string | null; firstPrompt: string | null }): string {
  return s.title ?? s.firstPrompt ?? 'Untitled session'
}

/* ------------------------------------------------------------------ keys */

export type LauncherKeyAction =
  | { type: 'continue' }
  | { type: 'agents' }
  | { type: 'switcher' }
  | { type: 'openFolder' }
  | { type: 'resume'; index: number }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'filter'; char: string }
  | { type: 'escape' }
  /** A held Enter's repeats: swallowed, so a held key never starts a session. */
  | { type: 'swallow' }

export interface LauncherKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
}

/**
 * What a key pressed inside the launcher card does, or null to leave it alone
 * (Tab, Space and a plain Enter on a focused button keep their native meaning).
 *
 *   Cmd/Ctrl+Enter  Continue the latest conversation
 *   Alt+Enter       Open the agent menu on the Start button
 *   /               Open the folder switcher
 *   Cmd/Ctrl+O      Open a folder (the system dialog)
 *   1–9             Resume the Nth listed conversation
 *   Enter (filter)  Resume the top match
 *   ↓ / ↑           Move between Start and the conversation list
 *   a printable key Type into the conversation filter
 *   Esc             Clear the filter
 *
 * `inField` is true when focus is in a text input (the filter): there the
 * characters are the input's, and only the arrows, Enter chords and Escape
 * mean anything to the card. A repeated Enter is swallowed everywhere — the
 * repeats of a key held to get past the welcome splash must not press the Start
 * button that gets focus when the splash closes (QA L1).
 */
export function launcherKey(e: LauncherKeyEvent, ctx: { inField: boolean }): LauncherKeyAction | null {
  const mod = e.metaKey || e.ctrlKey
  if (e.key === 'Enter') {
    if (e.repeat) return { type: 'swallow' }
    if (mod && !e.altKey) return { type: 'continue' }
    if (e.altKey && !mod) return { type: 'agents' }
    // Typed a filter, pressed Enter: the top match is what was meant. The
    // input has no Enter of its own, so without this it did nothing at all.
    if (ctx.inField && !e.shiftKey) return { type: 'resume', index: 0 }
    return null
  }
  if (e.key === 'Escape') return { type: 'escape' }
  if (e.key === 'ArrowDown') return { type: 'move', delta: 1 }
  if (e.key === 'ArrowUp') return { type: 'move', delta: -1 }
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o') return { type: 'openFolder' }
  if (ctx.inField || mod || e.altKey) return null
  if (e.key === '/') return { type: 'switcher' }
  if (/^[1-9]$/.test(e.key)) return { type: 'resume', index: Number(e.key) - 1 }
  if (e.key.length === 1 && e.key !== ' ') return { type: 'filter', char: e.key }
  return null
}

/* ------------------------------------------------------ first-run picker */

/**
 * How the agent picker lays out its rows (QA L20): the agents on this machine
 * first, in picker order with Claude Code leading, and every other agent folded
 * under "More agents". Eighteen rows in fixed order put Grok (not installed)
 * between Codex and OpenCode (both installed), in 1,141px of scroll.
 *
 * While detection has not answered, nothing is known to be installed, so there
 * is one unsplit list rather than eighteen rows filed under "more".
 */
export function pickerSections<T extends string>(
  all: readonly T[],
  installed: ReadonlySet<T> | null
): { installed: T[]; more: T[] } {
  if (!installed) return { installed: [], more: [...all] }
  return {
    installed: all.filter((id) => installed.has(id)),
    more: all.filter((id) => !installed.has(id))
  }
}

/**
 * What "Select all" ticks: the installed agents, never the rest. It used to tick
 * all eighteen, which silently turned Continue into "Install 15 and continue" —
 * five of those vendor installs a `curl … | bash` nobody had read ("agent-picker-
 * select-all-hides-bulk-install"). An install now only ever comes from a row the
 * user ticked by hand, whose command is printed on it.
 *
 * `checked` is whether every installed agent is picked; `mixed` is some.
 */
export function selectAllInstalled<T extends string>(
  picked: ReadonlySet<T>,
  installed: readonly T[],
  locked: ReadonlySet<T>
): { checked: boolean; mixed: boolean; toggle: () => Set<T> } {
  const on = installed.filter((id) => picked.has(id))
  const checked = installed.length > 0 && on.length === installed.length
  const mixed = on.length > 0 && !checked
  return {
    checked,
    mixed,
    toggle: () => {
      const next = new Set(picked)
      for (const id of installed) {
        if (checked && !locked.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    }
  }
}
