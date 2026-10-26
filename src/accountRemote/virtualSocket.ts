import type { PhoneSocket } from '../main/remote/socket.ts'
const OPEN=1,CLOSED=3
class BrowserEvents {
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  on(event: string, fn: (...args: any[]) => void): this { const set=this.listeners.get(event)??new Set();set.add(fn);this.listeners.set(event,set);return this }
  once(event: string, fn: (...args: any[]) => void): this { const once=(...args: any[])=>{this.listeners.get(event)?.delete(once);fn(...args)};return this.on(event,once) }
  emit(event: string, ...args: any[]): void { for (const fn of [...this.listeners.get(event)??[]]) fn(...args) }
}
export class VirtualSocket extends BrowserEvents implements PhoneSocket {
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
