import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { CliInfo, LaunchOptions } from '@shared/types'
// Relative and with the extension: this module is run directly under
// `node --experimental-strip-types`, which resolves no path aliases.
import {
  binNamesFor,
  cliFor,
  CODING_CLIS,
  type CodingCli,
  type CodingCliId,
  type CodingCliDetection
} from '../shared/codingClis.ts'

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
 * it got slow once per PTY spawn rather than once per launch.
 *
 * Holding the promise fixed that and overshot: it cached the failure for the
 * whole life of the process, so one slow boot left the app unable to find
 * `claude` until it was quit and reopened. Neither extreme is right, which is
 * why the failure now stands for PROBE_RETRY_MS and no longer.
 *
 * `-i` is load-bearing and must not be dropped to make this cheaper: measured
 * from a bare Finder-like environment, `-lc` alone returns a PATH with no mise
 * directory in it, and mise is where `claude` actually lives here.
 */
let loginPathProbe: Promise<string | null> | null = null
let probeFailedAt = 0

/*
 * The last PATH a login shell printed, kept on disk so a session never waits
 * on the next probe to get one.
 *
 * `zsh -ilc` measured 2.96–4.18 s here against its 5 s timeout, and the first
 * session of a launch — restored tabs included — waited on it: 516 and 1246 ms
 * to `pty:start` when Start was pressed right after the launcher enabled, 7–18
 * ms for every start after. A PATH changes when someone edits a shell rc,
 * which is rare; a launch happens every day. So a start waits
 * `REMEMBERED_WAIT_MS` for a fresh answer and otherwise takes the remembered
 * one, while the probe finishes behind it for the next start. It also means a
 * probe that times out — gotcha 52's Finder launch — leaves the session with
 * the PATH the shell gave last time rather than none. POSIX only: Windows'
 * registry read is quick and has its own race in `buildEnvPath`.
 */
const REMEMBERED_WAIT_MS = 200
let rememberedLoginPath: string | null = null
let rememberedLoginPathFile: string | null = null

/** Where the remembered PATH lives, and load it. Called once, at app ready. */
export async function rememberLoginPathIn(file: string): Promise<void> {
  rememberedLoginPathFile = file
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as { path?: unknown }
    if (typeof saved.path === 'string' && saved.path) rememberedLoginPath ??= saved.path
  } catch {
    /* none yet, or unreadable: the first probe writes it */
  }
}

/**
 * The PATH a session start uses: a fresh probe's if it answered in time, else
 * the remembered one. `fresh` is `undefined` when the probe is still running,
 * `null` when it failed. Pure, for verify:cli.
 */
export function pickLoginPath(fresh: string | null | undefined, remembered: string | null): string | null {
  return fresh ?? remembered
}

function rememberLoginPath(path: string): void {
  if (path === rememberedLoginPath) return
  rememberedLoginPath = path
  if (!rememberedLoginPathFile) return
  void writeFile(rememberedLoginPathFile, JSON.stringify({ path, at: Date.now() })).catch(() => {})
}

/**
 * How long a *failed* probe stands before the next caller retries it, and the
 * timeout that decides a failure in the first place.
 *
 * A failure has to be remembered for a while, for the reason above — otherwise
 * every PTY spawn pays the timeout again. What it must NOT be is remembered for
 * the life of the process, which is exactly what `loginPathProbe ??=` did,
 * because `null` is both "failed" and "nothing cached yet".
 *
 * One slow boot therefore poisoned the app until it was restarted. `findClaude`
 * falls back to `extraSearchDirs()`, and on a machine whose `claude` lives in a
 * version manager that list used to hold nothing at all — so every later
 * session start reported "Could not find the `claude` executable" while the
 * binary sat happily on disk. Measured here: with the probe forced past its
 * timeout, `findClaude` returns null on a machine where `claude --version`
 * answers `2.1.237` from the same shell a second later. It reads as
 * "Stoke cannot access claude, for some reason", and the tell is that quitting
 * and reopening fixes it.
 */
export const PROBE_RETRY_MS = 30_000
const PROBE_TIMEOUT_MS = 5000

