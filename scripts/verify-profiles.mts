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
 * The colour blocks at the end are the third bug, and the one this suite was
 * complicit in. It measured `accentContrast` against `accent` — the ink on the
 * fill, a pair that never touches the page — and imported BUILT_IN_THEMES only
 * to print a number it did not assert. So nothing compared a profile colour to
 * the ground it is drawn on, and all eight swatches measured 1.43-2.52:1
 * against the light theme's page — the range the raw-swatch block below still
 * prints — while `npm run check` stayed green. CLAUDE.md gotcha 31.
 *
 *   node scripts/verify-profiles.mts
 */
import type { ProfileConfig, Project, Settings } from '../src/shared/types.ts'
import { profileIdForCwd } from '../src/shared/paths.ts'
import { apcaContrast, parseColor, perceptualDistance, type Rgb } from '../src/shared/color.ts'
import { deriveAccent } from '../src/shared/accent.ts'
import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
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
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  'named folders no longer swallow the rest of the machine',
  ids({ personal: 6, school: 3, work: 3, Documents: 2, WINDOWS: 1 }),
  ['personal', 'school', 'work', 'Documents']
)
check(
  'they keep their given order, not the folder count order',
  labels({ work: 9, personal: 1 }),
  ['Personal', 'Work']
)
check('a named folder is matched however it is cased', ids({ PERSONAL: 4 }), ['personal'])

console.log('\na machine organised some other way')
check(
  'unknown folders become profiles when nothing named matches',
  ids({ clients: 5, lab: 3, uni: 2 }),
  ['clients', 'lab', 'uni']
)
check('and are named readably', labels({ 'my-projects': 4, clients: 2 }), ['My projects', 'Clients'])
check(
  'a lone repo parked somewhere is not a category of work',
  ids({ clients: 4, Downloads: 1, Desktop: 1 }),
  ['clients']
)
check('no folders at all yields nothing rather than throwing', ids({}), [])
check('a single project overall yields nothing', ids({ Code: 1 }), [])

console.log('\none profile is still a choice')
check('a mac with one work folder still gets a profile', ids({ Code: 4 }), ['Code'])

console.log('\nnamed folders no longer suppress the rest of the machine')
/*
 * The early return was `if (known.length) return known`. Measured against the
 * live ~/.claude.json on this Mac: `personal` is the only folder matching a
 * named profile, so the derived list was exactly ['personal'] — the
 * five-project `work` folder, which is the entire reason profiles exist here,
 * could never be seeded, and neither could anything else. A user-made record
 * was the only way to get a second chip, which is why one exists in settings.
 */
check(
  'a folder holding real work beside the named ones is seeded too',
  ids({ personal: 8, clients: 5, dev: 3, Documents: 1 }),
  ['personal', 'clients', 'dev']
)
check(
  'this machine, measured: clients, dev, scratch and Codes were all invisible',
  ids({ personal: 8, clients: 5, dev: 3, scratch: 3, Codes: 2 }),
  ['personal', 'clients', 'dev', 'scratch', 'Codes']
)
check(
  'the named ones still come first, in their own order',
  labels({ clients: 9, personal: 1, school: 2 }),
  ['Personal', 'Study', 'Clients']
)
check(
  'extras wear the fallback colours, which no named seed wears',
  deriveProfiles(counts({ personal: 6, clients: 5, lab: 2 })).map((p) => p.accent),
  ['#ff9552', '#6ea8fe', '#f7c948']
)
/* `school` is labelled Study. A folder literally called `study` beside it would
   put two chips reading Study in one row, and the chip is the only thing the
   user sees — so the named profile's label claims that name too. This is why
   the seed claims both an id and a label, and it is the case the 0.4.0 rename
   of `work` -> `work` could no longer exercise: `work` is labelled
   Work, so its id and its label are the same word. */
