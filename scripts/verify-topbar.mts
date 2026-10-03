/*
 * The title bar's own items (shared/topBar.ts): the settings block's default
 * and repair, the editor's moves, what a text shortcut may type into, what the
 * folder chip says, and how the bar gives way on a narrow window.
 *
 * Pure throughout. The wires — a click reaching the pty, a drag, the measurer
 * feeding `fitTopBar` — are gotcha 31's and are proven in the built app.
 *
 *   node scripts/verify-topbar.mts
 */
import {
  addRefusal,
  clampTopBar,
  FOLDER_PATH_MAX,
  fitTopBar,
  folderChip,
  isSingleEmoji,
  labelFromText,
  mintItemId,
  nudgeItem,
  pathTail,
  removeItem,
  SHORTCUT_LABEL_MAX,
  SHORTCUT_TEXT_BUDGET,
  SHORTCUT_TEXT_MAX,
  shortcutDraftProblem,
  shortcutFromDraft,
  shortcutCost,
  shortcutVerdict,
  tabsFloorPx,
  topBarKeep,
  DRAG_GAP_REM,
  TOP_BAR_DEFAULTS,
  TOP_BAR_MAX_ITEMS,
  type FitItem,
  type ShortcutTarget,
  type TopBarItem
} from '../src/shared/topBar.ts'
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'
import { LOCAL_KEYS, PORTABLE_KEYS } from '../src/shared/setupFile.ts'
import { T1_KEYS, MAX_ITEM_PLAINTEXT_BYTES, itemPlaintextText } from '../src/shared/hub/items.ts'
import { PRIVATE_FOLDER_TEXT } from '../src/shared/privateChat.ts'
import { readFileSync } from 'node:fs'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

const kinds = (items: readonly TopBarItem[]): string[] => items.map((i) => `${i.kind}:${i.id}`)

/* ------------------------------------------------------- default and repair */

console.log('the default: on, with git alone')
{
  // Git alone since 2026-10-03: the owner asked for the folder chip gone (it is one Add away).
  check('TOP_BAR_DEFAULTS', TOP_BAR_DEFAULTS, {
    enabled: true,
    items: [{ id: 'git', kind: 'git' }]
  })
  check('a missing block is the default', clampTopBar(undefined), TOP_BAR_DEFAULTS)
  check('junk is the default', [clampTopBar(7), clampTopBar('x'), clampTopBar([])], [TOP_BAR_DEFAULTS, TOP_BAR_DEFAULTS, TOP_BAR_DEFAULTS])
  check('the default is a copy, never the constant itself', clampTopBar(null).items === TOP_BAR_DEFAULTS.items, false)
  check('a file from before the key hydrates to the default', hydrateSettings({}).topBar, TOP_BAR_DEFAULTS)
  check('a hand-edited junk block is repaired at hydrate, not spread through', [hydrateSettings({ topBar: 7 }).topBar, hydrateSettings({ topBar: { enabled: true, items: [{ id: 'w', kind: 'widget' }] } }).topBar], [
    TOP_BAR_DEFAULTS,
    { enabled: true, items: [] }
  ])
  check('DEFAULT_SETTINGS carries it', DEFAULT_SETTINGS.topBar, TOP_BAR_DEFAULTS)
  check('turned off stays off', clampTopBar({ enabled: false, items: [] }), { enabled: false, items: [] })
  check('only a literal false turns it off', clampTopBar({ enabled: 0, items: [] }).enabled, true)
  check('an emptied bar stays empty (nobody refills it)', clampTopBar({ enabled: true, items: [] }).items, [])
  check('items that are not an array are no items', clampTopBar({ enabled: true, items: { a: 1 } }).items, [])
}