/**
 * Whether a probe may run, given when the last one failed. Pure, and separate
 * from the caller that spawns the shell, for gotcha 31's reason: the rule is
 * the part worth asserting and the spawn is the part a suite cannot reach.
 *
 * `failedAt === 0` means "no failure on record" — either nothing has been
 * probed yet or the last probe succeeded — and both may proceed.
 */
export function shouldReprobe(failedAt: number, now: number): boolean {
  return failedAt === 0 || now - failedAt >= PROBE_RETRY_MS
}

/*
 * Windows has no login shell to ask, but it has the same question and a better
 * place to answer it: the registry holds the PATH every NEW process is given —
 * the machine value, then the user's — and it is where every installer writes.
 * `winget install`, Node's MSI, Codex's and Grok's install.ps1 and winget's own
 * portable fallback folders all land there and nowhere else, and a Stoke started
 * before them kept the PATH it was born with, so an agent installed from Stoke's
 * own picker sat "not found" until Stoke restarted.
 *
 * Read through PowerShell, not reg.exe: reg.exe converts a piped value to the
 * console code page, so an accented profile folder (which vendor installers
 * write out as a literal, expanded path) arrived as U+FFFD, and it cannot say
 * what the OTHER environment variables are — `%PNPM_HOME%` defined by an
 * installer after Stoke started would stay literal. PowerShell hands over every
 * value raw (DoNotExpandEnvironmentNames) as UTF-8 JSON, and `pathFromRegistry`
 * expands them the way Windows builds a new process's environment. It costs
 * one Windows PowerShell start — seconds when cold, see WIN_PROBE_TIMEOUT_MS —
 * once, memoised, never on the boot path. A failure is remembered for PROBE_RETRY_MS like the
 * POSIX probe's, but never reported as a login-shell failure — the words
 * `notFoundError` uses for that would be false here.
 */
let winPathProbe: Promise<string | null> | null = null
let winPathFailedAt = 0

const WIN_ENV_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "function Vals($k) { $h = @{}; if ($k) { foreach ($n in $k.GetValueNames()) { $h[$n] = [string]$k.GetValue($n, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } }; $h }",
  "$m = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')",
  "$u = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  '@{ machine = (Vals $m); user = (Vals $u) } | ConvertTo-Json -Compress'
].join('; ')

/**
 * `%NAME%` expanded the way Windows does it — case-insensitively, and a name it
 * does not know left exactly as written. Registry values are stored
 * unexpanded; `%USERPROFILE%\.local\bin` means nothing to a directory walk.
 */
export function expandWinEnv(value: string, env: Record<string, string | undefined>): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]))
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole)
}

/**
 * Variables Windows takes from the logged-on user's profile, never from the
 * machine key. HKLM's Environment carries `USERNAME=SYSTEM` — CreateEnvironmentBlock
 * overrides it with the real user — so layering the machine key over this
 * process's env unfiltered turned `%USERNAME%` into `SYSTEM`.
 */
const PROFILE_VARS = new Set([
  'username', 'userdomain', 'userdomain_roamingprofile', 'userprofile', 'appdata', 'localappdata',
  'homedrive', 'homepath', 'homeshare', 'logonserver'
])

/**
 * The PATH a new process gets, from the two registry Environment keys, built
 * the way Windows builds a new process's environment: this process's env (for
 * what comes from the profile, like USERPROFILE), then each machine variable
 * but the profile ones, then each user variable — every value expanded against
 * the scope built so far, plain values before `%…%` ones, so a variable that
 * names another (`%JAVA_HOME%\bin` beside `JAVA_HOME=%ProgramFiles%\Java`)
 * arrives expanded. Only then are the machine Path and the user's expanded
 * against that scope and joined, machine first.
 */