check(
  'a folder a named profile already speaks for is not seeded twice',
  ids({ school: 3, study: 2 }),
  ['school']
)
check('nor is one folder in two spellings', ids({ Clients: 5, clients: 2 }), ['Clients'])
/* The named loop claims both an id and a label; the extras loop claimed only
   the id, so two folders that are different ids but title-case to the same
   words each got a chip. `My stuff` twice, told apart only by hover. */
check(
  'nor do two folders that read as the same word',
  ids({ my_stuff: 5, 'my-stuff': 3 }),
  ['my_stuff']
)
check(
  'a stray with one project is still not a category of work',
  ids({ personal: 6, Downloads: 1 }),
  ['personal']
)
check(
  'at most four extras are seeded, so the chip row cannot run away',
  ids({ personal: 2, a: 9, b: 8, c: 7, d: 6, e: 5 }),
  ['personal', 'a', 'b', 'c', 'd']
)

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
    id: 'work',
    label: 'Work',
    accent: '#5fd08a',
    accentHover: '#83deA5',
    accentSoft: 'rgba(95, 208, 138, 0.14)',
    accentContrast: '#08170f'
  }
]
/* No stray folder in here: this fixture backs the frozen LEGACY_NAMED lock and
   the deletion cases below, all of which are about the named seeds themselves.
   The folder-derived half of the list has its own block above. */
const namedMachine = counts({ personal: 6, school: 3, 'work': 3 })
check(
  'every derived field is unchanged',
  resolveProfiles(namedMachine, []).map(({ groups: _groups, ...rest }) => rest),
  LEGACY_NAMED
)
check(
  'and each seed covers its own folder',
  resolveProfiles(namedMachine, []).map((p) => p.groups),
  [['personal'], ['school'], ['work']]
)
check(
  'the fallback layout is unchanged too',
  resolveProfiles(counts({ clients: 5, lab: 3 }), []).map((p) => [p.id, p.accent]),
  [
    ['clients', '#6ea8fe'],
    ['lab', '#f7c948']
  ]
)

console.log('\na profile the user made')
/*
 * The bug, in one case. On this machine personal/school/work all exist,
 * so the derived list early-returned them and stopped; and Task holds one
 * project, which the other branch dropped. Either way the user pressed Create
 * and nothing appeared.
 */
const withTask = counts({ personal: 6, school: 3, 'work': 3, Task: 1 })
const taskRecord = rec({ id: 'Task', label: 'Task', createdByUser: true })
check(
  'appears next to the named ones, which it never could before',
  resolveProfiles(withTask, [taskRecord]).map((p) => p.id),
  ['personal', 'school', 'work', 'Task']
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
const windowsConfig = [rec({ id: 'work', label: 'Work' }), rec({ id: 'personal' })]
check(
  'a mac keeps the windows records rather than eating them',
  resolveProfiles(macCounts, windowsConfig).map((p) => p.id),
  ['Code', 'work', 'personal']
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
    ['work', 1]
  ]
)
check(
  'the chip is gone even though the folder is still full of projects',
  visibleProfiles(resolveProfiles(namedMachine, tombstone), namedMachine).map((p) => p.id),
  ['personal', 'work']
)
check(
  'and nothing resolves it back into the accent',
  profileFor('school', visibleProfiles(resolveProfiles(namedMachine, tombstone), namedMachine)),
  null
)
check(
  'deleting a user-made profile just drops the record',
  visibleProfiles(resolveProfiles(withTask, []), withTask).map((p) => p.id),
  ['personal', 'school', 'work']
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
    /*
     * The same probe the check above branches on, and for the same reason.
     * Where the volume does not normalise, that check already established this
     * is a `create`: the NFD name is a folder that does not exist yet, so it is
     * correctly absent from a listing of what does. Asserting membership
     * unconditionally asserts that create plans name existing directories —
     * true on APFS only because the NFC entry is what comes back, which is the
     * accident this pair of checks exists to rule out.
     */
    LINK_NORMALISES
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
    'G:\\Code\\work\\refinity',
    [proj('G:\\Code\\work\\refinity', 'work')],
    [],
    [{ id: 'work', groups: ['work'] }],
    'win32'
  ),
  'work'
)
/*
 * The case above proves nothing about Windows, and that is worth saying rather
 * than leaving for the next person to discover. `pathRulesFor`'s win32 and
 * darwin rules differ only in `sep`, and `sep` is unobservable here:
 * `normalizePath` canonicalises both compared strings to whichever separator is
 * chosen, symmetrically, so `isInside`'s prefix test cannot see the choice, and
 * the group comes from `Project.group` rather than from any reconstructed path.
 * Measured: hardcoding pathRulesFor('linux') inside profileIdForCwd — case
 * SENSITIVE and the wrong separator — still passes the check above.
 *
 * Case folding is the one win32 property that does show through, so this is the
 * assertion that actually holds the Windows branch down. There is no machine to
 * run Windows on in this project, so this literal is the only coverage it gets.
 */
