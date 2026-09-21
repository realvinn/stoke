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
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS, HEARTH, STAGES, paint, type ColorMode } from '../src/shared/campfire.ts'
import {
  CACHE_CONTROL,
  contentTypeFor,
  httpsRedirect,
  redirectBody,
  routeFor,
  type InstallerBody
} from '../worker/route.ts'
import { parseStokeArgs, stokeHelp } from '../src/shared/stokeArgs.ts'
import { LINUX_WRAPPER_MARK } from '../src/shared/stokeCommand.ts'
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

console.log('\n  plain HTTP gets a redirect, never a script')
/*
 * Measured before this existed: `curl -D - http://stoke.vinn.dev/` answered 200
 * with the whole installer, over a connection anyone on the path could rewrite,
 * headed for `| sh`. The Worker now answers plain HTTP with a 301 and nothing
 * executable, before it looks at what was asked for.
 */
check('http is sent to https', httpsRedirect('http://stoke.vinn.dev/'), 'https://stoke.vinn.dev/')
check('with its query, so ?sh still means ?sh', httpsRedirect('http://stoke.vinn.dev/?sh'), 'https://stoke.vinn.dev/?sh')
check('and its path', httpsRedirect('http://stoke.vinn.dev/install.ps1'), 'https://stoke.vinn.dev/install.ps1')
check('https is served', httpsRedirect('https://stoke.vinn.dev/'), null)
check('cf-visitor saying http is believed too', httpsRedirect('https://stoke.vinn.dev/', { 'cf-visitor': '{"scheme":"http"}' }), 'https://stoke.vinn.dev/')
check('and saying https is not a reason to redirect', httpsRedirect('https://stoke.vinn.dev/', { 'cf-visitor': '{"scheme":"https"}' }), null)
check('wrangler dev on localhost is left alone', httpsRedirect('http://localhost:8787/?sh'), null)
check('as is 127.0.0.1', httpsRedirect('http://127.0.0.1:8787/'), null)
ok(
  'the redirect body is a comment in sh AND PowerShell, so a curl without -L pipes nothing runnable',
  redirectBody('https://stoke.vinn.dev/').split('\n').filter(Boolean).every((l) => l.startsWith('#'))
)

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
/*
 * The other half of that decision, and it has to be asserted or the two halves
 * come apart. Three different bodies come back from one URL depending on the
 * User-Agent. With no `Vary`, a `public` response is one a SHARED cache — a
 * corporate MITM proxy, the very thing the `?sh` override exists for — may
 * store and hand to the next client whatever that one asked for: a shell
 * receiving the landing page, or a browser offered a script. `private` keeps
 * the short TTL for the end client, which has exactly one User-Agent.
 */
ok(
  'and the body is not offered to shared caches, since three of them share one URL',
  /(^|[,\s])(private|no-store)([,\s]|$)/.test(CACHE_CONTROL),
  CACHE_CONTROL
)
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
ok(
  'and asks httpsRedirect BEFORE routing, answering 301 with a location',
  workerCode.indexOf('httpsRedirect(request.url') !== -1 &&
    workerCode.indexOf('httpsRedirect(request.url') < workerCode.indexOf('routeFor(request.url') &&
    /status:\s*301/.test(workerCode) &&
    /location:\s*secure/.test(workerCode)
)

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
// Gotcha 102: every arm64 installer up to 0.9.9 exited 0 and put no files
// down, leaving a REGISTERED install with no Stoke.exe. Read out of the code,
// since the branch needs a real registry to reach.
ok(
  'install.ps1 never calls a same-version install "already installed" when its folder has no Stoke.exe',
  /\$empty = \$installed\.Location -and -not \(Test-Path -LiteralPath \(Join-Path \$installed\.Location 'Stoke\.exe'\)\)/.test(ps1Code) &&
    /if \(\$cmp -eq 0 -and \$empty\) \{/.test(ps1Code) &&
    ps1Code.indexOf('$cmp -eq 0 -and $empty') < ps1Code.indexOf('is already installed. Nothing to do.')
)
// The architecture comes from the MACHINE, not from this process's
// PROCESSOR_ARCHITECTURE: Git Bash on an arm64 PC is emulated x64, its
// handoff arrived saying AMD64, and the x64 build was installed. Measured on
// windows-11-arm: the registry and WMI answer ARM64 there, the environment
// and RuntimeInformation do not.
{
  const at = (needle: string): number => ps1Code.indexOf(needle)
  ok(
    'install.ps1 reads the machine\'s architecture from Session Manager\'s registry value first, then WMI, and its own process\'s last',
    at("-Name PROCESSOR_ARCHITECTURE") > -1 &&
      at('Get-CimInstance -ClassName Win32_Processor') > at("-Name PROCESSOR_ARCHITECTURE") &&
      at('$env:PROCESSOR_ARCHITEW6432) {') > at('Get-CimInstance -ClassName Win32_Processor') &&
      /\$arch = if \(\$machineArch -eq 'ARM64'\) \{ 'arm64' \} else \{ 'x64' \}/.test(ps1Code)
  )
  ok('and never RuntimeInformation.OSArchitecture, which said X64 on arm64 under emulation', !ps1Code.includes('OSArchitecture'))
}
ok(
  'and after installing, an exit 0 with no Stoke.exe is an error that names the portable zip, not "installed"',
  /Join-Path \$after\.Location 'Stoke\.exe'\)\)\) \{\s*throw "[^"]*portable zip/.test(ps1Code)
)

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
 * And then RUN it under each of them, because parsing is not running and the
 * gap between the two is where a real bug lived: `zsh -n install.sh` was clean
 * while `zsh install.sh` died on its first line of work with `command not
 * found: 1`. zsh does not split an unquoted parameter expansion on IFS unless
 * asked, and three things in the script depend on that splitting — the flicker
 * table, the stage thresholds and the painter's segments — so the whole file
 * was dead under the shell macOS makes the default while every assertion here
 * stayed green. `setopt sh_word_split` is the fix; this is what proves it.
 *
 * Byte-identical to /bin/sh's output, not merely exit 0: a shell that ran the
 * painter wrongly would still exit 0. Between them the four flags cover the
 * painter, the degrade rules, the digest pipeline and the help text.
 *
 * LINES and COLUMNS are set explicitly because zsh assigns LINES itself — 0
 * when there is no terminal — so `--print-plan tty` would report "the window is
 * under 12 rows" there and nowhere else, for a reason that is not the script's.
 */