export function pathFromRegistry(
  reg: { machine?: Record<string, string>; user?: Record<string, string> },
  env: Record<string, string | undefined>
): string | null {
  const isPath = (k: string): boolean => k.toLowerCase() === 'path'
  const pathOf = (vars: Record<string, string> | undefined): string | null => {
    if (!vars) return null
    const key = Object.keys(vars).find(isPath)
    return key && vars[key] ? vars[key] : null
  }
  const machine = pathOf(reg.machine)
  const user = pathOf(reg.user)
  if (machine === null && user === null) return null
  // Keyed case-insensitively, as Windows' own environment is.
  const scope: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) scope[k.toLowerCase()] = v
  const layer = (vars: Record<string, string> | undefined, skip: (k: string) => boolean): void => {
    const entries = Object.entries(vars ?? {}).filter(([k]) => !isPath(k) && !skip(k.toLowerCase()))
    const plain = entries.filter(([, v]) => !v.includes('%'))
    const refs = entries.filter(([, v]) => v.includes('%'))
    for (const [k, v] of plain) scope[k.toLowerCase()] = v
    for (const [k, v] of refs) scope[k.toLowerCase()] = expandWinEnv(v, scope)
  }
  layer(reg.machine, (k) => PROFILE_VARS.has(k))
  layer(reg.user, () => false)
  return [machine, user]
    .filter((v): v is string => v !== null)
    .map((v) => expandWinEnv(v, scope))
    // Windows' separator, whatever machine a suite runs this on.
    .join(';')
}

/*
 * Its own timeout, well above the login shell's: measured on GitHub's
 * windows-latest, the same probe answered in one run and came back empty in the
 * next under PROBE_TIMEOUT_MS (5 s) — a cold Windows PowerShell 5.1, which
 * loads .NET and its modules before running a line, on a busy machine. The
 * probe is memoised and never on the boot path, so waiting longer costs nothing
 * when it succeeds, and a failure here means an agent installed a minute ago is
 * reported missing.
 */
const WIN_PROBE_TIMEOUT_MS = 20_000
let winPathError: string | null = null

function windowsRegistryPath(): Promise<string | null> {
  if (winPathProbe) return winPathProbe
  if (!shouldReprobe(winPathFailedAt, Date.now())) return Promise.resolve(null)
  winPathProbe = (async () => {
    const ps = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const started = Date.now()
    try {
      const run = execFileAsync(ps, ['-NoProfile', '-NonInteractive', '-Command', WIN_ENV_SCRIPT], {
        timeout: WIN_PROBE_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      })
      // execFile hands the child an open stdin pipe, and Windows PowerShell can
      // sit waiting on it; nothing is ever written, so close it at once.
      run.child.stdin?.end()
      const { stdout } = await run
      const path = pathFromRegistry(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()), process.env)
      if (!path) throw new Error('the registry holds no Path')
      winPathFailedAt = 0
      winPathError = null
      return path
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string | null; code?: string | number; message?: string; stderr?: string }
      winPathError = e.killed || e.signal
        ? `powershell.exe did not answer within ${WIN_PROBE_TIMEOUT_MS / 1000}s`
        : `${e.message ?? String(err)}${e.stderr ? ` — ${e.stderr.trim().slice(0, 400)}` : ''}`
      winPathError += ` (after ${Date.now() - started} ms)`
      winPathFailedAt = Date.now()
      winPathProbe = null
      return null
    }
  })()
  return winPathProbe
}

/**
 * Why the last Windows registry PATH read failed, or null. Read only to explain
 * a miss — the Windows workflow prints it — never to decide one.
 */
export function windowsPathProbeError(): string | null {
  return winPathError
}

/**
 * Set PATH in an environment object that will become a child's, as ONE key.
 *
 * On Windows the variable is spelled `Path`, and `Object.entries(process.env)`
 * keeps that spelling — so an env copied from it and then given `env.PATH = …`
 * carries TWO entries. node-pty hands the object to CreateProcess in insertion
 * order, and a case-insensitive lookup takes the first: the STALE inherited
 * `Path`, not the one Stoke built. (pty.ts had `if (platform !== 'win32')
 * env.Path = env.PATH`, the right repair on the wrong side of the condition.)
 * Every other spelling is removed first, so exactly one survives.
 */
export function setPathKey(env: Record<string, string>, value: string, platform: string = process.platform): void {
  if (platform === 'win32') {
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]
  }
  env.PATH = value
}