check(
  'a Windows path still matches its project when only the casing differs',
  profileIdForCwd(
    'C:\\Users\\V\\Dev\\Thing',
    [proj('c:\\users\\v\\dev\\thing', 'dev')],
    [],
    [{ id: 'Work', groups: ['dev'] }],
    'win32'
  ),
  'Work'
)

console.log('\nthe chip stays out of the main process')
/*
 * The worklog gate is keyed on a session's own folder and never on the sidebar
 * selection — gate.ts's header is three paragraphs on why, and both failures
 * are silent. Making the chip follow the active tab is only safe because
 * nothing over there reads it, so that is asserted rather than remembered.
 *
 * A source scan, not a type: the coupling this guards against is one `import
 * { getSettings }` away and would typecheck perfectly.
 */
const MAIN = fileURLToPath(new URL('../src/main/', import.meta.url))

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const mentionsChip = tsFilesUnder(MAIN)
  .filter((f) => readFileSync(f, 'utf8').includes('activeProfile'))
  .map((f) => f.slice(MAIN.length).split('\\').join('/'))

/*
 * The two files that may name it: one declares the default and repairs the
 * stored value, the other persists what it is given. Neither decides anything
 * with it. Adding a third is a deliberate act — read gate.ts's header first.
 */
const SETTINGS_FILES = ['settingsSchema.ts', 'store.ts']
check(
  'only the settings files name it, and they only store it',
  mentionsChip.filter((f) => !SETTINGS_FILES.includes(f)),
  []
)
check(
  'the worklog in particular never sees it',
  mentionsChip.filter((f) => f.startsWith('worklog/')),
  []
)

console.log('\ncolour alone cannot say which profile is active')
/*
 * A profile overrides the theme's accent, so "the accent changed" looks like a
 * sufficient signal. It is not: PROFILES[0].accent is the app's own accent by
 * design, so selecting Personal on Ember changes nothing at all — and that is
 * not the only collision.
 *
 * Printed, not asserted. Both numbers move as the palette changes, so a check
 * comparing them (nearestThemeToProfile < nearestSwatches, or its opposite)
 * would fail — for the wrong reason — the day someone improves the palette
 * enough to close the gap: it would turn `npm run check` red for fixing the
 * exact problem this readout exists to surface. There is no fixed threshold on
 * nearestThemeToProfile that is honest either: today it is 0 (Ember and
 * Personal are the same string) by design, not by accident, and this task
 * deliberately does not change that — so asserting "stays near 0" would be
 * asserting a defect must persist, and asserting "clears some bound" would be
 * asserting a fix this task explicitly declines to make. The number is for a
 * human to read.
 */
const rgb = (hex: string): Rgb => {
  const c = parseColor(hex)
  if (!c) throw new Error(`unparseable colour ${hex}`)
  return c
}
const gap = (a: string, b: string): number => perceptualDistance(rgb(a), rgb(b))

