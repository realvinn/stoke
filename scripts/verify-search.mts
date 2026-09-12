/*
 * Search: what the sidebar's search box and the command palette match, how they
 * rank it and what they highlight — and the session index main builds for the
 * sidebar, read from real transcript files in a temp directory.
 *
 * The matcher is one pure module both surfaces call (`projectSearch.ts`). It
 * exists because there were two, and the palette's never read the label, so a
 * renamed folder was findable in one and not the other; the first section here
 * pins that it is found in both.
 *
 * The index is the half no pure assertion can stand in for. Its whole point is
 * what it does NOT read — a 40 MB transcript must cost two 256 KB reads, a
 * second pass must cost nothing, and a subagent's transcript must never become
 * a searchable session — so those are asserted against files on disk, with the
 * byte count taken from the reads themselves.
 *
 *   node scripts/verify-search.mts
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, SessionIndexEntry } from '../src/shared/types.ts'
import {
  capSessions,
  fold,
  indexPending,
  matchRanges,
  rankForPalette,
  scopeProjects,
  searchProjects,
  SESSION_CAP,
  snippet,
  SNIPPET_LEAD,
  TIERS
} from '../src/renderer/src/lib/projectSearch.ts'
import type { Range } from '../src/renderer/src/lib/projectSearch.ts'
import { createSessionIndexCache, indexSessions } from '../src/main/sessionIndex.ts'
import type { SessionIndexStats } from '../src/main/sessionIndex.ts'
import { CHUNK, parseSession } from '../src/main/sessionFile.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/** The highlighted substrings, which is what a reader of the row actually sees. */
function marked(text: string, ranges: readonly Range[] | null): string[] | null {
  return ranges ? ranges.map(([s, e]) => text.slice(s, e)) : null
}

function project(path: string, extra: Partial<Project> = {}): Project {
  const parts = path.split('/')
  return {
    path,
    name: parts[parts.length - 1],
    group: parts[parts.length - 2] ?? '',
    encodedDir: null,
    sessionCount: 0,
    lastModified: null,
    lastCost: null,
    lastPrompt: null,
    exists: true,
    pinned: false,
    emoji: null,
    label: null,
    addedManually: false,
    ...extra
  }
}

function session(
  projectPath: string,
  id: string,
  title: string | null,
  firstPrompt: string | null,
  modified: number
): SessionIndexEntry {
  return { id, projectPath, title, firstPrompt, modified }
}

const now = Date.UTC(2026, 8, 11, 12)
const hour = 3_600_000
const paths = (hits: { project: Project }[]): string[] => hits.map((h) => h.project.path)

/* ---------------------------------------------------------------- highlights */

console.log('\nhighlight ranges land on the text as displayed')
check('a prefix', matchRanges('Stoke', 'sto'), [[0, 3]])
check('case never matters', matchRanges('STOKE', 'stoke'), [[0, 5]])
check('a hit that ends the string ends exactly at its length', matchRanges('my-stoke', 'stoke'), [[3, 8]])
check('no hit is null, not an empty list', matchRanges('stoke', 'xyz'), null)
check('a query with no words in it highlights nothing', matchRanges('stoke', '   '), [])
check('diacritics fold away', fold('Résumé').text, 'resume')
{
  const t = 'Café Résumé'
  check('a plain query finds accented text', marked(t, matchRanges(t, 'resume')), ['Résumé'])
  check('an accented query finds plain text', matchRanges('cafe', 'CAFÉ'), [[0, 4]])
}
{
  const t = 'Déjà vu, café'
  const r = matchRanges(t, 'cafe')
  check('an accented hit at the very end of the string', marked(t, r), ['café'])
  check('...and its range ends at the string length', r?.[0]?.[1], t.length)
}
{
  // Text that arrived decomposed: "e" + U+0301. The accent is its own code unit
  // and must go with the letter, or the highlight splits one glyph in two.
  const t = 'Cafe\u0301 society'
  check('the fixture really is decomposed', t.length, 13)
  check('a decomposed accent is highlighted with its letter', matchRanges(t, 'cafe'), [[0, 5]])
}
check('an emoji before the hit shifts it by two code units', matchRanges('🔥 stoke', 'stoke'), [[3, 8]])
check('a dotted capital I folds to i', matchRanges('İstanbul', 'istanbul'), [[0, 8]])
check('a final sigma matches a medial one', matchRanges('ΟΔΥΣΣΕΥΣ', 'οδυσσευς'), [[0, 8]])
{
  const t = 'Fix the auth bug'
  check('every word, in any order, each marked', marked(t, matchRanges(t, 'bug auth')), [
    'auth',
    'bug'
  ])
  check('one missing word means no match at all', matchRanges(t, 'auth login'), null)
  check('words that touch merge into one mark', matchRanges('authbug', 'auth bug'), [[0, 7]])
}

