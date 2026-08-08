/*
 * Profiles are derived from the folders a machine actually has, and the first
 * version hardcoded one machine's layout — so a Mac organised any other way
 * matched nothing and showed no profiles at all. These cases are the layouts
 * that must keep working.
 *
 * The second half covers the bug that made user-created profiles useless: the
 * derived list early-returned the named profiles whenever any named folder
 * existed, and dropped every group holding a single project — so on this machine
 * a profile the user had just made could not appear at all, by either route.
 *
 *   node scripts/verify-profiles.mts
 */
import type { ProfileConfig } from '../src/shared/types.ts'
import {
  PROFILES,
  PROFILE_SWATCHES,
  deriveProfiles,
  describePlan,
  foldGroup,
  folderName,
  nextProfileId,
  profileFor,
  resolveProfiles,
  sameFolderName,
  visibleProfiles
} from '../src/shared/profiles.ts'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planProfile } from '../src/main/profiles.ts'

let failures = 0

/** Key order is not meaning, so compare with keys sorted. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]])
        )
      : val
  )
}

function check(name: string, got: unknown, want: unknown): void {
  const ok = canon(got) === canon(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${canon(got)}, want ${canon(want)}`)
  )
}

const counts = (o: Record<string, number>): Map<string, number> => new Map(Object.entries(o))
const ids = (o: Record<string, number>): string[] => deriveProfiles(counts(o)).map((p) => p.id)
const labels = (o: Record<string, number>): string[] => deriveProfiles(counts(o)).map((p) => p.label)

/** Shorthand for a stored record, with colours that are obviously not seeds. */
const rec = (p: Partial<ProfileConfig> & { id: string }): ProfileConfig => ({
  groups: [p.id],
  label: p.label ?? p.id,
  accent: '#4ecdc4',
  accentHover: '#77dcd5',
  accentSoft: 'rgba(78, 205, 196, 0.14)',
  accentContrast: '#041a18',
  ...p
})

console.log('\nthe windows layout this was designed around')
check(
  'named folders are recognised, stray ones ignored',
  ids({ personal: 6, school: 3, 'gitea-company': 3, Documents: 2, WINDOWS: 1 }),
  ['personal', 'school', 'gitea-company']
)
check(
  'they keep their given order, not the folder count order',
  labels({ 'gitea-company': 9, personal: 1 }),
  ['Personal', 'Work']
)
check('a named folder is matched however it is cased', ids({ PERSONAL: 4 }), ['personal'])

console.log('\na machine organised some other way')
check(
  'unknown folders become profiles when nothing named matches',
  ids({ work: 5, side: 3, uni: 2 }),
  ['work', 'side', 'uni']
)
check('and are named readably', labels({ 'my-projects': 4, work: 2 }), ['My projects', 'Work'])
check(
  'a lone repo parked somewhere is not a category of work',
  ids({ work: 4, Downloads: 1, Desktop: 1 }),
  ['work']
)
check('no folders at all yields nothing rather than throwing', ids({}), [])
check('a single project overall yields nothing', ids({ Code: 1 }), [])

console.log('\none profile is still a choice')
check('a mac with one work folder still gets a profile', ids({ Code: 4 }), ['Code'])

console.log('\nresolveProfiles with nothing stored is the old derived list')
/*
 * Frozen literal, not a re-derivation: this is exactly what `profilesFor`
 * returned for this machine before stored records existed, so it is a real
 * regression lock rather than a tautology. `groups` is the one field the
 * resolved shape adds and is asserted separately below.
 */
const LEGACY_NAMED = [
  {
    id: 'personal',
    label: 'Personal',
    accent: '#ff9552',
    accentHover: '#ffab74',
    accentSoft: 'rgba(255, 149, 82, 0.14)',
    accentContrast: '#1a1108'
  },
  {
    id: 'school',
    label: 'Study',
    accent: '#ff6b6b',
    accentHover: '#ff8a8a',
    accentSoft: 'rgba(255, 107, 107, 0.14)',
    accentContrast: '#1a0d0d',
    secondary: '#6ea8fe'
  },
  {
    id: 'gitea-company',
    label: 'Work',
    accent: '#5fd08a',
    accentHover: '#83deA5',
    accentSoft: 'rgba(95, 208, 138, 0.14)',
    accentContrast: '#08170f'
  }
]
const namedMachine = counts({ personal: 6, school: 3, 'gitea-company': 3, Documents: 2 })
check(
  'every derived field is unchanged',
  resolveProfiles(namedMachine, []).map(({ groups: _groups, ...rest }) => rest),
  LEGACY_NAMED
)
check(
  'and each seed covers its own folder',
  resolveProfiles(namedMachine, []).map((p) => p.groups),
  [['personal'], ['school'], ['gitea-company']]
)
check(
  'the fallback layout is unchanged too',
  resolveProfiles(counts({ work: 5, side: 3 }), []).map((p) => [p.id, p.accent]),
  [
    ['work', '#6ea8fe'],
    ['side', '#f7c948']
  ]
)

