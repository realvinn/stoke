import { useEffect, useRef } from 'react'

/**
 * "A prompt is running — Force restart / Wait / Cancel."
 *
 * Asked before anything kills a `claude` that is mid-turn: the relaunch pill
 * (onto a newer CLI), Stoke's own "Restart and install", and closing a tab
 * (gotcha 90). Killing the process then is not a pause — SIGHUP fires no
 * `Stop` hook, the streaming reply is never persisted, and the resumed
 * session opens on "Interrupted · What should Claude do instead?". So the
 * dialog says what is lost, and where the two-choice question below cannot
 * offer one, an alternative that loses nothing: wait for the turn to end,
 * then do it.
 *
 * Wait, when there is one, is focused rather than Force: the button Enter
 * lands on should be the one that cannot throw work away. `onWait` is
 * omitted for a close, which has nowhere to come back to the way a relaunch
 * or a restart does — the fallback focus is Cancel, for the same reason.
 *
 * Drawn above everything, the Settings sheet included, because "Restart and
 * install" is pressed from inside it. App adds it to `overlayOpen`, which is
 * what detaches the docked browser — a `WebContentsView` paints over all DOM
 * (gotcha 14), so without that this would be drawn underneath it.
 */
export function BusyDialog({
  title,
  children,
  forceLabel,
  waitLabel,
  waitHint,
  onForce,
  onWait,
  onCancel
}: {
  title: string
  children: React.ReactNode
  forceLabel: string
  /** Omitted along with `onWait` when there is nothing worth waiting for. */
  waitLabel?: string
  /** What Wait will do, for its tooltip. */
  waitHint?: string
  onForce: () => void
  onWait?: () => void
  onCancel: () => void
}): React.JSX.Element {
  const waitRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus once, on mount. Depending on `onWait` itself re-runs this on every
  // render for a caller that passes an inline arrow (the relaunch and restart
  // callers both do), stealing focus back from whatever the user tabbed to —
  // measured: focus Cancel, cause any re-render, and Enter fires Wait instead
  // (gotcha 90 correction). `hasWait` is a boolean, so it is stable across
  // renders even when the callback identity is not.
  const hasWait = !!onWait
  useEffect(() => {
    ;(hasWait ? waitRef.current : cancelRef.current)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * Tab stays inside the dialog. Without this a Tab out of it lands in the
   * Settings sheet underneath (or the terminal), which is still live DOM, and
   * the next Enter presses a control the user cannot see is focused.
   */
  const trap = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key !== 'Tab') return
    const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    if (!buttons.length) return
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : at === buttons.length - 1 ? 0 : at + 1
    e.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <>
      <div className="confirm-scrim" onClick={onCancel} />
      <div
        className="confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="busy-dialog-title"
        ref={dialogRef}
        onKeyDown={trap}
      >
        <h2 id="busy-dialog-title">{title}</h2>
        <div className="confirm-body">{children}</div>
        <div className="confirm-actions">
          <button className="btn" data-variant="ghost" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" data-variant="danger" onClick={onForce}>
            {forceLabel}
          </button>
          {onWait && (
            <button
              className="btn"
              data-variant="primary"
              ref={waitRef}
              onClick={onWait}
              title={waitHint}
            >
              {waitLabel}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
