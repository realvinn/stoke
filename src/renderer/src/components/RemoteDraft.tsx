import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { DRAFT_MAX, DraftJournal, mountDraftCache, type RecoveryDraft } from '../../../remote/draftCache'
import { remoteTypeVerdict, type RemoteTabView } from '@shared/hub/remote'
import { refuseOverlongPaste } from '../lib/pasteLimit'

/** Compose the whole prompt locally; reconnect never replays terminal control keys. */
export function RemoteDraft({ scope, view, receive, onHide, label = 'Remote terminal' }: {
  scope: string
  label?: string
  view: RemoteTabView | undefined
  receive: MutableRefObject<((text: string) => boolean) | null>
  onHide?: () => void
}): React.JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null)
  const generation = useRef(0)
  const cache = useRef<ReturnType<typeof mountDraftCache> | null>(null)
  const [hasText, setHasText] = useState(false)
  const [note, setNote] = useState('')
  // A refused paste's note, kept apart from `note`: the draft cache rewrites that
  // on every save, blur and storage event, and this must last until the next edit.
  const [pasteNote, setPasteNote] = useState('')
  const [versions, setVersions] = useState<RecoveryDraft[]>([])
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [direct, setDirect] = useState(true)
  const [visible, setVisible] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const offline = view?.state !== 'open'
  const preferences = useRef({ direct, offline, waiting: view?.session?.activity === 'waiting' || view?.session?.activity === 'shell' })
  preferences.current = { direct, offline, waiting: view?.session?.activity === 'waiting' || view?.session?.activity === 'shell' }
  useEffect(() => {
    generation.current++
    sendingRef.current = false
    setSending(false)
    const field = input.current!
    // A resumed host may have a new PTY: flush the old scope in cleanup,
    // then let only this scope's journal initialise the editor.
    field.value = ''
    setHasText(false)
    setPasteNote('')
    setExpanded(false)
    const abort = new AbortController()
    let journal: DraftJournal | null = null
    try { journal = new DraftJournal(localStorage, scope, Date.now, undefined, label) } catch { /* editing still works */ }
    const mounted = mountDraftCache(field, journal, {
      signal: abort.signal,
      notify: (state, records) => {
        setHasText(!!field.value)
        if (state === 'restored' && field.value) setVisible(true)
        setVersions(records)
        setNote(state === 'error' ? 'Saving unavailable — keep a copy before closing' : state === 'editing' ? 'Saving…' : state === 'restored' ? 'Draft restored' : 'Saved locally')
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
      setVisible(true)
      requestAnimationFrame(() => field.focus())
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
  const fieldId = `remote-draft-${view?.id ?? scope}`
  const focusInput = (): void => input.current?.focus({ preventScroll: true })
  return (
    <div className="remote-draft" data-collapsed={!visible || undefined} data-expanded={visible && expanded || undefined} data-offline={offline || undefined} onKeyDown={e => e.stopPropagation()}>
      <button type="button" className="remote-draft-toggle btn" hidden={visible} aria-expanded={visible} title="Open the locally saved prompt editor. Direct terminal input is not saved here." onClick={() => { setVisible(true); requestAnimationFrame(focusInput) }}>
        {hasText ? 'Saved prompt · draft' : versions.length ? `Saved prompt · ${versions.length} to recover` : 'Saved prompt'}
      </button>
      <label className="sr-only" htmlFor={fieldId}>Remote prompt, saved locally</label>
      <textarea id={fieldId} ref={input} rows={1} disabled={sending} maxLength={DRAFT_MAX}
        hidden={!visible}
        aria-describedby={`${fieldId}-hint`} placeholder="Message agent…"
        onPaste={e => { const refused = refuseOverlongPaste(e); if (refused) setPasteNote(refused) }}
        onKeyDown={e => {
          if (e.key === 'Escape' && expanded) { e.preventDefault(); setExpanded(false) }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !offline) { e.preventDefault(); void insert(!e.ctrlKey && !e.metaKey) }
        }} onInput={() => { setPasteNote(''); setHasText(!!input.current?.value) }} />
      <span className="sr-only" id={`${fieldId}-hint`}>Enter sends, Shift+Enter adds a line, Ctrl+Enter inserts without sending. Your draft stays here through connection loss.</span>
      <div className="remote-draft-actions" hidden={!visible}>
        <span role="status" title={pasteNote || note} data-alert={pasteNote ? '' : undefined}>{offline ? 'Offline · ' : ''}{pasteNote || note}</span>
        <button type="button" className="btn" onClick={() => { setVisible(false); onHide?.() }}>Hide prompt</button>
        <button type="button" className="btn" aria-expanded={expanded} aria-controls={fieldId}
          onMouseDown={e => e.preventDefault()} onClick={() => { setExpanded(v => !v); focusInput() }}>
          {expanded ? 'Collapse prompt' : 'Expand prompt'}
        </button>
        <details className="remote-draft-options">
          <summary>{versions.length ? `Recover · ${versions.length}` : direct ? 'Direct input' : 'Options'}</summary>
          <div className="remote-draft-menu">
            {versions.length > 0 && <label>Recover a saved prompt
              <select aria-label="Recover another saved draft" value="" onChange={e => {
                const entry = versions.find(v => v.key === e.target.value)
                if (entry && cache.current?.restore(entry)) { setHasText(true); focusInput() }
              }}><option value="">Choose a draft…</option>{versions.map(v => <option key={v.key} value={v.key}>{v.context || 'Saved remote prompt'} · {v.kind === 'queued' ? 'Send attempt' : 'Unsent'} · {new Date(v.at).toLocaleString()} · {v.text.slice(0, 70)}</option>)}</select>
            </label>}
            <label><input type="checkbox" checked={direct} onChange={e => setDirect(e.target.checked)} /> Type directly in terminal</label>
            <span className="field-hint">{direct ? 'Terminal input is not saved as a draft. This editor still keeps anything you write here.' : 'Typing a prompt in the terminal moves it into this saved editor.'}</span>
            <button type="button" className="btn" disabled={offline || !hasText || sending || !!remoteTypeVerdict(view)} onClick={() => void insert(false)}>Insert only</button>
          </div>
        </details>
        <button type="button" className="btn" data-variant="primary" disabled={offline || !hasText || sending || !!remoteTypeVerdict(view)} onClick={() => void insert(true)}>{sending ? 'Sending…' : 'Send prompt'}</button>
      </div>
    </div>
  )
}
