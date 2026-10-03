import { useEffect, useRef, useState } from 'react'
import { dismissToast, useToastFloor, useToasts, type Toast } from '../lib/toasts'
import { IconAlert, IconCheck, IconClose } from './Icons'

/** How long a leaving toast takes to fade and drop away before it is removed (app.css `--toast-leave`). */
const LEAVE_MS = 320

/** Whether this window is the one in front and showing — a notice read by nobody is not used up. */
function useWindowActive(): boolean {
  const read = (): boolean => !document.hidden && document.hasFocus()
  const [active, setActive] = useState(read)
  useEffect(() => {
    const update = (): void => setActive(read())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    // Read again now the listeners are on: a focus that landed between the
    // first render and this effect fires no event this could hear, and the
    // stale `false` paused every toast until the window lost focus and got it
    // back (measured: 3 launches of 5, a toast up for 90 s).
    update()
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return active
}

/**
 * The notices from `toast()`, stacked in the bottom-right corner of the
 * terminal column.
 *
 * Inside `.main-col`, never fixed to the window: the docked browser is a
 * native view that paints over every pixel of renderer DOM in its column
 * (gotcha 14), and this column is the one it never covers. So a toast is
 * visible with the browser open and needs no floating-layer registration —
 * it never asks the browser to hide. It sits above whatever the pane in front
 * floats along its foot (`useToastFloor`), never over the exit card's or the
 * image strip's buttons, and under every overlay: while one is up the shell is
 * inert (gotcha 88), so a toast over the scrim could be seen and not pressed —
 * a click on it reached the backdrop and closed Settings. `paused` holds every
 * clock until the overlay goes, so a notice raised behind it is still there to
 * read.
 *
 * The list is always in the DOM: a live region has to exist before the text
 * that changes in it, or a screen reader may not announce the first toast.
 */
export function Toaster({ paused }: { paused: boolean }): React.JSX.Element {
  const toasts = useToasts()
  const floor = useToastFloor()
  const windowActive = useWindowActive()
  return (
    <ol
      className="toaster"
      aria-live="polite"
      aria-label="Notifications"
      style={{ '--toast-floor': `${floor}px` } as React.CSSProperties}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} paused={paused || !windowActive} />
      ))}
    </ol>
  )
}

/**
 * One notice. It leaves on its own after `duration` — a clock that stops while
 * the pointer rests on it, focus is inside it, or `paused`, so a toast being
 * read or reached for is not taken away mid-sentence — or on its close button,
 * or Escape while focus is inside it.
 */
function ToastCard({ toast, paused }: { toast: Toast; paused: boolean }): React.JSX.Element {
  const [leaving, setLeaving] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const held = hovered || focused || paused
  // What is left of its time, kept across pauses.
  const left = useRef(toast.duration)

  useEffect(() => {
    if (leaving || held) return
    const started = performance.now()
    const timer = window.setTimeout(() => setLeaving(true), left.current)
    return () => {
      window.clearTimeout(timer)
      left.current = Math.max(0, left.current - (performance.now() - started))
    }
  }, [leaving, held])

  useEffect(() => {
    if (!leaving) return
    // A timer, not `transitionend`: under reduced motion, or in a hidden
    // window, a transition may never report its end.
    const timer = window.setTimeout(() => dismissToast(toast.id), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving, toast.id])

  return (
    <li
      className="toast"
      data-tone={toast.tone}
      data-leaving={leaving || undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={(e) => {
        // A chord goes on to App (Cmd+W still closes the tab).
        if (e.ctrlKey || e.metaKey || e.altKey) return
        /*
         * Every plain key stops here, as in RemoteFab: App's window listener
         * types an unclaimed key on a focused BUTTON through to the terminal in
         * front (`typeThroughKey`), so an Enter on Dismiss was a `\r` in the
         * session — measured: it submitted the draft — and the button never
         * ran. Enter and Space now press it, natively.
         */
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          setLeaving(true)
        }
      }}
    >
      {toast.tone !== 'info' && (
        <span className="toast-icon" aria-hidden="true">
          {toast.tone === 'success' ? <IconCheck /> : <IconAlert />}
        </span>
      )}
      <div className="toast-body">
        <p className="toast-title">{toast.title}</p>
        {toast.description && <p className="toast-description">{toast.description}</p>}
      </div>
      <button className="icon-btn toast-close" onClick={() => setLeaving(true)} title="Dismiss" aria-label="Dismiss">
        <IconClose />
      </button>
    </li>
  )
}
