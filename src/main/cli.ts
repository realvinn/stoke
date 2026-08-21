import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { CliInfo, LaunchOptions } from '@shared/types'

const execFileAsync = promisify(execFile)

const isWin = process.platform === 'win32'

/**
 * A GUI app launched from Finder or the Dock inherits a bare PATH — not the one
 * the user's shell builds. Claude Code is usually installed into ~/.local/bin or
 * a version manager's shim dir, so without this the app would only work when
 * launched from a terminal. Ask the login shell for its PATH once and cache it.
 */
/*
 * The *promise* is memoised, not the resolved string, and both halves of that
 * mattered.
 *
 * `cachedLoginPath` was assigned only after the await, so two callers entering
 * in the same tick both saw null and both spawned a full interactive login
 * shell. Boot does exactly that: `App.tsx:363` calls `cli.info()` and
 * `App.tsx:366` calls `updates.check()`, and both reach `buildEnvPath` through
 * `findClaude`. Measured with `SHELL` pointed at a logging wrapper — two
 * `-ilc` spawns in the same millisecond, every launch. Same shape as gotcha 20.
 *
 * Worse, a *failure* was cached as `null`, which is the value the guard reads
 * as "nothing cached yet" — so a probe that failed was retried by every later
 * caller, each paying the full 5s timeout again. That is not hypothetical on
 * this machine: `~/.zshrc` stats a path on an external USB disk, so when that
 * disk is asleep the probe is exactly the thing that gets slow (gotcha 40), and
 * it got slow once per PTY spawn rather than once per launch. Holding the
 * promise caches both outcomes.
 *
 * `-i` is load-bearing and must not be dropped to make this cheaper: measured
 * from a bare Finder-like environment, `-lc` alone returns a PATH with no mise
 * directory in it, and mise is where `claude` actually lives here.
 */
let loginPathProbe: Promise<string | null> | null = null

function loginShellPath(): Promise<string | null> {
  if (isWin) return Promise.resolve(null)
  loginPathProbe ??= (async () => {
    const shell = process.env.SHELL || '/bin/zsh'
    try {
      const { stdout } = await execFileAsync(shell, ['-ilc', 'printf %s "$PATH"'], {
        timeout: 5000,
        encoding: 'utf8'
      })
      return stdout.trim() || null
    } catch {
      return null
    }
  })()
  return loginPathProbe
}

/** PATH to hand to spawned processes: login-shell PATH unioned with our own. */
export async function buildEnvPath(): Promise<string> {
  const parts = new Set<string>()
  const login = await loginShellPath()
  if (login) for (const p of login.split(delimiter)) if (p) parts.add(p)
  for (const p of (process.env.PATH ?? '').split(delimiter)) if (p) parts.add(p)
  for (const p of extraSearchDirs()) parts.add(p)
  return [...parts].join(delimiter)
}

function extraSearchDirs(): string[] {
  const home = homedir()
  if (isWin) {
    return [
      join(home, '.local', 'bin'),
      join(home, '.claude', 'local'),
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'claude'),
      join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')
    ]
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin'
  ]
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** Executable name variants to try inside each search directory. */
function candidateNames(): string[] {
  return isWin ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude']
}

/** Find the claude executable, honouring an explicit user override first. */
export async function findClaude(override: string | null): Promise<string | null> {
  if (override && isFile(override)) return override

  const searchPath = await buildEnvPath()
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue
    for (const name of candidateNames()) {
      const full = join(dir, name)
      if (isFile(full)) return full
    }
  }
  return null
}

