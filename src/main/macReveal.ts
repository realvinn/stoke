import { spawn, type ChildProcess } from 'node:child_process'

/** One owned metadata sampler, only while Stoke has a native full-screen window. */
export class MacReveal {
  private child: ChildProcess | null = null
  private restart: ReturnType<typeof setTimeout> | null = null
  private active = false
  private stopped = false
  private frame: unknown = null
  private executable: string
  private onFrames: (frames: unknown) => void
  constructor(executable: string, onFrames: (frames: unknown) => void) {
    this.executable = executable; this.onFrames = onFrames
  }
  current(): unknown { return this.frame }
  setActive(active: boolean): void {
    this.active = active
    if (!active) {
      if (this.restart) clearTimeout(this.restart)
      this.restart = null
      this.child?.kill('SIGTERM')
      this.frame = null; this.onFrames(null)
    } else if (!this.child && !this.stopped) this.start()
  }
  private start(): void {
    const child = spawn(this.executable, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.child = child
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 65536) { child.kill('SIGTERM'); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try { this.frame = JSON.parse(line); this.onFrames(this.frame) } catch { this.frame = null; this.onFrames(null) }
      }
    })
    child.on('error', () => { this.frame = null; this.onFrames(null) })
    child.on('close', () => {
      if (this.child !== child) return
      this.child = null; this.frame = null; this.onFrames(null)
      if (this.active && !this.stopped) this.restart = setTimeout(() => { this.restart = null; this.start() }, 5000)
    })
  }
  stop(): void { this.stopped = true; this.setActive(false) }
}
