/**
 * Project and session search: one pure matcher, called by the sidebar's search
 * box and by the command palette alike.
 *
 * It exists as one function because there were two, and they disagreed. The
 * sidebar matched a project's name, path and label; the palette's `score()`
 * matched name and path and never looked at the label — so a folder renamed
 * "Client site" was found by the sidebar under that name and not by Cmd+K,
 * which also went on displaying the basename the user had renamed away from.
 * Two copies of "what does this query match" is how that happens; there is one.
 *
 * The sidebar also searches sessions: every session's title and first prompt,
 * across every project, from the index main builds (`sessionIndex.ts`). The
 * palette stays project-only and passes no index.
 *
 * No runtime imports, on purpose: `scripts/verify-search.mts` imports this file
 * directly under node's strip-types mode, which erases `import type` and can do
 * nothing with anything else.
 */
import type { Project, SessionIndexEntry } from '@shared/types'

/** Half-open `[start, end)`, in UTF-16 code units of the text as displayed. */
export type Range = readonly [start: number, end: number]

/** Some text to show, and which parts of it to highlight. */
export interface Snippet {
  text: string
  ranges: Range[]
}

export type MatchedBy = 'label' | 'name' | 'title' | 'path' | 'prompt' | 'subsequence'

/**
 * How good a match is, best first. A project ranks by the best of its own match
 * and its best session's.
 *
 * The order is the order of intent. A project's own name is the thing people
 * type; a session title is Claude's one-line summary of a conversation, which
 * is specific and short; a path matches every folder under a common parent, so
 * it is weak; a first prompt is long free text and matches almost anything,
 * so it is weaker still. `subsequence` is the palette's "hrth finds stoke" and
 * the sidebar never uses it.
 */
export const TIERS = {
  namePrefix: 6,
  name: 5,
  title: 4,
  path: 3,
  prompt: 2,
  subsequence: 1
} as const

export interface SessionHit {
  session: SessionIndexEntry
  /** Which field matched. A title match wins when both would. */
  field: 'title' | 'prompt'
  /**
   * The row's title line: the session's title — or, for a session Claude has
   * not titled, its first prompt, windowed so the hit is on screen.
   */
  label: Snippet
  /**
   * A second line quoting the first prompt around the hit, for a titled
   * session that matched only in its prompt — otherwise nothing on the row
   * would say why it is there.
   */
  detail: Snippet | null
}

export interface ProjectHit {
  project: Project
  /** One of `TIERS`; 0 only when the query is empty and everything is listed. */
  score: number
  /** The field that decided `score`, or null for the empty query. */
  matchedBy: MatchedBy | null
  /** Ranges in the name the row displays — `project.label ?? project.name`. */
  nameRanges: Range[]
  /**
   * Ranges in `project.path`, whenever the path matched. The sidebar shows the
   * path when the displayed name has nothing to highlight — a match on a
   * basename hidden behind a label, say — since the basename is in the path.
   */
  pathRanges: Range[]
  /** Only the sessions that matched, best tier first, newest first within it. */
  sessions: SessionHit[]
}

/* ------------------------------------------------------------------ folding */

/**
 * A folded copy of some text — lower-cased, diacritics stripped — and where
 * each folded code unit came from in the original, so a match found in the
 * fold can be highlighted in the text the user actually sees. `from`/`to` are
 * null for plain ASCII, where folding moves nothing and the mapping is the
 * identity.
 */
interface Folded {
  text: string
  from: number[] | null
  to: number[] | null
}

const ASCII = /^[\u0000-\u007f]*$/

function foldChar(ch: string): string {
  return (
    ch
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      // Recompose what NFD split apart that was not an accent — Hangul
      // syllables decompose into jamo, which are letters, not marks.
      .normalize('NFC')
      // Per-character lower-casing cannot know a sigma is word-final, so a
      // query typed with ς would never meet a folded σ. Fold both to one.
      .replace(/ς/g, 'σ')
  )
}

