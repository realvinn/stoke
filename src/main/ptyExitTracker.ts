import type { IPty } from '@lydell/node-pty'

/** Own native exit delivery independently of tabs, which may close first. */
export class PtyExitTracker {
  private pending = new Map<IPty, Promise<void>>()
  private watched = new WeakSet<IPty>()

  track(child: IPty): void {
    if (this.watched.has(child)) return
    this.watched.add(child)
    let complete!: () => void
    this.pending.set(child, new Promise<void>(resolve => { complete = resolve }))
    child.onExit(() => {
      // ConPTY's TSFN must finish its JS callback and native handle close
      // before Electron starts Node environment teardown. Do not resolve
      // from inside that callback, or just from a kill()/tab-close request.
      setImmediate(() => setImmediate(() => {
        this.pending.delete(child)
        complete()
      }))
    })
  }

  get count(): number { return this.pending.size }

  /** A deadline reports remaining ownership; it never invents an exit. */
  async wait(timeoutMs = 5000): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...this.pending.values()]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
      ])
      return this.pending.size
    } finally { clearTimeout(timer) }
  }
}

// Survives the main window's closed handler clearing its PtyManager. Every
// local/SSH agent and quick shell registers the exact object after spawn.
export const ownedPtyExits = new PtyExitTracker()