/** The smallest gap the palette itself treats as two different colours. */
let nearestSwatches = Infinity
for (let i = 0; i < PROFILE_SWATCHES.length; i++) {
  for (let j = i + 1; j < PROFILE_SWATCHES.length; j++) {
    nearestSwatches = Math.min(
      nearestSwatches,
      gap(PROFILE_SWATCHES[i].accent, PROFILE_SWATCHES[j].accent)
    )
  }
}

const wearableAccents = [
  ...PROFILES.map((p) => p.accent),
  ...PROFILE_SWATCHES.map((s) => s.accent)
]
let nearestThemeToProfile = Infinity
for (const theme of BUILT_IN_THEMES) {
  for (const accent of wearableAccents) {
    nearestThemeToProfile = Math.min(nearestThemeToProfile, gap(theme.colors.accent, accent))
  }
}

console.log(
  `  nearest two swatches ${nearestSwatches.toFixed(3)}; ` +
    `nearest theme accent to a profile accent ${nearestThemeToProfile.toFixed(3)}`
)
/*
 * `nearestThemeToProfile` stays a printed number, not an assertion: it is 0.000
 * by design — Ember's accent and Personal's are the same literal `#ff9552`, and
 * Nocturne's is the Azure swatch's — so any threshold would either demand the
 * collision persists or demand a fix this task does not make.
 *
 * `nearestSwatches` is a different number and does carry a guard. It measures
 * the swatches against EACH OTHER, where a collision is a plain defect: two
 * chips a user picked deliberately would become indistinguishable. Today it is
 * 0.083 (Moss vs Teal), so the floor below sits at half that — far enough not
 * to punish a palette tweak, close enough that a collapse to 0 cannot pass.
 */
check('no two swatches a user can pick are the same colour', nearestSwatches >= 0.04, true)

console.log('\nevery swatch against every theme, in both appearances')
/*
 * The assertion the invisible focus ring walked straight through, and the
 * reason src/shared/accent.ts exists at all. `--accent-ink` is the
 * `:focus-visible` outline, the context ring's stroke, the tab indicator and
 * eight `color:` rules in app.css, so it is judged against the page rather
 * than against the fill it used to be judged against.
 *
 * The four named seeds wear the first four swatches byte for byte, so
 * PROFILE_SWATCHES is the entire set of colours a profile can end up in — not
 * a sample of it. The UI has no free-form colour input precisely so that stays
 * true, which is the same argument the block above makes for `wearable`.
 */
/*
 * Mirrored from src/shared/accent.ts, which exports none of them. If you
 * change one, change the other — this is the assertion that catches it.
 */
const ACCENT_LC = 60
const ACCENT_WCAG = 4.5
const AT_FLOOR_TOLERANCE = 2
const INK_LIGHT = '#ffffff'
const INK_DARK = '#12100e'
/*
 * An outline is a non-text UI component, so WCAG 1.4.11's bar is 3:1 rather
 * than 4.5:1. `--bg-sunken` is the ground under the sidebar and the tab strip,
 * where most focusable chrome actually sits, and `deriveAccent` deliberately
 * solves against `--bg` instead (accent.ts:176-183, about 4 Lc apart) — so the
 * sunken ground is the one nothing solves for and the one worth pinning.
 */
const RING_WCAG = 3

const lcOf = (fg: string, bg: string): number => Math.abs(apcaContrast(rgb(fg), rgb(bg)))