/** Exported for the suite; everything else goes through the cached `folded`. */
export function fold(text: string): Folded {
  if (ASCII.test(text)) return { text: text.toLowerCase(), from: null, to: null }
  let out = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  /* Where the previous character's folded units begin in `from`/`to`. */
  let prev = -1
  for (const ch of text) {
    const next = at + ch.length
    const f = foldChar(ch)
    if (f === '') {
      /*
       * A combining mark on its own — text that arrived decomposed. It has
       * nothing to match, but it belongs to the character before it, so a
       * highlight of that character must take the accent along rather than
       * cutting the glyph in half.
       */
      if (prev >= 0) for (let k = prev; k < to.length; k++) to[k] = next
    } else {
      prev = to.length
      for (let k = 0; k < f.length; k++) {
        from.push(at)
        to.push(next)
      }
      out += f
    }
    at = next
  }
  return { text: out, from, to }
}

/*
 * Folding is the expensive part — every title and prompt, per character — and
 * the index does not change between keystrokes, so each string is folded once
 * per object that carries it. Keyed weakly, so a refetched index or project
 * list takes its cache with it, and checked against the source text, so a
 * reused object with a different string can never answer with a stale fold.
 */
const folds = new WeakMap<object, Map<string, { source: string; folded: Folded }>>()

function folded(owner: object, key: string, text: string): Folded {
  let byKey = folds.get(owner)
  if (!byKey) {
    byKey = new Map()
    folds.set(owner, byKey)
  }
  const hit = byKey.get(key)
  if (hit && hit.source === text) return hit.folded
  const f = fold(text)
  byKey.set(key, { source: text, folded: f })
  return f
}

/** The query as folded words. Every word must appear in the same field. */
export function queryWords(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((w) => fold(w).text)
    .filter((w) => w.length > 0)
}

/**
 * Where every word lands in `f`, as ranges in the ORIGINAL text, or null when
 * any word is missing. The first occurrence of each word; overlapping and
 * touching ranges merged, so two words that meet highlight as one run.
 */
function locate(f: Folded, words: readonly string[]): Range[] | null {
  const found: [number, number][] = []
  for (const w of words) {
    const at = f.text.indexOf(w)
    if (at < 0) return null
    const end = at + w.length
    found.push(f.from && f.to ? [f.from[at], f.to[end - 1]] : [at, end])
  }
  return merge(found)
}

function merge(ranges: [number, number][]): Range[] {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = []
  for (const r of ranges) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/**
 * Where `query` matches `text`, as highlight ranges in `text`; null when it
 * does not; empty for a query with no words in it.
 */
export function matchRanges(text: string, query: string): Range[] | null {
  const words = queryWords(query)
  if (words.length === 0) return []
  return locate(fold(text), words)
}

/**
 * How many characters of context a snippet keeps in front of its first hit.
 *
 * Sized for the narrowest row the hit has to be visible in, not for reading
 * comfort. At the sidebar's 200px minimum a session row's 13px title line holds
 * about 22 characters before its CSS ellipsis. The first value, 24, spent all of
 * them on context: an untitled session whose prompt read "…sure it's hosted on
 * my CloudFlo tunnel?" painted its "CloudFlo" mark at x=180 of a line that ends
 * at x=183, so the row showed a match with the match itself cut off. The 11px
 * metadata line did the same to a basename hidden behind a label: "Laro" in
 * "/Users/thevinh/dev/work/Laro" painted at x=173-196 of a line ending at 182.
 * Both measured over CDP. At 12 the hit starts at most 13 characters in,
 * leaving about nine characters of it on screen at the minimum width and all of
 * it at the default one.
 */
export const SNIPPET_LEAD = 12

/**
 * A window of `text` that starts a little before the first hit, so a match at
 * character 200 of a 300-character prompt is not ellipsised off the end of a
 * one-line row. Starts on a word (or path segment) boundary when there is one
 * inside the lead-in, marks each cut end with `…`, and shifts the ranges to
 * match. Text whose first hit is already near the start comes back whole.
 */
export function snippet(
  text: string,
  ranges: readonly Range[],
  before = SNIPPET_LEAD,
  max = 160
): Snippet {
  const first = ranges[0]
  let start = 0
  if (first && first[0] > before) {
    start = first[0] - before
    const brk = text.slice(start, first[0]).search(/[\s/\\][^\s/\\]/)
    if (brk >= 0) start += brk + 1
    else if (isLowSurrogate(text.charCodeAt(start))) start++
  }
  let end = Math.min(text.length, start + max)
  if (first && end < first[1]) end = first[1]
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--

  const lead = start > 0 ? '…' : ''
  const trail = end < text.length ? '…' : ''
  const shift = lead.length - start
  const out: [number, number][] = []
  for (const [s, e] of ranges) {
    const a = Math.max(s, start)
    const b = Math.min(e, end)
    if (a < b) out.push([a + shift, b + shift])
  }
  return { text: lead + text.slice(start, end) + trail, ranges: out }
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}

/* ------------------------------------------------------------------ matching */

interface OwnMatch {
  tier: number
  matchedBy: MatchedBy
  nameRanges: Range[]
  pathRanges: Range[]
}

function nameTier(f: Folded, words: readonly string[]): number {
  return f.text.startsWith(words[0]) ? TIERS.namePrefix : TIERS.name
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) {
    if (needle.startsWith(ch, i)) i += ch.length
    if (i >= needle.length) return true
  }
  return needle.length === 0
}

