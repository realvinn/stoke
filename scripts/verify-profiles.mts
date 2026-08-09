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
import type { ProfileConfig, Project, Settings } from '../src/shared/types.ts'
import { profileIdForCwd } from '../src/shared/paths.ts'
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
  visibleProfiles
} from '../src/shared/profiles.ts'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createProfile, planProfile } from '../src/main/profiles.ts'

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

console.log('\nplanProfile name and folder guards')
/*
 * These become real directories once accepted — a name that slips through is
 * a folder that gets created or reused — so the refusals are worth pinning
 * directly rather than trusting they still fire. `...` and `..foo` are
 * deliberately *not* refused: only the exact strings `.` and `..` are, and
 * that stays true below.
 */
const guardsBox = mkdtempSync(join(tmpdir(), 'stoke-plan-guards-'))
try {
  mkdirSync(join(guardsBox, 'Work'))

  check('an empty name is refused', (await planProfile(guardsBox, '')).error, 'Give the profile a name.')
  check(
    'a whitespace-only name is refused the same way',
    (await planProfile(guardsBox, '   ')).error,
    'Give the profile a name.'
  )
  const trimmed = await planProfile(guardsBox, '  Work  ')
  check('surrounding whitespace is trimmed, then reused like any other match', [trimmed.action, trimmed.root], [
    'reuse',
    join(guardsBox, 'Work')
  ])

  const forbidden = 'A profile name cannot contain \\ / : * ? " < > or |.'
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    check(`${JSON.stringify(bad)} is refused as a name`, (await planProfile(guardsBox, bad)).error, forbidden)
  }

  for (const dot of ['.', '..']) {
    check(
      `${JSON.stringify(dot)} is refused, not treated as a folder name`,
      (await planProfile(guardsBox, dot)).error,
      'That is not a folder name.'
    )
  }
  const dotdotdot = await planProfile(guardsBox, '...')
  check('but "..." is a legal name, not a special one', [dotdotdot.action, dotdotdot.error], ['create', null])
  const dotfoo = await planProfile(guardsBox, '..foo')
  check('and so is "..foo"', [dotfoo.action, dotfoo.error], ['create', null])

  check(
    'an empty chosen folder is refused',
    (await planProfile('', 'Work')).error,
    'Choose a folder to keep this profile in.'
  )
  check(
    'a whitespace-only chosen folder is refused the same way',
    (await planProfile('   ', 'Work')).error,
    'Choose a folder to keep this profile in.'
  )
} finally {
  rmSync(guardsBox, { recursive: true, force: true })
}

console.log('\nimports keep one order regardless of what readdir hands back')
/*
 * Deleting `.sort((a, b) => a.localeCompare(b))` from `projectChildren` left
 * the suite green before: the old fixture's two names (`buyback`, `refinity`)
 * already come back from `readdir` in sorted order, so the assertion never
 * exercised the sort. These eight don't — measured on this machine, `readdir`
 * returns them in a different order than `.sort()` would, so this fixture
 * actually bites a missing sort rather than merely restating one that never
 * ran. `planProfile(sortBox, basename(sortBox))` reuses the temp directory
 * itself as the profile root — the box's own name already matches, so
 * `imports` is `projectChildren(sortBox)` directly.
 */
const sortBox = mkdtempSync(join(tmpdir(), 'stoke-plan-sort-'))
try {
  const names = ['000', 'Aaa', 'Banana', 'Zebra', '_under', 'apple', 'mmm', 'zzz-last']
  for (const n of names) mkdirSync(join(sortBox, n))
  const rawOrder = readdirSync(sortBox)
  const sortedOrder = [...names].sort((a, b) => a.localeCompare(b))
  if (JSON.stringify(rawOrder) === JSON.stringify(sortedOrder)) {
    console.log(
      '  NOTE  raw readdir order already matches sorted order on this volume; this fixture is not exercising the sort here'
    )
  }
  const sortPlan = await planProfile(sortBox, basename(sortBox))
  check('the box itself is reused, so imports come straight from it', sortPlan.root, sortBox)
  check('and they are alphabetised, not in whatever order readdir returned', sortPlan.imports, sortedOrder)
} finally {
  rmSync(sortBox, { recursive: true, force: true })
}

