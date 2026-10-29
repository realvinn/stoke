import { useRef, useState } from 'react'
import { FieldHint } from './FieldHint'

export function StatsSettings(): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const claim = useRef(false)
  const reset = async (): Promise<void> => {
    if (claim.current) return
    claim.current = true; setBusy(true); setMessage('')
    try {
      const result = await window.stoke.stats.reset()
      setMessage(result.ok ? `Stats reset. Counting started again at ${new Date(result.view.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : result.message)
      if (result.ok) setConfirm(false)
    } catch { setMessage('Stats could not be reset. Try again.') }
    finally { claim.current = false; setBusy(false) }
  }
  return <div className="field" data-setting="stats.reset">
    <span className="field-label">Reset stats</span>
    <FieldHint>Stats counts this computer’s Stoke-open time, agent time and lines written by Claude Code and Codex. The data stays on this computer.</FieldHint>
    {confirm && <FieldHint tone="warning">This forgets this computer’s counts and starts again now. Earlier transcripts will not be counted again.</FieldHint>}
    <div className="btn-row">
      {confirm ? <><button className="btn" data-variant="danger" disabled={busy} onClick={() => void reset()}>Forget this computer’s stats</button><button className="btn" disabled={busy} onClick={() => setConfirm(false)}>Keep them</button></> : <button className="btn" onClick={() => setConfirm(true)}>Reset stats…</button>}
    </div>
    {message && <span className="field-hint" role="status">{message}</span>}
  </div>
}
