import { useEffect, useState } from 'react'
import type { HubView } from '@shared/hub/client'
import { platformName } from '../lib/hubRemote'
import { IconClose } from './Icons'

/*
 * On a device in the vault: another computer has asked to join it.
 *
 * The request was only ever listed inside Settings › Account & sync, which
 * nobody has open at the moment it arrives — and since a computer that signs
 * in now asks by itself (`autoJoin`, src/main/hub/service.ts), the owner's
 * next step is HERE, on the computer they are not looking at. So it is said
 * above the terminal, a strip in `.main-col` like the SSH key offer and the
 * Other machines question (gotcha 14: anything floating is painted over by the
 * docked browser). Review opens Account & sync, where the codes are compared;
 * nothing is approved from the strip. Not now hides one request for this run.
 *
 * Only a request nobody has answered yet (`waiting`): one this device answered
 * is already on screen in Settings, and one another device answered is being
 * handled there.
 */

interface Props {
  onReview: () => void
}

export function HubJoinPrompt({ onReview }: Props): React.JSX.Element | null {
  const [view, setView] = useState<HubView | null>(null)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  /*
   * Pushes only, never `hub.view()`: that call starts the hub client (it is
   * main's lazy `hubService()`), which on a launch is main's to do, at +4 s and
   * only with a hub address set — asking from here loaded it on every launch,
   * hub or none (found in review, 2026-10-02). The client emits its view when
   * it starts and on every change, a `pair` hint from presence included.
   */
  useEffect(() => window.stoke.hub.onChange((v) => setView(v)), [])

  if (!view || view.phase !== 'active') return null
  const asking = view.pairs.filter((p) => p.state === 'waiting' && !p.mine && !dismissed.has(p.pair))
  if (asking.length === 0) return null
  const first = asking[0]
  const more = asking.length - 1
  const dismiss = (): void => setDismissed((prev) => new Set([...prev, ...asking.map((p) => p.pair)]))

  return (
    <div className="ssh-prompt hub-join-strip" role="status" aria-live="polite" data-hub="join-ask">
      <span className="ssh-prompt-kind">Hub</span>
      <p className="ssh-prompt-text" title={`${first.device.label} (${platformName(first.device.platform)}) asks to join your vault. Approve it only if you just signed in there.`}>
        <strong>{first.device.label}</strong> asks to join your vault{more > 0 ? `, and ${more} more` : ''}. Approve it in Account &amp; sync if you just
        signed in there.
      </p>
      <span className="ssh-prompt-meta truncate">{platformName(first.device.platform)}</span>
      <button className="btn" data-variant="primary" onClick={onReview} aria-label={`Review the request from ${first.device.label}`}>
        Review
      </button>
      <button className="btn" onClick={dismiss} aria-label={`Not now: hide the request from ${first.device.label}`}>
        Not now
      </button>
      <button className="icon-btn" onClick={dismiss} title="Dismiss">
        <IconClose />
        <span className="sr-only">Dismiss the join request from {first.device.label}</span>
      </button>
    </div>
  )
}
