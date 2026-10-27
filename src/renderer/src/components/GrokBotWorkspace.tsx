import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GrokBotOperation, GrokBotResult, GrokBotTabBinding, GrokBotView } from '@shared/grokBot'
import { grokBotMessages, grokBotSwitch, grokBotThreads, type GrokBotMessage, type GrokBotThread } from '@shared/grokBotConversation'
import { ipcErrorMessage } from '../lib/format'
import { refuseOverlongPaste } from '../lib/pasteLimit'
import { GrokBotMessages } from './GrokBotMessages'
import { GrokBotTools, type GrokBotTool } from './GrokBotTools'
import '../styles/grokBot.css'

export function GrokBotWorkspace({ binding, onChange, onManage, onNewChat, onOpenUrl }: {
  binding: GrokBotTabBinding; onChange: (patch: Partial<GrokBotTabBinding>) => void
  onManage: () => void; onNewChat: () => void; onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const [view, setView] = useState<GrokBotView | null>(null)
  const [roster, setRoster] = useState<{ accountId: string; rows: GrokBotThread[] } | null>(null)
  const [messages, setMessages] = useState<GrokBotMessage[]>([])
  const [reading, setReading] = useState(false), [error, setError] = useState('')
  const [rosterProblem, setRosterProblem] = useState(''), [rosterPending, setRosterPending] = useState(false)
  const [search, setSearch] = useState(''), [showHidden, setShowHidden] = useState(false)
  const [liveUpdates, setLiveUpdates] = useState(true), [limit, setLimit] = useState(40)
  const [tool, setTool] = useState<GrokBotTool | null>(null), [railOpen, setRailOpen] = useState(true)
  const accountId = binding.accountId || view?.defaultAccount || ''
  const account = view?.accounts.find(item => item.id === accountId)
  const threads = roster?.accountId === accountId ? roster.rows : []
  const selected = threads.find(thread => thread.id === binding.targetId)
  const target = selected || (binding.targetId ? { id: binding.targetId, name: binding.targetLabel, kind: 'Bot' as const } : undefined)
  const key = `${accountId}:${binding.targetId}`
  const owner = useRef(key), ownerAccount = useRef(accountId), live = useRef(true), claim = useRef<object | null>(null)
  const history = useRef<HTMLDivElement>(null), follow = useRef(true)
  const rosterRetry = useRef(false), rosterWaiting = useRef(false)
  owner.current = key
  ownerAccount.current = accountId
  useEffect(() => {
    live.current = true
    const accept = (next: GrokBotView) => { if (live.current) setView(old => !old || next.revision >= old.revision ? next : old) }
    const off = window.stoke.grokBot.onChange(accept)
    window.stoke.grokBot.read().then(accept).catch(error => { if (live.current) setError(ipcErrorMessage(error)) })
    return () => { live.current = false; off() }
  }, [])
  const operate = async (operation: Omit<GrokBotOperation, 'accountId'>): Promise<GrokBotResult | null> => {
    const mutation = !['list', 'thread', 'get', 'skills', 'approvals', 'desktop'].includes(operation.kind)
    if (claim.current || (mutation && binding.sending) || !account || (operation.kind !== 'desktop' && !view?.cli.installed)) return null
    const mine = {}, current = key
    claim.current = mine; setReading(true); setError('')
    if (mutation) onChange({ sending: true })
    try {
      const result = await window.stoke.grokBot.operate({ ...operation, accountId })
      if (!live.current || (operation.kind === 'list' ? ownerAccount.current !== accountId : owner.current !== current)) return null
      if (!result.ok && operation.kind !== 'list') setError(result.message || 'Grok Bot could not complete this action.')
      return result
    } catch (error) {
      if (live.current && owner.current === current) setError(ipcErrorMessage(error))
      return null
    } finally {
      if (claim.current === mine) claim.current = null
      if (live.current) setReading(false)
      if (mutation) onChange({ sending: false })
    }
  }
  const read = async (kind: 'list' | 'thread'): Promise<boolean> => {
    if (kind === 'list') { setRosterProblem(''); rosterRetry.current = false }
    const result = await operate({ kind, ...(kind === 'thread' ? { target: binding.targetId, limit } : {}) })
    if (!result?.ok) {
      if (kind === 'list' && result) { rosterRetry.current = result.code === 'busy'; setRosterProblem(result.message || 'The bot list could not be read.') }
      return false
    }
    if (kind === 'list') {
      const rows = grokBotThreads(result.data)
      setRoster({ accountId, rows })
      const next = rows.find(row => row.id === binding.targetId)
      if (owner.current === key && next && next.name !== binding.targetLabel) onChange({ targetLabel: next.name, accountLabel: account!.label })
    } else setMessages(grokBotMessages(result.data))
    return true
  }
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    if (!account || !view?.cli.installed) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0
    rosterWaiting.current = true; setRosterPending(true)
    const tick = async () => {
      if (stopped) return
      // A tab switch can arrive while the previous account's read still owns
      // the claim. Read this account once that job releases it.
      if (claim.current) { timer = setTimeout(tick, 500); return }
      const ok = await readRef.current('list')
      if (stopped) return
      if (!ok && rosterRetry.current && ++attempts < 8) { timer = setTimeout(tick, 500); return }
      rosterWaiting.current = false; setRosterPending(false)
    }
    tick()
    return () => { stopped = true; rosterWaiting.current = false; clearTimeout(timer); if (live.current) setRosterPending(false) }
  }, [account?.id, view?.cli.installed])
  useEffect(() => { setMessages([]); setError(''); follow.current = true }, [key])
  useEffect(() => {
    if (!binding.targetId || !account || !view?.cli.installed || tool) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (stopped) return
      const skip = document.visibilityState === 'hidden' || binding.sending || claim.current || rosterWaiting.current
      const ok = skip ? true : await readRef.current('thread')
      if (!stopped && !ok) { setLiveUpdates(false); return }
      if (!stopped && (liveUpdates || skip)) timer = setTimeout(tick, skip && document.visibilityState !== 'hidden' ? 500 : 6000)
    }
    void tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [key, account?.id, view?.cli.installed, liveUpdates, binding.sending, tool, limit])
  useLayoutEffect(() => { if (follow.current && history.current) history.current.scrollTop = history.current.scrollHeight }, [messages])
  const choose = (thread?: GrokBotThread, nextAccount = account) => {
    if (!nextAccount || claim.current || binding.sending) return
    setTool(null); setError(''); setSearch('')
    onChange(grokBotSwitch(binding, nextAccount, thread))
  }
  const send = async () => {
    if (claim.current || binding.sending || !account || !binding.targetId || !binding.draft.trim()) return
    const mine = {}, current = key, draft = binding.draft
    claim.current = mine; onChange({ sending: true, delivery: undefined, sendError: '' }); setError('')
    let accepted = false
    try {
      const result = await window.stoke.grokBot.operate({ kind: 'send', accountId, target: binding.targetId, message: draft })
      accepted = result.ok && result.delivery === 'accepted'
      onChange(accepted ? { draft: '', delivery: 'accepted', sendError: '' } : { delivery: result.delivery || 'unknown', sendError: result.message || 'Delivery is unconfirmed. Check the thread before resending.' })
    } catch (error) { onChange({ delivery: 'unknown', sendError: `${ipcErrorMessage(error)} Check the thread before resending.` }) }
    finally { if (claim.current === mine) claim.current = null; onChange({ sending: false }) }
    if (accepted && live.current && owner.current === current) { follow.current = true; await readRef.current('thread') }
  }
  const busy = reading || binding.sending || rosterPending
  const visible = threads.filter(thread => (showHidden || !thread.hidden || thread.id === binding.targetId) && thread.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  return <section className="grok-workspace" aria-label="Grok Bot conversation" data-rail={railOpen}>
    {railOpen && <aside className="grok-rail" aria-label="Grok Bot list">
      <div className="grok-rail-title"><strong>Grok Bot</strong><button className="btn" data-variant="ghost" aria-label="Hide bot list" onClick={() => setRailOpen(false)}>←</button></div>
      <label className="grok-account">Account<select value={accountId} disabled={busy || !view?.accounts.length} onChange={event => choose(undefined, view?.accounts.find(item => item.id === event.target.value))}><option value="">Choose an account</option>{view?.accounts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <input className="grok-search" type="search" aria-label="Search bots and groups" placeholder="Search bots…" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="grok-rail-actions"><button className="btn" disabled={busy || !account || !view?.cli.installed} onClick={() => void read('list')}>{reading ? 'Reading…' : 'Refresh bots'}</button><button className="btn" disabled={busy || !account || !view?.cli.installed} onClick={() => setTool('create')}>+ New</button></div>
      <nav className="grok-bot-list" aria-label="Bots and groups">
        {(['Bot', 'Group'] as const).map(kind => <div key={kind}><h3>{kind === 'Bot' ? 'Bots' : 'Groups'} <span>{visible.filter(thread => thread.kind === kind).length}</span></h3>{visible.filter(thread => thread.kind === kind).map(thread => <button key={thread.id} className="grok-bot-row" aria-current={thread.id === binding.targetId ? 'page' : undefined} disabled={busy} onClick={() => choose(thread)}><span className="grok-bot-avatar" aria-hidden="true">{kind === 'Group' ? '◈' : thread.name.slice(0, 1).toLocaleUpperCase()}</span><span>{thread.name}{thread.hidden && <small>Hidden</small>}</span>{binding.drafts?.[`${accountId}:${thread.id}`] && <small>Draft</small>}</button>)}</div>)}
        {rosterProblem && !rosterPending && <p className="plugin-error" role="alert">{rosterProblem}</p>}
        {!visible.length && !rosterProblem && <p className="plugin-muted">{busy ? 'Reading bots…' : search ? 'No matching bots.' : 'No bots found. Refresh or create one.'}</p>}
      </nav>
      <label className="grok-check"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />Show hidden bots</label>
      <button className="btn" data-variant="ghost" onClick={onManage}>Manage accounts</button>
      <small className="grok-cli-version">CLI {view?.cli.version || '…'}</small>
    </aside>}
    <div className="grok-chat">
      <header className="grok-header"><div className="grok-heading">{!railOpen && <button className="btn" aria-label="Show bot list" onClick={() => setRailOpen(true)}>Bots →</button>}<div><h2>{binding.targetLabel || 'Your bots'}</h2><p>Grok Bot · {account?.label || binding.accountLabel || 'Choose an account'}</p></div></div><button className="btn" data-variant="ghost" onClick={onNewChat}>New bot conversation</button></header>
      {error && <p className="grok-notice plugin-error" role="alert">{error}</p>}
      {!account && view && <div className="grok-chooser"><h3>{view.accounts.length ? 'Choose an account' : 'Connect Grok Bot'}</h3><p>Import each Cursor or Grok desktop login as a separate saved account.</p><button className="btn" onClick={onManage}>Manage Grok Bot accounts</button></div>}
      {account && !view?.cli.installed && <div className="grok-chooser"><h3>Set up the bot CLI</h3><p>Install Stoke’s reviewed Grok Bot CLI to connect this account.</p><button className="btn" disabled={busy} onClick={() => {
        if (claim.current) return
        const mine = {}; claim.current = mine; setReading(true); setError('')
        window.stoke.grokBot.install().then(next => { if (live.current) setView(next) }).catch(error => { if (live.current) setError(ipcErrorMessage(error)) }).finally(() => { if (claim.current === mine) claim.current = null; if (live.current) setReading(false) })
      }}>Install reviewed CLI</button></div>}
      {account && view?.cli.installed && <>
        <div className="grok-toolbar" aria-label="Conversation tools"><button className="btn" data-variant={tool === null ? 'primary' : 'ghost'} disabled={!target || busy} onClick={() => setTool(null)}>Chat</button>{(['profile', 'skills', 'approvals', 'computer'] as const).map(item => <button key={item} className="btn" data-variant={tool === item ? 'primary' : 'ghost'} disabled={busy || (!target && ['profile', 'approvals'].includes(item))} onClick={() => setTool(item)}>{item === 'profile' ? 'Bot settings' : item === 'skills' ? 'Skills' : item === 'approvals' ? 'Approvals' : 'Computer'}</button>)}</div>
        {tool ? <GrokBotTools key={`${key}:${tool}`} tool={tool} target={target} accountLabel={account.label} threads={threads} busy={!!busy} onOperate={operate} onRefresh={() => readRef.current('list')} onClose={() => setTool(null)} /> : binding.targetId ? <>
          <div className="grok-chat-controls"><label><input type="checkbox" checked={liveUpdates} onChange={event => setLiveUpdates(event.target.checked)} />Live updates</label><label>Recent entries <select aria-label="Recent message limit" value={limit} disabled={busy} onChange={event => setLimit(Number(event.target.value))}>{[40, 100, 200].map(count => <option key={count} value={count}>{count}</option>)}</select></label><button className="btn" disabled={busy} onClick={() => void read('thread')}>Refresh chat</button></div>
          <div className="grok-history" ref={history} onScroll={() => { const el = history.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
            {messages.length ? <GrokBotMessages messages={messages} name={binding.targetLabel} onOpenUrl={onOpenUrl} /> : <div className="grok-empty"><h3>{reading ? 'Reading the conversation…' : 'Ready when you are'}</h3><p>{reading ? 'Fetching recent messages from this account.' : `Send ${binding.targetLabel} a task or refresh the recent conversation.`}</p></div>}
          </div>
          <form className="grok-composer" onSubmit={event => { event.preventDefault(); void send() }}><label>Message as {account.label}<textarea value={binding.draft} maxLength={32 * 1024} disabled={binding.sending} onPaste={event => { const note = refuseOverlongPaste(event); if (note) onChange({ sendError: note }) }} onChange={event => onChange({ draft: event.target.value, delivery: undefined, sendError: '' })} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send() } }} placeholder={`Message ${binding.targetLabel}…`} /></label>
            {binding.sendError && <p role="alert" className="plugin-error">{binding.sendError}</p>}{binding.delivery === 'accepted' && <p role="status">Message sent.</p>}
            <div className="btn-row"><small>Enter for a new line · {window.stoke.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter to send</small><button className="btn" data-variant="primary" disabled={busy || !binding.draft.trim()}>{binding.sending ? 'Sending…' : 'Send message'}</button></div>
          </form>
        </> : <div className="grok-chooser"><h3>Choose a bot from the left</h3><p>Your selected account is <strong>{account.label}</strong>. Open a bot or group to see its conversation, or create one for a new task.</p><button className="btn" disabled={busy} onClick={() => setTool('create')}>Create a bot or group</button></div>}
      </>}
    </div>
  </section>
}
