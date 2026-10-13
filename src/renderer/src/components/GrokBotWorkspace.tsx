import { useEffect, useRef, useState } from 'react'
import type { GrokBotTabBinding, GrokBotView } from '@shared/grokBot'
import { grokBotMessages, grokBotThreads, type GrokBotMessage, type GrokBotThread } from '@shared/grokBotConversation'
import { ipcErrorMessage } from '../lib/format'
import { GrokBotMessages } from './GrokBotMessages'
import '../styles/grokBot.css'

export function GrokBotWorkspace({ binding, onChange, onManage, onNewChat, onOpenUrl }: {
  binding: GrokBotTabBinding
  onChange: (patch: Partial<GrokBotTabBinding>) => void
  onManage: () => void
  onNewChat: () => void
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const [view, setView] = useState<GrokBotView | null>(null)
  const [threads, setThreads] = useState<GrokBotThread[]>([])
  const [choice, setChoice] = useState('')
  const [messages, setMessages] = useState<GrokBotMessage[]>([])
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [liveUpdates, setLiveUpdates] = useState(true)
  const accountId = binding.accountId || view?.defaultAccount || ''
  const account = view?.accounts.find(item => item.id === accountId)
  const key = `${accountId}:${binding.targetId}`
  const owner = useRef(key), live = useRef(true), claim = useRef<object | null>(null)
  owner.current = key
  useEffect(() => {
    live.current = true
    const accept = (next: GrokBotView) => {
      if (live.current) setView(old => !old || next.revision >= old.revision ? next : old)
    }
    const off = window.stoke.grokBot.onChange(accept)
    window.stoke.grokBot.read().then(accept).catch(error => { if (live.current) setError(ipcErrorMessage(error)) })
    return () => { live.current = false; off() }
  }, [])

  const read = async (kind: 'list' | 'thread'): Promise<boolean> => {
    if (claim.current || binding.sending || !account || !view?.cli.installed) return false
    const mine = {}, current = key
    claim.current = mine
    setReading(true)
    setError('')
    try {
      const result = await window.stoke.grokBot.operate({ kind, accountId, ...(kind === 'thread' ? { target: binding.targetId } : {}) })
      if (!live.current || owner.current !== current) return false
      if (!result.ok) { setError(result.message || 'The conversation could not be read.'); return false }
      if (kind === 'list') {
        const rows = grokBotThreads(result.data)
        setThreads(rows); setChoice(rows[0]?.id || '')
      } else setMessages(grokBotMessages(result.data))
      return true
    } catch (error) {
      if (live.current && owner.current === current) setError(ipcErrorMessage(error))
      return false
    } finally {
      if (claim.current === mine) claim.current = null
      if (live.current) setReading(false)
    }
  }
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    if (!binding.targetId || !account || !view?.cli.installed) return
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (stopped) return
      // Hidden/background tabs neither poll nor submit messages.
      const ok = document.visibilityState === 'hidden' || binding.sending || claim.current ? true : await readRef.current('thread')
      if (!stopped && liveUpdates && ok) timer = setTimeout(tick, 6000)
      else if (!stopped && liveUpdates && !ok) setLiveUpdates(false)
    }
    void tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [key, account?.id, view?.cli.installed, liveUpdates, binding.sending])

  const send = async () => {
    if (claim.current || binding.sending || !account || !binding.targetId || !binding.draft.trim()) return
    const mine = {}, current = key, draft = binding.draft
    claim.current = mine
    onChange({ sending: true, delivery: undefined, sendError: '' })
    setError('')
    let accepted = false
    try {
      const result = await window.stoke.grokBot.operate({ kind: 'send', accountId, target: binding.targetId, message: draft })
      accepted = result.ok && result.delivery === 'accepted'
      // The receipt and draft belong to this tab even if it is now behind another tab.
      onChange(accepted ? { draft: '', delivery: 'accepted', sendError: '' } : { delivery: result.delivery || 'unknown', sendError: result.message || 'Delivery is unconfirmed. Check the thread before resending.' })
    } catch (error) {
      onChange({ delivery: 'unknown', sendError: `${ipcErrorMessage(error)} Check the thread before resending.` })
    } finally {
      if (claim.current === mine) claim.current = null
      onChange({ sending: false })
    }
    if (accepted && live.current && owner.current === current) await readRef.current('thread')
  }
  const busy = reading || binding.sending
  const sendError = binding.sendError
  return <section className="grok-workspace" aria-label="Grok Bot conversation">
    {binding.targetId ? <>
      <header className="grok-header">
        <div><h2>{binding.targetLabel || 'Grok Bot'}</h2><p>Grok Bot · {account?.label || binding.accountLabel}</p></div>
        <div className="btn-row">
          <label><input type="checkbox" checked={liveUpdates} onChange={event => setLiveUpdates(event.target.checked)} /> Live updates</label>
          <button className="btn" disabled={busy || !account} onClick={() => void read('thread')}>Refresh</button>
          <button className="btn" onClick={onNewChat}>New bot conversation</button>
        </div>
      </header>
      {error && <p className="grok-notice plugin-error" role="alert">{error}</p>}
      {!account && view && <p className="grok-notice" role="alert">This saved account is unavailable. <button className="btn" onClick={onManage}>Manage Grok Bot accounts</button></p>}
      <div className="grok-history">
        {messages.length ? <GrokBotMessages messages={messages} name={binding.targetLabel} onOpenUrl={onOpenUrl} /> : <p className="plugin-muted">{reading ? 'Reading recent messages…' : 'No readable messages in the recent conversation.'}</p>}
      </div>
      <form className="grok-composer" onSubmit={event => { event.preventDefault(); void send() }}>
        <label>Message as {account?.label || binding.accountLabel}
          <textarea value={binding.draft} maxLength={32 * 1024} disabled={binding.sending || !account} onChange={event => onChange({ draft: event.target.value, delivery: undefined, sendError: '' })} onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send() }
          }} placeholder="Write a message…" />
        </label>
        {sendError && <p role="alert" className="plugin-error">{sendError}{binding.delivery === 'unknown' && !sendError.includes('resending') ? ' Check the thread before resending.' : ''}</p>}
        {binding.delivery === 'accepted' && <p role="status">Message sent.</p>}
        <div className="btn-row"><small>Enter for a new line · {window.stoke.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter to send</small><button className="btn" data-variant="primary" disabled={busy || !account || !binding.draft.trim()}>{binding.sending ? 'Sending…' : 'Send message'}</button></div>
      </form>
    </> : <div className="grok-chooser">
      <h2>Grok Bot</h2><p>Choose the account and bot for this conversation.</p>
      {error && <p role="alert" className="plugin-error">{error}</p>}
      <label>Account<select value={accountId} disabled={busy || !view?.accounts.length} onChange={event => {
        const next = view?.accounts.find(item => item.id === event.target.value)
        if (!next) return
        setThreads([]); setChoice(''); setMessages([]); setError('')
        onChange({ accountId: next.id, accountLabel: next.label })
      }}><option value="">Choose an account</option>{view?.accounts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {view?.cli.installed ? <button className="btn" disabled={busy || !account} onClick={() => {
        if (account) onChange({ accountId, accountLabel: account.label })
        void read('list')
      }}>{reading ? 'Reading bots…' : 'List bots and groups'}</button> : <button className="btn" disabled={!view || busy} onClick={() => {
        setReading(true); setError('')
        window.stoke.grokBot.install().then(next => { if (live.current) setView(next) }).catch(error => { if (live.current) setError(ipcErrorMessage(error)) }).finally(() => { if (live.current) setReading(false) })
      }}>Install reviewed CLI</button>}
      {threads.length > 0 && <><label>Bot or group<select value={choice} disabled={busy} onChange={event => setChoice(event.target.value)}>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.kind}: {thread.name}</option>)}</select></label>
        <button className="btn" data-variant="primary" disabled={busy || !choice || !account} onClick={() => {
          const thread = threads.find(item => item.id === choice)
          if (thread && account) onChange({ accountId, accountLabel: account.label, targetId: thread.id, targetLabel: thread.name })
        }}>Open conversation</button></>}
      {view?.accounts.length === 0 && <p>No saved accounts yet. Import a desktop login in the account manager.</p>}
      <button className="btn" data-variant="ghost" onClick={onManage}>Manage Grok Bot accounts</button>
    </div>}
  </section>
}
