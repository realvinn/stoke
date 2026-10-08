import { useEffect, useRef, useState } from 'react'
import type { CodingCli } from '@shared/codingClis'
import type { AgentInstallation, AgentUpdateResult } from '@shared/agentLifecycle'
import { Spinner } from './Spinner'

export function AgentUpdater({ cli, path }: { cli: CodingCli; path: string }): React.JSX.Element {
  const [info, setInfo] = useState<AgentInstallation | null>(null)
  const [reading, setReading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [result, setResult] = useState<AgentUpdateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const claimed = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const inspect = async (): Promise<void> => {
    const request = ++generation.current
    setReading(true)
    setError(null)
    try {
      const next = await window.stoke.cli.agentInstallation(cli.id)
      if (mounted.current && request === generation.current) setInfo(next)
    } catch { if (mounted.current && request === generation.current) setError('The installation could not be inspected.') }
    finally { if (mounted.current && request === generation.current) setReading(false) }
  }
  useEffect(() => {
    mounted.current = true
    void inspect()
    return () => { mounted.current = false; generation.current++ }
  }, [cli.id, path])
  const update = async (): Promise<void> => {
    if (claimed.current || !info?.command || !info.version) return
    claimed.current = true
    setUpdating(true)
    setResult(null)
    try {
      const outcome = await window.stoke.cli.updateAgent({ cli: cli.id, expectedPath: info.resolvedPath, expectedVersion: info.version })
      if (mounted.current) { setResult(outcome); await inspect() }
    } catch { if (mounted.current) setError('The updater could not start. Inspect the installation before retrying.') }
    finally { claimed.current = false; if (mounted.current) setUpdating(false) }
  }
  return (
    <div className="field" data-setting="agent.update">
      <span className="field-label">Installed version and updates</span>
      {reading ? <span className="field-hint"><Spinner /> Inspecting installation…</span> : info ? <>
        <span className="field-hint">{info.version ?? 'Unknown version'} · {info.method}{info.packageName ? ` · ${info.packageName}` : ''}</span>
        {info.command && <span className="field-hint">Runs <code className="mono">{info.command.label}</code> through this installation’s updater.</span>}
        {info.reason && <span className="field-hint">{info.reason}</span>}
        {info.runningSessions > 0 && <span className="field-hint">Close this agent’s {info.runningSessions} local session{info.runningSessions === 1 ? '' : 's'} or sign-in tabs, then check again to update.</span>}
      </> : <span className="field-hint">This executable could no longer be found.</span>}
      <div className="mcp-editor-actions">
        <button className="btn" disabled={reading || updating} onClick={() => void inspect()}>Check installation</button>
        <button className="btn" disabled={reading || updating || !info?.command || (info?.runningSessions ?? 0) > 0} aria-busy={updating} onClick={() => void update()}>
          {updating && <Spinner />}{updating ? `Updating ${cli.label}…` : `Update ${cli.label}`}
        </button>
      </div>
      {result && <p className="field-hint" role="status" data-tone={['failed', 'unverified', 'blocked'].includes(result.outcome) ? 'warning' : undefined}>{result.message}</p>}
      {result?.output && <details><summary className="field-hint">Updater output</summary><pre className="mono agent-update-output">{result.output}</pre></details>}
      {error && <p className="field-hint" role="alert" data-tone="warning">{error}</p>}
      <span className="field-hint">Updates are explicit and never restart a session. New sessions use the installed version.</span>
    </div>
  )
}