console.log('\ncase folding and Unicode normalisation come from the filesystem, not toLowerCase()')
/*
 * `existingChild` used to compare `n.toLowerCase() === name.toLowerCase()`,
 * which is weaker than what the filesystem itself does on the default
 * (case-insensitive, normalising) volume this machine runs: an NFD-typed
 * name never matched an NFC one on disk under `toLowerCase()`, and casing
 * never folded past ASCII, so `STRASSE` never matched `Straße`. Whether this
 * volume actually normalises or folds beyond ASCII is measured, not assumed
 * — same discipline as CASE_BLIND above — so this passes identically on a
 * volume that does neither. Driven through `createProfile`, not `planProfile`
 * directly, because the bug this closes is what gets *persisted*.
 */
const unicodeBox = mkdtempSync(join(tmpdir(), 'stoke-plan-unicode-'))
try {
  const settings = { profiles: [], projectRoots: [] } as unknown as Settings
  const swatch = {
    accent: '#4ecdc4',
    accentHover: '#77dcd5',
    accentSoft: 'rgba(78, 205, 196, 0.14)',
    accentContrast: '#041a18'
  }

  const nfc = 'Café'.normalize('NFC')
  const nfd = 'Café'.normalize('NFD')
  mkdirSync(join(unicodeBox, nfc))
  const NORMALISES = existsSync(join(unicodeBox, nfd))

  const cafe = await createProfile(settings, { folder: unicodeBox, name: nfd, ...swatch })
  check(
    'an NFD-typed name resolves against an NFC entry when this volume normalises',
    cafe.plan.action,
    NORMALISES ? 'reuse' : 'create'
  )
  check(
    'the persisted scan root is the real on-disk entry, not the typed spelling',
    cafe.plan.root,
    join(unicodeBox, NORMALISES ? nfc : nfd)
  )
  check(
    'and it is byte-identical to a directory really on disk, not merely string-equal after normalising twice',
    readdirSync(unicodeBox)
      .map((n) => join(unicodeBox, n))
      .includes(cafe.plan.root),
    true
  )
  check('the patch persists the same byte-identical root', cafe.patch.projectRoots, [cafe.plan.root])

  mkdirSync(join(unicodeBox, 'Straße'))
  const FOLDS_NON_ASCII = existsSync(join(unicodeBox, 'STRASSE'))
  const strasse = await createProfile(settings, { folder: unicodeBox, name: 'STRASSE', ...swatch })
  check(
    'STRASSE resolves against Straße when this volume folds beyond ASCII case',
    strasse.plan.action,
    FOLDS_NON_ASCII ? 'reuse' : 'create'
  )
  check(
    'and that root is also byte-identical to a directory really on disk',
    readdirSync(unicodeBox)
      .map((n) => join(unicodeBox, n))
      .includes(strasse.plan.root),
    true
  )
} finally {
  rmSync(unicodeBox, { recursive: true, force: true })
}

console.log('\nsymlinks: kept where the user pointed, never relocated to the target')
/*
 * `realpathSync.native` resolves symlinks, so its raw result can point
 * somewhere entirely different from where the user aimed. `existingChild`
 * only ever keeps the *basename* of that result and rejoins it onto the
 * caller's own directory — this is the fixture that proves a symlinked
 * chosen folder is not silently relocated to whatever it targets. Whether a
 * wrong-cased spelling matches at all is still a volume question, so that
 * part is measured the same way as CASE_BLIND above, not assumed.
 *
 * The second half is the regression that basename shortcut caused, and it has
 * nothing to do with case. A child that is itself a symlink to a target with a
 * different basename (`Link` -> `Elsewhere/Archive`) resolves to the basename
 * `Archive`; rejoining that onto the parent names `<box>/Archive`, and when a
 * real, unrelated `Archive/` happens to sit right there, that folder existed,
 * was a directory, and became the profile's scan root and group. The user
 * typed `Link`, with its exact on-disk casing, and got two projects belonging
 * to somebody else — silently, with a plausible import count, which this
 * module's own comment calls the worst way for it to be wrong. The sibling
 * collision is the whole point of the fixture: without a real `Archive/` next
 * to `Link` the reconstructed path simply did not exist and the bug hid.
 *
 * `Ghost` covers the same shape one directory closer: a symlink whose target
 * is a sibling of the link itself, so the resolved path never leaves the
 * parent at all. "Did the path leave `dir`" is therefore not a sufficient
 * discriminator, and this is the case that proves it.
 */
