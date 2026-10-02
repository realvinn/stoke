import { useId, useRef, useState } from 'react'

/*
 * A live "Other machines" link as a small floating button instead of a strip
 * (Settings › Account & sync › `remoteBar`): a dot that says the link's state
 * and a word or two, opening on hover or keyboard focus — or a click, which
 * pins it open — to say the rest and offer what the strip offered.
 *
 * Where it floats is the caller's: over the top-right of a remote tab's own
 * pane, or the bottom-right of `.main-col` on the host. Both are inside the
 * main column, never over the docked browser (gotcha 14), and it is not a
 * popover or a menu: it never leaves its corner, so it registers no floating
 * layer.
 *
 * One writer for "open" (hover, keyboard focus inside, or pinned), drawn by
 * `data-open`, so the face's `aria-expanded` cannot disagree with what is on
 * screen. The panel is display-toggled, never `visibility` (gotcha 137): the
 * face's own focus opens it, so Tab walks straight on into its buttons, under
 * reduced motion too. Its appear animation rests fully shown, so with motion
 * reduced it simply appears (gotcha 72). Escape closes it and leaves the
 * keyboard on the face.
 */

interface Props {
  /** `pane`: top-right of a remote tab's pane; `main`: bottom-right of the main column (the host). */
  placement: 'pane' | 'main'
  /** The dot: a live link, one on its way, or one that is down. */
  tone: 'live' | 'pending' | 'down'
  /** What the closed button says after the dot. */
  face: React.ReactNode
  /** The button's accessible name. */
  faceLabel: string
  /** A polite announcement of the link's state, for a screen reader (never drawn). */
  announce: string
  /** What the open panel holds: the whole sentence and the buttons. */
  children: React.ReactNode
  /** A test hook and a CSS hook. */
  hub?: string
}

export function RemoteFab({ placement, tone, face, faceLabel, announce, children, hub }: Props): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const faceRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const open = hover || focused || pinned
  return (
    <div
      ref={rootRef}
      className="remote-fab"
      data-placement={placement}
      data-tone={tone}
      data-open={open || undefined}
      data-hub={hub}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Keyboard focus opens it; a click's focus does not, so the click's own toggle decides.
      onFocus={(e) => {
        if ((e.target as Element).matches?.(':focus-visible')) setFocused(true)
      }}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={(e) => {
        // A chord goes on to App (Cmd+W still closes the tab).
        if (e.ctrlKey || e.metaKey || e.altKey) return
        /*
         * Every plain key stops here. App's window listener types an unclaimed
         * key on a focused BUTTON through to the terminal in front
         * (`typeThroughKey`, gotcha 145's note), so without this an Enter on
         * Disconnect would be a `\r` in the session and the button would never
         * run. Enter and Space then press the focused button, natively.
         */
        e.stopPropagation()
        if (e.key !== 'Escape' || !open) return
        // Closed, with the keyboard left on the face; the terminal behind never sees this Escape.
        e.preventDefault()
        setPinned(false)
        setHover(false)
        faceRef.current?.focus()
        setFocused(false)
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      <button
        ref={faceRef}
        type="button"
        className="remote-fab-face"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={faceLabel}
        onClick={() => setPinned((v) => !v)}
      >
        <span className="remote-fab-dot" aria-hidden="true" />
        {face}
      </button>
      <div id={panelId} className="remote-fab-panel" role="group" aria-label={faceLabel}>
        {children}
      </div>
    </div>
  )
}
