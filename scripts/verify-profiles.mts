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
import type { ProfileConfig, Settings } from '../src/shared/types.ts'
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
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
 * There is a real, accepted gap this does not close, and it has nothing to
 * do with case: a *child* that is itself a symlink to a target with a
 * different basename (`Link` -> `.../Target2`) resolves to a basename,
 * `Target2`, that is not an entry of the parent at all, so `existingChild`
 * safely returns null (see its doc) rather than a fabricated path — even
 * typed with its own exact on-disk casing, `Link`. `planProfile` then falls
 * through to `create`, and its fallback `isDirectory` check *does* find the
 * symlink (case-insensitively resolved, on a volume that folds), so
 * `willCreate` comes back false — an inconsistent `create` + `willCreate:
 * false` plan, the same shape Important 2 closed, reopened here for
 * symlinked children specifically. That is measured below, not papered over.
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
  mkdirSync(join(linkBox, 'Elsewhere', 'Target2'))
  symlinkSync(join(linkBox, 'Elsewhere', 'Target2'), join(linkBox, 'Link'))

  // Exact on-disk casing, deliberately — this gap is not a casing problem.
  const viaSymlinkedChild = await planProfile(linkBox, 'Link')
  check(
    'the accepted gap: a symlinked child whose target has a different basename is not matched by existingChild',
    viaSymlinkedChild.action,
    'create'
  )
  check(
    'so the plan is internally inconsistent for this one case: create, yet nothing would actually be made',
    [viaSymlinkedChild.root, viaSymlinkedChild.willCreate],
    [join(linkBox, 'Link'), false]
  )
} finally {
  rmSync(linkBox, { recursive: true, force: true })
}

console.log('\nthe scan-root dedupe key actually dedupes, and actually distinguishes')
/*
 * `pathKey` is only used for `createProfile`'s scan-root dedupe against
 * `settings.projectRoots` — a list compared as strings, which is why it
 * stays platform-folded rather than filesystem-probed like `existingChild`
 * and `isNamed` above. Replacing its body with `return 'CONSTANT'` leaves
 * the suite green without this: both checks are needed together, because a
 * constant key passes the first (everything looks "already known") but fails
 * the second (an unrelated root would also look "already known" and never
 * get appended).
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
  const staleSettings = { profiles: [], projectRoots: [staleRoot] } as unknown as Settings
  const staleResult = await createProfile(staleSettings, { folder: dedupeBox, name: 'Work', ...swatch })
  check(
    'a stale wrong-cased root already in projectRoots is treated as the same folder',
    staleResult.patch.projectRoots,
    [staleRoot]
  )

  const unrelatedRoot = join(dedupeBox, 'Elsewhere')
  const unrelatedSettings = { profiles: [], projectRoots: [unrelatedRoot] } as unknown as Settings
  const unrelatedResult = await createProfile(unrelatedSettings, { folder: dedupeBox, name: 'Work', ...swatch })
  check(
    'an unrelated root already in the list does not swallow a genuinely new one',
    unrelatedResult.patch.projectRoots,
    [unrelatedRoot, join(dedupeBox, 'Work')]
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

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
