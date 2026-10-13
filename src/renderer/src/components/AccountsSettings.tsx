import type { Settings } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { accountsOf, DEFAULT_ACCOUNT_ID } from '@shared/accounts'
import { cliFor, type CodingCliId } from '@shared/codingClis'
import { AgentAccounts } from './AgentAccounts'
import type { SettingsLocation } from '@shared/settingsIndex'
import { agentMark } from '../lib/agentColor'
import { stokeAccountSummary, useStokeAccount } from '../lib/useStokeAccount'
import type { PluginsView } from '@shared/pluginPackages'
import type { GrokBotView } from '@shared/grokBot'

/** A compact directory; editing lives in each agent's Accounts submenu. */
export function AccountsSettings({ settings, agents, plugins, onManage, onSync, onPlugin }: {
  settings: Settings
  agents: readonly CodingCliId[]
  plugins: PluginsView | null
  onManage: (cli: CodingCliId) => void
  onSync: () => void
  onPlugin: (id: string) => void
}): React.JSX.Element {
  const state = useStokeAccount()
  const hub = stokeAccountSummary(state)
  const grokEnabled = plugins?.entries.some(entry => entry.manifest.id === 'grok-bot' && entry.enabled) === true
  const [grok, setGrok] = useState<GrokBotView | null>(null)
  const [grokError, setGrokError] = useState(false)
  useEffect(() => {
    if (!grokEnabled) return
    let live = true, changed = false
    setGrokError(false)
    const accept = (next: GrokBotView): void => {
      if (live) setGrok(old => old && old.revision > next.revision ? old : next)
    }
    const off = window.stoke.grokBot.onChange(next => { changed = true; accept(next) })
    void window.stoke.grokBot.read().then(next => { if (!changed) accept(next) }).catch(() => { if (live && !changed) setGrokError(true) })
    return () => { live = false; off() }
  }, [grokEnabled])
  const grokDefault = grok?.accounts.find(account => account.id === grok.defaultAccount)
  const syncText = !hub.signedIn ? 'Sign in to connect your devices' : state?.phase !== 'active' ? hub.status : state.accountSync !== true ? 'Agent account sync is off' : state.scope.accounts ? 'Agent accounts sync on this computer' : 'Agent account sync is paused here'
  return <div className="accounts-settings" data-testid="accounts-overview" data-setting="accounts.overview">
    <header className="accounts-heading">
      <h2>Accounts</h2>
      <p className="field-hint">Your Stoke sign-in, saved logins and API accounts.</p>
    </header>
    <section className="accounts-stoke" data-setting="accounts.stoke">
      <div className="accounts-stoke-identity">
        <span className="account-avatar" aria-hidden="true">{hub.signedIn ? hub.identity.slice(0, 1).toUpperCase() : 'S'}</span>
        <div className="agent-account-body"><strong>Stoke account</strong><span className="field-hint">{hub.identity}</span></div>
      </div>
      <div className="accounts-stoke-meta"><span className="field-hint">{syncText}</span>{state?.phase === 'active' && <span className="field-hint">{state.devices.length} approved {state.devices.length === 1 ? 'device' : 'devices'}</span>}</div>
      <button className="btn" onClick={onSync}>{hub.signedIn ? 'Devices & sync' : 'Sign in to Stoke'}</button>
    </section>
    <section className="accounts-agent-list" data-setting="accounts.agents">
      <div className="accounts-heading"><h3>Agent accounts</h3><p className="field-hint">Choose an agent to manage its sign-ins and API connections.</p></div>
      {agents.map(id => {
        const cli = cliFor(id)
        const accounts = accountsOf(cli.id, settings.accounts)
        const selected = accounts.find(account => account.id === settings.agents.defaultAccount[cli.id])
        return <button className="accounts-agent" key={cli.id} data-cli={cli.id} onClick={() => onManage(cli.id)} aria-label={`Manage ${cli.label} accounts`}>
            <span className="agent-tab-dot" {...agentMark(cli.id)} aria-hidden="true" />
            <span className="agent-account-body">
              <strong>{cli.label}</strong>
              <span className="field-hint" data-account={selected?.id ?? DEFAULT_ACCOUNT_ID}>New sessions: {selected?.label ?? 'Default · Existing setup'}</span>
            </span>
            <span className="field-hint accounts-count">{accounts.length ? `${accounts.length} saved` : 'Existing setup'}</span>
            <span aria-hidden="true">›</span>
        </button>
      })}
      {grokEnabled && <button className="accounts-agent" data-plugin="grok-bot" data-setting="accounts.grok-bot" onClick={() => onPlugin('grok-bot')} aria-label="Manage Grok Bot accounts">
        <span className="account-plugin-mark" aria-hidden="true">G</span>
        <span className="agent-account-body"><strong>Grok Bot</strong><span className="field-hint">{grokError ? 'Open the plugin to check its saved accounts' : grokDefault ? `New chats: ${grokDefault.label}` : grok ? 'Import desktop logins' : 'Reading accounts…'}</span></span>
        <span className="field-hint accounts-count">{grok ? `${grok.accounts.length} saved` : ''}</span><span aria-hidden="true">›</span>
      </button>}
      <p className="field-hint">Default uses your existing CLI setup. Account choices apply to new sessions; running sessions keep their original account.</p>
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
