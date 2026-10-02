/**
 * A folder's git state as the title bar shows it: the reading, how
 * `git status --porcelain=v2 --branch` is parsed into it, and what the chip says.
 *
 * Pure: main's `gitStatus.ts` runs git and hands the text here, and
 * `verify:git` holds the parse against real scratch repos (gotcha 78: relative
 * `.ts` imports only, no `node:`).
 *
 * Ahead/behind is as of the LAST FETCH. Stoke never fetches for this — a fetch
 * is network, can prompt for credentials, and is the owner's to run — so the
 * chip's tooltip says so rather than implying the remote was asked.
 */

export interface GitChanges {
  /** Paths with a change in the index (X of XY is not `.`), conflicts excluded. */
  staged: number
  /** Paths with a change in the work tree (Y is not `.`), conflicts excluded. */
  unstaged: number
  untracked: number
  /** Unmerged paths (`u` lines). */
  conflicts: number
}

export interface GitStatus {
  /** False for a folder in no repository: the chip draws nothing. */
  repo: boolean
  /** The work tree's top, when a repository was found. */
  root: string | null
  /** The checked-out branch; null when detached. */
  branch: string | null
  /** The commit, abbreviated; null on an unborn branch or when unknown. */
  oid: string | null
  detached: boolean
  /** A branch with no commits yet (`git init`, nothing committed). */
  unborn: boolean
  /** `origin/main`, or null for none. */
  upstream: string | null
  /** The upstream was set and is gone (deleted on the remote and pruned). */
  upstreamGone: boolean
  /** As of the last fetch. Null with no upstream, or when git did not answer. */
  ahead: number | null
  behind: number | null
  /**
   * Null when unknown — git missing, too slow, refused. Never a stale or guessed
   * zero: "clean" is a claim, and a chip that says it on a timeout lies.
   */
  changes: GitChanges | null
  /** A linked worktree (`git worktree add`): the main work tree's top, and this one's name. */
  worktree: { main: string; name: string } | null
  /** Why `changes` is null, in a sentence; null when it is known or there is no repo. */
  error: string | null
  /** When this reading was taken, epoch ms. */
  at: number
}

export const NO_REPO: Omit<GitStatus, 'at'> = {
  repo: false,
  root: null,
  branch: null,
  oid: null,
  detached: false,
  unborn: false,
  upstream: null,
  upstreamGone: false,
  ahead: null,
  behind: null,
  changes: null,
  worktree: null,
  error: null
}

/** What `git status --porcelain=v2 --branch` (no `-z`) says, before anything is merged into a reading. */
export interface StatusV2 {
  oid: string | null
  unborn: boolean
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  changes: GitChanges
}

/**
 * Parse porcelain v2 with branch headers.
 *
 * Headers: `# branch.oid <sha>|(initial)`, `# branch.head <name>|(detached)`,
 * `# branch.upstream <ref>`, `# branch.ab +A -B` (absent when the upstream is
 * gone). Entries: `1`/`2` changed or renamed with `XY` second, `u` unmerged,
 * `?` untracked, `!` ignored (not asked for). Paths are never read: a path
 * with a newline is C-quoted on its one line without `-z`.
 */
export function parseStatusV2(text: string): StatusV2 {
  const out: StatusV2 = {
    oid: null,
    unborn: false,
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        if (value === '(initial)') out.unborn = true
        else out.oid = value.slice(0, 7) || null
      } else if (key === 'branch.head') {
        if (value === '(detached)') out.detached = true
        else out.branch = value || null
      } else if (key === 'branch.upstream') {
        out.upstream = value || null
      } else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          out.ahead = Number(m[1])
          out.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = line[0]
    if (kind === '?') out.changes.untracked++
    else if (kind === 'u') out.changes.conflicts++
    else if (kind === '1' || kind === '2') {
      const xy = line.slice(2, 4)
      if (xy[0] && xy[0] !== '.') out.changes.staged++
      if (xy[1] && xy[1] !== '.') out.changes.unstaged++
    }
  }
  return out
}

/** Total changed paths: a path both staged and modified counts once per side, as `git status` lists it. */
export function changeCount(c: GitChanges): number {
  return c.staged + c.unstaged + c.untracked + c.conflicts
}

/**
 * The `-c` overrides that keep `git status` from running a repo's OWN filter
 * commands (gotcha 147), from `git config --null --show-scope --name-only
 * --get-regexp '^filter\.'` output (`scope NUL key NUL` pairs).
 *
 * A clean filter runs on every stat-dirty file `git status` re-hashes — measured
 * with git 2.55: a repo's `filter.x.clean` touching a marker made the marker on
 * a plain status after a `touch`, with fsmonitor off and optional locks off. A
 * folder Stoke merely shows a tab in may be an unpacked archive whose
 * `.git/config` nobody has read, so a poll must run none of its commands.
 * Filters from the user's own `system`/`global` config (git-lfs) are left on —
 * they are the user's, and turning LFS off would show every touched LFS file
 * as changed. Anything from the repo (`local`, `worktree`) or a scope this
 * code does not know is emptied: `filter.<name>.clean=` and `.process=` with
 * `required=false`, which measured as running nothing.
 *
 * Null when a name cannot be passed safely as `-c key=value` (git splits at
 * the first `=`): the caller then reports "unknown" rather than run status.
 */
