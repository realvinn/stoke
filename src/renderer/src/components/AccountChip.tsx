import { useEffect, useRef, useState } from 'react'
import { accountIdentityKey, accountIdentityText, type AccountIdentityTarget } from '@shared/accountIdentity'
import { cliFor, type CodingCliId } from '@shared/codingClis'
import type { HubView } from '@shared/hub/client'
import { useAccountIdentity } from '../lib/useAccountIdentity'
import { useFloatingLayer } from '../lib/floatingLayers'
import { agentMark } from '../lib/agentColor'

export function AccountChip({ target, label, settingsOpen, onAgentSettings, onSyncSettings }: {
  target: AccountIdentityTarget
  label?: string
  settingsOpen: boolean
  onAgentSettings: (cli: CodingCliId) => void
  onSyncSettings: () => void
}): React.JSX.Element {
  const { identity, refresh } = useAccountIdentity(target)
  const [open, setOpen] = useState(false)
  const [hub, setHub] = useState<HubView | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useFloatingLayer(panelRef, open)
  const key = accountIdentityKey(target)
  useEffect(() => { setOpen(false) }, [key, settingsOpen])
  useEffect(() => {
    if (!open) return
    let live = true
    let changed = false
    panelRef.current?.focus()
    const off = window.stoke.hub.onChange(view => { changed = true; if (live) setHub(view) })
    void window.stoke.hub.view().then(view => { if (live && !changed) setHub(view) }).catch(() => { if (live && !changed) setHub(null) })
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus()
    }
    window.addEventListener('keydown', escape, true)
    return () => { live = false; off(); window.removeEventListener('keydown', escape, true) }
  }, [open])
  const nickname = label || identity?.label || (target.accountId === 'default' ? 'Default' : target.accountId)
  const text = accountIdentityText(identity)
  const vendor = cliFor(target.cli).label
  return (
    <div className="account-chip-wrap">
      <button className="account-chip" ref={buttonRef} {...agentMark(target.accountId === 'default' ? target.cli : target.accountId)} data-testid="active-account" data-account={target.accountId} aria-expanded={open} aria-haspopup="dialog" title={`${vendor} · ${nickname} — ${text}. Account details.`} onClick={() => setOpen(v => !v)}>
        <span className="account-chip-label">{vendor} · {nickname}</span>
        <span className="account-chip-identity">{text}</span>
      </button>
      {open && <>
        <div className="popover-backdrop" onClick={() => setOpen(false)} />
        <div className="popover account-panel" role="dialog" aria-label="Accounts" ref={panelRef} tabIndex={-1}>
          <span className="popover-title">Agent account</span>
          <strong>{vendor} · {nickname}</strong>
          <span className="account-panel-email" data-testid="account-identity">{text}</span>
          {identity?.organization && <span>{identity.organization}</span>}
          {identity?.plan && <span className="field-hint">Plan: {identity.plan}</span>}
          <p className="popover-text">{identity?.detail || 'Reading this account’s sign-in identity…'} {target.ptyId && 'An existing session may retain credentials from launch after its saved login changes.'}</p>
          <div className="account-panel-actions">
            <button className="btn" onClick={refresh}>Refresh</button>
            <button className="btn" onClick={() => { setOpen(false); onAgentSettings(target.cli) }}>Manage agent accounts</button>
          </div>
          <div className="account-panel-sync">
            <span className="popover-title">Stoke account</span>
            <span className="account-panel-email">{hub?.email || (hub ? 'Not signed in' : 'Checking Stoke sign-in…')}</span>
            {hub?.email && (hub.phase === 'off' || hub.phase === 'signed-out') && <span className="field-hint">Not signed in on this device.</span>}
            {hub?.phase === 'revoked' && <span className="field-hint">This device was removed from the account.</span>}
            <button className="btn" onClick={() => { setOpen(false); onSyncSettings() }}>Account &amp; sync</button>
          </div>
        </div>
      </>}
    </div>
  )
}
