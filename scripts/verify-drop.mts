/*
 * What a dropped file types at the prompt.
 *
 * The whole risk in this feature is quoting, and it is a risk precisely because
 * the common case hides it: every path anyone tests with by hand looks fine
 * unquoted. It is the screenshot on a Mac — `Screenshot 2026-09-02 at 6.11.05 pm.png`
 * — that splits into six arguments at a shell prompt, and that is the single
 * most likely file anyone will ever drop on this terminal.
 *
 *   node scripts/verify-drop.mts
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dropText, escapePath, imagePasteKeys, isInsertable, quotePath } from '../src/shared/drop.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

console.log('\nquoting, POSIX')
check('an ordinary path is left bare', quotePath('/Users/me/notes.md', 'darwin'), '/Users/me/notes.md')
check(
  'the screenshot case — a space means quotes, or it is six arguments',
  quotePath('/Users/me/Screenshot 2026-09-02 at 6.11.05 pm.png', 'darwin'),
  "'/Users/me/Screenshot 2026-09-02 at 6.11.05 pm.png'"
)
check(
  "an apostrophe closes and reopens, which is the only way out of single quotes",
  quotePath("/tmp/it's here.txt", 'darwin'),
  "'/tmp/it'\\''s here.txt'"
)
check(
  'a dollar sign is inert inside single quotes and must not be expanded',
  quotePath('/tmp/$HOME trick.txt', 'darwin'),
  "'/tmp/$HOME trick.txt'"
)
check(
  'so is a backtick, which double quotes would have run',
  quotePath('/tmp/`whoami`.txt', 'darwin'),
  "'/tmp/`whoami`.txt'"
)
check(
  'and a backslash, which double quotes would have eaten',
  quotePath('/tmp/back\\slash.txt', 'darwin'),
  "'/tmp/back\\slash.txt'"
)
check('linux takes the same branch as darwin', quotePath('/a b', 'linux'), "'/a b'")

console.log('\nquoting, Windows')
check(
  'a bare Windows path keeps its separators and is not quoted',
  quotePath('C:\\Users\\me\\notes.md', 'win32'),
  'C:\\Users\\me\\notes.md'
)
check(
  'a space gets double quotes — single quotes are literal to cmd.exe',
  quotePath('C:\\Users\\me\\my notes.md', 'win32'),
  '"C:\\Users\\me\\my notes.md"'
)
check(
  'the POSIX escape must NOT be applied on win32, where a backslash is a separator',
  quotePath("C:\\a b\\c.txt", 'win32'),
  '"C:\\a b\\c.txt"'
)

console.log('\nwhat can be typed at all')
check('an ordinary name can', isInsertable('/tmp/a.txt'), true)
check('an empty string cannot', isInsertable(''), false)
/*
 * The one that matters. `Terminal.paste()` rewrites every newline to a bare
 * `\r` (Clipboard.ts:14,21-26), which is Enter — so a file named with one
 * would not insert a path, it would SUBMIT whatever the user had half-written.
 * Refused rather than stripped, and asserted here because the failure is
 * silent, destructive and impossible to notice in manual testing.
 */
check('a newline in the name cannot, because pasting it would press Enter', isInsertable('/tmp/a\nb'), false)
check('nor a carriage return, for the same reason', isInsertable('/tmp/a\rb'), false)

console.log('\na whole drop')
check('one file, with the trailing space that lets you keep typing', dropText(['/a/b.png'], 'darwin'), '/a/b.png ')
/*
 * Several files: the backslash form, never single quotes. This case used to
 * assert `/a/b.png '/c/d e.png' `, which is the bug: Claude Code splits a paste
 * only at a space followed by `/` (or a drive letter), so a quoted second path
 * fused onto the first and no image attached. Its reader is transcribed below
 * and run over what dropText types.
 */