console.log('\nsnippets keep the hit on screen')
check('a hit near the start leaves the text whole', snippet('hello world', [[6, 11]]), {
  text: 'hello world',
  ranges: [[6, 11]]
})
{
  const t = 'We need to look at the way the application handles the database migration step'
  const s = snippet(t, matchRanges(t, 'database') ?? [])
  check('a hit deep in the text is windowed with a leading ellipsis', s.text.startsWith('…'), true)
  check('...and the window starts on a word, not inside one', t.includes(` ${s.text.slice(1)}`), true)
  check('...and the ranges move with it', marked(s.text, s.ranges), ['database'])
}
{
  const p = '/Users/me/dev/personal/clients/stoke'
  const s = snippet(p, matchRanges(p, 'stoke') ?? [])
  check('a path is cut at a separator', p.includes(`/${s.text.slice(1)}`), true)
  check('...and still marks the hit', marked(s.text, s.ranges), ['stoke'])
}
{
  // A real untitled session's prompt. At the sidebar's 200px minimum its 13px
  // title line holds ~22 characters, and the first lead-in (24) painted the
  // "CloudFlo" mark at x=180 of a line ending at x=183 — a row showing a match
  // with the match cut off by its own ellipsis.
  const t = "Can you make sure it's hosted on my CloudFlo tunnel?"
  const s = snippet(t, matchRanges(t, 'cloudflo') ?? [])
  const NARROWEST_ROW_CHARS = 22
  check(
    `the whole hit sits inside the ${NARROWEST_ROW_CHARS} characters the narrowest row shows`,
    (s.ranges[0]?.[1] ?? Infinity) <= NARROWEST_ROW_CHARS,
    true
  )
  check('...which the lead-in guarantees for a word of nine', SNIPPET_LEAD + 1 + 9 <= NARROWEST_ROW_CHARS, true)
  check('...still starting on a word', s.text, '…on my CloudFlo tunnel?')
  const p = '/Users/me/dev/work/Laro'
  check(
    'a path behind a label keeps its hit in the narrow metadata line too',
    snippet(p, matchRanges(p, 'laro') ?? []).text,
    '…dev/work/Laro'
  )
}
{
  const t = `${'lead '.repeat(6)}needle ${'tail '.repeat(80)}`
  const s = snippet(t, matchRanges(t, 'needle') ?? [])
  check('a long text is cut at the end too', s.text.endsWith('…'), true)
  check('...within its bound', s.text.length <= 162, true)
}

/* -------------------------------------------------------------- the palette */

const client = project('/dev/work/www', {
  label: 'Client site',
  lastModified: now - 5 * hour,
  sessionCount: 2
})
const stoke = project('/dev/personal/stoke', { lastModified: now - 1 * hour, sessionCount: 4 })
const alpha = project('/dev/personal/alpha', { lastModified: now - 2 * hour, sessionCount: 3 })

