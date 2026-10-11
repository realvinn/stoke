import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { posix, win32 } from 'node:path'
import { buildEnvPath } from './cli.ts'
import type { QuickTerminalShell } from '../shared/quickTerminal.ts'

export interface ResolvedTerminalShell extends QuickTerminalShell { args: string[] }
interface Candidate { id: string; paths: string[] }

/** Shell-specific arguments matter even when a custom shell is the OS default. */
export function terminalShellArgs(path: string): string[] {
  const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.exe$/, '')
  if (name === 'cmd') return ['/d']
  if (name === 'powershell' || name === 'pwsh') return ['-NoLogo']
  return ['-l']
}
function shellLabel(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.exe$/, '')
  return ({ cmd: 'Command Prompt', powershell: 'Windows PowerShell', pwsh: 'PowerShell 7', zsh: 'Zsh', bash: 'Bash', sh: 'Sh' } as Record<string, string>)[name ?? ''] ?? name ?? 'Shell'
}

export function terminalShellCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, path: string): Candidate[] {
  const p = platform === 'win32' ? win32 : posix
  const directories = path.split(platform === 'win32' ? ';' : ':').map(dir => dir.replace(/^"(.*)"$/, '$1')).filter(dir => p.isAbsolute(dir))
  const onPath = (name: string): string[] => directories.map(dir => p.join(dir, name))
  if (platform === 'win32') {
    const root = env.SystemRoot || 'C:\\Windows'
    const programFiles = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter((dir): dir is string => !!dir && p.isAbsolute(dir))
    const cmd = p.join(root, 'System32', 'cmd.exe')
    const powershell = p.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const gitRoots = [...programFiles.map(dir => p.join(dir, 'Git')), ...(env.LOCALAPPDATA ? [p.join(env.LOCALAPPDATA, 'Programs', 'Git')] : [])]
    return [
      { id: 'default', paths: [env.ComSpec ?? env.COMSPEC ?? '', cmd] },
      { id: 'cmd', paths: [cmd] },
      { id: 'powershell', paths: [powershell, ...onPath('powershell.exe')] },
      { id: 'pwsh', paths: [...onPath('pwsh.exe'), ...programFiles.map(dir => p.join(dir, 'PowerShell', '7', 'pwsh.exe'))] },
      { id: 'git-bash', paths: [...gitRoots.flatMap(dir => [p.join(dir, 'bin', 'bash.exe'), p.join(dir, 'usr', 'bin', 'bash.exe')]), ...directories.map(dir => p.join(dir, '..', 'bin', 'bash.exe'))] }
    ]
  }
  return [
    { id: 'default', paths: [env.SHELL ?? '', platform === 'darwin' ? '/bin/zsh' : '/bin/sh'] },
    { id: 'zsh', paths: [...onPath('zsh'), '/bin/zsh'] },
    { id: 'bash', paths: [...onPath('bash'), '/bin/bash'] },
    { id: 'sh', paths: ['/bin/sh'] },
    { id: 'pwsh', paths: onPath('pwsh') }
  ]
}

/** Only installed, absolute executables from this catalog can cross the shell picker. */
export async function discoverTerminalShells(input?: {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; path: string
  usable?: (path: string) => Promise<boolean>
  canonical?: (path: string) => Promise<string>
}): Promise<ResolvedTerminalShell[]> {
  const platform = input?.platform ?? process.platform
  const env = input?.env ?? process.env
  const path = input?.path ?? await buildEnvPath()
  const p = platform === 'win32' ? win32 : posix
  const canonical = input?.canonical ?? realpath
  const usable = input?.usable ?? (async (file: string) => {
    try { if (!(await stat(file)).isFile()) return false; await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return true } catch { return false }
  })
  const matches = await Promise.all(terminalShellCandidates(platform, env, path).map(async candidate => {
    for (const file of [...new Set(candidate.paths)]) {
      if (!p.isAbsolute(file) || file.includes('\0') || !await usable(file)) continue
      let resolved: string
      try { resolved = await canonical(file) } catch { continue }
      return { shell: { id: candidate.id, path: file, label: candidate.id === 'git-bash' ? 'Git Bash' : shellLabel(file), args: terminalShellArgs(file) }, resolved }
    }
    return null
  }))
  if (!matches[0]) throw new Error('The default local shell is unavailable.')
  const seen = new Set<string>()
  return matches.flatMap(match => {
    if (!match) return []
    const key = platform === 'win32' ? p.normalize(match.resolved).toLowerCase() : p.normalize(match.resolved)
    if (seen.has(key)) return []
    seen.add(key)
    const shell = match.shell
    if (shell.id === 'default') shell.label += ' (Default)'
    return [shell]
  })
}
