/**
 * What a file dropped on a terminal becomes at the prompt.
 *
 * Dropping a file into a terminal is expected to insert its path — Terminal.app
 * and iTerm2 both do it, and for Stoke it is the shortest route to handing
 * Claude Code a screenshot: drop it, and the path is typed for you.
 *
 * The quoting is the whole job, and it has two audiences rather than one. A
 * local tab spawns `claude` directly (`cli.ts` builds its argv), so the text
 * lands in the CLI's own prompt box, where it is read as prose. An SSH tab can
 * be sitting at a real shell (gotcha 10), where the same text is parsed. A form
 * that survives both is therefore the requirement, not a shell nicety — an
 * unquoted `/Users/me/Screenshot 2026.png` is one argument in prose and two at
 * a shell prompt.
 *
 * Pure, and the platform is passed in rather than read off `process`, for the
 * same reason `paths.ts` does it: `scripts/verify-drop.mts` runs the rule for
 * every platform under `node --experimental-strip-types`, and `tsconfig.web.json`
 * gives `src/shared` no Node types to read it with anyway.
 */

/**
 * Characters that need no quoting anywhere: a POSIX shell, `cmd.exe` and a
 * plain text prompt all read these literally. Deliberately conservative —
 * quoting a path that did not need it costs two characters, and failing to
 * quote one that did splits it in half.
 */
const POSIX_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/
/** As above, plus the separator Windows actually uses. */
const WINDOWS_BARE = /^[A-Za-z0-9_@%+=:,.\\/-]+$/

/**
 * One path, ready to be typed.
 *
 * POSIX gets single quotes, because inside them every character except `'` is
 * literal — including the backslashes, spaces, `$` and backticks that a
 * double-quoted form would still interpret. The one exception is escaped the
 * only way it can be: end the quoting, emit an escaped quote, start again.
 *
 * Windows gets double quotes and no escaping, because `"` is not a legal
 * character in a Windows path — there is nothing to escape, and `^` and `&`
 * are inert inside quotes.
 */
export function quotePath(path: string, platform: string): string {
  if (platform === 'win32') return WINDOWS_BARE.test(path) ? path : `"${path}"`
  return POSIX_BARE.test(path) ? path : `'${path.split("'").join("'\\''")}'`
}

/**
 * Whether a path can be typed at all.
 *
 * A newline cannot, and quoting does not save it: `Terminal.paste()` normalises
 * every `\n` and `\r\n` to a bare `\r` (`Clipboard.ts:14,21-26`), which is
 * Enter. So a filename containing one would not insert a path — it would submit
 * whatever the user had half-written to Claude, and quoting it makes that
 * *more* likely to look deliberate rather than less.
 *
 * POSIX permits such a name, so this is reachable rather than theoretical. It
 * is refused rather than mangled, because a silently altered path that then
 * fails to open is harder to understand than one that never appeared.
 */
export function isInsertable(path: string): boolean {
  return path.length > 0 && !/[\r\n]/.test(path)
}

/**
 * One POSIX path in the backslash form: every ASCII character outside
 * `POSIX_BARE` gets a `\` in front, and nothing else changes.
 *
 * The form for SEVERAL paths, because it is the one form both readers agree
 * on. A POSIX shell reads `\x` as a literal `x` outside quotes, so this is as
 * literal there as single quotes are. Claude Code reads a paste by splitting
 * it on a space that is followed by `/` or a drive letter
 * (`/ (?=\/|[A-Za-z]:\\)/`, read out of 2.1.287's bundle), then strips ONE
 * pair of matching quotes off each piece and turns `\x` back into `x`. So
 * `'/a/Shot 1.png' '/a/Shot 2.png'` — the old form — reached it as ONE piece
 * (no space there is followed by `/`), `/a/Shot 1.png' '/a/Shot 2.png`, which
 * is no file, and neither image attached. Escaped, the only splitting spaces
 * are the ones between paths.
 *
 * Non-ASCII is left alone: no shell splits on it, Claude's splitter looks only
 * for an ASCII space, and macOS puts a U+202F before "PM" in every screenshot
 * name, which a backslash would only make harder to read.
 */
export function escapePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_@%+=:,./\-\u0080-￿]/g, (c) => `\\${c}`)
}

/**
 * A whole drop, ready to be pasted. Empty when nothing in it can be typed,
 * which the caller reads as "do nothing" rather than "paste nothing".
 *
 * The trailing space is deliberate and is what every terminal does: a drop is
 * almost always followed by more typing, and it also keeps a second drop from
 * fusing onto the first path.
 *
 * One path keeps its single quotes (`quotePath`); several POSIX paths use the
 * backslash form (`escapePath`), which is what lets Claude Code attach every
 * image in a multi-file drop whose names have spaces. Windows keeps its double
 * quotes either way: a backslash is its separator, not an escape.
 */
export function dropText(paths: string[], platform: string): string {
  const usable = paths.filter(isInsertable)
  if (!usable.length) return ''
  if (usable.length > 1 && platform !== 'win32') return `${usable.map(escapePath).join(' ')} `
  return `${usable.map((p) => quotePath(p, platform)).join(' ')} `
}

/**
 * What to send a local tab's agent when the clipboard holds only an image, so
 * it reads the image off the clipboard itself (no bytes cross the pty).
 *
 * Claude Code binds its image paste (`chat:imagePaste`) to Ctrl+V on macOS and
 * Linux and to Alt+V on Windows (read out of 2.1.287's bundle: `alt+v` when
 * the platform is Windows or WSL). `\x16` is Ctrl+V; Alt+V reaches a terminal
 * app as ESC v. So on Windows the `\x16` Stoke sent did nothing for Claude.
 * Every other agent keeps `\x16`, the terminal's own Ctrl+V. An SSH tab never
 * comes here when uploads are on — its image is sent to the machine instead.
 */
export function imagePasteKeys(platform: string, cliId: string, remote: boolean): string {
  return platform === 'win32' && cliId === 'claude' && !remote ? '\x1bv' : '\x16'
}
