import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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
let cachedLoginPath: string | null = null

async function loginShellPath(): Promise<string | null> {
  if (isWin) return null
  if (cachedLoginPath !== null) return cachedLoginPath
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileAsync(shell, ['-ilc', 'printf %s "$PATH"'], {
      timeout: 5000,
      encoding: 'utf8'
    })
    cachedLoginPath = stdout.trim() || null
  } catch {
    cachedLoginPath = null
  }
  return cachedLoginPath
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
 * Translate Hearth's launch options into claude CLI arguments.
 *
 * Note `bypassPermissions` maps to `--dangerously-skip-permissions` rather than
 * `--permission-mode bypassPermissions`: the latter requires the mode to already
 * be enabled for the workspace, the former always works.
 */
export function buildArgs(opts: LaunchOptions): string[] {
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
  if (opts.effort && opts.effort !== 'default') args.push('--effort', opts.effort)
  if (opts.name) args.push('--name', opts.name)
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir)
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)

  return args
}
