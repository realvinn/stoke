/*
 * `stoke …` from a terminal: the grammar, the shims that carry it, and the
 * rules for putting the command on PATH.
 *
 *   node scripts/verify-stoke-args.mts
 *
 * Three pieces have to agree and two of them are shell scripts that cannot
 * import anything, so this runs them rather than reading them:
 *
 *  - src/shared/stokeArgs.ts, which turns an argv into a request. The rule that
 *    matters most is the one about SILENCE: an argv without `--stoke-cli` is
 *    never a request, because the app is launched by Finder, the updater and
 *    every test here with argvs full of other things.
 *  - build/bin/stoke (macOS) and build/bin/stoke.cmd (Windows), which build that
 *    argv and answer --help themselves. The POSIX one is RUN, against a fake
 *    bundle, with `open` replaced by a recorder, and what it would have launched
 *    is fed back through the parser — the wire from the shell to the request.
 *  - src/shared/stokeCommand.ts and src/main/stokeCommand.ts, which decide
 *    whether a `~/.local/bin/stoke` may be replaced. The shim's own
 *    `install-cli` is run against the same fixtures and must make the same call:
 *    a link to a Stoke bundle is re-pointed, anything else is never touched.
 *
 * Everything that writes does so under a temp HOME, and a bystander file beside
 * the link is checked after every operation (gotcha 74).
 */
import { execFileSync, spawnSync } from 'node:child_process'
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
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  folderProblem,
  parseStokeArgs,
  requestFrom,
  resolveFolder,
  stokeHelp,
  STOKE_CLI_MARKER,
  type StokeCliRequest
} from '../src/shared/stokeArgs.ts'
import {
  appOfShim,
  classifyLinuxCommand,
  classifyMacLink,
  dirOnPath,
  isStokeShimTarget,
  LINUX_WRAPPER_MARK,
  macBundleProblem,
  PATH_EXPORT_LINE
} from '../src/shared/stokeCommand.ts'
import { CODING_CLIS } from '../src/shared/codingClis.ts'
import {
  installCommand,
  readCommandState,
  removeCommand,
  WIN_PATH_ADD,
  WIN_PATH_READ,
  WIN_PATH_REMOVE,
  type CommandEnv
} from '../src/main/stokeCommand.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIM = join(root, 'build', 'bin', 'stoke')
const CMD = join(root, 'build', 'bin', 'stoke.cmd')

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass || !detail ? '' : `\n        ${detail}`))
}

const HOME = '/Users/me'
const CWD = '/Users/me/proj'
const MAC = { home: HOME, platform: 'darwin' }
/** An argv exactly as the shim builds it: marker, cwd, Chromium's terminator, then what was typed. */
const shimArgv = (...typed: string[]): string[] => [
  '/Applications/Stoke.app/Contents/MacOS/Stoke',
  STOKE_CLI_MARKER,
  `--stoke-cwd=${CWD}`,
  '--',
  ...typed
]
const parse = (...typed: string[]): StokeCliRequest | null => parseStokeArgs(shimArgv(...typed), MAC)
const kind = (r: StokeCliRequest | null): string => (r === null ? 'null' : r.kind)
const msg = (r: StokeCliRequest | null): string => (r && r.kind === 'error' ? r.message : '')
const session = (cwd: string, cli = 'claude', launch = 'reuse'): StokeCliRequest =>
  ({ kind: 'session', cwd, cli, launch }) as StokeCliRequest

// ---------------------------------------------------------------------------
console.log('\nonly an argv carrying the marker is a request')
// ---------------------------------------------------------------------------
/*
 * Every one of these is a real launch shape: the bare binary, a Finder launch
 * on an old macOS (-psn_), the verify suites' own profile and CDP flags, a dev
 * run with its app path, and the switch Chromium appends to a forwarded argv.
 * A folder-looking positional must not be read as "open this" without the
 * marker — that is the whole security model of the parser.
 */
for (const argv of [
  [],
  ['/Applications/Stoke.app/Contents/MacOS/Stoke'],
  ['/Applications/Stoke.app/Contents/MacOS/Stoke', '-psn_0_123456'],
  ['Electron', '.', '--user-data-dir=/tmp/stoke-cli-ud', '--remote-debugging-port=9340', '/tmp/stoke-cli-probe'],
  ['Electron', '.', '--original-process-start-time=13370000000', '/etc'],
  ['Stoke', '--stoke-cwd=/tmp', '.', '--new'],
  ['Stoke', '--stoke-clii', '.'],
  ['Stoke', 'stoke-cli', '.']
]) {
  check(`no marker, no request: ${JSON.stringify(argv.slice(1))}`, parseStokeArgs(argv, MAC), null)
}
check('the marker alone is a focus request', kind(parseStokeArgs(['Stoke', STOKE_CLI_MARKER], MAC)), 'focus')
check(
  'nothing BEFORE the marker is read, however folder-like',
  parseStokeArgs(['Electron', '/etc', '--user-data-dir=/tmp/ud', STOKE_CLI_MARKER, `--stoke-cwd=${CWD}`, '--', '.'], MAC),
  session(CWD)
)

