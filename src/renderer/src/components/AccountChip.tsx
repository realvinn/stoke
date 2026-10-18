import { useEffect, useRef, useState } from 'react'
import { accountIdentityKey, accountIdentityText, type AccountIdentityTarget } from '@shared/accountIdentity'
import { cliFor } from '@shared/codingClis'
import { useAccountIdentity } from '../lib/useAccountIdentity'
import { useFloatingLayer } from '../lib/floatingLayers'
import { agentMark } from '../lib/agentColor'
import { stokeAccountSummary, useStokeAccount } from '../lib/useStokeAccount'
import { IconChevron } from './Icons'

export function AccountChip({ target, label, settingsOpen, onSyncSettings, onAccounts }: {
  target: AccountIdentityTarget | null
  label?: string
  settingsOpen: boolean
  onSyncSettings: () => void
  onAccounts: () => void
}): React.JSX.Element {
  const { identity, refresh } = useAccountIdentity(target)
  const [open, setOpen] = useState(false)
  const hub = useStokeAccount()
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useFloatingLayer(panelRef, open)
  const key = target ? accountIdentityKey(target) : null
  useEffect(() => { setOpen(false) }, [key, settingsOpen])
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
  const stoke = stokeAccountSummary(hub)
  return (
    <div className="account-chip-wrap" data-surface="sidebar" onKeyDown={event => { if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation() }}>
      <button className="account-chip" ref={buttonRef} data-testid="stoke-account" data-account={target?.accountId} data-cli={target?.cli} aria-label={`Stoke account — ${stoke.identity}`} aria-expanded={open} aria-haspopup="dialog" title={`Stoke account — ${stoke.identity}. ${stoke.status}`} onClick={() => setOpen(v => !v)}>
        <span className="account-chip-avatar" aria-hidden="true">{stoke.signedIn ? stoke.identity.slice(0, 1).toUpperCase() : 'S'}</span>
        <span className="account-chip-label">{stoke.signedIn ? stoke.identity : 'Sign in to Stoke'}</span>
        {target && <span className="sr-only">{vendor} · {nickname}. </span>}
        <span className="sr-only account-chip-identity">{target ? text : stoke.identity}</span>
        <IconChevron />
      </button>
      {open && <>
        <div className="popover-backdrop" onClick={() => setOpen(false)} />
        <div className="popover account-panel" role="dialog" aria-label="Stoke account" ref={panelRef} tabIndex={-1}>
          <div className="account-panel-sync">
            <div className="account-panel-heading">
              <span className="account-avatar" aria-hidden="true">{stoke.signedIn ? stoke.identity.slice(0, 1).toUpperCase() : 'S'}</span>
              <div className="agent-account-body"><strong>Stoke account</strong><span className="account-panel-email">{stoke.identity}</span></div>
            </div>
            <p className="popover-text">{stoke.signedIn ? stoke.status : 'Sign in to connect your devices and sync saved accounts.'}</p>
          </div>
          {target && <div className="account-panel-section">
            <div className="account-panel-heading">
              <span className="agent-tab-dot" {...agentMark(target.accountId === 'default' ? target.cli : target.accountId)} aria-hidden="true" />
              <span className="popover-title">This session</span>
            </div>
            <strong>{vendor} · {nickname}</strong>
            <span className="account-panel-email" data-testid="account-identity">{text}</span>
            {identity?.organization && <span className="field-hint">{identity.organization}</span>}
            {identity?.plan && <span className="field-hint">{identity.plan}</span>}
            <div className="account-panel-session-note"><span className="field-hint">Running sessions keep the account they started with.</span><button className="btn" data-variant="ghost" onClick={refresh}>Refresh identity</button></div>
          </div>}
          <div className="account-panel-actions">
            <button className="btn" data-variant="primary" onClick={() => { setOpen(false); onSyncSettings() }}>{stoke.signedIn ? 'Devices & sync' : 'Sign in to Stoke'}</button>
            <button className="btn" data-variant="ghost" onClick={() => { setOpen(false); onAccounts() }}>Agent accounts</button>
          </div>
        </div>
      </>}
    </div>
  )
}
