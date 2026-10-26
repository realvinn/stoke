import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { DraftJournal, mountDraftCache, type RecoveryDraft } from '../../../remote/draftCache'
import { remoteTypeVerdict, type RemoteTabView } from '@shared/hub/remote'

/** Offline text is a local draft, never a replay of terminal control keys. */
export function RemoteDraft({ scope, view, receive }: {
  scope: string
  view: RemoteTabView | undefined
  receive: MutableRefObject<((text: string) => void) | null>
}): React.JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null)
  const generation = useRef(0)
  const cache = useRef<ReturnType<typeof mountDraftCache> | null>(null)
  const [hasText, setHasText] = useState(false)
  const [note, setNote] = useState('')
  const [versions, setVersions] = useState<RecoveryDraft[]>([])
  const [sending, setSending] = useState(false)
  const offline = view?.state !== 'open'
  useEffect(() => {
    generation.current++
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
      if (field.disabled) return
      // Only literal text. Escape sequences, Enter and control keys are never queued.
      if (text === '\r' || text === '\n') { field.focus(); return }
      const printable = text.replace(/\x1b\[20[01]~/g, '').replace(/\r\n?/g, '\n')
      if (!printable || /[\x00-\x08\x0b-\x1f\x7f]/.test(printable)) return
      field.value += printable
      field.dispatchEvent(new Event('input', { bubbles: true }))
      setHasText(true)
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    }
    return () => { generation.current++; abort.abort(); cache.current = null; receive.current = null }
  }, [scope, receive])
  const insert = async (): Promise<void> => {
    const field = input.current!
    const identity = generation.current
    const text = field.value
    const reason = remoteTypeVerdict(view, text)
    if (reason) { setNote(reason); return }
    if (!text || sending) return
    cache.current?.flush()
    setSending(true)
    try {
      const answer = await window.stoke.hub.remote.type(view!.id, text)
      if (identity !== generation.current) return
      if (answer.ok) { cache.current?.clear(); setHasText(false); setNote('Inserted. Review the agent’s input, then press Enter there.') }
      else setNote(answer.message)
    } catch { if (identity === generation.current) setNote('The link dropped. Your draft is still here.') }
    finally { if (identity === generation.current) setSending(false) }
  }
  return (
    <div className="remote-draft" hidden={!offline && !hasText && !versions.length}>
      <label htmlFor={`remote-draft-${view?.id ?? scope}`}>{offline ? (view?.state === 'connecting' || view?.state === 'asking' ? 'Waiting for connection — draft here' : 'Connection interrupted — keep writing here') : 'Your local draft'}</label>
      <textarea id={`remote-draft-${view?.id ?? scope}`} ref={input} rows={3} disabled={sending} maxLength={100000} placeholder="Your text stays here until you insert it." onInput={() => setHasText(!!input.current?.value)} />
      <div className="remote-draft-actions">
        <span role="status">{note}</span>
        {versions.length > 0 && <select aria-label="Recover another saved draft" value="" onChange={e => {
          const entry = versions.find(v => v.key === e.target.value)
          if (entry && cache.current?.restore(entry)) setHasText(true)
        }}><option value="">Recover draft…</option>{versions.map(v => <option key={v.key} value={v.key}>{new Date(v.at).toLocaleString()} · {v.text.slice(0, 70)}</option>)}</select>}
        <button className="btn" disabled={offline || !hasText || sending || !!remoteTypeVerdict(view)} onClick={() => void insert()}>{sending ? 'Inserting…' : 'Insert into agent'}</button>
      </div>
    </div>
  )
}