check(
  'several files are space separated, each escaped on its own merits',
  dropText(['/a/b.png', '/c/d e.png'], 'darwin'),
  String.raw`/a/b.png /c/d\ e.png `
)
check(
  'two macOS screenshots, the case that never attached',
  dropText(['/a/Screenshot 1.png', '/a/Screenshot 2.png'], 'darwin'),
  String.raw`/a/Screenshot\ 1.png /a/Screenshot\ 2.png `
)
check('one path keeps its single quotes', dropText(['/c/d e.png'], 'linux'), "'/c/d e.png' ")
check(
  'Windows keeps double quotes for several too — its backslash is a separator',
  dropText([String.raw`C:\a b.png`, String.raw`C:\c.png`], 'win32'),
  String.raw`"C:\a b.png" C:\c.png `
)
check('nothing droppable produces nothing, not a bare space', dropText(['/tmp/a\nb'], 'darwin'), '')
check('an empty drop produces nothing', dropText([], 'darwin'), '')
check(
  'one bad name does not take the good ones with it',
  dropText(['/tmp/a\nb', '/good.png'], 'darwin'),
  '/good.png '
)
check(
  'and one bad name of three still leaves several, in the several form',
  dropText(['/tmp/a\nb', '/x y.png', '/z.png'], 'darwin'),
  String.raw`/x\ y.png /z.png `
)

console.log('\nthe backslash form, read back the way each reader reads it')
/*
 * Claude Code's reader, transcribed from the installed bundle (2.1.287): split
 * on a space before `/` or `X:\`, then on newlines; per piece trim, strip one
 * pair of matching quotes, and turn `\x` into `x` (a doubled backslash
 * survives as one).
 */
const claudePieces = (text: string): string[] =>
  text
    .split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap((z) => z.split('\n'))
    .filter((z) => z.trim())
    .map((z) => {
      const t = z.trim()
      const q = (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t
      return q.replaceAll('\\\\', '\u0000').replace(/\\(.)/g, '$1').replaceAll('\u0000', '\\')
    })
const awkward = [
  '/Users/me/Screenshot 2026-09-02 at 6.11.05\u202fPM.png',
  "/tmp/it's here.png",
  '/tmp/$HOME `x` (1) & [2] ; | > *.png',
  String.raw`/tmp/back\slash.png`,
  '/tmp/émoji 🎉.png'
]
check('Claude reads every path of a multi-file drop back exactly', claudePieces(dropText(awkward, 'darwin')), awkward)
check(
  'the old single-quoted form reaches it as ONE piece',
  claudePieces(`${awkward.slice(0, 2).map((p) => quotePath(p, 'darwin')).join(' ')} `).length,
  1
)
check('escapePath leaves a bare path bare', escapePath('/a/b-c_d.png'), '/a/b-c_d.png')
check('escapePath leaves non-ASCII alone', escapePath('/a/é\u202f.png'), '/a/é\u202f.png')
// A real POSIX shell reads the same text back to the same strings.
if (process.platform === 'win32' || !existsSync('/bin/sh')) console.log('  SKIP  no /bin/sh here')
else {
  for (const sh of ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh']) {
    if (!existsSync(sh)) continue
    // zsh does not split an unquoted expansion; eval reads the text as typed in every one.
    const script = `eval "set -- $1"; for a in "$@"; do printf '%s\\0' "$a"; done`
    const out = execFileSync(sh, ['-c', script, 'sh', dropText(awkward, 'linux')], { encoding: 'utf8' })
    check(`${sh} reads each path back as one argument`, out.split('\0').slice(0, -1), awkward)
  }
}

console.log('\nan image-only clipboard, on a local tab')
check('macOS: Ctrl+V, which Claude Code reads the clipboard on', imagePasteKeys('darwin', 'claude', false), '\x16')
check('Linux: the same', imagePasteKeys('linux', 'claude', false), '\x16')
check('Windows: Alt+V (ESC v), Claude Code’s chord there', imagePasteKeys('win32', 'claude', false), '\x1bv')
check('Windows, another agent: its terminal Ctrl+V, unchanged', imagePasteKeys('win32', 'codex', false), '\x16')
check('Windows, an SSH tab: Ctrl+V for the far side, unchanged', imagePasteKeys('win32', 'claude', true), '\x16')

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
