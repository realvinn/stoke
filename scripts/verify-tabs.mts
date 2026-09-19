/*
 * Tab list arithmetic: which tab is selected when one closes, and where a
 * dragged tab lands. Both are pure list operations that were written inline in
 * a React callback, where the only way to check them was to click.
 *
 *   node scripts/verify-tabs.mts
 */
import {
  autoscrollVelocity,
  AUTOSCROLL_MAX_PX_S,
  AUTOSCROLL_ZONE_PX,
  clampDrag,
  cycleTab,
  dragView,
  focusAfterStart,
  moveTab,
  nearestSlot,
  neighbourOf,
  paneOrder,
  pastSlop,
  previewShift,
  previewSlot,
  relaunchPlan,
  revealDelta,
  stillOver,
  replaceOrAppend,
  adoptRemoteTab,
  restartPlan,
  autoRelaunchKey,
  autoRelaunchStep,
  busyTabIds,
  looksTyped,
  moveKey,
  pendingRelaunchStep,
  rebindTabs,
  continuePlan,
  newTabToReuse,
  tabLabel
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

console.log('\nadoptRemoteTab: a phone Resume takes the ended twin\'s place')
{
  type T = { id: string; kind: string; ptyId: string | null; sessionId: string; status: string }
  const ended: T = { id: 'old', kind: 'session', ptyId: 'p-old', sessionId: 'S', status: 'exited' }
  const other: T = { id: 'o', kind: 'session', ptyId: 'p-o', sessionId: 'X', status: 'running' }
  const live: T = { id: 'p-new', kind: 'session', ptyId: 'p-new', sessionId: 'S', status: 'running' }
  const adopted = adoptRemoteTab([ended, other], live)
  check('replaces the exited tab on the same id, in place', adopted.list.map((t) => t.id), ['p-new', 'o'])
  check('and names the tab it replaced, so selection can follow', adopted.replacedId, 'old')
  check(
    'one tab per session id afterwards',
    adopted.list.filter((t) => t.sessionId === 'S').length,
    1
  )
  const paused = { ...ended, status: 'paused' }
  check('a paused (restored, never started) twin is replaced too', adoptRemoteTab([paused], live).list.map((t) => t.id), ['p-new'])
  const running = { ...ended, status: 'running' }
  check(
    'a RUNNING tab on that id is never replaced (the server refuses that resume anyway)',
    adoptRemoteTab([running], live).list.map((t) => t.id),
    ['old', 'p-new']
  )
  check('a new session with no twin is appended', adoptRemoteTab([other], live).list.map((t) => t.id), ['o', 'p-new'])
  check('the same pty twice is a no-op', adoptRemoteTab([live], live).list.length, 1)
}

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
  { kind: 'local', cwd: '/Users/x/dev/stoke', cli: 'claude' }
)
/*
 * The CLI travels with the plan, and the default direction is what protects
 * every caller that predates the field: a tab with no `cliId` is a Claude tab,
 * because every tab written before this existed was one.
 */
check(
  'a tab that does not name a CLI restarts as Claude Code',
  restartPlan({ cwd: '/tmp/x', hostId: null }, []).kind === 'local' &&
    (restartPlan({ cwd: '/tmp/x', hostId: null }, []) as { cli: string }).cli,
  'claude'
)
check(
  'a Codex tab restarts as Codex, not as claude in the same folder',
  restartPlan({ cwd: '/tmp/x', hostId: null, cliId: 'codex' }, []),
  { kind: 'local', cwd: '/tmp/x', cli: 'codex' }
)
check(
  'an install tab runs its installs again — never the first agent in its list, which may have just failed to install',
  restartPlan({ cwd: '/Users/x', hostId: null, cliId: 'codex', installing: ['codex', 'pi'] }, []),
  { kind: 'install', ids: ['codex', 'pi'] }
)
check(
  'a corrupted cli id restarts as Claude Code rather than spawning it',
  restartPlan({ cwd: '/tmp/x', hostId: null, cliId: 'banana' as never }, []),
  { kind: 'local', cwd: '/tmp/x', cli: 'claude' }
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
  { kind: 'local', cwd: '/tmp/scratch', cli: 'claude' }
)

/*
 * The relaunch pill against a session that is not Claude Code.
 *
 * This matters more than it looks. The pill's whole action is
 * `claude --resume <id>`, so an offer on a Codex tab does not fail — it
 * SUCCEEDS, replacing a Codex session with a Claude one in the same tab, on one
 * click. The refusal also has to come before the no-id branch: a Codex tab has
 * no session id either, and being told "this session was continued rather than
 * started" is a sentence about a Claude flag, offered for a tab not running
 * Claude.
 */
