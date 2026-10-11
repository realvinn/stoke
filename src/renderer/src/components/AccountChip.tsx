import { useEffect, useRef, useState } from 'react'
import { accountIdentityKey, accountIdentityText, type AccountIdentityTarget } from '@shared/accountIdentity'
import { cliFor, type CodingCliId } from '@shared/codingClis'
import { useAccountIdentity } from '../lib/useAccountIdentity'
import { useFloatingLayer } from '../lib/floatingLayers'
import { agentMark } from '../lib/agentColor'
import { accountKindsFor } from '@shared/accounts'
import { stokeAccountSummary, useStokeAccount } from '../lib/useStokeAccount'
import { IconChevron } from './Icons'

export function AccountChip({ target, label, settingsOpen, onAgentSettings, onSyncSettings, onAccounts, surface = 'titlebar' }: {
  target: AccountIdentityTarget | null
  label?: string
  settingsOpen: boolean
  onAgentSettings: (cli: CodingCliId, kind?: 'login' | 'key') => void
  onSyncSettings: () => void
  onAccounts: () => void
  surface?: 'titlebar' | 'sidebar'
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
  const sidebar = surface === 'sidebar'
  return (
    <div className="account-chip-wrap" data-surface={surface} onKeyDown={event => { if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation() }}>
      <button className="account-chip" ref={buttonRef} {...(target ? agentMark(target.accountId === 'default' ? target.cli : target.accountId) : {})} data-testid={sidebar ? 'stoke-account' : 'active-account'} data-account={target?.accountId} aria-expanded={open} aria-haspopup="dialog" title={target ? `${vendor} · ${nickname} — ${text}. Account details.` : `Stoke account · ${stoke.identity}`} onClick={() => setOpen(v => !v)}>
        {sidebar && <span className="account-avatar" aria-hidden="true">{stoke.signedIn ? stoke.identity.slice(0, 1).toUpperCase() : 'S'}</span>}
        <span className="account-chip-copy">
          <span className="account-chip-label">{target ? `${vendor} · ${nickname}` : sidebar ? 'Stoke account' : 'Accounts'}</span>
          <span className="account-chip-identity">{target ? text : sidebar && !stoke.signedIn ? 'Sign in & manage accounts' : stoke.identity}</span>
        </span>
        {sidebar && <IconChevron />}
      </button>
      {open && <>
        <div className="popover-backdrop" onClick={() => setOpen(false)} />
        <div className="popover account-panel" role="dialog" aria-label="Accounts" ref={panelRef} tabIndex={-1}>
          {!target && <div className="account-panel-sync">
            <span className="popover-title">Stoke account</span>
            <span className="account-panel-email">{stoke.identity}</span>
            <p className="popover-text">Connect your devices and choose what Stoke syncs.</p>
            <button className="btn" onClick={() => { setOpen(false); onSyncSettings() }}>{stoke.signedIn ? 'Account & sync' : 'Sign in to Stoke'}</button>
          </div>}
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
            <div className="account-panel-section">
            <span className="popover-title">Coding accounts</span>
            <p className="popover-text">Manage subscription sign-ins and API accounts. NanoGPT and OpenRouter are under Custom API.</p>
            <div className="account-panel-actions">
              <button className="btn" onClick={() => { setOpen(false); onAccounts() }}>Manage accounts</button>
              <button className="btn" onClick={() => { setOpen(false); onAgentSettings('claude', 'key') }}>Claude / Anthropic API</button>
              <button className="btn" onClick={() => { setOpen(false); onAgentSettings('codex', 'key') }}>Codex / OpenAI API</button>
            </div>
            </div>
          </>}
          {target && <div className="account-panel-sync">
            <span className="popover-title">Stoke account</span>
            <span className="account-panel-email">{stoke.identity}</span>
            <div className="account-panel-actions"><button className="btn" onClick={() => { setOpen(false); onAccounts() }}>All accounts</button><button className="btn" data-variant="ghost" onClick={() => { setOpen(false); onSyncSettings() }}>Account &amp; sync</button></div>
          </div>}
        </div>
      </>}
    </div>
  )
}