console.log('\na profile the user made')
/*
 * The bug, in one case. On this machine personal/school/gitea-company all exist,
 * so the derived list early-returned them and stopped; and Task holds one
 * project, which the other branch dropped. Either way the user pressed Create
 * and nothing appeared.
 */
const withTask = counts({ personal: 6, school: 3, 'gitea-company': 3, Task: 1 })
const taskRecord = rec({ id: 'Task', label: 'Task', createdByUser: true })
check(
  'appears next to the named ones, which it never could before',
  resolveProfiles(withTask, [taskRecord]).map((p) => p.id),
  ['personal', 'school', 'gitea-company', 'Task']
)
check(
  'and renders with only one project in it',
  visibleProfiles(resolveProfiles(withTask, [taskRecord]), withTask).map((p) => p.label),
  ['Personal', 'Study', 'Work', 'Task']
)
check(
  'a profile for a folder that is empty so far still renders, via its scan root',
  visibleProfiles(
    resolveProfiles(counts({ personal: 6 }), [rec({ id: 'Task' })]),
    counts({ personal: 6 }),
    ['G:\\Code\\Task\\']
  ).map((p) => p.id),
  ['personal', 'Task']
)
check(
  'with no root and no projects it is stored but not shown',
  visibleProfiles(resolveProfiles(counts({ personal: 6 }), [rec({ id: 'Task' })]), counts({ personal: 6 })).map(
    (p) => p.id
  ),
  ['personal']
)

console.log('\nstored records win, and survive a machine that has none of their folders')
check(
  'a rename and a recolour are kept',
  resolveProfiles(namedMachine, [rec({ id: 'school', label: 'Uni' })]).map((p) => [
    p.label,
    p.accent
  ]),
  [
    ['Personal', '#ff9552'],
    ['Uni', '#4ecdc4'],
    ['Work', '#5fd08a']
  ]
)
check(
  'a record that only renames keeps the seed colours',
  resolveProfiles(namedMachine, [{ id: 'school', groups: ['school'], label: 'Uni' } as ProfileConfig]).map(
    (p) => p.accent
  ),
  ['#ff9552', '#ff6b6b', '#5fd08a']
)
check(
  "recolouring Study drops the blue hairline rather than pairing it with the new colour",
  resolveProfiles(namedMachine, [rec({ id: 'school' })])[1].secondary,
  undefined
)
const macCounts = counts({ Code: 4 })
const windowsConfig = [rec({ id: 'gitea-company', label: 'Work' }), rec({ id: 'personal' })]
check(
  'a mac keeps the windows records rather than eating them',
  resolveProfiles(macCounts, windowsConfig).map((p) => p.id),
  ['Code', 'gitea-company', 'personal']
)
check(
  'but renders only what is here',
  visibleProfiles(resolveProfiles(macCounts, windowsConfig), macCounts).map((p) => p.id),
  ['Code']
)

console.log('\na deleted profile stays deleted')
/* Deletion of a derived profile is a record covering no groups. Nothing else in
   ProfileConfig can express it, and without it the folder layout re-derives the
   profile on the next launch. */
const tombstone = [rec({ id: 'school', groups: [] })]
check(
  'the record survives so the deletion is remembered',
  resolveProfiles(namedMachine, tombstone).map((p) => [p.id, p.groups.length]),
  [
    ['personal', 1],
    ['school', 0],
    ['gitea-company', 1]
  ]
)
check(
  'the chip is gone even though the folder is still full of projects',
  visibleProfiles(resolveProfiles(namedMachine, tombstone), namedMachine).map((p) => p.id),
  ['personal', 'gitea-company']
)
check(
  'and nothing resolves it back into the accent',
  profileFor('school', visibleProfiles(resolveProfiles(namedMachine, tombstone), namedMachine)),
  null
)
check(
  'deleting a user-made profile just drops the record',
  visibleProfiles(resolveProfiles(withTask, []), withTask).map((p) => p.id),
  ['personal', 'school', 'gitea-company']
)

console.log('\nlookup')
const named = resolveProfiles(namedMachine, [])
check('a known id resolves', profileFor('school', named)?.label, 'Study')
check('null resolves to nothing', profileFor(null, named), null)
check('an unknown id resolves to nothing rather than a wrong colour', profileFor('nope', named), null)
check('case does not matter', profileFor('SCHOOL', named)?.label, 'Study')
check(
  'a derived id resolves against the derived list',
  profileFor('uni', resolveProfiles(counts({ uni: 3, work: 2 }), []))?.label,
  'Uni'
)

console.log('\nids for new profiles')
check('the folder name is used when it is free', nextProfileId('Task', ['personal']), 'Task')
check('and disambiguated when it is not', nextProfileId('Task', ['task']), 'Task-2')

