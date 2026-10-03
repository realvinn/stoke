import { useSyncExternalStore } from 'react'

/*
 * Short-lived notices: "Key added to NUC", and whatever else is news rather
 * than a question. A question — something with buttons the user has to answer
 * — stays a strip in `.main-col` (SshKeyPrompt, WorklogPrompt): a toast leaves
 * on its own, and an answer nobody gave is not an answer.
 *
 * A module store rather than App state, so anything can say something without
 * a callback threaded down to it; `Toaster` is the one reader.
 */

export type ToastTone = 'success' | 'info' | 'error'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  description?: string
  /** How long it stays, in ms, not counting time under the pointer or focus. */
  duration: number
}

/** Long enough to read a title and a short line twice. */
export const TOAST_MS = 5000
/** More than this and the oldest goes: a stack of notices is a log, not news. */
const MAX_TOASTS = 3

let toasts: Toast[] = []
let seq = 0
const listeners = new Set<() => void>()

function publish(next: Toast[]): void {
  toasts = next
  for (const l of listeners) l()
}

/** Show a notice. Returns its id, for `dismissToast`. */
export function toast(t: { tone?: ToastTone; title: string; description?: string; duration?: number }): number {
  const id = ++seq
  const item: Toast = { id, tone: t.tone ?? 'info', title: t.title, duration: t.duration ?? TOAST_MS }
  if (t.description) item.description = t.description
  publish([...toasts, item].slice(-MAX_TOASTS))
  return id
}

export function dismissToast(id: number): void {
  if (toasts.some((t) => t.id === id)) publish(toasts.filter((t) => t.id !== id))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The notices showing now, oldest first. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts)
}

/*
 * How far above the terminal column's foot the toasts must sit to clear what
 * the pane in front floats there — the exit card's Start again and Close tab,
 * the image strip's Cancel — in px. Set by that pane (TerminalView), which is
 * the only thing that knows its floats; 0 when it has none.
 */
let floor = 0
const floorListeners = new Set<() => void>()

export function setToastFloor(px: number): void {
  const next = Math.max(0, Math.round(px))
  if (next === floor) return
  floor = next
  for (const l of floorListeners) l()
}

function subscribeFloor(listener: () => void): () => void {
  floorListeners.add(listener)
  return () => floorListeners.delete(listener)
}

export function useToastFloor(): number {
  return useSyncExternalStore(subscribeFloor, () => floor)
}
