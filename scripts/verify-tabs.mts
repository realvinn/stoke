/*
 * Tab list arithmetic: which tab is selected when one closes, and where a
 * dragged tab lands. Both are pure list operations that were written inline in
 * a React callback, where the only way to check them was to click.
 *
 *   node scripts/verify-tabs.mts
 */
import {
  moveTab,
  neighbourOf,
  relaunchPlan,
  replaceOrAppend,
  restartPlan
} from '../src/renderer/src/lib/tabs.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const five = ['a', 'b', 'c', 'd', 'e']

console.log('\nclosing a tab selects its neighbour')
check('closing the first selects the one that takes its place', neighbourOf(five, 'a'), 'b')
check('closing a middle one selects the one that takes its place', neighbourOf(five, 'c'), 'd')
check('closing the last selects the one before it', neighbourOf(five, 'e'), 'd')
check('closing the only tab leaves nothing selected', neighbourOf(['a'], 'a'), null)
check('closing a tab that is not there changes nothing', neighbourOf(five, 'zz'), null)
check('an empty list has no neighbour', neighbourOf([], 'a'), null)

console.log('\nreplaceOrAppend: a launch consumes the New Project tab it started from')
const abc = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
check(
  'replacing a tab that exists lands the new tab at the replaced index',
  replaceOrAppend(abc, { id: 'x' }, 'b'),
  [{ id: 'a' }, { id: 'x' }, { id: 'c' }]
)
check(
  'replacing an id not in the list appends, rather than throwing or dropping it',
  replaceOrAppend(abc, { id: 'x' }, 'not-there'),
  [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'x' }]
)
check(
  'no replaceTabId appends',
  replaceOrAppend(abc, { id: 'x' }),
  [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'x' }]
)
check(
  'a null replaceTabId (startHostSession passes activeNewTabId straight through) also appends',
  replaceOrAppend(abc, { id: 'x' }, null),
  [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'x' }]
)
check(
  'replacing the only tab in a single-tab list',
  replaceOrAppend([{ id: 'only' }], { id: 'x' }, 'only'),
  [{ id: 'x' }]
)

console.log('\ndragging a tab onto another')
const ids = (list: { id: string }[]): string[] => list.map((t) => t.id)
const five5 = five.map((id) => ({ id }))

check('dragging right lands on the target index', ids(moveTab(five5, 'a', 'c')), [
  'b',
  'c',
  'a',
  'd',
  'e'
])
check('dragging left lands on the target index', ids(moveTab(five5, 'e', 'b')), [
  'a',
  'e',
  'b',
  'c',
  'd'
])
check('dropping a tab on itself changes nothing', ids(moveTab(five5, 'c', 'c')), five)
check(
  'same-index move returns the identical array, not just an equal one (no churn)',
  moveTab(five5, 'c', 'c') === five5,
  true
)
check('an unknown drag id changes nothing', ids(moveTab(five5, 'zz', 'c')), five)
check('an unknown target changes nothing', ids(moveTab(five5, 'a', 'zz')), five)
check('the input list is not mutated', ids(five5), five)
check('moving the last to first', ids(moveTab(five5, 'e', 'a')), ['e', 'a', 'b', 'c', 'd'])
check('moving the first to last', ids(moveTab(five5, 'a', 'e')), ['b', 'c', 'd', 'e', 'a'])
check(
  'a single-item list: the only move possible is a no-op onto itself',
  ids(moveTab([{ id: 'only' }], 'only', 'only')),
  ['only']
)

console.log('\na paused tab is an ordinary member of the list')
check(
  'closing a paused tab selects its neighbour like any other',
  neighbourOf(['live', 'paused', 'other'], 'paused'),
  'other'
)
check(
  'resuming replaces the paused tab at its own index, so nothing reorders',
  replaceOrAppend([{ id: 'a' }, { id: 'paused' }, { id: 'c' }], { id: 'live' }, 'paused'),
  [{ id: 'a' }, { id: 'live' }, { id: 'c' }]
)


