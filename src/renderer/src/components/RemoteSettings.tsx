import { useCallback, useEffect, useState } from 'react'
import type { RemoteState, UpdateInfo } from '@shared/api'
import type { Settings } from '@shared/types'

interface Props {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}

/**
 * Remote access: a loopback server that a Cloudflare Tunnel can point a real
 * hostname at, so sessions are reachable from a phone.
 */
export function RemoteSettings({ settings, onPatch }: Props): React.JSX.Element {
  const [state, setState] = useState<RemoteState | null>(null)
  const [busy, setBusy] = useState(false)
  const remote = settings.remote

  const refresh = useCallback(async (): Promise<void> => {
    setState(await window.stoke.remote.status())
  }, [])

  useEffect(() => {
    void refresh()
    // The tunnel takes a few seconds to report a URL, so keep polling gently.
    const id = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(id)
  }, [refresh])

  const act = async (fn: () => Promise<RemoteState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await fn())
    } finally {
      setBusy(false)
    }
  }

  const running = state?.server.running ?? false
  const tunnel = state?.tunnel

  return (
    <>
      <div className="field">
        <span className="field-label">
          Remote access{' '}
          <span className="pill" data-tone={running ? 'success' : undefined}>
            {running ? `on · ${state?.server.clients ?? 0} connected` : 'off'}
          </span>
        </span>
        <span className="field-hint">
          Serves your live sessions to a phone. Bound to loopback and gated by a key, so it is
          only reachable through a tunnel you point at it.
        </span>

        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button
            className="btn"
            data-variant={running ? undefined : 'primary'}
            disabled={busy}
            onClick={() =>
              void act(() => (running ? window.stoke.remote.stop() : window.stoke.remote.start()))
            }
          >
            {running ? 'Turn off' : 'Turn on'}
          </button>
          <button className="btn" disabled={busy} onClick={() => void act(window.stoke.remote.newToken)}>
            New key
          </button>
        </div>

        {state?.server.error && (
          <span className="field-hint" style={{ color: 'var(--danger)' }}>
            {state.server.error}
          </span>
        )}
      </div>

      {running && state && (
        <div className="field">
          <span className="field-label">Open on your phone</span>
          {state.qr && (
            <img
              src={state.qr}
              alt="QR code linking to the remote session list"
              width={180}
              height={180}
              style={{ borderRadius: 'var(--r-lg)', alignSelf: 'flex-start' }}
            />
          )}
          <span className="mono field-hint" style={{ overflowWrap: 'anywhere' }}>
            {state.url}
          </span>
          <span className="field-hint">
            The link carries the key. Treat it like a password — anyone with it can drive a
            session on this machine.
          </span>
        </div>
      )}

      <div className="field">
        <span className="field-label">Public hostname</span>
        <input
          className="input mono"
          placeholder="code.example.com"
          value={remote.hostname}
          spellCheck={false}
          onChange={(e) => onPatch({ remote: { ...remote, hostname: e.target.value.trim() } })}
        />
        <span className="field-hint">The hostname your Cloudflare Tunnel routes to this port.</span>
      </div>

      <div className="field">
        <span className="field-label">Port</span>
        <input
          className="input"
          type="number"
          min={1024}
          max={65535}
          value={remote.port}
          onChange={(e) => onPatch({ remote: { ...remote, port: Number(e.target.value) || 7878 } })}
        />
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={remote.requireAccessHeader}
          onChange={(e) => onPatch({ remote: { ...remote, requireAccessHeader: e.target.checked } })}
        />
        <span>
          <span className="field-label">Require Cloudflare Access</span>
          <span className="field-hint">
            Reject anything without Access headers, so the server only answers requests that came
            through the tunnel. Turn this on once Access is working — it also blocks you on the
            LAN.
          </span>
        </span>
      </label>

      <label className="check-row">
        <input
          type="checkbox"
          checked={remote.bindLan}
          onChange={(e) => onPatch({ remote: { ...remote, bindLan: e.target.checked } })}
        />
        <span>
          <span className="field-label">Also listen on the local network</span>
          <span className="field-hint">
            Lets a phone on the same Wi-Fi connect without a tunnel. Convenient at home, but it
            exposes the port to everything on that network.
          </span>
        </span>
      </label>

      <div className="field">
        <span className="field-label">
          Cloudflare Tunnel{' '}
          <span className="pill" data-tone={tunnel?.running ? 'success' : undefined}>
            {!tunnel?.installed ? 'not installed' : tunnel.running ? 'running' : 'stopped'}
          </span>
        </span>

        {!tunnel?.installed ? (
          <span className="field-hint">
            cloudflared was not found. Install it, then reopen this panel.
          </span>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
              <button
                className="btn"
                disabled={busy || !remote.hostname}
                onClick={() => void act(() => window.stoke.remote.tunnelStart('named'))}
                title={remote.hostname ? undefined : 'Set a public hostname first'}
              >
                Run named tunnel
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => void act(() => window.stoke.remote.tunnelStart('quick'))}
              >
                Quick tunnel
              </button>
              <button className="btn" disabled={busy} onClick={() => void act(window.stoke.remote.tunnelStop)}>
                Stop
              </button>
            </div>

            {tunnel.url && (
              <span className="mono field-hint" style={{ overflowWrap: 'anywhere' }}>
                {tunnel.url}
              </span>
            )}
            {tunnel.error && (
              <span className="field-hint" style={{ color: 'var(--danger)' }}>
                {tunnel.error}
              </span>
            )}

            <span className="field-hint">
              A quick tunnel gets a throwaway trycloudflare.com address with no Access policy in
              front of it — only the key protects it. Use the named tunnel for anything lasting.
            </span>

            <details>
              <summary className="field-hint" style={{ cursor: 'default' }}>
                One-time setup commands
              </summary>
              <pre
                className="mono"
                style={{
                  fontSize: 'var(--fs-xs)',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  color: 'var(--text-muted)'
                }}
              >
                {(state?.setup ?? []).join('\n')}
              </pre>
              <span className="field-hint">
                These need a browser login, so run them yourself once. Then add a Cloudflare Access
                policy for the hostname allowing only your email.
              </span>
            </details>

            {tunnel.log.length > 0 && (
              <details>
                <summary className="field-hint" style={{ cursor: 'default' }}>
                  Tunnel log
                </summary>
                <pre
                  className="mono"
                  style={{
                    fontSize: 'var(--fs-xs)',
                    maxHeight: '10rem',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    color: 'var(--text-faint)'
                  }}
                >
                  {tunnel.log.slice(-25).join('\n')}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </>
  )
}

/** Version, update availability and `claude doctor` health. */
export function UpdatesSettings(): React.JSX.Element {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void window.stoke.updates.check().then(setInfo)
  }, [])

  const run = async (label: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(label)
    setOutput(null)
    try {
      setOutput(await fn())
      if (label === 'update') setInfo(await window.stoke.updates.check())
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="field">
      <span className="field-label">
        Claude Code{' '}
        {info?.updateAvailable && (
          <span className="pill" data-tone="accent">
            {info.latest} available
          </span>
        )}
      </span>
      <span className="field-hint">
        {info
          ? info.error
            ? `Running ${info.current ?? 'unknown'}. Could not check for updates: ${info.error}`
            : `Running ${info.current ?? 'unknown'}${info.latest ? `, latest is ${info.latest}` : ''}.`
          : 'Checking…'}
      </span>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() => void window.stoke.updates.check().then(setInfo)}
        >
          Check again
        </button>
        <button
          className="btn"
          data-variant={info?.updateAvailable ? 'primary' : undefined}
          disabled={busy !== null}
          onClick={() => void run('update', window.stoke.updates.run)}
        >
          {busy === 'update' ? 'Updating…' : 'Update now'}
        </button>
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() => void run('doctor', window.stoke.updates.doctor)}
        >
          {busy === 'doctor' ? 'Running…' : 'Run doctor'}
        </button>
      </div>

      {output && (
        <pre
          className="mono"
          style={{
            fontSize: 'var(--fs-xs)',
            maxHeight: '14rem',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            color: 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            padding: 'var(--sp-3)'
          }}
        >
          {output}
        </pre>
      )}
    </div>
  )
}
