import { HUB_LIMITS, parsePresenceServerFrame, reconnectDelayMs } from '../../shared/hub/protocol.ts'

export interface PresenceSocket {
  send(text: string): void
  close(code?: number, reason?: string): void
  terminate?(): void
  on(event: 'open', fn: () => void): unknown
  on(event: 'message', fn: (data: unknown) => void): unknown
  on(event: 'close', fn: (code: number) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}
interface Options {
  open(): Promise<PresenceSocket>
  enabled(): boolean
  opened(socket: PresenceSocket): void
  message(text: string): void
  closed(): void
  error(error: unknown): void
  now?: () => number
  pingMs?: number
  handshakeMs?: number
  retryMs?: (attempt: number) => number
}

/** One reconnecting presence connection. Every callback belongs to an attempt;
 * old sockets and late opening promises cannot mutate a newer connection. */
export class HubPresence {
  private readonly options: Options
  private socket: PresenceSocket | null = null
  private opening = false
  private generation = 0
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private handshake: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(options: Options) { this.options = options }

  start(): void {
    if (this.socket || this.opening || this.timer || !this.options.enabled()) return
    this.opening = true
    const generation = ++this.generation
    const current = (): boolean => generation === this.generation
    const now = this.options.now ?? Date.now
    let lastSeen = now()
    const fail = (error?: unknown): void => {
      if (!current()) return
      this.generation++
      const socket = this.socket
      this.socket = null; this.opening = false
      this.clearConnectionTimers()
      if (error) this.options.error(error)
      this.dispose(socket)
      this.options.closed()
      if (!this.options.enabled()) return
      const attempt = this.attempts++
      const delay = this.options.retryMs?.(attempt) ?? reconnectDelayMs(attempt, Math.random())
      this.timer = setTimeout(() => { this.timer = null; this.start() }, delay)
    }
    this.handshake = setTimeout(() => fail(new Error('The hub presence connection timed out. Reconnecting.')), this.options.handshakeMs ?? 20_000)
    void Promise.resolve().then(() => current() ? this.options.open() : null).then((socket) => {
      if (!socket) return
      // A late connecting ws can emit error when terminated. Always install
      // its handler, even when stop() has already invalidated this attempt.
      socket.on('error', (error) => fail(error))
      if (!current()) { this.dispose(socket); return }
      this.socket = socket
      if (!this.options.enabled()) { fail(); return }
      socket.on('close', () => fail())
      socket.on('message', (data) => {
        if (!current()) return
        const text = String(data)
        if (!parsePresenceServerFrame(text)) return
        lastSeen = now(); this.attempts = 0
        this.options.message(text)
      })
      socket.on('open', () => {
        if (!current()) return
        this.opening = false
        if (this.handshake) clearTimeout(this.handshake)
        this.handshake = null
        lastSeen = now()
        try { this.options.opened(socket) } catch (error) { fail(error); return }
        const pingMs = this.options.pingMs ?? HUB_LIMITS.pingMs
        this.heartbeat = setInterval(() => {
          if (!current()) return
          if (now() - lastSeen > pingMs * 2.5) { fail(new Error('The hub stopped answering presence heartbeats. Reconnecting.')); return }
          try { socket.send(JSON.stringify({ t: 'ping' })) } catch (error) { fail(error) }
        }, pingMs)
      })
    }).catch((error) => fail(error))
  }

  stop(): void {
    this.generation++
    this.opening = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.clearConnectionTimers()
    const socket = this.socket
    this.socket = null
    this.dispose(socket)
    this.options.closed()
  }

  private clearConnectionTimers(): void {
    if (this.handshake) clearTimeout(this.handshake)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.handshake = null; this.heartbeat = null
  }
  private dispose(socket: PresenceSocket | null): void {
    try { if (socket?.terminate) socket.terminate(); else socket?.close(1000, 'bye') } catch { /* already closed */ }
  }
}