function loginShellPath(): Promise<string | null> {
  if (isWin) return windowsRegistryPath()
  if (loginPathProbe) return loginPathProbe
  // Inside the cooldown from a failure: answer instantly rather than pay the
  // timeout again. Outside it, fall through and probe once more.
  if (!shouldReprobe(probeFailedAt, Date.now())) return Promise.resolve(null)
  loginPathProbe = (async () => {
    const shell = process.env.SHELL || '/bin/zsh'
    try {
      const { stdout } = await execFileAsync(shell, ['-ilc', 'printf %s "$PATH"'], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: 'utf8'
      })
      // An empty PATH is a failed probe wearing a success's clothes: it would
      // be cached forever by the branch above and contribute nothing.
      const path = stdout.trim()
      if (!path) throw new Error('the login shell printed no PATH')
      probeFailedAt = 0
      rememberLoginPath(path)
      return path
    } catch {
      probeFailedAt = Date.now()
      // Drop the memo so the next caller past the cooldown probes again.
      loginPathProbe = null
      return null
    }
  })()
  return loginPathProbe
}

/**
 * Drop a SUCCESSFUL probe's memo, so the next caller reads the login shell
 * again. For after an install: every vendor's POSIX installer appends its bin
 * directory to the user's shell rc (opencode's `~/.opencode/bin`, grok's
 * `~/.grok/bin`), and a PATH read before that stays stale for the life of the
 * process — the CLI would sit installed and "not found" until Stoke restarted.
 * A failure's memo is left alone: its retry rule is gotcha 52's.
 */
export function forgetLoginPath(): void {
  if (probeFailedAt === 0) loginPathProbe = null
  // And the remembered copy, in memory only: the next start must wait for the
  // shell that knows the new bin directory, not take the one from before it.
  // The probe's success writes the file again.
  rememberedLoginPath = null
  // Windows' equivalent: an installer just wrote the registry PATH.
  if (winPathFailedAt === 0) winPathProbe = null
}

/**
 * Whether the most recent login-shell probe failed. Read only to explain a
 * miss, never to decide one.
 */
export function loginPathProbeFailed(): boolean {
  return probeFailedAt !== 0
}

/**
 * The login shell's own PATH — what a NEW terminal will have — or null when the
 * probe failed. On Windows, the registry's PATH (`windowsRegistryPath`). Not `buildEnvPath`, which
 * unions in Stoke's own and the fallback dirs: Settings > Updates > Command
 * line asks whether a terminal will find `stoke`, and a directory Stoke added
 * for itself is no evidence of that.
 */
export function loginShellPathValue(): Promise<string | null> {
  return loginShellPath()
}

/** PATH to hand to spawned processes: login-shell PATH unioned with our own. */
export async function buildEnvPath(): Promise<string> {
  const parts = new Set<string>()
  // A session start waits on this, so on Windows it waits no longer than the
  // login-shell probe would; a slower registry read carries on in the
  // background, memoised, and the next caller gets it. Without it the answer
  // is still this process's PATH plus the known install folders below.
  const login = isWin
    ? await Promise.race([loginShellPath(), new Promise<null>((r) => setTimeout(() => r(null), PROBE_TIMEOUT_MS).unref())])
    : rememberedLoginPath
      ? pickLoginPath(
          await Promise.race([
            loginShellPath(),
            new Promise<undefined>((r) => setTimeout(() => r(undefined), REMEMBERED_WAIT_MS).unref())
          ]),
          rememberedLoginPath
        )
      : await loginShellPath()
  if (login) for (const p of login.split(delimiter)) if (p) parts.add(p)
  for (const p of (process.env.PATH ?? '').split(delimiter)) if (p) parts.add(p)
  for (const p of extraSearchDirs()) parts.add(p)
  return [...parts].join(delimiter)
}