// ---------------------------------------------------------------------------
console.log('\nevery command')
// ---------------------------------------------------------------------------
check('`stoke` brings the window forward and starts nothing', parse(), { kind: 'focus' })
check('`stoke .` is a session here, reusing a running tab', parse('.'), session(CWD))
check('`stoke sub` resolves against the shell cwd', parse('sub'), session(`${CWD}/sub`))
check('`stoke --new` always opens another tab, here', parse('--new'), session(CWD, 'claude', 'new'))
check('`stoke --new x` and `stoke x --new` agree', parse('x', '--new'), parse('--new', 'x'))
check('`stoke --cli codex` is a Codex session here', parse('--cli', 'codex'), session(CWD, 'codex'))
check('`--cli=codex dir` is the same flag', parse('--cli=codex', 'dir'), session(`${CWD}/dir`, 'codex'))
check('`--cli codex --new .` is a new Codex tab', parse('--cli', 'codex', '--new', '.'), session(CWD, 'codex', 'new'))
check('`--continue` is Claude Code continuing here', parse('--continue'), session(CWD, 'claude', 'continue'))
check('`--continue --cli claude` is allowed, since it IS Claude', parse('--continue', '--cli', 'claude'), session(CWD, 'claude', 'continue'))
check('`--open` adds the folder and starts nothing', parse('--open'), { kind: 'open', cwd: CWD })
check('`--open dir` likewise', parse('--open', 'dir'), { kind: 'open', cwd: `${CWD}/dir` })
check('`stoke update` is the update request', parse('update'), { kind: 'update' })
check('`stoke ./update` is a folder called update', parse('./update'), session(`${CWD}/update`))
check('`stoke --new update` is a folder too: a command is only ever the first word', parse('--new', 'update'), session(`${CWD}/update`, 'claude', 'new'))
check('`stoke update now` is refused rather than guessed at', kind(parse('update', 'now')), 'error')
ok('install-cli reaching the app points at the Settings row', /Settings → Updates → Command line/.test(msg(parse('install-cli'))), msg(parse('install-cli')))
check('uninstall-cli likewise is an error, not a session in a folder of that name', kind(parse('uninstall-cli')), 'error')
check('--help that got past the shim is only a focus', parse('--help'), { kind: 'focus' })
check('as is -v', parse('-v', '.'), { kind: 'focus' })

console.log('\n  the combinations that disagree, refused with a sentence')
check('two folders', kind(parse('a', 'b')), 'error')
ok('and it names them', /2: a, b/.test(msg(parse('a', 'b'))), msg(parse('a', 'b')))
check('--open with --cli', kind(parse('--open', '--cli', 'codex')), 'error')
check('--open with --new', kind(parse('--open', '--new')), 'error')
check('--new with --continue', kind(parse('--new', '--continue')), 'error')
check('--continue with another CLI', kind(parse('--continue', '--cli', 'codex')), 'error')
check('--cli twice, differently', kind(parse('--cli', 'codex', '--cli', 'claude')), 'error')
check('--cli twice, the same, is harmless', parse('--cli', 'codex', '--cli', 'codex'), session(CWD, 'codex'))

console.log('\n  hostile and junk input')
check('--cli with nothing after it', kind(parse('--cli')), 'error')
check('--cli= with an empty value', kind(parse('--cli=', '.')), 'error')
ok(
  '--cli ../../etc is an unknown CLI, never a path',
  /does not know a CLI called "\.\.\/\.\.\/etc"/.test(msg(parse('--cli', '../../etc'))),
  msg(parse('--cli', '../../etc'))
)
ok(
  'and the known ones are listed from CODING_CLIS',
  msg(parse('--cli', 'vim')).includes(CODING_CLIS.map((c) => c.id).join(', '))
)
check('an unknown option is an error', kind(parse('-x')), 'error')
ok('which says how to name a folder starting with -', /stoke -- -x/.test(msg(parse('-x'))), msg(parse('-x')))
check('and `--` then does exactly that', parse('--', '-x'), session(`${CWD}/-x`))
check('`./-x` too', parse('./-x'), session(`${CWD}/-x`))
/*
 * A Chromium switch typed AFTER the transport's terminator reached the parser
 * rather than the browser — which is the point of the terminator — and is an
 * unknown option there, not a debugging port.
 */
