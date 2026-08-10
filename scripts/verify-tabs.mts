/*
 * Tab list arithmetic: which tab is selected when one closes, and where a
 * dragged tab lands. Both are pure list operations that were written inline in
 * a React callback, where the only way to check them was to click.
 *
 *   node scripts/verify-tabs.mts
 */
import { neighbourOf } from '../src/renderer/src/lib/tabs.ts'

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

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
