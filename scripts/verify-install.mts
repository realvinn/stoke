/*
 * The one-line installer: the endpoint's routing rule, and the two scripts it
 * serves.
 *
 *   node scripts/verify-install.mts
 *
 * Everything this covers is outside every tsconfig and outside every other
 * suite — `install/`, `worker/` and the Worker's own decision (gotcha 27:
 * `scripts/` is in neither project either, so none of it is typechecked). It is
 * also the highest-blast-radius artifact the project ships: whatever
 * stoke.vinn.dev answers with runs as the user on every machine that runs the
 * one-liner.
 *
 * Three of the things asserted here fail in ways that are invisible from this
 * machine, which is why each is pinned rather than reasoned about:
 *
 *  - PowerShell's User-Agent starts with `Mozilla/5.0`, so a browser test that
 *    runs before the PowerShell test hands `irm | iex` an HTML page.
 *  - The sha512 in a release manifest is BASE64 of the raw digest. Every
 *    reflex — `shasum -a 512`, `Get-FileHash` — produces hex, and a hex
 *    comparison fails 100% of the time in a way that reads like a corrupt
 *    download.
 *  - The whole body of each script is inside a function called on the LAST
 *    line, because `sh` executes a piped script as it reads it and a connection
 *    dropped at 60% would otherwise run the first 60%.
 *
 * And the part that exists because a hand-written decoder has already shipped a
 * visible `||` at a user once (gotcha 70): install.sh's own painter is RUN, for
 * every frame in every tier, and diffed against `paint()` in
 * src/shared/campfire.ts. The script prints them with `--fire-frames`, which is
 * the shipped code path the download loop uses, not a copy of it.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEARTH, STAGES, paint, type ColorMode } from '../src/shared/campfire.ts'
import { CACHE_CONTROL, contentTypeFor, routeFor, type InstallerBody } from '../worker/route.ts'
import { shArtBlock, ps1ArtBlock, extractBlock } from './gen-installer-art.mts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SH = join(root, 'install', 'install.sh')
const PS1 = join(root, 'install', 'install.ps1')
const HTML = join(root, 'install', 'index.html')

let failures = 0

function ok(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass || !detail ? '' : `\n        ${detail}`))
}

function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const shText = readFileSync(SH, 'utf8')
const ps1Text = readFileSync(PS1, 'utf8')
const htmlText = readFileSync(HTML, 'utf8')

/*
 * The executable half of a script, with whole-line `#` comments dropped.
 *
 * Every "this script never does X" assertion below has to run against this
 * rather than against the file, because the scripts EXPLAIN at length why they
 * do not do those things — `spctl`, `/allusers`, `Get-FileHash` and
 * `Invoke-WebRequest` are each named in a comment saying not to use it. Grepping
 * the raw text makes the explanation itself the failure, which would teach the
 * next person to delete the explanation.
 *
 * `#` starts a comment in both a POSIX shell and PowerShell, and no line of the
 * generated art begins with one (the art's `#` glyphs are always preceded by a
 * `(` or a segment key), so one rule serves both files.
 */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
const shCode = code(shText)
const ps1Code = code(ps1Text)

// ---------------------------------------------------------------------------
console.log('\nwho gets which body')
// ---------------------------------------------------------------------------

const CURL = 'curl/8.7.1'
const WGET = 'Wget/1.21.4 (darwin23.0.0)'
const PWSH7 = 'Mozilla/5.0 (Microsoft Windows NT 10.0.22631.0; Microsoft Windows 10.0.22631; en-AU) PowerShell/7.5.0'
const PS51 = 'Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1.22621.4391'
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI_OLD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15'

const BASE = 'https://stoke.vinn.dev/'
const route = (url: string, headers: Record<string, string | undefined>) => {
  const r = routeFor(url, headers)
  return [r.body, r.why]
}

/*
 * The trap this whole ordering exists for. PowerShell builds its User-Agent as
 * `Mozilla/5.0 (…) PowerShell/7.5.0`, so the intuitive "contains Mozilla,
 * therefore a browser" rule serves HTML to `irm | iex`, and PowerShell's parse
 * error on HTML reads like a broken installer rather than a routing bug. Both
 * spellings are asserted, because 5.1 — the one that ships in Windows, and so
 * the one a bare one-liner usually runs — says WindowsPowerShell.
 */