for (const theme of BUILT_IN_THEMES) {
  for (const s of PROFILE_SWATCHES) {
    const d = deriveAccent(s.accent, theme.appearance, theme.colors.bg)
    const inkWcag = ratio(d.accentInk, theme.colors.bg)
    const inkLc = lcOf(d.accentInk, theme.colors.bg)
    const ringWcag = ratio(d.accentInk, theme.colors.bgSunken)
    const labelLc = lcOf(d.accentContrast, d.accent)
    /*
     * Two Lc floors, and the split is the promise rather than a fudge.
     * `AT_FLOOR_TOLERANCE` exists so a swatch already sitting a hair under Lc
     * 60 on a dark page stays exactly as authored — measured here, Ember lands
     * at 59.18-59.41 and Blossom at 58.70-58.93 across the three dark themes,
     * and moving them would change every dark theme's accent by one 8-bit step
     * for no legibility gain. So the tolerance is spendable only on KEEPING the
     * brand colour: an ink `deriveAccent` actually moved must clear the full Lc
     * 60, and the ones it moves measure 60.02 at worst. A flat 58 everywhere
     * would let a derived ink land in that band too, which the tolerance was
     * never for.
     */
    const kept = d.accentInk.toLowerCase() === s.accent.toLowerCase()
    const lcFloor = kept ? ACCENT_LC - AT_FLOOR_TOLERANCE : ACCENT_LC
    const why = [
      inkWcag >= ACCENT_WCAG ? '' : `ink ${inkWcag.toFixed(2)}:1 on the page`,
      inkLc >= lcFloor ? '' : `ink Lc ${inkLc.toFixed(1)} on the page, floor ${lcFloor}`,
      ringWcag >= RING_WCAG ? '' : `ring ${ringWcag.toFixed(2)}:1 on the sunken ground`,
      labelLc >= ACCENT_LC ? '' : `label Lc ${labelLc.toFixed(1)} on the fill`
    ].filter((m) => m !== '')
    if (why.length) failures++
    console.log(
      `  ${why.length ? 'FAIL' : 'PASS'}  ${theme.name.padEnd(9)}${s.name.padEnd(9)}` +
        `ink ${d.accentInk}  page ${inkWcag.toFixed(2).padStart(5)}:1 Lc ${inkLc.toFixed(1).padStart(4)}` +
        `  ring ${ringWcag.toFixed(2).padStart(5)}:1` +
        `  label Lc ${labelLc.toFixed(1).padStart(4)}` +
        (why.length ? `\n        ${why.join('; ')}` : '')
    )
  }
}

console.log('\nthe raw stored swatches, which are why deriveAccent has to exist')
/*
 * This one is pinning a defect on purpose, so it is worth being explicit about
 * what it means. `PROFILE_SWATCHES[].accent` is hand-authored for a dark
 * ground; the block above proves what `deriveAccent` makes of it, and this
 * proves there was something to make. Without it, `deriveAccent` could be
 * reduced to `accentInk = accent` and every assertion above would still pass on
 * the dark themes while the light one went back to a 1.98:1 focus ring.
 *
 * If a future palette change makes the stored values light-safe by themselves,
 * DELETE this assertion rather than working around it: it will be stating
 * something that is no longer true, and the honest response is that the
 * derivation has less to do, not that the palette has regressed.
 */
const lightThemes = BUILT_IN_THEMES.filter((t) => t.appearance === 'light')
const darkThemes = BUILT_IN_THEMES.filter((t) => t.appearance === 'dark')

/*
 * Coverage, asserted rather than assumed -- and this is not defensive padding.
 *
 * An adversarial pass on the first version of this file removed DAYLIGHT from
 * BUILT_IN_THEMES and the suite printed "all pass". Every light-mode row
 * vanished, the "unaided" check below was skipped by its own `else`, and the
 * entire reason src/shared/accent.ts exists went untested -- silently, because
 * a filter that yields nothing makes every loop over it succeed.
 *
 * The same shape guards the dark side below. A suite whose value is coverage
 * has to assert its coverage.
 */
check('a light built-in theme exists to test against', lightThemes.length > 0, true)
check('a dark built-in theme exists to test against', darkThemes.length > 0, true)
check('every swatch is a colour', PROFILE_SWATCHES.length > 0, true)

