/*
 * The first-run campfire: the rule that decides whether it plays, the settings
 * field it remembers that in, and the NSIS welcome page that puts the same
 * campfire at the FRONT of the Windows installer instead of the end.
 *
 *   node scripts/verify-welcome.mts
 *
 * What this suite can and cannot see is worth stating up front, because the
 * split is the whole shape of this feature (gotcha 31). `welcomePlan` is pure
 * and is covered exhaustively here. The wire from it to a mounted component and
 * a settings write is a side effect inside a closure and is covered by nothing
 * here; it was driven over CDP against the built app instead — first run shows
 * it, dismiss, relaunch on the same profile, gone. And the NSIS half is covered
 * by nobody anywhere: no round of work in this repo has ever run on Windows, so
 * the assertions below check that the file says what app-builder-lib's own
 * templates need it to say, and nothing about what a wizard draws.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WELCOME_DISMISS_MS,
  WELCOME_SEEN_MAX,
  clampWelcomeSeen,
  welcomePlan
} from '../src/shared/welcome.ts'
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

let failures = 0

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
}

function check(name: string, got: unknown, want: unknown): void {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (!same) failures++
  console.log(
    `  ${same ? 'PASS' : 'FAIL'}  ${name}` +
      (same ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/** The two fields a caller acts on, so a fixture states an outcome not an object. */
function plan(seen: string | null | undefined, current: string): string {
  const p = welcomePlan(seen, current)
  return `${p.play ? 'play' : 'quiet'}:${p.reason}`
}

/* ------------------------------------------------------------------ *
 * The refusal first, because it is the assertion that protects
 * something rather than adds something. A splash that reappears on a
 * launch where nothing changed lands in front of the sessions Stoke
 * has just restored, every single time the app opens.
 * ------------------------------------------------------------------ */

console.log('\nthe same version never plays again')
check('an exact match is seen', plan('0.9.4', '0.9.4'), 'quiet:seen')
check('and so is one with a prerelease tag', plan('1.0.0-beta.2', '1.0.0-beta.2'), 'quiet:seen')
/* Semver says build metadata takes no part in precedence. A stored `0.9.4+ci`
   against a running `0.9.4` is the same build, and must not replay. */
check('build metadata is not a version change', plan('0.9.4+ci.7', '0.9.4'), 'quiet:seen')
check('nor is surrounding whitespace', plan('  0.9.4  ', '0.9.4'), 'quiet:seen')

console.log('\nthe two moments it does play')
check('nothing recorded is a fresh install', plan(null, '0.9.4'), 'play:install')
check('and so is undefined, which is what an older settings file has', plan(undefined, '0.9.4'), 'play:install')
check('a newer build is an upgrade', plan('0.9.3', '0.9.4'), 'play:upgrade')
check('an older build is a downgrade, and still plays', plan('0.9.5', '0.9.4'), 'play:downgrade')

console.log('\nthe version comparison is semver, not string order')
/* '0.10.0' < '0.9.4' lexicographically and the other way round numerically.
   A string compare here would call every 0.10.x launch a downgrade. */
check('0.9.4 -> 0.10.0 is an upgrade', plan('0.9.4', '0.10.0'), 'play:upgrade')
check('0.10.0 -> 0.9.4 is a downgrade', plan('0.10.0', '0.9.4'), 'play:downgrade')
check('2.0.0 beats 10 as a minor', plan('1.2.0', '1.10.0'), 'play:upgrade')
check('a prerelease ranks below its own release', plan('0.9.4-beta.1', '0.9.4'), 'play:upgrade')
check('and a release above it', plan('0.9.4', '0.9.4-beta.1'), 'play:downgrade')
/* beta.10 > beta.2 numerically and < it as a string — the repo has shipped
   `0.4.0-beta.3`, so this is a tag shape that has actually existed here. */
check('numeric prerelease identifiers compare as numbers', plan('0.9.4-beta.2', '0.9.4-beta.10'), 'play:upgrade')
check('an alphanumeric identifier outranks a numeric one', plan('0.9.4-beta.2', '0.9.4-beta.rc'), 'play:upgrade')
check('more identifiers outrank fewer', plan('0.9.4-beta', '0.9.4-beta.1'), 'play:upgrade')

