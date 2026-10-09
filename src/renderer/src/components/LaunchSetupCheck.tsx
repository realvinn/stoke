import { useEffect, useRef, useState } from 'react'
import type { LaunchPreflightItem, LaunchPreflightRequest, LaunchPreflightResult } from '@shared/launchPreflight'
import { Spinner } from './Spinner'

interface Props {
  input: LaunchPreflightRequest
  /** Main settings change even when a masked key stays visually empty. */
  revision: object | null
  onFix: (item: LaunchPreflightItem['id']) => void
}
export function LaunchSetupCheck({ input, revision, onFix }: Props): React.JSX.Element {
  const key = JSON.stringify(input)
  const current = useRef({ key, revision }); current.current = { key, revision }
  const mounted = useRef(false)
  const claimed = useRef(false)
  const [checking, setChecking] = useState(false)
  const [sample, setSample] = useState<{ key: string; revision: object | null; result: LaunchPreflightResult } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const result = sample?.key === key && sample.revision === revision ? sample.result : null
  const check = async (): Promise<void> => {
    if (claimed.current || !revision) return
    claimed.current = true; setChecking(true); setSample(null)
    const captured = { key, revision }
    try {
      const answer = await window.stoke.pty.preflight({ ...input })
      if (mounted.current && current.current.key === captured.key && current.current.revision === captured.revision) setSample({ ...captured, result: answer })
    } catch {
      if (mounted.current && current.current.key === captured.key && current.current.revision === captured.revision) setSample({ ...captured, result: { ok: false, message: 'Setup did not answer. Wait before retrying and check the folder and agent in Settings.' } })
    } finally { claimed.current = false; if (mounted.current) setChecking(false) }
  }
  return <div className="launcher-setup" onKeyDown={event => event.stopPropagation()}>
    <button className="btn" data-variant="ghost" type="button" disabled={checking || !revision} aria-busy={checking} onClick={() => void check()}>
      {checking && <Spinner />}{checking ? 'Checking setup…' : 'Check setup'}
    </button>
    {result && <div className="launcher-setup-result" role="status">
      {!result.ok ? <p>{result.message}</p> : <>
        <b>{result.report.items.some(item => item.state === 'blocked') ? 'Setup needs attention' : 'No blocking setup issues found'}</b>
        <span className="launcher-setup-note">{new Date(result.report.checkedAt).toLocaleTimeString()} · Local configuration only. No agent task or connection test was started. Recheck after changing setup.</span>
        <ul>{result.report.items.map(item => <li key={item.id}>
          <div className="launcher-alert-text"><b>{item.label} · {item.state === 'configured' ? 'Configured' : item.state === 'blocked' ? 'Needs setup' : 'Review'}</b><span>{item.message}</span></div>
          {item.state !== 'configured' && <button className="btn" data-variant="ghost" type="button" onClick={() => onFix(item.id)}>{item.id === 'folder' ? 'Choose folder…' : 'Open settings…'}</button>}
        </li>)}</ul>
      </>}
    </div>}
  </div>
}