export function filterOverrides(configOutput: string): string[] | null {
  const parts = configOutput.split('\0')
  const names = new Set<string>()
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]
    const key = parts[i + 1]
    if (!key.toLowerCase().startsWith('filter.')) continue
    if (scope === 'system' || scope === 'global') continue
    const dot = key.lastIndexOf('.')
    if (dot <= 'filter.'.length) continue
    const name = key.slice('filter.'.length, dot)
    if (/[=\n\r\0]/.test(name)) return null
    names.add(name)
  }
  const args: string[] = []
  for (const name of names) {
    args.push('-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`)
  }
  return args
}

/**
 * A HEAD file: `ref: refs/heads/<branch>` is that branch; a bare sha is a
 * detached HEAD. The fallback when git cannot be run — the branch is still
 * known, the changes are not.
 */
export function parseHead(text: string): { branch: string | null; oid: string | null; detached: boolean } {
  const t = text.trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(t)
  if (ref) return { branch: ref[1], oid: null, detached: false }
  if (/^[0-9a-f]{40,64}$/i.test(t)) return { branch: null, oid: t.slice(0, 7), detached: true }
  return { branch: null, oid: null, detached: false }
}

/** How old a reading may be and still be shown as known. Three missed polls. */
export const GIT_STALE_MS = 30_000

/**
 * The reading as the chip may show it at `now`: past `GIT_STALE_MS` its changes
 * and ahead/behind are unknown until the next reading lands — never the old
 * numbers, and never a remembered "clean".
 */
export function shownGitStatus(s: GitStatus | null, now: number): GitStatus | null {
  if (!s || !s.repo || now - s.at <= GIT_STALE_MS) return s
  return { ...s, changes: null, ahead: null, behind: null, error: 'looking again' }
}

/* --------------------------------------------------------- what the chip says */

export interface GitChip {
  /** The branch, or the detached commit. */
  head: string
  /** Changed paths, or null when unknown (drawn as "…"), 0 when clean. */
  changes: number | null
  ahead: number | null
  behind: number | null
  /** "worktree" tag text, or null. */
  worktree: string | null
  title: string
}

/**
 * The chip for a reading, or null to draw nothing (no repository). The
 * tooltip states each part in words, and says that ahead/behind is as of the
 * last fetch and that Stoke does not fetch.
 */
export function gitChip(s: GitStatus | null): GitChip | null {
  if (!s || !s.repo) return null
  const head = s.detached ? (s.oid ?? 'detached') : (s.branch ?? (s.oid ?? 'HEAD'))
  const lines: string[] = []
  lines.push(
    s.detached
      ? `Detached at ${s.oid ?? 'an unknown commit'}`
      : s.unborn
        ? `On ${s.branch ?? 'a new branch'}, no commits yet`
        : `On ${s.branch ?? 'an unknown branch'}`
  )
  if (s.changes) {
    const c = s.changes
    const n = changeCount(c)
    if (n === 0) lines.push('No changes')
    else {
      const bits: string[] = []
      if (c.staged) bits.push(`${c.staged} staged`)
      if (c.unstaged) bits.push(`${c.unstaged} modified`)
      if (c.untracked) bits.push(`${c.untracked} untracked`)
      if (c.conflicts) bits.push(`${c.conflicts} conflicted`)
      lines.push(bits.join(', '))
    }
  } else {
    lines.push(`Changes unknown${s.error ? `: ${s.error}` : ''}`)
  }
  if (s.upstreamGone) lines.push(`Its upstream ${s.upstream ?? ''} is gone`.trimEnd())
  else if (s.upstream && s.ahead !== null && s.behind !== null) {
    lines.push(`${s.ahead} ahead, ${s.behind} behind ${s.upstream}, as of your last fetch (Stoke does not fetch)`)
  } else if (!s.upstream && !s.detached && !s.unborn) lines.push('No upstream branch')
  if (s.worktree) lines.push(`A linked worktree of ${s.worktree.main}`)
  if (s.root) lines.push(s.root)
  return {
    head,
    changes: s.changes ? changeCount(s.changes) : null,
    ahead: s.upstream && !s.upstreamGone ? s.ahead : null,
    behind: s.upstream && !s.upstreamGone ? s.behind : null,
    worktree: s.worktree ? 'worktree' : null,
    title: lines.join('\n')
  }
}
