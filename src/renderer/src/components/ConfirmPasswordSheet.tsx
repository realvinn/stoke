import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { verifyPasswordSentence, type HubVerifyResult } from '@shared/hub/client'
import { useFloatingLayer } from '../lib/floatingLayers'
import { Spinner } from './Spinner'

/*
 * "Confirm it's you": the hub password, typed again on THIS computer, before it
 * lets the account's other computers in to something of its own (spec
 * 2026-10-03 §2 — first, its chat history). It asks main
 * (`window.stoke.hub.verifyPassword` -> `HubService.verifyPassword` -> the
 * hub's `POST /v1/auth/verify`) and calls `onConfirmed` only when the hub said
 * yes. Wrong tries count on this device's own counter on the hub, never the
 * sign-in ones.
 *
 * HOW TO MOUNT IT. Render it only while it is wanted; it focuses its field on
 * mount and forgets everything on unmount:
 *
 *   {confirming && (
 *     <ConfirmPasswordSheet
 *       title="Confirm it’s you"
 *       confirmLabel="Turn on"
 *       onConfirmed={() => { setConfirming(false); turnOn() }}
 *       onCancel={() => setConfirming(false)}
 *     />
 *   )}
 *
 * - From inside the Settings sheet (Settings › Account & sync, its first
 *   home) nothing else is needed: `settingsOpen` is already in App's
 *   `overlayOpen`, so the shell is inert (gotcha 88) and the docked browser is
 *   off the window (gotcha 14).
 * - Anywhere else, add its open state to App's `overlayOpen` (and the file to
 *   `OVERLAY_COVERED` in scripts/verify-layers.mts), so the browser hides
 *   behind it like behind BusyDialog. It registers itself with
 *   `useFloatingLayer` regardless, so the browser never paints over it.
 *
 * Wherever it is mounted, it makes the whole app under `#root` inert while it
 * is up — the Settings sheet it stands on included, which App's own lock (the
 * shell's three rows) does not cover — so no click, Tab or screen reader walks
 * out of it into the sheet behind. It is drawn outside `#root`, so it stays
 * live. The caller puts focus back where it was when the sheet goes.
 *
 * It is drawn into <body> through a portal, one step above the Settings sheet
 * (`.confirm-scrim`/`.confirm-modal`, BusyDialog's classes): inside the sheet's
 * DOM it would be laid out against the sheet's own box while `modal-in` runs.
 * Tab stays inside it, every plain key stops at it (App types an unclaimed key
 * on a focused button into the terminal, `typeThroughKey`), and Escape is its
 * Cancel wherever focus is — caught on the window in the capture phase, before
 * App's own listener would close the whole Settings sheet (ColorPicker's
 * shape).
 *
 * The password is never React state or a prop. The field is UNCONTROLLED on
 * purpose: React 19 mirrors a controlled input's value into its `value`
 * ATTRIBUTE (react-dom's `setDefaultValue` sets `defaultValue`), which would
 * put the password in the DOM for any outerHTML or CDP read to see. It is read
 * from the field once, on the press, the field is emptied at that moment, and
 * it is emptied again on close; main neither keeps nor logs it.
 */

export interface ConfirmPasswordSheetProps {
  /** The heading. Default "Confirm it’s you". */
  title?: string
  /** The primary button's label. Default "Turn on". */
  confirmLabel?: string
  /** A sentence or two above the field: what the password is about to turn on. */
  children?: React.ReactNode
  /** The hub said yes. Called once; the field is already empty. */
  onConfirmed: () => void
  /** Cancel, Escape or a click outside. Nothing was turned on. */
  onCancel: () => void
}

interface Shown {
  text: string
  detail: string | null
}