console.log('\nrepair: rebuilt from named keys')
{
  const r = clampTopBar({
    enabled: true,
    items: [
      { id: 'f1', kind: 'folder', style: 'name', extra: 'dropped' },
      { id: 'f2', kind: 'folder', style: 'path' },
      { id: 'g1', kind: 'git', parts: 'x' },
      { id: 'g2', kind: 'git' },
      { id: 'sp', kind: 'spacer' },
      { id: 'sp', kind: 'spacer' },
      { id: 'bad id!', kind: 'spacer' },
      { id: '', kind: 'spacer' },
      { kind: 'spacer' },
      { id: 'w', kind: 'widget' },
      null,
      7
    ]
  })
  check('a second folder and a second git are dropped; a duplicate id, a bad id and an unknown kind too', kinds(r.items), [
    'folder:f1',
    'git:g1',
    'spacer:sp'
  ])
  check('a field the clamp does not name is not kept', Object.keys(r.items[0]), ['id', 'kind', 'style'])
  check('a junk folder style is the path', clampTopBar({ items: [{ id: 'f', kind: 'folder', style: 'huge' }] }).items, [
    { id: 'f', kind: 'folder', style: 'path' }
  ])
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, kind: 'spacer' }))
  check(`at most ${TOP_BAR_MAX_ITEMS} items`, clampTopBar({ items: many }).items.length, TOP_BAR_MAX_ITEMS)
}

console.log('\nrepair: shortcuts')
{
  const one = (raw: Record<string, unknown>): unknown => clampTopBar({ items: [{ id: 's', kind: 'shortcut', ...raw }] }).items[0] ?? null
  check('a shortcut with no text is dropped', [one({ label: 'x', text: '' }), one({ label: 'x', text: '   \n' }), one({ label: 'x' })], [null, null, null])
  check('the whole shape, send and scope defaulting off and any', one({ label: 'Tests', text: 'run the tests' }), {
    id: 's',
    kind: 'shortcut',
    label: 'Tests',
    icon: '',
    text: 'run the tests',
    send: false,
    on: 'any'
  })
  check('only a literal true sends', [one({ text: 'a', send: 'yes' }), one({ text: 'a', send: 1 })].map((s) => (s as { send: boolean }).send), [false, false])
  check('only the literal claude narrows the scope', (one({ text: 'a', on: 'Claude' }) as { on: string }).on, 'any')
  check('a label-less shortcut is named from its first non-blank line', (one({ text: '\n  fix the build\nthen test' }) as { label: string }).label, 'fix the build')
  check(`a long label is cut to ${SHORTCUT_LABEL_MAX} code points`, Array.from((one({ text: 'a', label: '🙂'.repeat(40) }) as { label: string }).label).length, SHORTCUT_LABEL_MAX)
  check(`text is cut to ${SHORTCUT_TEXT_MAX} code points, never mid-pair`, (() => {
    const t = (one({ text: '😀'.repeat(SHORTCUT_TEXT_MAX + 10) }) as { text: string }).text
    return [Array.from(t).length, t.endsWith('😀')]
  })(), [SHORTCUT_TEXT_MAX, true])
  check('one emoji is an icon', (one({ text: 'a', icon: '🚀' }) as { icon: string }).icon, '🚀')
  check('two emoji, a letter, or junk is no icon', [one({ text: 'a', icon: '🚀🚀' }), one({ text: 'a', icon: 'x' }), one({ text: 'a', icon: 5 })].map((s) => (s as { icon: string }).icon), ['', '', ''])
  check('a skin tone, a ZWJ sequence and a flag are each one emoji', [isSingleEmoji('👍🏽'), isSingleEmoji('🧑‍💻'), isSingleEmoji('🇦🇺')], [true, true, true])
  check('nor is an empty string', isSingleEmoji(''), false)
  check('labelFromText cuts the first line', labelFromText('a'.repeat(50)).length, SHORTCUT_LABEL_MAX)
}