/*
 * "Start again", after a session exits.
 *
 * The remote case is the reason this is a pure function at all. `restartTab`
 * used to start every tab locally with `cwd: tab.cwd`, and a remote tab's `cwd`
 * is the host alias rather than a path — so Start again on a dropped VPS
 * session ran a local `claude` in a folder named `vps`. Nothing in this repo
 * could catch that: it was a closure in App.tsx calling an IPC method, which is
 * gotcha 31's shape exactly.
 */
console.log('\n"Start again" restarts a tab the way it was started')
check(
  'a local tab restarts locally, in its own folder',
  restartPlan({ cwd: '/Users/x/dev/stoke', hostId: null }, ['host-1']),
  { kind: 'local', cwd: '/Users/x/dev/stoke' }
)
check(
  'a remote tab reconnects to its host, NOT to a local folder named after the alias',
  restartPlan({ cwd: 'vps', hostId: 'host-1' }, ['host-1', 'host-2']),
  { kind: 'host', hostId: 'host-1' }
)
check(
  'a remote tab whose host was deleted is impossible, not silently local',
  restartPlan({ cwd: 'vps', hostId: 'host-9' }, ['host-1']).kind,
  'impossible'
)
check(
  'and it says why, because the alias is not a folder and never was',
  restartPlan({ cwd: 'vps', hostId: 'host-9' }, []).kind === 'impossible',
  true
)
check(
  'no hosts configured at all does not turn a remote tab into a local one',
  restartPlan({ cwd: 'vps', hostId: 'host-1' }, []).kind,
  'impossible'
)
check(
  'an empty hostId is a local tab, not a broken remote one',
  restartPlan({ cwd: '/tmp/scratch', hostId: '' }, ['host-1']),
  { kind: 'local', cwd: '/tmp/scratch' }
)

/*
 * Moving a live session onto a newly-installed CLI without losing the chat.
 *
 * The condition is not "an update exists" but "this session is running a
 * different binary from the one on disk", and those are different states: an
 * update that has been *installed* leaves every open session behind, silently,
 * with nothing on screen saying so. Every refusal below carries a reason,
 * because a button that is simply absent is indistinguishable from one that is
 * broken — and four of these six refusals are permanent for that tab, so
 * "wait and it will appear" is the wrong thing for a user to conclude.
 */
console.log('\nwhether a live session can be moved onto the installed CLI')

const live = (over: Partial<Parameters<typeof relaunchPlan>[0]['tab'] & object> = {}) => ({
  kind: 'session' as const,
  status: 'running' as const,
  sessionId: 'sess-1',
  hostId: null,
  ...over
})

check(
  'a running local session on an older binary is offered the swap',
  relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251' }),
  { kind: 'offer', running: '2.1.237', installed: '2.1.251', sessionId: 'sess-1' }
)
check(
  'and it is not offered when the two already match',
  relaunchPlan({ tab: live(), running: '2.1.251', installed: '2.1.251' }).kind,
  'none'
)

/*
 * The two sources state a version in two different formats, and this pair is
 * the assertion that matters most in this file.
 *
 * `CliInfo.version` is `stdout.trim()` from `claude --version` — the whole
 * line, `"2.1.237 (Claude Code)"`. The statusLine payload's `version` is the
 * bare `"2.1.237"`. Comparing them raw is false for equal versions, so the
 * offer appeared on every session on every machine, permanently, inviting a
 * relaunch onto the binary already running. It passed every unit test written
 * before it, because both sides of those tests were bare numbers; it was found
 * by launching the built app against a shimmed `claude` and reading the value
 * back out of `window.stoke.cli.info()`. Gotcha 31, again.
 */
check(
  'the raw `--version` line and the payload\'s bare number are the SAME version',
  relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.237 (Claude Code)' }).kind,
  'none'
)
check(
  'and a real difference still shows through the same noise',
  relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251 (Claude Code)' }),
  { kind: 'offer', running: '2.1.237', installed: '2.1.251', sessionId: 'sess-1' }
)
check(
  'the offer carries numbers, not sentences — the pill renders `installed` verbatim',
  relaunchPlan({ tab: live(), running: '2.1.237 (Claude Code)', installed: '2.1.251 (Claude Code)' }),
  { kind: 'offer', running: '2.1.237', installed: '2.1.251', sessionId: 'sess-1' }
)
/*
 * A prerelease tail is part of the version, not noise to strip. Two builds
 * differing only there are different binaries, and collapsing them would
 * suppress a legitimate offer.
 */
