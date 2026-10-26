import { openRemoteSocket } from './api'
/*
 * The live session list, pushed over `/ws/events` (phone contract point 4)
 * with a 5s `/api/sessions` poll as the fallback while that socket is down.
 *
 * It replaces the list's 5s poll and the terminal's own 6s poll: one source
 * for every screen, so the list, the laptop rail and a session's status pill
 * cannot disagree. Its connection state drives the global "Reconnecting…"
 * strip.
 */
import { api, AuthError, loadTheme, wsUrl, type SessionRow } from './api'

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
  private health: ReturnType<typeof setInterval> | null = null
  private attaching: ReturnType<typeof setTimeout> | null = null
  private reading: AbortController | null = null
  private generation = 0
  private hiddenAt: number | null = null

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
    this.generation++
    this.open()
    this.health = setInterval(() => {
      if (document.visibilityState === 'visible') void this.refresh()
    }, 15_000)
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('online', this.onVisible)
  }

  stop(): void {
    this.running = false
    this.generation++
    this.reading?.abort()
    this.reading = null
    if (this.health) clearInterval(this.health)
    this.health = null
    if (this.attaching) clearTimeout(this.attaching)
    this.attaching = null
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
  private onVisible = (event?: Event): void => {
    if (document.visibilityState !== 'visible') { this.hiddenAt = Date.now(); return }
    if (document.visibilityState !== 'visible' || !this.running) return
    const slept = this.hiddenAt !== null && Date.now() - this.hiddenAt > 10_000
    this.hiddenAt = null
    if (event?.type === 'online' || slept || !this.ws || this.ws.readyState > WebSocket.OPEN) {
      this.backoff = 1000
      this.open()
    }
    void this.refresh()
  }

  private open(): void {
    if (!this.running) return
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
    if (this.attaching) clearTimeout(this.attaching)
    // Invalidate first; the replaced socket's late events cannot reset this connection.
    const previous = this.ws
    this.ws = null
    previous?.close()
    let socket: WebSocket
    try {
      socket = openRemoteSocket(wsUrl('/ws/events'))
    } catch {
      this.startPolling()
      this.retry = setTimeout(() => this.open(), this.backoff * (0.8 + Math.random() * 0.4))
      this.backoff = Math.min(this.backoff * 2, 15_000)
      return
    }
    this.ws = socket
    this.setLink('connecting')
    this.attaching = setTimeout(() => {
      this.attaching = null
      if (this.ws !== socket) return
      // A broken path may never complete the WebSocket close handshake.
      this.ws = null
      socket.close()
      this.setLink('down')
      this.startPolling()
      this.retry = setTimeout(() => this.open(), this.backoff * (0.8 + Math.random() * 0.4))
      this.backoff = Math.min(this.backoff * 2, 15_000)
    }, 12_000)
    socket.addEventListener('open', () => {
      if (this.ws !== socket) return
      // A transport handshake is not a restored session list.
      this.setLink('connecting')
    })
    socket.addEventListener('message', (ev) => {
      if (this.ws !== socket) return
      try {
        const msg = JSON.parse(String(ev.data)) as { type: string; rows?: SessionRow[] }
        if (msg.type === 'sessions' && Array.isArray(msg.rows)) {
          if (this.attaching) clearTimeout(this.attaching)
          this.attaching = null
          this.backoff = 1000
          this.stopPolling()
          this.link = 'live'
          this.rows = msg.rows
          this.error = null
          this.emit()
        } else if (msg.type === 'theme') {
          // The desktop switched theme (audit PX-21): paint the new one now,
          // not the next time the page is reopened.
          void loadTheme().catch(() => {})
        }
      } catch {
        /* a frame this version does not know */
      }
    })
    socket.addEventListener('close', () => {
      if (this.ws !== socket || !this.running) return
      this.ws = null
      if (this.attaching) clearTimeout(this.attaching)
      this.attaching = null
      this.link = 'connecting'
      this.startPolling()
      this.retry = setTimeout(() => this.open(), this.backoff * (0.8 + Math.random() * 0.4))
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
    if (!this.running || this.reading) return
    const generation = this.generation
    const socket = this.ws
    const controller = new AbortController()
    this.reading = controller
    try {
      const rows = await api<SessionRow[]>('/api/sessions', { signal: controller.signal })
      if (!this.running || generation !== this.generation) return
      if (this.ws !== socket && this.link === 'live') return
      if (!Array.isArray(rows)) throw new Error('The computer returned an invalid session list.')
      this.rows = rows
      this.error = null
      if (this.link !== 'live') this.link = 'polling'
      this.emit()
    } catch (err) {
      if (controller.signal.aborted || !this.running || generation !== this.generation) return
      if (err instanceof AuthError) return
      if (this.ws !== socket && this.link === 'live') return
      this.error = err
      // A socket can remain OPEN after the host or its tunnel stopped answering.
      if (this.ws === socket && this.link === 'live') {
        this.ws = null
        socket?.close()
        this.retry = setTimeout(() => this.open(), 1000)
        this.startPolling()
      }
      this.link = 'down'
      this.emit()
    } finally { if (this.reading === controller) this.reading = null }
  }
}

export const store = new SessionStore()
