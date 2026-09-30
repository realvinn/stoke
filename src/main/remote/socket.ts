/*
 * The socket the phone server's handlers talk to, and a virtual one.
 *
 * `RemoteServer` serves a phone's `/ws/events` and pty sockets over `ws`. The
 * hub relay (src/main/hub/remote.ts) serves the SAME handlers to another of
 * the owner's machines, with no listener: each relayed socket is a
 * `VirtualSocket` whose sends become sealed `ws-msg` frames and whose
 * messages arrive from the channel (spec §6.4, "never by opening its loopback
 * port"). So the handlers are written against `PhoneSocket`, the part of
 * `ws`'s WebSocket they use, and every rule they hold — gotchas 84–87 — holds
 * for both.
 *
 * No electron import, so a suite can drive it under strip-types.
 */
import { EventEmitter } from 'node:events'

/** The part of `ws`'s WebSocket the phone server's socket handlers use. */
export interface PhoneSocket {
  readonly readyState: number
  send(text: string): void
  close(code?: number, reason?: string): void
  ping(): void
  terminate(): void
  on(event: 'message', fn: (raw: unknown) => void): unknown
  on(event: 'close' | 'error' | 'pong', fn: () => void): unknown
  once(event: 'close', fn: () => void): unknown
}

const OPEN = 1
const CLOSED = 3

/**
 * A relayed socket. `out` carries what the server sends to the far end;
 * `onClose` tells the far end the server closed it. `deliver` is a message
 * from the far end; `drop` is the far end (or the relay) going away, which the
 * server hears as a close — so it forgets the socket and, for a pty, puts back
 * the desktop's size exactly as it does when a phone leaves.
 */
export class VirtualSocket extends EventEmitter implements PhoneSocket {
  readyState: number
  private readonly out: (text: string) => void
  private readonly onClose: (code: number, reason: string) => void

  constructor(out: (text: string) => void, onClose: (code: number, reason: string) => void) {
    super()
    this.readyState = OPEN
    this.out = out
    this.onClose = onClose
    // The server binds 'error' too; an EventEmitter with no listener throws on it.
    this.on('error', () => {})
  }

  send(text: string): void {
    if (this.readyState === OPEN) this.out(text)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== OPEN) return
    this.readyState = CLOSED
    this.onClose(code, reason)
    this.emit('close', code, reason)
  }

  /** The keepalive's ping: the channel has its own liveness, so a virtual socket always answers. */
  ping(): void {
    if (this.readyState === OPEN) queueMicrotask(() => this.emit('pong'))
  }

  terminate(): void {
    this.close(1006, 'terminated')
  }

  deliver(text: string): void {
    if (this.readyState === OPEN) this.emit('message', text)
  }

  drop(reason = 'the other machine left'): void {
    if (this.readyState !== OPEN) return
    this.readyState = CLOSED
    this.emit('close', 1001, reason)
  }
}