/**
 * A version manager keeps its tools behind a *shim* directory that only reaches
 * PATH once the shell hook has run — `mise activate zsh` and its equivalents
 * live in `.zshrc`, so an interactive shell has them and a Finder launch does
 * not. That is what the login-shell probe exists for, and for a long time it
 * was the ONLY channel: a `claude` installed under mise appears in none of the
 * fixed directories below, so a single failed probe meant the CLI could not be
 * found at all. Measured on this machine, `claude` was present in exactly one
 * directory and absent from all ten that `findClaude` falls back to.
 *
 * The shim directories need no hook of their own, which is the whole point:
 * `~/.local/share/mise/shims/claude` answers `--version` correctly with PATH
 * set to nothing but `/usr/bin:/bin:/usr/sbin:/sbin`, verified here. Naming
 * them directly demotes the probe from a single point of failure back to the
 * optimisation it was meant to be.
 *
 * Each manager's data directory is overridable, so the env var is honoured
 * ahead of the default. nvm is deliberately absent: it publishes no stable
 * shim directory, only `versions/node/<version>/bin`, which would need a glob
 * and a policy about which version to prefer.
 */
function shimDirs(): string[] {
  const home = homedir()
  const xdgData = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
  return [
    join(process.env.MISE_DATA_DIR || join(xdgData, 'mise'), 'shims'),
    join(process.env.ASDF_DATA_DIR || join(home, '.asdf'), 'shims'),
    join(process.env.FNM_DIR || join(xdgData, 'fnm'), 'aliases', 'default', 'bin')
  ]
}

export function extraSearchDirs(): string[] {
  const home = homedir()
  if (isWin) {
    return [
      join(home, '.local', 'bin'),
      join(home, '.claude', 'local'),
      ...shimDirs(),
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'claude'),
      join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
      // Where the vendors' own install.ps1 scripts put their binaries, which
      // reach PATH only through a profile edit this process has not re-read.
      join(home, '.grok', 'bin'),
      join(home, '.kimi-code', 'bin'),
      join(home, '.amp', 'bin'),
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'cursor-agent'),
      /*
       * Three more, found by review from the vendors' install.ps1 scripts. On
       * Windows there is no login shell to re-read (`loginShellPath` is null),
       * so a PATH entry an installer adds is invisible to this process until it
       * restarts — the only way Stoke finds a just-installed agent is to look
       * where the installer puts it.
       */
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin'),
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'qwen-code', 'bin'),
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links')
    ]
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    /*
     * Where two vendors' own installers put their binary — `~/.opencode/bin`
     * (opencode.ai/install) and `~/.grok/bin` (x.ai/cli/install.sh) — reaching
     * PATH only through a line they append to the shell rc. Listed so that a CLI
     * installed from Stoke is found in this run, before any shell has re-read
     * that rc, and so a Finder launch whose login probe failed still finds it.
     */
    join(home, '.opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.kimi-code', 'bin'),
    join(home, '.amp', 'bin'),
    ...shimDirs(),
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
function candidateNames(): readonly string[] {
  return binNamesFor(CODING_CLIS[0], process.platform)
}

/**
 * Find an executable on the same PATH a session would get.
 *
 * Factored out of `findClaude` rather than duplicated, because the search path
 * is the interesting part and it is not `process.env.PATH`: `buildEnvPath` puts
 * the version-manager shim directories ahead of the system ones and, where it
 * can, asks a login shell — the only channel that finds a CLI installed by
 * mise/asdf/fnm when Stoke was started from the Dock (gotcha 52). A second copy
 * of this would answer differently on exactly the machines where the answer is
 * hard to get right.
 */
export async function findTool(names: readonly string[]): Promise<string | null> {
  const searchPath = await buildEnvPath()
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const full = join(dir, name)
      if (isFile(full)) return full
    }
  }
  return null
}

/** Every match for these names on the search PATH, in PATH order. */
async function findAllTools(names: readonly string[]): Promise<string[]> {
  const searchPath = await buildEnvPath()
  const out: string[] = []
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const full = join(dir, name)
      if (isFile(full) && !out.includes(full)) out.push(full)
    }
  }
  return out
}

