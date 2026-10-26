import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { ScreenMirror } from '../main/screenMirror.ts'
import type { CodingCliId } from '../shared/codingClis.ts'
import { configPath, terminalHome, type TerminalConfig } from './config.ts'
import { createChat, executableFor, launchArgs, type Chat } from './sessionMeta.ts'
import { MAX_SESSION_FRAME, processAlive, readServerInfo } from './sessionProtocol.ts'
import { verifyAgentIdentity } from './agentAdapter.ts'

export interface LiveChat {
  chat: Chat
  pty: { write(data: string): void; resize(cols: number, rows: number): void; kill(): void }
  screen: ScreenMirror
  exited: boolean
  exitCode?: number
}
interface Snapshot { chat: Chat; exited: boolean; exitCode?: number; cols: number; rows: number; snapshot: string }

/** UI-side session handles. The private local service owns real PTYs, so a
 * UI can close and another can reattach without creating duplicate agents. */
export class Sessions {
  readonly live = new Map<string, LiveChat>()
  private readonly output: (session: LiveChat, data: string) => void
  private readonly exited: (session: LiveChat) => void
  private readonly home: string
  private socket: Socket | null = null
  private token = ''
  private sequence = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; apply?: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
  private connecting: Promise<boolean> | null = null
  private closed = false
  private starting = new Map<string, Promise<unknown>>()

  constructor(output: (session: LiveChat, data: string) => void, exited: (session: LiveChat) => void, home = terminalHome()) {
    this.output = output; this.exited = exited; this.home = resolve(home)
  }
  create(agent: CodingCliId, cwd: string, model: string, prompt = ''): Chat { return createChat(agent, cwd, model, prompt) }

  ready(start = true): Promise<boolean> {
    this.connecting ??= this.connect(start)
    return this.connecting
  }
  private async connect(start: boolean): Promise<boolean> {
    let spawned = false
    for (let attempt = 0; attempt < 100 && !this.closed; attempt++) {
      const info = readServerInfo(this.home)
      if (info && processAlive(info.pid)) {
        try {
          await new Promise<void>((resolve, reject) => {
            const socket = createConnection(info.endpoint)
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('The local session service did not answer.')) }, 500)
            socket.once('error', reject)
            socket.once('connect', () => { clearTimeout(timer); this.socket = socket; resolve() })
          })
          this.token = info.token
          this.listen(this.socket!)
          await this.request('list', {}, (value) => { for (const record of value as Snapshot[]) this.add(record) })
          return true
        } catch { this.socket?.destroy(); this.socket = null }
      }
      if (!start) return false
      if (!spawned) {
        mkdirSync(this.home, { recursive: true, mode: 0o700 })
        const log = openSync(join(this.home, 'server.log'), 'w', 0o600)
        const entry = process.argv[1]
        if (!entry) { closeSync(log); throw new Error('The CLI entry point could not be located for the session service.') }
        const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', resolve(entry), '--internal-session-server'], {
          cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log, log],
          env: { ...process.env, STOKE_TERMINAL_HOME: this.home }
        })
        child.on('error', () => undefined); child.unref(); closeSync(log)
        spawned = true
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`The local session service did not start. See ${join(this.home, 'server.log')} or run stoke doctor.`)
  }

  private listen(socket: Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The local session service disconnected.')) }
      this.pending.clear()
      if (!this.closed) for (const session of this.live.values()) if (!session.exited) {
        this.output(session, '\r\nStoke lost its local session connection. Restart Stoke to reattach.\r\n')
        session.exited = true; this.exited(session)
      }
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_SESSION_FRAME) { socket.destroy(); return }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let message: Record<string, unknown>
        try { message = JSON.parse(line) } catch { socket.destroy(); return }
        if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id)
          if (!pending) continue
          this.pending.delete(message.id); clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(String(message.error)))
          else { pending.apply?.(message.result); pending.resolve(message.result) }
        } else if (message.event === 'created') this.add(message as unknown as Snapshot)
        else {
          const session = this.live.get(String(message.session))
          if (!session) continue
          if (message.event === 'output' && typeof message.data === 'string') { session.screen.write(message.data); this.output(session, message.data) }
          else if (message.event === 'resize') session.screen.resize(Number(message.cols), Number(message.rows))
          else if (message.event === 'exit') { session.exited = true; session.exitCode = Number(message.exitCode); this.exited(session) }
        }
      }
    })
  }
  private request(command: string, data: Record<string, unknown> = {}, apply?: (value: unknown) => void): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('The local session service is not connected.'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The local session service timed out during ${command}.`)) }, 10_000)
      this.pending.set(id, { resolve, reject, apply, timer })
      this.socket!.write(JSON.stringify({ id, token: this.token, command, ...data }) + '\n')
    })
  }
  private add(record: Snapshot): LiveChat {
    const existing = this.live.get(record.chat.id)
    if (existing && !existing.exited) return existing
    existing?.screen.dispose()
    const session: LiveChat = {
      chat: record.chat, exited: record.exited, exitCode: record.exitCode,
      screen: new ScreenMirror(record.cols || process.stdout.columns || 80, record.rows || process.stdout.rows || 24),
      pty: {
        write: (data) => { void this.sessionCommand(record.chat.id, 'input', { data }).catch((error) => this.output(session, `\r\nStoke: ${error.message}\r\n`)) },
        resize: (cols, rows) => { void this.sessionCommand(record.chat.id, 'resize', { cols, rows }).catch((error) => this.output(session, `\r\nStoke: ${error.message}\r\n`)) },
        kill: () => { void this.sessionCommand(record.chat.id, 'stop').catch(() => undefined) }
      }
    }
    this.live.set(record.chat.id, session)
    if (record.snapshot) session.screen.write(record.snapshot)
    return session
  }
  private async sessionCommand(id: string, command: string, data: Record<string, unknown> = {}): Promise<unknown> {
    await this.starting.get(id)
    return this.request(command, { session: id, ...data })
  }
  start(chat: Chat, config: TerminalConfig, prompt = '', resume = false, override?: { file: string; args: string[] }): LiveChat {
    const existing = this.live.get(chat.id)
    if (existing && !existing.exited) return existing
    const file = override?.file ?? executableFor(chat.agent, config)
    if (!file) throw new Error(`${chat.agent} is not on PATH. Configure its executable in ${configPath()}.`)
    const args = override?.args ?? launchArgs(chat, config, prompt, resume)
    const session = this.add({ chat, exited: false, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24, snapshot: '' })
    const launch = (override ? Promise.resolve() : verifyAgentIdentity(chat.agent, file)).then(() => {
      if (this.closed) throw new Error('Launch cancelled because this UI detached.')
      return this.request('start', { chat, config, prompt, resume, override: { file, args }, environment: process.env, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
    })
    this.starting.set(chat.id, launch)
    void launch.catch((error) => {
      this.output(session, `\r\nStoke could not start this chat: ${error.message}\r\n`)
      session.exited = true; session.exitCode = 1; this.exited(session)
    }).finally(() => this.starting.delete(chat.id))
    return session
  }
  async shutdown(): Promise<void> { if (this.socket) await this.request('shutdown'); this.close() }
  close(): void {
    this.closed = true
    this.socket?.end()
    for (const session of this.live.values()) session.screen.dispose()
  }
}