const shellTmp = mkdtempSync(join(tmpdir(), 'stoke-install-shells-'))
try {
  const blob = join(shellTmp, 'blob.bin')
  writeFileSync(blob, randomBytes(20_000))
  const FLAGS: string[][] = [
    ['--fire-frames', 'truecolor'],
    ['--fire-frames', 'none'],
    ['--print-plan', 'tty'],
    ['--print-plan', 'pipe'],
    ['--sha512', blob],
    ['--help']
  ]
  const shellEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LINES: '40',
    COLUMNS: '120'
  }
  const runFlag = (shell: string, flag: string[]): string =>
    execFileSync(shell, [SH, ...flag], { encoding: 'utf8', env: shellEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  if (process.platform === 'win32' || !existsSync('/bin/sh')) {
    console.log('  SKIP  needs a POSIX shell to run the script with.')
  } else {
    for (const shell of SHELLS) {
      if (!existsSync(shell)) continue
      for (const flag of FLAGS) {
        const name = `${shell} runs ${flag[0]} ${flag[1]?.startsWith('/') ? '<file>' : (flag[1] ?? '')}`.trim()
        let got = ''
        let err = ''
        try {
          got = runFlag(shell, flag)
        } catch (e) {
          err = String((e as { stderr?: Buffer }).stderr ?? e).trim()
        }
        if (err) {
          ok(name, false, err)
          continue
        }
        const want = runFlag('/bin/sh', flag)
        ok(`${name}, identically to /bin/sh`, got === want, `${JSON.stringify(got.slice(0, 120))} vs ${JSON.stringify(want.slice(0, 120))}`)
      }
    }
  }
  /*
   * And the animate path, which no flag and no pipe can reach — `fire_open`,
   * `fire_draw` and `fire_cleanup` only ever run with a real terminal on the
   * other end, so they were the part of this script that nothing here touched.
   * That is not a theoretical gap: `printf '%s' "$ESC[?25l"` is `zsh: invalid
   * subscript`, because zsh reads `$NAME[` as an array subscript even inside
   * double quotes — so under zsh the fire died on its first byte AND the cursor
   * was never restored, with `setopt sh_word_split` doing nothing about it and
   * every offline flag passing. It took a pty to see. This calls the three
   * functions directly instead, by sourcing the script with `--help` so main
   * returns without doing anything.
   *
   * Asserted on its own terms as well as across shells, so it says something
   * even if every shell agreed on being wrong: hide first, restore last, three
   * redraws for three draws, and never the alternate screen buffer.
   */
  const drive = 'set -- --help; . "$STOKE_SH" >/dev/null 2>&1;' +
    ' FIRE_ANIMATE=1; fire_set_tier truecolor; fire_open;' +
    ' fire_draw 5; fire_draw 50; fire_draw 100; fire_cleanup'
  if (process.platform !== 'win32' && existsSync('/bin/sh')) {
    let reference = ''
    for (const shell of SHELLS) {
      if (!existsSync(shell)) continue
      let got = ''
      let err = ''
      try {
        got = execFileSync(shell, ['-c', drive], {
          encoding: 'utf8',
          env: { ...shellEnv, STOKE_SH: SH },
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (e) {
        err = String((e as { stderr?: Buffer }).stderr ?? e).trim()
      }
      if (err) {
        ok(`${shell} draws the fire`, false, err)
        continue
      }
      if (!reference) {
        reference = got
        ok('the fire hides the cursor before it draws anything', got.startsWith('[?25l'), JSON.stringify(got.slice(0, 12)))
        ok('and restores it last of all, so a failure cannot leave it hidden', got.endsWith('[?25h[0m'), JSON.stringify(got.slice(-12)))
        check(
          `one redraw per draw, and the canvas is ${CANVAS.rows} rows`,
          got.split(`[${CANVAS.rows}A`).length - 1,
          3
        )
        ok('and never the alternate screen buffer', !got.includes('1049'))
      }
      ok(`${shell} draws the fire identically`, got === reference, JSON.stringify(got.slice(0, 80)))
    }
  }
} finally {
  rmSync(shellTmp, { recursive: true, force: true })
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
  check(
    `every frame is exactly the ${CANVAS.rows} rows of the fixed canvas`,
    mono.trimEnd().split('\n').length,
    12 * CANVAS.rows
  )

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
/*
 * The Windows line is the long form, not `irm … | iex`: `irm` is a PowerShell
 * alias, and cmd.exe — where a Windows user who opened "a terminal" usually is
 * — answers it with `'irm' is not recognized`. `powershell -c "…"` is the same
 * install from cmd, Windows PowerShell and PowerShell 7 alike.
 */
const PS1_LINE = 'powershell -ExecutionPolicy Bypass -c "irm https://stoke.vinn.dev | iex"'
const PS1_SHORT = 'irm https://stoke.vinn.dev | iex'
const readmeText = readFileSync(join(root, 'README.md'), 'utf8')
ok('the landing page shows the sh one-liner', htmlText.includes(SH_LINE))
ok('and the Windows one, in the form cmd.exe can run', htmlText.includes(PS1_LINE))
ok('the page still offers the short form, for somebody already in PowerShell', htmlText.includes(PS1_SHORT))
/*
 * The page and README must never offer the short form as THE Windows line —
 * that is the exact instruction that failed in cmd.exe. It may appear only in
 * prose, inside a <code>, never as the <pre> a reader copies.
 */
ok('and never as the line to copy', !/<pre>[^<]*<span class="prompt">[^<]*<\/span>irm /.test(htmlText))
ok('install.sh sends a Windows user to exactly that ps1 line', shText.includes(`STOKE_PS1_LINE='${PS1_LINE}'`))
ok('install.ps1 sends a macOS user to exactly that sh line', ps1Text.includes(`$StokeShLine = '${SH_LINE}'`))
/*
 * README is the fifth place the address is written and was the one nothing
 * held: it is what a reader on GitHub copies, so a hostname that moved
 * everywhere except there is a one-liner that points at nothing, with the repo
 * looking correct. Same shape as gotchas 62 and 68 — a hand-kept copy of a
 * value with no assertion over it.
 */
ok('README shows the same sh one-liner', readmeText.includes(SH_LINE))
ok('and the same Windows one', readmeText.includes(PS1_LINE))
ok('install.ps1 names the same line in its header', ps1Text.includes(`#     ${PS1_LINE}`))
/*
 * And no documented command may leave a glob character unquoted in a URL.
 * `curl -fsSL https://stoke.vinn.dev?sh | sh` is the override the landing page
 * offers to anyone behind a User-Agent-rewriting proxy — and `?` is a glob, so
 * zsh, which is what a Mac terminal starts in, refuses it outright with `no
 * matches found` and never runs curl at all. The one person following that
 * instruction is the one person for whom nothing else works.
 */
const unquotedGlob = [...(htmlText + readmeText).matchAll(/(^|.)(https:\/\/stoke\.vinn\.dev[^\s<'"]*[?*][^\s<'"]*)/g)]
  .filter((m) => m[1] !== "'" && m[1] !== '"')
  .map((m) => m[2])
check('every documented URL carrying a glob character is quoted, or zsh refuses it', unquotedGlob, [])
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

console.log('\nwhat the script makes of a machine it is not running on')
/*
 * The environment decisions — platform, arch, and whether this box is about to
 * be handed a build that cannot start — are the least testable code in the
 * installer and the most consequential: they read `uname` and `id`, so on any
 * one machine five of the six branches are unreachable, and the Linux ones had
 * never executed at all until v0.9.5 shipped a Linux build.
 *
 * So the SHIPPED script is run with `uname` and `id` shimmed onto the front of
 * PATH. `--preflight` resolves nothing and downloads nothing, which is what
 * makes this affordable in a suite; the same shim trick with STOKE_DRY_RUN=1
 * is how the full resolve/verify path gets exercised by hand (gotcha 71).
 *
 * The root case is not hypothetical. Electron aborts hard on Linux as root —
 * "Running as root without --no-sandbox is not supported", a FATAL inside
 * Chromium's startup that no JavaScript of ours can catch — and the installer
 * cheerfully installed into /root and said "installed" right up until 0.9.5.
 */
{
  const shimDir = mkdtempSync(join(tmpdir(), 'stoke-preflight-'))
  const shim = (name: string, body: string): void => {
    const f = join(shimDir, name)
    writeFileSync(f, body, { mode: 0o755 })
  }
  /*
   * `pgrep` is shimmed too, always: the real one would count whatever Stoke
   * happens to be running on the machine running the suite, and the answer
   * would change with it.
   */
  const preflight = (
    os: string,
    machine: string,
    uid: string,
    extra: { running?: number; env?: Record<string, string>; shell?: string } = {}
  ): Record<string, string> => {
    shim('uname', `#!/bin/sh\ncase "$1" in\n  -s) echo ${os} ;;\n  -m) echo ${machine} ;;\n  *) echo ${os} ;;\nesac\n`)
    shim('id', `#!/bin/sh\ncase "$1" in\n  -u) echo ${uid} ;;\n  *) echo "uid=${uid}" ;;\nesac\n`)
    const pids = Array.from({ length: extra.running ?? 0 }, (_, i) => 4100 + i).join(' ')
    shim('pgrep', pids ? `#!/bin/sh\nfor p in ${pids}; do echo $p; done\n` : '#!/bin/sh\nexit 1\n')
    const out = execFileSync(extra.shell ?? '/bin/sh', [SH, '--preflight'], {
      encoding: 'utf8',
      env: { PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...(extra.env ?? {}) }
    })
    const map: Record<string, string> = {}
    for (const line of out.split('\n')) {
      const m = /^([a-z_]+)=(.*)$/.exec(line)
      if (m) map[m[1]] = m[2]
    }
    return map
  }

  try {
    check(
      'a normal user on x86-64 Linux gets the linux x64 build and no warning',
      preflight('Linux', 'x86_64', '1000'),
      { arch: 'x64', handoff: 'none', inside_stoke: 'no', platform: 'linux', refusal: 'none', root: 'no', root_warning: 'no' }
    )
    check(
      'ROOT on Linux is warned: Electron aborts there and the app cannot catch it',
      preflight('Linux', 'x86_64', '0').root_warning,
      'yes'
    )
    check(
      'root on macOS is NOT warned — crbug.com/638180 is a Linux-only refusal',
      preflight('Darwin', 'arm64', '0'),
      { arch: 'arm64', handoff: 'none', inside_stoke: 'no', platform: 'mac', refusal: 'none', root: 'yes', root_warning: 'no' }
    )
    check('aarch64 Linux resolves arm64', preflight('Linux', 'aarch64', '1000').arch, 'arm64')
    check('amd64 is x64', preflight('Linux', 'amd64', '1000').arch, 'x64')
    check('a Mac reports mac arm64', preflight('Darwin', 'arm64', '501').platform, 'mac')
    check('an Intel Mac reports x64', preflight('Darwin', 'x86_64', '501').arch, 'x64')
    check('MINGW is recognised as Windows, not as unsupported', preflight('MINGW64_NT-10.0', 'x86_64', '1000').platform, 'windows')
    check('a CPU with no build says so rather than guessing', preflight('Linux', 'riscv64', '1000').arch, 'unsupported')
    check('and so does an OS with no build', preflight('FreeBSD', 'x86_64', '1000').platform, 'unsupported')

    /*
     * The two ways a Mac install used to end badly, decided before anything
     * is downloaded. Inside a Stoke terminal, installing quits the Stoke that
     * owns this very shell (every Stoke pty sets TERM_PROGRAM=Stoke), so the
     * install died halfway with the old app renamed aside. With two copies
     * running, `quit app "Stoke"` asks one and the wait timed out on the other
     * after thirty seconds.
     */
    const inside = { TERM_PROGRAM: 'Stoke' }
    check('inside a Stoke terminal on a Mac, it refuses', preflight('Darwin', 'arm64', '501', { env: inside }).refusal, 'inside-stoke')
    check('and says it is inside', preflight('Darwin', 'arm64', '501', { env: inside }).inside_stoke, 'yes')
    check('on Linux it does not refuse: the replace there is a rename that quits nothing', preflight('Linux', 'x86_64', '1000', { env: inside }).refusal, 'none')
    check('Terminal.app is not Stoke', preflight('Darwin', 'arm64', '501', { env: { TERM_PROGRAM: 'Apple_Terminal' } }).refusal, 'none')
    check('two copies of Stoke running refuses up front', preflight('Darwin', 'arm64', '501', { running: 2 }).refusal, 'several-running')
    check('one copy is the ordinary case', preflight('Darwin', 'arm64', '501', { running: 1 }).refusal, 'none')
    check('none is too', preflight('Darwin', 'arm64', '501', { running: 0 }).refusal, 'none')
    check('inside Stoke is the reason given when both hold', preflight('Darwin', 'arm64', '501', { env: inside, running: 3 }).refusal, 'inside-stoke')
    for (const shell of ['/bin/bash', '/bin/dash', '/bin/zsh']) {
      if (!existsSync(shell)) continue
      check(
        `${shell} makes the same calls`,
        [preflight('Darwin', 'arm64', '501', { env: inside, shell }).refusal, preflight('Darwin', 'arm64', '501', { running: 2, shell }).refusal],
        ['inside-stoke', 'several-running']
      )
    }

    /*
     * And the real main acts on it BEFORE the first byte of network: run with
     * no flag, `curl` and `wget` replaced by a recorder that fails, and the
     * recorder must never have been called. Then the counterfactual — a dry run
     * quits nothing, so it is allowed past, and does reach the network.
     */
    const called = join(shimDir, 'fetch-called')
    shim('curl', `#!/bin/sh\necho "$@" >> '${called}'\nexit 22\n`)
    shim('wget', `#!/bin/sh\necho "$@" >> '${called}'\nexit 1\n`)
    const runMain = (env: Record<string, string>) => {
      rmSync(called, { force: true })
      const r = spawnSync('/bin/sh', [SH], {
        encoding: 'utf8',
        env: { PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: shimDir, TMPDIR: shimDir, ...env }
      })
      return { status: r.status, err: r.stderr, fetched: existsSync(called) }
    }
    preflight('Darwin', 'arm64', '501') // reset the uname/id/pgrep shims to a Mac with nothing running
    const refusedInside = runMain({ TERM_PROGRAM: 'Stoke' })
    check('main refuses inside Stoke, exit 1, before any download', [refusedInside.status, refusedInside.fetched], [1, false])
    ok('and names both ways out', /Settings > Updates/.test(refusedInside.err) && refusedInside.err.includes('curl -fsSL https://stoke.vinn.dev | sh'), refusedInside.err)
    preflight('Darwin', 'arm64', '501', { running: 2 })
    const refusedTwo = runMain({})
    check('main refuses with two copies running, before any download', [refusedTwo.status, refusedTwo.fetched], [1, false])
    ok('and lists the pids it saw', refusedTwo.err.includes('4100 4101'), refusedTwo.err)
    preflight('Darwin', 'arm64', '501')
    const dry = runMain({ TERM_PROGRAM: 'Stoke', STOKE_DRY_RUN: '1' })
    check('a dry run inside Stoke is let through, and reaches the network', dry.fetched, true)
  } finally {
    rmSync(shimDir, { recursive: true, force: true })
  }
}

console.log('\nthe mac/linux line typed into a Windows shell')
/*
 * Git Bash, MSYS2 and Cygwin can run install.sh — curl.exe sends `curl/8.x`, so
 * stoke.vinn.dev hands it the sh body — and it used to answer "run this in
 * PowerShell instead" and exit 1. It hands over now: the PowerShell installer,
 * run for them, their environment carried along.
 *
 * Run, not read, against a recording `powershell.exe`, with PATH holding
 * NOTHING but the shim directory. That isolation is load-bearing rather than
 * tidy: GitHub's ubuntu runners ship `/usr/bin/pwsh`, so any PATH that includes
 * the host's would find a real PowerShell there and the "no PowerShell at all"
 * branch could never be reached in CI. Everything the Windows branch calls
 * before handing over is either a builtin or one of these shims.
 */
{
  const dir = mkdtempSync(join(tmpdir(), 'stoke-handoff-'))
  const shim = (name: string, body: string): void => writeFileSync(join(dir, name), body, { mode: 0o755 })
  const argvFile = join(dir, 'argv')
  shim('uname', '#!/bin/sh\ncase "$1" in\n  -m) echo x86_64 ;;\n  *) echo MINGW64_NT-10.0-26100 ;;\nesac\n')
  shim('id', '#!/bin/sh\necho 1000\n')
  // One argument per line, then what it could read from stdin, then the two
  // environment variables that have to arrive: the MSYS guard and a knob the
  // user set.
  const recorder = (code: number) =>
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvFile}'\n` +
    `printf 'stdin=%s\\n' "$(cat)" >> '${argvFile}'\n` +
    `printf 'conv=%s\\n' "\${MSYS2_ARG_CONV_EXCL:-}" >> '${argvFile}'\n` +
    `printf 'dry=%s\\n' "\${STOKE_DRY_RUN:-}" >> '${argvFile}'\n` +
    `exit ${code}\n`
  const run = (shell: string, env: Record<string, string> = {}) => {
    rmSync(argvFile, { force: true })
    const r = spawnSync(shell, [SH], { encoding: 'utf8', input: 'REST OF THE PIPE\n', env: { PATH: dir, HOME: dir, ...env } })
    return { status: r.status, out: r.stdout, err: r.stderr, argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8').trim().split('\n') : null }
  }
  const pf = (): Record<string, string> => {
    const out = spawnSync('/bin/sh', [SH, '--preflight'], { encoding: 'utf8', env: { PATH: dir } }).stdout
    return Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2) as [string, string]))
  }
  try {
    check('with no PowerShell anywhere, preflight says it would only print the line', [pf().platform, pf().handoff], ['windows', 'message'])
    const bare = run('/bin/sh')
    check('and main does exactly that: exit 1, nothing handed over', [bare.status, bare.argv], [1, null])
    ok('naming the line that works in cmd AND PowerShell', bare.err.includes(PS1_LINE), bare.err)

    shim('powershell.exe', recorder(0))
    check('with powershell.exe on PATH, preflight says it would hand over', pf().handoff, 'powershell')
    for (const shell of SHELLS) {
      if (!existsSync(shell)) continue
      const r = run(shell, { STOKE_DRY_RUN: '1' })
      check(
        `${shell}: hands over with exactly this command, stdin cut off from the pipe, the MSYS guard set and STOKE_DRY_RUN carried`,
        [r.status, r.argv],
        [0, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Remove-Item Env:MSYS2_ARG_CONV_EXCL -ErrorAction SilentlyContinue; irm https://stoke.vinn.dev/install.ps1 | iex', 'stdin=', 'conv=*', 'dry=1']]
      )
    }
    ok('and says what it is doing before it does it', /handing over to the Windows installer, in powershell\.exe/.test(run('/bin/sh').out))
    /*
     * The guard is for the argv only. install.ps1 ends by starting Stoke, which
     * inherits PowerShell's environment — so the variable is removed before
     * anything is fetched, or every Claude Code session's Git Bash would run
     * with MSYS path conversion off (found by review).
     */
    ok('PowerShell drops MSYS2_ARG_CONV_EXCL before it fetches anything, so the Stoke it starts never inherits it', /^Remove-Item Env:MSYS2_ARG_CONV_EXCL -ErrorAction SilentlyContinue; irm /.test(run('/bin/sh').argv?.[4] ?? ''))
    shim('powershell.exe', recorder(3))
    check('a failed Windows install fails the line: the exit code comes back', run('/bin/sh').status, 3)
    /*
     * `OS=Windows_NT` alone counts, which is what Cygwin and a bare MSYS
     * runtime leave in the environment when `uname` says something else.
     */
    shim('uname', '#!/bin/sh\necho Linux\n')
    check('OS=Windows_NT is Windows even when uname is not', run('/bin/sh', { OS: 'Windows_NT' }).status, 3)
    const handoffUrl = /^STOKE_PS1_URL='([^']+)'$/m.exec(shText)?.[1] ?? ''
    check('the URL it hands over to is the readable ps1 path, which no User-Agent guess can turn into the page', routeFor(handoffUrl, { 'user-agent': 'curl/8.7.1' }).body, 'ps1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\nthe Linux launcher, run rather than read')
/*
 * `~/.local/bin/stoke` is a wrapper, not the AppImage, and the whole point of
 * it is a branch that cannot be reached from this machine: as root it adds
 * `--no-sandbox`, because Electron LOG(FATAL)s without it (crbug.com/638180)
 * before any of Stoke's JavaScript runs, and the AppImage's own AppRun will not
 * add it — its `unshare -Ur true` probe SUCCEEDS as root, which its generated
 * comment admits makes the probe "mostly a no-op in that scenario".
 *
 * So the wrapper is EXECUTED here rather than pattern-matched, against a
 * stand-in AppImage that records its argv. `--print-wrapper` emits the same
 * text `install_linux` writes, from the same function, so this runs the
 * shipped code path rather than a copy of it (gotcha 71). Root is reached the
 * way `--preflight` reaches it: by shimming `id` onto the front of PATH.
 *
 * It is also the `stoke` command on Linux now, so it carries the same contract
 * as build/bin/stoke on a Mac: --help and --version answered without starting
 * anything, and every typed argument wrapped as `--stoke-cli --stoke-cwd=… --`
 * for src/shared/stokeArgs.ts. And it launches DETACHED (setsid, else nohup),
 * so closing the terminal cannot take Stoke and its sessions down — which is
 * why the stand-in writes its argv to a file: the app's stdout goes to a log.
 *
 * The layout assertion matters as much as the branch. electron-updater's
 * AppImageUpdater replaces `process.env.APPIMAGE` in place only when that
 * file's basename has no `<n>.<n>.<n>` in it (AppImageUpdater.js: `if
 * (path.basename(installerPath) === existingBaseName || !/\d+\.\d+\.\d+/
 * .test(existingBaseName))`). It never reads PATH, argv or execPath — which is
 * why a wrapper can sit on PATH at all, and why the file it points at must keep
 * a version-free name.
 */
{
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-wrapper-')))
  try {
    const record = join(dir, 'argv.txt')
    const app = join(dir, 'stoke.AppImage')
    writeFileSync(
      app,
      '#!/bin/sh\n' +
        `{ printf 'ERAN=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}"; for a in "$@"; do printf '%s\\n' "$a"; done; } > '${record}'\n` +
        'if [ "${STAND_IN_FAIL:-}" = 1 ]; then echo "fuse: failed to open /dev/fuse" >&2; exit 127; fi\n',
      { mode: 0o755 }
    )

    const wrapperText = execFileSync('/bin/sh', [SH, '--print-wrapper', app], { encoding: 'utf8' })
    const launcher = join(dir, 'stoke')
    writeFileSync(launcher, wrapperText, { mode: 0o755 })

    check(
      'the wrapper points at an AppImage whose basename carries no version',
      /\d+\.\d+\.\d+/.test('stoke.AppImage'),
      false
    )
    check('and it is a POSIX sh script, not a shebang-less fragment', wrapperText.startsWith('#!/bin/sh'), true)
    ok(
      `and carries the mark Settings > Updates reads it back by (${LINUX_WRAPPER_MARK})`,
      wrapperText.split('\n').slice(0, 3).some((l) => l.startsWith(LINUX_WRAPPER_MARK))
    )
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh']) {
      if (!existsSync(shell)) continue
      let err = ''
      try {
        execFileSync(shell, ['-n', launcher], { stdio: 'pipe' })
      } catch (e) {
        err = String((e as { stderr?: Buffer }).stderr ?? e)
      }
      ok(`${shell} -n <the launcher>`, err === '', err)
    }

    const where = join(dir, 'a project')
    mkdirSync(where)
    const home = join(dir, 'home')
    mkdirSync(join(home, '.local', 'share', 'stoke'), { recursive: true })
    const run = (uid: string, args: string[], env: Record<string, string> = {}) => {
      rmSync(record, { force: true })
      const shim = join(dir, `shim-${uid}`)
      mkdirSync(shim, { recursive: true })
      writeFileSync(join(shim, 'id'), `#!/bin/sh\necho ${uid}\n`, { mode: 0o755 })
      const r = spawnSync('/bin/sh', [launcher, ...args], {
        encoding: 'utf8',
        cwd: where,
        env: {
          PATH: `${shim}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          HOME: home,
          PWD: where,
          TMPDIR: dir,
          ELECTRON_RUN_AS_NODE: '1',
          ...env
        }
      })
      const seen = existsSync(record) ? readFileSync(record, 'utf8').trimEnd().split('\n') : null
      return { status: r.status, out: r.stdout, err: r.stderr, erun: seen?.[0] ?? null, argv: seen ? seen.slice(1) : null }
    }

    check('a bare `stoke` starts the app with nothing added', run('1000', []).argv, [])
    check(
      'anything typed is wrapped for the parser, with this folder as the cwd',
      run('1000', ['--cli', 'codex', 'x y']).argv,
      ['--stoke-cli', `--stoke-cwd=${where}`, '--', '--cli', 'codex', 'x y']
    )
    const viaLauncher = run('1000', ['.']).argv ?? []
    check(
      'launcher -> parser: `stoke .` is a session in the folder it was typed in',
      parseStokeArgs(['stoke', ...viaLauncher], { home, platform: 'linux' }),
      { kind: 'session', cwd: where, cli: 'claude', launch: 'reuse' }
    )
    check(
      'root gets --no-sandbox, ahead of the request',
      run('0', ['.']).argv,
      ['--no-sandbox', '--stoke-cli', `--stoke-cwd=${where}`, '--', '.']
    )
    check('and on a bare launch too', run('0', []).argv, ['--no-sandbox'])
    ok('and is told what that costs', /sandbox is off/.test(run('0', []).err))
    check('ELECTRON_RUN_AS_NODE never reaches the app (gotcha 1)', run('1000', ['.']).erun, 'ERAN=unset')
    check(
      '--appimage-* goes through untouched, first, for the runtime to read',
      run('1000', ['--appimage-extract-and-run', '.']).argv,
      ['--appimage-extract-and-run', '.']
    )
    const help = run('1000', ['--help'])
    check('--help prints stokeHelp(linux) and starts nothing', [help.out, help.argv], [stokeHelp('linux'), null])
    writeFileSync(join(home, '.local', 'share', 'stoke', 'installed-version'), '1.2.3\n')
    const version = run('1000', ['--version'])
    check('--version reads what the installer recorded, and starts nothing', [version.out, version.argv], ['Stoke 1.2.3\n', null])
    check('install-cli is answered, not forwarded', run('1000', ['install-cli']).argv, null)
    const broken = run('1000', ['.'], { STAND_IN_FAIL: '1' })
    check('an app that cannot start fails the command', broken.status, 127)
    ok('and its own error is shown, not swallowed by the detached launch', broken.err.includes('fuse: failed'), broken.err)
    check('a launch that works exits 0', run('1000', ['.']).status, 0)
    ok(
      'the launch is detached: setsid where there is one, nohup where not',
      /command -v setsid/.test(wrapperText) && /setsid "\$STOKE_APPIMAGE" "\$@" <\/dev\/null/.test(wrapperText) &&
        /nohup "\$STOKE_APPIMAGE" "\$@" <\/dev\/null/.test(wrapperText)
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const shText = readFileSync(SH, 'utf8')
  check(
    'the .desktop entry launches the wrapper, so a double-click is covered too',
    /Exec=\$lin_bin %U/.test(shText),
    true
  )
  check(
    'and the root notice no longer tells the user to type --no-sandbox themselves',
    /note 'run it with' 'stoke --no-sandbox/.test(shText),
    false
  )
}

console.log('\nthe macOS install links the stoke command, through the command itself')
/*
 * After the copy lands, install_macos runs the NEW bundle's own `stoke
 * install-cli` (mac_link_cli), so the installer and the command share one rule
 * for what at ~/.local/bin/stoke may be replaced. `--link-cli <shim>` is that
 * exact function against a shim the suite names, under a temp HOME.
 */
if (process.platform === 'win32' || !existsSync('/bin/sh')) {
  console.log('  SKIP  needs a POSIX shell.')
} else {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-linkcli-')))
  try {
    const shims = join(tmp, 'shims')
    mkdirSync(shims)
    writeFileSync(join(shims, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 })
    const app = join(tmp, 'Applications', 'Stoke.app')
    const shim = join(app, 'Contents', 'Resources', 'bin', 'stoke')
    mkdirSync(dirname(shim), { recursive: true })
    copyFileSync(join(root, 'build', 'bin', 'stoke'), shim)
    execFileSync('/bin/chmod', ['755', shim])
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key>\n<string>0.0.1</string></dict></plist>\n')

    const link = (shell: string, target: string, home: string) =>
      spawnSync(shell, [SH, '--link-cli', target], {
        encoding: 'utf8',
        env: { PATH: `${shims}:/usr/bin:/bin`, HOME: home }
      })
    const homeFor = (name: string): string => {
      const h = join(tmp, name)
      mkdirSync(h, { recursive: true })
      return h
    }

    let reference = ''
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh']) {
      if (!existsSync(shell)) continue
      const home = homeFor(`home-${shell.split('/').pop()}`)
      const r = link(shell, shim, home)
      const made = join(home, '.local', 'bin', 'stoke')
      check(`${shell}: exits 0 and links ~/.local/bin/stoke to the new bundle`, [r.status, lstatSync(made).isSymbolicLink() && readlinkSync(made)], [0, shim])
      const out = r.stdout.split(home).join('<HOME>')
      if (!reference) {
        reference = out
        ok('it says what it did, and the PATH line to add', out.includes('command') && out.includes('export PATH="$HOME/.local/bin:$PATH"'), out)
      }
      ok(`${shell}: says it identically`, out === reference, JSON.stringify(out))
    }
    const foreignHome = homeFor('home-foreign')
    mkdirSync(join(foreignHome, '.local', 'bin'), { recursive: true })
    writeFileSync(join(foreignHome, '.local', 'bin', 'stoke'), 'mine\n')
    const refused = link('/bin/sh', shim, foreignHome)
    check(
      'somebody else’s stoke is left alone, and the install still succeeds',
      [refused.status, readFileSync(join(foreignHome, '.local', 'bin', 'stoke'), 'utf8'), /not linked/.test(refused.stdout)],
      [0, 'mine\n', true]
    )
    const olderHome = homeFor('home-older')
    const older = link('/bin/sh', join(tmp, 'Applications', 'Old.app', 'Contents', 'Resources', 'bin', 'stoke'), olderHome)
    check(
      'a release with no shim yet is said plainly and creates nothing',
      [older.status, /no stoke command yet/.test(older.stdout), existsSync(join(olderHome, '.local', 'bin', 'stoke'))],
      [0, true, false]
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
const shAll = readFileSync(SH, 'utf8')
ok('install_macos calls it on the bundle it just copied', /mac_link_cli \/Applications\/Stoke\.app\/Contents\/Resources\/bin\/stoke/.test(code(shAll)))

console.log('\nthe Windows installer does the same, unverified')
/*
 * No PowerShell here, so this is read, not run — said out loud rather than
 * left as a gap. What can be held from a Mac: the same inside-Stoke refusal,
 * placed before the first request, and a PATH edit that keeps %VAR% entries.
 */
const insideAt = ps1Code.indexOf("$env:TERM_PROGRAM -eq 'Stoke'")
ok('install.ps1 refuses inside Stoke', insideAt !== -1)
ok('before it fetches the manifest', insideAt !== -1 && insideAt < ps1Code.indexOf('Invoke-RestMethod -Uri'))
ok('but lets a dry run through', /TERM_PROGRAM -eq 'Stoke' -and -not \$env:STOKE_DRY_RUN/.test(ps1Code))
ok('it adds resources\\bin to the user PATH after installing', /Add-StokeToPath \(Join-Path \$after\.Location 'resources\\bin'\)/.test(ps1Code))
ok('reading the raw value, so %VAR% entries are not frozen', ps1Code.includes('DoNotExpandEnvironmentNames'))
ok('writing REG_EXPAND_SZ back', ps1Code.includes('RegistryValueKind]::ExpandString'))
ok('and never setx, which truncates at 1024 characters', !/\bsetx\b/i.test(ps1Code))

console.log('\nthe landing page says what is true now')
ok('it no longer calls ~/.local/bin/stoke the AppImage', !/puts the AppImage at <code>~\/\.local\/bin\/stoke<\/code>/.test(htmlText))
ok('it names where the AppImage does go', htmlText.includes('~/.local/bin/stoke.AppImage'))
ok('it no longer says Linux builds arrive "from the next release onwards"', !/next release onwards/.test(htmlText))
ok('nor that the installer calls Linux experimental, which it does not', !/the installer says so too/.test(htmlText))
ok('it documents the stoke command', htmlText.includes('stoke .') && htmlText.includes('stoke --help'))

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
