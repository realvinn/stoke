/*
 * `stoke …` typed in a terminal, turned into one request the running app can
 * act on — or into nothing at all.
 *
 * The `stoke` command is a shell shim shipped inside the app bundle
 * (`build/bin/stoke`, `build/bin/stoke.cmd`). It answers `--help`, `--version`
 * and the link commands itself, and for everything else launches the app with
 *
 *     --stoke-cli --stoke-cwd=<the shell's cwd> -- <what the user typed>
 *
 * which is the only shape this module ever turns into a request.
 *
 * **The marker is the whole security model of this file.** The app is also
 * started by Finder, the Dock, a login item, electron-updater's relaunch,
 * `npx electron .`, and every test in this repo — and every one of those argvs
 * carries something: `-psn_0_…`, `--user-data-dir=…`,
 * `--remote-debugging-port=…`, `--original-process-start-time=…`, the app path
 * itself. None of them may ever be read as "open this folder". So an argv with
 * no `--stoke-cli` is `null`, full stop, and nothing before the marker is ever
 * looked at.
 *
 * **The `--` after the marker is Chromium's, not the user's.** Chromium parses
 * the same argv as a command line, and without a terminator everything the user
 * typed that looks like a switch — `stoke --remote-debugging-port=9222`, say —
 * would configure the browser rather than reach this parser. The shim therefore
 * always writes a `--` between its own two arguments and the user's, and the
 * first `--` after the marker is consumed here as that terminator. A `--` the
 * USER typed comes after it, and keeps its ordinary meaning of "no more
 * options" (`stoke -- -odd-folder-name`).
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27): the
 * home directory and the platform are passed in, and `scripts/
 * verify-stoke-args.mts` runs the whole grammar under node strip-types.
 * Whether a folder EXISTS is not a question this module can answer — main
 * asks the disk (`src/main/index.ts`, `checkLaunchRequest`), and turns a
 * missing one into the `error` request built by `folderProblem` below.
 */
import { CODING_CLIS, DEFAULT_CLI, isCodingCliId, type CodingCliId } from './codingClis.ts'

/** The argument that makes an argv a request. Nothing without it ever is. */
export const STOKE_CLI_MARKER = '--stoke-cli'
/** The shell's cwd, which relative paths resolve against. `open -a` starts apps in `/`. */
export const STOKE_CWD_PREFIX = '--stoke-cwd='

/** What `stoke` asked for, once parsed. Crosses a process boundary, so plain data only. */
export type StokeCliRequest =
  /** `stoke` on its own: bring the window forward (or start the app). */
  | { kind: 'focus' }
  /**
   * A session in `cwd`. `reuse` focuses a RUNNING tab for the same folder and
   * CLI when there is one; `new` always opens another; `continue` is Claude
   * Code's `--continue`, which also reuses a running tab rather than putting a
   * second `claude` on the same transcript.
   */
  | { kind: 'session'; cwd: string; cli: CodingCliId; launch: 'reuse' | 'new' | 'continue' }
  /** Add the folder to the sidebar and select it in a New tab. Starts nothing. */
  | { kind: 'open'; cwd: string }
  /** Settings → Updates, and a check. Never installs and never quits. */
  | { kind: 'update' }
  /** Something the user should be told, in the app's own error banner. */
  | { kind: 'error'; message: string }

export interface ArgContext {
  /** The user's home directory, for `~`. */
  home: string
  /** `process.platform` of the machine that will open the folder. */
  platform: string
}

/** The longest path this will accept. Anything longer is not a folder anyone typed. */
const MAX_PATH_CHARS = 4096

/**
 * A user-supplied string made safe to put in a sentence: control characters
 * become `?` and the length is capped. The banner renders text, not HTML, so
 * this is about legibility — a pasted escape sequence or a 10 KB argument must
 * not turn the error into something nobody can read.
 */
