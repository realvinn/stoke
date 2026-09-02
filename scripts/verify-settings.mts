/*
 * hydrate() is the only thing standing between a hand-edited settings.json and
 * the app. It used to live behind an `import { app } from 'electron'`, so none
 * of it was ever run outside a window — and it repaired every structured field
 * except the ones that had just been added.
 *
 *   node scripts/verify-settings.mts
 */
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'
import { wallpaperFileFor } from '../src/main/wallpaper.ts'
import { DEFAULT_WORKLOG_BOARDS } from '../src/shared/worklog.ts'
import {
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  activeThemeId,
  followPatch,
  themeSlotFor
} from '../src/shared/themes.ts'
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

console.log('\nthe terminal block, field by field')
check('a machine that has never said gets the defaults', hydrateSettings({}).terminal.lineHeight, 1.3)
/*
 * Unframed by default: the terminal fills its pane. The frame shipped as the
 * default first and is a deliberate look rather than a neutral one, so it is an
 * option now — which means BOTH directions have to hold, or "make it a setting"
 * quietly becomes "we changed it".
 */
check('and an unframed pane, edge to edge', hydrateSettings({}).terminal.frame, false)
check('while a machine that asked for the frame keeps it', hydrateSettings({ terminal: { frame: true } }).terminal.frame, true)
check('line height is clamped to the range xterm draws sanely', [hydrateSettings({ terminal: { lineHeight: 0.4 } }).terminal.lineHeight, hydrateSettings({ terminal: { lineHeight: 9 } }).terminal.lineHeight], [1, 1.6])
check('and snapped to twentieths, so 1.333 does not survive as a slider position', hydrateSettings({ terminal: { lineHeight: 1.333 } }).terminal.lineHeight, 1.35)
check('a cursor style outside the vocabulary falls back', hydrateSettings({ terminal: { cursorStyle: 'beam' } }).terminal.cursorStyle, 'bar')
check('a bold weight that is not 600 or 700 falls back', hydrateSettings({ terminal: { boldWeight: 900 } }).terminal.boldWeight, 600)
check('a contrast boost outside the three offered falls back', hydrateSettings({ terminal: { contrastBoost: 3 } }).terminal.contrastBoost, 1)
check('padding is bounded and whole', [hydrateSettings({ terminal: { padding: -4 } }).terminal.padding, hydrateSettings({ terminal: { padding: 99 } }).terminal.padding, hydrateSettings({ terminal: { padding: 7.6 } }).terminal.padding], [0, 32, 8])
check('one bad field does not take the others with it', hydrateSettings({ terminal: { lineHeight: 'x', cursorBlink: false } }).terminal, { lineHeight: 1.3, letterSpacing: 0, cursorStyle: 'bar', cursorBlink: false, boldWeight: 600, contrastBoost: 1, smoothScroll: true, frame: false, padding: 12 })

console.log('\nthe wallpaper block')
check('none by default', hydrateSettings({}).wallpaper, { path: null, blur: 12, dim: 0.35, opacity: 0.85 })
check('a path is kept', hydrateSettings({ wallpaper: { path: '/x/y.png' } }).wallpaper.path, '/x/y.png')
check('a blank path is none', hydrateSettings({ wallpaper: { path: '  ' } }).wallpaper.path, null)
check('opacity has a floor, because below it text sits on the image', hydrateSettings({ wallpaper: { opacity: 0.1 } }).wallpaper.opacity, 0.5)
check('blur and dim are bounded', [hydrateSettings({ wallpaper: { blur: 99 } }).wallpaper.blur, hydrateSettings({ wallpaper: { dim: 2 } }).wallpaper.dim], [40, 0.9])

console.log('\nthe wallpaper scheme serves one directory and nothing else')
{
  const ud = '/tmp/stoke-ud'
  check('a bare file name in the wallpaper host resolves', wallpaperFileFor(ud, 'stoke-asset://wallpaper/abc123.png'), '/tmp/stoke-ud/wallpaper/abc123.png')
  check('the encoded form resolves the same', wallpaperFileFor(ud, 'stoke-asset://wallpaper/a%20b.jpg'), '/tmp/stoke-ud/wallpaper/a b.jpg')
  check('a traversal is refused', wallpaperFileFor(ud, 'stoke-asset://wallpaper/..%2F..%2Fsettings.json'), null)
  check('so is a nested path', wallpaperFileFor(ud, 'stoke-asset://wallpaper/x/y.png'), null)
  check('so is another host', wallpaperFileFor(ud, 'stoke-asset://settings/x.png'), null)
  check('so is a non-image', wallpaperFileFor(ud, 'stoke-asset://wallpaper/x.json'), null)
  check('so is another scheme', wallpaperFileFor(ud, 'file:///etc/passwd'), null)
  check('and garbage is not a throw', wallpaperFileFor(ud, 'not a url'), null)
}