console.log('\nwhat it refuses to do')
/*
 * An unreadable running version is the one case that must NOT play, and the
 * friendly-looking choice is the wrong one: with nothing to record, playing
 * means asking the same question and getting the same answer on every launch
 * for ever. `record: null` is what makes that visible to the caller.
 */
check('an unreadable current version plays nothing', plan('0.9.4', ''), 'quiet:unknown')
check('nor does it with nothing recorded either', plan(null, 'banana'), 'quiet:unknown')
check('a two-part version is not a version', plan(null, '0.9'), 'quiet:unknown')
check('and there is nothing to record when it cannot tell', welcomePlan(null, 'banana').record, null)
/* Junk on the stored side is recoverable — it reads as "never seen", plays
   once, and is overwritten with something valid. Junk on the running side is
   not, which is why the two sides are treated differently on purpose. */
check('junk in the settings file replays once', plan('banana', '0.9.4'), 'play:install')
check('so does a leading v, which npm prints and package.json never holds', plan('v0.9.4', '0.9.4'), 'play:install')
check('what gets recorded is the running version', welcomePlan(null, '0.9.4').record, '0.9.4')
check('trimmed', welcomePlan(null, ' 0.9.4 ').record, '0.9.4')
/*
 * A version that parses but is too long for the stored field is the loop this
 * file's own comments only closed from one side. It is reachable: build
 * metadata is legal semver and a CI-stamped `0.9.4+ci.<build id>` clears 64
 * characters without trying. Recorded raw it would be written, refused by
 * `hydrateSettings` on the next read, and therefore read as "never seen" — a
 * splash on every launch, for ever, in front of whatever was restored.
 */
const LONG = `0.9.4+ci.${'a'.repeat(WELCOME_SEEN_MAX)}`
check('a version too long to store plays nothing', plan(null, LONG), 'quiet:unknown')
check('and records nothing', welcomePlan(null, LONG).record, null)

console.log('\nthe stored field is repaired, not trusted')
check('a real version survives', clampWelcomeSeen('0.9.4'), '0.9.4')
check('with a prerelease tag', clampWelcomeSeen('1.0.0-beta.2'), '1.0.0-beta.2')
check('trimmed', clampWelcomeSeen('  0.9.4 '), '0.9.4')
check('the empty string is not a version', clampWelcomeSeen(''), null)
check('nor is whitespace', clampWelcomeSeen('   '), null)
check('nor a boolean', clampWelcomeSeen(true), null)
check('nor a number', clampWelcomeSeen(0.94), null)
check('nor an object', clampWelcomeSeen({ v: '0.9.4' }), null)
check('nor null', clampWelcomeSeen(null), null)
check('nor a tag with a v', clampWelcomeSeen('v0.9.4'), null)
check('nor two parts', clampWelcomeSeen('0.9'), null)
check('and nothing unbounded', clampWelcomeSeen(`0.9.${'4'.repeat(200)}`), null)

/*
 * The property that keeps the clamp and the comparator from drifting apart,
 * which is why they live in one file: anything the clamp keeps must be
 * something `welcomePlan` can compare, or a stored value would clear hydration
 * and then read as "never seen" on every launch.
 */
console.log('\nevery value the clamp keeps is one the plan can read')
for (const v of ['0.9.4', '1.0.0', '10.20.30', '0.4.0-beta.3', '1.0.0-rc.1', '2.0.0+build.9']) {
  const kept = clampWelcomeSeen(v)
  ok(`${v} survives the clamp and then compares equal to itself`, kept !== null && plan(kept, v) === 'quiet:seen')
}

/*
 * And the converse, which is the half that was missing and the half that loops.
 * The property above stops a STORED value the comparator cannot read; this one
 * stops a RECORDED value the clamp will not keep. Both directions have the same
 * consequence — the field reads as "never seen" on the next launch — and only
 * this one is reachable from a version string the app itself hands over.
 */
console.log('and every value the plan records is one the clamp keeps')
for (const v of ['0.9.4', ' 0.9.4 ', '10.20.30', '0.4.0-beta.3', '2.0.0+build.9', LONG, 'banana', '']) {
  const rec = welcomePlan(null, v).record
  ok(
    `${JSON.stringify(v)} records something hydration will not throw away`,
    rec === null || clampWelcomeSeen(rec) === rec,
    `recorded ${JSON.stringify(rec)}, which hydrates back to ${JSON.stringify(clampWelcomeSeen(rec))}`
  )
}