check('a Chromium switch after the terminator is just an unknown option', kind(parse('--remote-debugging-port=9222')), 'error')
check('so is a second marker', kind(parse(STOKE_CLI_MARKER, '.')), 'error')
check('and a cwd override typed by hand', kind(parse('--stoke-cwd=/etc', '.')), 'error')
check('a NUL in a path', kind(parse('a\u0000b')), 'error')
check('a path over 4096 characters', kind(parse('x'.repeat(5000))), 'error')
const escapeMsg = msg(parse('--\u001b[31mred'))
ok('control characters never reach the banner', escapeMsg !== '' && !/[\u0000-\u001f]/.test(escapeMsg), JSON.stringify(escapeMsg))
check('a lone `-` is an unknown option, not stdin', kind(parse('-')), 'error')

// ---------------------------------------------------------------------------
console.log('\npaths: relative, absolute, ~, trailing slashes')
// ---------------------------------------------------------------------------
check('`..` climbs one', parse('..'), session('/Users/me'))
check('`..` never climbs above /', parse('../../../../..'), session('/'))
check('an absolute path is taken as it is', parse('/opt/work'), session('/opt/work'))
check('trailing slashes go', parse('/opt/work///'), session('/opt/work'))
check('doubled and dot segments collapse', parse('/opt//./work/../play'), session('/opt/play'))
check('`~` is the home folder', parse('~'), session(HOME))
check('`~/x/` is inside it', parse('~/x/'), session(`${HOME}/x`))
check('`~other` is a folder named ~other, not a user', parse('~other'), session(`${CWD}/~other`))
check('the root itself', parse('/'), session('/'))
check(
  'with no --stoke-cwd, a relative folder cannot be resolved',
  kind(parseStokeArgs(['Stoke', STOKE_CLI_MARKER, '--', '.'], MAC)),
  'error'
)
check(
  'but an absolute one can',
  parseStokeArgs(['Stoke', STOKE_CLI_MARKER, '--', '/opt'], MAC),
  session('/opt')
)
check(
  'and a RELATIVE --stoke-cwd is no cwd at all',
  kind(parseStokeArgs(['Stoke', STOKE_CLI_MARKER, '--stoke-cwd=proj', '--', '.'], MAC)),
  'error'
)

console.log('\n  Windows paths, resolved the way cmd.exe hands them over')
const WIN = { home: 'C:\\Users\\me', platform: 'win32' }
const winAt = (cwd: string, ...typed: string[]) =>
  parseStokeArgs(['Stoke.exe', STOKE_CLI_MARKER, `--stoke-cwd=${cwd}`, '--', ...typed], WIN)
check('`.` in a folder', winAt('C:\\Users\\me\\proj', '.'), session('C:\\Users\\me\\proj'))
check('`..\\x`', winAt('C:\\Users\\me\\proj', '..\\x'), session('C:\\Users\\me\\x'))
check('forward slashes and a lower-case drive', winAt('C:\\w', 'd:/a/b/'), session('D:\\a\\b'))
check('`\\x` is the root of the cwd drive', winAt('E:\\deep\\down', '\\x'), session('E:\\x'))
check('a UNC share', winAt('C:\\w', '\\\\srv\\share\\x\\..\\y'), session('\\\\srv\\share\\y'))
check('`..` never climbs out of a share', winAt('\\\\srv\\share\\a', '..\\..\\..'), session('\\\\srv\\share'))
check('a bare drive is its root', winAt('C:\\w', 'c:'), session('C:\\'))
check('`~` is the profile folder', winAt('C:\\w', '~\\code'), session('C:\\Users\\me\\code'))
/*
 * stoke.cmd doubles a trailing backslash so `"--stoke-cwd=C:\"` does not read
 * as an escaped quote; CommandLineToArgvW turns the pair back into one. So the
 * cwd that arrives from a drive root is `C:\`, and `.` there must be `C:\`.
 */
check('the drive root cwd stoke.cmd sends', winAt('C:\\', '.'), session('C:\\'))
check('`C:foo` is refused: relative to a per-drive cwd nobody can know', kind(winAt('D:\\w', 'C:foo')), 'error')
check('a device path is refused', kind(winAt('C:\\w', '\\\\?\\C:\\x')), 'error')
check(
  'resolveFolder reports the relative-without-cwd case for Windows too',
  'error' in resolveFolder('x', null, WIN),
  true
)

// ---------------------------------------------------------------------------
console.log('\nthe argv the proof commands and a reordered forward produce')
// ---------------------------------------------------------------------------
/*
 * A direct launch with no `--` (how this repo's own CDP proof starts a second
 * instance) parses, because everything after the marker is then the user's.
 */
const direct = (...rest: string[]) =>
  parseStokeArgs(['Electron', '.', '--user-data-dir=/tmp/stoke-cli-ud', STOKE_CLI_MARKER, ...rest], MAC)
check('direct: a folder', direct('--stoke-cwd=/tmp/p', '/tmp/p'), session('/tmp/p'))
check('direct: --open', direct('--stoke-cwd=/tmp/p', '--open', '/tmp/p'), { kind: 'open', cwd: '/tmp/p' })
check('direct: --cli codex', direct('--stoke-cwd=/tmp/p', '--cli', 'codex', '/tmp/p'), session('/tmp/p', 'codex'))
check('direct: the first --stoke-cwd wins', direct('--stoke-cwd=/a', '--stoke-cwd=/b', '.'), session('/a'))

