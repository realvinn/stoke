import { useEffect, useRef, useState } from 'react'
import { accountIdentityKey, accountIdentityText, type AccountIdentityTarget } from '@shared/accountIdentity'
import { cliFor, type CodingCliId } from '@shared/codingClis'
import type { HubView } from '@shared/hub/client'
import { useAccountIdentity } from '../lib/useAccountIdentity'
import { useFloatingLayer } from '../lib/floatingLayers'
import { agentMark } from '../lib/agentColor'
import { accountKindsFor } from '@shared/accounts'

export function AccountChip({ target, label, settingsOpen, onAgentSettings, onSyncSettings }: {
  target: AccountIdentityTarget | null
  label?: string
  settingsOpen: boolean
  onAgentSettings: (cli: CodingCliId, kind?: 'login' | 'key') => void
  onSyncSettings: () => void
}): React.JSX.Element {
  const { identity, refresh } = useAccountIdentity(target)
  const [open, setOpen] = useState(false)
  const [hub, setHub] = useState<HubView | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useFloatingLayer(panelRef, open)
  const key = target ? accountIdentityKey(target) : null
  useEffect(() => { setOpen(false) }, [key, settingsOpen])
  useEffect(() => {
    let live = true
    let changed = false
    const off = window.stoke.hub.onChange(view => { changed = true; if (live) setHub(view) })
    void window.stoke.hub.view().then(view => { if (live && !changed) setHub(view) }).catch(() => { if (live && !changed) setHub(null) })
    return () => { live = false; off() }
  }, [])
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus()
    }
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('keydown', escape, true) }
  }, [open])
  const nickname = label || identity?.label || (target?.accountId === 'default' ? 'Default' : target?.accountId)
  const text = accountIdentityText(identity)
  const vendor = target ? cliFor(target.cli).label : 'Stoke'
  const stokeSignedIn = hub && ['new-account', 'locked', 'active'].includes(hub.phase)
  const stokeIdentity = stokeSignedIn ? hub.email || 'Signed in' : hub?.phase === 'revoked' ? 'Device removed' : hub ? 'Not signed in' : 'Account & sync'
  return (
    <div className="account-chip-wrap">
      <button className="account-chip" ref={buttonRef} {...(target ? agentMark(target.accountId === 'default' ? target.cli : target.accountId) : {})} data-testid="active-account" data-account={target?.accountId} aria-expanded={open} aria-haspopup="dialog" title={target ? `${vendor} · ${nickname} — ${text}. Account details.` : `Stoke account · ${stokeIdentity}`} onClick={() => setOpen(v => !v)}>
        <span className="account-chip-label">{target ? `${vendor} · ${nickname}` : 'Stoke account'}</span>
        <span className="account-chip-identity">{target ? text : stokeIdentity}</span>
      </button>
      {open && <>
        <div className="popover-backdrop" onClick={() => setOpen(false)} />
        <div className="popover account-panel" role="dialog" aria-label="Accounts" ref={panelRef} tabIndex={-1}>
          {target && <>
          <span className="popover-title">Agent account</span>
          <strong>{vendor} · {nickname}</strong>
          <span className="account-panel-email" data-testid="account-identity">{text}</span>
          {identity?.organization && <span>{identity.organization}</span>}
          {identity?.plan && <span className="field-hint">Plan: {identity.plan}</span>}
          <p className="popover-text">{identity?.detail || 'Reading this account’s sign-in identity…'} {target.ptyId && 'An existing session may retain credentials from launch after its saved login changes.'}</p>
          <div className="account-panel-actions">
            <button className="btn" onClick={refresh}>Refresh</button>
            <button className="btn" onClick={() => { setOpen(false); onAgentSettings(target.cli) }}>Manage agent accounts</button>
            {accountKindsFor(target.cli).includes('key') && <button className="btn" onClick={() => { setOpen(false); onAgentSettings(target.cli, 'key') }}>Add API account</button>}
          </div>
          </>}
          {!target && <>
            <span className="popover-title">API accounts</span>
            <p className="popover-text">Add a named key for Anthropic, OpenAI or a compatible provider.</p>
            <div className="account-panel-actions">
              <button className="btn" onClick={() => { setOpen(false); onAgentSettings('claude', 'key') }}>Claude / Anthropic API</button>
              <button className="btn" onClick={() => { setOpen(false); onAgentSettings('codex', 'key') }}>Codex / OpenAI API</button>
            </div>
          </>}
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
