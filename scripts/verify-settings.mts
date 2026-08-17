/*
 * hydrate() is the only thing standing between a hand-edited settings.json and
 * the app. It used to live behind an `import { app } from 'electron'`, so none
 * of it was ever run outside a window — and it repaired every structured field
 * except the ones that had just been added.
 *
 *   node scripts/verify-settings.mts
 */
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'
import { DEFAULT_WORKLOG_BOARDS } from '../src/shared/worklog.ts'
import { nextBoards } from '../src/renderer/src/lib/worklogBoards.ts'
import type { WorklogTarget } from '../src/shared/types.ts'

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

console.log('\nproject metadata')
check('junk is dropped rather than kept', hydrateSettings({ projectMeta: 7 }).projectMeta, {})
check(
  // A plain array of strings would be dropped either way - by Array.isArray or
  // by the `typeof value !== 'object'` continue further down. An array of
  // objects is the input Array.isArray actually guards: without it,
  // Object.entries would key each element on its array index and produce
  // { '0': { label: 'x' } } instead of {}.
  'an array is not an object of records',
  hydrateSettings({ projectMeta: [{ label: 'x' }] }).projectMeta,
  {}
)
check(
  'a trailing separator is normalised off the key',
  Object.keys(hydrateSettings({ projectMeta: { '/a/b/': { emoji: '🔥' } } }).projectMeta),
  ['/a/b']
)
check(
  'an entry that says nothing is dropped',
  hydrateSettings({ projectMeta: { '/a': { emoji: '  ', label: '' } } }).projectMeta,
  {}
)
check(
  'addedManually needs a literal true',
  hydrateSettings({ projectMeta: { '/a': { addedManually: 1 } } }).projectMeta,
  {}
)
check(
  // Asserts the value, not just its length - a fixture whose length survives
  // .trim() being dropped (e.g. a 200-char label padded with spaces) would
  // pass this even with a broken tidy().
  'a label is trimmed',
  hydrateSettings({ projectMeta: { '/a': { label: '  x  ' } } }).projectMeta['/a'].label,
  'x'
)
check(
  'and capped at 64',
  hydrateSettings({ projectMeta: { '/a': { label: 'x'.repeat(200) } } }).projectMeta['/a'].label,
  'x'.repeat(64)
)

console.log('\nworklog boards')
check(
  'an untouched machine gets Notion only',
  hydrateSettings({}).worklogBoards.targets,
  ['notion']
)
check(
  'a target with no id is not a destination',
  hydrateSettings({
    worklogBoards: { targets: ['notion', 'clickup'], notionDataSource: 'x', clickupListId: '' }
  }).worklogBoards.targets,
  ['notion']
)
check(
  'the stored order cannot change the write order',
  hydrateSettings({
    worklogBoards: { targets: ['clickup', 'notion'], notionDataSource: 'x', clickupListId: '1' }
  }).worklogBoards.targets,
  ['notion', 'clickup']
)
check(
  'a target nobody can write to is dropped',
  hydrateSettings({
    worklogBoards: { targets: ['jira'], notionDataSource: 'x', clickupListId: '1' }
  }).worklogBoards.targets,
  []
)

console.log('\ninterface scale, which a number input will not clamp for you')
check('a hand-typed 40 is clamped', hydrateSettings({ uiScale: 40 }).uiScale, 1.6)
check('so is 0', hydrateSettings({ uiScale: 0 }).uiScale, 0.8)
check('and junk falls back to 1', hydrateSettings({ uiScale: 'big' }).uiScale, 1)
check('a legitimate value is untouched', hydrateSettings({ uiScale: 1.25 }).uiScale, 1.25)

/*
 * zoomTarget decides which of the two sizes above the zoom keys move. Junk
 * must fall back rather than disable zoom: an unrecognised value that survived
 * hydration would leave the shortcut firing and visibly doing nothing.
 */
check('zoomTarget defaults to both', hydrateSettings({}).zoomTarget, 'both')
check('a real target is kept', hydrateSettings({ zoomTarget: 'terminal' }).zoomTarget, 'terminal')
check('junk falls back to both', hydrateSettings({ zoomTarget: 'sideways' }).zoomTarget, 'both')

