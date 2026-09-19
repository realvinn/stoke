/*
 * Settings > Updates > Command line: the file work behind the `stoke` command.
 *
 * macOS   `~/.local/bin/stoke` -> `<resources>/bin/stoke`, a symlink to the
 *         shim inside this bundle, made and removed here with async fs
 *         (gotcha 40: a synchronous call in main is a bet on the disk).
 * Linux   read-only. The command is the launcher the one-line installer
 *         writes, and a symlink from here would point into the AppImage's
 *         mount under /tmp, which is gone the moment Stoke quits.
 * Windows `<resources>\bin` on the per-user PATH, through PowerShell. NOT
 *         VERIFIED ON WINDOWS: nobody has run this branch, and the panel says so.
 *
 * Every decision is one of the pure rules in `src/shared/stokeCommand.ts`,
 * which the shim's own `install-cli` also follows; this file only gathers what
 * those rules need and acts on the answer. No electron import, so a suite can
 * load it: the caller passes the paths and the PATH probe in.
 */
import { execFile } from 'node:child_process'
import { access, constants, lstat, mkdir, open, readlink, realpath, rename, rm, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { StokeCommandState } from '../shared/api.ts'
import {
  appOfShim,
  classifyLinuxCommand,
  classifyMacLink,
  dirOnPath,
  isStokeShimTarget,
  macBundleProblem,
  PATH_EXPORT_LINE,
  type LinkEntry
} from '../shared/stokeCommand.ts'

export interface CommandEnv {
  platform: string
  home: string
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** `app.isPackaged`. A development run has no bundle for the command to open. */
  packaged: boolean
  /** The PATH a new terminal gets (cli.ts's login-shell probe), or null when it could not be read. */
  loginPath: () => Promise<string | null>
}

const INSTALL_LINE = 'curl -fsSL https://stoke.vinn.dev | sh'

function platformOf(p: string): StokeCommandState['platform'] {
  return p === 'darwin' || p === 'linux' || p === 'win32' ? p : 'other'
}

function blank(env: CommandEnv): StokeCommandState {
  return {
    platform: platformOf(env.platform),
    unavailable: null,
    commandPath: null,
    shimPath: null,
    status: 'missing',
    detail: '',
    onPath: null,
    pathLine: null,
    error: null,
    canInstall: false,
    canRemove: false
  }
}

const DEV_RUN =
  'This is a development run, so there is no installed Stoke for the command to open. Package the app (npm run dist:mac) to try it.'

async function readEntry(path: string): Promise<LinkEntry> {
  try {
    const st = await lstat(path)
    if (!st.isSymbolicLink()) return { kind: 'other' }
    return { kind: 'link', target: await readlink(path) }
  } catch {
    return { kind: 'missing' }
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- macOS */

async function macState(env: CommandEnv, error: string | null = null): Promise<StokeCommandState> {
  const binDir = join(env.home, '.local', 'bin')
  const commandPath = join(binDir, 'stoke')
  /*
   * The PHYSICAL path, because that is what the shim links to: it resolves its
   * own folder with `pwd -P`. Were the bundle reached through a symlinked
   * folder, the two spellings would differ and each side would read the
   * other's link as "a different Stoke" and offer to repair it, forever.
   */
  const shimPath = await realpath(join(env.resourcesPath, 'bin', 'stoke')).catch(() =>
    join(env.resourcesPath, 'bin', 'stoke')
  )
  const out: StokeCommandState = { ...blank(env), commandPath, shimPath, error }
  if (!env.packaged) return { ...out, unavailable: DEV_RUN }
  const app = appOfShim(shimPath)
  if (!app) return { ...out, unavailable: `This Stoke is not laid out as an app bundle (${env.resourcesPath}).` }
  const problem = macBundleProblem(app)
  if (problem) return { ...out, unavailable: problem }
  if (!(await isExecutable(shimPath))) {
    return { ...out, unavailable: 'This build of Stoke has no stoke command inside it. Update Stoke to get one.' }
  }

  const entry = await readEntry(commandPath)
  const status = classifyMacLink(entry, shimPath)
  const onPath = dirOnPath(binDir, await env.loginPath(), 'darwin')
  const target = entry.kind === 'link' ? entry.target : ''
  const detail =
    status === 'installed'
      ? `${commandPath} links to this Stoke.`
      : status === 'repairable'
        ? `${commandPath} links to a different Stoke (${target}). Repair points it at this one.`
        : status === 'foreign'
          ? `${commandPath} is not Stoke's${target ? ` (it links to ${target})` : ''}, so Stoke will not touch it. Move it aside to install the command.`
          : 'Not installed.'
  return {
    ...out,
    status,
    detail,
    onPath,
    pathLine: onPath === false ? PATH_EXPORT_LINE : null,
    canInstall: status === 'missing' || status === 'repairable',
    canRemove: status === 'installed' || status === 'repairable'
  }
}

async function macInstall(env: CommandEnv): Promise<StokeCommandState> {
  const before = await macState(env)
  if (before.unavailable || before.status === 'installed') return before
  if (!before.canInstall) {
    return { ...before, error: `${before.commandPath} is not Stoke's, so it was left alone.` }
  }
  const commandPath = before.commandPath as string
  const binDir = dirname(commandPath)
  // Beside the destination and renamed over it: rename(2) replaces a symlink
  // without following it and is atomic, so there is never a moment with no
  // command. Checked again right before the rename, not only at the top: the
  // one thing this must never do is replace something that is not Stoke's.
  const stage = join(binDir, `.stoke.link.${process.pid}`)
  try {
    await mkdir(binDir, { recursive: true })
    await rm(stage, { force: true })
    await symlink(before.shimPath as string, stage)
    const now = classifyMacLink(await readEntry(commandPath), before.shimPath as string)
    if (now !== 'missing' && now !== 'repairable') {
      await rm(stage, { force: true })
      return macState(env, `${commandPath} changed while this ran, and is not Stoke's now. Nothing was replaced.`)
    }
    await rename(stage, commandPath)
  } catch (e) {
    await rm(stage, { force: true }).catch(() => {})
    return macState(env, `Could not write ${commandPath}: ${(e as Error).message}`)
  }
  return macState(env)
}

async function macRemove(env: CommandEnv): Promise<StokeCommandState> {
  const before = await macState(env)
  if (before.unavailable || !before.commandPath) return before
  const entry = await readEntry(before.commandPath)
  if (entry.kind === 'missing') return before
  if (entry.kind !== 'link' || !isStokeShimTarget(entry.target)) {
    return macState(env, `${before.commandPath} is not Stoke's, so it was left alone.`)
  }
  try {
    await unlink(before.commandPath)
  } catch (e) {
    return macState(env, `Could not remove ${before.commandPath}: ${(e as Error).message}`)
  }
  return macState(env)
}

/* ---------------------------------------------------------------- Linux */

async function readHead(path: string): Promise<string | null> {
  let fh
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(512)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('latin1')
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

async function linuxState(env: CommandEnv, error: string | null = null): Promise<StokeCommandState> {
  const binDir = join(env.home, '.local', 'bin')
  const commandPath = join(binDir, 'stoke')
  const kind = classifyLinuxCommand(await readHead(commandPath))
  const onPath = dirOnPath(binDir, await env.loginPath(), 'linux')
  const detail =
    kind === 'wrapper'
      ? `${commandPath} is the launcher the installer wrote.`
      : kind === 'appimage'
        ? `${commandPath} is the AppImage itself, the installer's older layout: it runs, but cannot take a folder. Run the installer again (${INSTALL_LINE}) to replace it with the launcher.`
        : kind === 'foreign'
          ? `${commandPath} is not Stoke's.`
          : `Not installed. The one-line installer puts it there: ${INSTALL_LINE}`
  return {
    ...blank(env),
    commandPath,
    status: kind === 'wrapper' ? 'installed' : kind === 'appimage' ? 'repairable' : kind,
    detail,
    onPath,
    pathLine: onPath === false ? PATH_EXPORT_LINE : null,
    error,
    // Never from here: see the header.
    canInstall: false,
    canRemove: false
  }
}

/* -------------------------------------------------------------- Windows */

/*
 * The per-user PATH, edited without flattening it.
 *
 * `[Environment]::GetEnvironmentVariable('Path', 'User')` returns the value
 * EXPANDED, and `SetEnvironmentVariable` writes a plain REG_SZ — so the obvious
 * read-append-write rewrites `%USERPROFILE%\AppData\Local\Microsoft\WindowsApps`
 * (the entry Windows itself puts there) and every other `%VAR%` entry as a
 * frozen literal, silently, for good. So the value is read raw
 * (DoNotExpandEnvironmentNames) and written back as REG_EXPAND_SZ, and the
 * change is announced by setting and clearing a throwaway variable through
 * [Environment], which is what broadcasts WM_SETTINGCHANGE (a raw registry
 * write does not, and running shells and Explorer would not notice).
 * Never `setx`: it truncates the value at 1024 characters.
 *
 * The folder arrives in $env:STOKE_BIN_DIR, never interpolated into the
 * script: an install path can hold an apostrophe (C:\Users\O'Brien\...).
 *
 * NOT VERIFIED ON WINDOWS. Written from the .NET and registry documentation.
 */
export const WIN_PATH_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  '$dir = $env:STOKE_BIN_DIR',
  "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "$parts = @($raw -split ';' | Where-Object { $_ -ne '' })",
  "function Same($a) { ([Environment]::ExpandEnvironmentVariables($a)).TrimEnd('\\').ToLowerInvariant() -eq $dir.TrimEnd('\\').ToLowerInvariant() }",
  'function Save($next) {',
  "  $key.SetValue('Path', ($next -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)",
  "  [Environment]::SetEnvironmentVariable('STOKE_PATH_CHANGED', '1', 'User')",
  "  [Environment]::SetEnvironmentVariable('STOKE_PATH_CHANGED', $null, 'User')",
  '}'
]
export const WIN_PATH_ADD = [...WIN_PATH_PRELUDE, 'if (-not ($parts | Where-Object { Same $_ })) { Save ($parts + $dir) }'].join('\n')
export const WIN_PATH_REMOVE = [
  ...WIN_PATH_PRELUDE,
  '$keep = @($parts | Where-Object { -not (Same $_) })',
  'if ($keep.Count -ne $parts.Count) { Save $keep }'
].join('\n')
export const WIN_PATH_READ = [
  "$u = [Environment]::GetEnvironmentVariable('Path', 'User')",
  "$m = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
  "@{ user = [string]$u; machine = [string]$m } | ConvertTo-Json -Compress"
].join('\n')

const PS_TIMEOUT_MS = 15_000

function powershell(script: string, binDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, STOKE_BIN_DIR: binDir },
        timeout: PS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        // `killed` before any code (gotcha 25): a timeout arrives as killed, code null.
        const e = err as { killed?: boolean; code?: unknown; message: string }
        if (e.killed) return reject(new Error(`PowerShell did not answer within ${PS_TIMEOUT_MS / 1000}s.`))
        reject(new Error((stderr || e.message).trim()))
      }
    )
  })
}

