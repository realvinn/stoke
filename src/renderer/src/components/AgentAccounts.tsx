import { useEffect, useRef, useState } from 'react'
import { accountIdentityTarget, accountIdentityText, identityFor, unavailableAccountIdentity, type AccountIdentity } from '@shared/accountIdentity'
import { ACCOUNT_IDENTITY_CHANGED } from '../lib/useAccountIdentity'
import type { CodingCli, CodingCliId } from '@shared/codingClis'
import { accountApiProfileProblem, accountProvidersFor, ACCOUNT_PROVIDER_LABELS, defaultAccountApiProfile, type AccountApiProfile } from '@shared/accountProviders'
import { ACCOUNT_KEY_ENV, ACCOUNT_LABEL_MAX, accountKindsFor, DEFAULT_ACCOUNT_ID, type AccountKind, type AgentAccount } from '@shared/accounts'
import { accountMcpLines, type AccountMcpSummary } from '@shared/mcpServers'
import { Spinner } from './Spinner'
import { agentMark } from '../lib/agentColor'
import { ipcErrorMessage } from '../lib/format'

/*
 * An agent's accounts (shared/accounts.ts): its own sign-in (Default), then
 * every account Stoke holds for it, which one new sessions start on, and how
 * to add another. A login account is made by main — the renderer names an
 * agent and a label, never a folder — and signed in by the agent's own login,
 * in a tab (`onSignIn`). A key account's key is sealed like every other.
 *
 * Saved accounts are summaries until Edit is chosen; their drafts are saved
 * together explicitly. The whole map is not needed on a commit: main applies
 * a label, key or API profile to the one account named and ignores everything
 * else (`accountsFromRenderer`).
 */
