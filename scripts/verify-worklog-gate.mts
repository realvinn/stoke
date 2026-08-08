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
import { scanSentence, watchSentence, worklogButtonState } from '../src/shared/worklog.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
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

console.log('\nwhat the panel says about itself')

const state = (over: Record<string, unknown> = {}): never =>
  ({
    sessionId: 's1',
    watched: true,
    reason: 'watched-group',
    group: 'gitea-company',
    remote: false,
    decidedAt: 1,
    ...over
  }) as never

ok(
  'a watched session names its group',
  watchSentence(state(), ['gitea-company']).includes('gitea-company'),
  watchSentence(state(), ['gitea-company'])
)
ok(
  'with nothing ticked it says how to turn it on, not merely that it is off',
  /Settings/.test(watchSentence(state({ watched: false, reason: 'off' }), [])),
  watchSentence(state({ watched: false, reason: 'off' }), [])
)
ok(
  'an unwatched group says which groups are armed instead',
  watchSentence(state({ watched: false, reason: 'unwatched-group', group: 'personal' }), [
    'gitea-company'
  ]).includes('gitea-company'),
  watchSentence(state({ watched: false, reason: 'unwatched-group', group: 'personal' }), ['gitea-company'])
)
ok(
  'a folder that cannot be placed says so rather than blaming the profile',
  /no project/.test(
    watchSentence(state({ watched: false, reason: 'unknown-folder', group: null }), ['gitea-company'])
  )
)
ok(
  'a remote session is described by its machine',
  /machine/.test(
    watchSentence(state({ watched: false, reason: 'unwatched-host', group: 'Build box', remote: true }), [])
  )
)
ok(
  'and no session at all is its own sentence',
  /No session/.test(watchSentence(null, ['gitea-company'])),
  watchSentence(null, ['gitea-company'])
)

const report = (over: Record<string, unknown> = {}): never =>
  ({ sessionId: 's1', at: 1, auto: false, outcome: 'nothing', added: 0, message: null, ...over }) as never

// `report()` always names session 's1'. Most assertions below only care about
// wording that holds regardless of which session is on screen, so they pass
// 's1' - "here" - as the active session throughout; the block further down
// ("who a report is actually about") is the one that varies it on purpose.
ok(
  'a scan that proposed says how many',
  /2 entries/.test(scanSentence(report({ outcome: 'proposed', added: 2 }), 's1'))
)
ok(
  'one entry is not "1 entries"',
  /1 entry\b/.test(scanSentence(report({ outcome: 'proposed', added: 1 }), 's1'))
)
ok('an empty scan says it looked', /nothing worth logging/.test(scanSentence(report(), 's1')))
ok(
  'a budget failure says so verbatim, never as an empty result',
  scanSentence(
    report({ outcome: 'budget', message: 'The recall run stopped at its $0.60 budget ceiling.' }),
    's1'
  ).includes('$0.60'),
  scanSentence(
    report({ outcome: 'budget', message: 'The recall run stopped at its $0.60 budget ceiling.' }),
    's1'
  )
)
ok(
  // 'transcript found', not 'no transcript found': `asSentence` capitalises a
  // lowercase fragment's first letter (Task 29 review, finding 3), so the
  // leading "no" arrives in the sentence as "No" - checked for below instead.
  'an error carries its message through',
  scanSentence(report({ outcome: 'error', message: 'no transcript found' }), 's1').includes(
    'transcript found'
  )
)
ok(
  'an automatic scan is marked as one',
  /on its own/.test(scanSentence(report({ auto: true }), 's1')),
  scanSentence(report({ auto: true }), 's1')
)

/*
 * H5 (Task 26 review, carried into Task 29): a scan that drafted proposals
 * without managing to read the board first still reports `outcome: 'proposed'`
 * — but `message` is non-null in exactly that case, and it is the only thing
 * telling the user the drafts might duplicate what is already on the board.
 * A rendering that drops the message on the floor here is the silent failure
 * H5 exists to close, so this is asserted directly rather than trusted.
 */
ok(
  'a starved-board warning rides along with the proposals it applies to',
  scanSentence(
    report({
      outcome: 'proposed',
      added: 2,
      message: 'the recall run stopped at its $2.00 budget ceiling'
    }),
    's1'
  ).includes('$2.00'),
  scanSentence(
    report({ outcome: 'proposed', added: 2, message: 'the recall run stopped at its $2.00 budget ceiling' }),
    's1'
  )
)
/*
 * Task 29 review, minor 5: the old version of this check only asserted the
 * *absence of one literal phrase* ("boards first"). That passes just as
 * happily against a warning appended unconditionally under a different
 * wording as it does against the warning being dropped outright — it never
 * actually exercises the decision to include the warning, only one guess at
 * its vocabulary. Coupled to behaviour instead, two ways:
 *
 *  - Exact equality against the literal clean sentence catches an
 *    unconditionally-appended warning of *any* wording, because anything
 *    extra breaks the match regardless of what it says.
 *  - The `.includes('$2.00')` check above already catches the warning being
 *    dropped: if `scanSentence` stopped reading `message` at all, that
 *    assertion would fail on its own.
 *
 * Both directions are demonstrated live in this task's report rather than
 * merely asserted here — see "vacuity check" there.
 */
ok(
  'and an ordinary clean proposal is worded exactly like one with no warning to carry, nothing appended',
  scanSentence(report({ outcome: 'proposed', added: 2 }), 's1') ===
    'A scan ran on this session and proposed 2 entries.',
  scanSentence(report({ outcome: 'proposed', added: 2 }), 's1')
)