console.log('\nthe label is matched by both surfaces')
{
  const hits = searchProjects([stoke, client], [], 'client')
  check('the sidebar finds a folder by its label', paths(hits), [client.path])
  check('...says the label decided it', hits[0]?.matchedBy, 'label')
  check('...and marks the label it displays', marked('Client site', hits[0]?.nameRanges ?? null), [
    'Client'
  ])
  check('a two-word label matches both words', paths(searchProjects([client], [], 'site client')), [
    client.path
  ])
}
{
  // The bug: the palette's own score() read name and path only.
  const hits = rankForPalette([stoke, client], 'client')
  check('the palette finds a folder by its label', paths(hits), [client.path])
  check('...and marks the label, which is what it now displays', hits[0]?.nameRanges, [[0, 6]])
}
{
  const hits = rankForPalette([stoke, client], 'www')
  check('a basename hidden behind a label is still found', paths(hits), [client.path])
  check('...with nothing to mark in the label shown', hits[0]?.nameRanges, [])
  check('...so the path carries the mark', marked(client.path, hits[0]?.pathRanges ?? null), ['www'])
}
check(
  'the palette keeps its subsequence match, as the lowest tier',
  rankForPalette([alpha, stoke], 'stk').map((h) => [h.project.path, h.matchedBy, h.score]),
  [[stoke.path, 'subsequence', TIERS.subsequence]]
)
check('the sidebar does not do subsequence matching', searchProjects([stoke], [], 'stk'), [])
check(
  'an empty palette query lists every project in the order given',
  paths(rankForPalette([stoke, client, alpha], '')),
  [stoke.path, client.path, alpha.path]
)

/* ---------------------------------------------------------------- sessions */

console.log('\nsessions: a title match lists only the sessions that matched')
const alphaIndex = [
  session(alpha.path, 'a1', 'Fix OAuth refresh', 'the token expires after an hour', now - 3 * hour),
  session(alpha.path, 'a2', 'Tidy the README', 'docs pass', now - 4 * hour),
  session(alpha.path, 'a3', null, 'something unrelated', now - 5 * hour)
]
{
  const hits = searchProjects([stoke, alpha], alphaIndex, 'oauth')
  check('the project with the matching session is listed', paths(hits), [alpha.path])
  check('...because of a title', [hits[0]?.matchedBy, hits[0]?.score], ['title', TIERS.title])
  check('...with only the session that matched', hits[0]?.sessions.map((s) => s.session.id), ['a1'])
  check(
    '...its title marked',
    marked(hits[0]?.sessions[0]?.label.text ?? '', hits[0]?.sessions[0]?.label.ranges ?? null),
    ['OAuth']
  )
  check('...and no second line, since the title says why', hits[0]?.sessions[0]?.detail, null)
  check('...and nothing marked in a project name that did not match', hits[0]?.nameRanges, [])
}
check(
  'a project matched by name still lists its matching sessions',
  searchProjects(
    [stoke],
    [session(stoke.path, 's1', 'Stoke release notes', 'x', now - hour)],
    'stoke'
  ).map((h) => [h.matchedBy, h.sessions.map((s) => s.session.id)]),
  [['name', ['s1']]]
)
check(
  'a session whose project is not listed (hidden since) never surfaces',
  searchProjects([alpha], [session('/dev/secret/hidden', 'h1', 'OAuth secrets', null, now)], 'oauth'),
  []
)

console.log('\nsessions: the first prompt is the fallback')
const beta = project('/dev/personal/beta', { lastModified: now - 2 * hour })
const betaIndex = [
  session(beta.path, 'b1', null, 'please migrate the database schema to v2', now - 1 * hour),
  session(
    beta.path,
    'b2',
    'Schema work',
    'Write a migration for the users table and then backfill the database from the legacy import',
    now - 2 * hour
  ),
  session(beta.path, 'b3', 'Database indexes', 'speed up the slow query', now - 10 * hour)
]
{
  const hits = searchProjects([beta], betaIndex, 'database')
  const byId = new Map(hits[0]?.sessions.map((s) => [s.session.id, s]) ?? [])
  check(
    'a title match ranks above newer prompt matches; prompt matches newest first',
    hits[0]?.sessions.map((s) => [s.session.id, s.field]),
    [
      ['b3', 'title'],
      ['b1', 'prompt'],
      ['b2', 'prompt']
    ]
  )
  const b1 = byId.get('b1')
  check(
    'an untitled session shows its prompt as the title line, marked',
    marked(b1?.label.text ?? '', b1?.label.ranges ?? null),
    ['database']
  )
  check('...with no second line', b1?.detail, null)
  const b2 = byId.get('b2')
  check('a titled session matched only in its prompt keeps its title, unmarked', b2?.label, {
    text: 'Schema work',
    ranges: []
  })
  check(
    '...and quotes the prompt around the hit on a second line',
    marked(b2?.detail?.text ?? '', b2?.detail?.ranges ?? null),
    ['database']
  )
  check('...windowed, because the hit is deep in it', b2?.detail?.text.startsWith('…'), true)
}

