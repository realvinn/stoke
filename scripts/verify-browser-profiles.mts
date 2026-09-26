/*
 * Browser profiles: the rules that decide where a profile's logins live.
 *
 * The one that matters most is the first: the Default profile must keep the
 * partition the single browser always had, or every login made before profiles
 * existed silently disappears on upgrade. The rest keep a settings file from
 * ever naming a partition that two profiles would share.
 *
 *   node scripts/verify-browser-profiles.mts
 */
import {
  clampCurrentProfile,
  DEFAULT_BROWSER_PROFILE_ID,
  hydrateBrowserProfiles,
  newProfileId,
  nextProfileLabel,
  partitionFor
} from '../src/shared/browserProfiles.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

console.log('\npartitions')
check('Default keeps the partition the single browser always had', partitionFor('default'), 'persist:stoke-browser')
check('any other profile gets its own, beside it', partitionFor('a1b2c3'), 'persist:stoke-browser-a1b2c3')

console.log('\nhydrating a settings file')
check('nothing stored: Default alone', hydrateBrowserProfiles(undefined), [
  { id: 'default', label: 'Default', source: '' }
])
check(
  'Default is put back first when a file lost it',
  hydrateBrowserProfiles([{ id: 'work1', label: 'Work', source: 'Chrome · Work' }]).map((p) => p.id),
  ['default', 'work1']
)
check(
  'Default may be renamed but never re-sourced or duplicated',
  hydrateBrowserProfiles([{ id: 'default', label: 'Me', source: 'x' }, { id: 'default', label: 'Again' }]),
  [{ id: 'default', label: 'Again', source: '' }]
)
check(
  'an id Electron would fold or nest is dropped, not guessed at',
  hydrateBrowserProfiles([
    { id: 'Work', label: 'Upper' },
    { id: 'a/b', label: 'Slash' },
    { id: 'has space', label: 'Space' },
    { id: '', label: 'Empty' },
    { id: 'ok1', label: 'Fine' }
  ]).map((p) => p.id),
  ['default', 'ok1']
)
check(
  'a duplicate id keeps the first',
  hydrateBrowserProfiles([
    { id: 'dup', label: 'First' },
    { id: 'dup', label: 'Second' }
  ]).map((p) => p.label),
  ['Default', 'First']
)
check('a blank label gets a name', hydrateBrowserProfiles([{ id: 'x9', label: '   ' }])[1].label, 'Profile')
check('junk entries are skipped', hydrateBrowserProfiles([null, 3, 'str', { id: 'k2', label: 'K' }]).length, 2)
check(
  'a long label is cut, not refused',
  hydrateBrowserProfiles([{ id: 'l1', label: 'x'.repeat(100) }])[1].label.length,
  40
)

console.log('\nthe active profile')
const list = hydrateBrowserProfiles([{ id: 'work1', label: 'Work' }])
check('a known id is kept', clampCurrentProfile('work1', list), 'work1')
check('a removed one falls back to Default', clampCurrentProfile('gone', list), DEFAULT_BROWSER_PROFILE_ID)
check('junk falls back to Default', clampCurrentProfile(42, list), DEFAULT_BROWSER_PROFILE_ID)

console.log('\nminting')
{
  const seq = ['DEFAULT', 'work1', 'Ab-Cd-Ef']
  let i = 0
  const id = newProfileId(list, () => seq[i++])
  check('never "default", never a taken id, always lower-case and bare', id, 'abcdef')
}
check('labels count up past the taken ones', nextProfileLabel([{ id: 'a', label: 'Profile', source: '' }]), 'Profile 2')
check(
  'and skip a gap',
  nextProfileLabel([
    { id: 'a', label: 'Profile', source: '' },
    { id: 'b', label: 'profile 2', source: '' }
  ]),
  'Profile 3'
)
check('a fresh base label is used as it is', nextProfileLabel([], 'Chrome'), 'Chrome')

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