/*
 * Task 29 review, routed item 2: `scanSession` (runner.ts) already tells an
 * empty transcript apart from a model that looked and found nothing — that is
 * `ScanOutcome.emptyTranscript`. `runWorklogScan` (index.ts) carries the
 * distinction into `message` rather than discarding it, and this is the
 * pure-function guarantee that the sentence actually differs when it does.
 */
ok(
  'a session with no turns yet reads differently from one the model read and dismissed',
  scanSentence(report({ outcome: 'nothing', message: 'it had not sent anything yet' }), 's1') !==
    scanSentence(report(), 's1'),
  scanSentence(report({ outcome: 'nothing', message: 'it had not sent anything yet' }), 's1')
)

console.log('\nwho a report is actually about (Task 29 review, finding 2)')
/*
 * `lastScan` (App.tsx / WorklogPanel.tsx) is the last scan of *any* session,
 * and `AutoScanner` fires precisely on sessions that have gone idle — usually
 * not the one on screen. `report()` always names session 's1'; these compare
 * that against a *different* active session to prove the sentence says so.
 */
ok(
  'an automatic scan of the session on screen says "this session"',
  scanSentence(report({ auto: true, outcome: 'proposed', added: 1 }), 's1').startsWith(
    'Stoke scanned this session on its own'
  ),
  scanSentence(report({ auto: true, outcome: 'proposed', added: 1 }), 's1')
)
ok(
  'an automatic scan of a different session says so, not "this"',
  scanSentence(report({ auto: true, outcome: 'proposed', added: 1 }), 's2').startsWith(
    'Stoke scanned another session on its own'
  ),
  scanSentence(report({ auto: true, outcome: 'proposed', added: 1 }), 's2')
)
ok(
  'a manual scan of the session on screen says "this session"',
  scanSentence(report({ outcome: 'proposed', added: 1 }), 's1').startsWith('A scan ran on this session'),
  scanSentence(report({ outcome: 'proposed', added: 1 }), 's1')
)
ok(
  'a manual scan of a different session says so, not "this"',
  scanSentence(report({ outcome: 'proposed', added: 1 }), 's2').startsWith('A scan ran on another session'),
  scanSentence(report({ outcome: 'proposed', added: 1 }), 's2')
)
ok(
  'no session on screen at all still names the report a session, not "this"',
  scanSentence(report({ outcome: 'proposed', added: 1 }), null).startsWith('A scan ran on another session'),
  scanSentence(report({ outcome: 'proposed', added: 1 }), null)
)

console.log('\nframes composed against the messages they actually receive (Task 29 review, finding 3)')
/*
 * These are not the friendly test fixtures above — they are the real strings
 * `runWorklogScan` and its collaborators produce, reproduced verbatim from
 * recall.ts / runner.ts / index.ts. Rendering them is the test: a frame that
 * merely *contains* the right substring can still read as broken English
 * around it (a doubled period, a contradiction, a restated verb) — see this
 * task's report for the full set, printed and read.
 */
ok(
  'the board-read budget message never gets a doubled period',
  !scanSentence(
    report({
      outcome: 'budget',
      message:
        'The worklog scan could not check what is already on your boards before hitting its $2.00 budget ceiling.'
    }),
    's1'
  ).includes('..'),
  scanSentence(
    report({
      outcome: 'budget',
      message:
        'The worklog scan could not check what is already on your boards before hitting its $2.00 budget ceiling.'
    }),
    's1'
  )
)
ok(
  'the parse-error message never gets a doubled period or a colon splice',
  (() => {
    const s = scanSentence(
      report({
        outcome: 'error',
        message: "Claude's reply could not be read back as an entry. Try scanning again."
      }),
      's1'
    )
    return !s.includes('..') && !s.includes(': ')
  })(),
  scanSentence(
    report({
      outcome: 'error',
      message: "Claude's reply could not be read back as an entry. Try scanning again."
    }),
    's1'
  )
)
ok(
  'a quoted CLI budget message never gets a stray period after the closing quote',
  !scanSentence(
    report({
      outcome: 'budget',
      message:
        'The worklog scan stopped at its $0.30 budget ceiling before it finished, so no entries were drafted. The run said: "Reached maximum budget ($0.0001)"'
    }),
    's1'
  ).includes('".'),
  scanSentence(
    report({
      outcome: 'budget',
      message:
        'The worklog scan stopped at its $0.30 budget ceiling before it finished, so no entries were drafted. The run said: "Reached maximum budget ($0.0001)"'
    }),
    's1'
  )
)

console.log('\nwhat the title-bar button is showing')

const watching = state()
const off = state({ watched: false, reason: 'off' })

check('nothing open at all is disarmed', worklogButtonState([], 0), 'disarmed')
check('every session off is disarmed', worklogButtonState([off, off] as never[], 0), 'disarmed')
check('a watched session is watching', worklogButtonState([off, watching] as never[], 0), 'watching')
check('anything pending badges', worklogButtonState([watching] as never[], 3), 'badged')
/*
 * A pending proposal outranks the switch. A queue holding work the user has
 * not decided on must be reachable even after they switch every profile off —
 * otherwise turning the feature off hides three real proposals with no way
 * back to them. Contracts §0.3 states this ordering, and the tab strip reads
 * the same contract.
 */
check('and it badges even with everything switched off', worklogButtonState([off] as never[], 1), 'badged')
check(
  'an unwatched-but-known session is neither armed nor showing anything',
  worklogButtonState([state({ watched: false, reason: 'unwatched-group' })] as never[], 0),
  'disarmed'
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
