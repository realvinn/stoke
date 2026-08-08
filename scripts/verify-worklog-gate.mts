/*
 * The worklog gate decides which sessions an agent gets to read, and both ways
 * of getting it wrong are silent: watch too much and personal work is proposed
 * into a work tracker, watch too little and the feature simply never fires. So
 * the resolution rule is pinned here rather than trusted.
 *
 * The cases that matter are the ones a real machine produces — a cwd a level
 * down inside a project, a trailing separator off a shell, forward slashes on
 * Windows, and the same folder written in a different case.
 *
 *   node scripts/verify-worklog-gate.mts
 */
import { sep } from 'node:path'
import { GATE_RULES, groupForCwd, isWatchedGroup, shouldWatch } from '../src/main/worklog/gate.ts'
import { watchStateFrom } from '../src/main/worklog/watch.ts'
import { groupForCwd as groupForCwdShared, pathRulesFor } from '../src/shared/paths.ts'
import type { Project } from '../src/shared/types.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const isWin = process.platform === 'win32'

/** Fixture paths in this platform's own shape, so the test is not Windows-only. */
const root = isWin ? 'G:\\Code' : '/Users/vinn/Code'
const p = (...parts: string[]): string => [root, ...parts].join(sep)

/** A Project with only the fields the gate reads carrying real values. */
function project(path: string, group: string): Project {
  return {
    path,
    name: path.split(sep).pop() ?? path,
    group,
    encodedDir: null,
    sessionCount: 0,
    lastModified: null,
    lastCost: null,
    lastPrompt: null,
    exists: true,
    pinned: false,
    emoji: null,
    label: null,
    addedManually: false
  }
}

const projects: Project[] = [
  project(p('personal', 'Stoke'), 'personal'),
  project(p('personal', 'Stoke-old'), 'personal'),
  project(p('gitea-company', 'refinity'), 'gitea-company'),
  project(p('school', 'assignment-2'), 'school')
]

/** The user watches work only. */
const WATCHED = ['gitea-company']

console.log('\nresolving a working directory to its group')
check('a project root resolves', groupForCwd(p('gitea-company', 'refinity'), projects), 'gitea-company')
check(
  'a cwd a level down inside a project resolves to the same group',
  groupForCwd(p('gitea-company', 'refinity', 'src', 'server'), projects),
  'gitea-company'
)
check('a folder that is no project at all resolves to nothing', groupForCwd(p('scratch', 'notes'), projects), null)
check('somewhere else on the disk entirely resolves to nothing', groupForCwd(isWin ? 'C:\\Windows\\System32' : '/etc', projects), null)
check('an empty cwd resolves to nothing rather than matching the first project', groupForCwd('', projects), null)
check(
  'a sibling sharing a name prefix is not claimed',
  groupForCwd(p('personal', 'Stoke-old'), projects),
  'personal'
)
check(
  'a group missing off the record is recomputed from the path',
  groupForCwd(p('gitea-company', 'refinity'), [project(p('gitea-company', 'refinity'), '')]),
  'gitea-company'
)

console.log('\nthe gate')
check('a session inside a watched group is watched', shouldWatch(p('gitea-company', 'refinity'), projects, WATCHED), true)
check(
  'a session deep inside a watched project is watched',
  shouldWatch(p('gitea-company', 'refinity', 'apps', 'web'), projects, WATCHED),
  true
)
check('a session inside an unwatched group is not', shouldWatch(p('personal', 'Stoke'), projects, WATCHED), false)
check('a session in an unknown folder is not', shouldWatch(p('scratch', 'notes'), projects, WATCHED), false)
check('no groups watched means nothing is watched', shouldWatch(p('gitea-company', 'refinity'), projects, []), false)
check(
  'a blank entry does not switch everything on',
  shouldWatch(p('gitea-company', 'refinity'), projects, ['  ']),
  false
)
check(
  'watching several groups covers each of them',
  ['personal', 'gitea-company', 'school'].map((g) =>
    shouldWatch(p(g, g === 'personal' ? 'Stoke' : g === 'school' ? 'assignment-2' : 'refinity'), projects, [
      'personal',
      'gitea-company'
    ])
  ),
  [true, true, false]
)

console.log('\ncwd shapes a real shell produces')
check(
  'a trailing separator does not change the answer',
  shouldWatch(p('gitea-company', 'refinity') + sep, projects, WATCHED),
  true
)
check(
  'a trailing separator on an unwatched group does not change that either',
  shouldWatch(p('personal', 'Stoke') + sep, projects, WATCHED),
  false
)
check(
  'surrounding whitespace is tolerated',
  shouldWatch(`  ${p('gitea-company', 'refinity')}  `, projects, WATCHED),
  true
)
if (isWin) {
  check(
    'forward slashes resolve the same as backslashes',
    shouldWatch(p('gitea-company', 'refinity').replace(/\\/g, '/'), projects, WATCHED),
    true
  )
}

console.log('\ncase')
check(
  'the watched group name is compared case-blind',
  shouldWatch(p('gitea-company', 'refinity'), projects, ['GITEA-Company']),
  true
)
check('so is a group looked up on its own', isWatchedGroup('Gitea-Company', ['gitea-company']), true)
check('and a group nobody watches stays off', isWatchedGroup('personal', ['gitea-company']), false)

const shouted = p('GITEA-COMPANY', 'Refinity')
check(
  'this machine folds path case exactly as its own rules say',
  shouldWatch(shouted, projects, WATCHED),
  GATE_RULES.caseInsensitive
)
if (isWin) {
  check(
    'and an unwatched one still does not match however it is cased',
    shouldWatch(p('PERSONAL', 'STOKE'), projects, WATCHED),
    false
  )
}

