import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildEnvPath, setPathKey } from './cli.ts'
import { releaseExitedPtyTransports } from './ptyTransportCleanup.ts'
import { ownedPtyExits } from './ptyExitTracker.ts'
import type { IPty } from '@lydell/node-pty'
import type { ScreenMirror } from './screenMirror.ts'
import type { QuickTerminalFrame, QuickTerminalMode, QuickTerminalSnapshot, QuickTerminalState, QuickTerminalSurface } from '../shared/quickTerminal.ts'

type Runtime = { spawn: typeof import('@lydell/node-pty').spawn; mirror: (cols: number, rows: number) => ScreenMirror }
interface Options {
  enabled: () => boolean
  onState: (state: QuickTerminalState) => void
  onData: (frame: QuickTerminalFrame) => void
  /** Injected only by the native shell suite. */
  runtime?: () => Promise<Runtime>
  environment?: () => Promise<Record<string, string>>
}

const STRIP = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS', 'GDK_BACKEND', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'c28fc6f98a2c44abbbd89d6a3037d0d9_POSIX_FD_STATE', 'c28fc6f98a2c44abbbd89d6a3037d0d9_POSIX_CHROOT'])
export function quickTerminalEnv(source: NodeJS.ProcessEnv, path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) if (value !== undefined && !STRIP.has(key)) env[key] = value
  setPathKey(env, path)
  env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor'; env.TERM_PROGRAM = 'Stoke'
  // No selected provider keys, MCP, agent hooks or config-home overlays.
  return env
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The shell could not prepare within five seconds.')), 5000) })]) }
  finally { clearTimeout(timer) }
}
async function shellPath(): Promise<string> {
  const preferred = process.platform === 'win32' ? process.env.ComSpec ?? process.env.COMSPEC : process.env.SHELL
  const fallback = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
  if (preferred && isAbsolute(preferred)) {
    try { if ((await stat(preferred)).isFile()) { await access(preferred, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return preferred } } catch { /* use the platform shell */ }
  }
  await access(fallback, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  return fallback
}

/** One local shell, separate from agents, history, Work and remote sharing. */
export class QuickTerminal {
  private options: Options
  private child: IPty | null = null
  private mirror: ScreenMirror | null = null
  private sequence = 0
  private preparing: object | null = null
  private cancelStart = false
  private disposed = false
  private killed: ReturnType<typeof setTimeout> | undefined
  private state: Omit<QuickTerminalState, 'enabled'> = { revision: 0, id: null, phase: 'idle', mode: 'hidden', cwd: '', shell: '', cols: 80, rows: 24, exitCode: null }
  constructor(options: Options) { this.options = options }
  view(): QuickTerminalState { return { ...this.state, enabled: this.options.enabled() } }
  snapshot(): QuickTerminalSnapshot { return { state: this.view(), sequence: this.sequence, data: this.mirror?.snapshot() ?? '' } }
  private changed(): void { this.state.revision++; this.options.onState(this.view()) }
  refreshSettings(): void { this.changed() }
  async open(mode: QuickTerminalSurface, cwd?: string): Promise<QuickTerminalState> {
    if (this.disposed) throw new Error('The Stoke window is closing.')
    if (!this.options.enabled()) throw new Error('Enable Quick terminal in Appearance settings first.')
    if (this.preparing || this.state.phase === 'stopping') throw new Error('Wait for the current shell operation to finish.')
    if (this.state.id) return this.move(mode)
    return this.start(mode, cwd)
  }
  private async start(mode: QuickTerminalSurface, cwd?: string): Promise<QuickTerminalState> {
    const previous = { ...this.state }
    const mine = {}; this.preparing = mine; this.cancelStart = false
    this.state.phase = 'starting'; this.state.mode = mode; this.changed()
    try {
      if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 8192 || cwd.includes('\0'))) throw new Error('Choose a local folder for the shell.')
      const prepare = async () => {
        const [folder, shell, env, runtime] = await Promise.all([
          realpath(cwd || homedir()).then(async path => { if (!(await stat(path)).isDirectory()) throw new Error('The shell folder is unavailable.'); return path }),
          shellPath(), this.options.environment?.() ?? buildEnvPath().then(path => quickTerminalEnv(process.env, path)),
          this.options.runtime?.() ?? Promise.all([import('@lydell/node-pty'), import('./screenMirror.ts')]).then(([pty, screen]) => ({ spawn: pty.spawn, mirror: (cols: number, rows: number) => new screen.ScreenMirror(cols, rows) }))
        ])
        return { folder, shell, env, runtime }
      }
      const { folder, shell, env, runtime } = await bounded(prepare())
      if (this.disposed || this.cancelStart || !this.options.enabled()) throw new Error('The shell opening was cancelled.')
      const mirror = runtime.mirror(80, 24)
      const id = randomUUID()
      let child: IPty
      try { child = runtime.spawn(shell, process.platform === 'win32' ? ['/d'] : ['-l'], { cwd: folder, env, cols: 80, rows: 24, name: 'xterm-256color' }) }
      catch (error) { mirror.dispose(); throw error }
      ownedPtyExits.track(child)
      this.mirror?.dispose(); this.mirror = mirror; this.sequence = 0
      this.child = child
      this.state = { ...this.state, id, cwd: folder, shell, phase: 'running', cols: 80, rows: 24, exitCode: null }
      child.onData(data => { if (this.state.id !== id) return; this.mirror?.write(data); this.sequence++; this.options.onData({ id, sequence: this.sequence, data }) })
      child.onExit(event => {
        releaseExitedPtyTransports(child)
        if (this.child !== child) return
        clearTimeout(this.killed); this.killed = undefined; this.child = null
        this.state.phase = 'exited'; this.state.exitCode = event.exitCode; this.changed()
      })
      this.changed(); return this.view()
    } catch (err) { this.state = { ...previous, revision: this.state.revision, mode: previous.id ? this.state.mode : 'hidden' }; this.changed(); throw err }
    finally { if (this.preparing === mine) this.preparing = null }
  }
  move(mode: QuickTerminalMode): QuickTerminalState {
    if (mode !== 'hidden' && mode !== 'panel' && mode !== 'popout') throw new Error('Choose a terminal view.')
    if (!this.options.enabled() && mode !== 'hidden') throw new Error('Quick terminal is disabled.')
    this.state.mode = mode; this.changed(); return this.view()
  }
  async restart(surface: QuickTerminalSurface): Promise<QuickTerminalState> {
    if (this.disposed) throw new Error('The Stoke window is closing.')
    if (!this.options.enabled()) throw new Error('Quick terminal is disabled.')
    if (this.child || this.preparing) throw new Error('End the existing shell before starting another.')
    if (this.state.phase === 'stopping') throw new Error('Wait for the shell to exit.')
    return this.start(surface, this.state.cwd || undefined)
  }
  write(surface: QuickTerminalSurface, id: string, data: string): void {
    if (!this.options.enabled() || this.state.mode !== surface || this.state.id !== id || this.state.phase !== 'running' || typeof data !== 'string' || data.length > 256_000) return
    try { this.child?.write(data) } catch { /* an exit may win */ }
  }
  resize(surface: QuickTerminalSurface, id: string, cols: number, rows: number): void {
    if (!this.options.enabled() || this.state.mode !== surface || this.state.id !== id || !this.child || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) return
    if (cols === this.state.cols && rows === this.state.rows) return
    try { this.child.resize(cols, rows); this.mirror?.resize(cols, rows); this.state.cols = cols; this.state.rows = rows } catch { /* an exit may win */ }
  }
  end(): QuickTerminalState {
    this.cancelStart = true
    const child = this.child
    if (child && this.state.phase !== 'stopping') {
      this.state.phase = 'stopping'; this.changed()
      try { child.kill() } catch { /* retain ownership until onExit */ }
      this.killed = setTimeout(() => { if (this.child === child) { try { child.kill('SIGKILL') } catch { /* onExit owns release */ } } }, 2000)
      this.killed.unref()
    }
    return this.view()
  }
  disable(): void { this.end(); this.state.mode = 'hidden'; this.changed() }
  dispose(): void { this.disposed = true; this.disable(); if (!this.child) { this.mirror?.dispose(); this.mirror = null } }
}