/** The project's own fields: label, name, path — and, for the palette only, a subsequence. */
function matchProject(project: Project, words: readonly string[], subsequence: boolean): OwnMatch | null {
  const labelF = project.label ? folded(project, 'label', project.label) : null
  const nameF = folded(project, 'name', project.name)
  const pathF = folded(project, 'path', project.path)

  const labelR = labelF ? locate(labelF, words) : null
  const nameR = locate(nameF, words)
  const pathR = locate(pathF, words)

  const labelT = labelF && labelR ? nameTier(labelF, words) : 0
  const nameT = nameR ? nameTier(nameF, words) : 0
  const pathT = pathR ? TIERS.path : 0

  // The row displays the label when there is one, so only its ranges can be drawn.
  const nameRanges = (project.label ? labelR : nameR) ?? []
  const pathRanges = pathR ?? []

  if (labelT || nameT || pathT) {
    const tier = Math.max(labelT, nameT, pathT)
    const matchedBy: MatchedBy = labelT === tier ? 'label' : nameT === tier ? 'name' : 'path'
    return { tier, matchedBy, nameRanges, pathRanges }
  }

  if (subsequence) {
    const joined = words.join('')
    const shown = labelF ?? nameF
    if (isSubsequence(joined, shown.text) || isSubsequence(joined, nameF.text)) {
      return { tier: TIERS.subsequence, matchedBy: 'subsequence', nameRanges: [], pathRanges: [] }
    }
  }
  return null
}

function fieldTier(field: SessionHit['field']): number {
  return field === 'title' ? TIERS.title : TIERS.prompt
}

function matchSessions(entries: readonly SessionIndexEntry[], words: readonly string[]): SessionHit[] {
  const out: SessionHit[] = []
  for (const s of entries) {
    const titleR = s.title ? locate(folded(s, 'title', s.title), words) : null
    if (s.title && titleR) {
      out.push({ session: s, field: 'title', label: { text: s.title, ranges: titleR }, detail: null })
      continue
    }
    const promptR = s.firstPrompt ? locate(folded(s, 'prompt', s.firstPrompt), words) : null
    if (!s.firstPrompt || !promptR) continue
    out.push(
      s.title
        ? {
            session: s,
            field: 'prompt',
            label: { text: s.title, ranges: [] },
            detail: snippet(s.firstPrompt, promptR)
          }
        : { session: s, field: 'prompt', label: snippet(s.firstPrompt, promptR), detail: null }
    )
  }
  return out.sort(
    (a, b) => fieldTier(b.field) - fieldTier(a.field) || b.session.modified - a.session.modified
  )
}

/* The index grouped by project, once per index array rather than per keystroke. */
const grouped = new WeakMap<readonly SessionIndexEntry[], Map<string, SessionIndexEntry[]>>()

function byProject(index: readonly SessionIndexEntry[]): Map<string, SessionIndexEntry[]> {
  let map = grouped.get(index)
  if (!map) {
    map = new Map()
    for (const s of index) {
      const list = map.get(s.projectPath)
      if (list) list.push(s)
      else map.set(s.projectPath, [s])
    }
    grouped.set(index, map)
  }
  return map
}

export interface SearchOptions {
  /** Also match a name that holds the query's letters in order. The palette's, not the sidebar's. */
  subsequence?: boolean
}