console.log('\nthe rule that matters: the sidebar chip is not consulted')
/*
 * There is nowhere to pass the active profile in, which is the point. This
 * asserts the shape of that promise: the same cwd gives the same answer with
 * every profile selection, because the selection cannot reach the function.
 */
check('shouldWatch takes exactly cwd, projects and the group list', shouldWatch.length, 3)
check(
  'a work session is watched no matter what the user is browsing',
  [null, 'personal', 'school', 'gitea-company'].map(() =>
    shouldWatch(p('gitea-company', 'refinity'), projects, WATCHED)
  ),
  [true, true, true, true]
)

console.log('\na scan root is not a project')
/*
 * `/Users/thevinh/dev/work` is itself a registered Claude project on the real
 * machine, so the longest-prefix rule matched it and answered `dev` for every
 * sibling under it — 7 of 12 work folders were unwatched. A root is a
 * container of projects, not a project.
 */
const withRoot: Project[] = [...projects, project(root, isWin ? 'G:' : 'vinn')]
check(
  'a folder under a scan root resolves to the root name, not the root parent',
  groupForCwd(p('unregistered-repo'), withRoot, [root]),
  'Code'
)
check(
  'and a real project inside the root still wins over the root fallback',
  groupForCwd(p('gitea-company', 'refinity'), withRoot, [root]),
  'gitea-company'
)
check(
  'with no roots passed, an unregistered folder still resolves to nothing',
  groupForCwd(p('unregistered-repo'), projects),
  null
)

console.log('\na watched root watches the folders under it')
check(
  'a folder under a watched root is watched even with no history of its own',
  shouldWatch(p('unregistered-repo'), withRoot, ['Code'], [root]),
  true
)

console.log('\nmacOS folds case like Windows does')
/*
 * Asserted for all three platforms with an explicit `pathRulesFor(...)` call
 * rather than branched on `process.platform`, so every machine runs every
 * assertion and `npm run check` gives identical results everywhere. Branching
 * here would mean the darwin behaviour is exercised on nobody's machine but a
 * Mac's.
 */
check('win32 folds path case', pathRulesFor('win32').caseInsensitive, true)
check(
  'darwin folds path case too, because APFS is case-insensitive by default',
  pathRulesFor('darwin').caseInsensitive,
  true
)
check('linux does not fold path case', pathRulesFor('linux').caseInsensitive, false)
check(
  'a differently-cased path matches on APFS',
  isWatchedGroup(groupForCwdShared(p('GITEA-COMPANY', 'Refinity'), projects, pathRulesFor('darwin')), WATCHED),
  true
)

console.log('\nwhy a session is, or is not, the worklog agent\'s business')

const at = 1_700_000_000_000
const watchOf = (over: Partial<Parameters<typeof watchStateFrom>[0]> = {}): unknown =>
  watchStateFrom({
    sessionId: 's1',
    cwd: p('gitea-company', 'refinity'),
    host: null,
    projects,
    roots: [],
    worklogGroups: WATCHED,
    now: at,
    ...over
  })

check('a watched folder is watched, and says which group', watchOf(), {
  sessionId: 's1',
  watched: true,
  reason: 'watched-group',
  group: 'gitea-company',
  remote: false,
  decidedAt: at
})
check(
  'a folder in a group nobody watches says so',
  watchOf({ cwd: p('personal', 'Stoke') }),
  { sessionId: 's1', watched: false, reason: 'unwatched-group', group: 'personal', remote: false, decidedAt: at }
)
check(
  'a folder that belongs to no project and no root cannot be placed at all',
  watchOf({ cwd: p('scratch', 'notes') }),
  { sessionId: 's1', watched: false, reason: 'unknown-folder', group: null, remote: false, decidedAt: at }
)
check(
  'with nothing ticked the feature is off, not merely unwatched',
  watchOf({ worklogGroups: [] }),
  { sessionId: 's1', watched: false, reason: 'off', group: 'gitea-company', remote: false, decidedAt: at }
)

/*
 * The root fallback, reaching through this predicate. `/…/work` is itself a
 * registered project on the real machine, so the longest-prefix rule answered
 * `dev` for every sibling under it and 7 of 12 work folders were never watched
 * (spec §2.4.3).
 */
const rootProjects: Project[] = [...projects, project(root, isWin ? 'G:' : 'vinn')]
check(
  'a folder under a watched scan root is watched with no history of its own',
  watchOf({
    cwd: p('unregistered-repo'),
    projects: rootProjects,
    roots: [root],
    worklogGroups: ['Code']
  }),
  { sessionId: 's1', watched: true, reason: 'watched-group', group: 'Code', remote: false, decidedAt: at }
)

console.log('\na remote session is gated by its machine, never by a folder')
const host = { label: 'Build box', alias: 'buildbox', worklog: true }
check('a ticked host is watched', watchOf({ host }), {
  sessionId: 's1',
  watched: true,
  reason: 'watched-host',
  group: 'Build box',
  remote: true,
  decidedAt: at
})
check(
  'an unticked host is not, whatever the local cwd happens to be',
  watchOf({ host: { ...host, worklog: false } }),
  { sessionId: 's1', watched: false, reason: 'unwatched-host', group: 'Build box', remote: true, decidedAt: at }
)
check(
  'anything other than a literal true is off',
  watchOf({ host: { label: '', alias: 'buildbox' } }),
  { sessionId: 's1', watched: false, reason: 'unwatched-host', group: 'buildbox', remote: true, decidedAt: at }
)
check(
  'and a ticked host works with no project groups ticked at all',
  watchOf({ host, worklogGroups: [] }),
  { sessionId: 's1', watched: true, reason: 'watched-host', group: 'Build box', remote: true, decidedAt: at }
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