/*
 * Chromium's CommandLine moves every switch ahead of every positional
 * (`AppendSwitchesAndArguments`: a switch is inserted before `begin_args_`, an
 * argument appended; parsing switches stops at `--`, which is kept as an
 * argument). That is the argv a `second-instance` handler receives, and why
 * Electron says to send `additionalData` instead. The shim's `--` is what keeps
 * even that reordered argv readable, for the fallback path.
 */
function chromiumReorder(argv: string[], appended: string[] = []): string[] {
  const [prog, ...rest] = argv
  const switches: string[] = []
  const args: string[] = []
  let parsing = true
  for (const a of rest) {
    if (a === '--') parsing = false
    if (parsing && a.length > 1 && a.startsWith('-')) switches.push(a)
    else args.push(a)
  }
  return [prog, ...switches, ...appended, ...args]
}
for (const typed of [['.'], ['--cli', 'codex', '--new', 'x'], ['--open', '~/w'], ['--', '-odd'], ['update']]) {
  const argv = shimArgv(...typed)
  check(
    `reordered by Chromium, with a switch appended, \`stoke ${typed.join(' ')}\` still parses the same`,
    parseStokeArgs(chromiumReorder(argv, ['--original-process-start-time=13370000000']), MAC),
    parseStokeArgs(argv, MAC)
  )
}

// ---------------------------------------------------------------------------
console.log('\na forwarded request is rebuilt, never trusted')
// ---------------------------------------------------------------------------
/*
 * `additionalData` arrives from another process — another build of Stoke, or
 * anything that can write to the lock's pipe. Every parse result has to survive
 * the JSON trip unchanged, and anything malformed has to come back null.
 */
const samples = [parse(), parse('.'), parse('--cli', 'codex', '--new'), parse('--continue'), parse('--open'), parse('update'), parse('-x')]
for (const r of samples) {
  check(`round-trips: ${kind(r)}`, requestFrom(JSON.parse(JSON.stringify(r)), 'darwin'), r)
}
check('null', requestFrom(null, 'darwin'), null)
check('a string', requestFrom('session', 'darwin'), null)
check('an unknown kind', requestFrom({ kind: 'shell', cmd: 'rm -rf /' }, 'darwin'), null)
check('a relative cwd', requestFrom({ kind: 'session', cwd: 'proj', cli: 'claude', launch: 'reuse' }, 'darwin'), null)
check('a NUL in the cwd', requestFrom({ kind: 'open', cwd: '/a\u0000' }, 'darwin'), null)
check('an unknown CLI', requestFrom({ kind: 'session', cwd: '/a', cli: 'bash', launch: 'reuse' }, 'darwin'), null)
check('an unknown launch', requestFrom({ kind: 'session', cwd: '/a', cli: 'claude', launch: 'fork' }, 'darwin'), null)
check('--continue on Codex', requestFrom({ kind: 'session', cwd: '/a', cli: 'codex', launch: 'continue' }, 'darwin'), null)
check(
  'extra keys are dropped, not carried',
  requestFrom({ kind: 'open', cwd: '/a', exec: 'x', __proto__: { polluted: true } }, 'darwin'),
  { kind: 'open', cwd: '/a' }
)
check('a POSIX path is not absolute on Windows', requestFrom({ kind: 'open', cwd: '/a' }, 'win32'), null)
check('a Windows path is', requestFrom({ kind: 'open', cwd: 'C:\\a' }, 'win32'), { kind: 'open', cwd: 'C:\\a' })
const forwardedError = requestFrom({ kind: 'error', message: 'bad\u001b[2J' }, 'darwin')
ok('an error message is scrubbed of control characters', forwardedError !== null && !msg(forwardedError).includes('\u001b'))

console.log('\n  what main says about a folder it could not use')
const problems = (['missing', 'not-a-folder', 'denied', 'unreachable'] as const).map((p) => msg(folderProblem('/x/y', p)))
check('four different sentences', new Set(problems).size, 4)
ok('each names the folder', problems.every((m) => m.includes('/x/y')))

