import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteState } from '@shared/api'
import { IconCopy, IconPhone } from './Icons'
import { reachLine } from './RemoteSettings'

interface Props {
  /** Open Settings at the Phone access section. */
  onOpenSettings: () => void
}

/**
 * The phone button in the title bar, and the code behind it.
 *
 * Phone access used to be reachable only by opening Settings and finding the
 * right row, and a phone being attached was visible only as a count inside
 * that row. This is the one-press version: the button lights when the server
 * is on, carries a dot while a phone is attached, and the popover holds the
 * code to scan — or, when the server is off, the single button that turns it
 * on and picks a route a phone can actually use.
 */
export function PhonePopover({ onOpenSettings }: Props): React.JSX.Element {
  const [state, setState] = useState<RemoteState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setState(await window.stoke.remote.status())
  }, [])

  useEffect(() => {
    void refresh()
    return window.stoke.remote.onChange(setState)
  }, [refresh])

  // The tunnel URL and the attached count move without a push; refresh while
  // someone is looking, and never otherwise.
  useEffect(() => {
    if (!open) return
    void refresh()
    const id = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(id)
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const act = async (fn: () => Promise<RemoteState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await fn())
    } finally {
      setBusy(false)
    }
  }

  const copyLink = (): void => {
    if (!state?.url) return
    window.stoke.clipboard.writeText(state.url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const running = state?.server.running ?? false
  const attached = state?.server.clients ?? 0
  const reachable = running && state !== null && state.reach !== 'loopback' && state.url !== null

  return (
    <div className="phone-wrap">
      <button
        className="icon-btn"
        aria-pressed={running}
        aria-expanded={open}
        data-attached={attached > 0 || undefined}
        onClick={() => setOpen((v) => !v)}
        title={
          !running
            ? 'Open on phone'
            : attached > 0
              ? `Phone access on · ${attached} connected`
              : 'Phone access on — show the code'
        }
      >
        <IconPhone />
        <span className="sr-only">Phone access</span>
      </button>

      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="popover phone-panel" role="dialog" aria-label="Phone access" ref={panelRef}>
            {!running && (
              <>
                <p className="popover-title">Your sessions, on your phone</p>
                <p className="popover-text">
                  Read, type and dictate into any open session. Picks{' '}
                  {state?.tailnet ? 'Tailscale' : 'your Wi-Fi'} and shows a code to scan.
                </p>
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={busy}
                  onClick={() => void act(window.stoke.remote.openOnPhone)}
                >
                  {busy ? 'Starting…' : 'Open on phone'}
                </button>
              </>
            )}

            {running && state && !reachable && (
              <>
                <p className="popover-title">Phone access is on</p>
                <p className="popover-text" data-tone="warning">
                  The link only works on this computer. Choose how the phone reaches it in Settings.
                </p>
                <div className="popover-actions">
                  <button className="btn" onClick={() => { setOpen(false); onOpenSettings() }}>
                    Open settings
                  </button>
                  <button className="btn" data-variant="ghost" disabled={busy} onClick={() => void act(window.stoke.remote.stop)}>
                    Turn off
                  </button>
                </div>
              </>
            )}

            {reachable && state && (
              <>
                {state.qr && (
                  <img className="phone-qr" src={state.qr} alt="QR code linking to your sessions" width={200} height={200} />
                )}
                <p className="popover-text">{reachLine(state)}</p>
                <p className="popover-text">
                  {attached > 0 ? `${attached} phone${attached === 1 ? '' : 's'} connected.` : 'Scan with the phone’s camera.'}
                </p>
                <div className="popover-actions">
                  <button className="btn" onClick={copyLink}>
                    <IconCopy />
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <button className="btn" data-variant="ghost" onClick={() => { setOpen(false); onOpenSettings() }}>
                    Settings
                  </button>
                  <button className="btn" data-variant="ghost" disabled={busy} onClick={() => void act(window.stoke.remote.stop)}>
                    Turn off
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