console.log('\nsettings hydration')
check('the default is null — nobody has seen anything', DEFAULT_SETTINGS.welcomeSeenVersion, null)
check('a settings file written before this key reads as null', hydrateSettings({}).welcomeSeenVersion, null)
check('a stored version survives', hydrateSettings({ welcomeSeenVersion: '0.9.4' }).welcomeSeenVersion, '0.9.4')
check('junk does not', hydrateSettings({ welcomeSeenVersion: true }).welcomeSeenVersion, null)
check('nor does a number', hydrateSettings({ welcomeSeenVersion: 42 }).welcomeSeenVersion, null)
check(
  'and hydrating it disturbs nothing else',
  hydrateSettings({ welcomeSeenVersion: '0.9.4', uiScale: 1.2 }).uiScale,
  1.2
)

console.log('\nhow long it stays up on its own')
/*
 * "A few seconds" is the whole requirement, and both ends of it matter: under
 * about a second and a half nobody reads the line, and past about six the
 * splash is in the way of the session that has already started behind it.
 */
ok(`${WELCOME_DISMISS_MS}ms is a few seconds`, WELCOME_DISMISS_MS >= 1500 && WELCOME_DISMISS_MS <= 6000)

/* ------------------------------------------------------------------ *
 * The component. Text assertions, because a .tsx cannot be imported
 * under node's strip-only mode (it does not transform JSX) — so these
 * check the rules a compiler cannot: no colour of its own, one shared
 * geometry, and a dynamic import.
 * ------------------------------------------------------------------ */

const CAMPFIRE = read('src', 'renderer', 'src', 'components', 'Campfire.tsx')
const APP = read('src', 'renderer', 'src', 'App.tsx')
const CSS = read('src', 'renderer', 'src', 'styles', 'app.css')

console.log('\nthe component holds no colour of its own')
/*
 * Every fill and stroke has to come from a class app.css resolves against the
 * theme's custom properties, or the fire is Ember's orange on all twelve
 * themes. `#campfire-flame` and friends are safe from this regex: after the
 * `#` they run out of hex characters at "ca".
 */