async function winState(env: CommandEnv, error: string | null = null): Promise<StokeCommandState> {
  const binDir = join(env.resourcesPath, 'bin')
  const shimPath = join(binDir, 'stoke.cmd')
  const out: StokeCommandState = { ...blank(env), commandPath: binDir, shimPath, error }
  if (!env.packaged) return { ...out, unavailable: DEV_RUN.replace('dist:mac', 'dist:win') }
  try {
    await access(shimPath)
  } catch {
    return { ...out, unavailable: 'This build of Stoke has no stoke command inside it. Update Stoke to get one.' }
  }
  let user = ''
  let machine = ''
  try {
    const got = JSON.parse(await powershell(WIN_PATH_READ, binDir)) as { user?: unknown; machine?: unknown }
    user = typeof got.user === 'string' ? got.user : ''
    machine = typeof got.machine === 'string' ? got.machine : ''
  } catch (e) {
    return { ...out, detail: 'Could not read PATH.', error: error ?? (e as Error).message, canInstall: true }
  }
  const inUser = dirOnPath(binDir, user, 'win32') === true
  const onPath = inUser || dirOnPath(binDir, machine, 'win32') === true
  return {
    ...out,
    status: onPath ? 'installed' : 'missing',
    detail: onPath
      ? `${binDir} is on your PATH, so stoke works in a new terminal. Not yet verified on Windows.`
      : `Not on PATH. Install adds ${binDir} to your user PATH. Not yet verified on Windows.`,
    onPath,
    canInstall: !onPath,
    canRemove: inUser
  }
}