export function AgentAccounts({
  cli,
  section,
  sectionRevision,
  accounts,
  defaultId,
  onDefault,
  onPatchAccount,
  onSignIn,
  savedApiAccounts = []
}: {
  cli: CodingCli
  section?: string
  sectionRevision?: number
  accounts: AgentAccount[]
  /** The stored default account for this agent, or absent for its own sign-in. */
  defaultId: string | undefined
  onDefault: (id: string) => void
  onPatchAccount: (id: string, patch: { label?: string; apiKey?: string; apiProfile?: AccountApiProfile }) => void
  onSignIn: (id: string) => void
  /** Compatible saved keys offered only inside OpenCode's add form. */
  savedApiAccounts?: AgentAccount[]
}): React.JSX.Element | null {
  const kinds = accountKindsFor(cli.id)
  const [name, setName] = useState('')
  const [apiName, setApiName] = useState('')
  const [key, setKey] = useState('')
  const [apiProfile, setApiProfile] = useState(() => defaultAccountApiProfile(cli.id))
  const [keySource, setKeySource] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageError, setMessageError] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [identities, setIdentities] = useState<Record<string, AccountIdentity | null>>({})
  const [identityRevision, setIdentityRevision] = useState(0)
  const [mcp, setMcp] = useState<Record<string, AccountMcpSummary>>({})
  const [adding, setAdding] = useState<'choose' | AccountKind | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const addPane = useRef<HTMLDivElement>(null)
  const wasAdding = useRef(false)
  useEffect(() => {
    if (section === 'agent-accounts.login') setAdding('login')
    else if (section === 'agent-accounts.api' || section === 'agent-accounts.anthropic') setAdding('key')
  }, [section, sectionRevision])
  useEffect(() => {
    if (adding) {
      const pane = addPane.current
      const target = adding === 'choose'
        ? pane?.querySelector<HTMLElement>('[data-testid="choose-login-account"], [data-testid="choose-api-account"]')
        // Both forms stay mounted; focus only the one that is open.
        : pane?.querySelector<HTMLElement>('details[open]:not([hidden]) input:not([type="hidden"])') ?? pane?.querySelector<HTMLElement>('details[open]:not([hidden]) select')
      target?.focus()
    }
    else if (wasAdding.current) addButton.current?.focus()
    wasAdding.current = !!adding
  }, [adding])
  const cancelAdd = (): void => {
    if (busyRef.current) return
    setAdding(null); setName(''); setApiName(''); setKey(''); setKeySource('')
    setApiProfile(defaultAccountApiProfile(cli.id)); setMessage(null)
  }
  const homes = accounts.map((a) => `${a.id}:${a.home}:${a.apiProfile?.provider ?? ''}:${!!a.apiKey}`).join('|')
  useEffect(() => { setApiProfile(defaultAccountApiProfile(cli.id)) }, [cli.id])
  useEffect(() => {
    const changed = (event: Event) => {
      if (accountIdentityTarget((event as CustomEvent).detail)?.cli === cli.id) setIdentityRevision(v => v + 1)
    }
    window.addEventListener(ACCOUNT_IDENTITY_CHANGED, changed)
    return () => window.removeEventListener(ACCOUNT_IDENTITY_CHANGED, changed)
  }, [cli.id])
  useEffect(() => {
    if (cli.id !== 'claude') return
    let live = true
    // What each account is handed of Default's user-scope MCP servers.
    void window.stoke.accounts.mcp().then((m) => {
      if (live) setMcp(m)
    })
    return () => {
      live = false
    }
  }, [cli.id, homes])
  useEffect(() => {
    let live = true
    let running = false
    const ids = [DEFAULT_ACCOUNT_ID, ...accounts.map(a => a.id)]
    const pull = async (refresh = false) => {
      if (running) return
      running = true
      try {
        for (const accountId of ids) {
          if (!live) break
          const target = { cli: cli.id, accountId }
          const value = await window.stoke.accounts.identity(target, refresh).catch(() => null)
          if (live) setIdentities(prev => ({ ...prev, [accountId]: value || unavailableAccountIdentity(target) }))
        }
      } finally { running = false }
    }
    void pull(identityRevision > 0)
    const focus = () => { void pull() }
    window.addEventListener('focus', focus)
    const timer = window.setInterval(focus, 30_000)
    return () => { live = false; window.removeEventListener('focus', focus); window.clearInterval(timer) }
    // The stable account/home list scopes these reads; labels are drawn from current props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli.id, homes, identityRevision])
  const identity = (id: string) => identityFor({ cli: cli.id, accountId: id }, identities[id] ?? null)

  if (kinds.length === 0) {
    return (
      <div className="field" data-testid="agent-accounts" data-setting="agent-accounts.list">
        <span className="field-label">Accounts</span>
        <span className="field-hint">
          {cli.label} keeps one sign-in for the whole machine and takes no key from Stoke, so it
          runs on its own sign-in only.
        </span>
        <span className="field-hint" data-testid="default-account-identity">{accountIdentityText(identity(DEFAULT_ACCOUNT_ID))}</span>
        <button className="btn" onClick={() => setIdentityRevision(v => v + 1)}>Refresh sign-in</button>
      </div>
    )
  }

  const current = defaultId && accounts.some((a) => a.id === defaultId) ? defaultId : DEFAULT_ACCOUNT_ID
  // What a blank name becomes: main's rule, the first free `<cli>-<n>` from 2.
  let nextNumber = 2
  while (accounts.some((a) => a.id === `${cli.id}-${nextNumber}`)) nextNumber++
  const add = async (kind: AccountKind): Promise<void> => {
    // Claimed before the await (gotcha 20): a second press would make a second account.
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage(null)
    setMessageError(false)
    try {
      const res = await window.stoke.accounts.create({ cli: cli.id, name: kind === 'key' ? apiName : name, kind, apiKey: kind === 'key' ? key : undefined, ...(kind === 'key' && apiProfile ? { apiProfile } : {}) })
      if (!res.ok) {
        setMessage(res.message)
        setMessageError(true)
        return
      }
      if (kind === 'key') {
        setApiName(''); setKey(''); setKeySource('')
        onDefault(res.account.id)
        setMessage(res.created ? `${res.account.label} added. New ${cli.label} sessions will use it.` : `${res.account.label} selected.`)
      } else setName('')
      setAdding(null)
      if (!res.created) setMessage(`${res.account.label} is already here.`)
      // A login account is signed in at once, in a tab: that is what it is for.
      if (kind === 'login') onSignIn(res.account.id)
    } catch (error) {
      setMessage(ipcErrorMessage(error))
      setMessageError(true)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="field agent-accounts" data-testid="agent-accounts" data-setting="agent-accounts.list">
      <div className="account-manager-heading">
        <span className="field-label">{adding ? 'Add account' : 'Your accounts'}</span>
        {adding ? <button className="btn" data-variant="ghost" disabled={busy} onClick={cancelAdd}>Cancel</button> : <button className="btn" ref={addButton} data-testid="add-account-start" onClick={() => { setMessage(null); setAdding(kinds.length === 1 ? kinds[0] : 'choose') }}>+ Add account</button>}
      </div>
      {!adding && <span className="field-hint">The active account is used for new sessions. Running sessions keep their account.</span>}
      <div className="agent-account-list" hidden={!!adding} role="radiogroup" aria-label={`Account new ${cli.label} sessions start on`}>
        <label className="account-manager-existing">
          <input type="radio" name={`account-${cli.id}`} checked={current === DEFAULT_ACCOUNT_ID} onChange={() => onDefault(DEFAULT_ACCOUNT_ID)} aria-label={`Use the existing ${cli.label} setup for new sessions`} />
          <span className="agent-account-body">
            <strong className="agent-account-name">Existing setup <span className="field-hint">· Default</span></strong>
            <span className="account-manager-identity" data-testid="default-account-identity" title={identity(DEFAULT_ACCOUNT_ID)?.detail}>{accountIdentityText(identity(DEFAULT_ACCOUNT_ID))}</span>
            <span className="field-hint">Uses your existing {cli.label} login or API configuration. You don’t need to add it again.</span>
          </span>
          {current === DEFAULT_ACCOUNT_ID && <span className="account-manager-selected">Active</span>}
        </label>
        {(['login', 'key'] as const).map(kind => {
          const saved = accounts.filter(account => account.kind === kind)
          return saved.length > 0 && <section className="account-manager-group" key={kind} aria-label={kind === 'login' ? 'Saved sign-ins' : 'Saved API accounts'}>
            <span className="field-label">{kind === 'login' ? 'Saved sign-ins' : 'Saved API accounts'}</span>
            {saved.map(a => <AccountRow
              key={a.id} cli={cli} account={a} identity={identity(a.id)} mcp={mcp[a.id] ?? null}
              checked={current === a.id} onDefault={() => onDefault(a.id)}
              onPatch={patch => onPatchAccount(a.id, patch)} onSignIn={() => onSignIn(a.id)}
              removing={removing === a.id}
              onRemove={() => {
                if (removing !== a.id) { setRemoving(a.id); return }
                setRemoving(null)
                void window.stoke.accounts.remove(a.id)
              }}
              onKeepIt={() => setRemoving(null)}
            />)}
          </section>
        })}
      </div>
      <div className="account-manager-add-flow" ref={addPane} hidden={!adding}>
      {adding === 'choose' && <div className="account-manager-choices">
        {kinds.includes('login') && <button className="accounts-agent" data-testid="choose-login-account" onClick={() => setAdding('login')}>
          <span className="agent-account-body"><strong>Sign in</strong><span className="field-hint">{cli.id === 'claude' ? 'Claude subscription' : cli.id === 'codex' ? 'ChatGPT subscription' : `${cli.label} account`} · opens the official login</span></span><span aria-hidden="true">›</span>
        </button>}
        {kinds.includes('key') && <button className="accounts-agent" data-testid="choose-api-account" onClick={() => setAdding('key')}>
          <span className="agent-account-body"><strong>API key</strong><span className="field-hint">Connect a provider · billed separately</span></span><span aria-hidden="true">›</span>
        </button>}
      </div>}
      {kinds.includes('login') && <details className="account-manager-add" open={adding === 'login'} hidden={adding !== 'login'} data-testid="add-login-account">
        <summary>Add another sign-in <span className="field-hint">{cli.id === 'claude' ? 'Use a Claude subscription' : cli.id === 'codex' ? 'Use a ChatGPT subscription' : `Use another ${cli.label} login`}</span></summary>
        <div className="account-manager-form" data-setting="agent-accounts.login">
          <span className="field-hint">Sign in to another {cli.label} account in a new tab. Keep a nickname to tell your accounts apart.</span>
          <label className="account-manager-field">Nickname <span className="field-hint">Optional</span>
            <input className="input" value={name} placeholder={`e.g. Work (blank: ${cli.label} ${nextNumber})`}
              aria-label={`New ${cli.label} account name`} maxLength={ACCOUNT_LABEL_MAX} spellCheck={false}
              onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add('login') }} />
          </label>
          <button className="btn" data-testid="add-account" disabled={busy} aria-busy={busy} onClick={() => void add('login')}>
            {busy && <Spinner />}
            Continue to sign in
          </button>
        </div>
      </details>}
      {kinds.includes('key') && (
        <details className="account-manager-add" open={adding === 'key'} hidden={adding !== 'key'} data-testid="add-api-account">
          <summary>Add an API account <span className="field-hint">Use an API key</span></summary>
          <div className="account-manager-form" data-setting="agent-accounts.api">
            <span className="field-hint">API access is billed by the provider, separately from subscription sign-ins.</span>
            {cli.id === 'opencode' && savedApiAccounts.length > 0 && <label className="account-manager-field">API key source
              <select className="input" aria-label="OpenCode API key source" value={keySource} onChange={event => {
                const source = savedApiAccounts.find(account => account.id === event.target.value)
                setKeySource(source?.id ?? '')
                setKey(source?.apiKey ?? '')
                setApiName(source?.label ?? '')
                const next = defaultAccountApiProfile(cli.id, source?.apiProfile?.provider)
                setApiProfile(next ? { ...next, model: source?.apiProfile?.model ?? '' } : null)
              }}>
                <option value="">Enter a new key</option>
                {savedApiAccounts.map(account => <option key={account.id} value={account.id}>{account.label} · {ACCOUNT_PROVIDER_LABELS[account.apiProfile!.provider]}</option>)}
              </select>
              <span className="field-hint">Reuses the saved key when you add this account. Future edits are separate.</span>
            </label>}
            <label className="account-manager-field">Nickname <span className="field-hint">Optional</span>
              <input
                className="input"
                value={apiName}
                placeholder={`Name, e.g. work API (blank: ${cli.label} ${nextNumber})`}
                aria-label={`New ${cli.label} API account name`}
                maxLength={ACCOUNT_LABEL_MAX}
                spellCheck={false}
                onChange={(e) => setApiName(e.target.value)}
              />
            </label>
            {apiProfile && <AccountProfileFields cli={cli.id} value={apiProfile} onChange={setApiProfile} label="New API account" />}
            <label className="account-manager-field">API key
              <input
                className="input mono"
                type="password"
                value={key}
                placeholder={apiProfile ? `${ACCOUNT_PROVIDER_LABELS[apiProfile.provider]} key or token` : `${ACCOUNT_KEY_ENV[cli.id]?.key ?? 'API key'} for a key account`}
                aria-label={`New ${cli.label} account API key`}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => { setKey(e.target.value); setKeySource('') }}
              />
            </label>
            <button className="btn" disabled={busy || !key.trim() || !!(apiProfile && accountApiProfileProblem(cli.id, apiProfile))} onClick={() => void add('key')}>
              Add API account
            </button>
          </div>
        </details>
      )}
      </div>
      {message && (
        <span className="field-hint" role="status" data-tone={messageError ? 'warning' : undefined}>
          {message}
        </span>
      )}
      {!adding && <div className="account-manager-heading"><span className="field-hint">Saved on this computer.</span><button className="btn" data-variant="ghost" onClick={() => setIdentityRevision(v => v + 1)}>Refresh sign-ins</button></div>}
    </div>
  )
}

