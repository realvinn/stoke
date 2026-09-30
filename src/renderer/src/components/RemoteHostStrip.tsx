import { useEffect, useRef, useState } from 'react'
import type { AttachAnswer, HubRemoteView, RemoteAskView } from '@shared/hub/remote'
import { platformName } from '../lib/hubRemote'

/*
 * On the HOST: the owner's question when another of their devices asks for a
 * session here — "Let <device> open <session>?" Allow once / Always / Deny —
 * and, while any device is attached, who and to what, with Disconnect.
 *
 * Strips in `.main-col`, like the SSH key offer, never a modal or an overlay:
 * the docked browser paints over anything floating (gotcha 14), and a
 * question nobody can see is refused by its timer. The question names the
 * device, its platform and its signing-key fingerprint (the same one Account &
 * sync lists), so a device the owner does not recognise can be told apart.
 * An answer is claimed before the IPC (gotcha 20): a second press sends nothing.
 */

interface Props {
  view: HubRemoteView
}

function Ask({ ask }: { ask: RemoteAskView }): React.JSX.Element {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((ask.expiresAt - Date.now()) / 1000)))
  const [sent, setSent] = useState<AttachAnswer | null>(null)
  const claimed = useRef(false)
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((ask.expiresAt - Date.now()) / 1000))), 1000)
    return () => clearInterval(t)
  }, [ask.expiresAt])
  const answer = (a: AttachAnswer): void => {
    if (claimed.current) return
    claimed.current = true
    setSent(a)
    void window.stoke.hub.remote.answer(ask.id, a)
  }
  return (
    <div className="ssh-prompt remote-strip" role="status" aria-live="assertive" aria-label={`Let ${ask.label} open ${ask.title}?`} data-hub="remote-ask">
      <span className="ssh-prompt-kind">Remote</span>
      <p className="ssh-prompt-text" title={`${ask.label} (${platformName(ask.platform)}), key ${ask.fingerprint}`}>
        Let <strong>{ask.label}</strong> open <strong>{ask.title}</strong> on this computer?
      </p>
      <span className="ssh-prompt-meta truncate mono" title="The asking device's signing-key fingerprint, as Settings › Account & sync lists it">
        {platformName(ask.platform)} · {ask.fingerprint} · {left}s
      </span>
      <button className="btn" data-variant="primary" disabled={sent !== null} onClick={() => answer('once')} title="This session, this time: it can watch and type until the tab closes">
        Allow once
      </button>
      <button className="btn" disabled={sent !== null} onClick={() => answer('always')} title={`Let ${ask.label} open any session here without asking. Take it back in Settings › Account & sync.`}>
        Always
      </button>
      <button className="btn" data-variant="ghost" disabled={sent !== null} onClick={() => answer('deny')}>
        Deny
      </button>
    </div>
  )
}

export function RemoteHostStrip({ view }: Props): React.JSX.Element | null {
  if (view.asks.length === 0 && view.guests.length === 0) return null
  const guests = view.guests
  const names = [...new Set(guests.map((g) => g.label))]
  return (
    <>
      {view.asks.map((a) => (
        <Ask key={a.id} ask={a} />
      ))}
      {guests.length > 0 && (
        <div className="ssh-prompt remote-strip" role="status" aria-live="polite" data-hub="remote-guests">
          <span className="remote-live" aria-hidden="true" />
          <span className="ssh-prompt-kind">Remote</span>
          <p className="ssh-prompt-text" title={guests.map((g) => `${g.label}: ${g.title ?? 'a session'}${g.via === 'always' ? ' (always allowed)' : ''}`).join('\n')}>
            <strong>{names.join(', ')}</strong> {guests.length === 1 ? 'is' : 'are'} attached to{' '}
            {guests.length === 1 ? <strong>{guests[0].title ?? 'a session'}</strong> : `${guests.length} sessions`} here, from another machine.
          </p>
          <button className="btn" onClick={() => void window.stoke.hub.remote.dropGuests()} title="Disconnect every other machine now. An Allow once goes with it; an Always stays until you take it back.">
            Disconnect
          </button>
        </div>
      )}
    </>
  )
}