{
  for (const t of lightThemes) {
    const raw = PROFILE_SWATCHES.map((s) => ({ name: s.name, r: ratio(s.accent, t.colors.bg) })).sort(
      (a, b) => a.r - b.r
    )
    const under = raw.filter((x) => x.r < RING_WCAG)
    console.log(
      `  ${t.name}: ${under.length} of ${raw.length} raw accents under ${RING_WCAG}:1 on --bg, ` +
        `${raw[0].r.toFixed(2)} (${raw[0].name}) to ${raw[raw.length - 1].r.toFixed(2)} (${raw[raw.length - 1].name})`
    )
  }
  /*
   * `every`, not `some`, on both axes.
   *
   * `some`-of-`some` is satisfied by one bad swatch on one theme, so seven of
   * the eight could become light-safe while this still printed a pass over the
   * line "1 of 8 raw accents under 3:1". The claim being pinned is that the
   * WHOLE palette needs the derivation, so that is what is asserted.
   */
  check(
    'a stored accent is still unusable as ink on a light page, unaided',
    lightThemes.every((t) => PROFILE_SWATCHES.every((s) => ratio(s.accent, t.colors.bg) < RING_WCAG)),
    true
  )
}

console.log('\nderiving never restyles the colour someone picked')
/*
 * The other half of the promise, and the one that would be easy to break while
 * fixing the ring: deriving the FILL as well as the ink would have quietly
 * repainted three of the eight shipped swatches in dark mode, which is a
 * product decision rather than an accessibility fix (accent.ts:44-59).
 *
 * So the fill moves for exactly one reason — the ~7 L* dead band where neither
 * near-white nor near-ink reaches Lc 60 on it, leaving a filled button with no
 * legible label at any ink. `deadBand` recomputes that from the two candidate
 * inks rather than asking `deriveAccent` which swatches it moved, so the two
 * are independent answers to the same question. Measured today: Coral, Iris and
 * Azure are in the band and move by 0.0144, 0.0289 and 0.0334 — all inside the
 * 0.04 the check above calls one colour rather than two.
 */
/** The same 0.04 the swatch-distinctness floor above uses, read the other way
    round: a fill that moved less than this is still the colour that was picked. */
const SAME_COLOUR = 0.04
const deadBand = (fill: string): boolean =>
  Math.max(lcOf(INK_LIGHT, fill), lcOf(INK_DARK, fill)) < ACCENT_LC

const restyled: string[] = []
const strayed: string[] = []
const nudged = new Map<string, string>()
for (const theme of BUILT_IN_THEMES.filter((t) => t.appearance === 'dark')) {
  for (const s of PROFILE_SWATCHES) {
    const fill = deriveAccent(s.accent, theme.appearance, theme.colors.bg).accent
    if (fill === s.accent) continue
    const moved = gap(fill, s.accent)
    nudged.set(s.name, `${s.name} ${s.accent} -> ${fill} by ${moved.toFixed(4)}`)
    if (!deadBand(s.accent)) restyled.push(`${theme.name}/${s.name}`)
    if (moved >= SAME_COLOUR) strayed.push(`${theme.name}/${s.name} ${moved.toFixed(4)}`)
  }
}
for (const line of nudged.values()) console.log(`  nudged out of the dead band: ${line}`)
/*
 * What this pins, stated honestly: `deadBand` here recomputes the SAME
 * expression `deriveAccent` uses to decide whether to move a fill, so it cannot
 * fail because of a palette change -- brute-forcing 141,840 sRGB colours
 * through both leaves `restyled` empty every time. It is a code-drift mirror:
 * it goes red when accent.ts's ACCENT_LC or its ink candidates move without
 * this file following, and when the round trip through toOklch/fitToSrgb/toHex
 * stops being byte-exact. Both were confirmed red by perturbation.
 *
 * The check after it -- that a moved fill stayed inside 0.04 -- is the one a
 * new swatch colour can actually break: 243 of those 141,840 colours nudge
 * further than that, and Azure already uses 0.0334 of the 0.04.
 */
check('a dark theme keeps every fill that has a legible label, byte for byte', restyled, [])
check('and the ones it does move are still the colour that was picked', strayed, [])

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