// ---------------------------------------------------------------------------
console.log('\nthe help text, in all three places it is printed')
// ---------------------------------------------------------------------------
for (const platform of ['darwin', 'linux', 'win32']) {
  const help = stokeHelp(platform)
  ok(`${platform}: plain ASCII`, /^[\x20-\x7e\n]*$/.test(help))
  ok(
    `${platform}: nothing cmd.exe's echo or an unquoted heredoc would read`,
    !/[<>|&^%!"$`\\]/.test(help),
    help.match(/[<>|&^%!"$`\\]/g)?.join('') ?? ''
  )
  ok(`${platform}: lists every agent id`, CODING_CLIS.every((c) => new RegExp(`[ ,]${c.id}(,|\n)`).test(help)))
}
ok('install-cli is offered on macOS only', stokeHelp('darwin').includes('install-cli') && !stokeHelp('linux').includes('install-cli') && !stokeHelp('win32').includes('install-cli'))

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh']
if (process.platform === 'win32' || !existsSync('/bin/sh')) {
  console.log('  SKIP  no POSIX shell here to run build/bin/stoke with.')
} else {
  for (const shell of SHELLS) {
    if (!existsSync(shell)) continue
    const out = execFileSync(shell, [SHIM, '--help'], { encoding: 'utf8' })
    check(`${shell} build/bin/stoke --help is stokeHelp('darwin')`, out, stokeHelp('darwin'))
  }
}

const cmdText = readFileSync(CMD, 'utf8')
/*
 * The checkout carries it CRLF (.gitattributes: *.cmd eol=crlf) because cmd's
 * GOTO scans for a label by byte offset and an LF-only file can miss one.
 */
ok('stoke.cmd is CRLF throughout', cmdText.includes('\r\n') && !/[^\r]\n/.test(cmdText))
const cmdLines = cmdText.split('\r\n')
const helpAt = cmdLines.indexOf(':help')
const echoed: string[] = []
for (let i = helpAt + 1; i < cmdLines.length && cmdLines[i].startsWith('echo('); i++) echoed.push(cmdLines[i].slice(5))
check("stoke.cmd's :help echoes stokeHelp('win32') line for line", echoed.join('\n') + '\n', stokeHelp('win32'))
ok(
  'stoke.cmd launches Stoke.exe two folders up with the marker, the cwd and the terminator',
  cmdText.includes('set "STOKE_EXE=%~dp0..\\..\\Stoke.exe"') &&
    cmdText.includes('start "" "%STOKE_EXE%" --stoke-cli "--stoke-cwd=%STOKE_CWD%" -- %*')
)
ok('and doubles a trailing backslash on the cwd, or C:\\ would escape its own quote', cmdText.includes('if "%STOKE_CWD:~-1%"=="\\" set "STOKE_CWD=%STOKE_CWD%\\"'))
ok('and clears ELECTRON_RUN_AS_NODE before launching', cmdText.includes('set "ELECTRON_RUN_AS_NODE="'))
// A `%` in a rem line is still expanded by cmd, and %* there would splice the
// user's arguments into a comment.
ok('no rem line carries a percent sign', !cmdLines.some((l) => /^rem\b.*%/i.test(l)))

// ---------------------------------------------------------------------------
console.log('\nthe link rules')
// ---------------------------------------------------------------------------
const OUR = '/Applications/Stoke.app/Contents/Resources/bin/stoke'
check('a link to this bundle is installed', classifyMacLink({ kind: 'link', target: OUR }, OUR), 'installed')
check('a link to another Stoke bundle is repairable', classifyMacLink({ kind: 'link', target: '/Users/me/Downloads/Stoke.app/Contents/Resources/bin/stoke' }, OUR), 'repairable')
check('so is a relative link into one', classifyMacLink({ kind: 'link', target: '../../../Applications/Stoke.app/Contents/Resources/bin/stoke' }, OUR), 'repairable')
check('a link to anything else is foreign', classifyMacLink({ kind: 'link', target: '/opt/homebrew/bin/stoke' }, OUR), 'foreign')
check('a regular file is foreign', classifyMacLink({ kind: 'other' }, OUR), 'foreign')
check('nothing there is missing', classifyMacLink({ kind: 'missing' }, OUR), 'missing')
ok('a shim target must END in the bundle path', !isStokeShimTarget('/Applications/Stoke.app/Contents/Resources/bin/stoke.bak'))
check('appOfShim', appOfShim(OUR), '/Applications/Stoke.app')
check('appOfShim of something else', appOfShim('/usr/local/bin/stoke'), null)
ok('App Translocation is refused', macBundleProblem('/private/var/folders/x/AppTranslocation/ABC/d/Stoke.app') !== null)
ok('an app at a disk image root is refused', macBundleProblem('/Volumes/Stoke 0.9.6-arm64/Stoke.app') !== null)
check('an app kept on an external drive is fine', macBundleProblem('/Volumes/External/Applications/Stoke.app'), null)
check('/Applications is fine', macBundleProblem('/Applications/Stoke.app'), null)
check('on PATH', dirOnPath('/Users/me/.local/bin', '/usr/bin:/Users/me/.local/bin:/bin', 'darwin'), true)
check('on PATH with a trailing slash', dirOnPath('/Users/me/.local/bin', '/usr/bin:/Users/me/.local/bin/', 'darwin'), true)
check('not on PATH', dirOnPath('/Users/me/.local/bin', '/usr/bin:/bin', 'darwin'), false)
check('a prefix is not a match', dirOnPath('/Users/me/.local/bin', '/Users/me/.local/bin2', 'darwin'), false)
check('no PATH read is unknown, not false', dirOnPath('/Users/me/.local/bin', null, 'darwin'), null)
check('Windows compares case-insensitively on ;', dirOnPath('C:\\S\\resources\\bin', 'C:\\x;c:\\s\\RESOURCES\\bin\\', 'win32'), true)
check('Linux: the installer launcher', classifyLinuxCommand(`#!/bin/sh\n${LINUX_WRAPPER_MARK} Written by…`), 'wrapper')
check('Linux: an AppImage is the older layout', classifyLinuxCommand('\u007fELF\u0002\u0001'), 'appimage')
check('Linux: some other script', classifyLinuxCommand('#!/bin/sh\necho hi'), 'foreign')
check('Linux: nothing', classifyLinuxCommand(null), 'missing')

console.log('\n  the PowerShell that edits the Windows PATH')
for (const [name, script] of [['add', WIN_PATH_ADD], ['remove', WIN_PATH_REMOVE], ['read', WIN_PATH_READ]] as const) {
  ok(`${name}: never setx, which truncates at 1024 characters`, !/\bsetx\b/i.test(script))
}
for (const [name, script] of [['add', WIN_PATH_ADD], ['remove', WIN_PATH_REMOVE]] as const) {
  ok(`${name}: reads the raw value, so %VAR% entries are not frozen`, script.includes('DoNotExpandEnvironmentNames'))
  ok(`${name}: writes it back as REG_EXPAND_SZ`, script.includes('RegistryValueKind]::ExpandString'))
  ok(`${name}: announces the change through [Environment]`, script.includes("[Environment]::SetEnvironmentVariable('STOKE_PATH_CHANGED'"))
  ok(`${name}: takes the folder from the environment, never spliced into the script`, script.includes('$env:STOKE_BIN_DIR'))
}

// ---------------------------------------------------------------------------
console.log('\nthe shim, run: what it launches, and what it links')
// ---------------------------------------------------------------------------
if (process.platform === 'win32' || !existsSync('/bin/sh')) {
  console.log('  SKIP  needs a POSIX shell.')
} else {
  // Real path: on macOS /var is a link to /private/var, and the shim resolves
  // its own location physically (`pwd -P`), as process.resourcesPath is.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-args-')))
  try {
    // A fake bundle with the real shim inside it, and a `uname` that says
    // Darwin so this runs the same on a Linux CI runner.
    const app = join(tmp, 'Applications', 'Stoke.app')
    const res = join(app, 'Contents', 'Resources')
    mkdirSync(join(res, 'bin'), { recursive: true })
    const shim = join(res, 'bin', 'stoke')
    copyFileSync(SHIM, shim)
    execFileSync('/bin/chmod', ['755', shim])
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>9.8.7</string>\n</dict>\n</plist>\n'
    )
    const shims = join(tmp, 'shims')
    mkdirSync(shims)
    writeFileSync(join(shims, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 })
    const linuxShims = join(tmp, 'shims-linux')
    mkdirSync(linuxShims)
    writeFileSync(join(linuxShims, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 })
    const recorder = join(tmp, 'open-recorder')
    writeFileSync(
      recorder,
      '#!/bin/sh\nprintf "ELECTRON_RUN_AS_NODE=%s\\n" "${ELECTRON_RUN_AS_NODE-unset}"\nfor a in "$@"; do printf "%s\\n" "$a"; done\n',
      { mode: 0o755 }
    )
    const home = join(tmp, 'home')
    const bin = join(home, '.local', 'bin')
    mkdirSync(home)
    const where = join(tmp, 'work dir')
    mkdirSync(where)

    const run = (file: string, args: string[], env: Record<string, string> = {}, cwd = where) =>
      spawnSync('/bin/sh', [file, ...args], {
        encoding: 'utf8',
        cwd,
        env: {
          PATH: `${shims}:/usr/bin:/bin`,
          HOME: home,
          PWD: cwd,
          ELECTRON_RUN_AS_NODE: '1',
          ...env
        }
      })

    check('--version reads the bundle it sits in', run(shim, ['--version']).stdout, 'Stoke 9.8.7\n')

    const launched = run(shim, ['--cli', 'codex', 'a b', '-x'], { STOKE_OPEN: recorder })
    const lines = launched.stdout.trimEnd().split('\n')
    check('ELECTRON_RUN_AS_NODE is gone before the GUI starts (gotcha 1)', lines[0], 'ELECTRON_RUN_AS_NODE=unset')
    check(
      'it asks open for a NEW instance of its own bundle, with the marker, the shell cwd and the terminator',
      lines.slice(1),
      ['-n', '-a', app, '--args', '--stoke-cli', `--stoke-cwd=${where}`, '--', '--cli', 'codex', 'a b', '-x']
    )
    /*
     * The wire from the shell to the request: what the shim hands `open` after
     * --args is exactly the argv the app gets, so parse THAT.
     */
    const viaShim = (...typed: string[]): StokeCliRequest | null => {
      const out = run(shim, typed, { STOKE_OPEN: recorder }).stdout.trimEnd().split('\n')
      return parseStokeArgs(['Stoke', ...out.slice(out.indexOf('--args') + 1)], { home, platform: 'darwin' })
    }
    check('shim -> parser: `stoke .` is a session in the shell folder, spaces and all', viaShim('.'), session(where))
    check('shim -> parser: `stoke --cli codex ..`', viaShim('--cli', 'codex', '..'), session(tmp, 'codex'))
    check('shim -> parser: `stoke --open ~`', viaShim('--open', '~'), { kind: 'open', cwd: home })
    check('shim -> parser: a switch-looking argument reaches the parser, not Chromium', kind(viaShim('--remote-debugging-port=9222')), 'error')
    check('shim -> parser: `stoke` alone is focus', viaShim(), { kind: 'focus' })

    // --- install-cli, against the fixtures classifyMacLink is handed --------
    const link = join(bin, 'stoke')
    const bystander = join(bin, 'someone-elses-tool')
    const reset = (): void => {
      rmSync(bin, { recursive: true, force: true })
      mkdirSync(bin, { recursive: true })
      writeFileSync(bystander, 'untouched\n')
    }
    const entryAt = (p: string) => {
      try {
        const st = lstatSync(p)
        return st.isSymbolicLink() ? ({ kind: 'link', target: readlinkSync(p) } as const) : ({ kind: 'other' } as const)
      } catch {
        return { kind: 'missing' } as const
      }
    }
    const fixtures: { name: string; make: () => void }[] = [
      { name: 'nothing there', make: () => {} },
      { name: 'already linked here', make: () => symlinkSync(shim, link) },
      { name: 'a link to another Stoke', make: () => symlinkSync('/Applications/Old Stoke.app/Contents/Resources/bin/stoke', link) },
      { name: 'somebody else\u2019s file', make: () => writeFileSync(link, '#!/bin/sh\necho mine\n', { mode: 0o755 }) },
      { name: 'a link to somebody else\u2019s tool', make: () => symlinkSync('/usr/bin/true', link) }
    ]
    for (const f of fixtures) {
      reset()
      f.make()
      const before = entryAt(link)
      const verdict = classifyMacLink(before, shim)
      const res = run(shim, ['install-cli'], { PATH: `${shims}:/usr/bin:/bin` })
      const after = entryAt(link)
      if (verdict === 'foreign') {
        check(`${f.name}: classified foreign, and the shim refuses`, res.status, 1)
        check(`${f.name}: and leaves it exactly as it was`, after, before)
      } else {
        check(`${f.name}: classified ${verdict}, and the shim succeeds`, res.status, 0)
        check(`${f.name}: and the link now points at this bundle`, classifyMacLink(after, shim), 'installed')
      }
      check(`${f.name}: the file beside it survives (gotcha 74)`, readFileSync(bystander, 'utf8'), 'untouched\n')
    }
    reset()
    const notOnPath = run(shim, ['install-cli'], { PATH: `${shims}:/usr/bin:/bin` }).stdout
    ok('off PATH, it prints the line to add', notOnPath.includes(PATH_EXPORT_LINE), notOnPath)
    const onPath = run(shim, ['install-cli'], { PATH: `${shims}:${bin}:/usr/bin:/bin` }).stdout
    ok('on PATH, it does not', !onPath.includes(PATH_EXPORT_LINE), onPath)

    // Run through the link, as a user would: $0 is the link, not the file.
    const throughLink = spawnSync(link, ['--cli', 'codex'], {
      encoding: 'utf8',
      cwd: where,
      env: { PATH: `${shims}:/usr/bin:/bin`, HOME: home, PWD: where, STOKE_OPEN: recorder }
    })
    ok('invoked through ~/.local/bin/stoke it still finds its own bundle', throughLink.stdout.includes(`\n${app}\n`), throughLink.stdout + throughLink.stderr)

    check('uninstall-cli removes a Stoke link', [run(shim, ['uninstall-cli']).status, entryAt(link).kind], [0, 'missing'])
    check('uninstall-cli with nothing there is fine', run(shim, ['uninstall-cli']).status, 0)
    writeFileSync(link, 'mine\n')
    check('uninstall-cli refuses a file that is not Stoke\u2019s', [run(shim, ['uninstall-cli']).status, readFileSync(link, 'utf8')], [1, 'mine\n'])
    check('and the bystander survives that too', readFileSync(bystander, 'utf8'), 'untouched\n')

    // A bundle macOS translocated: the shim and macBundleProblem make the same call.
    const moved = join(tmp, 'AppTranslocation', 'ABC', 'd', 'Stoke.app')
    mkdirSync(join(moved, 'Contents', 'Resources', 'bin'), { recursive: true })
    copyFileSync(SHIM, join(moved, 'Contents', 'Resources', 'bin', 'stoke'))
    copyFileSync(join(app, 'Contents', 'Info.plist'), join(moved, 'Contents', 'Info.plist'))
    reset()
    const translocated = run(join(moved, 'Contents', 'Resources', 'bin', 'stoke'), ['install-cli'])
    check('a translocated bundle is refused by the shim', translocated.status, 1)
    ok('as macBundleProblem refuses it', macBundleProblem(moved) !== null)
    check('and nothing was linked', entryAt(link).kind, 'missing')

    const linux = run(shim, ['.'], { PATH: `${linuxShims}:/usr/bin:/bin`, STOKE_OPEN: recorder })
    ok('off macOS it says where the real command is, and launches nothing', linux.status === 1 && !linux.stdout.includes('--stoke-cli'), linux.stderr)
    check('but --help still answers there', run(shim, ['--help'], { PATH: `${linuxShims}:/usr/bin:/bin` }).stdout, stokeHelp('darwin'))
    const outside = join(tmp, 'loose-stoke')
    copyFileSync(SHIM, outside)
    check('a copy outside any bundle refuses to launch', run(outside, ['.'], { STOKE_OPEN: recorder }).status, 1)

    // --- the Settings row's main-process half, against the same fixtures ---
    const envFor = (over: Partial<CommandEnv> = {}): CommandEnv => ({
      platform: 'darwin',
      home,
      resourcesPath: res,
      packaged: true,
      loginPath: async () => `/usr/bin:${bin}:/bin`,
      ...over
    })
    reset()
    let st = await readCommandState(envFor())
    check('main: nothing there offers Install', [st.status, st.canInstall, st.canRemove, st.unavailable], ['missing', true, false, null])
    st = await installCommand(envFor())
    check('main: Install links it to this bundle', [st.status, st.error, readlinkSync(link)], ['installed', null, shim])
    check('main: and reads the login PATH to say a terminal will find it', [st.onPath, st.pathLine], [true, null])
    // The same bundle reached through a symlinked folder. The shim links to its
    // PHYSICAL path (`pwd -P`), so main has to compare physical paths too, or
    // each side reads the other's link as "a different Stoke" to repair.
    const alias = join(tmp, 'apps-alias')
    symlinkSync(join(tmp, 'Applications'), alias)
    st = await readCommandState(envFor({ resourcesPath: join(alias, 'Stoke.app', 'Contents', 'Resources') }))
    check('main: a bundle reached through a symlinked folder still reads as installed', st.status, 'installed')
    st = await readCommandState(envFor({ loginPath: async () => '/usr/bin:/bin' }))
    check('main: off the login PATH it gives the line to add', [st.onPath, st.pathLine], [false, PATH_EXPORT_LINE])
    st = await readCommandState(envFor({ loginPath: async () => null }))
    check('main: an unreadable login PATH is unknown, not "off"', st.onPath, null)
    rmSync(link)
    symlinkSync('/Applications/Old Stoke.app/Contents/Resources/bin/stoke', link)
    st = await installCommand(envFor())
    check('main: Repair re-points a link to another Stoke', [st.status, readlinkSync(link)], ['installed', shim])
    st = await removeCommand(envFor())
    check('main: Remove takes it away', [st.status, entryAt(link).kind], ['missing', 'missing'])
    writeFileSync(link, 'mine\n')
    st = await installCommand(envFor())
    check('main: Install refuses a file that is not Stoke\u2019s, and says so', [st.status, st.error !== null, readFileSync(link, 'utf8')], ['foreign', true, 'mine\n'])
    st = await removeCommand(envFor())
    check('main: so does Remove', [st.error !== null, readFileSync(link, 'utf8')], [true, 'mine\n'])
    check('main: and the bystander survived all of it', readFileSync(bystander, 'utf8'), 'untouched\n')
    st = await readCommandState(envFor({ packaged: false }))
    ok('main: a development run explains itself instead of offering buttons', st.unavailable !== null && !st.canInstall)
    st = await readCommandState(envFor({ resourcesPath: join(moved, 'Contents', 'Resources') }))
    ok('main: a translocated bundle is unavailable, as the shim says', st.unavailable !== null && /Translocation/.test(st.unavailable))

    rmSync(link)
    writeFileSync(link, `#!/bin/sh\n${LINUX_WRAPPER_MARK} Written by the installer.\n`)
    st = await readCommandState(envFor({ platform: 'linux' }))
    check('main, Linux: the installer launcher reads as installed, with no buttons', [st.status, st.canInstall, st.canRemove], ['installed', false, false])
    st = await installCommand(envFor({ platform: 'linux' }))
    ok('main, Linux: Install writes nothing and points at the installer', st.error !== null && readFileSync(link, 'utf8').includes(LINUX_WRAPPER_MARK))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// The tally is the last statement in the file (gotchas 50, 62).
console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