export function ConfirmPasswordSheet({
  title = 'Confirm it’s you',
  confirmLabel = 'Turn on',
  children,
  onConfirmed,
  onCancel
}: ConfirmPasswordSheetProps): React.JSX.Element {
  const dialogRef = useRef<HTMLFormElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const [filled, setFilled] = useState(false)
  const [checking, setChecking] = useState(false)
  const [shown, setShown] = useState<Shown | null>(null)
  /** A check in flight: claimed before the await, so a double press sends one (gotchas 20, 51). */
  const claimed = useRef(false)
  /** Cancelled, confirmed or gone: an answer that lands later turns nothing on. */
  const closed = useRef(false)
  /** The caller's latest `onConfirmed`, for an answer that lands after a re-render. */
  const confirmedRef = useRef(onConfirmed)
  confirmedRef.current = onConfirmed
  const titleId = useId()
  const errorId = useId()

  useFloatingLayer(dialogRef, true)

  // Everything behind it is inert while it is up (gotcha 88): a LAYOUT effect, so the
  // field's focus on mount (a passive effect) runs after it, never into the sheet behind.
  useLayoutEffect(() => {
    const root = document.getElementById('root')
    if (!root || root.hasAttribute('inert')) return
    root.setAttribute('inert', '')
    return () => root.removeAttribute('inert')
  }, [])

  const forget = useCallback((): void => {
    if (fieldRef.current) fieldRef.current.value = ''
    setFilled(false)
  }, [])

  const cancel = useCallback((): void => {
    if (closed.current) return
    closed.current = true
    forget()
    onCancel()
  }, [forget, onCancel])

  // The field again whenever a check ends (and on mount): it is disabled while one runs.
  // Never shown-then-focused through `visibility` (gotcha 137): nothing here is hidden first.
  useEffect(() => {
    if (!checking) fieldRef.current?.focus()
  }, [checking])

  useEffect(() => {
    const field = fieldRef.current
    return () => {
      closed.current = true
      if (field) field.value = ''
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cancel])

  const settle = (r: HubVerifyResult): void => {
    claimed.current = false
    if (closed.current) return
    setChecking(false)
    if (r.kind === 'ok') {
      closed.current = true
      confirmedRef.current()
      return
    }
    if (r.kind === 'busy') return
    const text = verifyPasswordSentence(r)
    setShown(text ? { text, detail: r.kind === 'unreachable' && r.message ? r.message : null } : null)
  }

  const submit = (e?: React.FormEvent): void => {
    e?.preventDefault()
    const field = fieldRef.current
    if (!field || claimed.current || closed.current) return
    const password = field.value
    if (password === '') return
    claimed.current = true
    forget()
    setShown(null)
    setChecking(true)
    void window.stoke.hub.verifyPassword(password).then(settle, (err: unknown) =>
      settle({ kind: 'unreachable', message: err instanceof Error ? err.message : '' })
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLFormElement>): void => {
    // Every key stops here: the Settings sheet's own keys (Cmd+F to its search) and App's
    // window listener never see a key meant for this sheet. Enter and Space still press
    // the focused button, natively; Enter in the field submits the form.
    e.stopPropagation()
    if (e.key !== 'Tab') return
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input, button') ?? [])].filter(
      (el) => !(el as HTMLInputElement | HTMLButtonElement).disabled
    )
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1
    e.preventDefault()
    items[next]?.focus()
  }

  return createPortal(
    <>
      <div className="confirm-scrim" onClick={cancel} />
      <form
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        // Focusable itself, so a press on its padding keeps focus (and the keyboard) in here.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onSubmit={submit}
        data-confirm-password=""
      >
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-body">
          {children ?? <p>Type your Stoke Hub password. Your hub checks it; Stoke does not keep it.</p>}
        </div>
        <div className="field">
          <input
            ref={fieldRef}
            className="input"
            type="password"
            aria-label="Stoke Hub password"
            placeholder="Stoke Hub password"
            autoComplete="current-password"
            spellCheck={false}
            disabled={checking}
            aria-invalid={shown ? true : undefined}
            aria-describedby={shown ? errorId : undefined}
            onChange={(e) => setFilled(e.currentTarget.value !== '')}
          />
          {shown && (
            <span className="field-hint" data-tone="danger" role="alert" id={errorId}>
              {shown.text}
              {shown.detail ? ` ${shown.detail}` : ''}
            </span>
          )}
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn" data-variant="ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="btn" data-variant="primary" disabled={!filled || checking} aria-busy={checking || undefined}>
            {checking && <Spinner />}
            {checking ? 'Checking…' : confirmLabel}
          </button>
        </div>
      </form>
    </>,
    document.body
  )
}
