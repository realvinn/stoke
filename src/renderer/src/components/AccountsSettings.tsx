import type { Settings } from '@shared/types'
import { accountKindsFor, accountsOf, DEFAULT_ACCOUNT_ID } from '@shared/accounts'
import { CODING_CLIS, type CodingCliId } from '@shared/codingClis'
import { agentMark } from '../lib/agentColor'
import { stokeAccountSummary, useStokeAccount } from '../lib/useStokeAccount'

/** A single starting point; the existing scoped editor still owns each agent's accounts. */
export function AccountsSettings({ settings, installed, onManage, onSync }: {
  settings: Settings
  installed: readonly CodingCliId[]
  onManage: (cli: CodingCliId, kind?: 'login' | 'key') => void
  onSync: () => void
}): React.JSX.Element {
  const hub = stokeAccountSummary(useStokeAccount())
  const agents = CODING_CLIS.filter(cli => accountKindsFor(cli.id).length > 0 &&
    (['claude', 'codex'].includes(cli.id) || installed.includes(cli.id) || accountsOf(cli.id, settings.accounts).length > 0))
  return <div className="accounts-settings" data-testid="accounts-overview" data-setting="accounts.overview">
    <header className="accounts-heading">
      <h2>Accounts</h2>
      <p className="field-hint">Your Stoke sign-in connects your devices. Agent sign-ins and API keys choose how your coding sessions run.</p>
    </header>
    <section className="accounts-stoke" data-setting="accounts.stoke">
      <div className="accounts-stoke-identity">
        <span className="account-avatar" aria-hidden="true">{hub.signedIn ? hub.identity.slice(0, 1).toUpperCase() : 'S'}</span>
        <div className="agent-account-body"><strong>Stoke account</strong><span className="field-hint">{hub.identity}</span></div>
      </div>
      <p className="field-hint">Manage sign-in, device approval and the settings you sync.</p>
      <button className="btn" onClick={onSync}>{hub.signedIn ? hub.status : 'Sign in to Stoke'}</button>
    </section>
    <section className="accounts-agent-list" data-setting="accounts.agents">
      <div className="accounts-heading"><h3>Agent accounts</h3><p className="field-hint">Your existing CLI login is Default. Add another subscription sign-in or an API account when you need one.</p></div>
      {agents.map(cli => {
        const accounts = accountsOf(cli.id, settings.accounts)
        const selected = accounts.find(account => account.id === settings.agents.defaultAccount[cli.id])
        const logins = accounts.filter(account => account.kind === 'login').length
        const keys = accounts.filter(account => account.kind === 'key').length
        const kinds = accountKindsFor(cli.id)
        return <article className="accounts-agent" key={cli.id} data-cli={cli.id}>
          <div className="accounts-agent-heading">
            <span className="agent-tab-dot" {...agentMark(cli.id)} aria-hidden="true" />
            <strong>{cli.label}</strong>
            <span className="field-hint">{accounts.length === 0 ? 'Existing setup' : `${logins} saved sign-in${logins === 1 ? '' : 's'} · ${keys} API account${keys === 1 ? '' : 's'}`}</span>
          </div>
          <span className="field-hint" data-account={selected?.id ?? DEFAULT_ACCOUNT_ID}>New sessions use <strong>{selected?.label ?? 'Default · Existing setup'}</strong></span>
          <div className="btn-row">
            <button className="btn" onClick={() => onManage(cli.id)}>Manage accounts</button>
            {kinds.includes('login') && <button className="btn" data-variant="ghost" onClick={() => onManage(cli.id, 'login')}>Add sign-in</button>}
            {kinds.includes('key') && <button className="btn" data-variant="ghost" onClick={() => onManage(cli.id, 'key')}>Add API account</button>}
          </div>
        </article>
      })}
      <p className="field-hint">Agent accounts are saved on this computer. API accounts use provider billing; subscription sign-ins use your agent plan.</p>
    </section>
  </div>
}