/**
 * Every project that matches `query` — by its own label, name or path, or by
 * any of its sessions' titles or first prompts in `index` — ranked.
 *
 * Ranked by `TIERS`, then by recency: the project's own last activity when its
 * own field decided the rank, the newest matching session's when a session
 * did. So of two projects that match only through a session, the one whose
 * matching conversation is newer comes first, however busy the other is.
 *
 * Sessions whose project is not in `projects` are never returned — a project
 * hidden since the index was fetched stays hidden. An empty query returns every
 * project, in the order given, with nothing highlighted and no sessions.
 */
export function searchProjects(
  projects: readonly Project[],
  index: readonly SessionIndexEntry[],
  query: string,
  opts: SearchOptions = {}
): ProjectHit[] {
  const words = queryWords(query)
  if (words.length === 0) {
    return projects.map((project) => ({
      project,
      score: 0,
      matchedBy: null,
      nameRanges: [],
      pathRanges: [],
      sessions: []
    }))
  }

  const sessionsOf = byProject(index)
  const ranked: { hit: ProjectHit; recency: number; shown: string }[] = []
  for (const project of projects) {
    const own = matchProject(project, words, opts.subsequence === true)
    const sessions = matchSessions(sessionsOf.get(project.path) ?? [], words)
    const ownTier = own?.tier ?? 0
    const sessionTier = sessions.length ? fieldTier(sessions[0].field) : 0
    if (!ownTier && !sessionTier) continue

    const bySession = sessionTier > ownTier
    ranked.push({
      hit: {
        project,
        score: Math.max(ownTier, sessionTier),
        matchedBy: bySession ? sessions[0].field : (own?.matchedBy ?? null),
        nameRanges: own?.nameRanges ?? [],
        pathRanges: own?.pathRanges ?? [],
        sessions
      },
      recency: bySession ? sessions[0].session.modified : (project.lastModified ?? 0),
      shown: project.label ?? project.name
    })
  }

  ranked.sort(
    (a, b) =>
      b.hit.score - a.hit.score ||
      b.recency - a.recency ||
      a.shown.localeCompare(b.shown) ||
      a.hit.project.path.localeCompare(b.hit.project.path)
  )
  return ranked.map((r) => r.hit)
}

/** The palette's list: projects only, fuzzy as a last resort, at most `PALETTE_LIMIT`. */
export const PALETTE_LIMIT = 40
const NO_SESSIONS: readonly SessionIndexEntry[] = []

export function rankForPalette(projects: readonly Project[], query: string): ProjectHit[] {
  return searchProjects(projects, NO_SESSIONS, query, { subsequence: true }).slice(0, PALETTE_LIMIT)
}

/**
 * The projects the sidebar considers, before any matching.
 *
 * A query reaches across every profile on purpose. The profile narrows what you
 * browse; it must never hide something you went looking for by name — it is a
 * view, not a permission. So `inScope` applies only while the query is empty.
 */
export function scopeProjects(
  projects: readonly Project[],
  query: string,
  inScope: ((p: Project) => boolean) | null
): readonly Project[] {
  if (query.trim() || !inScope) return projects
  return projects.filter(inScope)
}

/**
 * Whether the session index has yet to arrive for the first time, so a search
 * has not looked at a single session: say "Searching sessions…", and never
 * "Nothing matches".
 *
 * "Not loading and no error" is not idle here. The first fetch is started by an
 * effect in App, and React paints the render that first shows a query BEFORE
 * effects run — so for one frame the index is null, nothing is loading and
 * nothing has failed. Keyed on `loading` alone, that frame said "Nothing
 * matches “q” in … session titles or first prompts" about conversations nobody
 * had read yet. Measured over CDP on the first search of a run: the claim was
 * painted 5.5 ms after the keystroke and replaced by "Searching sessions…" at
 * 10.5 ms. A failed fetch is not pending — the sidebar says why instead — but a
 * retry after one is.
 */
export function indexPending(
  index: readonly unknown[] | null,
  loading: boolean,
  error: string | null
): boolean {
  return index === null && (loading || error === null)
}

/** How many matching sessions a project shows before "Show N more". */
export const SESSION_CAP = 5

export function capSessions<T>(
  sessions: readonly T[],
  showAll: boolean,
  cap = SESSION_CAP
): { shown: readonly T[]; hidden: number } {
  if (showAll || sessions.length <= cap) return { shown: sessions, hidden: 0 }
  return { shown: sessions.slice(0, cap), hidden: sessions.length - cap }
}