const linkBox = mkdtempSync(join(tmpdir(), 'stoke-plan-symlink-'))
try {
  mkdirSync(join(linkBox, 'RealRoot'))
  mkdirSync(join(linkBox, 'RealRoot', 'Task'))
  symlinkSync(join(linkBox, 'RealRoot'), join(linkBox, 'LinkRoot'))
  const LINK_CASE_BLIND = existsSync(join(linkBox, 'LinkRoot', 'task'))

  const viaSymlinkedChosen = await planProfile(join(linkBox, 'LinkRoot'), 'task')
  check(
    'a wrong-cased child of a symlinked chosen folder is found exactly when this volume would fold it',
    viaSymlinkedChosen.action,
    LINK_CASE_BLIND ? 'reuse' : 'create'
  )
  check(
    'and when it is, the root stays under the symlink the user picked, not the real directory it targets',
    viaSymlinkedChosen.root,
    join(linkBox, 'LinkRoot', LINK_CASE_BLIND ? 'Task' : 'task')
  )

  mkdirSync(join(linkBox, 'Elsewhere'))
  mkdirSync(join(linkBox, 'Elsewhere', 'Archive'))
  mkdirSync(join(linkBox, 'Elsewhere', 'Archive', 'inner-project'))
  symlinkSync(join(linkBox, 'Elsewhere', 'Archive'), join(linkBox, 'Link'))
  // The collision. A real, unrelated folder carrying the link target's name.
  mkdirSync(join(linkBox, 'Archive'))
  mkdirSync(join(linkBox, 'Archive', 'unrelated-project-1'))
  mkdirSync(join(linkBox, 'Archive', 'unrelated-project-2'))

  // Exact on-disk casing, deliberately — this is not a casing problem.
  const viaSymlinkedChild = await planProfile(linkBox, 'Link')
  check(
    'a symlinked child is reused as the folder the user named',
    [viaSymlinkedChild.action, viaSymlinkedChild.root, viaSymlinkedChild.willCreate],
    ['reuse', join(linkBox, 'Link'), false]
  )
  check(
    'the group is the name that was typed, never the symlink target basename',
    viaSymlinkedChild.group,
    'Link'
  )
  check(
    "and the imports are what is inside it, not the unrelated sibling's projects",
    viaSymlinkedChild.imports,
    ['inner-project']
  )
  check(
    'the unrelated sibling is still reachable by its own name, so nothing was merely hidden',
    (await planProfile(linkBox, 'Archive')).imports,
    ['unrelated-project-1', 'unrelated-project-2']
  )

  // Same shape, one directory closer: the target never leaves the parent.
  symlinkSync(join(linkBox, 'Archive'), join(linkBox, 'Ghost'))
  const siblingLink = await planProfile(linkBox, 'Ghost')
  check(
    'a symlink to a sibling of its own parent is still the folder that was named',
    [siblingLink.action, siblingLink.root, siblingLink.group],
    ['reuse', join(linkBox, 'Ghost'), 'Ghost']
  )

  /*
   * The two spellings that make the listing scan have to compare *identity*
   * rather than names. Searching the entries for the typed string finds `Link`
   * and `Ghost` above by accident — they were typed exactly as they are
   * spelled — so those two alone do not pin the mechanism. Here the typed name
   * is not the entry name by any string rule the volume does not know about:
   * NFD against an NFC entry, and a casing the entry does not have.
   */
  const nfcLink = 'Café'.normalize('NFC')
  const nfdLink = 'Café'.normalize('NFD')
  symlinkSync(join(linkBox, 'Elsewhere', 'Archive'), join(linkBox, nfcLink))
  const LINK_NORMALISES = existsSync(join(linkBox, nfdLink))
  const viaNormalised = await planProfile(linkBox, nfdLink)
  check(
    'an NFD-typed symlinked child resolves to the NFC entry when this volume normalises',
    [viaNormalised.action, viaNormalised.root],
    LINK_NORMALISES ? ['reuse', join(linkBox, nfcLink)] : ['create', join(linkBox, nfdLink)]
  )
  check(
    'and that root is byte-identical to the entry readdir reports, not the typed spelling',
    readdirSync(linkBox)
      .map((n) => join(linkBox, n))
      .includes(viaNormalised.root),
    true
  )
  const viaWrongCase = await planProfile(linkBox, 'lINK')
  check(
    'a wrong-cased symlinked child comes back with its own on-disk spelling',
    [viaWrongCase.action, viaWrongCase.root],
    LINK_CASE_BLIND ? ['reuse', join(linkBox, 'Link')] : ['create', join(linkBox, 'lINK')]
  )
} finally {
  rmSync(linkBox, { recursive: true, force: true })
}