function AccountProfileFields({ cli, value, onChange, label }: { cli: CodingCliId; value: AccountApiProfile; onChange: (value: AccountApiProfile) => void; label: string }): React.JSX.Element {
  const problem = accountApiProfileProblem(cli, value)
  const direct = accountProvidersFor(cli).filter(provider => provider === 'anthropic' || provider === 'openai')
  const custom = !direct.some(provider => provider === value.provider)
  const modelRequired = custom || cli === 'opencode'
  const select = (provider: AccountApiProfile['provider']) => {
    const next = defaultAccountApiProfile(cli, provider)
    if (next) onChange(next)
  }
  return <div className="agent-account-body account-manager-profile" data-api-provider={value.provider}>
    <label className="account-manager-field">API provider
      <select className="input" aria-label={`${label} provider`} value={custom ? 'custom' : value.provider} onChange={e => {
        const next = defaultAccountApiProfile(cli, e.target.value as AccountApiProfile['provider'])
        if (next) onChange(next)
      }}>
        {direct.map(provider => <option key={provider} value={provider}>{ACCOUNT_PROVIDER_LABELS[provider]}</option>)}
        <option value="custom">Custom API</option>
      </select>
    </label>
    {custom && <label className="account-manager-field">Custom service
      <select className="input" aria-label={`${label} custom service`} value={value.provider} onChange={e => select(e.target.value as AccountApiProfile['provider'])}>
        <option value="custom">Custom endpoint</option>
        {accountProvidersFor(cli).filter(provider => !direct.some(option => option === provider) && provider !== 'custom').map(provider => <option key={provider} value={provider}>{ACCOUNT_PROVIDER_LABELS[provider]}</option>)}
      </select>
    </label>}
    {value.provider === 'custom' ? <label className="account-manager-field">API base URL
      <input className="input mono" value={value.baseUrl} maxLength={2048} aria-label={`${label} API base URL`} spellCheck={false} onChange={e => onChange({ ...value, baseUrl: e.target.value })} />
    </label> : <span className="field-hint mono">{value.baseUrl}</span>}
    <label className="account-manager-field"><span>Model ID <span className="field-hint">· {modelRequired ? 'Required' : 'Optional'}</span></span>
      <input className="input mono" value={value.model} maxLength={200} placeholder={modelRequired ? 'Exact model ID from this provider' : 'Blank uses the agent’s selected model'} aria-label={`${label} model ID`} spellCheck={false} onChange={e => onChange({ ...value, model: e.target.value })} />
    </label>
    {custom && <span className="field-hint">{cli === 'claude' ? 'Choose a service that supports the Anthropic Messages API.' : cli === 'opencode' ? 'Choose a service that supports the OpenAI Chat Completions API.' : 'Choose a service that supports the OpenAI Responses API.'}</span>}
    {cli === 'claude' && value.provider === 'anthropic' && <details className="account-manager-advanced" data-setting="agent-accounts.anthropic">
      <summary>Claude Code key approval</summary>
      <span className="field-hint">Start a new session with this account selected and approve the key when Claude Code asks. If you previously declined it, open /config and enable “Use custom API key”.</span>
      <span className="field-hint">Use a Console API key with API billing enabled. Subscription sign-ins are added separately.</span>
    </details>}
    {problem && <span className="field-hint" data-tone="warning">{problem}</span>}
  </div>
}