console.log('\nthe remote port, which a number input will not clamp for you either')
check('a machine that has never said listens on 7878', hydrateSettings({}).remote.port, 7878)
check('a real port is kept', hydrateSettings({ remote: { port: 8080 } }).remote.port, 8080)
check('a privileged port falls back rather than failing to bind', hydrateSettings({ remote: { port: 80 } }).remote.port, 7878)
check('so does one past the top', hydrateSettings({ remote: { port: 70000 } }).remote.port, 7878)
check('and a fraction', hydrateSettings({ remote: { port: 8080.5 } }).remote.port, 7878)
check('a string typed into the box is read as its number', hydrateSettings({ remote: { port: '9000' as unknown as number } }).remote.port, 9000)

console.log('\nnotifications')
check('a machine that has never said gets background-only notifications', hydrateSettings({}).notifications, 'background')
check('off is kept', hydrateSettings({ notifications: 'off' }).notifications, 'off')
check('always is kept', hydrateSettings({ notifications: 'always' }).notifications, 'always')
check('a value outside the vocabulary falls back to the default rather than surviving', hydrateSettings({ notifications: 'loud' }).notifications, 'background')

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

console.log('\nthe theme pair, and which half the OS has selected')
const solo = { themeId: 'nocturne', themeIdLight: 'mist', followSystemTheme: false }
check('not following ignores the system entirely', activeThemeId(solo, false), 'nocturne')
check('even in dark', activeThemeId(solo, true), 'nocturne')
const pair = { ...solo, followSystemTheme: true }
check('following takes the dark slot in dark', activeThemeId(pair, true), 'nocturne')
check('and the light slot in light', activeThemeId(pair, false), 'mist')

console.log('\na card click lands in the slot matching its own appearance')
check('a dark theme is the dark pick', themeSlotFor('dark'), 'themeId')
check('a light theme is the light pick', themeSlotFor('light'), 'themeIdLight')

console.log('\nswitching following ON must not strand a light theme in the dark slot')
/*
 * The single theme in force may be a light one. Carrying it into the dark slot
 * unchanged means the switch appears to do nothing at night and then paints
 * white at dawn — which reads as the feature being broken rather than as the
 * pair being wrong.
 */
check(
  'a dark choice stays where it is',
  followPatch('nocturne', 'daylight', 'dark'),
  { themeId: 'nocturne', themeIdLight: 'daylight' }
)
check(
  'a light choice moves to the light slot, and dark falls back',
  followPatch('paper', 'daylight', 'light'),
  { themeId: DEFAULT_THEME_ID, themeIdLight: 'paper' }
)

console.log('\nthe two new keys hydrate, and junk in them does not reach resolveTheme')
check('defaults on an untouched machine', [hydrateSettings({}).themeIdLight, hydrateSettings({}).followSystemTheme], [DEFAULT_LIGHT_THEME_ID, false])
check('a stored pair survives', hydrateSettings({ themeIdLight: 'mist', followSystemTheme: true }).themeIdLight, 'mist')
check('a number is not an id', hydrateSettings({ themeIdLight: 42 }).themeIdLight, DEFAULT_LIGHT_THEME_ID)
check('nor is the empty string', hydrateSettings({ themeId: '   ' }).themeId, DEFAULT_THEME_ID)
check('and only a real true follows', hydrateSettings({ followSystemTheme: 'true' }).followSystemTheme, false)

console.log('\nthe phone-reach preference')
/*
 * The field that ends "the picker is stuck on Cloudflare Tunnel". Hydration
 * matters here more than usual: the raw `...r.remote` spread would carry a
 * hand-written value straight into connectTarget, where anything unrecognised
 * matches no branch and silently means loopback — a phone link that stops
 * working because of a typo in a file.
 */
check('every settings file written before this reads as auto', hydrateSettings({}).remote.reach, 'auto')
check('and one that never named it', hydrateSettings({ remote: { port: 7878 } }).remote.reach, 'auto')
check('a real choice survives', hydrateSettings({ remote: { reach: 'tunnel' } }).remote.reach, 'tunnel')
check('junk does not', hydrateSettings({ remote: { reach: 'banana' } }).remote.reach, 'auto')
check('nor does a number', hydrateSettings({ remote: { reach: 3 } }).remote.reach, 'auto')
check(
  'and it does not disturb the rest of the block',
  hydrateSettings({ remote: { reach: 'lan', port: 9000, hostname: 'x.example.com' } }).remote,
  { ...DEFAULT_SETTINGS.remote, reach: 'lan', port: 9000, hostname: 'x.example.com' }
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