console.log('\nan unreadable folder is refused in words, not thrown across IPC')
/*
 * `resolveOnDisk` narrowed its catch to `ENOENT` so an unreadable folder could
 * never be misread as "create" — right, but `profiles:plan` (index.ts:1136) is
 * a debounced keystroke handler that previously could not throw at all. The
 * renderer catches it, so nothing crashes; the costs are that the user reads
 * `Error invoking remote method 'profiles:plan': Error: EACCES: permission
 * denied, realpath '…'`, and that `setPlan` is skipped, leaving the preview
 * describing the *previous* name underneath the new failure.
 *
 * macOS makes this reachable with nothing broken at all: an unentitled build
 * gets EPERM/EACCES from realpath under ~/Documents, ~/Desktop and iCloud
 * Drive. `chmod 000` is the portable stand-in. Root ignores the mode bits, so
 * whether the folder is really unreadable is probed rather than assumed.
 */
const denyBox = mkdtempSync(join(tmpdir(), 'stoke-plan-deny-'))
try {
  mkdirSync(join(denyBox, 'Work'))
  chmodSync(denyBox, 0o000)
  let denied = false
  try {
    readdirSync(denyBox)
  } catch {
    denied = true
  }
  if (!denied) {
    console.log('  NOTE  this process can read a 0o000 directory (root?); refusal case not exercised')
  } else {
    const refused = await planProfile(denyBox, 'Work')
    check(
      'a folder that cannot be read is refused with a sentence, not an errno',
      refused.error,
      `Stoke is not allowed to read ${denyBox}. Give it access to that folder, or pick another one.`
    )
    check(
      'and it is refused, never quietly planned as a create',
      [refused.root, refused.willCreate],
      ['', false]
    )
    check('the refusal never mentions realpath or a raw code', /realpath|EACCES|EPERM/.test(refused.error ?? ''), false)
  }
  chmodSync(denyBox, 0o700)
  check(
    'ENOENT alone still means "no such spelling", so a readable folder plans normally again',
    (await planProfile(denyBox, 'Study')).action,
    'create'
  )
} finally {
  chmodSync(denyBox, 0o700)
  rmSync(denyBox, { recursive: true, force: true })
}

console.log('\ncreate and willCreate cannot disagree')
/*
 * `describePlan` states the action in words — a `create` promises "It starts
 * empty; anything you put in it joins this profile" — and
 * ProfilesSettings.tsx:467-476 prints that sentence directly above the import
 * list. A `create` plan whose root already exists therefore printed "It starts
 * empty" on top of the projects it had just counted inside. Swept over every
 * shape this module can produce rather than pinned at the one that regressed,
 * because the inconsistency has reappeared once already by a different route.
 */