console.log('\nthe block fits one hub item')
{
  /*
   * The block travels as ONE T1 item and an item is at most 128 KiB of
   * plaintext. The worst a hand-edited file can hold: every item a shortcut at
   * the length cap, in three-byte characters with quotes and backslashes that
   * JSON escapes.
   */
  const worst = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    kind: 'shortcut',
    label: '漢"'.repeat(20),
    icon: '🧑‍💻',
    text: '漢"\\\n'.repeat(SHORTCUT_TEXT_MAX),
    send: true,
    on: 'claude'
  }))
  const kept = clampTopBar({ enabled: true, items: worst })
  const bytes = new TextEncoder().encode(JSON.stringify(kept)).length
  check('shortcuts past the text budget are dropped from the end', kept.items.length < worst.length && kept.items.length > 0, true)
  check(`the clamped worst case is under MAX_ITEM_PLAINTEXT_BYTES (${bytes} bytes)`, bytes < MAX_ITEM_PLAINTEXT_BYTES, true)
  check('the budget is what is spent', kept.items.reduce((n, i) => n + (i.kind === 'shortcut' ? shortcutCost(i.text) : 0), 0) <= SHORTCUT_TEXT_BUDGET, true)

  /*
   * Measured the way `sealItem` measures it (`itemPlaintextText`), and with
   * the worst escape there is: a control character is one UTF-8 byte and six
   * in the item (`\u0001`). Counted in raw bytes, 24 such shortcuts fit the
   * budget and made a 288 KB item — and an oversize item throws inside the
   * hub upload's batch, failing every other setting's sync with it.
   */
  const asItem = (value: unknown): number =>
    new TextEncoder().encode(itemPlaintextText({ path: 't1/settings/topBar', editedAt: 1_790_000_000_000, deleted: false, value })).length
  const control = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`,
    kind: 'shortcut',
    label: '\u0001'.repeat(40),
    icon: '🧑‍💻',
    text: '\u0001'.repeat(SHORTCUT_TEXT_MAX),
    send: true,
    on: 'claude'
  }))
  const keptControl = clampTopBar({ enabled: true, items: control })
  check(`control characters: the clamped block fits one hub item (${asItem(keptControl)} bytes)`, asItem(keptControl) < MAX_ITEM_PLAINTEXT_BYTES, true)
  check('and so does the CJK worst case, measured as the item', asItem(kept) < MAX_ITEM_PLAINTEXT_BYTES, true)
  check('a control character costs its escape, a plain one its byte', [shortcutCost('\u0001'), shortcutCost('a'), shortcutCost('"')], [8, 3, 4])
  check(
    'the form refuses what the repair would drop: the same count',
    shortcutDraftProblem({ label: 'x', icon: '', text: '\u0001'.repeat(SHORTCUT_TEXT_MAX), send: false, on: 'any' }, Array.from({ length: 4 }, () => '\u0001'.repeat(SHORTCUT_TEXT_MAX))) !== null,
    true
  )
}

console.log('\nhydrate is idempotent here (gotcha 116)')
{
  const raw = {
    topBar: {
      enabled: true,
      items: [
        { id: 'git', kind: 'git' },
        { id: 'shortcut-abc123', kind: 'shortcut', label: '', text: 'run the tests\nand fix them', send: true, on: 'claude', icon: '🧪' },
        { id: 'spacer-x', kind: 'spacer' },
        { id: 'folder', kind: 'folder', style: 'name' }
      ]
    }
  }
  const once = hydrateSettings(raw).topBar
  check('twice equals once', hydrateSettings(JSON.parse(JSON.stringify({ topBar: once }))).topBar, once)
  check('and nothing is minted by a read', once.items.map((i) => i.id), ['git', 'shortcut-abc123', 'spacer-x', 'folder'])
}

console.log('\nwhere it travels')
{
  check('topBar is portable (setup file and hub sync)', (PORTABLE_KEYS as readonly string[]).includes('topBar'), true)
  check('and not local', (LOCAL_KEYS as readonly string[]).includes('topBar'), false)
  check('so it is a T1 hub item', T1_KEYS.includes('topBar'), true)
}

/* ------------------------------------------------------------- the editor */

console.log('\nediting')
{
  const items: TopBarItem[] = [
    { id: 'a', kind: 'folder', style: 'path' },
    { id: 'b', kind: 'git' },
    { id: 'c', kind: 'spacer' }
  ]
  check('Alt+Right moves one step right', nudgeItem(items, 'a', 1).map((i) => i.id), ['b', 'a', 'c'])
  check('Alt+Left moves one step left', nudgeItem(items, 'c', -1).map((i) => i.id), ['a', 'c', 'b'])
  check('at either end it stays', [nudgeItem(items, 'a', -1).map((i) => i.id), nudgeItem(items, 'c', 1).map((i) => i.id)], [
    ['a', 'b', 'c'],
    ['a', 'b', 'c']
  ])
  check('an unknown id changes nothing', nudgeItem(items, 'zz', 1).map((i) => i.id), ['a', 'b', 'c'])
  check('the input is not mutated', items.map((i) => i.id), ['a', 'b', 'c'])
  check('Delete focuses the right neighbour', removeItem(items, 'b'), { items: [items[0], items[2]], focus: 'c' })
  check('or the left one at the end', removeItem(items, 'c').focus, 'b')
  check('and nothing when the bar empties', removeItem([items[0]], 'a'), { items: [], focus: null })
  check('a second folder is refused', addRefusal('folder', items) !== null, true)
  check('a second git is refused', addRefusal('git', items) !== null, true)
  check('spaces and shortcuts are not', [addRefusal('spacer', items), addRefusal('shortcut', items)], [null, null])
  check('a full bar refuses anything', addRefusal('spacer', Array.from({ length: TOP_BAR_MAX_ITEMS }, (_, i) => ({ id: `s${i}`, kind: 'spacer' as const }))) !== null, true)
  let n = 0
  const seq = [0.5, 0.5, 0.25]
  const id = mintItemId('shortcut', [{ id: mintItemId('shortcut', [], () => 0.5), kind: 'spacer' }], () => seq[n++] ?? 0.1)
  check('a minted id never repeats one in the bar', id !== mintItemId('shortcut', [], () => 0.5), true)
  check('and survives the repair (a valid id)', clampTopBar({ items: [{ id, kind: 'spacer' }] }).items.length, 1)
}

console.log('\nthe shortcut form')
{
  const d = { label: 'Tests', icon: '', text: 'run them', send: false, on: 'claude' as const }
  check('a plain draft saves', shortcutDraftProblem(d), null)
  check('no text is refused', shortcutDraftProblem({ ...d, text: '  ' }) !== null, true)
  check('an over-long label is refused, not cut silently', shortcutDraftProblem({ ...d, label: 'x'.repeat(SHORTCUT_LABEL_MAX + 1) }) !== null, true)
  check('an over-long text is refused', shortcutDraftProblem({ ...d, text: 'x'.repeat(SHORTCUT_TEXT_MAX + 1) }) !== null, true)
  check('an icon that is not one emoji is refused', shortcutDraftProblem({ ...d, icon: 'ab' }) !== null, true)
  check('the budget counts the other shortcuts', shortcutDraftProblem(d, ['x'.repeat(SHORTCUT_TEXT_BUDGET)]) !== null, true)
  check('send stays as ticked: off by default', shortcutFromDraft('s1', d).send, false)
  check('a blank label is named from the text', shortcutFromDraft('s1', { ...d, label: ' ' }).label, 'run them')
  check('and the saved item is exactly what the repair keeps', clampTopBar({ items: [shortcutFromDraft('s1', { ...d, send: true, icon: '🧪' })] }).items, [
    shortcutFromDraft('s1', { ...d, send: true, icon: '🧪' })
  ])
}

/* ---------------------------------------------- what a shortcut may type into */

console.log('\nwhat a shortcut may type into')
{
  const claude: ShortcutTarget = { kind: 'session', status: 'running', cliId: 'claude', utility: false, dot: null }
  const ok = (r: ReturnType<typeof shortcutVerdict>): boolean => r.ok
  check('a running Claude tab takes either scope', [ok(shortcutVerdict({ on: 'claude' }, claude)), ok(shortcutVerdict({ on: 'any' }, claude))], [true, true])
  check('no tab, or a New tab, takes nothing', [ok(shortcutVerdict({ on: 'any' }, null)), ok(shortcutVerdict({ on: 'any' }, { ...claude, kind: 'new' }))], [false, false])
  check('another machine’s session takes nothing', ok(shortcutVerdict({ on: 'any' }, { ...claude, kind: 'remote' })), false)
  check('a paused or exited tab takes nothing', [ok(shortcutVerdict({ on: 'any' }, { ...claude, status: 'paused' })), ok(shortcutVerdict({ on: 'any' }, { ...claude, status: 'exited' }))], [false, false])
  check('an install, key or sign-in tab takes nothing', ok(shortcutVerdict({ on: 'any' }, { ...claude, utility: true })), false)
  check('a Codex tab takes an any-tab shortcut and refuses a Claude one', [ok(shortcutVerdict({ on: 'any' }, { ...claude, cliId: 'codex' })), ok(shortcutVerdict({ on: 'claude' }, { ...claude, cliId: 'codex' }))], [true, false])
  const waiting = shortcutVerdict({ on: 'any' }, { ...claude, dot: 'waiting' })
  check('a tab waiting on a question refuses, and says why (keys would answer it)', [waiting.ok, !waiting.ok && /answer/i.test(waiting.reason)], [false, true])
  check('a working tab takes it (Claude queues a typed message)', ok(shortcutVerdict({ on: 'any' }, { ...claude, dot: 'working' })), true)
}

/* ---------------------------------------------------------- the folder chip */

console.log('\nthe folder chip')
{
  const local = { kind: 'session' as const, cwd: '/Users/me/dev/personal/stoke', hostId: null }
  const opts = { style: 'path' as const, hostLabel: null, deviceLabel: null }
  check('a local tab: its path, its name compact, openable', folderChip(local, opts), {
    text: '/Users/me/dev/personal/stoke',
    compact: 'stoke',
    title: 'Open /Users/me/dev/personal/stoke',
    open: '/Users/me/dev/personal/stoke',
    where: 'local'
  })
  check('name style shows the name', folderChip(local, { ...opts, style: 'name' })?.text, 'stoke')
  const ssh = folderChip({ kind: 'session', cwd: 'vps', hostId: 'host-1' }, { ...opts, hostLabel: 'My VPS' })
  check('an SSH tab names its host and is NEVER openable (its cwd is an alias, gotcha 18)', [ssh?.text, ssh?.open, ssh?.where], ['My VPS', null, 'host'])
  check('an SSH tab with no label names the alias, still not openable', [folderChip({ kind: 'session', cwd: 'vps', hostId: 'h' }, opts)?.text, folderChip({ kind: 'session', cwd: 'vps', hostId: 'h' }, opts)?.open], ['vps', null])
  check('another machine’s session names that machine', folderChip({ kind: 'remote', cwd: '/x', hostId: null }, { ...opts, deviceLabel: 'Desk' })?.text, 'Desk')
  check('a New tab, no tab, or no folder draws nothing', [folderChip({ kind: 'new', cwd: '', hostId: null }, opts), folderChip(null, opts), folderChip({ kind: 'session', cwd: '', hostId: null }, opts)], [null, null, null])
  check('a Windows path: the name is its last segment', folderChip({ kind: 'session', cwd: 'C:\\Users\\me\\code\\app', hostId: null }, opts)?.compact, 'app')
  /*
   * A private chat's cwd is Stoke's scratch folder (shared/privateChat.ts):
   * driven on the merged build, the chip drew `…/<uuid>` and its Open put
   * Finder on a folder deleted with the chat — and at 940 px it took the room
   * the tab's own title needed ("Pr…").
   */
  const priv = folderChip({ kind: 'session', cwd: '/Users/me/Library/Application Support/Stoke/private/1b2c', hostId: null, private: true }, opts)
  check('a private chat says so and is NEVER openable', priv, {
    text: 'Private chat',
    compact: 'Private',
    title: PRIVATE_FOLDER_TEXT,
    open: null,
    where: 'private'
  })
  check('whichever style the chip is set to', folderChip({ kind: 'session', cwd: '/x/private/1b2c', hostId: null, private: true }, { ...opts, style: 'name' })?.text, 'Private chat')
  check(
    'a host label of only spaces names the alias (Settings stores labels as typed), as the tab menu does',
    folderChip({ kind: 'session', cwd: 'vps', hostId: 'h' }, { ...opts, hostLabel: '   ' })?.text,
    'vps'
  )
  check('a padded label is trimmed', folderChip({ kind: 'session', cwd: 'vps', hostId: 'h' }, { ...opts, hostLabel: ' My VPS ' })?.text, 'My VPS')
  {
    const bar = readFileSync(new URL('../src/renderer/src/components/TopBar.tsx', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    check('the bar hands the chip the tab\u2019s private flag', /private: tab\.private/.test(bar), true)
    check('and never asks git about a private chat\u2019s folder', /const local = [^\n]*!tab\.private/.test(bar), true)
    check(
      'App opens the chip\u2019s folder through revealFolder, so a folder that has gone says so (revealProblem)',
      /<TopBar[\s\S]*?onReveal=\{revealFolder\}/.test(app),
      true
    )
  }
  check('a short path is whole', pathTail('/a/b/c'), '/a/b/c')
  const long = '/Users/someone/dev/personal/clients/acme/monorepo/packages/web'
  const tail = pathTail(long)
  check(`a long one keeps its tail, cut at a separator, within ${FOLDER_PATH_MAX}`, [tail.startsWith('…/'), long.endsWith(tail.slice(1)), Array.from(tail).length <= FOLDER_PATH_MAX], [true, true, true])
  check('the last segment is kept whole however long', pathTail(`/a/${'x'.repeat(60)}`), `…/${'x'.repeat(60)}`)
  check('a Windows path is cut at backslashes', pathTail('C:\\Users\\someone\\dev\\personal\\clients\\acme\\monorepo\\web').startsWith('…\\'), true)
}

/* ----------------------------------------------------- giving way on width */

console.log('\ngiving way on a narrow window')
{
  const items: FitItem[] = [
    { id: 'folder', kind: 'folder', full: 200, compact: 60 },
    { id: 'git', kind: 'git', full: 140, compact: 70 },
    { id: 'sp', kind: 'spacer', full: 0, compact: 0 },
    { id: 's1', kind: 'shortcut', full: 80, compact: 80 },
    { id: 's2', kind: 'shortcut', full: 90, compact: 90 }
  ]
  const fit = (room: number): unknown => fitTopBar({ room, gap: 4, fixed: 28, more: 28, items })
  // full: 200+140+0+80+90 + 28 (pencil) + 5 gaps of 4 = 558
  check('everything in full when it fits', fit(558), { compact: [], overflow: [], hidden: [] })
  // folder as its name: 60+140+0+80+90+28+20 = 418
  check('a pixel short: the folder goes to its name first, git keeps its changes', fit(557), { compact: ['folder'], overflow: [], hidden: [] })
  check('still in: the folder alone did it', fit(418), { compact: ['folder'], overflow: [], hidden: [] })
  // and git as its branch: 60+70+0+80+90+28+20 = 348
  check('then git goes to its branch', fit(417), { compact: ['folder', 'git'], overflow: [], hidden: [] })
  check('then the LAST shortcut goes into »', fit(347), { compact: ['folder', 'git'], overflow: ['s2'], hidden: [] })
  // compact, s2 out: 60+70+0+80 +28 +28(»)+ gaps(folder,git,sp,s1,pencil,» = 5 gaps)=20 → 286
  check('until it fits', fit(286), { compact: ['folder', 'git'], overflow: ['s2'], hidden: [] })
  check('then the next, in display order', fit(285), { compact: ['folder', 'git'], overflow: ['s1', 's2'], hidden: [] })
  check('then git is left out', fit(150), { compact: ['folder', 'git'], overflow: ['s1', 's2'], hidden: ['git'] })
  check('and last the folder', fit(10), { compact: ['folder', 'git'], overflow: ['s1', 's2'], hidden: ['folder', 'git'] })
  check('an empty bar always fits', fitTopBar({ room: 30, gap: 4, fixed: 28, more: 28, items: [] }), { compact: [], overflow: [], hidden: [] })
  check('a bar of spaces needs only its gaps', fitTopBar({ room: 40, gap: 4, fixed: 28, more: 28, items: [{ id: 'a', kind: 'spacer', full: 0, compact: 0 }] }).compact, [])
  const squeezable: FitItem[] = [
    { ...items[0], min: 64 },
    { ...items[1], min: 80 },
    items[2],
    items[3],
    items[4]
  ]
  // squeezed, both shortcuts out: 60(min 64 → 60)+70(min 80 → 70)... compact already under min: nothing to gain
  check('a chip already under its least width squeezes no further', fitTopBar({ room: 150, gap: 4, fixed: 28, more: 28, items: squeezable }).hidden, ['git'])
  const wide: FitItem[] = [
    { id: 'folder', kind: 'folder', full: 300, compact: 160, min: 64 },
    { id: 'git', kind: 'git', full: 260, compact: 180, min: 80 },
    { id: 's1', kind: 'shortcut', full: 80, compact: 80 }
  ]
  // compact, s1 out: 160+180+28+28 + 3 gaps = 408; squeezed: 64+80+28+28+12 = 212
  check('before anything is left out, folder and git squeeze to an ellipsis', fitTopBar({ room: 300, gap: 4, fixed: 28, more: 28, items: wide }), {
    compact: ['folder', 'git'],
    overflow: ['s1'],
    hidden: []
  })
  check('and only below that is git left out', fitTopBar({ room: 211, gap: 4, fixed: 28, more: 28, items: wide }).hidden, ['git'])
  /*
   * A min-width also GROWS a chip: compact git "main" is ~64px of content in
   * an 88px (5.5rem) floor. Counted at 64, the fit kept both chips and they ran
   * 5px past the list at 940px. Here: compact at content would be
   * 40+50+28+28+3 gaps = 158 ≤ 160; at their floors, 64+88+28+28+12 = 220.
   */
  const small: FitItem[] = [
    { id: 'folder', kind: 'folder', full: 300, compact: 40, min: 64 },
    { id: 'git', kind: 'git', full: 200, compact: 50, min: 88 },
    { id: 's1', kind: 'shortcut', full: 80, compact: 80 }
  ]
  check('a compact chip narrower than its min-width is counted at it, so the fit leaves git out', fitTopBar({ room: 160, gap: 4, fixed: 28, more: 28, items: small }), {
    compact: ['folder', 'git'],
    overflow: ['s1'],
    hidden: ['git']
  })
  check('and keeps both once its floors fit', fitTopBar({ room: 220, gap: 4, fixed: 28, more: 28, items: small }).hidden, [])
  check(
    'with no folder item, git is the first to give way',
    fitTopBar({ room: 200, gap: 4, fixed: 28, more: 28, items: [items[1], items[3]] }),
    { compact: ['git'], overflow: [], hidden: [] }
  )
}

console.log('\nthe tab strip’s floor yields to the actions')
{
  /*
   * `.titlebar-actions` never shrinks, so a floor that held pushed the usage
   * chip and the Settings gear off the window: 940px, Interface scale 1.6, four
   * tabs — a 409.6px floor (16rem at 25.6px) and the actions ending at 1077px.
   */
  const rem16 = 16 * 25.6
  check('room to spare: the lesser of the strip’s natural width and 16rem', [
    tabsFloorPx({ natural: 900, floor: rem16, avail: 1200, keep: 40 }),
    tabsFloorPx({ natural: 224, floor: 256, avail: 1200, keep: 40 })
  ], [409, 224])
  check('a tight bar: never more than the actions leave, less the pencil', tabsFloorPx({ natural: 900, floor: rem16, avail: 230, keep: 45 }), 185)
  check('no room at all: nothing, never a negative floor', tabsFloorPx({ natural: 900, floor: rem16, avail: 20, keep: 45 }), 0)
  check('whole pixels, rounded down so it never overshoots', tabsFloorPx({ natural: 300.9, floor: 400, avail: 1000, keep: 0 }), 300)
  // The bar keeps its pencil, and the "»" with its gap once a shortcut could spill into it.
  check('the bar keeps the "»" too when a shortcut can spill into it', topBarKeep({ trail: 45, more: 45, gap: 6, shortcuts: true, editing: false }), 96)
  check('only its trail with no shortcuts, or while editing (no "»" then)', [
    topBarKeep({ trail: 45, more: 45, gap: 6, shortcuts: false, editing: false }),
    topBarKeep({ trail: 140, more: 45, gap: 6, shortcuts: true, editing: true })
  ], [45, 140])
  /*
   * And the window's drag space with its gap (the owner, 2026-10-03: with a few
   * tabs open there was nowhere left to grab the window). The tab strip's floor
   * yields to it like any control on the bar — never while editing, when the
   * list scrolls instead.
   */
  const drag = DRAG_GAP_REM * 16
  check('the drag space is kept beside the trail', topBarKeep({ trail: 45, more: 45, gap: 6, shortcuts: false, editing: false, drag }), 45 + drag + 6)
  check('  with the "»" as well', topBarKeep({ trail: 45, more: 45, gap: 6, shortcuts: true, editing: false, drag }), 45 + drag + 6 + 51)
  check('  but not while editing', topBarKeep({ trail: 140, more: 45, gap: 6, shortcuts: true, editing: true, drag }), 140)
  check(
    'so a strip of many tabs stops short of it: the floor leaves the drag space free',
    tabsFloorPx({ natural: 2000, floor: rem16, avail: 400, keep: topBarKeep({ trail: 45, more: 45, gap: 6, shortcuts: false, editing: false, drag }) }),
    400 - (45 + drag + 6)
  )
  check('DRAG_GAP_REM is a real space (≥ 2rem)', DRAG_GAP_REM >= 2, true)
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