console.log('\nfolder names')
check('a trailing separator is ignored', folderName('G:\\Code\\Task\\'), 'Task')
check('either separator works', folderName('/home/v/Code/Task'), 'Task')
check('a name already on the folder is spotted', sameFolderName('G:\\Code\\Task\\', 'task', true), true)
check('and is not, when case matters', sameFolderName('/home/v/Code/Task', 'task', false), false)
check('groups fold to one spelling', [foldGroup(' Task '), foldGroup('TASK')], ['task', 'task'])

console.log('\nplan previews read as sentences')
check(
  'create',
  describePlan({
    action: 'create',
    chosen: 'G:\\Code',
    root: 'G:\\Code\\Task',
    group: 'Task',
    imports: [],
    willCreate: true,
    error: null
  }),
  'Create G:\\Code\\Task. It starts empty; anything you put in it joins this profile.'
)
check(
  'reuse counts what it will import',
  describePlan({
    action: 'reuse',
    chosen: 'G:\\Code\\personal',
    root: 'G:\\Code\\personal',
    group: 'personal',
    imports: ['a', 'b'],
    willCreate: false,
    error: null
  }),
  'Use G:\\Code\\personal as it is — 2 projects already inside it join this profile.'
)
check(
  'an error replaces the sentence entirely',
  describePlan({
    action: 'create',
    chosen: '',
    root: '',
    group: '',
    imports: [],
    willCreate: false,
    error: 'Give the profile a name.'
  }),
  'Give the profile a name.'
)

console.log('\nplanProfile against real folders')
/*
 * None of this logic had a test, and the bug it hides is a folder: on APFS,
 * `isDirectory('/Users/thevinh/dev/Work')` is true because `.../work` exists,
 * so planProfile answered `reuse` with a casing that is not on disk and the
 * app persisted it as a scan root (spec 2.5). The case-blindness of the
 * filesystem is the thing under test, so CASE_BLIND is measured from the box
 * itself rather than from pathRulesFor — deriving the expectation from the
 * function under test would make every assertion below vacuous (break
 * pathRulesFor and the suite still passes), and pathRulesFor('darwin')
 * .caseInsensitive is true even on a case-sensitive APFS volume, which a real
 * Mac can be running.
 */
const box = mkdtempSync(join(tmpdir(), 'stoke-plan-'))
try {
  mkdirSync(join(box, 'Work'))
  const CASE_BLIND = existsSync(join(box, 'work'))
  mkdirSync(join(box, 'Work', 'refinity'))
  mkdirSync(join(box, 'Work', 'buyback'))

  const differentCaseChild = await planProfile(box, 'work')
  check(
    'a child that exists in another case is reused, not nested inside itself',
    differentCaseChild.action,
    CASE_BLIND ? 'reuse' : 'create'
  )
  check(
    'and it is reported with the casing it has on disk',
    differentCaseChild.root,
    join(box, CASE_BLIND ? 'Work' : 'work')
  )
  check(
    'so the group is the real folder name',
    differentCaseChild.group,
    CASE_BLIND ? 'Work' : 'work'
  )
  const alreadyNamed = await planProfile(join(box, 'Work'), 'work')
  check(
    'a folder already carrying the name is used as it is, however it is cased',
    [alreadyNamed.action, alreadyNamed.root],
    CASE_BLIND
      ? ['reuse', join(box, 'Work')]
      : ['create', join(box, 'Work', 'work')]
  )

  const exact = await planProfile(box, 'Work')
  check(
    'an exact match still reuses, on every platform',
    [exact.action, exact.root],
    ['reuse', join(box, 'Work')]
  )
  check(
    'and reports what adopting it would import',
    exact.imports,
    ['buyback', 'refinity']
  )

  const fresh = await planProfile(box, 'Study')
  check(
    'a name nothing matches still creates the child',
    [fresh.action, fresh.root, fresh.willCreate, fresh.imports],
    ['create', join(box, 'Study'), true, []]
  )

  const missing = await planProfile(join(box, 'nope'), 'Work')
  check(
    'a folder that is not there is refused rather than planned',
    missing.error,
    `${join(box, 'nope')} is not a folder that exists.`
  )
} finally {
  rmSync(box, { recursive: true, force: true })
}

console.log('\ncolour contrast')
const lin = (c: number): number => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const lum = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/*
 * Everything a profile can end up wearing: the named seeds, the colours an
 * unknown folder is given, and every swatch the settings UI offers. The UI has
 * no free-form colour input precisely so this list is the whole set.
 */
const derived = resolveProfiles(counts({ a: 2, b: 2, c: 2, d: 2 }), [])
const wearable = [
  ...PROFILES.map((p) => ({ label: p.label, accent: p.accent, ink: p.accentContrast })),
  ...derived.map((p) => ({ label: p.label, accent: p.accent, ink: p.accentContrast })),
  ...PROFILE_SWATCHES.map((s) => ({ label: s.name, accent: s.accent, ink: s.accentContrast }))
]
for (const p of wearable) {
  const r = ratio(p.accent, p.ink)
  const ok = r >= 4.5
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${p.label.padEnd(11)} ${r.toFixed(2)}:1`)
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
