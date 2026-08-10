/*
 * Tab list arithmetic: which tab is selected when one closes, and where a
 * dragged tab lands. Both are pure list operations that were written inline in
 * a React callback, where the only way to check them was to click.
 *
 *   node scripts/verify-tabs.mts
 */
import { moveTab, neighbourOf, replaceOrAppend } from '../src/renderer/src/lib/tabs.ts'

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

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
