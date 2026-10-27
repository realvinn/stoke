import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setPathKey } from './cli.ts'
import { releaseExitedPtyTransports } from './ptyTransportCleanup.ts'
import { ownedPtyExits } from './ptyExitTracker.ts'
import { discoverTerminalShells, terminalEnvironmentPath, type ResolvedTerminalShell } from './terminalShells.ts'
import type { IPty } from '@lydell/node-pty'
import type { ScreenMirror } from './screenMirror.ts'
import type { QuickTerminalFrame, QuickTerminalMode, QuickTerminalShell, QuickTerminalSnapshot, QuickTerminalState, QuickTerminalSurface } from '../shared/quickTerminal.ts'

type Runtime = { spawn: typeof import('@lydell/node-pty').spawn; mirror: (cols: number, rows: number) => ScreenMirror }
interface Options {
  enabled: () => boolean
  onState: (state: QuickTerminalState) => void
  onData: (frame: QuickTerminalFrame) => void
  /** Injected only by the native shell suite. */
  runtime?: () => Promise<Runtime>
  environment?: () => Promise<Record<string, string>>
  shells?: () => Promise<ResolvedTerminalShell[]>
}

const STRIP = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS', 'GDK_BACKEND', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'c28fc6f98a2c44abbbd89d6a3037d0d9_POSIX_FD_STATE', 'c28fc6f98a2c44abbbd89d6a3037d0d9_POSIX_CHROOT'])
export function quickTerminalEnv(source: NodeJS.ProcessEnv, path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) if (value !== undefined && !STRIP.has(key)) env[key] = value
  setPathKey(env, path)
  // Stoke's terminal is always UTF-8, but a Dock or Finder launch hands main no
  // locale at all. In the C locale bash's readline has convert-meta on, so every
  // typed or pasted byte >= 0x80 became a Meta key (0xF0, an emoji's first byte,
  // is M-p: a history search) and the line never ran. zsh inserts the bytes, so
  // only bash showed it. LANG rather than LC_CTYPE=UTF-8, which is no locale on
  // Linux; an explicit locale of the user's is kept.
  if (process.platform !== 'win32' && !env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor'; env.TERM_PROGRAM = 'Stoke'
  // No selected provider keys, MCP, agent hooks or config-home overlays.
  return env
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The shell could not prepare within five seconds.')), 5000) })]) }
  finally { clearTimeout(timer) }
}
/** One owned process and replay buffer, retained when another shell is selected. */
class QuickTerminalSession {
  private options: Options & { shell: () => Promise<ResolvedTerminalShell>; shellId: string }
  private child: IPty | null = null
  private mirror: ScreenMirror | null = null
  private sequence = 0
  private preparing: object | null = null
  private cancelStart = false
  private disposed = false
  private killed: ReturnType<typeof setTimeout> | undefined
  private state: Omit<QuickTerminalState, 'enabled' | 'shellId' | 'sessions' | 'contextId' | 'pinned'> = { revision: 0, id: null, phase: 'idle', mode: 'hidden', cwd: '', shell: '', cols: 80, rows: 24, exitCode: null }
  constructor(options: Options & { shell: () => Promise<ResolvedTerminalShell>; shellId: string }) { this.options = options }
  view(): QuickTerminalState { return { ...this.state, enabled: this.options.enabled(), shellId: this.options.shellId, sessions: [], contextId: null, pinned: false } }
  snapshot(): QuickTerminalSnapshot { return { state: this.view(), sequence: this.sequence, data: this.mirror?.snapshot() ?? '' } }
  private changed(): void { this.state.revision++; this.options.onState(this.view()) }
  refreshSettings(): void { this.changed() }
  async open(mode: QuickTerminalSurface, cwd?: string): Promise<QuickTerminalState> {
    if (this.disposed) throw new Error('The Stoke window is closing.')
    if (!this.options.enabled()) throw new Error('The quick terminal is unavailable.')
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
          this.options.shell().then(async shell => { if (!(await stat(shell.path)).isFile()) throw new Error('The selected shell is unavailable.'); await access(shell.path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return shell }), this.options.environment?.() ?? terminalEnvironmentPath().then(path => quickTerminalEnv(process.env, path)),
          this.options.runtime?.() ?? Promise.all([import('@lydell/node-pty'), import('./screenMirror.ts')]).then(([pty, screen]) => ({ spawn: pty.spawn, mirror: (cols: number, rows: number) => new screen.ScreenMirror(cols, rows) }))
        ])
        return { folder, shell, env, runtime }
      }
      const { folder, shell, env, runtime } = await bounded(prepare())
      if (this.disposed || this.cancelStart || !this.options.enabled()) throw new Error('The shell opening was cancelled.')
      const mirror = runtime.mirror(80, 24)
      const id = randomUUID()
      let child: IPty
      try { child = runtime.spawn(shell.path, shell.args, { cwd: folder, env, cols: 80, rows: 24, name: 'xterm-256color' }) }
      catch (error) { mirror.dispose(); throw error }
      ownedPtyExits.track(child)
      this.mirror?.dispose(); this.mirror = mirror; this.sequence = 0
      this.child = child
      this.state = { ...this.state, id, cwd: folder, shell: shell.path, phase: 'running', cols: 80, rows: 24, exitCode: null }
      child.onData(data => { if (this.state.id !== id) return; this.mirror?.write(data); this.sequence++; this.options.onData({ id, sequence: this.sequence, data }) })
      child.onExit(event => {
        releaseExitedPtyTransports(child)
        if (this.child !== child) return
        clearTimeout(this.killed); this.killed = undefined; this.child = null
        this.state.phase = 'exited'; this.state.exitCode = event.exitCode; this.changed()
        if (this.disposed) { this.mirror?.dispose(); this.mirror = null }
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

/** Machine-local shells only; agent credentials and SSH sessions stay separate. */
class QuickTerminalBank {
  private readonly options: Options
  private readonly sessions = new Map<string, QuickTerminalSession>()
  private active: QuickTerminalSession
  private catalog: Promise<ResolvedTerminalShell[]> | null = null
  private revision = 0
  private operation: { cancelled: boolean; done: Promise<void>; finish: () => void } | null = null
  private disposed = false
  constructor(options: Options) {
    this.options = options
    this.active = this.create('default', async () => {
      const shell = (await this.installed()).find(item => item.id === 'default')
      if (!shell) throw new Error('The default local shell is unavailable.')
      return shell
    })
  }
  private installed(): Promise<ResolvedTerminalShell[]> {
    if (!this.catalog) {
      const mine = bounded(this.options.shells?.() ?? discoverTerminalShells())
      this.catalog = mine
      void mine.catch(() => { if (this.catalog === mine) this.catalog = null })
    }
    return this.catalog
  }
  async shells(): Promise<QuickTerminalShell[]> { return (await this.installed()).map(({ id, label, path }) => ({ id, label, path })) }
  private create(shellId: string, shell: () => Promise<ResolvedTerminalShell>): QuickTerminalSession {
    let session: QuickTerminalSession
    session = new QuickTerminalSession({ ...this.options, shellId, shell,
      onState: () => this.changed(),
      onData: frame => { if (this.active === session) this.options.onData(frame) }
    })
    this.sessions.set(shellId, session)
    return session
  }
  view(): QuickTerminalState {
    return { ...this.active.view(), revision: this.revision, sessions: [...this.sessions].flatMap(([shellId, session]) => {
      const state = session.view()
      return state.id ? [{ shellId, id: state.id, phase: state.phase }] : []
    }) }
  }
  snapshot(): QuickTerminalSnapshot { return { ...this.active.snapshot(), state: this.view() } }
  private changed(): void { this.revision++; this.options.onState(this.view()) }
  refreshSettings(): void { this.changed() }
  private claim(): { cancelled: boolean; done: Promise<void>; finish: () => void } {
    if (this.disposed) throw new Error('The Stoke window is closing.')
    if (!this.options.enabled()) throw new Error('The quick terminal is unavailable.')
    if (this.operation) throw new Error('Wait for the current shell operation to finish.')
    let finish = (): void => {}
    const mine = { cancelled: false, done: new Promise<void>(resolve => { finish = resolve }), finish: () => finish() }
    this.operation = mine; return mine
  }
  private check(mine: { cancelled: boolean }): void {
    if (mine.cancelled || this.disposed || !this.options.enabled()) throw new Error('The shell opening was cancelled.')
  }
  async open(mode: QuickTerminalSurface, cwd?: string): Promise<QuickTerminalState> {
    const mine = this.claim()
    try { await this.active.open(mode, cwd); this.check(mine); return this.view() }
    finally { if (this.operation === mine) this.operation = null; mine.finish() }
  }
  async selectShell(surface: QuickTerminalSurface, shellId: string): Promise<QuickTerminalState> {
    const mine = this.claim()
    let target: QuickTerminalSession | undefined
    let created = false
    try {
      if (this.active.view().mode !== surface) throw new Error('Use the current terminal view to switch shells.')
      if (typeof shellId !== 'string') throw new Error('Choose an installed shell.')
      const shell = (await this.installed()).find(item => item.id === shellId)
      this.check(mine)
      if (!shell) throw new Error('This shell is unavailable. Choose an installed shell.')
      if (shellId === this.active.view().shellId) return this.view()
      target = this.sessions.get(shellId)
      if (!target) { target = this.create(shellId, async () => shell); created = true }
      await target.open(surface, this.active.view().cwd || undefined)
      this.check(mine)
      const previous = this.active
      this.active = target
      previous.move('hidden')
      this.changed()
      return this.view()
    } catch (error) {
      if (created && target) { target.dispose(); this.sessions.delete(shellId); this.changed() }
      throw error
    } finally { if (this.operation === mine) this.operation = null; mine.finish() }
  }
  move(mode: QuickTerminalMode): QuickTerminalState {
    if (this.disposed && mode !== 'hidden') throw new Error('The Stoke window is closing.')
    if (this.operation && mode !== 'hidden') throw new Error('Wait for the current shell operation to finish.')
    this.active.move(mode)
    // A hidden view also cancels a pending selection, so it cannot reopen itself later.
    if (mode === 'hidden' && this.operation) { this.operation.cancelled = true; for (const session of this.sessions.values()) if (session.view().phase === 'starting') session.end() }
    return this.view()
  }
  async restart(surface: QuickTerminalSurface): Promise<QuickTerminalState> {
    const mine = this.claim()
    try { await this.active.restart(surface); this.check(mine); return this.view() }
    finally { if (this.operation === mine) this.operation = null; mine.finish() }
  }
  write(surface: QuickTerminalSurface, id: string, data: string): void { this.active.write(surface, id, data) }
  resize(surface: QuickTerminalSurface, id: string, cols: number, rows: number): void { this.active.resize(surface, id, cols, rows) }
  end(): QuickTerminalState {
    if (this.operation) this.operation.cancelled = true
    for (const session of this.sessions.values()) if (session.view().phase === 'starting') session.end()
    this.active.end(); return this.view()
  }
  disable(): void {
    if (this.operation) this.operation.cancelled = true
    for (const session of this.sessions.values()) session.disable()
  }
  dispose(): void {
    this.disposed = true
    if (this.operation) this.operation.cancelled = true
    for (const session of this.sessions.values()) session.dispose()
  }
  whenIdle(): Promise<void> { return this.operation?.done ?? Promise.resolve() }
  isBusy(): boolean { return this.operation !== null }
}

interface TerminalContext { id: string | null; cwd?: string; bank: QuickTerminalBank }

/** Each tab keeps its own shell bank. Pinning retains the current visible bank. */
export class QuickTerminal {
  private readonly options: Options
  private readonly contexts = new Map<string | null, TerminalContext>()
  private active: TerminalContext
  private desired: { id: string | null; cwd?: string } = { id: null }
  private pinned = false
  private mode: QuickTerminalMode = 'hidden'
  private revision = 0
  private epoch = 0
  private disposed = false
  private liveContexts: ReadonlySet<string> | null = null
  private catalog: Promise<ResolvedTerminalShell[]> | null = null
  constructor(options: Options) { this.options = options; this.active = this.create(null) }
  private installed(): Promise<ResolvedTerminalShell[]> {
    if (!this.catalog) {
      const mine = bounded(this.options.shells?.() ?? discoverTerminalShells())
      this.catalog = mine
      void mine.catch(() => { if (this.catalog === mine) this.catalog = null })
    }
    return this.catalog
  }
  private create(id: string | null): TerminalContext {
    const entry: TerminalContext = { id, bank: undefined! }
    entry.bank = new QuickTerminalBank({ ...this.options, shells: () => this.installed(),
      onState: () => { if (this.active === entry) this.changed() },
      onData: frame => { if (this.active === entry) this.options.onData(frame) }
    })
    this.contexts.set(id, entry)
    return entry
  }
  view(): QuickTerminalState { const state = this.active.bank.view(); return { ...state, cwd: state.cwd || this.active.cwd || '', mode: this.mode, revision: this.revision, contextId: this.active.id, pinned: this.pinned } }
  snapshot(): QuickTerminalSnapshot { return { ...this.active.bank.snapshot(), state: this.view() } }
  private changed(): void { this.revision++; this.options.onState(this.view()) }
  private validate(id: string | null, cwd?: string): void {
    if (this.disposed) throw new Error('The Stoke window is closing.')
    if (id !== null && (typeof id !== 'string' || !id || id.length > 512 || /[\x00-\x1f]/.test(id))) throw new Error('Choose a tab for the terminal.')
    if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 8192 || cwd.includes('\0'))) throw new Error('Choose a local folder for the shell.')
  }
  private async selectContext(): Promise<QuickTerminalState> {
    const { id, cwd } = this.desired
    let target = this.contexts.get(id)
    if (!target) target = this.create(id)
    target.cwd = cwd
    if (target === this.active) return this.view()
    const mode = this.mode
    const mine = ++this.epoch
    this.active.bank.move('hidden')
    this.active = target
    this.changed()
    if (mode !== 'hidden') {
      try {
        await target.bank.whenIdle()
        if (mine !== this.epoch || this.disposed) return this.view()
        await target.bank.open(mode, target.cwd)
      } catch (error) { if (mine === this.epoch) throw error }
    }
    return this.view()
  }
  async context(id: string | null, cwd?: string): Promise<QuickTerminalState> {
    this.validate(id, cwd)
    this.desired = { id, cwd }
    if (this.pinned) return this.view()
    return this.selectContext()
  }
  async pin(pinned: boolean): Promise<QuickTerminalState> {
    if (this.disposed) throw new Error('The Stoke window is closing.')
    if (typeof pinned !== 'boolean') throw new Error('Choose whether to pin the terminal.')
    if (this.pinned === pinned) return this.view()
    this.pinned = pinned; this.changed()
    if (!pinned) {
      try { await this.selectContext() }
      finally { if (this.liveContexts) this.retainContexts(this.liveContexts) }
    }
    return this.view()
  }
  async open(mode: QuickTerminalSurface, cwd?: string, contextId?: string | null): Promise<QuickTerminalState> {
    if (contextId !== undefined) {
      const selecting = this.context(contextId, cwd)
      const expected = this.active
      const expectedEpoch = this.epoch
      await selecting
      if (expected !== this.active || expectedEpoch !== this.epoch) throw new Error('The shell opening was cancelled.')
    }
    const target = this.active
    const mine = this.epoch
    if (this.disposed) throw new Error('The Stoke window is closing.')
    if (mine !== this.epoch || target !== this.active) return this.view()
    if (target.bank.isBusy()) throw new Error('Wait for the current shell operation to finish.')
    const previousMode = this.mode
    this.mode = mode
    try { await target.bank.open(mode, this.pinned ? target.cwd : cwd ?? target.cwd) }
    catch (error) { if (mine === this.epoch) { this.mode = previousMode; this.changed() }; throw error }
    return this.view()
  }
  async selectShell(surface: QuickTerminalSurface, shellId: string): Promise<QuickTerminalState> { const target = this.active; await target.bank.selectShell(surface, shellId); return this.view() }
  shells(): Promise<QuickTerminalShell[]> { return this.active.bank.shells() }
  move(mode: QuickTerminalMode): QuickTerminalState { if (mode === 'hidden') this.epoch++; this.active.bank.move(mode); this.mode = mode; this.changed(); return this.view() }
  async restart(surface: QuickTerminalSurface): Promise<QuickTerminalState> {
    const target = this.active, mine = this.epoch
    if (target.bank.isBusy()) throw new Error('Wait for the current shell operation to finish.')
    const previousMode = this.mode
    this.mode = surface
    try {
      // An idle bank has never resolved a shell cwd; retry its tab folder rather
      // than the session's empty cwd. Ended shells retain their original cwd.
      if (target.bank.view().phase === 'idle') await target.bank.open(surface, target.cwd)
      else await target.bank.restart(surface)
    }
    catch (error) { if (mine === this.epoch) { this.mode = previousMode; this.changed() }; throw error }
    return this.view()
  }
  write(surface: QuickTerminalSurface, id: string, data: string): void { this.active.bank.write(surface, id, data) }
  resize(surface: QuickTerminalSurface, id: string, cols: number, rows: number): void { this.active.bank.resize(surface, id, cols, rows) }
  end(): QuickTerminalState { this.epoch++; this.active.bank.end(); return this.view() }
  refreshSettings(): void { this.changed() }
  /** Main supplies live tabs plus pending transfer reservations across windows. */
  retainContexts(ids: ReadonlySet<string>): void {
    this.liveContexts = new Set(ids)
    for (const [id, entry] of this.contexts) {
      if (id === null || ids.has(id) || this.pinned && entry === this.active) continue
      this.contexts.delete(id)
      entry.bank.dispose()
      if (entry === this.active) {
        this.epoch++; this.desired = { id: null }; this.active = this.contexts.get(null) ?? this.create(null)
        this.active.bank.move('hidden'); this.changed()
      }
    }
  }
  disable(): void { this.epoch++; this.mode = 'hidden'; for (const entry of this.contexts.values()) entry.bank.disable() }
  dispose(): void { this.disposed = true; this.epoch++; this.mode = 'hidden'; for (const entry of this.contexts.values()) entry.bank.dispose() }
}