console.log('\nmulti-word queries need every word in ONE field')
check('both words in the title', searchProjects([alpha], alphaIndex, 'refresh oauth').length, 1)
check(
  'one word in the title and the other in the prompt is not a match',
  searchProjects([alpha], alphaIndex, 'oauth hour'),
  []
)
check(
  'nor across two sessions',
  searchProjects([alpha], alphaIndex, 'oauth readme'),
  []
)

/* ----------------------------------------------------------------- ranking */

console.log('\nranking: tier first, then recency')
{
  const pPrefix = project('/x/search-ui', { lastModified: now - 50 * hour })
  const pName = project('/x/my-search', { lastModified: now - 40 * hour })
  const pTitle = project('/x/zeta', { lastModified: now - 1 * hour })
  const pPath = project('/x/search/omega', { lastModified: now - 1 * hour })
  const pPrompt = project('/x/kappa', { lastModified: now - 1 * hour })
  const index = [
    session(pTitle.path, 't1', 'Search box polish', 'nothing', now - 30 * hour),
    session(pPrompt.path, 'p1', 'Other things', 'add search to the list', now - 1 * hour)
  ]
  const hits = searchProjects([pPrompt, pPath, pTitle, pName, pPrefix], index, 'search')
  check(
    'name prefix > name substring > session title > path > first prompt',
    hits.map((h) => [h.project.name, h.matchedBy, h.score]),
    [
      ['search-ui', 'name', TIERS.namePrefix],
      ['my-search', 'name', TIERS.name],
      ['zeta', 'title', TIERS.title],
      ['omega', 'path', TIERS.path],
      ['kappa', 'prompt', TIERS.prompt]
    ]
  )
}
{
  const older = project('/r/a-search', { lastModified: now - 10 * hour })
  const newer = project('/r/b-search', { lastModified: now - 2 * hour })
  check(
    'two name matches: the more recently used project first',
    paths(searchProjects([older, newer], [], 'search')),
    [newer.path, older.path]
  )
}
{
  // Busy project, old matching conversation vs. quiet project, recent one.
  const busy = project('/r/busy', { lastModified: now - 1 * hour })
  const quiet = project('/r/quiet', { lastModified: now - 20 * hour })
  const index = [
    session(busy.path, 'x1', 'Payment webhook', null, now - 100 * hour),
    session(quiet.path, 'x2', 'Payment retries', null, now - 20 * hour)
  ]
  check(
    'two session matches: the newer matching conversation first, however busy the other project',
    paths(searchProjects([busy, quiet], index, 'payment')),
    [quiet.path, busy.path]
  )
}
{
  const z = project('/r/zeta-proj')
  const a = project('/r/alpha-proj')
  check(
    'a full tie falls back to the name, so the order never flickers',
    paths(searchProjects([z, a], [], 'proj')),
    [a.path, z.path]
  )
}

/* ------------------------------------------------------ empty query, scope */

console.log('\nan empty query changes nothing; a query ignores the profile')
{
  const list = [stoke, client, alpha]
  const hits = searchProjects(list, alphaIndex, '   ')
  check('every project, in the order given', paths(hits), paths(list.map((project) => ({ project }))))
  check(
    '...with nothing marked and no sessions listed',
    hits.every((h) => h.score === 0 && !h.nameRanges.length && !h.sessions.length),
    true
  )
}
{
  const personal = (p: Project): boolean => p.group === 'personal'
  const list = [client, stoke, alpha]
  check('browsing applies the profile', paths(scopeProjects(list, '', personal).map((project) => ({ project }))), [
    stoke.path,
    alpha.path
  ])
  check('whitespace is not a query', scopeProjects(list, '  ', personal).length, 2)
  check('a query reaches past the profile', scopeProjects(list, 'client', personal).length, 3)
  check(
    '...so a folder outside the profile is still found',
    paths(searchProjects(scopeProjects(list, 'client', personal), [], 'client')),
    [client.path]
  )
  check('no profile, no filter', scopeProjects(list, '', null).length, 3)
}