export function shown(s: string, max = 120): string {
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

const HELP_HINT = 'Run `stoke --help` for what it understands.'

function fail(message: string): StokeCliRequest {
  return { kind: 'error', message }
}

/* ---------------------------------------------------------------- paths */

type Resolved = { path: string } | { error: string }

/** Collapse `.`, `..` and empty segments. `..` never climbs above the root. */
function collapse(segments: string[]): string[] {
  const out: string[] = []
  for (const s of segments) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return out
}

function isPosixAbsolute(p: string): boolean {
  return p.startsWith('/')
}

/** `C:\…`, or a UNC share `\\server\share\…`. Separators already backslashes. */
function winRoot(p: string): { root: string; rest: string } | null {
  const drive = /^([A-Za-z]):\\(.*)$/s.exec(p)
  if (drive) return { root: `${drive[1].toUpperCase()}:`, rest: drive[2] }
  if (/^[A-Za-z]:$/.test(p)) return { root: `${p[0].toUpperCase()}:`, rest: '' }
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/s.exec(p)
  if (unc) return { root: `\\\\${unc[1]}\\${unc[2]}`, rest: unc[3] ?? '' }
  return null
}

function joinWin(root: string, segments: string[]): string {
  const tail = collapse(segments).join('\\')
  // A drive root keeps its separator (`C:\`); a share root is already a folder.
  if (/^[A-Z]:$/.test(root)) return `${root}\\${tail}`
  return tail ? `${root}\\${tail}` : root
}

/**
 * An absolute, normalised folder path for `input`, resolved against `cwd`.
 *
 * `~` and `~/…` are the user's home; `~name` is left as a literal folder name,
 * because the shell has already expanded every `~` it could and a `~name` that
 * survived to here is either a real folder or a user this module cannot look
 * up. Windows paths take either separator and come back with backslashes.
 */
export function resolveFolder(input: string, cwd: string | null, ctx: ArgContext): Resolved {
  if (input.includes('\u0000')) return { error: 'A folder path cannot contain a NUL byte.' }
  if (input.length > MAX_PATH_CHARS) return { error: `That path is over ${MAX_PATH_CHARS} characters.` }
  if (input === '') return { error: 'An empty folder path is not a folder.' }

  if (ctx.platform === 'win32') {
    let p = input.replace(/\//g, '\\')
    if (p === '~' || p.startsWith('~\\')) p = ctx.home.replace(/\//g, '\\') + p.slice(1)
    // `\\?\` and `\\.\` are device namespaces, not folders anyone opens a
    // session in, and the UNC pattern below would misread `?` as a server.
    if (/^\\\\[?.]\\/.test(p)) {
      return { error: `${shown(input)} is a Windows device path, not a folder Stoke can open.` }
    }
    // `C:foo` is relative to drive C's OWN current folder, which every process
    // tracks separately and Stoke cannot know. Guessing would open the wrong place.
    if (/^[A-Za-z]:(?!\\)./s.test(p)) {
      return { error: `${shown(input)} is relative to that drive's own current folder. Give a full path, like ${p[0]}:\\${p.slice(2)}.` }
    }
    const abs = winRoot(p)
    if (abs) return { path: joinWin(abs.root, abs.rest.split('\\')) }
    const base = cwd ? winRoot(cwd.replace(/\//g, '\\')) : null
    if (!base) return { error: `${shown(input)} is relative, and no working folder came with it. Give a full path.` }
    // `\foo` is the root of the cwd's own drive or share.
    if (p.startsWith('\\')) return { path: joinWin(base.root, p.split('\\')) }
    return { path: joinWin(base.root, [...base.rest.split('\\'), ...p.split('\\')]) }
  }

  let p = input
  if (p === '~' || p.startsWith('~/')) p = ctx.home + p.slice(1)
  if (isPosixAbsolute(p)) return { path: '/' + collapse(p.split('/')).join('/') }
  if (!cwd || !isPosixAbsolute(cwd)) {
    return { error: `${shown(input)} is relative, and no working folder came with it. Give a full path.` }
  }
  return { path: '/' + collapse([...cwd.split('/'), ...p.split('/')]).join('/') }
}

/** Whether `--stoke-cwd`'s value is an absolute path on this platform, and so usable at all. */
function usableCwd(cwd: string, platform: string): boolean {
  if (!cwd || cwd.includes('\u0000') || cwd.length > MAX_PATH_CHARS) return false
  return platform === 'win32' ? winRoot(cwd.replace(/\//g, '\\')) !== null : isPosixAbsolute(cwd)
}

/* -------------------------------------------------------------- grammar */

/** The first positional word that is a command rather than a folder. */
const COMMANDS = new Set(['update', 'install-cli', 'uninstall-cli'])

/**
 * Parse a launch argv — `process.argv`, or the argv a second instance
 * forwarded — into a request, or `null` when it carries no marker.
 *
 * Never throws. A malformed request is an `error` request, which the app shows
 * rather than acting on; only a missing marker is silence.
 */
export function parseStokeArgs(argv: readonly string[], ctx: ArgContext): StokeCliRequest | null {
  const at = argv.indexOf(STOKE_CLI_MARKER)
  if (at === -1) return null

  // Everything after the marker, split at the transport's own terminator.
  const after = argv.slice(at + 1)
  const sep = after.indexOf('--')
  const envelope = sep === -1 ? after : after.slice(0, sep)
  const typed = sep === -1 ? after.filter((t) => !t.startsWith(STOKE_CWD_PREFIX)) : after.slice(sep + 1)

  const cwdArg = envelope.find((t) => t.startsWith(STOKE_CWD_PREFIX))
  const rawCwd = cwdArg === undefined ? null : cwdArg.slice(STOKE_CWD_PREFIX.length)
  const cwd = rawCwd !== null && usableCwd(rawCwd, ctx.platform) ? rawCwd : null

  // A command is a first word, typed before any option or `--`.
  if (typed.length && COMMANDS.has(typed[0])) {
    const word = typed[0]
    if (typed.length > 1) return fail(`\`stoke ${word}\` takes nothing after it. ${HELP_HINT}`)
    if (word === 'update') return { kind: 'update' }
    return fail(
      `\`stoke ${word}\` is handled by the stoke command in a terminal on macOS. ` +
        'Here, Settings → Updates → Command line does the same.'
    )
  }

  let cli: CodingCliId | null = null
  let fresh = false
  let cont = false
  let open = false
  let info = false
  let optionsOver = false
  const positional: string[] = []

  for (let i = 0; i < typed.length; i++) {
    const t = typed[i]
    if (optionsOver) {
      positional.push(t)
      continue
    }
    if (t === '--') {
      optionsOver = true
      continue
    }
    if (t === '--cli' || t.startsWith('--cli=')) {
      const value = t === '--cli' ? typed[++i] : t.slice('--cli='.length)
      if (value === undefined || value === '') {
        return fail(`--cli needs the name of a CLI: ${CODING_CLIS.map((c) => c.id).join(', ')}.`)
      }
      if (!isCodingCliId(value)) {
        return fail(
          `Stoke does not know a CLI called "${shown(value, 40)}". It knows ${CODING_CLIS.map((c) => c.id).join(', ')}.`
        )
      }
      if (cli !== null && cli !== value) return fail('--cli was given twice, with two different CLIs.')
      cli = value
      continue
    }
    if (t === '--new') {
      fresh = true
      continue
    }
    if (t === '--continue') {
      cont = true
      continue
    }
    if (t === '--open') {
      open = true
      continue
    }
    if (t === '--help' || t === '-h' || t === '--version' || t === '-v') {
      info = true
      continue
    }
    if (t.startsWith('-')) {
      return fail(
        `Unknown option ${shown(t, 60)}. A folder whose name starts with - is \`stoke ./${shown(t, 40)}\` or \`stoke -- ${shown(t, 40)}\`. ${HELP_HINT}`
      )
    }
    positional.push(t)
  }

  // The shim answers these without starting the app. One that got here anyway
  // (a hand-typed launch, an older shim) means "show me Stoke", not an error.
  if (info) return { kind: 'focus' }

  if (positional.length > 1) {
    return fail(
      `stoke opens one folder at a time, and was given ${positional.length}: ${positional
        .slice(0, 3)
        .map((p) => shown(p, 40))
        .join(', ')}${positional.length > 3 ? ', …' : ''}.`
    )
  }
  if (open && (cli !== null || fresh || cont)) {
    return fail('--open only adds the folder to the sidebar, so it takes no --cli, --new or --continue.')
  }
  if (fresh && cont) {
    return fail('--new and --continue disagree: --continue picks up the last conversation, --new starts another.')
  }
  if (cont && cli !== null && cli !== 'claude') {
    return fail(`--continue is Claude Code's. ${shown(cli)} has no conversation for Stoke to continue.`)
  }

  if (positional.length === 0 && cli === null && !fresh && !cont && !open) return { kind: 'focus' }

  const folder = resolveFolder(positional[0] ?? '.', cwd, ctx)
  if ('error' in folder) return fail(folder.error)
  if (open) return { kind: 'open', cwd: folder.path }
  return {
    kind: 'session',
    cwd: folder.path,
    cli: cli ?? DEFAULT_CLI,
    launch: fresh ? 'new' : cont ? 'continue' : 'reuse'
  }
}

/**
 * A request that arrived from ANOTHER process — the second instance's
 * `additionalData` — checked field by field before anything acts on it.
 *
 * That process may be a different build of Stoke, or not Stoke at all: the
 * single-instance lock is a named pipe any local process can write to. So
 * this rebuilds the request from named keys (the clamp rule CLAUDE.md states
 * for settings) and returns null for anything it does not recognise — never a
 * partially trusted object.
 */
export function requestFrom(v: unknown, platform: string): StokeCliRequest | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  // A folder has to be absolute here: main resolves nothing against its own
  // cwd, which for an app started by `open` is `/`.
  const folder = (x: unknown): x is string => typeof x === 'string' && usableCwd(x, platform)
  switch (r.kind) {
    case 'focus':
      return { kind: 'focus' }
    case 'update':
      return { kind: 'update' }
    case 'error':
      return typeof r.message === 'string' ? { kind: 'error', message: shown(r.message, 400) } : null
    case 'open':
      return folder(r.cwd) ? { kind: 'open', cwd: r.cwd } : null
    case 'session': {
      if (!folder(r.cwd)) return null
      if (!isCodingCliId(r.cli)) return null
      if (r.launch !== 'reuse' && r.launch !== 'new' && r.launch !== 'continue') return null
      if (r.launch === 'continue' && r.cli !== 'claude') return null
      return { kind: 'session', cwd: r.cwd, cli: r.cli, launch: r.launch }
    }
    default:
      return null
  }
}

/** Whether a checked request names a folder main must look at before acting. */
export function folderOf(req: StokeCliRequest): string | null {
  return req.kind === 'session' || req.kind === 'open' ? req.cwd : null
}

/** Why a folder a request named cannot be used, as the sentence the banner shows. */
export type FolderProblem = 'missing' | 'not-a-folder' | 'unreachable' | 'denied'

export function folderProblem(path: string, problem: FolderProblem): StokeCliRequest {
  const p = shown(path, 200)
  switch (problem) {
    case 'missing':
      return fail(`stoke: there is no folder at ${p}.`)
    case 'not-a-folder':
      return fail(`stoke: ${p} is a file, not a folder. Sessions open in folders.`)
    case 'denied':
      return fail(`stoke: Stoke is not allowed to read ${p}.`)
    case 'unreachable':
      return fail(`stoke: ${p} did not answer in time — a sleeping or disconnected disk, most likely. Try again.`)
  }
}

/* ------------------------------------------------------------------ help */

/**
 * What `stoke --help` prints, per platform.
 *
 * One text, three copies — `build/bin/stoke`, `build/bin/stoke.cmd` and the
 * Linux launcher `install/install.sh` writes — because each of those is a
 * script that cannot import this file. `verify:stoke-args` runs the two POSIX
 * ones and reads the .cmd's echo lines, and fails when any of them has drifted
 * from this.
 *
 * Written for the strictest of the three: no `<`, `>`, `|`, `&`, `^`, `%`, `!`
 * or `"` (cmd.exe's echo reads every one of them), no `$` or backtick (the
 * Linux launcher is emitted through an unquoted heredoc), and plain ASCII (a
 * Windows console is often cp437). Blank lines are fine: the .cmd writes each
 * line as `echo(…`, which prints an empty one rather than "ECHO is off.".
 */
export function stokeHelp(platform: string): string {
  const win = platform === 'win32'
  const lines = [
    'Usage: stoke [options] [DIR]',
    '',
    '  stoke                   bring Stoke forward, or start it',
    '  stoke DIR               a session in DIR (stoke . for here), or the tab already running there',
    '  stoke --new [DIR]       a new tab even when one is already running there',
    '  stoke --cli ID [DIR]    a session with another coding CLI: ' + CODING_CLIS.map((c) => c.id).join(', '),
    '  stoke --continue [DIR]  pick up the last Claude Code conversation in DIR',
    '  stoke --open [DIR]      add DIR to the sidebar and select it; starts nothing',
    '  stoke update            open Settings, Updates and check for a new Stoke; installs nothing',
    '  stoke --version         the installed version',
    '  stoke --help            this'
  ]
  if (platform === 'darwin') {
    lines.push(
      '',
      '  stoke install-cli       link this command into ~/.local/bin',
      '  stoke uninstall-cli     remove that link'
    )
  }
  lines.push(
    '',
    'DIR defaults to the current folder when an option is given.',
    'A folder named update, or starting with -, is stoke ./update or stoke -- -name.'
  )
  if (win) lines.push('Settings, Updates, Command line in Stoke puts this command on PATH.')
  return lines.join('\n') + '\n'
}
