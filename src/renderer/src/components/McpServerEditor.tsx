import { useEffect, useRef, useState } from 'react'
import { validateMcpSetup, type McpProbeResult } from '@shared/mcpSetup'
import type { McpServerSpec } from '@shared/mcpServers'
import { Spinner } from './Spinner'

type Pair = { key: string; value: string }
function entries(values: Record<string, string>): Pair[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }))
}
function pairs(rows: Pair[], header: boolean): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.value) continue
    const identity = header ? key.toLowerCase() : key
    if (!key || seen.has(identity)) throw new Error('Give each credential a unique, nonempty name.')
    seen.add(identity)
    out[key] = row.value
  }
  return out
}

function Credentials({ label, rows, onChange }: { label: string; rows: Pair[]; onChange: (rows: Pair[]) => void }): React.JSX.Element {
  return (
    <fieldset className="mcp-credentials">
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div className="mcp-credential-row" key={index}>
          <input className="input mono" aria-label={`${label} name ${index + 1}`} placeholder="Name" value={row.key}
            spellCheck={false} onChange={(e) => onChange(rows.map((entry, i) => i === index ? { ...entry, key: e.target.value } : entry))} />
          <input className="input" type="password" aria-label={`${label} value ${index + 1}`} placeholder="Value" value={row.value}
            autoComplete="off" spellCheck={false} onChange={(e) => onChange(rows.map((entry, i) => i === index ? { ...entry, value: e.target.value } : entry))} />
          <button className="btn" type="button" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove</button>
        </div>
      ))}
      <button className="btn" type="button" disabled={rows.length >= 64} onClick={() => onChange([...rows, { key: '', value: '' }])}>Add {label.toLowerCase()}</button>
    </fieldset>
  )
}

/** Drafts are local until Save; closing never flushes a half-entered credential. */
export function McpServerEditor({ server, existingNames, enableLabel, initiallyEnabled, onSave, onCancel }: {
  server: McpServerSpec | null
  existingNames: readonly string[]
  enableLabel: string | null
  initiallyEnabled: boolean
  onSave: (spec: McpServerSpec, enabled: boolean) => void
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState(server?.transport ?? 'http')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args ?? [])
  const [env, setEnv] = useState(entries(server?.env ?? {}))
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState(entries(server?.headers ?? {}))
  const [bearer, setBearer] = useState(server?.bearer ?? '')
  const [enabled, setEnabled] = useState(initiallyEnabled)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<McpProbeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const testing = useRef(false)
  const draftVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const change = (apply: () => void): void => { draftVersion.current++; setTest(null); setError(null); apply() }
  const read = (): McpServerSpec | null => {
    try {
      if (!server && existingNames.includes(name.trim())) throw new Error('That server name is already in use. Choose another name.')
      const result = validateMcpSetup({ name: name.trim(), transport, command, args, env: pairs(env, false), url, headers: pairs(headers, true), bearer })
      if (!result.ok) throw new Error(result.message)
      setError(null)
      return result.spec
    } catch (error) { setError(error instanceof Error ? error.message : 'Check the server fields.'); return null }
  }
  const probe = async (): Promise<void> => {
    if (testing.current) return
    const spec = read()
    if (!spec) return
    testing.current = true
    setBusy(true)
    setTest(null)
    const version = draftVersion.current
    try {
      const result = await window.stoke.cli.probeMcp(spec)
      if (mounted.current && version === draftVersion.current) setTest(result)
    } catch { if (mounted.current && version === draftVersion.current) setTest({ ok: false, message: 'The connection test could not start.' }) }
    finally { testing.current = false; if (mounted.current) setBusy(false) }
  }
  return (
    <form className="mcp-editor" onSubmit={(e) => { e.preventDefault(); if (!testing.current) { const spec = read(); if (spec) onSave(spec, enabled) } }}>
      <span className="field-label">{server ? `Edit ${server.name}` : 'Add an MCP server'}</span>
      <p className="field-hint">Keys, tokens, header values and environment values use Stoke’s encrypted store. Choose which agents receive this server. Changes apply to new sessions.</p>
      <label>Name<input className="input mono" value={name} disabled={server !== null} autoFocus={!server} spellCheck={false} maxLength={64}
        onChange={(e) => change(() => setName(e.target.value))} /></label>
      <label>Connection<select className="input" value={transport} onChange={(e) => change(() => setTransport(e.target.value as 'stdio' | 'http'))}>
        <option value="http">HTTP endpoint</option><option value="stdio">Local command</option>
      </select></label>
      {transport === 'http' ? <>
        <label>Endpoint<input className="input mono" type="url" value={url} placeholder="https://example.com/mcp" spellCheck={false}
          onChange={(e) => change(() => setUrl(e.target.value))} /></label>
        <label>Bearer token (optional)<input className="input" type="password" value={bearer} autoComplete="off" spellCheck={false}
          onChange={(e) => change(() => setBearer(e.target.value))} /></label>
        <Credentials label="Headers" rows={headers} onChange={(rows) => change(() => setHeaders(rows))} />
        <p className="field-hint">OAuth sign-in stays in each agent’s own MCP flow. Stoke does not copy an agent’s OAuth session.</p>
      </> : <>
        <label>Executable<input className="input mono" value={command} placeholder="npx" spellCheck={false}
          onChange={(e) => change(() => setCommand(e.target.value))} /></label>
        <fieldset className="mcp-credentials"><legend>Arguments</legend>
          {args.map((arg, index) => <div className="mcp-credential-row" key={index}>
            <input className="input mono" aria-label={`Argument ${index + 1}`} value={arg} spellCheck={false}
              onChange={(e) => change(() => setArgs(args.map((entry, i) => i === index ? e.target.value : entry)))} />
            <button className="btn" type="button" aria-label={`Remove argument ${index + 1}`} onClick={() => change(() => setArgs(args.filter((_, i) => i !== index)))}>Remove</button>
          </div>)}
          <button className="btn" type="button" disabled={args.length >= 256} onClick={() => change(() => setArgs([...args, '']))}>Add argument</button>
        </fieldset>
        <p className="field-hint">One argument per field. Enter credentials below; command arguments can be read from the process list.</p>
        <Credentials label="Environment variables" rows={env} onChange={(rows) => change(() => setEnv(rows))} />
      </>}
      {enableLabel && <label className="check-row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span>Use for {enableLabel}</span></label>}
      {error && <p className="field-hint" data-tone="warning" role="alert">{error}</p>}
      {test && <p className="field-hint" role="status" data-tone={test.ok ? undefined : 'warning'}>
        {test.ok ? `Connected to ${test.server} (${test.version}); ${test.tools}${test.moreTools ? '+' : ''} tools available.` : test.message}
      </p>}
      <div className="mcp-editor-actions">
        <button className="btn" type="button" disabled={busy} aria-busy={busy} onClick={() => void probe()}>{busy && <Spinner />}{busy ? 'Testing…' : 'Test connection'}</button>
        <button className="btn" type="submit" disabled={busy} data-variant="primary">Save server</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
      <p className="field-hint">Testing a local command starts it briefly. The test initializes MCP and lists tools; it does not call them.</p>
    </form>
  )
}
