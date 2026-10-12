import type { Settings } from '@shared/types'
import { useRef } from 'react'
import { accountsOf, DEFAULT_ACCOUNT_ID } from '@shared/accounts'
import { cliFor, type CodingCliId } from '@shared/codingClis'
import { AgentAccounts } from './AgentAccounts'
import type { SettingsLocation } from '@shared/settingsIndex'
import { agentMark } from '../lib/agentColor'
import { stokeAccountSummary, useStokeAccount } from '../lib/useStokeAccount'

/** A compact directory; editing lives in each agent's Accounts submenu. */
export function AccountsSettings({ settings, agents, onManage, onSync }: {
  settings: Settings
  agents: readonly CodingCliId[]
  onManage: (cli: CodingCliId) => void
  onSync: () => void
}): React.JSX.Element {
  const state = useStokeAccount()
  const hub = stokeAccountSummary(state)
  return <div className="accounts-settings" data-testid="accounts-overview" data-setting="accounts.overview">
    <header className="accounts-heading">
      <h2>Accounts</h2>
      <p className="field-hint">Pick an agent, then choose or add an account.</p>
    </header>
    <section className="accounts-stoke" data-setting="accounts.stoke">
      <div className="accounts-stoke-identity">
        <span className="account-avatar" aria-hidden="true">{hub.signedIn ? hub.identity.slice(0, 1).toUpperCase() : 'S'}</span>
        <div className="agent-account-body"><strong>Stoke account</strong><span className="field-hint">{hub.identity}</span></div>
      </div>
      <p className="field-hint">Connect your devices and choose what syncs.</p>
      <button className="btn" onClick={onSync}>{hub.signedIn ? 'Manage account & sync' : 'Sign in to Stoke'}</button>
    </section>
    <section className="accounts-agent-list" data-setting="accounts.agents">
      <div className="accounts-heading"><h3>Coding agents</h3></div>
      {agents.map(id => {
        const cli = cliFor(id)
        const accounts = accountsOf(cli.id, settings.accounts)
        const selected = accounts.find(account => account.id === settings.agents.defaultAccount[cli.id])
        return <button className="accounts-agent" key={cli.id} data-cli={cli.id} onClick={() => onManage(cli.id)} aria-label={`Manage ${cli.label} accounts`}>
            <span className="agent-tab-dot" {...agentMark(cli.id)} aria-hidden="true" />
            <span className="agent-account-body">
              <strong>{cli.label}</strong>
              <span className="field-hint" data-account={selected?.id ?? DEFAULT_ACCOUNT_ID}>Active: {selected?.label ?? 'Default · Existing setup'}</span>
            </span>
            <span className="field-hint accounts-count">{accounts.length ? `${accounts.length} saved` : ''}</span>
            <span aria-hidden="true">›</span>
        </button>
      })}
      <p className="field-hint">Your existing CLI login is Default. {state?.accountSync === true && state.scope.accounts ? 'Account sync is on for this computer.' : 'Turn on account sync under Stoke to share saved accounts with your other devices.'}</p>
    </section>
  </div>
}

export function AgentAccountsPage({ settings, agent, section, sectionRevision, onPatch, onSignIn, onGo }: {
  settings: Settings
  agent: CodingCliId
  section?: string
  sectionRevision?: number
  onPatch: (patch: Partial<Settings>) => void
  onSignIn: (accountId: string) => void
  onGo: (location: SettingsLocation) => void
}): React.JSX.Element {
  // The radio writer must retain other agents' choices across rapid selections.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const cli = cliFor(agent)
  return <div className="accounts-settings" data-testid="agent-account-page" data-cli={agent}>
    <header className="accounts-heading">
      <button className="btn accounts-back" data-variant="ghost" onClick={() => onGo({ page: 'accounts' })}>‹ All accounts</button>
      <h2>{cli.label}</h2>
    </header>
    <AgentAccounts key={agent} cli={cli} section={section} sectionRevision={sectionRevision} accounts={accountsOf(agent, settings.accounts)} defaultId={settings.agents.defaultAccount[agent]}
      onDefault={id => {
        const current = settingsRef.current
        const defaultAccount = { ...current.agents.defaultAccount }
        if (id === DEFAULT_ACCOUNT_ID) delete defaultAccount[agent]
        else defaultAccount[agent] = id
        const agents = { ...current.agents, defaultAccount }
        settingsRef.current = { ...current, agents }
        onPatch({ agents })
      }}
      onPatchAccount={(id, patch) => {
        const account = settingsRef.current.accounts[id]
        if (account) onPatch({ accounts: { [id]: { ...account, ...patch } } })
      }} onSignIn={onSignIn}
      savedApiAccounts={agent === 'opencode' ? Object.values(settings.accounts).filter(account => account.cli !== 'opencode' && account.kind === 'key' && !!account.apiKey && !!account.apiProfile && account.apiProfile.provider !== 'custom') : undefined} />
  </div>
}