/* --------------------------------------------------------------------- cap */

console.log('\nper-project cap')
{
  const gamma = project('/dev/personal/gamma', { lastModified: now })
  const many = Array.from({ length: 8 }, (_, i) =>
    session(gamma.path, `g${i}`, `Search pass ${i}`, null, now - i * hour)
  )
  const hit = searchProjects([gamma], many, 'search')[0]
  check('every match is returned, newest first', hit?.sessions.map((s) => s.session.id), [
    'g0',
    'g1',
    'g2',
    'g3',
    'g4',
    'g5',
    'g6',
    'g7'
  ])
  const capped = capSessions(hit?.sessions ?? [], false)
  check(`the row shows the first ${SESSION_CAP}`, capped.shown.map((s) => s.session.id), [
    'g0',
    'g1',
    'g2',
    'g3',
    'g4'
  ])
  check('...and says how many more there are', capped.hidden, 3)
  check('"Show more" shows all of them', capSessions(hit?.sessions ?? [], true).shown.length, 8)
  check('exactly the cap hides nothing', capSessions(many.slice(0, SESSION_CAP), false).hidden, 0)
}

/* ------------------------------------------------- before the index arrives */

console.log('\nno session has been searched until the index first arrives')
// The first: React paints the render that shows a query before App's effect
// starts the fetch, so this frame has no index, no fetch and no error. Keyed on
// the loading flag it read as done, and painted "Nothing matches" (measured
// over CDP: 5.5 ms after the keystroke, replaced at 10.5 ms).
check('the frame before the first fetch starts is pending', indexPending(null, false, null), true)
check('the first fetch in flight is pending', indexPending(null, true, null), true)
check('a failed first fetch is not pending: the sidebar says why', indexPending(null, false, 'boom'), false)
check('...but a retry after it is', indexPending(null, true, 'boom'), true)
check('an index in hand is never pending', indexPending([], false, null), false)
check('...not even while it is refreshed', indexPending([], true, null), false)

/* ---------------------------------------------------------- the real index */

