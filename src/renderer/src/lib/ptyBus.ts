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

import { looksTyped } from './tabs'

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
  typed.delete(ptyId)
}

/* ------------------------------------------------- typed since submitted */

/**
 * Ptys that have had text typed into them since their last submitted prompt.
 *
 * Exists because the CLI's own registry says `idle` while a draft sits unsent
 * in the prompt box (measured: typing leaves the status untouched), so "idle"
 * alone cannot license killing a session the user is not looking at — the
 * automatic relaunch reads this before it acts. Set on any input that
 * `looksTyped`; cleared by a prompt hook the user typed, or by a registry
 * idle -> busy edge that no machine-injected prompt (a task's notification, a
 * teammate's message, a wake-up) claims — a slash command like `/clear` fires
 * no hook, so the edge is all it leaves — and when the pty is forgotten. Keys
 * typed while the registry says `waiting` answer the dialog, so the edge out
 * of it puts back what the flag held going in. App drives all of that through
 * `draftOnRegistry`/`draftOnPrompt` (src/shared/activityView.ts, gotcha 104)
 * and writes the answer back with `setTyped`. Module state rather than React
 * state: nothing renders it, and a keystroke must not cost a render.
 */
const typed = new Set<string>()

/** Record what was just written to a pty from the keyboard or a paste. */
export function noteInput(ptyId: string, data: string): void {
  if (ptyId && looksTyped(data)) typed.add(ptyId)
}

export function typedSinceSubmit(ptyId: string): boolean {
  return typed.has(ptyId)
}

export function clearTyped(ptyId: string): void {
  typed.delete(ptyId)
}

/**
 * Put the flag where the draft-guard bookkeeping decided: set again when an
 * edge it cleared turns out to be the CLI's own turn, or when a dialog closes
 * over a draft typed before it opened.
 */
export function setTyped(ptyId: string, value: boolean): void {
  if (!ptyId) return
  if (value) typed.add(ptyId)
  else typed.delete(ptyId)
}
