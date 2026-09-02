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
import { dropText, isInsertable, quotePath } from '../src/shared/drop.ts'

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
check(
  'several files are space separated, each quoted on its own merits',
  dropText(['/a/b.png', '/c/d e.png'], 'darwin'),
  "/a/b.png '/c/d e.png' "
)
check('nothing droppable produces nothing, not a bare space', dropText(['/tmp/a\nb'], 'darwin'), '')
check('an empty drop produces nothing', dropText([], 'darwin'), '')
check(
  'one bad name does not take the good ones with it',
  dropText(['/tmp/a\nb', '/good.png'], 'darwin'),
  '/good.png '
)

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