const shapeBox = mkdtempSync(join(tmpdir(), 'stoke-plan-shapes-'))
try {
  mkdirSync(join(shapeBox, 'Work'))
  mkdirSync(join(shapeBox, 'Work', 'refinity'))
  mkdirSync(join(shapeBox, 'Elsewhere'))
  mkdirSync(join(shapeBox, 'Elsewhere', 'Target'))
  symlinkSync(join(shapeBox, 'Elsewhere', 'Target'), join(shapeBox, 'Link'))
  symlinkSync(join(shapeBox, 'Work'), join(shapeBox, 'Sibling'))
  symlinkSync(join(shapeBox, 'nowhere-at-all'), join(shapeBox, 'Dangling'))

  const shapes: [string, string][] = [
    [shapeBox, 'Work'],
    [shapeBox, 'work'],
    [shapeBox, 'WORK'],
    [shapeBox, 'Link'],
    [shapeBox, 'link'],
    [shapeBox, 'Sibling'],
    [shapeBox, 'Target'],
    [shapeBox, 'Study'],
    [shapeBox, '...'],
    [join(shapeBox, 'Work'), 'Work'],
    [join(shapeBox, 'Work'), 'work'],
    [join(shapeBox, 'Link'), 'Target'],
    [join(shapeBox, 'Elsewhere'), 'Target']
  ]
  const disagreed: string[] = []
  const wrongGroup: string[] = []
  for (const [folder, name] of shapes) {
    const p = await planProfile(folder, name)
    if (p.error) continue
    if ((p.action === 'create') !== p.willCreate) {
      disagreed.push(`${name} in ${basename(folder)}: ${p.action}/willCreate=${p.willCreate}`)
    }
    // The root always sits under the folder the user picked, so nothing a
    // symlink points at can relocate the profile.
    if (p.root !== folder && !p.root.startsWith(folder + '/') && !p.root.startsWith(folder + '\\')) {
      wrongGroup.push(`${name} -> ${p.root}`)
    }
  }
  check('no plan says create while nothing would be created', disagreed, [])
  check('and no plan is rooted outside the folder that was picked', wrongGroup, [])

  // A dangling symlink is the one shape that cannot be planned at all: it is
  // not a directory, so it can only be a create, and mkdir will refuse the
  // name. Recorded so the limit is known rather than discovered.
  const dangling = await planProfile(shapeBox, 'Dangling')
  check(
    'a dangling symlink plans as a create, which mkdir will then reject',
    [dangling.action, dangling.willCreate],
    ['create', true]
  )
} finally {
  rmSync(shapeBox, { recursive: true, force: true })
}

console.log('\nthe shape none of the 13 above can reach: listable is not the same question as traversable')
/*
 * Every shape above sits inside a directory this process can list, so
 * `entryByIdentity`'s `readdirSync` always succeeds there and the invariant
 * holds for a reason that has nothing to do with `profiles.ts:417`'s guard.
 * `chmod 0o111` — execute only, no read — makes a directory traversable
 * without being listable: `lstat` of a *named* entry inside it still
 * succeeds, but `readdirSync` gets `EACCES`. That is exactly the gap
 * `entryByIdentity` straddles, and it is an ordinary shape on a real disk,
 * not a contrived one — it is the same permission gap that makes an
 * unentitled macOS build unable to `realpath` under iCloud Drive.
 *
 * With `dir` unlistable, `entryByIdentity` returns null, so `existingChild`
 * returns null for a symlinked child that is genuinely there, and
 * `planProfile` falls through to `root = join(dir, name)` — the *typed*
 * spelling, never listed. `isDirectory(root)` then `stat`s that path
 * directly, which needs no read permission on `dir` at all, follows the
 * symlink, and answers true: `willCreate: false` under an `action` that has
 * not yet been told. Only the guard reconciles the two. Root ignores
 * permission bits, so — same discipline as every probed fixture above —
 * whether the directory is actually unlistable is measured, not assumed.
 */
const guardBox = mkdtempSync(join(tmpdir(), 'stoke-plan-guard-'))
try {
  mkdirSync(join(guardBox, 'Target'))
  symlinkSync(join(guardBox, 'Target'), join(guardBox, 'Link'))
  chmodSync(guardBox, 0o111)
  let listDenied = false
  try {
    readdirSync(guardBox)
  } catch {
    listDenied = true
  }
  if (!listDenied) {
    console.log('  NOTE  this process can list a 0o111 directory (root?); guard fixture not exercised')
  } else {
    const guarded = await planProfile(guardBox, 'Link')
    check(
      'entryByIdentity cannot list the directory, so the guard is what keeps action and willCreate in agreement',
      [guarded.action, guarded.willCreate],
      ['reuse', false]
    )
  }
} finally {
  chmodSync(guardBox, 0o700)
  rmSync(guardBox, { recursive: true, force: true })
}

