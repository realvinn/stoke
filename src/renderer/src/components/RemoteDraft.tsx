import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { DRAFT_MAX, DraftJournal, mountDraftCache, type RecoveryDraft } from '../../../remote/draftCache'
import { remoteTypeVerdict, type RemoteTabView } from '@shared/hub/remote'

/** Compose the whole prompt locally; reconnect never replays terminal control keys. */
export function RemoteDraft({ scope, view, receive }: {
  scope: string
  view: RemoteTabView | undefined
  receive: MutableRefObject<((text: string) => boolean) | null>
}): React.JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null)
  const generation = useRef(0)
  const cache = useRef<ReturnType<typeof mountDraftCache> | null>(null)
  const [hasText, setHasText] = useState(false)
  const [note, setNote] = useState('')
  const [versions, setVersions] = useState<RecoveryDraft[]>([])
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [direct, setDirect] = useState(false)
  const offline = view?.state !== 'open'
  const preferences = useRef({ direct, offline, waiting: view?.session?.activity === 'waiting' || view?.session?.activity === 'shell' })
  preferences.current = { direct, offline, waiting: view?.session?.activity === 'waiting' || view?.session?.activity === 'shell' }
  useEffect(() => {
    generation.current++
    sendingRef.current = false
    setSending(false)
    const field = input.current!
    const abort = new AbortController()
    let journal: DraftJournal | null = null
    try { journal = new DraftJournal(localStorage, scope, Date.now, undefined, 'Remote terminal') } catch { /* editing still works */ }
    const mounted = mountDraftCache(field, journal, {
      signal: abort.signal,
      notify: (state, records) => {
        setHasText(!!field.value)
        setVersions(records)
        setNote(state === 'error' ? 'Local saving unavailable. Keep a copy before closing.' : state === 'editing' ? 'Saving draft…' : 'Draft saved on this computer')
      }
    })
    cache.current = mounted
    receive.current = (text) => {
      if (field.disabled || (!preferences.current.offline && (preferences.current.direct || preferences.current.waiting))) return false
      // Only literal text. Escape sequences, Enter and control keys are never queued.
      if (text === '\r' || text === '\n') return false
      const printable = text.replace(/\x1b\[20[01]~/g, '').replace(/\r\n?/g, '\n')
      if (!printable || /[\x00-\x08\x0b-\x1f\x7f]/.test(printable)) return false
      if (field.value.length - (field.selectionEnd - field.selectionStart) + printable.length > DRAFT_MAX) { setNote('This prompt is too large to save locally. Split it into smaller messages.'); return true }
      field.setRangeText(printable, field.selectionStart, field.selectionEnd, 'end')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      setHasText(true)
      field.focus()
      return true
    }
    return () => { generation.current++; abort.abort(); cache.current = null; receive.current = null }
  }, [scope, receive])
  const insert = async (enter = false): Promise<void> => {
    const field = input.current!
    const identity = generation.current
    const text = field.value
    const reason = remoteTypeVerdict(view, text)
    if (reason) { setNote(reason); return }
    if (!text.trim() || sendingRef.current) return
    cache.current?.flush()
    if (!cache.current?.queued(text)) { setNote('Keep a copy before sending: local recovery storage is unavailable.'); return }
    sendingRef.current = true
    setSending(true)
    try {
      const answer = await window.stoke.hub.remote.type(view!.id, text, enter)
      if (identity !== generation.current) return
      if (answer.ok) {
        // Keep a recoverable copy: dispatch success cannot prove the agent
        // accepted the prompt if the connection drops before its reply.
        cache.current?.clear(); setHasText(false)
        setNote(enter ? 'Sent. A recovery copy is kept locally.' : 'Inserted. Review the agent’s input, then press Enter there.')
      }
      else setNote(answer.message)
    } catch { if (identity === generation.current) setNote('The link dropped. Your draft is still here.') }
    finally { if (identity === generation.current) { sendingRef.current = false; setSending(false) } }
  }
  return (
    <div className="remote-draft">
      <label htmlFor={`remote-draft-${view?.id ?? scope}`}>{offline ? 'Connection interrupted — keep writing here' : direct ? 'Direct terminal input is not saved as a draft' : 'Prompt · saved on this computer'}</label>
      <textarea id={`remote-draft-${view?.id ?? scope}`} ref={input} hidden={direct && !offline && !hasText} rows={3} disabled={sending} maxLength={DRAFT_MAX} placeholder="Write here — your full prompt stays through reconnects. Shift+Enter for a new line." onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !offline) { e.preventDefault(); void insert(!e.ctrlKey && !e.metaKey) }
      }} onInput={() => setHasText(!!input.current?.value)} />
      <div className="remote-draft-actions">
        <span role="status">{note}</span>
        {versions.length > 0 && <select aria-label="Recover another saved draft" value="" onChange={e => {
          const entry = versions.find(v => v.key === e.target.value)
          if (entry && cache.current?.restore(entry)) setHasText(true)
        }}><option value="">Recover draft…</option>{versions.map(v => <option key={v.key} value={v.key}>{new Date(v.at).toLocaleString()} · {v.text.slice(0, 70)}</option>)}</select>}
        <label><input type="checkbox" checked={direct} onChange={e => setDirect(e.target.checked)} /> Type directly in terminal</label>
        <button className="btn" disabled={offline || !hasText || sending || !!remoteTypeVerdict(view)} onClick={() => void insert(false)}>Insert only</button>
        <button className="btn" data-variant="primary" disabled={offline || !hasText || sending || !!remoteTypeVerdict(view)} onClick={() => void insert(true)}>{sending ? 'Sending…' : 'Send prompt'}</button>
      </div>
    </div>
  )
}