check(
  'a prerelease tail is kept, so a beta and its release are not confused',
  relaunchPlan({ tab: live(), running: '2.1.251-beta.1', installed: '2.1.251' }).kind,
  'offer'
)
check(
  'a version-less string is "not known", not a string to compare',
  relaunchPlan({ tab: live(), running: '2.1.237', installed: 'command not found' }).kind,
  'none'
)
/*
 * Direction is deliberately not tested. The question is "is this chat on the
 * binary that is installed", and a downgrade — `claude install 2.1.236`, or a
 * stable channel that rolled back under you — leaves a session ahead of the
 * disk just as surely as an update leaves it behind. Both are the same repair.
 */
check(
  'a session AHEAD of the disk is offered it too — a channel can move backwards',
  relaunchPlan({ tab: live(), running: '2.1.251', installed: '2.1.236' }).kind,
  'offer'
)

/*
 * An SSH tab runs `claude` on the far machine (gotcha 18), so a local update is
 * not its update. It gets no statusLine wrapper either (gotcha 2), so `running`
 * is null in practice — asserted with a version present as well, to pin that
 * the refusal is the host and not the missing reading. Those two produce very
 * different sentences and only one of them is true.
 */
check(
  'a remote session is never offered a local version',
  relaunchPlan({ tab: live({ hostId: 'host-1' }), running: '2.1.237', installed: '2.1.251' }).kind,
  'none'
)
check(
  'and it says so, rather than blaming a reading that was never going to arrive',
  relaunchPlan({
    tab: live({ hostId: 'host-1' }),
    running: null,
    installed: '2.1.251'
  }).reason?.includes('another machine'),
  true
)

/*
 * A --continue session's id is chosen by the CLI after launch, so Stoke has
 * nothing to pass to --resume (gotcha 26). Relaunching without one would open
 * the most recent session in the folder, which is USUALLY this one and
 * occasionally is not — and silently resuming the wrong conversation is far
 * worse than not offering.
 */
check(
  'a session with no id is refused rather than resumed by guesswork',
  relaunchPlan({ tab: live({ sessionId: '' }), running: '2.1.237', installed: '2.1.251' }).kind,
  'none'
)

/*
 * "Not known yet" and "nothing to do" must not be the same answer. A session
 * that has not rendered a status line yet legitimately has no version, and
 * that is a wait; the others are not.
 */
check(
  'no reading yet is a refusal, not a claim that it is current',
  relaunchPlan({ tab: live(), running: null, installed: '2.1.251' }).kind,
  'none'
)
check(
  'nor is an unreadable install treated as agreement',
  relaunchPlan({ tab: live(), running: '2.1.237', installed: null }).kind,
  'none'
)

/*
 * Exited and paused tabs already have a button that spawns a fresh process,
 * and a fresh process picks up whatever is installed by construction. A second
 * offer would be a third way to do one thing.
 */
for (const [article, status] of [['an', 'exited'], ['a', 'paused']] as const) {
  check(
    `${article} ${status} tab is left to its own button, which already starts the installed version`,
    relaunchPlan({ tab: live({ status }), running: '2.1.237', installed: '2.1.251' }).kind,
    'none'
  )
}
check(
  'a New Project tab has no session to move',
  relaunchPlan({ tab: live({ kind: 'new' }), running: '2.1.237', installed: '2.1.251' }).kind,
  'none'
)
check('and neither does no tab at all', relaunchPlan({ tab: null, running: '2.1.237', installed: '2.1.251' }).kind, 'none')

/*
 * The tally is the LAST thing in this file, and it has to stay that way.
 *
 * It used to sit two thirds of the way up, immediately after the tab-list
 * arithmetic, with the "Start again" section below it. `process.exitCode` is
 * assigned once, so every assertion after that line could print FAIL and still
 * exit 0 — measured, by forcing one: the run printed `all pass`, then `FAIL`,
 * then exited 0, and `npm run check` went green. Six restartPlan assertions
 * were unfalsifiable for as long as that ordering stood, which is the exact
 * shape CLAUDE.md keeps warning about: a suite that cannot fail is worse than
 * no suite, because it is also a claim that the thing was checked.
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
