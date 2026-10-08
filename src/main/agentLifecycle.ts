import { execFile } from 'node:child_process'
import { access, open, realpath } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { spawnSpec, setPathKey } from './cli.ts'
import { redactSecrets } from './chatIndex/parse.ts'
import { agentNpmPackages, agentVersion, nativeUpdaterInHelp, NATIVE_AGENT_UPDATE, type AgentInstallation, type AgentUpdateResult } from '../shared/agentLifecycle.ts'
import type { CodingCliId } from '../shared/codingClis.ts'

const exec = promisify(execFile)
export type AgentCommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; output: string; timedOut?: boolean }>

/** An updater gets the user's toolchain, not any running agent's provider credentials. */
export function agentUpdateEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  const keep = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'USER', 'LOGNAME', 'SHELL', 'HOMEBREW_PREFIX', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
  for (const key of keep) if (process.env[key]) env[key] = process.env[key]!
  for (const [key, value] of Object.entries(process.env)) if (/^npm_config_/i.test(key) && value !== undefined) env[key] = value
  env.HOMEBREW_NO_AUTO_UPDATE = '1'
  setPathKey(env, path)
  return env
}
export function agentCommandRunner(path: string): AgentCommandRunner {
  const env = agentUpdateEnv(path)
  return async (file, args, timeoutMs) => {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file) && /[&|<>^%!\r\n]/.test([file, ...args].join(' '))) return { ok: false, output: 'This Windows batch path cannot safely run these arguments.' }
    const command = spawnSpec(file, args)
    const clean = (text: string): string => {
      let result = text
      for (const [key, value] of Object.entries(env)) if (/token|password|secret|auth/i.test(key) && value.length >= 4) result = result.split(value).join('[redacted]')
      return redactSecrets(result).slice(-32_768)
    }
    try {
      const result = await exec(command.file, command.args, { env, cwd: homedir(), timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
      return { ok: true, output: clean(`${result.stdout}\n${result.stderr}`.trim()) }
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; killed?: boolean }
      return { ok: false, timedOut: err.killed === true, output: clean(`${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim()) }
    }
  }
}

async function deadline<T>(work: Promise<T>, timeoutMs = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The installation path did not respond.')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function readSmall(file: string): Promise<string | null> {
  try {
    return await deadline((async () => {
      const fd = await open(file, 'r')
      try {
        const bytes = Buffer.alloc(65_537)
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0)
        return bytesRead > 65_536 ? null : bytes.subarray(0, bytesRead).toString('utf8')
      } finally { await fd.close() }
    })())
  } catch { return null }
}
async function manager(name: string, path: string, signal: AbortSignal): Promise<string | null> {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const dir of path.split(delimiter).filter(Boolean).slice(0, 200)) {
    for (const name of names) {
      if (signal.aborted) throw new Error('Installation inspection expired')
      const candidate = join(dir, name)
      if (await deadline(access(candidate)).then(() => true, () => false)) return candidate
    }
  }
  return null
}
const folded = (path: string): string => process.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path

export async function inspectAgentInstallation(cli: CodingCliId, path: string, searchPath: string, run = agentCommandRunner(searchPath)): Promise<AgentInstallation> {
  const abort = new AbortController()
  const guarded: AgentCommandRunner = async (...args) => {
    if (abort.signal.aborted) throw new Error('Installation inspection expired')
    const result = await run(...args)
    if (abort.signal.aborted) throw new Error('Installation inspection expired')
    return result
  }
  try { return await deadline(inspectInstallation(cli, path, searchPath, guarded, abort.signal), 20_000) }
  catch { return { cli, path, resolvedPath: path, version: null, method: 'unknown', packageName: null, command: null, runningSessions: 0, reason: 'The installation could not be inspected in time. Check its disk and executable, then retry.' } }
  finally { abort.abort() }
}
async function inspectInstallation(cli: CodingCliId, path: string, searchPath: string, run: AgentCommandRunner, signal: AbortSignal): Promise<AgentInstallation> {
  const info: AgentInstallation = { cli, path, resolvedPath: path, version: null, method: 'unknown', packageName: null, command: null, reason: null, runningSessions: 0 }
  try { info.resolvedPath = await deadline(realpath(path)) }
  catch { return { ...info, reason: 'The installed executable could not be resolved.' } }
  const version = await run(path, ['--version'], 5000)
  info.version = version.ok ? agentVersion(version.output) : null
  if (!info.version) return { ...info, reason: 'The installed version could not be read, so an update cannot be verified.' }
  const canonical = info.resolvedPath.replace(/\\/g, '/')
  const brew = /\/(Cellar|Caskroom)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\//.exec(canonical)
  if (brew) {
    info.method = 'brew'; info.packageName = brew[2]
    const executable = await manager('brew', searchPath, signal)
    if (!executable) return { ...info, reason: 'Homebrew owns this installation, but brew was not found on your PATH.' }
    const prefix = info.resolvedPath.slice(0, info.resolvedPath.replace(/\\/g, '/').indexOf(`/${brew[1]}/`))
    const activePrefix = await run(executable, ['--prefix'], 5000)
    const activeCanonical = activePrefix.ok ? await deadline(realpath(activePrefix.output.trim())).catch(() => null) : null
    if (!activeCanonical || folded(activeCanonical) !== folded(prefix)) return { ...info, reason: 'Your PATH finds a different Homebrew prefix. Use the Homebrew that owns this executable.' }
    const args = ['upgrade', ...(brew[1] === 'Caskroom' ? ['--cask'] : []), brew[2]]
    return { ...info, command: { file: executable, args, label: `brew ${args.join(' ')}` } }
  }
  const packages = agentNpmPackages(cli)
  let packageDir: string | null = null
  let current = dirname(info.resolvedPath)
  for (let depth = 0; depth < 12; depth++) {
    if (signal.aborted) throw new Error('Installation inspection expired')
    const text = await readSmall(join(current, 'package.json'))
    if (text) {
      try {
        const meta = JSON.parse(text) as { name?: unknown }
        if (typeof meta.name === 'string' && packages.includes(meta.name)) { info.packageName = meta.name; packageDir = current; break }
      } catch { /* keep looking, without executing package metadata */ }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // Windows global npm shims sit beside node_modules rather than inside it.
  if (!packageDir && /\.(cmd|bat)$/i.test(path)) {
    const shim = await readSmall(path)
    for (const name of packages) {
      if (signal.aborted) throw new Error('Installation inspection expired')
      if (!shim?.replace(/\\/g, '/').includes(`node_modules/${name}/`)) continue
      const candidate = join(dirname(path), 'node_modules', name)
      const text = await readSmall(join(candidate, 'package.json'))
      try { if (text && JSON.parse(text).name === name) { info.packageName = name; packageDir = candidate; break } } catch { /* not a package */ }
    }
  }
  if (packageDir && info.packageName) {
    if (/\/(?:\.pnpm|\.bun)\//.test(canonical)) return { ...info, reason: 'This installation belongs to pnpm or Bun. Update it with its original package manager.' }
    info.method = 'npm'
    const executable = await manager('npm', searchPath, signal)
    if (!executable) return { ...info, reason: 'npm owns this installation, but npm was not found on your PATH.' }
    const root = await run(executable, ['root', '--global'], 5000)
    let expected: string
    try { expected = await deadline(realpath(join(root.output.trim(), info.packageName))); packageDir = await deadline(realpath(packageDir)) }
    catch { return { ...info, reason: 'The npm on your PATH does not own this installation’s global package.' } }
    if (!root.ok || folded(expected) !== folded(packageDir)) return { ...info, reason: 'The npm on your PATH uses a different global prefix. Use the npm that installed this executable.' }
    const ignoreScripts = cli === 'pi' ? ['--ignore-scripts'] : []
    return { ...info, command: { file: executable, args: ['install', '--global', ...ignoreScripts, `${info.packageName}@latest`], label: `npm install --global ${ignoreScripts.join(' ')} ${info.packageName}@latest`.replace(/\s+/g, ' ') } }
  }
  const command = NATIVE_AGENT_UPDATE[cli]
  if (command) {
    const help = await run(path, ['--help'], 5000)
    if (help.ok && nativeUpdaterInHelp(cli, help.output)) return { ...info, method: 'native', command: { file: path, args: [command], label: `${cli} ${command}` } }
  }
  return { ...info, reason: 'No verified update route was found for this installation. Use its original installer or package manager.' }
}

/** Exit zero is not proof of an update: probe the installed path again. */
export async function runAgentUpdate(info: AgentInstallation, searchPath: string, run = agentCommandRunner(searchPath)): Promise<AgentUpdateResult> {
  if (!info.command || !info.version) return { outcome: 'blocked', before: info.version, after: null, output: '', message: info.reason ?? 'No update route is available.' }
  const result = await run(info.command.file, info.command.args, 180_000)
  const version = await run(info.path, ['--version'], 5000)
  const after = version.ok ? agentVersion(version.output) : null
  const base = { before: info.version, after, output: result.output }
  if (!result.ok) return { ...base, outcome: 'failed', message: result.timedOut ? 'The updater timed out. Inspect the installation before retrying.' : 'The updater failed. Its installed version was checked again.' }
  if (!after) return { ...base, outcome: 'unverified', message: 'The updater exited successfully, but the installed version could not be verified.' }
  if (after === info.version) return { ...base, outcome: 'unchanged', message: `The updater completed; the version remains ${after}. It may already be current.` }
  return { ...base, outcome: 'updated', message: `Installed version changed from ${info.version} to ${after}.` }
}