check('PowerShell 7 gets the ps1, despite its Mozilla/5.0 prefix', route(BASE, { 'user-agent': PWSH7 }), [
  'ps1',
  'powershell user-agent'
])
check('Windows PowerShell 5.1 gets it too, on the same substring test', route(BASE, { 'user-agent': PS51 }), [
  'ps1',
  'powershell user-agent'
])
check('curl gets the sh script', route(BASE, { 'user-agent': CURL, accept: '*/*' }), [
  'sh',
  'cli downloader user-agent'
])
check('so does wget', route(BASE, { 'user-agent': WGET, accept: '*/*' }), ['sh', 'cli downloader user-agent'])
check(
  'a browser navigation gets the page, on Fetch Metadata',
  route(BASE, { 'user-agent': CHROME, accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' }),
  ['html', 'browser navigation']
)
check(
  'an old Safari with no Sec-Fetch-* gets it on Accept instead',
  route(BASE, { 'user-agent': SAFARI_OLD, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
  ['html', 'browser navigation']
)
/*
 * The fallback direction, which is the one with a security argument behind it.
 * Whatever fetched this and could not be identified is far more likely to be a
 * crawler or a link-preview bot — Slack, Discord and iMessage all fetch a URL
 * the moment somebody pastes it — than a shell. HTML is harmless to all of
 * them; a script is not.
 */
check('an unidentified client gets the page, never a script', route(BASE, { 'user-agent': 'Mystery/1.0' }), [
  'html',
  'fallback'
])
check('and so does a request with no headers at all', route(BASE, {}), ['html', 'fallback'])
check('a Slack link preview gets the page', route(BASE, { 'user-agent': 'Slackbot-LinkExpanding 1.0' }), [
  'html',
  'fallback'
])

console.log('\n  the overrides, which are the escape hatch for every miss above')
check('?sh beats a browser User-Agent', route(BASE + '?sh', { 'user-agent': CHROME, accept: 'text/html' }), [
  'sh',
  'query override'
])
check('?ps1 beats curl', route(BASE + '?ps1', { 'user-agent': CURL }), ['ps1', 'query override'])
check('?html beats PowerShell', route(BASE + '?html', { 'user-agent': PWSH7 }), ['html', 'query override'])
check('a bare key with no value is the documented form and works', route(BASE + '?sh', {}), ['sh', 'query override'])
check('and so does ?sh=1', route(BASE + '?sh=1', {}), ['sh', 'query override'])
check('an unrelated query is not an override', route(BASE + '?utm_source=x', { 'user-agent': CURL }), [
  'sh',
  'cli downloader user-agent'
])
check('/install.sh is readable from a browser', route(BASE + 'install.sh', { 'user-agent': CHROME, accept: 'text/html' }), [
  'sh',
  'explicit path'
])
check('/install.ps1 likewise', route(BASE + 'install.ps1', { 'user-agent': CHROME, accept: 'text/html' }), [
  'ps1',
  'explicit path'
])
check('an unknown path is negotiated rather than 404d', route(BASE + 'favicon.ico', {}), ['html', 'fallback'])

console.log('\n  what is sent with them')
check('a script is text/plain, never JSON or XML', contentTypeFor('sh'), 'text/plain; charset=utf-8')
check('the ps1 too, or Invoke-RestMethod deserializes it into an object', contentTypeFor('ps1'), 'text/plain; charset=utf-8')
check('the page is html', contentTypeFor('html'), 'text/html; charset=utf-8')
/*
 * Five minutes at most. This is the one artifact that has to be able to change
 * the day a release breaks, and a long TTL means a bad script stays live with
 * no way to pull it.
 */
const maxAge = Number(/max-age=(\d+)/.exec(CACHE_CONTROL)?.[1] ?? -1)
ok(`the cache TTL is ${maxAge}s, which is at most five minutes`, maxAge > 0 && maxAge <= 300, CACHE_CONTROL)
/*
 * `Vary: User-Agent` is the obvious thing to reach for and would destroy the
 * hit rate outright: the variant space is every PowerShell version times every
 * Windows build times every locale.
 */
ok('nothing varies the cache on User-Agent', !/vary/i.test(CACHE_CONTROL))
const workerText = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
// The comments in that file discuss the things it must not do, by name, so they
// have to come out before asking whether it does them — same reason as `code()`.
const workerCode = workerText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
ok('the Worker sets no Vary header either', !/['"]vary['"]/i.test(workerCode))
/*
 * Nothing is fetched at request time. Fetching the scripts from
 * raw.githubusercontent instead would put a second network hop inside every
 * request, make GitHub a hard dependency of the install endpoint, and let a
 * force-push to `main` change what every one-liner executes with no deploy and
 * no audit trail. The only `fetch` in the file is the handler's own name.
 */
ok('and it fetches nothing at request time', !/\bfetch\s*\(/.test(workerCode.replace(/\bfetch\(request: Request\)/g, '')))
ok('it serves only the three embedded bodies', /BODIES\[route\.body\]/.test(workerCode))

// ---------------------------------------------------------------------------
console.log('\nthe truncation guard')
// ---------------------------------------------------------------------------
/*
 * `sh` reads its stdin incrementally and executes as it reads, so a piped
 * script whose connection drops at 60% executes the first 60% — half an
 * installer is worse than none. Everything inside a function invoked on the
 * last line makes that impossible: a truncated body either fails to parse or
 * simply never reaches the call.
 *
 * Asserted as the LAST line rather than as "contains", because a call in the
 * middle with more statements after it is exactly the regression this prevents.
 */
const lastLine = (text: string): string => {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines[lines.length - 1]
}
check('install.sh ends by calling main, and nothing follows it', lastLine(shText), 'main "$@"')
check('install.ps1 ends by calling Install-Stoke', lastLine(ps1Text), 'Install-Stoke')
ok('install.sh defines main as a function', /^main\(\)\s*\{/m.test(shText))
ok('install.ps1 defines Install-Stoke as a function', /^function Install-Stoke\s*\{/m.test(ps1Text))
ok('install.sh sets -eu', /^set -eu$/m.test(shText))
ok("install.ps1 sets ErrorActionPreference to 'Stop'", /^\$ErrorActionPreference = 'Stop'$/m.test(ps1Text))
ok('and Set-StrictMode', /^Set-StrictMode -Version Latest$/m.test(ps1Text))

console.log('\n  and the bytes the endpoint will serve')
/*
 * A UTF-8 BOM survives into the string `iex` parses and is an "unexpected
 * token" on line 1 — with a one-liner, on somebody else's machine, with no way
 * to see it. CRLF is the same class: .gitattributes normalises the repo to LF,
 * and the Worker serves these bytes verbatim.
 */
for (const [name, text] of [
  ['install.sh', shText],
  ['install.ps1', ps1Text],
  ['index.html', htmlText]
] as const) {
  ok(`${name} has no UTF-8 BOM`, !text.startsWith('\uFEFF'))
  ok(`${name} has no CRLF line endings`, !text.includes('\r'))
}

// ---------------------------------------------------------------------------
console.log('\nthe scripts parse, in every shell that might run them')
// ---------------------------------------------------------------------------
/*
 * bash 3.2.57 is what `#!/bin/sh` gets on every Mac and is the strictest of the
 * four about the constructs the art needs (gotcha 70). dash is what /bin/sh is
 * on Debian and Ubuntu. zsh is what somebody will paste it into.
 */
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh']
if (process.platform === 'win32') {
  console.log('  SKIP  no POSIX shell here — this is the half of the contract a Windows runner cannot check.')
} else {
  for (const shell of SHELLS) {
    if (!existsSync(shell)) {
      console.log(`  SKIP  ${shell} is not installed on this machine.`)
      continue
    }
    let err = ''
    try {
      execFileSync(shell, ['-n', SH], { stdio: 'pipe' })
    } catch (e) {
      err = String((e as { stderr?: Buffer }).stderr ?? e)
    }
    ok(`${shell} -n install.sh`, err === '', err)
  }
}
/*
 * PowerShell cannot be parsed from here at all — there is no pwsh and no
 * powershell on this machine — so the ps1 half of that claim is unverified
 * rather than merely untested. Said out loud rather than left as a gap in the
 * output.
 */
console.log('  NOTE  install.ps1 has never been parsed by any PowerShell: there is none on this machine.')

// ---------------------------------------------------------------------------
console.log('\nthe campfire art is generated, not typed')
// ---------------------------------------------------------------------------
/*
 * The same comparison verify:campfire makes, repeated here because this suite
 * is the one that fails when somebody edits an installer — a block nobody may
 * hand-edit, plus decode(encode(x)) === x, is the only defence against the
 * malformed row that shipped a literal `||` once.
 */
check('install.sh carries the generator sh block byte for byte', extractBlock(shText), shArtBlock())
check('install.ps1 carries the generator ps1 block byte for byte', extractBlock(ps1Text), ps1ArtBlock())
/*
 * The alternate screen buffer would make this animation trivial and is exactly
 * wrong: leaving it restores the previous buffer, so everything the installer
 * printed — where the app went, what to add to PATH — is gone the instant it
 * exits, and so is the scrollback of anyone reading back what a `curl | sh`
 * just did.
 */
for (const [name, text] of [
  ['install.sh', shText],
  ['install.ps1', ps1Text]
] as const) {
  ok(`${name} never touches the alternate screen buffer`, !text.includes('1049'))
  ok(`${name} restores the cursor`, text.includes('?25h'))
}

/*
 * The one number in the fire that is hand-written. The art block states the
 * index formula in its preamble and carries no variable for the stride, so a
 * stage that grew a fourth flicker frame would leave both scripts addressing
 * the wrong frame — and a wrong stride is not a crash, it is a fire that
 * flickers between two stages and looks almost right.
 */
const stride = Number(/^FIRE_STRIDE=(\d+)$/m.exec(shText)?.[1] ?? -1)
const ps1Stride = Number(/^\$FireStride = (\d+)$/m.exec(ps1Text)?.[1] ?? -2)
const realStride = [...new Set(STAGES.map((s) => s.frames.length))]
check("install.sh's frame stride is campfire.ts's own flicker-frame count", [stride], realStride)
check('install.ps1 agrees with it', ps1Stride, stride)
check('and stages x stride addresses every frame exactly once', STAGES.length * stride, STAGES.length * STAGES[0].frames.length)

// ---------------------------------------------------------------------------
console.log('\nthe shell paints what campfire.ts says it should')
// ---------------------------------------------------------------------------
/*
 * `--fire-frames` runs the SHIPPED painter — the same `fire_paint_row` the
 * download loop calls, not a copy — over all twelve frames, and the output is
 * diffed against `paint()` in src/shared/campfire.ts byte for byte.
 *
 * This is the assertion that would have caught the malformed row that once
 * shipped a visible `||`: the art block being generated protects the DATA, and
 * this protects the decoder that reads it. Segment merging, the skip of a
 * sequence equal to the one in effect, the reset at the end of a painted row
 * and the seven-row canvas are all inside that comparison.
 */
const paintedFrames = (mode: ColorMode): string =>
  STAGES.flatMap((stage) => stage.frames.map((rows) => paint([...rows, ...HEARTH], mode)))
    .map((f) => f + '\n')
    .join('')

if (process.platform === 'win32' || !existsSync('/bin/sh')) {
  console.log('  SKIP  needs a POSIX shell to run the script with.')
} else {
  for (const mode of ['truecolor', 'ansi256', 'ansi16', 'none'] as ColorMode[]) {
    const got = execFileSync('/bin/sh', [SH, '--fire-frames', mode], { encoding: 'utf8' })
    const want = paintedFrames(mode)
    let where = ''
    if (got !== want) {
      const g = got.split('\n')
      const w = want.split('\n')
      for (let i = 0; i < Math.max(g.length, w.length); i++) {
        if (g[i] !== w[i]) {
          where = `line ${i}: got ${JSON.stringify(g[i])}, want ${JSON.stringify(w[i])}`
          break
        }
      }
    }
    ok(`install.sh paints the twelve frames exactly as paint(…, '${mode}') does`, got === want, where)
  }
  /*
   * Said separately because it is the claim the degraded path exists to make,
   * and because asserting it on the output of the real script is different from
   * asserting it on the module: a pipe, CI and TERM=dumb get a transcript that
   * a CI log viewer and a support paste can both show.
   */
  const mono = execFileSync('/bin/sh', [SH, '--fire-frames', 'none'], { encoding: 'utf8' })
  ok('and the monochrome tier contains no escape byte at all', !mono.includes('\u001b'))
  check('every frame is exactly the seven rows of the fixed canvas', mono.trimEnd().split('\n').length, 12 * 7)

  // ---------------------------------------------------------------------------
  console.log('\nwhen the fire burns, and in what')
  // ---------------------------------------------------------------------------
  /*
   * install.sh's `fire_plan` is a transcription of `degradedReason` +
   * `colorMode`, so it is RUN against the module rather than read. `--print-plan
   * tty|pipe` takes the terminal-ness as an argument for exactly the reason
   * campfire.ts takes `Terminal.isTty` as one: a suite with no terminal can
   * still ask what the script does on one.
   *
   * The environment is cleared to a named set each time, because inheriting
   * this shell's TERM or CI would make half these cases agree by accident.
   */
  const plan = (env: Record<string, string>, tty: 'tty' | 'pipe') => {
    const out = execFileSync('/bin/sh', [SH, '--print-plan', tty], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }
    })
    const read = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1] ?? '<missing>'
    return [read('animate'), read('color')]
  }

  check('a 256-colour terminal animates in ansi256', plan({ TERM: 'xterm-256color' }, 'tty'), ['1', 'ansi256'])
  check(
    'COLORTERM=truecolor upgrades it',
    plan({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, 'tty'),
    ['1', 'truecolor']
  )
  check('so does Windows Terminal, whatever TERM says', plan({ TERM: 'xterm', WT_SESSION: 'abc' }, 'tty'), [
    '1',
    'truecolor'
  ])
  check('a plain xterm gets the 16-colour tier', plan({ TERM: 'xterm' }, 'tty'), ['1', 'ansi16'])
  /*
   * NO_COLOR governs COLOUR, not motion. no-color.org says the variable, when
   * present and not empty, "prevents the addition of ANSI color" and says
   * nothing whatever about animation — and the art is a silhouette that reads
   * perfectly at one colour. Removing the animation for it is the part of that
   * spec everyone gets wrong.
   */
  check('NO_COLOR keeps the fire and takes the colour', plan({ TERM: 'xterm-256color', NO_COLOR: '1' }, 'tty'), [
    '1',
    'none'
  ])
  /*
   * The other half, and the one that was easy to leave untested: a degraded
   * terminal gets no colour TIER either, not merely no animation. These four
   * carry TERM, COLORTERM and WT_SESSION set to everything that would otherwise
   * win, so a rule that looked at them before the degraded reason would show up
   * as `truecolor` here rather than as `none`.
   */
  const rich = { TERM: 'xterm-256color', COLORTERM: 'truecolor', WT_SESSION: 'abc' }
  check('a pipe gets neither motion nor colour', plan(rich, 'pipe'), ['0', 'none'])
  check('nor does TERM=dumb', plan({ ...rich, TERM: 'dumb' }, 'tty'), ['0', 'none'])
  check('nor CI', plan({ ...rich, CI: '1' }, 'tty'), ['0', 'none'])
  check('nor GITHUB_ACTIONS', plan({ ...rich, GITHUB_ACTIONS: 'true' }, 'tty'), ['0', 'none'])
  check('nor STOKE_NO_ANIMATION', plan({ ...rich, STOKE_NO_ANIMATION: '1' }, 'tty'), ['0', 'none'])
  check('an unset TERM is a terminal that has told us nothing', plan({ COLORTERM: 'truecolor' }, 'tty'), ['0', 'none'])
  /*
   * A canvas taller than the window smears rather than animating. LINES and
   * COLUMNS are what the script asks first, so they are also how this is
   * testable without a terminal.
   */
  check('a window under 12 rows is too short to draw in', plan({ ...rich, LINES: '8', COLUMNS: '80' }, 'tty'), [
    '0',
    'none'
  ])
  check('and under 20 columns too narrow', plan({ ...rich, LINES: '40', COLUMNS: '15' }, 'tty'), ['0', 'none'])
  check('a big enough window is fine', plan({ ...rich, LINES: '40', COLUMNS: '120' }, 'tty'), ['1', 'truecolor'])
}

// ---------------------------------------------------------------------------
console.log('\nthe digest is base64, which is the thing everyone gets wrong')
// ---------------------------------------------------------------------------
/*
 * electron-builder writes the sha512 into latest*.yml as BASE64 of the raw
 * 64-byte digest. `shasum -a 512`, `sha512sum` and `Get-FileHash` all emit hex;
 * a hex comparison fails every single time, and it fails looking exactly like a
 * corrupted download, which is the kind of check that gets "fixed" by being
 * deleted.
 *
 * Run against the shipped `--sha512`, on random bytes, rather than asserted by
 * grep — the pipeline is what has to be right, not the comment above it.
 */
const tmp = mkdtempSync(join(tmpdir(), 'stoke-install-verify-'))
try {
  const blob = join(tmp, 'blob.bin')
  const bytes = randomBytes(200_000)
  writeFileSync(blob, bytes)
  const want = createHash('sha512').update(bytes).digest('base64')
  const wantHex = createHash('sha512').update(bytes).digest('hex')
  ok('the two forms really are different, so this test can fail', want !== wantHex)
  if (process.platform !== 'win32' && existsSync('/bin/sh')) {
    const got = execFileSync('/bin/sh', [SH, '--sha512', blob], { encoding: 'utf8' }).trim()
    check("install.sh's digest is base64 of the raw digest", got, want)
    ok('and it is 88 characters, not 128 hex ones', got.length === 88, `${got.length} characters`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
ok('install.ps1 uses ToBase64String over the raw hash', /ToBase64String\(\s*\$sha\.ComputeHash/.test(ps1Text))
ok('and never Get-FileHash, which is hex', !/Get-FileHash/.test(ps1Code))
ok('install.sh never compares a bare hex digest', !/shasum -a 512 [^|]*\)"?\s*[!=]=/.test(shCode))

// ---------------------------------------------------------------------------
console.log('\nwhat the scripts refuse to do')
// ---------------------------------------------------------------------------
/*
 * `spctl --assess` returns rejected — exit 3 — for every Stoke build that will
 * ever ship, because they are signed but not notarized. Any verification step
 * that gates on it refuses all valid installs. `codesign --verify --strict
 * --deep` is the honest check and exits 0 on a real release build.
 */
ok('install.sh never gates on spctl, which rejects every build this project ships', !/spctl/.test(shCode))
ok('it does run codesign --verify --strict --deep', /codesign --verify --strict --deep/.test(shCode))
/*
 * Never kill Stoke. Its PTYs die with it and the `claude` processes underneath
 * do not, and the restarted app cannot reattach to the orphans — so the script
 * asks it to quit and waits, and so does the Windows one, precisely so NSIS's
 * own /S behaviour (which force-stops everything under $INSTDIR) has nothing
 * left to do.
 */
ok('it asks a running Stoke to quit rather than killing it', /osascript -e 'quit app "Stoke"'/.test(shCode))
ok('and never sends it a signal', !/\bkill -9\b|\bpkill\b|\bkillall\b/.test(shCode))
ok('install.ps1 closes the window rather than stopping the process', /CloseMainWindow/.test(ps1Code))
ok('and never Stop-Process', !/Stop-Process/.test(ps1Code))
/*
 * /allusers under /S sends the installer down the elevation path — a UAC prompt
 * out of a one-liner — and /D= on an upgrade can only move an install the user
 * put somewhere deliberately, since the installer already reuses the recorded
 * InstallLocation.
 */
ok("install.ps1 runs the installer with /S and nothing else", /-ArgumentList '\/S'/.test(ps1Code))
ok('it never passes /allusers', !/allusers/i.test(ps1Code))
ok('nor /D=', !/\/D=/.test(ps1Code))
/*
 * Windows PowerShell 5.1's Invoke-WebRequest can raise a prompt a piped
 * one-liner cannot answer, and gives no byte-level progress for the fire to
 * burn against.
 */
ok('the download goes through HttpClient, not Invoke-WebRequest', /HttpCompletionOption\]::ResponseHeadersRead/.test(ps1Code))
ok('and Invoke-WebRequest appears nowhere', !/Invoke-WebRequest/.test(ps1Code))
ok('TLS 1.2 is set before the first request', /SecurityProtocolType\]::Tls12/.test(ps1Code))
/*
 * Content negotiation cannot separate curl.exe on Windows from curl on Linux —
 * every Windows 10 1803+ ships curl and plenty of people type it — so each
 * script has to recognise the other's platform itself.
 */
ok('install.sh recognises a Windows shell and names the PowerShell line', /MINGW\* \| MSYS\* \| CYGWIN\*/.test(shCode))
ok('install.ps1 recognises a non-Windows PowerShell', /\$onWindows/.test(ps1Code))
/*
 * Nothing may be installed from anywhere but the project's own releases.
 */
const shUrls = [...shCode.matchAll(/https?:\/\/[^\s'"]+/g)].map((m) => m[0])
const ps1Urls = [...ps1Code.matchAll(/https?:\/\/[^\s'"]+/g)].map((m) => m[0])
const allowed = (u: string) => u.startsWith('https://github.com/realvinn/stoke') || u.startsWith('https://stoke.vinn.dev')
check('install.sh downloads from nowhere but the project releases', shUrls.filter((u) => !allowed(u)), [])
check('install.ps1 likewise', ps1Urls.filter((u) => !allowed(u)), [])
/*
 * Never suggest skipping a certificate check, anywhere, in any troubleshooting
 * text. Somebody will paste it — and this is the one artifact where pasting a
 * suggestion means executing whatever answers.
 */
ok(
  'nothing offers to skip certificate checks',
  !/(--insecure|--no-check-certificate|SkipCertificateCheck)/.test(shText + ps1Text + htmlText)
)

// ---------------------------------------------------------------------------
console.log('\nthe constants that come from somewhere else')
// ---------------------------------------------------------------------------
/*
 * The registry key the NSIS installer records itself under is
 * UUIDv5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3) — NsisTarget.js:28,157.
 * Hardcoding it into a script creates a silent dependency: change `appId` and
 * upgrade detection stops working while fresh installs keep succeeding, so
 * nobody notices. Recomputed here from electron-builder.yml so that is a red
 * check instead.
 */
function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const appId = /^appId:\s*(\S+)$/m.exec(builderYml)?.[1] ?? ''
const wantGuid = uuidV5(appId, '50e065bc-3134-11e6-9bab-38c9862bdaf3')
const gotGuid = /^\$AppGuid = '([0-9a-f-]+)'$/m.exec(ps1Text)?.[1] ?? ''
check(`install.ps1's upgrade-detection GUID is the one electron-builder derives from ${appId}`, gotGuid, wantGuid)

/*
 * The endpoint's own address, written in four files that a user reads in four
 * different places. A one-liner on the landing page that does not match the one
 * the script prints when it lands on the wrong platform is a support thread
 * nobody can reproduce.
 */
const SH_LINE = 'curl -fsSL https://stoke.vinn.dev | sh'
const PS1_LINE = 'irm https://stoke.vinn.dev | iex'
ok('the landing page shows the sh one-liner', htmlText.includes(SH_LINE))
ok('and the ps1 one', htmlText.includes(PS1_LINE))
ok('install.sh sends a Windows user to exactly that ps1 line', shText.includes(`STOKE_PS1_LINE='${PS1_LINE}'`))
ok('install.ps1 sends a macOS user to exactly that sh line', ps1Text.includes(`$StokeShLine = '${SH_LINE}'`))
const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
ok('the Worker is bound to stoke.vinn.dev as a custom domain', /"pattern":\s*"stoke\.vinn\.dev",\s*"custom_domain":\s*true/.test(wrangler))
ok('and the landing page links to the readable script URLs', htmlText.includes('/install.sh') && htmlText.includes('/install.ps1'))

/*
 * The three bodies the Worker embeds have to be the three files in install/,
 * or `curl https://stoke.vinn.dev/install.sh | less` stops being an audit of
 * what the one-liner runs.
 */
for (const [body, file] of [
  ['sh', '../install/install.sh'],
  ['ps1', '../install/install.ps1'],
  ['html', '../install/index.html']
] as [InstallerBody, string][]) {
  ok(`the Worker embeds ${file} for the ${body} body`, workerText.includes(`'${file}'`))
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
