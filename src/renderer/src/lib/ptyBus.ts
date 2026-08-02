/**
 * Fan-out for PTY output, with a retained replay buffer per process.
 *
 * Two problems this solves:
 *  1. `pty:start` resolves the moment the child spawns, so Claude can print its
 *     banner before React has committed the <TerminalView/>.
 *  2. Any remount (tab reorder, React StrictMode's double-mount in dev, a theme
 *     change that recreates the terminal) would otherwise show an empty pane.
 *
 * Keeping a capped history and replaying it on every attach fixes both, and
 * makes the terminal component safe to unmount and rebuild at will.
 */

type Sink = (data: string) => void

/** Retained bytes per process. Roughly a few thousand lines of output. */
const MAX_HISTORY = 1_000_000

interface Entry {
  chunks: string[]
  length: number
  sink: Sink | null
  exit: { code: number; signal?: number } | null
  exitSink: ((code: number, signal?: number) => void) | null
}

const entries = new Map<string, Entry>()
let started = false

function entry(ptyId: string): Entry {
  let e = entries.get(ptyId)
  if (!e) {
    e = { chunks: [], length: 0, sink: null, exit: null, exitSink: null }
    entries.set(ptyId, e)
  }
  return e
}

export function initPtyBus(): void {
  if (started) return
  started = true

  window.stoke.pty.onData((ptyId, data) => {
    const e = entry(ptyId)
    e.chunks.push(data)
    e.length += data.length
    // Drop whole chunks so we never slice through an escape sequence.
    while (e.length > MAX_HISTORY && e.chunks.length > 1) {
      e.length -= (e.chunks.shift() as string).length
    }
    e.sink?.(data)
  })

  window.stoke.pty.onExit((ptyId, code, signal) => {
    const e = entry(ptyId)
    e.exit = { code, signal }
    e.exitSink?.(code, signal)
  })
}

/**
 * Attach a terminal to a process. Everything received so far is replayed
 * synchronously first, so the caller must pass a freshly-cleared terminal.
 */
export function attachSink(ptyId: string, sink: Sink): () => void {
  const e = entry(ptyId)
  for (const chunk of e.chunks) sink(chunk)
  e.sink = sink
  return () => {
    if (e.sink === sink) e.sink = null
  }
}

export function attachExit(
  ptyId: string,
  sink: (code: number, signal?: number) => void
): () => void {
  const e = entry(ptyId)
  if (e.exit) sink(e.exit.code, e.exit.signal)
  e.exitSink = sink
  return () => {
    if (e.exitSink === sink) e.exitSink = null
  }
}

/** Release a closed tab's retained output. */
export function forgetPty(ptyId: string): void {
  entries.delete(ptyId)
}
