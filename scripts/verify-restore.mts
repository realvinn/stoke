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
import type { ContextSnapshot, StoredTab, StoredTabs } from '../src/shared/types.ts'
import { fromStored, toStored } from '../src/renderer/src/lib/restore.ts'
import type { Tab } from '../src/renderer/src/types.ts'

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

console.log('\norder and active-tab identity')
{
  // File order [A, B, C], but C is the most recent — the common case, since the
  // focused tab is usually the most recently used. Recency must decide only
  // which tabs get dropped over the cap, never the order tabs come back in.
  const out = normaliseTabs(
    state({
      activeIndex: 2,
      tabs: [
        tab({ sessionId: 'A', lastActiveAt: NOW - 3000 }),
        tab({ sessionId: 'B', lastActiveAt: NOW - 2000 }),
        tab({ sessionId: 'C', lastActiveAt: NOW - 1000 })
      ]
    }),
    NOW
  )
  check('tabs come back in file order, not recency order', out.tabs.map((t) => t.sessionId), ['A', 'B', 'C'])
  check(
    'activeIndex still names the same tab by identity, not the same number for the wrong reason',
    out.tabs[out.activeIndex]?.sessionId,
    'C'
  )
}
{
  const out = normaliseTabs(
    state({
      activeIndex: 0,
      tabs: [
        tab({ sessionId: 'stale', lastActiveAt: NOW - STORED_TAB_MAX_AGE_MS - 1 }),
        tab({ sessionId: 'fresh', lastActiveAt: NOW })
      ]
    }),
    NOW
  )
  check('an active tab dropped by the age filter falls back to index 0', out.activeIndex, 0)
  check('and the survivor there is the tab that was not expired', out.tabs[out.activeIndex]?.sessionId, 'fresh')
}
{
  const many = Array.from({ length: MAX_STORED_TABS + 5 }, (_, i) =>
    tab({ sessionId: `s${i}`, lastActiveAt: NOW - i * 1000 })
  )
  const out = normaliseTabs(state({ tabs: many, activeIndex: many.length - 1 }), NOW)
  check('an active tab dropped by the MAX_STORED_TABS cap falls back to index 0', out.activeIndex, 0)
}

console.log('\nunion fields are validated, not cast')
{
  const out = normaliseTabs(state({ tabs: [{ ...tab(), permissionMode: 'sudo', effort: 'ultra' }] }), NOW)
  check('an unrecognised permissionMode falls back to default', out.tabs[0]?.permissionMode, 'default')
  check('an unrecognised effort falls back to default', out.tabs[0]?.effort, 'default')
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

console.log('\nconverting between the tab list and the snapshot')
{
  const live: Tab[] = [
    {
      id: 'p1', kind: 'session', ptyId: 'p1', sessionId: 'sess-a', cwd: '/w/stoke',
      projectName: 'stoke', title: 'live one', permissionMode: 'default', model: '',
      effort: 'default', status: 'running', exitCode: null, hostId: null,
      selectedPath: null, expandedPath: null
    },
    {
      id: 'new-1', kind: 'new', ptyId: '', sessionId: '', cwd: '', projectName: '',
      title: 'New session', permissionMode: 'default', model: '', effort: 'default',
      status: 'running', exitCode: null, hostId: null,
      selectedPath: '/w/other', expandedPath: null
    }
  ]
  const snapA: ContextSnapshot = {
    sessionId: 'sess-a',
    contextTokens: 10,
    contextLimit: 200,
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    model: null,
    messageCount: 1,
    title: null,
    updatedAt: NOW,
    ready: true,
    permissionMode: 'default'
  }
  const snap = toStored(live, 'new-1', { 'sess-a': snapA }, () => 'SCREEN', NOW)
  check('the active tab is recorded by index', snap.activeIndex, 1)
  check('a live tab keeps its screen', snap.tabs.find((t) => t.sessionId === 'sess-a')?.screen, 'SCREEN')
  check('and its context reading', snap.tabs.find((t) => t.sessionId === 'sess-a')?.context, { tokens: 10, limit: 200 })
  check('a New tab keeps its selection', snap.tabs.find((t) => t.kind === 'new')?.selectedPath, '/w/other')

  const back = fromStored(snap)
  check('every restored session tab is paused', back.tabs.filter((t) => t.kind === 'session').every((t) => t.status === 'paused'), true)
  check('and carries no pty', back.tabs.every((t) => t.ptyId === ''), true)
  check('a restored New tab is not paused, it has nothing to resume', back.tabs.find((t) => t.kind === 'new')?.status, 'running')
  check('the active id points at a tab that exists', back.tabs.some((t) => t.id === back.activeId), true)
  check('restored ids are unique', new Set(back.tabs.map((t) => t.id)).size, back.tabs.length)
}
{
  const back = fromStored({ version: 1, savedAt: NOW, activeIndex: 0, tabs: [] })
  check('an empty snapshot restores nothing and selects nothing', [back.tabs.length, back.activeId], [0, null])
}

console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exit(failures ? 1 : 0)