/*
 * Whether a binary on PATH is the agent it is named after.
 *
 * Two agent names are also the names of unrelated Homebrew formulae — `grok` is
 * a regex tool (jordansissel/grok) and `amp` a text editor (amp.rs) — so a
 * filename match alone would tick "installed" in the picker and open the
 * editor in a tab. For a CLI with an `identify` pattern, `--version` has to
 * match it. The answer per path is cached for the life of the process: a
 * binary does not change identity, and a launch should not pay a spawn.
 */
const identityCache = new Map<string, boolean>()

async function isAgent(path: string, pattern: RegExp): Promise<boolean> {
  const cached = identityCache.get(path)
  if (cached !== undefined) return cached
  let yes = false
  try {
    const spec = spawnSpec(path, ['--version'])
    const { stdout, stderr } = await execFileAsync(spec.file, spec.args, {
      timeout: 4000,
      encoding: 'utf8',
      env: { ...process.env, PATH: await buildEnvPath() }
    })
    yes = pattern.test(`${stdout}\n${stderr}`)
  } catch (err) {
    /*
     * Only a program that RAN and answered is a definite "not this agent". A
     * timeout (`killed`, checked before any code — gotcha 25) or a spawn error
     * (ENOENT, EACCES, ETXTBSY mid-install) says nothing about identity, and
     * caching it would keep a real agent "not installed" for the rest of the
     * run, past "Look again" — found by review.
     */
    const e = err as { killed?: boolean; code?: unknown; stdout?: string; stderr?: string }
    if (e.killed || typeof e.code !== 'number') return false
    yes = pattern.test(`${e.stdout ?? ''}\n${e.stderr ?? ''}`)
  }
  identityCache.set(path, yes)
  return yes
}

/** Forget every identity answer, for a fresh detection after an install. */
export function forgetIdentities(): void {
  identityCache.clear()
}

/**
 * The agent's binary, and — when the first file by that name is some other
 * program — where that program is, so the UI can say so instead of "not
 * installed".
 */
async function locateAgent(cli: CodingCli): Promise<{ path: string | null; conflict: string | null }> {
  const found = await findAllTools(binNamesFor(cli, process.platform))
  if (!cli.identify) return { path: found[0] ?? null, conflict: null }
  for (const candidate of found) {
    if (await isAgent(candidate, cli.identify)) return { path: candidate, conflict: null }
  }
  return { path: null, conflict: found[0] ?? null }
}

/**
 * Whether a path is inside `%LOCALAPPDATA%\Microsoft\WindowsApps` — the folder
 * of Store app execution aliases, which is on every Windows PATH.
 */
export function isWindowsAppsAlias(p: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(p)
}

/**
 * Find the claude executable, honouring an explicit user override first.
 *
 * On Windows a `claude.exe` in WindowsApps is passed over, without being run:
 * that folder holds Store app aliases, Claude Desktop's among them, and Claude
 * Code is never installed there by any route (native → ~\.local\bin, npm →
 * %APPDATA%\npm, winget → WinGet\Links). Windows compares names without case,
 * so `Claude.exe` answers to `claude.exe` — and it comes before ~\.local\bin on
 * PATH, which the native installer never adds itself. Running it to ask
 * `--version` could open the desktop app's window, so it is not asked. A person
 * whose Claude Code really is there sets the path in Settings, which wins above.
 */
export async function findClaude(override: string | null): Promise<string | null> {
  if (override && isFile(override)) return override
  if (!isWin) return findTool(candidateNames())
  return (await findAllTools(candidateNames())).find((p) => !isWindowsAppsAlias(p)) ?? null
}

/**
 * The same lookup, for any CLI Stoke knows about.
 *
 * `findClaude` stays as it is rather than becoming a call to this: it carries
 * the Settings override, the four-site error message and every one of gotcha
 * 52's shim-directory lessons, and rewriting its callers to pass `'claude'`
 * would be churn with a chance of regression and no gain.
 */
export async function findCli(id: CodingCliId, override: string | null = null): Promise<string | null> {
  if (id === 'claude') return findClaude(override)
  if (override && isFile(override)) return override
  return (await locateAgent(cliFor(id))).path
}