console.log('\nthe scan-root dedupe asks the same filesystem the plan did')
/*
 * The dedupe decides whether `plan.root` is appended to `settings.projectRoots`
 * — and a root that is wrongly judged "already known" is never registered, so
 * the profile is stored, its folder is made or reused, and it renders empty.
 * That is the original "pressed Create and nothing appeared" bug.
 *
 * This used to be asserted *unconditionally*, alone among the fixtures here
 * while CASE_BLIND, NORMALISES, FOLDS_NON_ASCII and LINK_CASE_BLIND all probe
 * the volume. On a case-sensitive volume `<box>/work` is not on disk at all,
 * so `reuse <box>/Work` is a genuinely new root and must be appended — but
 * `pathKey` folded it by `pathRulesFor('darwin')`, called it known, and
 * dropped it. The unconditional assertion agreed with the bug and reported
 * "all pass" on the one volume the fix existed for. So it is probed like
 * everything else: SAME_FOLDER is measured off the box, and the two branches
 * are different answers to a different disk, not a preference.
 *
 * Both checks are still needed together against `pathKey` -> `'CONSTANT'`: a
 * constant key passes the first (everything looks known) and fails the second
 * (an unrelated root would look known too, and never get appended).
 */
const dedupeBox = mkdtempSync(join(tmpdir(), 'stoke-plan-dedupe-'))
try {
  mkdirSync(join(dedupeBox, 'Work'))
  const swatch = {
    accent: '#4ecdc4',
    accentHover: '#77dcd5',
    accentSoft: 'rgba(78, 205, 196, 0.14)',
    accentContrast: '#041a18'
  }

  const staleRoot = join(dedupeBox, 'work')
  // Not `pathRulesFor`: whether this spelling names the same directory is the
  // thing under test, and the filesystem is the only thing that knows.
  const SAME_FOLDER = existsSync(staleRoot)
  const staleSettings = { profiles: [], projectRoots: [staleRoot] } as unknown as Settings
  const staleResult = await createProfile(staleSettings, { folder: dedupeBox, name: 'Work', ...swatch })
  check(
    SAME_FOLDER
      ? 'a stale wrong-cased root is the same folder here, so nothing is added'
      : 'a wrong-cased root names nothing here, so the real root is still registered',
    staleResult.patch.projectRoots,
    SAME_FOLDER ? [staleRoot] : [staleRoot, join(dedupeBox, 'Work')]
  )
  /*
   * The assertion that does not care which volume this is, and the one the bug
   * actually broke: whatever ends up in projectRoots, one of them has to *be*
   * the folder the plan chose. On the case-sensitive volume the wrong-cased
   * root resolved to nothing at all and the real one was never appended, so
   * the profile had no scan root and rendered empty.
   */
  const realRoot = realpathSync.native(staleResult.plan.root)
  check(
    'either way, some registered root really is the profile folder',
    staleResult.patch.projectRoots?.some((r) => {
      try {
        return realpathSync.native(r) === realRoot
      } catch {
        return false
      }
    }),
    true
  )

  const unrelatedRoot = join(dedupeBox, 'Elsewhere')
  const unrelatedSettings = { profiles: [], projectRoots: [unrelatedRoot] } as unknown as Settings
  const unrelatedResult = await createProfile(unrelatedSettings, { folder: dedupeBox, name: 'Work', ...swatch })
  check(
    'an unrelated root already in the list does not swallow a genuinely new one',
    unrelatedResult.patch.projectRoots,
    [unrelatedRoot, join(dedupeBox, 'Work')]
  )

  // The same folder written two ways that are not string-equal on any
  // platform: the filesystem resolves both, so it is added once.
  const indirect = join(dedupeBox, 'Work', '..', 'Work')
  const indirectSettings = { profiles: [], projectRoots: [indirect] } as unknown as Settings
  const indirectResult = await createProfile(indirectSettings, { folder: dedupeBox, name: 'Work', ...swatch })
  check(
    'a root spelled through .. is recognised as the folder it really is',
    indirectResult.patch.projectRoots,
    [indirect]
  )
} finally {
  rmSync(dedupeBox, { recursive: true, force: true })
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

console.log('\na working directory resolves to a profile')
/*
 * The renderer needs this to point the chip at whatever tab is in front, and
 * duplicating the longest-prefix rule there is exactly what the design
 * forbids. It lives in shared/paths.ts beside groupForCwd, takes the
 * platform's rules as an argument rather than reading `process`, and is
 * therefore the same function in both processes — and testable here.
 *
 * POSIX paths and an explicit 'darwin' throughout, so these cases mean the
 * same thing whichever machine runs the suite.
 */
const proj = (path: string, group: string): Project => ({
  path,
  name: path.split(/[\\/]/).pop() ?? path,
  group,
  encodedDir: null,
  sessionCount: 0,
  lastModified: null,
  lastCost: null,
  lastPrompt: null,
  exists: true,
  pinned: false,
  emoji: null,
  label: null,
  addedManually: false
})

const MAC = 'darwin'
/* `/Users/v/dev/work` is both a scan root and — because a session was once
   started in it — a registered project whose own group is `dev`. That is the
   shape that made 7 of 12 work folders unwatched. */
const macProjects: Project[] = [
  proj('/Users/v/dev/personal/stoke', 'personal'),
  proj('/Users/v/dev/work/buyback', 'work'),
  proj('/Users/v/dev/work', 'dev')
]
const macRoots = ['/Users/v/dev/work']
const macProfiles = [
  { id: 'personal', groups: ['personal'] },
  { id: 'Work', groups: ['work'] }
]

check(
  'a tab in a project resolves to the profile covering its group',
  profileIdForCwd('/Users/v/dev/personal/stoke', macProjects, macRoots, macProfiles, MAC),
  'personal'
)
check(
  'a cwd a level down inside it resolves the same',
  profileIdForCwd('/Users/v/dev/personal/stoke/src/main', macProjects, macRoots, macProfiles, MAC),
  'personal'
)
check(
  'the profile id is returned, not the folder name',
  profileIdForCwd('/Users/v/dev/work/buyback', macProjects, macRoots, macProfiles, MAC),
  'Work'
)
check(
  'a folder under a scan root with no history of its own still resolves',
  profileIdForCwd('/Users/v/dev/work/postable', macProjects, macRoots, macProfiles, MAC),
  'Work'
)
check(
  'APFS case is folded, so a differently-cased path is the same path',
  profileIdForCwd('/Users/V/DEV/Work/Buyback', macProjects, macRoots, macProfiles, MAC),
  'Work'
)
check(
  'a group no profile covers resolves to nothing — the chip is left alone',
  profileIdForCwd('/Users/v/dev/personal/stoke', macProjects, macRoots, [macProfiles[1]], MAC),
  null
)
check(
  'an ssh alias is not a path, so it resolves to nothing',
  profileIdForCwd('vps-syd', macProjects, macRoots, macProfiles, MAC),
  null
)
check(
  'an empty cwd resolves to nothing rather than the first project',
  profileIdForCwd('', macProjects, macRoots, macProfiles, MAC),
  null
)
check(
  'a profile covering several groups matches on any of them',
  profileIdForCwd(
    '/Users/v/dev/personal/stoke',
    macProjects,
    macRoots,
    [{ id: 'Everything', groups: ['work', 'personal'] }],
    MAC
  ),
  'Everything'
)
check(
  'and windows paths resolve under the windows rules',
  profileIdForCwd(
    'G:\\Code\\gitea-company\\refinity',
    [proj('G:\\Code\\gitea-company\\refinity', 'gitea-company')],
    [],
    [{ id: 'gitea-company', groups: ['gitea-company'] }],
    'win32'
  ),
  'gitea-company'
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