console.log('\nthe session index reads both ends of each transcript, once')
const root = mkdtempSync(join(tmpdir(), 'stoke-search-'))
try {
  const line = (o: object): string => `${JSON.stringify(o)}\n`
  const user = (text: string): string =>
    line({ type: 'user', message: { role: 'user', content: text }, cwd: '/dev/personal/alpha' })
  const titled = (t: string): string => line({ type: 'ai-title', aiTitle: t })
  const said = (text: string): string =>
    line({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    })
  const filler = said('x'.repeat(4000))

  const dirA = join(root, '-dev-personal-alpha')
  const dirB = join(root, '-dev-personal-beta')
  mkdirSync(dirA)
  mkdirSync(dirB)

  // ~40 MB: the retitle Claude wrote last is at the far end, the prompt at the
  // start behind a slash command's noise.
  const bigFile = join(dirA, 'big-session.jsonl')
  writeFileSync(
    bigFile,
    user('<command-name>/clear</command-name>') +
      user('Build the search index for every chat') +
      titled('An early title') +
      filler.repeat(Math.ceil((40 * 1024 * 1024) / filler.length)) +
      titled('Search across every chat') +
      said('done')
  )
  // Bigger than both ends together, with its only title in the head.
  const mediumFile = join(dirA, 'medium-session.jsonl')
  writeFileSync(mediumFile, user('a medium prompt') + titled('Title only in the head') + filler.repeat(180))
  const smallFile = join(dirA, 'small-session.jsonl')
  writeFileSync(smallFile, user('hello   from a\nsmall session'))
  const betaFile = join(dirB, 'beta-1.jsonl')
  writeFileSync(betaFile, user('beta prompt') + titled('Beta title'))

  // A subagent's transcript, where Claude Code really puts them.
  mkdirSync(join(dirA, 'big-session', 'subagents'), { recursive: true })
  writeFileSync(
    join(dirA, 'big-session', 'subagents', 'agent-1.jsonl'),
    user('SUBAGENT PROMPT') + titled('SUBAGENT TITLE')
  )
  // Things in a history directory that are not transcripts.
  mkdirSync(join(dirA, 'not-a-file.jsonl'))
  writeFileSync(join(dirA, 'notes.txt'), titled('NOT A SESSION'))

  const at = (file: string, ms: number): void => utimesSync(file, ms / 1000, ms / 1000)
  at(smallFile, now - 1 * hour)
  at(mediumFile, now - 2 * hour)
  at(bigFile, now - 3 * hour)
  at(betaFile, now - 4 * hour)

  const alphaP = project('/dev/personal/alpha', { encodedDir: '-dev-personal-alpha' })
  const betaP = project('/dev/personal/beta', { encodedDir: '-dev-personal-beta' })
  const noHistory = project('/dev/personal/none')
  const gone = project('/dev/personal/gone', { encodedDir: '-dev-personal-gone' })

  const cache = createSessionIndexCache()
  const fresh = (): SessionIndexStats => ({ filesRead: 0, bytesRead: 0, cacheHits: 0 })

  const stats1 = fresh()
  const first = await indexSessions([alphaP, betaP, noHistory, gone], { root, cache, stats: stats1 })
  const byId = new Map(first.map((e) => [e.id, e]))
  check(
    'every top-level transcript, newest first, under its own project',
    first.map((e) => [e.id, e.projectPath]),
    [
      ['small-session', alphaP.path],
      ['medium-session', alphaP.path],
      ['big-session', alphaP.path],
      ['beta-1', betaP.path]
    ]
  )
  check(
    'a subagent transcript is not a session',
    first.some((e) => e.id === 'agent-1' || e.title === 'SUBAGENT TITLE'),
    false
  )
  check('the newest title, from the far end of 40 MB', byId.get('big-session')?.title, 'Search across every chat')
  check(
    'the first prompt a person typed, not the slash command before it',
    byId.get('big-session')?.firstPrompt,
    'Build the search index for every chat'
  )
  check('a title that is only in the head is still found', byId.get('medium-session')?.title, 'Title only in the head')
  check('an untitled session has a null title', byId.get('small-session')?.title, null)
  check('a prompt is collapsed to one line', byId.get('small-session')?.firstPrompt, 'hello from a small session')
  check('mtime is the modified time', byId.get('beta-1')?.modified, now - 4 * hour)

  const bigSize = statSync(bigFile).size
  const expected = 2 * CHUNK + 2 * CHUNK + statSync(smallFile).size + statSync(betaFile).size
  check('four files were read', stats1.filesRead, 4)
  check(
    `bytes read: one ${CHUNK / 1024} KB chunk from each end of the two big files, the small ones whole`,
    stats1.bytesRead,
    expected
  )
  check(`...which is ${((2 * CHUNK) / bigSize * 100).toFixed(1)}% of the 40 MB file`, bigSize > 40 * 1024 * 1024, true)

  // "First prompt" and "title" must mean what the expanded list means.
  const parsedBig = await parseSession(bigFile)
  const parsedMedium = await parseSession(mediumFile)
  const parsedSmall = await parseSession(smallFile)
  check(
    'the index and parseSession agree on the title and first prompt',
    [
      [byId.get('big-session')?.title, byId.get('big-session')?.firstPrompt],
      [byId.get('medium-session')?.title, byId.get('medium-session')?.firstPrompt],
      [byId.get('small-session')?.title, byId.get('small-session')?.firstPrompt]
    ],
    [
      [parsedBig.title, parsedBig.firstPrompt],
      [parsedMedium.title, parsedMedium.firstPrompt],
      [parsedSmall.title, parsedSmall.firstPrompt]
    ]
  )

  const stats2 = fresh()
  const second = await indexSessions([alphaP, betaP, noHistory, gone], { root, cache, stats: stats2 })
  check('a second pass over unchanged files reads nothing', [stats2.filesRead, stats2.bytesRead], [0, 0])
  check('...answers every file from the cache', stats2.cacheHits, 4)
  check('...and returns the same index', second, first)

  appendFileSync(smallFile, titled('Small, retitled'))
  at(smallFile, now - 0.5 * hour)
  const stats3 = fresh()
  const third = await indexSessions([alphaP, betaP], { root, cache, stats: stats3 })
  check('a retitled session is re-read, alone', [stats3.filesRead, stats3.bytesRead], [
    1,
    statSync(smallFile).size
  ])
  check('...and carries its new title', third.find((e) => e.id === 'small-session')?.title, 'Small, retitled')

  rmSync(mediumFile)
  const fourth = await indexSessions([alphaP, betaP], { root, cache, stats: fresh() })
  check('a deleted transcript leaves the index', fourth.some((e) => e.id === 'medium-session'), false)
  check('...and the cache', [...cache.keys()].some((k) => k.endsWith('medium-session.jsonl')), false)

  const twin = project('/dev/personal/Alpha', { encodedDir: '-dev-personal-alpha' })
  const stats5 = fresh()
  const fifth = await indexSessions([alphaP, twin], { root, cache, stats: stats5 })
  check(
    'two projects naming one history directory each get its sessions, as expanding either shows',
    fifth
      .filter((e) => e.id === 'small-session')
      .map((e) => e.projectPath)
      .sort(),
    [twin.path, alphaP.path].sort()
  )
  check('...from one read of each file', stats5.bytesRead, 0)

  const shared = createSessionIndexCache()
  const statsA = fresh()
  const statsB = fresh()
  await Promise.all([
    indexSessions([alphaP, betaP], { root, cache: shared, stats: statsA }),
    indexSessions([alphaP, betaP], { root, cache: shared, stats: statsB })
  ])
  check(
    'two overlapping passes share each read instead of both doing it',
    [statsA.filesRead + statsB.filesRead, statsA.cacheHits + statsB.cacheHits],
    [3, 3]
  )

  // A first message carrying pasted screenshots is longer than the whole head,
  // so the head ends inside it. Measured on a real transcript: 753 KB, three
  // images, typed text first.
  const dirC = join(root, '-dev-personal-pasted')
  mkdirSync(dirC)
  const bigImage = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(700 * 1024) }
  }
  const pastedFile = join(dirC, 'pasted.jsonl')
  writeFileSync(
    pastedFile,
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Make the   header\nlook like this' }, bigImage, bigImage]
      }
    }) + filler.repeat(200)
  )
  // A tool result is a user record too, and has text blocks nested inside it.
  const toolFile = join(dirC, 'tool-first.jsonl')
  writeFileSync(
    toolFile,
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: 'toolu_1',
            type: 'tool_result',
            content: [{ type: 'text', text: 'TOOL OUTPUT' }, bigImage]
          }
        ]
      }
    }) + filler.repeat(200)
  )
  const pastedP = project('/dev/personal/pasted', { encodedDir: '-dev-personal-pasted' })
  const statsC = fresh()
  const pastedIndex = await indexSessions([pastedP], { root, cache: createSessionIndexCache(), stats: statsC })
  const pastedById = new Map(pastedIndex.map((e) => [e.id, e]))
  check(
    'a first message cut by the head still yields its typed text',
    pastedById.get('pasted')?.firstPrompt,
    'Make the header look like this'
  )
  check(
    '...the same prompt parseSession reads from the whole file',
    pastedById.get('pasted')?.firstPrompt,
    (await parseSession(pastedFile)).firstPrompt
  )
  check(
    'a cut tool result never lends its nested text as a prompt',
    [pastedById.get('tool-first')?.firstPrompt, (await parseSession(toolFile)).firstPrompt],
    [null, null]
  )
  check('...and neither file cost more than its two ends', statsC.bytesRead, 4 * CHUNK)
} finally {
  rmSync(root, { recursive: true, force: true })
}

/*
 * The tally is the LAST statement in this file and has to stay that way:
 * `process.exitCode` is set once, so an assertion below it could print FAIL and
 * still exit 0 (CLAUDE.md gotchas 50 and 62).
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