export async function probeClaude(override: string | null): Promise<CliInfo> {
  const found = await findClaude(override)
  if (!found) {
    return {
      path: '',
      version: null,
      ok: false,
      error:
        'Could not find the `claude` executable. Install Claude Code, or set an explicit path in Settings.'
    }
  }
  try {
    const spec = spawnSpec(found, ['--version'])
    const { stdout } = await execFileAsync(spec.file, spec.args, {
      timeout: 15000,
      encoding: 'utf8',
      env: { ...process.env, PATH: await buildEnvPath() }
    })
    return { path: found, version: stdout.trim() || null, ok: true, error: null }
  } catch (err) {
    return {
      path: found,
      version: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Windows cannot exec a .cmd/.bat shim directly — it has to go through cmd.exe.
 * Native .exe installs (and everything on macOS/Linux) are spawned as-is.
 */
export function spawnSpec(exe: string, args: string[]): { file: string; args: string[] } {
  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/c', exe, ...args] }
  }
  return { file: exe, args }
}

/**
 * Ultracode is a *settings key*, not a flag and not an effort level. `--effort`
 * accepts only low/medium/high/xhigh/max, and there is no `--ultracode`; the CLI
 * describes it as "set per session via the `ultracode` settings key (--settings
 * or apply_flag_settings)", meaning xhigh effort plus standing dynamic-workflow
 * orchestration. What it does *not* mean is that the key always wins — see the
 * measurements in buildArgs below.
 *
 * It goes in as a file path rather than an inline `--settings '{"ultracode":true}'`
 * for exactly the reason recorded next to --mcp-config in pty.ts: quoting JSON
 * through a shell differs per platform and fails silently when it goes wrong. A
 * .cmd install is spawned through `cmd.exe /c`, which eats the quotes and braces,
 * so the inline form loses on this machine before the CLI ever sees it.
 *
 * The contents never vary, so the file is written once per process and reused.
 */
const ULTRACODE_SETTINGS_JSON = '{\n  "ultracode": true\n}\n'

let ultracodeSettingsPath: string | null = null

/**
 * Path to the JSON handed to `--settings` when ultracode is on, writing it first
 * if needed. Re-checked on every call because a temp sweeper can delete it out
 * from under a long-running app, and a `--settings` pointing at nothing would
 * either abort the launch or quietly start a session without ultracode.
 */
export function ultracodeSettingsFile(): string {
  if (ultracodeSettingsPath && isFile(ultracodeSettingsPath)) return ultracodeSettingsPath

  const dir = join(tmpdir(), 'stoke')
  const file = join(dir, 'ultracode-settings.json')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, ULTRACODE_SETTINGS_JSON, 'utf8')
  } catch (err) {
    // Loud rather than silent: dropping the flag would start a perfectly normal
    // session that merely disagrees with what the launcher promised.
    throw new Error(
      `Could not write the ultracode settings file at ${file}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  ultracodeSettingsPath = file
  return file
}

/**
 * Translate Stoke's launch options into claude CLI arguments.
 *
 * Note `bypassPermissions` maps to `--dangerously-skip-permissions` rather than
 * `--permission-mode bypassPermissions`: the latter requires the mode to already
 * be enabled for the workspace, the former always works.
 *
 * @param settingsFile the one `--settings` file for this session, holding both
 *   the ultracode key and the statusLine wrapper. Null means the session needs
 *   none — but note the ultracode fallback below, which keeps a caller that
 *   passes nothing working exactly as it did.
 */
export function buildArgs(opts: LaunchOptions, settingsFile: string | null = null): string[] {
  const args: string[] = []

  if (opts.continueLast) {
    args.push('--continue')
  } else if (opts.resume && opts.sessionId) {
    args.push('--resume', opts.sessionId)
  } else if (opts.sessionId) {
    args.push('--session-id', opts.sessionId)
  }

  if (opts.forkSession && (opts.resume || opts.continueLast)) args.push('--fork-session')

  if (opts.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions')
  } else if (opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }

  if (opts.model) args.push('--model', opts.model)

  // Ultracode pins the effort flag rather than sending it alongside the user's
  // pick, because --effort *beats* the settings key and switching ultracode off
  // is how it loses. Measured against 2.1.221 by reading the transcripts of four
  // print-mode sessions:
  //
  //   --settings {ultracode:true}                  -> effort xhigh, ultra_effort_enter present
  //   --settings {ultracode:true} --effort xhigh   -> effort xhigh, ultra_effort_enter present
  //   --settings {ultracode:true} --effort high    -> effort high,  ultra_effort_enter GONE
  //
  // That third line is the trap: an ordinary high-effort session starts happily,
  // with no warning anywhere that the thing the user ticked did not happen.
  //
  // xhigh is sent explicitly rather than simply omitting --effort, because
  // omitting it falls back to whatever effort the machine defaults to, and on a
  // machine that defaults below xhigh that lands straight back on line three.
  //
  // --settings sits before extraArgs so a hand-written `--settings` there still
  // wins — a repeated option is last-wins.
  if (opts.ultracode) {
    args.push('--effort', 'xhigh')
  } else if (opts.effort && opts.effort !== 'default') {
    args.push('--effort', opts.effort)
  }

  // Exactly one --settings, ever. A second silently discards the first
  // (measured against 2.1.221), so ultracode and the statusLine wrapper have
  // to share a file rather than each append a flag — which is why this is one
  // push and not two. The fallback keeps a caller that hands over no file
  // getting its ultracode key, including the deliberate throw when that file
  // cannot be written.
  //
  // It sits before extraArgs so a hand-written `--settings` there still wins —
  // a repeated option is last-wins.
  const file = settingsFile ?? (opts.ultracode ? ultracodeSettingsFile() : null)
  if (file) args.push('--settings', file)

  if (opts.name) args.push('--name', opts.name)
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir)
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)

  return args
}