console.log('\nterminal font size, which rounds as well as clamps')
check('a hand-typed 3 is clamped up to the floor', hydrateSettings({ fontSize: 3 }).fontSize, 9)
check('and 30 is clamped down to the ceiling', hydrateSettings({ fontSize: 30 }).fontSize, 24)
check('a fractional 13.5 is rounded to 14', hydrateSettings({ fontSize: 13.5 }).fontSize, 14)

console.log('\nthe status line')
check('suppression is on for a machine that has never said', hydrateSettings({}).hideStatusLine, true)
check('and off stays off', hydrateSettings({ hideStatusLine: false }).hideStatusLine, false)

console.log('\nnothing already persisted is disturbed')
check(
  'pinned and hidden keep their own shape',
  hydrateSettings({ pinnedProjects: ['/a'], hiddenProjects: ['/b'] }),
  { ...DEFAULT_SETTINGS, pinnedProjects: ['/a'], hiddenProjects: ['/b'] }
)

console.log('\na fresh install, or a settings.json that parses to null')
check(
  'hydrateSettings(null) repairs to the same shape as hydrateSettings({})',
  hydrateSettings(null),
  hydrateSettings({})
)
{
  // Identity, not deep-equality: this is exactly the bug the reviewer
  // measured. A bare `{ ...DEFAULT_SETTINGS }` shallow-copy on the fresh-
  // install path hands out DEFAULT_WORKLOG_BOARDS (and its .targets array)
  // and DEFAULT_SETTINGS.projectMeta by reference; two objects can look
  // identical under JSON.stringify while still being the one shared module
  // constant that later worklog code relies on as a write-path fallback.
  const fresh = hydrateSettings(null)
  ok(
    'worklogBoards is not the shared DEFAULT_WORKLOG_BOARDS object',
    (fresh.worklogBoards as unknown) !== (DEFAULT_WORKLOG_BOARDS as unknown)
  )
  ok(
    'worklogBoards.targets is not the shared DEFAULT_WORKLOG_BOARDS.targets array',
    (fresh.worklogBoards.targets as unknown) !== (DEFAULT_WORKLOG_BOARDS.targets as unknown)
  )
  ok(
    'projectMeta is not the shared DEFAULT_SETTINGS.projectMeta object',
    (fresh.projectMeta as unknown) !== (DEFAULT_SETTINGS.projectMeta as unknown)
  )
  // Mutate what the fresh-install path handed out, then prove nothing else
  // saw it - the actual failure mode, not just a reference check in isolation.
  fresh.worklogBoards.targets.push('clickup')
  ok(
    'mutating the returned targets array leaves DEFAULT_WORKLOG_BOARDS.targets alone',
    JSON.stringify(DEFAULT_WORKLOG_BOARDS.targets) === JSON.stringify(['notion'])
  )
  ok(
    'a later hydrateSettings({}) is unaffected by that mutation',
    JSON.stringify(hydrateSettings({}).worklogBoards.targets) === JSON.stringify(['notion'])
  )
}

console.log('\nwhat the boards control is allowed to produce')

/*
 * These are already true of hydrateWorklogBoards. They are asserted here
 * because the panel in WorklogSettings.tsx now applies the same three rules
 * itself, and a panel that could show a destination the store would drop is a
 * switch that lies about what it did.
 */
check(
  'a target whose id is empty is not a target',
  hydrateSettings({
    worklogBoards: { targets: ['notion', 'clickup'], notionDataSource: 'x', clickupListId: '  ' }
  }).worklogBoards.targets,
  ['notion']
)
check(
  'the stored order cannot change the canonical order',
  hydrateSettings({
    worklogBoards: { targets: ['clickup', 'notion'], notionDataSource: 'x', clickupListId: '1' }
  }).worklogBoards.targets,
  ['notion', 'clickup']
)
check(
  'a name no write tool exists for is dropped',
  hydrateSettings({
    worklogBoards: { targets: ['jira', 'notion'], notionDataSource: 'x', clickupListId: '1' }
  }).worklogBoards.targets,
  ['notion']
)

console.log('\nnextBoards, the panel’s own copy of that rule')