/** Readable account summary; nickname, key and provider edits save together. */
function AccountRow({
  cli,
  account,
  identity,
  mcp,
  checked,
  onDefault,
  onPatch,
  onSignIn,
  removing,
  onRemove,
  onKeepIt
}: {
  cli: CodingCli
  account: AgentAccount
  identity: AccountIdentity | null
  /** A Claude login account: what it gets of Default's user-scope MCP servers. */
  mcp: AccountMcpSummary | null
  checked: boolean
  onDefault: () => void
  onPatch: (patch: { label?: string; apiKey?: string; apiProfile?: AccountApiProfile }) => void
  onSignIn: () => void
  removing: boolean
  onRemove: () => void
  onKeepIt: () => void
}): React.JSX.Element {
  const [label, setLabel] = useState(account.label)
  const [key, setKey] = useState(account.apiKey)
  const [profile, setProfile] = useState(account.apiProfile)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) {
      setLabel(account.label)
      setKey(account.apiKey)
      setProfile(account.apiProfile)
    }
  }, [editing, account.label, account.apiKey, account.apiProfile])
  const changed = label.trim() !== account.label || key.trim() !== account.apiKey || JSON.stringify(profile) !== JSON.stringify(account.apiProfile)
  const problem = profile ? accountApiProfileProblem(cli.id, profile) : null
  const save = (): void => {
    if (!label.trim() || !changed || problem) return
    const patch: { label?: string; apiKey?: string; apiProfile?: AccountApiProfile } = {}
    if (label.trim() !== account.label) patch.label = label.trim()
    if (account.kind === 'key' && key.trim() !== account.apiKey) patch.apiKey = key.trim()
    if (profile && JSON.stringify(profile) !== JSON.stringify(account.apiProfile)) patch.apiProfile = profile
    onPatch(patch)
    setEditing(false)
    onKeepIt()
  }
  return (
    <div className="agent-account-stored" data-account={account.id} data-editing={editing || undefined}>
      <div className="account-manager-summary">
        <input type="radio" name={`account-${cli.id}`} checked={checked} onChange={onDefault} aria-label={`Start new ${cli.label} sessions on ${account.label}`} />
        <span className="agent-tab-dot" {...agentMark(account.id)} aria-hidden="true" />
        <div className="agent-account-body">
          <strong className="agent-account-name">{account.label}</strong>
          <span className="field-hint" title={identity?.detail}>{account.kind === 'login' ? accountIdentityText(identity) : account.apiProfile ? `${ACCOUNT_PROVIDER_LABELS[account.apiProfile.provider]} · ${account.apiProfile.model || 'Selected model'}` : 'API key account'}</span>
        </div>
        {checked && <span className="account-manager-selected">Active</span>}
        <div className="btn-row">
          {account.kind === 'login' && <button className="btn" onClick={onSignIn}>{identity?.state === 'ready' ? 'Reconnect' : 'Sign in'}</button>}
          <button className="btn" data-variant="ghost" aria-expanded={editing} onClick={() => { onKeepIt(); setEditing(v => !v) }}>{editing ? 'Cancel edit' : 'Edit'}</button>
        </div>
      </div>
      {editing && <form className="account-manager-form account-manager-edit" onSubmit={e => { e.preventDefault(); save() }}>
        <label className="account-manager-field">Account nickname
          <input className="input" value={label} maxLength={ACCOUNT_LABEL_MAX} spellCheck={false} aria-label={`${account.label} name`} onChange={e => setLabel(e.target.value)} />
        </label>
        {account.kind === 'key' && <label className="account-manager-field">API key
          <input
            className="input mono"
            type="password"
            value={key}
            placeholder={account.apiProfile ? `${ACCOUNT_PROVIDER_LABELS[account.apiProfile.provider]} key or token` : ACCOUNT_KEY_ENV[cli.id]?.key ?? 'API key'}
            aria-label={`${account.label} API key`}
            spellCheck={false}
            autoComplete="off"
            onChange={e => setKey(e.target.value)}
          />
        </label>}
        {profile && <AccountProfileFields cli={cli.id} label={account.label} value={profile} onChange={setProfile} />}
        <span className="field-hint">Changes apply to new or restarted sessions.</span>
        <div className="btn-row">
          <button type="submit" className="btn" disabled={!label.trim() || !changed || !!problem}>Save changes</button>
          <button type="button" className="btn" data-variant="ghost" onClick={() => { setEditing(false); onKeepIt() }}>Cancel</button>
        </div>
        {account.kind === 'login' && <details className="account-manager-advanced">
          <summary>Advanced details</summary>
          <span className="field-hint mono account-manager-path">{account.home}</span>
          {mcp && accountMcpLines(mcp).map(line => <span key={line} className="field-hint" data-testid="account-mcp" data-tone={mcp.error || line.startsWith('Not passed') ? 'warning' : undefined}>{line}</span>)}
        </details>}
        <div className="account-manager-remove">
          {removing && <span className="field-hint">Remove this account from Stoke? {account.kind === 'login' ? 'Its sign-in files stay on this computer.' : 'This removes its saved key and settings.'}</span>}
          <div className="btn-row">
            {removing ? (
              <>
                <button type="button" className="btn" data-variant="danger" onClick={onRemove}>
                  Remove account
                </button>
                <button type="button" className="btn" data-variant="ghost" onClick={onKeepIt}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn" data-variant="ghost" onClick={onRemove}>
                Remove account…
              </button>
            )}
          </div>
        </div>
      </form>}
    </div>
  )
}

