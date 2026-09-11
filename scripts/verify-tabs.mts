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
  focusAfterStart,
  moveTab,
  nearestSlot,
  neighbourOf,
  paneOrder,
  pastSlop,
  previewShift,
  previewSlot,
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