async function winEdit(env: CommandEnv, script: string): Promise<StokeCommandState> {
  const before = await winState(env)
  if (before.unavailable || !before.commandPath) return before
  try {
    await powershell(script, before.commandPath)
  } catch (e) {
    return winState(env, `Could not change PATH: ${(e as Error).message}`)
  }
  return winState(env)
}

/* ------------------------------------------------------------------ api */

export function readCommandState(env: CommandEnv): Promise<StokeCommandState> {
  if (env.platform === 'darwin') return macState(env)
  if (env.platform === 'linux') return linuxState(env)
  if (env.platform === 'win32') return winState(env)
  return Promise.resolve({ ...blank(env), unavailable: `Stoke has no command-line shim for ${env.platform}.` })
}

export function installCommand(env: CommandEnv): Promise<StokeCommandState> {
  if (env.platform === 'darwin') return macInstall(env)
  if (env.platform === 'win32') return winEdit(env, WIN_PATH_ADD)
  if (env.platform === 'linux') {
    return linuxState(env, `On Linux the installer manages ${join(env.home, '.local', 'bin', 'stoke')}: ${INSTALL_LINE}`)
  }
  return readCommandState(env)
}

export function removeCommand(env: CommandEnv): Promise<StokeCommandState> {
  if (env.platform === 'darwin') return macRemove(env)
  if (env.platform === 'win32') return winEdit(env, WIN_PATH_REMOVE)
  if (env.platform === 'linux') {
    return linuxState(env, `On Linux the installer manages ${join(env.home, '.local', 'bin', 'stoke')}.`)
  }
  return readCommandState(env)
}
