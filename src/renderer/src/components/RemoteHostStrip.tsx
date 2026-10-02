import { useEffect, useRef, useState } from 'react'
import { ONCE_GRACE_MS, type AttachAnswer, type HubRemoteView, type RemoteAskView, type RemoteGuestView } from '@shared/hub/remote'
import type { RemoteBarMode } from '@shared/ui'
import { platformName } from '../lib/hubRemote'
import { RemoteFab } from './RemoteFab'

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
 *
 * The tooltips say exactly what each answer reaches (`relayScopeVerdict`):
 * under either, a relay reaches only the session it opened — never new
 * sessions, folders or past conversations. Always only stops the question.
 *
 * Who is attached is a strip only when Settings asks for the full bar
 * (`remoteBar: 'bar'`); by default it is `RemoteHostFab`, a floating button in
 * the corner of the main column. The QUESTION is always a strip: it has a
 * timer, and a question nobody sees is refused by it.
 */

const GRACE_MIN = Math.round(ONCE_GRACE_MS / 60_000)

interface Props {
  view: HubRemoteView
  /** `bar`: who is attached is a strip here too. `fab`: only the question is (RemoteHostFab says the rest). */
  bar: RemoteBarMode
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
      <button
        className="btn"
        data-variant="primary"
        disabled={sent !== null}
        onClick={() => answer('once')}
        title={`This session, this time: ${ask.label} can watch and type in it until its tab closes, and a dropped link may reconnect within ${GRACE_MIN} minutes without asking again.`}
      >
        Allow once
      </button>
      <button
        className="btn"
        disabled={sent !== null}
        onClick={() => answer('always')}
        title={`Let ${ask.label} open any running session here, to watch and type in it, without asking. Nothing more: it cannot start sessions, make folders or read past conversations. Take it back in Settings › Account & sync.`}
      >
        Always
      </button>
      <button className="btn" data-variant="ghost" disabled={sent !== null} onClick={() => answer('deny')}>
        Deny
      </button>
    </div>
  )
}

/** "Laptop is attached to Fix the relay" — or, for several, who and how many. */
function attachedSentence(guests: readonly RemoteGuestView[]): React.JSX.Element {
  const names = [...new Set(guests.map((g) => g.label))]
  return (
    <>
      <strong>{names.join(', ')}</strong> {guests.length === 1 ? 'is' : 'are'} attached to{' '}
      {guests.length === 1 ? <strong>{guests[0].title ?? 'a session'}</strong> : `${guests.length} sessions`} here, from another machine.
    </>
  )
}

const DISCONNECT_TITLE = 'Disconnect every other machine now. An Allow once goes with it; an Always stays until you take it back.'

/**
 * On the host, while any device is attached: a green dot and "Remote" in the
 * bottom-right corner of the main column, opening on hover or focus to say
 * who is attached to what, with Disconnect. Bottom-right, because the
 * terminal's text runs from the left and a strip's buttons sit at the top
 * right; the tab itself carries the two arrows too (TitleBar).
 */
export function RemoteHostFab({ view }: { view: HubRemoteView }): React.JSX.Element | null {
  const guests = view.guests
  if (guests.length === 0) return null
  const names = [...new Set(guests.map((g) => g.label))]
  return (
    <RemoteFab
      placement="main"
      tone="live"
      hub="remote-guests-fab"
      face={
        <>
          <span className="remote-fab-name">Remote</span>
          {guests.length > 1 && <span className="remote-fab-state">{guests.length}</span>}
        </>
      }
      faceLabel={`Remote: ${names.join(', ')} attached from another machine. Show details.`}
      announce={`${names.join(', ')} attached from another machine`}
    >
      <p className="remote-fab-text">{attachedSentence(guests)}</p>
      {guests.length > 1 && (
        <ul className="remote-fab-list">
          {guests.map((g) => (
            <li key={g.relay}>
              <strong>{g.label}</strong> · {g.title ?? 'a session'}
              {g.via === 'always' ? <span className="remote-fab-meta"> · always allowed</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="remote-fab-actions">
        <button className="btn" onClick={() => void window.stoke.hub.remote.dropGuests()} title={DISCONNECT_TITLE}>
          Disconnect
        </button>
      </div>
    </RemoteFab>
  )
}

export function RemoteHostStrip({ view, bar }: Props): React.JSX.Element | null {
  const guests = bar === 'bar' ? view.guests : []
  if (view.asks.length === 0 && guests.length === 0) return null
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
            {attachedSentence(guests)}
          </p>
          <button className="btn" onClick={() => void window.stoke.hub.remote.dropGuests()} title={DISCONNECT_TITLE}>
            Disconnect
          </button>
        </div>
      )}
    </>
  )
}