console.log('\nthe relaunch pill never offers to relaunch another CLI as claude')
for (const cli of ['codex', 'opencode', 'grok'] as const) {
  const plan = relaunchPlan({
    tab: { kind: 'session', status: 'running', sessionId: '', hostId: null, cliId: cli },
    running: '2.1.237',
    installed: '9.9.9 (Claude Code)'
  })
  check(`${cli} is refused`, plan.kind, 'none')
  check(
    `${cli}'s refusal names the CLI, not Claude's --continue`,
    plan.kind === 'none' && /Stoke does not update/.test(plan.reason) && !/continued/.test(plan.reason),
    true
  )
}
check(
  'a Claude tab with the same shape is still offered, so the guard is not a blanket refusal',
  relaunchPlan({
    tab: { kind: 'session', status: 'running', sessionId: 'abc', hostId: null, cliId: 'claude' },
    running: '2.1.237',
    installed: '9.9.9 (Claude Code)'
  }).kind,
  'offer'
)
check(
  'and a tab that names no CLI is treated as Claude, so nothing that predates the field changed',
  relaunchPlan({
    tab: { kind: 'session', status: 'running', sessionId: 'abc', hostId: null },
    running: '2.1.237',
    installed: '9.9.9 (Claude Code)'
  }).kind,
  'offer'
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
  { kind: 'offer', running: '2.1.237', installed: '2.1.251', sessionId: 'sess-1', fresh: false, busy: null }
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
  { kind: 'offer', running: '2.1.237', installed: '2.1.251', sessionId: 'sess-1', fresh: false, busy: null }
)
check(
  'the offer carries numbers, not sentences — the pill renders `installed` verbatim',
  relaunchPlan({ tab: live(), running: '2.1.237 (Claude Code)', installed: '2.1.251 (Claude Code)' }),
  { kind: 'offer', running: '2.1.237', installed: '2.1.251', sessionId: 'sess-1', fresh: false, busy: null }
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
 * The CLI's own registry (`~/.claude/sessions/<pid>.json`) states two things
 * the plan used to guess at: which session the process is on NOW, and whether
 * a turn is running. Both were measured wrong in the running app before this:
 * a tab launched as 6b80feb4 whose process, registry, payload and every hook
 * said 39db23cb after a `/clear`, and a relaunch that killed a turn mid-reply.
 */
console.log('\nthe relaunch follows the session the process is on now, and knows when it is busy')
const reading = (over: Partial<{ sessionId: string | null; busy: boolean | null; version: string | null }> = {}) => ({
  sessionId: 'sess-1',
  busy: false as boolean | null,
  version: '2.1.237' as string | null,
  ...over
})
check(
  'a drifted id: after a /clear the registry names the new session, and that is what comes back',
  (() => {
    const p = relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251', live: reading({ sessionId: 'after-clear' }) })
    return p.kind === 'offer' ? p.sessionId : p.reason
  })(),
  'after-clear'
)
check(
  'a --continue tab (no id of its own) is offered once the registry names its session — gotcha 26',
  (() => {
    const p = relaunchPlan({ tab: live({ sessionId: '' }), running: null, installed: '2.1.251', live: reading({ sessionId: 'real-id' }) })
    return p.kind === 'offer' ? p.sessionId : p.reason
  })(),
  'real-id'
)
check(
  "the registry's version is the running binary, stated before any payload",
  relaunchPlan({ tab: live(), running: null, installed: '2.1.251', live: reading() }).kind,
  'offer'
)
check(
  'and it outranks a payload that says otherwise — they differ exactly when the payload is stale',
  relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251', live: reading({ version: '2.1.251' }) }).kind,
  'none'
)
check(
  'a registry reading with no version falls back to the payload',
  relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251', live: reading({ version: null }) }).kind,
  'offer'
)
check(
  'a turn in flight is carried on the offer, so the pill can ask instead of killing it',
  (() => {
    const p = relaunchPlan({ tab: live(), running: null, installed: '2.1.251', live: reading({ busy: true }) })
    return p.kind === 'offer' && p.busy
  })(),
  true
)
check(
  'no registry reading is "cannot say", never idle',
  (() => {
    const p = relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251' })
    return p.kind === 'offer' ? p.busy : 'none'
  })(),
  null
)
check(
  'no transcript yet: the offer is fresh — the same id starts again rather than --resume, which would exit 1',
  (() => {
    const p = relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251', hasTranscript: () => false })
    return p.kind === 'offer' && p.fresh
  })(),
  true
)
check(
  'the transcript is asked about for the id that will be relaunched, not the id the tab was launched with',
  (() => {
    const asked: string[] = []
    relaunchPlan({
      tab: live(),
      running: '2.1.237',
      installed: '2.1.251',
      live: reading({ sessionId: 'after-clear' }),
      hasTranscript: (id) => (asked.push(id), false)
    })
    return asked
  })(),
  ['after-clear']
)
check(
  'an unknown transcript is not "fresh": only a stated absence is',
  (() => {
    const p = relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251', hasTranscript: () => null })
    return p.kind === 'offer' && p.fresh
  })(),
  false
)

console.log('\na relaunch waiting for its turn to end')
const offer = (busy: boolean | null) =>
  relaunchPlan({ tab: live(), running: '2.1.237', installed: '2.1.251', live: reading({ busy }) })
const none = relaunchPlan({ tab: null, running: null, installed: null })
check('busy: keep waiting', pendingRelaunchStep({ origin: 'user', plan: offer(true), inFront: true, typedSinceSubmit: false }), 'wait')
check('cannot say: keep waiting — unknown is not permission', pendingRelaunchStep({ origin: 'user', plan: offer(null), inFront: false, typedSinceSubmit: false }), 'wait')
check('idle: fire', pendingRelaunchStep({ origin: 'user', plan: offer(false), inFront: false, typedSinceSubmit: false }), 'fire')
check(
  'Wait, chosen by the user, fires even on the tab in front and with a draft — they chose it looking at it',
  pendingRelaunchStep({ origin: 'user', plan: offer(false), inFront: true, typedSinceSubmit: true }),
  'fire'
)
check(
  'the tab exited or closed while waiting: dropped, never fired later on something else',
  pendingRelaunchStep({ origin: 'user', plan: none, inFront: false, typedSinceSubmit: false }),
  'drop'
)
check(
  'an automatic one hands back to the pill the moment its tab is in front',
  pendingRelaunchStep({ origin: 'auto', plan: offer(false), inFront: true, typedSinceSubmit: false }),
  'drop'
)
check(
  'or once something has been typed and not sent — idle does not prove the prompt box is empty',
  pendingRelaunchStep({ origin: 'auto', plan: offer(false), inFront: false, typedSinceSubmit: true }),
  'drop'
)

console.log('\nthe automatic relaunch (Settings: relaunch idle sessions in the background)')
const auto = (over: Partial<Parameters<typeof autoRelaunchStep>[0]> = {}) =>
  autoRelaunchStep({
    mode: 'auto',
    plan: offer(false),
    inFront: false,
    alreadyTried: false,
    pending: false,
    relaunching: false,
    typedSinceSubmit: false,
    ...over
  })
check('an idle background session is relaunched', auto(), 'relaunch')
check('a busy one is queued until idle', auto({ plan: offer(true) }), 'queue')
check('one that cannot say is queued too, never relaunched blind', auto({ plan: offer(null) }), 'queue')
check('never with the setting on ask', auto({ mode: 'ask' }), 'skip')
check('never the tab in front — someone may be typing into it', auto({ inFront: true }), 'skip')
check('never a tab with a draft in its prompt box', auto({ typedSinceSubmit: true }), 'skip')
check(
  'never twice for one session and version — a relaunch that comes back on the old binary must not loop',
  auto({ alreadyTried: true }),
  'skip'
)
check('never one already queued or mid-relaunch', [auto({ pending: true }), auto({ relaunching: true })], ['skip', 'skip'])
check('nothing to offer, nothing to do', auto({ plan: none }), 'skip')
check(
  'the one-attempt key is the session and the version it was sent to',
  autoRelaunchKey({ sessionId: 's', installed: '2.1.251' }) === autoRelaunchKey({ sessionId: 's', installed: '2.1.252' }),
  false
)

console.log('\nwhich tabs a restart would interrupt')
const liveTabs = [
  { id: 't1', kind: 'session', status: 'running', ptyId: 'p1' },
  { id: 't2', kind: 'session', status: 'running', ptyId: 'p2' },
  { id: 't3', kind: 'session', status: 'running', ptyId: 'p3' },
  { id: 't4', kind: 'session', status: 'exited', ptyId: 'p4' },
  { id: 't5', kind: 'new', status: 'running', ptyId: '' }
]
check(
  'only a stated busy counts; idle, unknown, exited and new tabs do not',
  busyTabIds(liveTabs, { p1: { busy: true }, p2: { busy: false }, p3: { busy: null }, p4: { busy: true } }),
  ['t1']
)

console.log('\na rebind moves the tab, and only the tab, onto the new id')
const strip = [
  { id: 'a', ptyId: 'p1', sessionId: 'old' },
  { id: 'b', ptyId: 'p2', sessionId: 'other' }
]
check('the tab on that pty takes the new id', rebindTabs(strip, 'p1', 'new').map((t) => t.sessionId), ['new', 'other'])
check('an unknown pty changes nothing, and returns the same list', rebindTabs(strip, 'p9', 'new') === strip, true)
check('the same id changes nothing', rebindTabs(strip, 'p1', 'old') === strip, true)
check('per-session state moves to the new key', moveKey({ old: 1, x: 2 }, 'old', 'new'), { x: 2, new: 1 })
check('but never over a newer entry already there', moveKey({ old: 1, new: 9 }, 'old', 'new'), { new: 9 })
const same = { x: 1 }
check('nothing to move is the same object', moveKey(same, 'old', 'new') === same, true)

console.log('\nwhat counts as typing into the prompt box')
check('letters are typing', looksTyped('hello'), true)
check('a paste is typing — its bracket markers are escapes, its body is not', looksTyped('\x1b[200~fix the bug\x1b[201~'), true)
check('Enter alone is not', looksTyped('\r'), false)
check('backspace is not', looksTyped('\x7f'), false)
check('focus reports are not — xterm sends them on every tab switch', looksTyped('\x1b[I\x1b[O'), false)
check('an SGR mouse report is not', looksTyped('\x1b[<0;12;7M\x1b[<0;12;7m'), false)
check('an answer to a colour query is not', looksTyped('\x1b]11;rgb:1818/1717/1616\x1b\\'), false)
check('arrows in application mode are not', looksTyped('\x1bOA\x1bOB'), false)
check('a device-attributes reply is not', looksTyped('\x1b[?1;2c'), false)
check('Alt+b (word back) is not — ESC and one character', looksTyped('\x1bb'), false)
check('but text after an escape still is', looksTyped('\x1b[Dfix'), true)

console.log('\ncycling the strip wraps rather than stopping')
check('next from the middle', cycleTab(five, 'c', 1), 'd')
check('previous from the middle', cycleTab(five, 'c', -1), 'b')
check('next from the last wraps to the first', cycleTab(five, 'e', 1), 'a')
check('previous from the first wraps to the last', cycleTab(five, 'a', -1), 'e')
check('one tab cycles to itself', cycleTab(['a'], 'a', 1), 'a')
check('an empty strip has nowhere to go', cycleTab([], 'a', 1), null)
/*
 * The first render has no selection at all — the mount effect picks tabs[0]
 * afterwards — so an unknown id must land somewhere rather than nowhere, or
 * the first press of the chord after launch does nothing.
 */
check('no selection goes to the first tab', cycleTab(five, null, 1), 'a')
check('and backwards to the last', cycleTab(five, null, -1), 'e')

/*
 * Which tab is selected once a start resolves.
 *
 * `Resume all` fires one start per paused tab, concurrently, and each one used
 * to call setActiveTabId(newId) unconditionally when its own PTY came up — so
 * the selected tab was whichever `pty.start` resolved LAST. Whatever you were
 * looking at, including a live session you were typing into, was taken away a
 * second or two after the press by a race.
 *
 * The rule is asserted rather than the outcome: focus is unconditional for a
 * single start (you pressed a button, show me the thing), and for a bulk one it
 * follows only if the tab being replaced was already selected — because a
 * resumed tab is a NEW object with a new id, so leaving the selection alone
 * would otherwise leave it naming a tab that no longer exists.
 */
console.log('\nwhere the selection lands after a session starts')

// `focusAfterStart` takes React's setter, so the assertions drive it through a
// stand-in that records what the updater computed.
function focused(current: string | null, newId: string, replaced: string | null, focus?: boolean): string {
  let out = current
  focusAfterStart((update) => { out = update(out) }, newId, replaced, focus)
  return out as string
}

check('a single start focuses its new tab', focused('a', 'new', 'b'), 'new')
check(
  'even when it replaces the tab you were on',
  focused('b', 'new', 'b'),
  'new'
)
check(
  'a bulk start leaves an unrelated selection alone',
  focused('a', 'new', 'b', false),
  'a'
)
check(
  'but follows the one tab it replaced under you, which no longer exists',
  focused('b', 'new', 'b', false),
  'new'
)
check(
  'three bulk resumes in one tick cannot steal the selection between them',
  ['x', 'y', 'z'].reduce((sel, id) => focused(sel, `${id}-live`, id, false), 'untouched'),
  'untouched'
)
check(
  'and with nothing selected there is still something to select',
  focused(null, 'new', 'b', false),
  'new'
)

/*
 * The Chrome-style drag.
 *
 * It replaced HTML5 drag-and-drop, where a neighbour only moved once the
 * POINTER was past its centre and then teleported a slot, because each swap
 * was a committed reorder. Now the strip shows a preview with transforms and
 * commits `moveTab` once, on release — so the one property that matters most is
 * that the preview and the commit agree. If they did not, the settle animation
 * would carry every tab to where the preview said and the commit would then
 * put one somewhere else: a jump at the exact moment the drag ends.
 *
 * Only the maths is here. The wiring — pointer capture, Escape in the window's
 * capture phase, the FLIP settle, the terminal keeping focus — is side effects
 * in closures (gotcha 31) and is proven over CDP against the built app.
 */
console.log('\nthe drag preview is exactly the reorder it commits')
{
  let agree = 0
  let permutations = 0
  let total = 0
  for (let from = 0; from < five5.length; from++) {
    for (let to = 0; to < five5.length; to++) {
      total++
      const preview: ({ id: string } | undefined)[] = new Array(five5.length)
      five5.forEach((tab, i) => {
        preview[previewSlot(i, from, to)] = tab
      })
      const filled = new Set(five5.map((_, i) => previewSlot(i, from, to)))
      if (filled.size === five5.length && preview.every(Boolean)) permutations++
      const committed = moveTab(five5, five5[from].id, five5[to].id)
      if (JSON.stringify(ids(preview as { id: string }[])) === JSON.stringify(ids(committed))) agree++
    }
  }
  check(`for all ${total} (from, to) on five tabs, the preview order equals moveTab's`, agree, total)
  check('and every preview puts exactly one tab in every slot', permutations, total)
}
check('the dragged tab itself shifts 0 — it follows the pointer, not a slot', previewShift(1, 1, 3), 0)
check('dragging right: a passed neighbour closes the gap leftwards', previewShift(2, 1, 3), -1)
check('dragging right: the tab now under the dragged one goes too', previewShift(3, 1, 3), -1)
check('dragging right: nothing past the target moves', previewShift(4, 1, 3), 0)
check('dragging left: the target makes room rightwards', previewShift(1, 3, 1), 1)
check('dragging left: nothing before the target moves', previewShift(0, 3, 1), 0)
check('no move, no shift', [0, 1, 2, 3, 4].map((i) => previewShift(i, 2, 2)), [0, 0, 0, 0, 0])

/*
 * Geometry as the strip really lays it out at Interface scale 1: 12rem tabs,
 * a 4px gap, so slots every 196px. Fractional on purpose in the second half —
 * rects, not integer offsetLeft, are what the drag measures, so a 1.1 scale's
 * 211.2px tabs must not round a swap a pixel early.
 */
console.log('\nwhere a dragged tab lands')
const slotLefts = [0, 196, 392, 588, 784]
const TAB_W = 192
const centres = slotLefts.map((l) => l + TAB_W / 2)
check('a tab at rest is its own nearest slot', slotLefts.map((l) => nearestSlot(centres, l + TAB_W / 2)), [0, 1, 2, 3, 4])
check('just short of half a slot rightwards stays put', nearestSlot(centres, centres[1] + 97.9), 1)
check('just past half a slot rightwards takes the next one', nearestSlot(centres, centres[1] + 98.1), 2)
check('just past half a slot leftwards takes the previous one', nearestSlot(centres, centres[1] - 98.1), 0)
check('exactly halfway is a tie, and a tie goes to the lower slot', nearestSlot(centres, centres[1] + 98), 1)
check('no slots, no answer', nearestSlot([], 50), -1)
{
  /*
   * The old rule depended on where the tab was grabbed: 0.5 to 1.5 tab widths
   * of travel before anything moved. The dragged tab's own centre is what is
   * measured now, and the grab offset cancels out of it.
   */
  const from = 1
  const landings = [5, 60, 120, 187].map((grab) => {
    const pressX = slotLefts[from] + grab
    const left = clampDrag(pressX + 99 - grab, slotLefts)
    return nearestSlot(centres, left + TAB_W / 2)
  })
  check('the same travel swaps at the same point wherever the tab was grabbed', landings, [2, 2, 2, 2])
}
{
  // Interface scale 1.1: 211.2px tabs and 4.4px gaps, so the midpoint between
  // the first two slots is 107.8px out — which integer offsets would put at 108.
  const scaled = [0, 215.6, 431.2, 646.8]
  const scaledCentres = scaled.map((l) => l + 105.6)
  check(
    'fractional slots swap at their own midpoint, not a rounded one',
    [107.7, 107.9].map((d) => nearestSlot(scaledCentres, scaledCentres[0] + d)),
    [0, 1]
  )
}
check('a drag inside the strip is not clamped', clampDrag(300, slotLefts), 300)
check('dragging past the first slot holds at the first', clampDrag(-80, slotLefts), 0)
check('dragging past the last slot holds at the last', clampDrag(9000, slotLefts), 784)
check('a strip of one holds its tab still', clampDrag(40, [12]), 12)
check(
  'held at the far end, the dragged tab still takes the last slot',
  nearestSlot(centres, clampDrag(5000, slotLefts) + TAB_W / 2),
  4
)
{
  /*
   * An overflowing strip: the lifted tab is held inside the part on screen as
   * well as inside its slots. Held by the slots alone, a tab dragged to the
   * edge to autoscroll sat half past it and was clipped for the whole scroll —
   * 52 of 112px out of sight, measured in the running app.
   */
  const view = { start: 100, end: 700, width: TAB_W }
  check('a view holds the lifted tab off the hidden end', clampDrag(9000, slotLefts, view), 508)
  check('and its far edge is exactly the visible edge', clampDrag(9000, slotLefts, view) + TAB_W, 700)
  check('a view holds it off the hidden start', clampDrag(-80, slotLefts, view), 100)
  check('inside the view nothing is clamped', clampDrag(300, slotLefts, view), 300)
  check(
    'a view showing the whole strip changes nothing',
    [-80, 300, 9000].map((l) => clampDrag(l, slotLefts, { start: 0, end: 976, width: TAB_W })),
    [-80, 300, 9000].map((l) => clampDrag(l, slotLefts))
  )
  check(
    'a view narrower than the tab is ignored, not inverted',
    clampDrag(9000, slotLefts, { start: 100, end: 250, width: TAB_W }),
    784
  )
  // As autoscroll carries the view to the end, the held tab reaches the last slot.
  const scrolled = [0, 100, 200, 300].map((s) =>
    nearestSlot(centres, clampDrag(9000, slotLefts, { start: s, end: s + 676, width: TAB_W }) + TAB_W / 2)
  )
  check('held at the edge while the strip scrolls, it walks through the slots to the last', scrolled, [2, 3, 3, 4])
}
{
  /*
   * A tab the strip's edge cuts in half. Held by the visible part alone it
   * leapt the whole hidden width as the press became a drag — 56px out from
   * under a pointer that had moved 4, measured in the running app. The view it
   * is held in takes in its own slot, so it follows the pointer from where it
   * was and still goes no further out than that.
   */
  const w = 112
  const lefts = [0, 116, 232, 348, 464, 580, 696, 812, 928, 1044]
  // A 600px view scrolled to 500: slot 9 (1044-1156) is 56px past its end at 1100.
  const home = lefts[9]
  const view = dragView(500, 600, home, w)
  check('a slot already on screen widens nothing', dragView(500, 600, lefts[6], w), { start: 500, end: 1100, width: w })
  check('a half-hidden tab at the end is not yanked in as it lifts', clampDrag(home - 4, lefts, view), home - 4)
  check('nor held short of the slot it started in', clampDrag(home, lefts, view), home)
  check('and goes no further out than that', clampDrag(home + 60, lefts, view), home)
  // Slot 5 (580-692) is 52px past a 640px view at scroll 0.
  check(
    'mid-strip, pushed outwards it stops at its own slot',
    clampDrag(9000, lefts, dragView(0, 640, lefts[5], w)) + w,
    692
  )
  check(
    'and once the view has scrolled past that slot, the view holds it again',
    clampDrag(9000, lefts, dragView(100, 640, lefts[5], w)) + w,
    740
  )
  const cutStart = dragView(260, 600, lefts[2], w) // slot 2 (232-344) is 28px before 260
  check('likewise at the start: not yanked', clampDrag(lefts[2] + 3, lefts, cutStart), lefts[2] + 3)
  check('and no further out than its slot', clampDrag(-500, lefts, cutStart), lefts[2])

  /*
   * The allowance is for where the tab started, and ends at each edge the
   * moment the tab is wholly inside it. Kept for the whole drag, a tab pressed
   * half behind the right edge, dragged to the left edge while the strip
   * scrolled back, then dragged back past the right edge ran straight out of
   * sight — wholly behind the + button in the running app, for as long as
   * autoscroll took to bring its old slot back.
   */
  const long = Array.from({ length: 16 }, (_, i) => i * 116)
  const slot12 = long[12] // 1392-1504; a 600px view at scroll 848 ends at 1448, 56px short
  let over = stillOver({ start: true, end: true }, slot12 - 4, w, 848, 600)
  check('pressed half behind the end, only the end still hangs out', over, { start: false, end: true })
  check(
    'while it hangs out, the end keeps its allowance',
    stillOver(over, slot12 - 20, w, 848, 600),
    { start: false, end: true }
  )
  const inside = clampDrag(900, long, dragView(848, 600, slot12, w, over))
  over = stillOver(over, inside, w, 848, 600)
  check('dragged wholly inside, the allowance is gone', over, { start: false, end: false })
  // The strip autoscrolls back 465px while it is held at the start; then back past the end.
  const back = clampDrag(9000, long, dragView(383, 600, slot12, w, over))
  check('coming back past the end, it is held at the visible edge, not its old slot', back + w, 983)
  check(
    'where the allowance kept for the whole drag would have let it out of sight',
    clampDrag(9000, long, dragView(383, 600, slot12, w)) >= 983,
    true
  )
  check(
    'and a tab that starts on screen has no allowance at all',
    stillOver({ start: true, end: true }, long[9], w, 848, 600),
    { start: false, end: false }
  )
}

console.log('\nthe tab a drag puts down is on screen')
check('a tab already in view needs no scroll', revealDelta(200, 312, 100, 700), 0)
check('flush with both edges is still in view', [revealDelta(100, 212, 100, 700), revealDelta(588, 700, 100, 700)], [0, 0])
check('half past the end scrolls forward by exactly the hidden part', revealDelta(644, 756, 100, 700), 56)
check('half before the start scrolls back by exactly the hidden part', revealDelta(44, 156, 100, 700), -56)
check('a span wider than the view lines up at its start', revealDelta(150, 900, 100, 700), 50)

console.log('\na press becomes a drag only past the slop')
check('3px is still a click', pastSlop(3, 0), false)
check('just past 3px is a drag', pastSlop(3.01, 0), true)
check('diagonal travel is measured as distance, not per axis', pastSlop(2, 2), false)
check('and counts once it is far enough', pastSlop(3, 3), true)
check('straight down onto the terminal is a drag too, so the strip claims it', pastSlop(0, -4), true)

console.log('\nautoscroll near the strip\'s edges')
const view = { start: 100, end: 700 }
check('the middle of the strip does not scroll', autoscrollVelocity(400, view.start, view.end), 0)
check(
  'the edge of the zone is still zero, so the ramp starts from rest',
  autoscrollVelocity(view.start + AUTOSCROLL_ZONE_PX, view.start, view.end),
  0
)
check(
  'halfway into the start zone scrolls back at half speed',
  autoscrollVelocity(view.start + AUTOSCROLL_ZONE_PX / 2, view.start, view.end),
  -AUTOSCROLL_MAX_PX_S / 2
)
check(
  'at the end edge it scrolls forwards at full speed',
  autoscrollVelocity(view.end, view.start, view.end),
  AUTOSCROLL_MAX_PX_S
)
check(
  'past the end, off the strip, it keeps full speed rather than stopping',
  autoscrollVelocity(view.end + 300, view.start, view.end),
  AUTOSCROLL_MAX_PX_S
)
check(
  'and past the start likewise, backwards',
  autoscrollVelocity(view.start - 300, view.start, view.end),
  -AUTOSCROLL_MAX_PX_S
)
check('a strip too narrow to have a middle never scrolls', autoscrollVelocity(110, 100, 140), 0)

/*
 * The terminal panes render in an order that does not follow the strip, so a
 * reorder moves no pane's DOM node and cannot blur the xterm you are typing in.
 */
console.log('\nreordering the strip never moves a terminal pane')
{
  const tabsFor = (order: string[]) =>
    order.map((id) => ({ id, kind: id.startsWith('new') ? 'new' : 'session' }))
  const base = ['s3', 'new-1', 's1', 's4', 's2']
  const want = ids(paneOrder(tabsFor(base)))
  let same = 0
  let moves = 0
  for (let from = 0; from < base.length; from++) {
    for (let to = 0; to < base.length; to++) {
      moves++
      const moved = moveTab(tabsFor(base), base[from], base[to])
      if (JSON.stringify(ids(paneOrder(moved))) === JSON.stringify(want)) same++
    }
  }
  check(`all ${moves} reorders of the strip leave the pane order untouched`, same, moves)
  check('New Project tabs have no pane', want.includes('new-1'), false)
  check('every session tab has one', want.length, 4)
  const input = tabsFor(base)
  paneOrder(input)
  check('the strip itself is not re-sorted', ids(input), base)
  check(
    'opening a tab inserts its pane without reordering the others',
    ids(paneOrder(tabsFor([...base, 's0']))).filter((id) => id !== 's0'),
    want
  )
}

console.log('\ncontinuePlan: the launcher\'s Continue never starts a twin (QA L2)')
{
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  const running = {
    id: 't1',
    kind: 'session',
    status: 'running',
    sessionId: 's-new',
    cwd: '/p/proj-a',
    cliId: 'claude' as const,
    hostId: null
  }
  check(
    'with the list loaded, Continue resumes the newest conversation BY ID',
    continuePlan({ sessions: [{ id: 's-new' }, { id: 's-old' }], loading: false, tabs: [running], cwd: '/p/proj-a', cli: 'claude', samePath: same }),
    { kind: 'resume', sessionId: 's-new' }
  )
  check(
    'still loading, a running tab of that agent in that folder is focused, not twinned',
    continuePlan({ sessions: [], loading: true, tabs: [running], cwd: '/P/proj-a', cli: 'claude', samePath: same }),
    { kind: 'focus', tabId: 't1' }
  )
  check(
    'still loading, a Codex tab in the folder does not stop a Claude --continue',
    continuePlan({ sessions: [], loading: true, tabs: [{ ...running, cliId: 'codex' }], cwd: '/p/proj-a', cli: 'claude', samePath: same }),
    { kind: 'continue' }
  )
  check(
    'still loading, an exited tab is not focused',
    continuePlan({ sessions: [], loading: true, tabs: [{ ...running, status: 'exited' }], cwd: '/p/proj-a', cli: 'claude', samePath: same }),
    { kind: 'continue' }
  )
  check(
    'still loading, an SSH tab whose alias equals the folder is not focused (gotcha 18)',
    continuePlan({ sessions: [], loading: true, tabs: [{ ...running, hostId: 'h1' }], cwd: '/p/proj-a', cli: 'claude', samePath: same }),
    { kind: 'continue' }
  )
  check(
    'loaded and empty, there is nothing to continue',
    continuePlan({ sessions: [], loading: false, tabs: [], cwd: '/p/proj-a', cli: 'claude', samePath: same }),
    { kind: 'none' }
  )
}

console.log('\nnewTabToReuse: a palette pick reuses a New tab (QA L17)')
check('the active New tab first', newTabToReuse([{ id: 'n1', kind: 'new' }, { id: 'n2', kind: 'new' }], 'n2'), 'n2')
check(
  'with a session in front, the first idle New tab in the strip',
  newTabToReuse([{ id: 's1', kind: 'session' }, { id: 'n1', kind: 'new' }], 's1'),
  'n1'
)
check('with no New tab anywhere, null (append one)', newTabToReuse([{ id: 's1', kind: 'session' }], 's1'), null)
check(
  'a background New tab with staged choices (Bypass) is not reused for another folder',
  newTabToReuse(
    [{ id: 's1', kind: 'session' }, { id: 'n1', kind: 'new', launch: { permissionMode: 'bypassPermissions' } }, { id: 'n2', kind: 'new' }],
    's1'
  ),
  'n2'
)
check(
  '…and with only that one, a fresh tab is appended',
  newTabToReuse([{ id: 's1', kind: 'session' }, { id: 'n1', kind: 'new', launch: { model: 'sonnet' } }], 's1'),
  null
)
check(
  'the New tab in front is reused whatever it has staged: its chips are on screen',
  newTabToReuse([{ id: 'n1', kind: 'new', launch: { model: 'sonnet' } }], 'n1'),
  'n1'
)

console.log('\ntabLabel: tabs say which project and which agent (QA L16)')
check(
  'a New tab aimed at a project names it',
  tabLabel({ kind: 'new', title: 'New session', cliId: 'claude' }, 'stoke'),
  { text: 'New · stoke', agentTag: null }
)
check(
  'a New tab aimed nowhere keeps its title',
  tabLabel({ kind: 'new', title: 'New session', cliId: 'claude' }, null),
  { text: 'New session', agentTag: null }
)
check(
  'a Codex tab is tagged codex',
  tabLabel({ kind: 'session', title: 'proj-a', cliId: 'codex' }, null),
  { text: 'proj-a', agentTag: 'codex' }
)
check(
  'a Claude tab carries no tag',
  tabLabel({ kind: 'session', title: 'proj-a', cliId: 'claude' }, null),
  { text: 'proj-a', agentTag: null }
)
check(
  'an install tab is not tagged as the agent it installs',
  tabLabel({ kind: 'session', title: 'Installing Codex CLI', cliId: 'codex', installing: ['codex'] }, null),
  { text: 'Installing Codex CLI', agentTag: null }
)

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
