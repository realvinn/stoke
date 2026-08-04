import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteState, SelfUpdateState, UpdateInfo } from '@shared/api'
import type { Settings } from '@shared/types'

interface Props {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}

/** Mirrors the store default; an emptied box falls back here rather than to ''. */
const DEFAULT_STT_URL = 'http://127.0.0.1:17890'

/**
 * Remote access: a loopback server that a Cloudflare Tunnel can point a real
 * hostname at, so sessions are reachable from a phone.
 */
export function RemoteSettings({ settings, onPatch }: Props): React.JSX.Element {
  const [state, setState] = useState<RemoteState | null>(null)
  const [busy, setBusy] = useState(false)
  const remote = settings.remote

  /*
   * Escape closes the sheet by unmounting this input (App.tsx binds it on
   * window), and React delivers no blur to a node that is being unmounted - so
   * the onBlur repair on the speech-server box never runs on that path. An
   * emptied box would then persist '' through hydrate, which keeps own
   * properties over the defaults, and survive a restart: the field renders its
   * placeholder so it still looks configured, while the microphone 503s.
   *
   * Repair on the way out as well. The ref keeps the dep array empty so this
   * runs only on a real unmount, never on the 4s status poll's re-renders.
   */
  const latest = useRef({ remote, onPatch })
  latest.current = { remote, onPatch }
  useEffect(
    () => () => {
      const { remote: r, onPatch: patch } = latest.current
      if (!r.sttUrl.trim()) patch({ remote: { ...r, sttUrl: DEFAULT_STT_URL } })
    },
    []
  )

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

      <label className="check-row">
        <input
          type="checkbox"
          checked={remote.bindTailscale}
          disabled={remote.bindLan}
          onChange={(e) => onPatch({ remote: { ...remote, bindTailscale: e.target.checked } })}
        />
        <span>
          <span className="field-label">Also listen on Tailscale</span>
          <span className="field-hint">
            {remote.bindLan
              ? 'Already covered: listening on the local network includes the tailnet.'
              : 'Reaches this machine from anywhere your phone can see the tailnet, with no tunnel. Unlike the local network option it opens the port to the tailnet only. Loopback stays bound, so the Cloudflare tunnel keeps working alongside it.'}
          </span>
        </span>
      </label>

      <div className="field">
        <span className="field-label">Speech server</span>
        <input
          className="input mono"
          placeholder={DEFAULT_STT_URL}
          value={remote.sttUrl}
          spellCheck={false}
          onChange={(e) => onPatch({ remote: { ...remote, sttUrl: e.target.value.trim() } })}
          onBlur={(e) => {
            // Fall back on blur, never on change: this input is controlled, so
            // substituting the default mid-edit re-renders, drops the selection
            // and parks the caret at the end — select-all, delete, retype would
            // silently append to the default instead of replacing it.
            if (!e.target.value.trim()) onPatch({ remote: { ...remote, sttUrl: DEFAULT_STT_URL } })
          }}
        />
        <span className="field-hint">
          The transcription sidecar the microphone on the phone dictates through. Stoke proxies to
          it, so it never has to face the internet. Takes effect the next time the remote server
          starts.
        </span>
      </div>

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

            {/*
              Say why the button is dead. It was disabled with the reason only in
              a title attribute, so it read as broken unless you happened to hover
              it - and a fresh profile always starts with no hostname.
            */}
            {!remote.hostname && (
              <span className="field-hint" data-tone="warning">
                Run named tunnel needs a Public hostname above — that is the name your tunnel
                already routes to this port. Quick tunnel works without one.
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

/** Stoke updating itself from GitHub releases. */
export function SelfUpdateSettings(): React.JSX.Element {
  const [state, setState] = useState<SelfUpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.stoke.self.state().then(setState)
    return window.stoke.self.onState(setState)
  }, [])

  if (!state) return <></>

  return (
    <div className="field">
      <span className="field-label">
        Stoke{' '}
        {state.availableVersion && (
          <span className="pill" data-tone="accent">
            {state.availableVersion} available
          </span>
        )}
      </span>

      {!state.supported ? (
        <span className="field-hint">
          Running from source, so there is no installed copy to replace. Self-update applies to
          the packaged app.
        </span>
      ) : (
        <span className="field-hint">
          Version {state.currentVersion}.{' '}
          {state.downloaded
            ? 'An update is ready to install.'
            : state.downloading
              ? `Downloading… ${state.progress}%`
              : state.availableVersion
                ? 'An update is available.'
                : state.error
                  ? `No update found: ${state.error}`
                  : 'Up to date.'}
        </span>
      )}

      {state.supported && (
        <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={busy || state.downloading}
            onClick={() => {
              setBusy(true)
              void window.stoke.self
                .check()
                .then(setState)
                .finally(() => setBusy(false))
            }}
          >
            Check for updates
          </button>
          {state.availableVersion && !state.downloaded && (
            <button
              className="btn"
              data-variant="primary"
              disabled={state.downloading}
              onClick={() => void window.stoke.self.download().then(setState)}
            >
              Download
            </button>
          )}
          {state.downloaded && (
            <button
              className="btn"
              data-variant="primary"
              onClick={() => void window.stoke.self.install()}
              title="Stoke restarts and any running sessions end"
            >
              Restart and install
            </button>
          )}
        </div>
      )}
    </div>
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
