/*
 * The live session list, pushed over `/ws/events` (phone contract point 4)
 * with a 5s `/api/sessions` poll as the fallback while that socket is down.
 *
 * It replaces the list's 5s poll and the terminal's own 6s poll: one source
 * for every screen, so the list, the laptop rail and a session's status pill
 * cannot disagree. Its connection state drives the global "Reconnecting…"
 * strip.
 */
import { api, AuthError, wsUrl, type SessionRow } from './api'

export type LinkState = 'connecting' | 'live' | 'polling' | 'down'

type Listener = () => void

class SessionStore {
  rows: SessionRow[] | null = null
  error: unknown = null
  link: LinkState = 'connecting'
  private listeners = new Set<Listener>()
  private ws: WebSocket | null = null
  private backoff = 1000
  private retry: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private running = false

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  row(ptyId: string): SessionRow | null {
    return this.rows?.find((r) => r.ptyId === ptyId) ?? null
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private setLink(link: LinkState): void {
    if (this.link === link) return
    this.link = link
    this.emit()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.open()
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('online', this.onVisible)
  }

  stop(): void {
    this.running = false
    document.removeEventListener('visibilitychange', this.onVisible)
    window.removeEventListener('online', this.onVisible)
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.stopPolling()
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  /** iOS drops sockets in the background: come back at once, not after the backoff. */
  private onVisible = (): void => {
    if (document.visibilityState !== 'visible' || !this.running) return
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      this.backoff = 1000
      this.open()
    }
  }

  private open(): void {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(wsUrl('/ws/events'))
    } catch {
      this.startPolling()
      return
    }
    this.ws = socket
    socket.addEventListener('open', () => {
      if (this.ws !== socket) return
      this.backoff = 1000
      this.stopPolling()
      this.setLink('live')
    })
    socket.addEventListener('message', (ev) => {
      if (this.ws !== socket) return
      try {
        const msg = JSON.parse(String(ev.data)) as { type: string; rows?: SessionRow[] }
        if (msg.type === 'sessions' && Array.isArray(msg.rows)) {
          this.rows = msg.rows
          this.error = null
          this.emit()
        }
      } catch {
        /* a frame this version does not know */
      }
    })
    socket.addEventListener('close', () => {
      if (this.ws !== socket || !this.running) return
      this.ws = null
      this.link = 'connecting'
      this.startPolling()
      this.retry = setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 15_000)
    })
  }

  private startPolling(): void {
    if (this.poll) return
    void this.refresh()
    this.poll = setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh()
    }, 5000)
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  /** One fetch, used by the fallback poll and by anything that just changed the list. */
  async refresh(): Promise<void> {
    try {
      this.rows = await api<SessionRow[]>('/api/sessions')
      this.error = null
      if (this.link !== 'live') this.link = 'polling'
      this.emit()
    } catch (err) {
      if (err instanceof AuthError) return
      this.error = err
      if (this.link !== 'live') this.link = 'down'
      this.emit()
    }
  }
}

export const store = new SessionStore()
