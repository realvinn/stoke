/*
 * The tab-restore store: what survives a quit, what is trimmed, and what a
 * corrupt file does. Pure — no electron, no window — so it runs anywhere.
 *
 *   node scripts/verify-restore.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SCREEN_BYTES,
  MAX_STORED_TABS,
  STORED_TAB_MAX_AGE_MS,
  normaliseTabs,
  readTabState,
  tabStateFile,
  trimScreen,
  writeTabState
} from '../src/main/tabStore.ts'
import type { StoredTab, StoredTabs } from '../src/shared/types.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}

const NOW = 1_760_000_000_000

function tab(over: Partial<StoredTab> = {}): StoredTab {
  return {
    kind: 'session',
    sessionId: 'sess-1',
    cwd: '/w/stoke',
    projectName: 'stoke',
    title: 'a title',
    permissionMode: 'default',
    model: '',
    effort: 'default',
    hostId: null,
    selectedPath: null,
    expandedPath: null,
    lastActiveAt: NOW,
    context: null,
    screen: '',
    ...over
  }
}

function state(over: Partial<StoredTabs> = {}): StoredTabs {
  return { version: 1, savedAt: NOW, activeIndex: 0, tabs: [tab()], ...over }
}

console.log('\nround trip')
{
  const dir = mkdtempSync(join(tmpdir(), 'stoke-restore-'))
  const file = tabStateFile(dir)
  const s = state({
    activeIndex: 1,
    tabs: [
      tab({ sessionId: 'a', context: { tokens: 62104, limit: 200000 }, screen: 'one\ntwo' }),
      tab({ sessionId: 'b', kind: 'new', cwd: '', selectedPath: '/w/x' })
    ]
  })
  writeTabState(file, s)
  check('a saved list comes back unchanged, context included', readTabState(file, NOW), s)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\ncaps')
{
  const many = Array.from({ length: MAX_STORED_TABS + 5 }, (_, i) =>
    tab({ sessionId: `s${i}`, lastActiveAt: NOW - i * 1000 })
  )
  const out = normaliseTabs(state({ tabs: many }), NOW)
  check('over-cap lists are cut to the cap', out.tabs.length, MAX_STORED_TABS)
  check('and it is the oldest that go', out.tabs.at(-1)?.sessionId, `s${MAX_STORED_TABS - 1}`)
}
{
  const long = `${'x'.repeat(200)}\n`.repeat(200)
  const trimmed = trimScreen(long)
  check('a huge screen is trimmed under the byte cap', trimmed.length <= MAX_SCREEN_BYTES, true)
  check('it is trimmed on a line boundary', trimmed.startsWith('x'), true)
  check('and it keeps the tail, not the head', long.endsWith(trimmed), true)
}

console.log('\nexpiry')
{
  const out = normaliseTabs(
    state({
      tabs: [
        tab({ sessionId: 'fresh', lastActiveAt: NOW - 13 * 24 * 60 * 60 * 1000 }),
        tab({ sessionId: 'stale', lastActiveAt: NOW - STORED_TAB_MAX_AGE_MS - 1 })
      ]
    }),
    NOW
  )
  check('a tab inside the age window is kept', out.tabs.map((t) => t.sessionId), ['fresh'])
}

console.log('\ncorruption is never fatal')
{
  const dir = mkdtempSync(join(tmpdir(), 'stoke-restore-'))
  const file = tabStateFile(dir)
  const empty: StoredTabs = { version: 1, savedAt: 0, activeIndex: 0, tabs: [] }
  check('a missing file reads as empty', readTabState(file, NOW), empty)
  for (const [name, body] of [
    ['truncated json', '{"version":1,"tabs":[{'],
    ['a BOM', '﻿{"version":1,"savedAt":0,"activeIndex":0,"tabs":[]}'],
    ['null', 'null'],
    ['an array at the root', '[]'],
    ['a future version', '{"version":99,"savedAt":0,"activeIndex":0,"tabs":[]}']
  ] as const) {
    writeFileSync(file, body, 'utf8')
    check(`${name} reads as empty`, readTabState(file, NOW), empty)
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log('\nwhat it drops')
{
  const out = normaliseTabs(
    { version: 1, savedAt: NOW, activeIndex: 0, tabs: [{ ...tab(), ptyId: 'p1', status: 'running', id: 'x', bogus: 1 }] },
    NOW
  )
  check('runtime-only and unknown keys are not carried forward', Object.keys(out.tabs[0]).sort(), Object.keys(tab()).sort())
}
{
  const out = normaliseTabs(state({ activeIndex: 99 }), NOW)
  check('an out-of-range activeIndex is clamped', out.activeIndex, 0)
}
{
  const out = normaliseTabs(state({ tabs: [tab({ kind: 'session', cwd: '' })] }), NOW)
  check('a session tab with no folder is dropped, it can never be resumed', out.tabs, [])
}

console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exit(failures ? 1 : 0)
