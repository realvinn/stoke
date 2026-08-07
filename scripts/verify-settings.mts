/*
 * hydrate() is the only thing standing between a hand-edited settings.json and
 * the app. It used to live behind an `import { app } from 'electron'`, so none
 * of it was ever run outside a window — and it repaired every structured field
 * except the ones that had just been added.
 *
 *   node scripts/verify-settings.mts
 */
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

console.log('\nproject metadata')
check('junk is dropped rather than kept', hydrateSettings({ projectMeta: 7 }).projectMeta, {})
check(
  'an array is not an object of records',
  hydrateSettings({ projectMeta: ['/a'] }).projectMeta,
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
  'a label is trimmed and capped',
  hydrateSettings({ projectMeta: { '/a': { label: `  ${'x'.repeat(200)}  ` } } }).projectMeta[
    '/a'
  ].label?.length,
  64
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

console.log('\nthe status line')
check('suppression is on for a machine that has never said', hydrateSettings({}).hideStatusLine, true)
check('and off stays off', hydrateSettings({ hideStatusLine: false }).hideStatusLine, false)

console.log('\nnothing already persisted is disturbed')
check(
  'pinned and hidden keep their own shape',
  hydrateSettings({ pinnedProjects: ['/a'], hiddenProjects: ['/b'] }),
  { ...DEFAULT_SETTINGS, pinnedProjects: ['/a'], hiddenProjects: ['/b'] }
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
