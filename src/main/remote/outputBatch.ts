/** Lossless terminal bursts: at most one frame per 16ms, bounded while waiting. */
export const OUTPUT_BATCH_MS = 16
export const OUTPUT_BATCH_CHARS = 64 * 1024

export class TerminalOutputBatch {
  private pending = new Map<string, { chunks: string[]; chars: number; timer: ReturnType<typeof setTimeout> }>()
  private readonly send: (id: string, data: string) => void

  constructor(send: (id: string, data: string) => void) { this.send = send }

  push(id: string, data: string): void {
    if (!data) return
    let entry = this.pending.get(id)
    if (entry && entry.chars + data.length > OUTPUT_BATCH_CHARS) {
      this.flush(id)
      entry = undefined
    }
    // A single large chunk already amortises frame overhead. Do not retain it.
    if (data.length >= OUTPUT_BATCH_CHARS) { this.send(id, data); return }
    if (!entry) {
      entry = { chunks: [], chars: 0, timer: setTimeout(() => this.flush(id), OUTPUT_BATCH_MS) }
      this.pending.set(id, entry)
    }
    entry.chunks.push(data)
    entry.chars += data.length
    if (entry.chars >= OUTPUT_BATCH_CHARS || entry.chunks.length >= 256) this.flush(id)
  }

  flush(id: string): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    this.send(id, entry.chunks.join(''))
  }

  clear(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }
}
