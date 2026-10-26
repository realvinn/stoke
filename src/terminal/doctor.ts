import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { CODING_CLIS } from '../shared/codingClis.ts'
import { configPath, readConfig, terminalHome } from './config.ts'
import { executableFor } from './sessionMeta.ts'
import { TERMINAL_TARGETS, findExecutable } from './platform.ts'
import { processAlive, readServerInfo } from './sessionProtocol.ts'

export async function doctor(): Promise<{ ok: boolean; platform: string; arch: string; node: string; checks: { name: string; status: 'ok' | 'warning' | 'error'; message: string }[] }> {
  const checks: { name: string; status: 'ok' | 'warning' | 'error'; message: string }[] = []
  const target = TERMINAL_TARGETS.find((entry) => entry.platform === process.platform && entry.arch === process.arch)
  checks.push({ name: 'Platform', status: target ? 'ok' : 'error', message: target?.label || 'Supported builds: macOS, Windows and glibc Linux on x64 or ARM64.' })
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  if (process.platform === 'linux') checks.push({ name: 'Linux runtime', status: header?.glibcVersionRuntime ? 'ok' : 'error', message: header?.glibcVersionRuntime ? `glibc ${header.glibcVersionRuntime}` : 'This release targets glibc Linux. Alpine/musl needs a separate build.' })
  let config
  try { config = readConfig(); checks.push({ name: 'Configuration', status: 'ok', message: configPath() }) }
  catch { checks.push({ name: 'Configuration', status: 'error', message: `Invalid or unreadable configuration at ${configPath()}. Correct it before starting chats.` }) }
  try {
    const { spawn } = createRequire(resolve(process.argv[1] || 'stoke.cjs'))('@lydell/node-pty') as typeof import('@lydell/node-pty')
    const status = await new Promise<boolean>((resolve) => {
      let output = ''
      const env = { ...process.env }; delete env.NODE_OPTIONS
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("stoke-pty-ok")'], { cols: 80, rows: 24, env })
      const timer = setTimeout(() => { try { child.kill() } catch { /* exited */ }; resolve(false) }, 5000)
      child.onData((data) => { output += data })
      child.onExit(({ exitCode }) => { clearTimeout(timer); resolve(exitCode === 0 && output.includes('stoke-pty-ok')) })
    })
    checks.push({ name: 'Terminal engine', status: status ? 'ok' : 'error', message: status ? 'Native PTY spawned and exchanged output.' : 'Native PTY did not complete. Reinstall the release for this architecture.' })
  } catch { checks.push({ name: 'Terminal engine', status: 'error', message: 'The native PTY module could not load. Reinstall this architecture’s release; npm installs must include optional dependencies.' }) }
  if (config) for (const cli of CODING_CLIS) {
    const file = executableFor(cli.id, config)
    if (file || cli.id === config.agent) checks.push({ name: cli.label, status: file ? 'ok' : 'warning', message: file || `Not on PATH. Install it from ${cli.home} or configure agents.${cli.id}.executable.` })
  }
  checks.push({ name: 'SSH', status: findExecutable(['ssh', 'ssh.exe']) ? 'ok' : 'warning', message: findExecutable(['ssh', 'ssh.exe']) || 'SSH connections need an OpenSSH client on PATH.' })
  const info = readServerInfo(terminalHome())
  checks.push({ name: 'Session service', status: info && processAlive(info.pid) ? 'ok' : 'warning', message: info && processAlive(info.pid) ? 'Running locally; no network listener.' : 'Not running. Stoke starts it when needed.' })
  checks.push({ name: 'Terminal', status: 'ok', message: `${process.env.TERM_PROGRAM || process.env.TERM || 'unspecified'}; ${process.stdout.isTTY ? 'interactive' : 'noninteractive'}; ${process.env.NO_COLOR !== undefined ? 'colors disabled' : 'colors enabled'}` })
  return { ok: !checks.some((check) => check.status === 'error'), platform: process.platform, arch: process.arch, node: process.versions.node, checks }
}
