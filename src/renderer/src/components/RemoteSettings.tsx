import { useCallback, useEffect, useRef, useState } from 'react'
import type { CliRunResult, RemoteState, SelfUpdateState, UpdateInfo } from '@shared/api'
import { updateButton, updateVerdict } from '../lib/updateVerdict'
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

        <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
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
          Where speech is transcribed, for dictation on the phone and in the terminal alike. Stoke
          proxies to it, so it never has to face the internet. Terminal dictation picks up a change
          immediately; the phone picks it up the next time the remote server starts.{' '}
          <code>scripts/stt-sidecar.py</code> in this repo runs one locally.
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
            <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
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
export function SelfUpdateSettings({
  betaUpdates,
  onChangeBeta
}: {
  betaUpdates: boolean
  onChangeBeta: (v: boolean) => void
}): React.JSX.Element {
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
          {/*
            `error` is tested before `availableVersion`, and that ordering is the
            whole fix. The other way round — which is how this shipped — an
            update being available short-circuited the chain, so every failure
            that happened *after* one was found had nowhere to appear. Pressing
            Download on a Mac threw ERR_UPDATER_ZIP_FILE_NOT_FOUND instantly and
            the panel went on calmly saying "An update is available."
          */}
          {state.downloaded
            ? 'An update is ready to install.'
            : state.downloading
              ? `Downloading… ${state.progress}%`
              : state.error
                ? state.error
                : state.blocked
                  ? state.blocked
                  : state.availableVersion
                    ? 'An update is available.'
                    : 'Up to date.'}
        </span>
      )}

      {state.supported && (
        <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
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
              // Greyed out rather than hidden when this build cannot install
              // what it downloads: the button still says what would happen, and
              // hovering says why it will not. Offering it would spend ~120 MB
              // to arrive at a refusal.
              disabled={state.downloading || state.blocked !== null}
              title={state.blocked ?? undefined}
              onClick={() => void window.stoke.self.download().then(setState)}
            >
              Download
            </button>
          )}
          {state.blocked !== null && state.availableVersion && (
            <button
              className="btn"
              onClick={() =>
                window.stoke.openExternal('https://github.com/realvinn/stoke/releases/latest')
              }
            >
              Open releases page
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

      {state.supported && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={betaUpdates}
            onChange={(e) => onChangeBeta(e.target.checked)}
          />
          <span>
            <span className="field-label">Offer beta releases</span>
            {/*
              Says what it cannot do as well as what it can. GitHub's "latest
              release" excludes prereleases, so with this off a beta is invisible
              rather than declined — and since the updater ships inside the app,
              this only ever governs what THIS build is offered next. It can
              never reach back and make an older install see a beta.
            */}
            <span className="field-hint">
              Betas are builds whose riskiest paths have not been exercised yet, so they are not
              offered unless you ask. Off, Check for updates only ever finds stable releases.
              This governs what this copy of Stoke is offered from now on — an older install
              cannot be made to see a beta it has already passed over, so the first beta after
              turning this on is still a manual download.
            </span>
          </span>
        </label>
      )}
    </div>
  )
}

/** Version, update availability and `claude doctor` health. */
export function UpdatesSettings(): React.JSX.Element {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(
    null
  )
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void window.stoke.updates.check().then(setInfo)
  }, [])

  const run = async (label: string, fn: () => Promise<CliRunResult>): Promise<void> => {
    setBusy(label)
    setOutput(null)
    setVerdict(null)
    try {
      const result = await fn()
      setOutput(result.output || null)
      if (label === 'update') {
        // Read `updateAvailable` from the check that ran *before* this update,
        // not from a fresh one: the fresh one is false either way afterwards.
        setVerdict(updateVerdict(result, info?.updateAvailable ?? false))
        setInfo(await window.stoke.updates.check())
      } else if (!result.ok) {
        setVerdict({ tone: 'danger', text: result.error ?? 'The command failed.' })
      }
    } catch (err) {
      /*
       * Without this the button was a no-op with no trace. A rejected invoke
       * skipped every setState above, `busy` cleared in the finally, and the
       * panel returned to exactly the state it started in — which is what
       * "I press it and sometimes nothing happens" looks like from outside.
       */
      setVerdict({
        tone: 'danger',
        text: `Stoke could not run the command: ${
          err instanceof Error ? err.message : String(err)
        }`
      })
    } finally {
      setBusy(null)
    }
  }

  const update = updateButton(info)

  return (
    <div className="field">
      {/* "Claude Code CLI", not "Claude Code": the sheet is one flat column and
          the Claude Code *settings* panel below would otherwise repeat this
          exact heading a few hundred pixels down. This one is about the
          binary's version; that one is about its configuration. */}
      <span className="field-label">
        Claude Code CLI{' '}
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

      <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
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
          disabled={busy !== null || !update.enabled}
          title={update.hint}
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

      {verdict && (
        <span className="field-hint" data-tone={verdict.tone}>
          {verdict.text}
        </span>
      )}

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
            padding: 'var(--space-8)'
          }}
        >
          {output}
        </pre>
      )}
    </div>
  )
}