/*
 * The three checks just above exercise hydrateWorklogBoards, in
 * settingsSchema.ts — a file this task never touched. `nextBoards`
 * (src/renderer/src/lib/worklogBoards.ts) is WorklogSettings.tsx's own
 * re-implementation of the same three rules, applied before a keystroke ever
 * reaches onChangeBoards, and nothing asserted it directly: every check above
 * would keep passing even if `nextBoards` silently stopped agreeing with the
 * store it is supposed to mirror. A dummy `boards` fixture is enough here —
 * `nextBoards` only reads `ids` and `ticked`; its `boards` argument exists to
 * satisfy the return type, and is fully overwritten by the `targets:` line
 * that follows it.
 */
const noBoards = { targets: [] as WorklogTarget[], notionDataSource: '', clickupListId: '' }
check(
  'a target whose id is empty is not a target',
  nextBoards(noBoards, new Set(['notion', 'clickup']), {
    notionDataSource: 'x',
    clickupListId: '  '
  }).targets,
  ['notion']
)
check(
  'the ticked order cannot change the canonical order',
  nextBoards(noBoards, new Set(['clickup', 'notion']), {
    notionDataSource: 'x',
    clickupListId: '1'
  }).targets,
  ['notion', 'clickup']
)
check(
  'a name no write tool exists for is dropped',
  nextBoards(noBoards, new Set(['jira', 'notion'] as WorklogTarget[]), {
    notionDataSource: 'x',
    clickupListId: '1'
  }).targets,
  ['notion']
)

console.log('\nthe active profile chip')
/*
 * hydrate validated every other structured field and passed this one straight
 * through, back when the only thing that ever wrote it was a click on a chip.
 * The tab strip writes it now, so a value that is not a profile id has to be
 * repaired rather than handed to profileFor.
 */
check('a number is not a profile id', hydrateSettings({ activeProfile: 7 }).activeProfile, null)
check(
  'nor is an object that merely contains one',
  hydrateSettings({ activeProfile: { id: 'Work' } }).activeProfile,
  null
)
check(
  'an empty string is no selection, not a profile named ""',
  hydrateSettings({ activeProfile: '   ' }).activeProfile,
  null
)
check('a real id survives, trimmed', hydrateSettings({ activeProfile: ' Work ' }).activeProfile, 'Work')
/*
 * Deliberately kept: a profile can legitimately belong to another machine, and
 * resolveProfiles keeps those records for the same reason. App resolves the id
 * against the visible list every render and shows no filter when it misses, so
 * an unknown id costs nothing — while dropping it would silently rewrite the
 * Windows selection the first time the Mac saved anything.
 */
check(
  'an id with no profile behind it is kept, because the profile may be on another machine',
  hydrateSettings({ activeProfile: 'a-folder-on-the-other-desk' }).activeProfile,
  'a-folder-on-the-other-desk'
)

/*
 * The one exception to "an unknown id is kept verbatim": the two ids renamed in
 * 0.4.0. A profile id doubles as the project group it matches, so leaving these
 * alone would strand a machine's selection on a profile that no longer exists,
 * and stranding it is indistinguishable from the case above — which is exactly
 * why this is asserted rather than assumed.
 */
check(
  'a renamed profile id is carried forward, not stranded',
  hydrateSettings({ activeProfile: 'gitea-company' }).activeProfile,
  'work'
)
check(
  'and so is the other one',
  hydrateSettings({ activeProfile: 'gitea-vibe' }).activeProfile,
  'side'
)
check(
  'a stored record is renamed by id',
  hydrateSettings({ profiles: [{ id: 'gitea-company', groups: ['gitea-company'] }] }).profiles[0].id,
  'work'
)
check(
  'but keeps the groups it already matched, so its folders do not move',
  JSON.stringify(
    hydrateSettings({ profiles: [{ id: 'gitea-company', groups: ['gitea-company'] }] }).profiles[0]
      .groups
  ),
  '["gitea-company"]'
)
check(
  'and a record already on the new id is left alone rather than collided with',
  hydrateSettings({
    profiles: [
      { id: 'work', groups: ['work'] },
      { id: 'gitea-company', groups: ['gitea-company'] }
    ]
  }).profiles.map((p) => p.id).join(','),
  'work,gitea-company'
)
check('and an untouched machine has no selection', hydrateSettings({}).activeProfile, null)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