/**
 * Which of the coding CLIs Stoke knows about are on this machine.
 *
 * Reports paths, nothing more. Stoke can RUN these now, but only Claude Code
 * gets the instrumentation around it — the context ring, resume, the worklog
 * and the plan-limit chip are all fed by Claude Code's own transcript format
 * and its statusLine hook. What each other CLI may honestly show is in
 * `CLI_CAPS`, not assumed here.
 */
export async function detectCodingClis(): Promise<CodingCliDetection> {
  const clis = await Promise.all(
    CODING_CLIS.map(async (cli) => {
      const { path, conflict } = await locateAgent(cli)
      return conflict ? { id: cli.id, path, conflict } : { id: cli.id, path }
    })
  )
  // Read after the lookups, which are what run the probe.
  return { clis, probeFailed: loginPathProbeFailed() }
}

/**
 * What to say when no `claude` turned up, which is not one message but two.
 * The single source for all four sites that can miss, so they cannot drift.
 *
 * Do not print a diagnosis the tool can disprove. "Install Claude Code" is
 * wrong — and wrong exactly when someone is looking for a cause — if the CLI is
 * installed and it was the login-shell probe that failed. Following that advice
 * means reinstalling a working install. Pure and exported so both branches are
 * assertable without depending on what happens to sit in /usr/bin on the
 * machine running the suite.
 *
 * The retry sentence is deliberately about what the *user* can do, and its
 * number is derived from PROBE_RETRY_MS rather than retyped. An earlier draft
 * said "this retries by itself shortly", which was the same sin one paragraph
 * up: nothing in the app refetches CliInfo on a timer short enough to honour
 * it — the renderer sets it on boot and on an `updates:state` push, and the
 * only automatic push lands at 12s (inside the cooldown) and then every six
 * hours. Starting a session DOES re-probe, because pty.ts calls findClaude
 * afresh every time, so "try again" is true where "it will fix itself" was not.
 */
export function notFoundError(probeFailed: boolean, id: CodingCliId = 'claude'): string {
  const secs = Math.round(PROBE_RETRY_MS / 1000)
  const cli = cliFor(id)
  const bin = cli.bins.posix[0]
  return probeFailed
    ? `Could not find the \`${bin}\` executable: asking the login shell for its PATH failed, so an install that needs a shell hook (mise, asdf, fnm, nvm) may be invisible. Trying again in ${secs}s re-runs that probe; if it keeps failing, set an explicit path in Settings.`
    : `Could not find the \`${bin}\` executable. Install ${cli.label}, or set an explicit path in Settings.`
}

export async function probeClaude(override: string | null): Promise<CliInfo> {
  const found = await findClaude(override)
  if (!found) {
    return { path: '', version: null, ok: false, error: notFoundError(loginPathProbeFailed()) }
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
 * `--resume <id>` or `--session-id <id>`, decided by whether `<id>` has a
 * transcript on disk — the one fact the CLI itself decides it on.
 *
 * Measured against 2.1.278, the two flags fail in opposite cases, and both
 * failures end the process before the TUI draws:
 *
 *   --resume U      with no transcript for U  -> exit 1, "No conversation found
 *                                                with session ID: U"
 *   --session-id U  once U has a transcript   -> "Session ID U is already in use"
 *   --resume U --session-id U                 -> refused: --session-id with
 *                                                --resume needs --fork-session
 *
 * A session has no transcript until its first prompt, yet its statusLine
 * payload — and so the relaunch pill — arrives before one; and `/clear` puts a
 * live process on a fresh id that has none either. So a relaunch or a Resume
 * cannot assume `--resume`. An id with no transcript is started again under
 * the SAME id with `--session-id`, which the CLI accepts (also measured, with
 * the old process still dying), so the tab keeps its identity and the context
 * meter its key. Pure, so `verify:cli` holds the table.
 */
export function resumeOrMint(opts: LaunchOptions, hasTranscript: boolean): LaunchOptions {
  if (opts.continueLast || !opts.sessionId || opts.host) return opts
  if (opts.resume && !hasTranscript) return { ...opts, resume: false, forkSession: false }
  if (!opts.resume && hasTranscript) return { ...opts, resume: true }
  return opts
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