const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/
ok('Campfire.tsx contains no hex colour', !HEX.test(CAMPFIRE), HEX.exec(CAMPFIRE)?.[0] ?? '')
ok(
  'nor a literal colour function',
  !/\b(?:rgba?|hsla?|oklch|oklab|color-mix)\s*\(/.test(CAMPFIRE)
)
ok('and app.css drives its palette from --accent', /--campfire-mid:\s*var\(--accent\)/.test(CSS))

console.log('\none campfire, four SVGs and now a component')
/*
 * The flame the installer draws and the flame the app draws are the same mark,
 * because they are the same path data. A fifth hand-copy is exactly the drift
 * `verify:installer-art` already holds the other four against; this is that
 * assertion extended to the one copy that lives in TypeScript.
 */
const SIDEBAR = read('build', 'installerSidebar.svg')
function svgPath(id: string): string | null {
  const m = new RegExp(`<path id="${id}"[^>]*\\sd="([^"]*)"`).exec(SIDEBAR)
  return m ? m[1] : null
}
function tsxPath(name: string): string | null {
  const m = new RegExp(`const ${name}_D =\\s*\\n?\\s*'([^']*)'`).exec(CAMPFIRE)
  return m ? m[1] : null
}
for (const [konst, id] of [
  ['FLAME', 'flame'],
  ['CORE', 'core'],
  ['LOGS', 'logs']
] as const) {
  const fromSvg = svgPath(id)
  const fromTsx = tsxPath(konst)
  ok(`build/installerSidebar.svg still has a #${id} path to compare`, fromSvg !== null)
  ok(`Campfire.tsx's ${konst}_D is byte-identical to it`, fromTsx !== null && fromTsx === fromSvg)
}

console.log('\nzero boot cost: the splash is a chunk, not part of the bundle')
/*
 * `lazy(() => import(...))` keeps the component, its SVG and its copy out of
 * the one renderer chunk every launch parses. A static import would compile to
 * the same working feature and cost every launch that never shows it — the
 * renderer's version of gotcha 40.
 */
ok("App.tsx imports the campfire with import()", /import\(\s*'\.\/components\/Campfire'\s*\)/.test(APP))
ok(
  'and nowhere statically',
  !/^import\s[^\n]*from '\.\/components\/Campfire'/m.test(APP),
  'a static import puts it back in the main chunk'
)

/*
 * And that the chunk cannot take the window with it.
 *
 * `lazy` rethrows a rejected factory during render; main.tsx renders `<App/>`
 * straight into `createRoot` with no error boundary anywhere in the tree, so a
 * chunk that will not load unmounts everything. Measured against the built app
 * by hiding the chunk file and launching a fresh profile: without the `.catch`,
 * `document.querySelector('.app')` is null, `#root` has **0** children and the
 * screenshot is an empty window, with `welcomeSeenVersion` still null so the
 * next launch does it again; with it, the app is up, the splash is skipped and
 * the version is recorded. A text assertion is all this suite can do — the
 * counterfactual is in the commit message.
 */
ok(
  'and a chunk that fails to load cannot blank the app',
  /import\('\.\/components\/Campfire'\)[\s\S]{0,200}?\.catch\(/.test(APP),
  'lazy() rethrows in render and this tree has no error boundary'
)

console.log('\nreduced motion')
/*
 * The global `prefers-reduced-motion` block already forces every animation to
 * 1ms, which stops the fire. What it cannot do is the sparks: they rest at
 * opacity 0 and would be five invisible circles rather than none.
 */
const REDUCED = CSS.split('@media (prefers-reduced-motion: reduce)').slice(1)
ok('app.css names .campfire in a reduced-motion block', REDUCED.some((b) => b.includes('.campfire')))
ok('and takes the sparks out entirely', REDUCED.some((b) => /\.campfire-spark\s*\{[^}]*display:\s*none/.test(b)))
ok(
  'the card enters with modal-in, never pop',
  /\.campfire-card\s*\{[^}]*animation:\s*modal-in/.test(CSS),
  'pop carries translate: -50%, which is wrong for a margin:auto child (gotcha 47)'
)

/* ------------------------------------------------------------------ *
 * The NSIS welcome page. Read from app-builder-lib's own templates;
 * verified by nobody on a real Windows machine.
 * ------------------------------------------------------------------ */

console.log('\nthe NSIS welcome page')
const NSH = read('build', 'installer.nsh')
const YML = read('electron-builder.yml')

/*
 * Every assertion below reads NSH_CODE, never NSH.
 *
 * This file is four fifths prose, and the prose quotes the very directives the
 * suite is looking for — `!insertmacro MUI_PAGE_WELCOME`, MUI_BGCOLOR,
 * ManifestDPIAware are all named in comments explaining why they are or are not
 * there. A check run against the raw bytes therefore passes on the explanation
 * and says nothing at all about the code: deleting the real
 * `!insertmacro MUI_PAGE_WELCOME` from inside the macro, and then emptying the
 * macro altogether, both left this suite green (measured, both ways). That is
 * gotcha 50's defect in its worst possible place — the NSIS half is the one
 * part of this feature no human here can verify, so this suite is its only
 * guard, and it was guarding a sentence.
 */
const NSH_CODE = NSH.split('\n')
  .filter((l) => !/^\s*[;#]/.test(l))
  .join('\n')

/*
 * `assistedInstaller.nsh` inserts the page only `!ifmacrodef customWelcomePage`
 * and only `!ifndef BUILD_UNINSTALLER`, so the macro has to carry exactly that
 * name. A typo here is a file that compiles, installs, and has no welcome page.
 */
ok('build/installer.nsh defines customWelcomePage', /^!macro\s+customWelcomePage\s*$/m.test(NSH_CODE))
ok('and closes it', /^!macroend\s*$/m.test(NSH_CODE))

/*
 * The page itself, asserted on the macro's BODY rather than anywhere in the
 * file. An `!insertmacro MUI_PAGE_WELCOME` at top level would not be inserted
 * by the assisted template at all — it would land before MUI2.nsh is included
 * and be a different bug with the same spelling.
 */
const BODY = /^!macro\s+customWelcomePage\s*$([\s\S]*?)^!macroend\s*$/m.exec(NSH_CODE)?.[1] ?? ''
ok('the macro body is not empty', BODY.trim().length > 0, 'an empty customWelcomePage draws no page')
ok('and it is the body that inserts MUI_PAGE_WELCOME', /!insertmacro\s+MUI_PAGE_WELCOME/.test(BODY))

/*
 * makensis reads this file as bytes. Anything outside ASCII depends on the
 * compiler's code page, and a BOM is its own trap (gotcha 8) — one written by
 * an editor on Windows would arrive as a stray character before `!macro`.
 * Checked on the whole file, comments included, because that is what makensis
 * reads.
 */
ok('it is plain ASCII', !/[^\t\n\r\x20-\x7e]/.test(NSH))
ok('with no BOM', !NSH.startsWith('﻿'))

/*
 * Two things it must NOT do. A `!define` at top level lands before MUI2.nsh
 * and is a real seam — but MUI_BGCOLOR/MUI_TEXTCOLOR is the one change that can
 * make the wizard's own title text unreadable, and installerHeader.bmp is drawn
 * LIGHT for MUI's default white bar (verify:installer-art pins that too, from
 * the other side). ManifestDPIAware breaks the component page's tree bitmap by
 * NSIS's own reference.
 */
ok('it sets no MUI colour overrides the header art is not drawn for', !/MUI_(?:BGCOLOR|TEXTCOLOR)/.test(NSH_CODE))
ok('and does not touch ManifestDPIAware', !/ManifestDPIAware/.test(NSH_CODE))

/*
 * The yml half. `include` is named rather than left to its default for the same
 * reason gotcha 69 gives for the three image keys: with the key SET,
 * getResource throws InvalidConfigurationError on a missing file and the build
 * stops; with it UNSET the welcome page disappears in silence.
 */
function ymlBlock(name: string): string | null {
  const lines = YML.split('\n')
  const start = lines.findIndex((l) => l === `${name}:`)
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end++
  return lines.slice(start + 1, end).join('\n')
}
const NSIS_BLOCK = ymlBlock('nsis')
ok('electron-builder.yml still has an nsis: block to check', NSIS_BLOCK !== null)
ok(
  'it names build/installer.nsh through the include key',
  /^\s+include:\s*build\/installer\.nsh\s*$/m.test(NSIS_BLOCK ?? '')
)
/*
 * Repeated here as well as in verify:installer-art, deliberately. This is the
 * suite that introduced a .nsh file, and `script:` is the one-character-away
 * key that would silently stop electron-builder generating and signing the
 * uninstaller.
 */
ok('and still no nsis.script', !/^\s+script:/m.test(NSIS_BLOCK ?? ''))

/*
 * And that a rule file actually reaches installer.nsh.
 *
 * CLAUDE.md's own procedure: "an entry no path reaches is never loaded". This
 * one matters more than most, because `build/installer.nsh` is compiled into an
 * elevated Windows installer that nobody in this repo can run — the reasoning
 * for what it must not contain (MUI colour overrides, ManifestDPIAware,
 * `nsis.script`) is all in release.md, and a `paths:` list that does not name
 * the file means the next person to open it is handed none of it. It was
 * reachable by nothing when this stream landed: the only `build/` glob anywhere
 * was `build/*.svg`.
 */
console.log('\nthe rules a reader of installer.nsh gets handed')
const RULE_GLOBS = readdirSync(join(ROOT, '.claude', 'rules'))
  .filter((f) => f.endsWith('.md'))
  .flatMap((f) => [...read('.claude', 'rules', f).matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]))
const reaches = (path: string): boolean =>
  RULE_GLOBS.some((g) =>
    new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(path)
  )
ok('some rule file names build/installer.nsh in its paths', reaches('build/installer.nsh'))
ok('and one names src/shared/welcome.ts', reaches('src/shared/welcome.ts'))
ok('and one names the Campfire component', reaches('src/renderer/src/components/Campfire.tsx'))

console.log('\nthe suite is in the chain CI derives its list from')
const PKG = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
ok('package.json declares verify:welcome', typeof PKG.scripts['verify:welcome'] === 'string')
ok('and the check chain runs it', PKG.scripts.check.includes('verify:welcome'))

/*
 * Said out loud rather than asserted, because the honest answer is that nothing
 * here can check it (gotcha 31 for the first, and a missing operating system
 * for the second).
 */
console.log('\nnot covered by this suite')
console.log('  - that the component mounts, dismisses and writes the flag: driven over CDP')
console.log('  - that NSIS compiles installer.nsh and draws the page: no Windows machine here')

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
