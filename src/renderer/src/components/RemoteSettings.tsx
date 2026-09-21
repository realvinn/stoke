import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CliRunResult,
  HostnameVerdict,
  RemoteReach,
  RemoteState,
  SelfUpdateState,
  StokeCommandState,
  UpdateInfo
} from '@shared/api'
import { clampPort, REMOTE_PORT_DEFAULT, type RemoteReachPreference } from '@shared/ui'
import { channelLagNotice, updateButton, updateVerdict } from '../lib/updateVerdict'
import { cliUpToDate, selfUpToDate } from '@shared/updateCheck'
import { useDraft } from '../lib/useDraft'
import { FieldHint } from './FieldHint'
import { IconCopy } from './Icons'
import { CloudflareSetup } from './CloudflareSetup'
import type { CliRelaunchMode, CliUpdateState, Settings } from '@shared/types'

interface Props {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
}

/** Mirrors the store default; an emptied box falls back here rather than to ''. */
const DEFAULT_STT_URL = 'http://127.0.0.1:17890'

/** The two answers to "what happens to open sessions after the CLI updates". */
const RELAUNCH_MODES: { id: CliRelaunchMode; label: string; hint: string }[] = [
  {
    id: 'ask',
    label: 'Offer to relaunch',
    hint: 'The status bar offers "relaunch on <version>" and nothing happens until you press it'
  },
  {
    id: 'auto',
    label: 'Relaunch idle sessions in the background',
    hint: 'Sessions not in front are moved onto the new version as soon as they are idle'
  }
]

/** How the segmented control names each way a phone can reach this machine. */
const REACH_LABEL: Record<RemoteReach, string> = {
  lan: 'Same Wi-Fi',
  tailnet: 'Tailscale',
  tunnel: 'Cloudflare Tunnel',
  loopback: 'This computer only'
}

/**
 * One line that says how the phone gets in: transport, then the address.
 * Exported so the title bar's phone button can draw the same sentence.
 */
export function reachLine(state: RemoteState): string {
  if (state.reach === 'loopback') return 'Only reachable from this computer'
  const port = state.reach === 'tunnel' ? '' : ` · port ${state.server.port}`
  return `${REACH_LABEL[state.reach]} · ${state.address}${port}`
}

/**
 * What "Open on phone" is about to do, before it is pressed.
 *
 * PX-26(a): this used to guess from whether Tailscale happens to be running,
 * ignoring a reach the user had already chosen — so with "Same Wi-Fi" picked
 * it still read "Picks Tailscale unless you choose below". A stored
 * preference (`remote.reach !== 'auto'`) always wins; only the untouched
 * default falls back to the old guess.
 */
export function openOnPhoneHint(reach: RemoteReachPreference, tailnetAvailable: boolean): string {
  if (reach !== 'auto') return `Uses ${REACH_LABEL[reach]}`
  return `Picks ${tailnetAvailable ? 'Tailscale' : 'your Wi-Fi'}`
}

/**
 * Phone access.
 *
 * Ordered around the one question a person opening this panel has: "how do I
 * get this on my phone". The primary button answers it in one press, the QR
 * code is only ever drawn for a link a phone can open, and everything that
 * needs a Cloudflare account or a decision about ports sits behind a
 * disclosure. The previous layout put "Turn on" first and produced a QR code
 * of 127.0.0.1 under the heading "Open on your phone" on every fresh install.
 */
export function RemoteSettings({ settings, onPatch }: Props): React.JSX.Element {
  const [state, setState] = useState<RemoteState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmKey, setConfirmKey] = useState(false)
  /*
   * F4: open only when the user asked — by pressing the Tunnel segment, which
   * sets this true, or because Tunnel was already the stored reach when this
   * sheet mounted. `settings.remote.reach` (not `state`, which is not fetched
   * yet on the very first render) is what makes the seed a real answer rather
   * than "unknown".
   */
  const [tunnelOpen, setTunnelOpen] = useState(() => settings.remote.reach === 'tunnel')
  /**
   * What the public hostname answered, from the setup steps below.
   *
   * Kept up here because this is where the consequence is: the header draws a
   * QR code and reports the tunnel running, both true, while the link itself
   * reaches nothing. An error the panel knows about has to be said next to the
   * thing it invalidates.
   */
  const [verdict, setVerdict] = useState<HostnameVerdict | null>(null)
  const remote = settings.remote

  /*
   * Patches are built from the LATEST settings, never a render-time copy.
   * Main writes `remote` itself (the key, `enabled`), and a patch spread from
   * an older copy would put the old values back — which is exactly how a
   * fresh install's first edit used to erase the key the server was holding.
   */
  const latest = useRef({ remote, onPatch })
  latest.current = { remote, onPatch }
  const patchRemote = useCallback((p: Partial<Settings['remote']>): void => {
    const { remote: r, onPatch: patch } = latest.current
    patch({ remote: { ...r, ...p } })
  }, [])

  useEffect(
    () => () => {
      const { remote: r } = latest.current
      if (!r.sttUrl.trim()) patchRemote({ sttUrl: DEFAULT_STT_URL })
    },
    [patchRemote]
  )

  const refresh = useCallback(async (): Promise<void> => {
    setState(await window.stoke.remote.status())
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.stoke.remote.onChange(setState)
    // Pushes cover every change Stoke makes itself; the slow poll is only for
    // cloudflared's asynchronous URL and a phone appearing or leaving.
    const id = window.setInterval(() => void refresh(), 15_000)
    return () => {
      off()
      window.clearInterval(id)
    }
  }, [refresh])

  const act = async (fn: () => Promise<RemoteState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await fn())
    } finally {
      setBusy(false)
    }
  }

  const copyLink = (): void => {
    if (!state?.url) return
    window.stoke.clipboard.writeText(state.url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const running = state?.server.running ?? false
  const tunnel = state?.tunnel
  const reach: RemoteReach = state?.reach ?? 'loopback'
  /**
   * Which segment is lit: the stored choice, and only otherwise what the link
   * happens to use.
   *
   * It used to be inferred, with `Boolean(remote.hostname.trim())` first in the
   * ladder — so the moment a hostname was saved this was permanently 'tunnel',
   * the other two segments lit nothing when pressed, and there was no way back.
   * That is the bug this field exists to remove; reading the preference is the
   * whole fix, and preferring a running transport over the stored value here
   * would be the same conflation in a smaller form.
   */
  const chosen: RemoteReach = remote.reach !== 'auto' ? remote.reach : running ? reach : 'loopback'

  const hostnameField = useDraft(remote.hostname, (v) => patchRemote({ hostname: v.trim() }))
  const tunnelNameField = useDraft(remote.tunnelName, (v) =>
    patchRemote({ tunnelName: v.trim() || 'stoke' })
  )
  const portField = useDraft(String(remote.port), (v) => patchRemote({ port: clampPort(v) }))
  const sttField = useDraft(remote.sttUrl, (v) => patchRemote({ sttUrl: v.trim() || DEFAULT_STT_URL }))

  const accessUsable = Boolean(remote.hostname.trim()) && tunnel?.running === true && tunnel.mode === 'named'

  return (
    <>
      <div className="field">
        <span className="field-label">
          Phone access{' '}
          <span className="pill" data-tone={running ? 'success' : undefined}>
            {running
              ? state && state.server.clients > 0
                ? `on · ${state.server.clients} connected`
                : 'on'
              : 'off'}
          </span>
        </span>
        <span className="field-hint">
          {running && state
            ? reach === 'loopback'
              ? 'The server is on, but nothing outside this computer can reach it yet.'
              : `Your live sessions, on a phone. ${reachLine(state)}.`
            : 'Your live sessions on a phone: read, type, dictate, and start or resume work. Over the same Wi-Fi, over Tailscale, or from anywhere through a tunnel.'}
        </span>

        {!running && (
          <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
            <button
              className="btn"
              data-variant="primary"
              disabled={busy}
              onClick={() => void act(window.stoke.remote.openOnPhone)}
            >
              {busy ? 'Starting…' : 'Open on phone'}
            </button>
            <span className="field-hint">
              {openOnPhoneHint(remote.reach, Boolean(state?.tailnet))} unless you choose below, then
              shows a code to scan.
            </span>
          </div>
        )}

        {running && state && (
          <>
            {/*
              PX-8: a busy port used to report `running:true, error:null` on the
              LAN bind, or draw a QR beside an error the user had to scroll down
              to notice. `server.error` is now the gate for the code itself —
              a link nobody's phone can actually reach is worse than none.
            */}
            {state.url && reach !== 'loopback' && state.qr && !state.server.error && (
              <div className="phone-link">
                <img
                  className="phone-qr"
                  src={state.qr}
                  alt="QR code linking to your sessions"
                  width={168}
                  height={168}
                />
                <div className="phone-link-text">
                  <span className="mono field-hint phone-url">{state.url}</span>
                  <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="btn" onClick={copyLink}>
                      <IconCopy />
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                    <button
                      className="btn"
                      data-variant="ghost"
                      disabled={busy}
                      onClick={() => void act(window.stoke.remote.stop)}
                    >
                      Turn off
                    </button>
                    {/*
                      PX-26(b): the port used to live only under Advanced, two
                      scrolls away from the link it changes. A tunnel has no
                      port to show the phone (it dials the hostname), so this
                      is withheld there.
                    */}
                    {reach !== 'tunnel' && (
                      <label
                        className="field-hint"
                        style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}
                      >
                        Port
                        <input
                          className="input"
                          type="number"
                          min={1024}
                          max={65535}
                          value={portField.draft}
                          onChange={(e) => portField.setDraft(e.target.value)}
                          onBlur={portField.onBlur}
                          onKeyDown={portField.onKeyDown}
                          style={{ width: '6rem' }}
                        />
                      </label>
                    )}
                  </div>
                  <span className="field-hint">
                    The link carries the key. Treat it like a password — anyone with it can drive a
                    session on this machine.
                  </span>
                  {/*
                    Shown, not folded behind "Why?". A disclosure is for
                    REASONING the short line had to leave out; these are the
                    addresses themselves, and they are the answer to the
                    question the line above asks. Someone whose phone will not
                    load the page is troubleshooting, and making them find and
                    click a summary to see the thing they need to type is the
                    one moment a collapsed hint costs more than it saves.
                  */}
                  {state.candidates.length > 0 && reach === 'lan' && (
                    <div className="field-hint">
                      Not loading on the phone? This machine has more than one address — try these:
                      {state.candidates.map((c) => (
                        <span
                          key={c}
                          className="mono"
                          style={{ display: 'block', overflowWrap: 'anywhere' }}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {reach === 'loopback' && (
              <>
                <span className="field-hint" data-tone="warning">
                  This link only works on this computer. Pick how the phone reaches it below.
                </span>
                <button
                  className="btn"
                  data-variant="ghost"
                  disabled={busy}
                  onClick={() => void act(window.stoke.remote.stop)}
                  style={{ alignSelf: 'flex-start' }}
                >
                  Turn off
                </button>
              </>
            )}
            {remote.requireAccessHeader && reach !== 'tunnel' && (
              <span className="field-hint" data-tone="warning">
                Cloudflare Access is required, so this link only works through the tunnel.
              </span>
            )}
          </>
        )}

        {state?.server.error && (
          <span className="field-hint" data-tone="danger">
            {state.server.error}
          </span>
        )}
        {/*
          PX-26(b), finished: the busy-port error says "pick a different port",
          and the inline Port field was drawn only while the server ran with no
          error, which is exactly never in this state. It is here beside the
          error now, and main retries the server as soon as the port changes
          while Phone access is on (`shouldRestartRemote`).
        */}
        {state?.server.error && !running && remote.enabled && (
          <label
            className="field-hint"
            style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}
          >
            Port
            <input
              className="input"
              type="number"
              min={1024}
              max={65535}
              aria-label="Port for phone access"
              value={portField.draft}
              onChange={(e) => portField.setDraft(e.target.value)}
              onBlur={portField.onBlur}
              onKeyDown={portField.onKeyDown}
              style={{ width: '6rem' }}
            />
            Stoke tries again as soon as you change it.
          </label>
        )}

        {/*
          What the hostname itself answers, said beside the code that encodes
          it. Error 1033 is the one failure this panel can produce all by
          itself — `tunnel route dns` refuses to overwrite an existing record,
          so a hostname that ever pointed anywhere keeps pointing there — and
          it used to be reported only inside a collapsed step, under a header
          cheerfully drawing a scannable code for the same name.
        */}
        {reach === 'tunnel' && verdict === 'tunnel-not-found' && (
          <FieldHint
            tone="warning"
            more={
              <>
                Cloudflare returns 1033 when a hostname is routed to a tunnel that has no
                connections — which is to say, to a different tunnel than the one running here.
                Open <b>Reach it from outside your network</b> below and press{' '}
                <b>Replace the existing record</b> on step 4; that repoints{' '}
                <span className="mono">{remote.hostname}</span> at this tunnel. Nothing else needs
                changing, and a Cloudflare Access policy on the hostname is unrelated — leave it on.
              </>
            }
          >
            This link does not work yet: {remote.hostname} answers with Cloudflare error 1033.
          </FieldHint>
        )}
        {reach === 'tunnel' && verdict === 'access' && (
          <FieldHint
            more={
              <>
                Access is a good thing to have here: it means a stranger holding the link still has
                to sign in as you. It also means Stoke cannot check the rest of the way, so if the
                phone shows <b>error 1033</b> after signing in, the hostname is routed to a
                different tunnel — press <b>Replace the existing record</b> on step 4 below. Do not
                turn Access off to fix that; it is a separate layer and would not change it.
              </>
            }
          >
            {remote.hostname} is behind Cloudflare Access, so you sign in once on the phone.
          </FieldHint>
        )}
      </div>

      <div className="field">
        <span className="field-label">Reach it from</span>
        <div className="segmented" role="group" aria-label="How the phone reaches this machine">
          <button
            aria-pressed={chosen === 'lan'}
            title="Any phone on the same network. Convenient at home; the port is open to that network."
            onClick={() => patchRemote({ reach: 'lan', bindLan: true, bindTailscale: false })}
          >
            {REACH_LABEL.lan}
          </button>
          <button
            aria-pressed={chosen === 'tailnet'}
            disabled={!state?.tailnet}
            title={
              state?.tailnet
                ? `Only devices on your tailnet. This machine is ${state.tailnet}.`
                : 'Tailscale is not running on this machine'
            }
            onClick={() => patchRemote({ reach: 'tailnet', bindLan: false, bindTailscale: true })}
          >
            {REACH_LABEL.tailnet}
          </button>
          <button
            aria-pressed={chosen === 'tunnel'}
            title="From anywhere, through Cloudflare. Needs a domain and a one-time setup."
            onClick={() => {
              setTunnelOpen(true)
              /*
               * The binds go false because cloudflared connects to loopback —
               * a tunnel needs no listener on the LAN. Writing only those two
               * falses is what this segment used to do, which is why pressing
               * it appeared to do nothing at all: they were already false, and
               * nothing read them.
               */
              patchRemote({ reach: 'tunnel', bindLan: false, bindTailscale: false })
            }}
          >
            {REACH_LABEL.tunnel}
          </button>
        </div>
        <span className="field-hint">
          {chosen === 'lan'
            ? 'Works for any phone on this Wi-Fi. Anything else on that network can see the port too, but the key still gates it.'
            : chosen === 'tailnet'
              ? 'Reaches this machine from anywhere on your tailnet, and from nowhere else. No tunnel, no port open to the room.'
              : chosen === 'tunnel'
                ? 'A Cloudflare Tunnel points a hostname at this machine; nothing inbound is opened. Set it up below.'
                : 'Nothing chosen yet — Open on phone picks for you, or choose here.'}
        </span>
      </div>

      <details
        className="field-detail"
        /*
         * F4: `tunnelOpen || undefined` handed the DOM the attribute exactly
         * when it was false — `undefined` means "React does not manage this",
         * so whatever the element's own open/closed state already was (a
         * browser default, a prior toggle) kept showing rather than being
         * forced shut. Always controlled now: `open` is `tunnelOpen`, full
         * stop, so a closed state actually closes it.
         */
        open={tunnelOpen}
        onToggle={(e) => setTunnelOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          Reach it from outside your network{' '}
          <span className="pill" data-tone={tunnel?.running ? 'success' : undefined}>
            {tunnel?.running ? 'tunnel running' : tunnel?.installed ? 'cloudflared installed' : 'needs cloudflared'}
          </span>
        </summary>
        <div className="field-detail-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)', paddingTop: 'var(--space-8)' }}>
          <div className="field">
            <span className="field-label">Public hostname</span>
            <input
              className="input mono"
              placeholder="code.example.com"
              value={hostnameField.draft}
              spellCheck={false}
              onChange={(e) => hostnameField.setDraft(e.target.value)}
              onBlur={hostnameField.onBlur}
              onKeyDown={hostnameField.onKeyDown}
            />
            <span className="field-hint">
              The public name you want to reach this machine at, on a domain in that same
              Cloudflare account. Step 4 points it here.
            </span>
          </div>

          <div className="field">
            <span className="field-label">Tunnel name</span>
            <input
              className="input mono"
              placeholder="stoke"
              value={tunnelNameField.draft}
              spellCheck={false}
              onChange={(e) => tunnelNameField.setDraft(e.target.value)}
              onBlur={tunnelNameField.onBlur}
              onKeyDown={tunnelNameField.onKeyDown}
            />
            <span className="field-hint">
              What the tunnel is called in your Cloudflare account. Pick anything; step 3 below
              creates it under this name, and the steps re-check themselves when you change it.
            </span>
          </div>

          {/*
            The steps, after the two fields they read and before the controls
            that only make sense once they are done. It probes on open and on
            every change to either field, so "no tunnel named X" cannot linger
            after X is renamed.

            PX-26(d): a closed `<details>` still mounts its children — the
            browser only hides them — so this used to run `cloudflared tunnel
            list` and an HTTP probe on every visit to this panel, even for a
            Wi-Fi-only user who never touched Cloudflare. Mounted only once
            the disclosure is genuinely open (the Tunnel segment was chosen,
            or the user opened it themselves) — the same condition `tunnelOpen`
            already gates the `<details>` on.
          */}
          {tunnelOpen && (
            <CloudflareSetup
              tunnelName={remote.tunnelName}
              hostname={remote.hostname}
              running={tunnel?.running ?? false}
              busy={busy}
              onRun={() => void act(() => window.stoke.remote.tunnelStart('named'))}
              onVerdict={setVerdict}
            />
          )}

          <label className="check-row">
            <input
              type="checkbox"
              checked={remote.autoStartTunnel}
              disabled={!remote.hostname.trim()}
              onChange={(e) => patchRemote({ autoStartTunnel: e.target.checked })}
            />
            <span>
              <span className="field-label">Start the tunnel whenever phone access is on</span>
              <span className="field-hint">
                {remote.hostname.trim()
                  ? 'Runs the named tunnel with the server, including at launch.'
                  : 'Needs a public hostname first.'}
              </span>
            </span>
          </label>

          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !remote.hostname.trim()}
              onClick={() => void act(() => window.stoke.remote.tunnelStart('named'))}
              title={remote.hostname.trim() ? undefined : 'Set a public hostname first'}
            >
              Run named tunnel
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void act(() => window.stoke.remote.tunnelStart('quick'))}
              title="A throwaway trycloudflare.com address with no Access policy in front of it. Fine for a few minutes."
            >
              Quick tunnel
            </button>
            <button className="btn" disabled={busy || !tunnel?.running} onClick={() => void act(window.stoke.remote.tunnelStop)}>
              Stop
            </button>
          </div>
          {tunnel?.error && (
            <span className="field-hint" data-tone="danger">
              {tunnel.error}
            </span>
          )}
          <FieldHint more="A quick tunnel gets a throwaway trycloudflare.com address with no Access policy in front of it, so only the key protects it. Use the named tunnel for anything lasting.">
            The link and the code above switch to the tunnel while it runs.
          </FieldHint>

          <label className="check-row">
            <input
              type="checkbox"
              checked={remote.requireAccessHeader}
              disabled={!accessUsable && !remote.requireAccessHeader}
              onChange={(e) => patchRemote({ requireAccessHeader: e.target.checked })}
            />
            <span>
              <span className="field-label">Require Cloudflare Access</span>
              <FieldHint
                tone={remote.requireAccessHeader && reach !== 'tunnel' ? 'warning' : undefined}
                more="Reject anything that does not carry the headers Cloudflare Access adds, which in practice means requests that did not come through the tunnel. Stoke checks that the headers are there; it cannot verify their signature, so this narrows what reaches the server rather than replacing the key — keep the key private either way. It also blocks the Wi-Fi and Tailscale routes, which is why it is only offered once a named tunnel is running."
              >
                {accessUsable || remote.requireAccessHeader
                  ? 'Only answer requests that came through the tunnel.'
                  : 'Available once a named tunnel is running.'}
              </FieldHint>
            </span>
          </label>

          {tunnel && tunnel.log.length > 0 && (
            <details className="field-detail" open={tunnel.error ? true : undefined}>
              <summary>Tunnel log</summary>
              <div className="field-detail-body">
                <pre className="mono field-hint" style={{ margin: 0, maxHeight: '10rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {tunnel.log.slice(-25).join('\n')}
                </pre>
              </div>
            </details>
          )}
        </div>
      </details>

      <details className="field-detail">
        <summary>Advanced</summary>
        <div className="field-detail-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)', paddingTop: 'var(--space-8)' }}>
          <div className="field">
            <span className="field-label">Port</span>
            <input
              className="input"
              type="number"
              min={1024}
              max={65535}
              value={portField.draft}
              onChange={(e) => portField.setDraft(e.target.value)}
              onBlur={portField.onBlur}
              onKeyDown={portField.onKeyDown}
              style={{ width: '8rem' }}
            />
            <span className="field-hint">
              1024–65535. Anything else falls back to {REMOTE_PORT_DEFAULT}. A running server moves
              to the new port at once.
            </span>
          </div>

          <div className="field">
            <span className="field-label">
              Speech server{' '}
              {state && state.stt !== 'unknown' && (
                <span className="pill" data-tone={state.stt === 'up' ? 'success' : undefined}>
                  {state.stt === 'up' ? 'running' : 'not running'}
                </span>
              )}
            </span>
            <input
              className="input mono"
              placeholder={DEFAULT_STT_URL}
              value={sttField.draft}
              spellCheck={false}
              onChange={(e) => sttField.setDraft(e.target.value)}
              onBlur={sttField.onBlur}
              onKeyDown={sttField.onKeyDown}
            />
            <FieldHint
              more={
                <>
                  Stoke proxies to it, so it never has to face the internet. Terminal dictation picks
                  up a change immediately; the phone picks it up the next time the remote server
                  starts. <span className="mono">python scripts/stt-sidecar.py</span> in this repo runs
                  one locally.
                </>
              }
            >
              {state?.stt === 'down'
                ? 'Nothing is answering there, so dictation will fail until it is started.'
                : 'Where speech is transcribed, for the phone and the terminal alike.'}
            </FieldHint>
          </div>

          <div className="field">
            <span className="field-label">Key</span>
            {confirmKey ? (
              <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="field-hint">Every phone will need to scan the new code. Replace it?</span>
                <button
                  className="btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmKey(false)
                    void act(window.stoke.remote.newToken)
                  }}
                >
                  Replace
                </button>
                <button className="btn" data-variant="ghost" onClick={() => setConfirmKey(false)}>
                  Keep
                </button>
              </div>
            ) : (
              <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => setConfirmKey(true)}>
                Replace the key…
              </button>
            )}
            <span className="field-hint">The link is the key. Replacing it logs every phone out at once.</span>
          </div>
        </div>
      </details>
    </>
  )
}

/** Stoke updating itself from GitHub releases. */
export function SelfUpdateSettings({
  betaUpdates,
  onChangeBeta,
  autoDownload,
  onChangeAutoDownload,
  onInstall
}: {
  betaUpdates: boolean
  onChangeBeta: (v: boolean) => void
  autoDownload: boolean
  onChangeAutoDownload: (v: boolean) => void
  /** App's `requestSelfRestart`, which asks first when a turn is running. */
  onInstall: () => void
}): React.JSX.Element {
  const [state, setState] = useState<SelfUpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copiedCommand, setCopiedCommand] = useState(false)

  useEffect(() => {
    void window.stoke.self.state().then(setState)
    return window.stoke.self.onState(setState)
  }, [])

  if (!state) return <></>

  // Same reasoning as the CLI badge above: derived during render, not ticked.
  const selfOk = selfUpToDate(state, Date.now())
  // How this copy updates (src/shared/installKind.ts). A package manager's copy
  // gets its own line and command instead of the generic `blocked` reason, and
  // no releases-page button: downloading by hand would put a copy outside the
  // manager's record, which is the thing that line exists to prevent.
  const kind = state.installKind
  const managed = kind?.kind === 'managed' ? kind : null

  return (
    <div className="field">
      <span className="field-label">
        Stoke{' '}
        {state.availableVersion && (
          <span className="pill" data-tone="accent">
            {state.availableVersion} available
          </span>
        )}
        {selfOk && (
          <span className="pill" data-tone="success" title={selfOk.title}>
            {selfOk.badge}
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
                : state.blocked && !managed
                  ? state.blocked
                  : state.availableVersion
                    ? 'An update is available.'
                    : ''}
          {selfOk && selfOk.checked && <span className="field-stamp">{selfOk.checked}</span>}
        </span>
      )}

      {/* A portable folder: say that it updates itself, and how. */}
      {state.supported && kind?.kind === 'portable' && kind.note && (
        <span className="field-hint">{kind.note}</span>
      )}

      {/* A package manager's copy: its own command, copyable. */}
      {state.supported && managed && (
        <div className="field-hint" style={{ display: 'grid', gap: 'var(--space-8)', justifyItems: 'start' }}>
          <span>{managed.note}</span>
          {managed.command && (
            <>
              <span className="mono">{managed.command}</span>
              <button
                className="btn"
                onClick={() => {
                  window.stoke.clipboard.writeText(managed.command ?? '')
                  setCopiedCommand(true)
                }}
              >
                <IconCopy />
                {copiedCommand ? 'Copied' : 'Copy command'}
              </button>
            </>
          )}
        </div>
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
          {state.availableVersion && !state.downloaded && !managed && (
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
          {state.blocked !== null && state.availableVersion && !managed && (
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
              onClick={onInstall}
              title="Stoke restarts, and your tabs come back resumed. A prompt still running is asked about first."
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
            checked={autoDownload}
            onChange={(e) => onChangeAutoDownload(e.target.checked)}
          />
          <span>
            <span className="field-label">Download updates in the background</span>
            {/*
              Says what it does NOT do, because "automatic update" reads as
              "restarts on its own", and that is the one thing it never does.
            */}
            <FieldHint
              more={
                <>
                  Checked a few seconds after launch and every six hours after that. The download
                  never restarts anything: it installs when you quit Stoke, or when you press
                  Restart and install — which asks first if a prompt is still running, and brings
                  your tabs back resumed afterwards. A build that could not install what it
                  downloads (an unsigned copy, say) never starts the download.
                </>
              }
            >
              Fetches a new version when one is found; installs only when you restart.
            </FieldHint>
          </span>
        </label>
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
            <FieldHint
              more={
                <>
                  GitHub&rsquo;s &ldquo;latest release&rdquo; excludes prereleases, so with this off
                  a beta is invisible rather than declined. And because the updater ships inside the
                  app, this only governs what <em>this</em> build is offered from now on — it cannot
                  reach back and make an older install see a beta it has already passed over, so the
                  first beta after turning this on is still a manual download.
                </>
              }
            >
              Betas have not had their riskiest paths exercised yet.
            </FieldHint>
          </span>
        </label>
      )}
    </div>
  )
}

/**
 * Settings > Updates > Command line: the `stoke` command.
 *
 * Says three things and offers at most two buttons: whether the command is
 * there, whether a NEW terminal will find it (read from the login shell's PATH,
 * not Stoke's own), and what is in the way when neither. The work is in main
 * (`src/main/stokeCommand.ts`); nothing here decides anything.
 */
export function StokeCommandSettings(): React.JSX.Element {
  const [state, setState] = useState<StokeCommandState | null>(null)
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null)
  const [copied, setCopied] = useState(false)
  // Claimed before the IPC call (gotcha 51): a second press before the
  // disabled button has rendered would otherwise run the same write twice.
  const busyRef = useRef(false)

  useEffect(() => {
    let live = true
    void window.stoke.command.state().then((s) => {
      if (live) setState(s)
    })
    return () => {
      live = false
    }
  }, [])

  const act = (kind: 'install' | 'remove'): void => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(kind)
    void (kind === 'install' ? window.stoke.command.install() : window.stoke.command.remove())
      .then(setState)
      .catch((e: unknown) =>
        setState((cur) => (cur ? { ...cur, error: e instanceof Error ? e.message : String(e) } : cur))
      )
      .finally(() => {
        busyRef.current = false
        setBusy(null)
      })
  }

  if (!state) return <></>

  const pill =
    state.unavailable === null && state.status === 'installed' ? (
      <span className="pill" data-tone="success">
        installed
      </span>
    ) : state.unavailable === null && state.status === 'repairable' ? (
      <span className="pill" data-tone="accent">
        needs repair
      </span>
    ) : null

  return (
    <div className="field">
      <span className="field-label">Command line {pill}</span>
      <span className="field-hint">
        <span className="mono">stoke .</span> in a terminal opens that folder here;{' '}
        <span className="mono">stoke --help</span> lists the rest.
      </span>

      {state.unavailable ? (
        <span className="field-hint">{state.unavailable}</span>
      ) : (
        <>
          <span className="field-hint">{state.detail}</span>

          {state.onPath === false && state.pathLine && (
            <div
              className="field-hint"
              data-tone="warning"
              style={{ display: 'grid', gap: 'var(--space-8)', justifyItems: 'start' }}
            >
              <span>
                {state.platform === 'win32'
                  ? 'That folder is not on PATH yet.'
                  : '~/.local/bin is not on your PATH, so a new terminal will not find stoke yet. Add this to your shell profile (~/.zshrc for zsh):'}
              </span>
              <span className="mono">{state.pathLine}</span>
              <button
                className="btn"
                onClick={() => {
                  window.stoke.clipboard.writeText(state.pathLine ?? '')
                  setCopied(true)
                }}
              >
                <IconCopy />
                {copied ? 'Copied' : 'Copy line'}
              </button>
            </div>
          )}
          {state.onPath === null && state.status === 'installed' && state.platform !== 'win32' && (
            <span className="field-hint">
              Stoke could not read your login shell&rsquo;s PATH, so it cannot tell whether a new
              terminal will find <span className="mono">~/.local/bin</span>.
            </span>
          )}

          {(state.canInstall || state.canRemove) && (
            <div style={{ display: 'flex', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
              {state.canInstall && (
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={busy !== null}
                  onClick={() => act('install')}
                >
                  {busy === 'install'
                    ? 'Working…'
                    : state.status === 'repairable'
                      ? 'Repair'
                      : 'Install'}
                </button>
              )}
              {state.canRemove && (
                <button className="btn" disabled={busy !== null} onClick={() => act('remove')}>
                  {busy === 'remove' ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
          )}

          {state.platform === 'win32' && (
            <span className="field-hint" data-tone="warning">
              Not yet verified on Windows: this edits your user PATH through PowerShell, and nobody
              has watched it run there. A terminal opened before the change will not see it.
            </span>
          )}
        </>
      )}

      {state.error && (
        <span className="field-hint" data-tone="danger">
          {state.error}
        </span>
      )}
    </div>
  )
}

/** Version, update availability, automatic updates, and `claude doctor` health. */
export function UpdatesSettings({
  autoUpdate,
  onChangeAuto,
  relaunch,
  onChangeRelaunch
}: {
  autoUpdate: boolean
  onChangeAuto: (v: boolean) => void
  relaunch: CliRelaunchMode
  onChangeRelaunch: (v: CliRelaunchMode) => void
}): React.JSX.Element {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(
    null
  )
  const [busy, setBusy] = useState<string | null>(null)

  /*
   * Read the state main already holds rather than starting a fresh check, and
   * subscribe for the rest of the panel's life.
   *
   * The subscription is the part that matters. The automatic checker runs on a
   * six-hour timer with no UI attached, so without a push the panel would only
   * ever show what was true when it was opened — and an update installed while
   * it sat open would change the version on disk with nothing on screen moving.
   */
  useEffect(() => {
    let live = true
    const take = (s: CliUpdateState): void => {
      setInfo(s.info)
      setNote(s.note)
    }
    void window.stoke.updates.state().then((s) => {
      if (live) take(s)
      // Nothing has checked yet this run — the deferred startup check has not
      // landed — so ask, rather than sitting on "Checking…" until it does.
      if (live && !s.info) void window.stoke.updates.check().then(setInfo)
    })
    const off = window.stoke.updates.onState(take)
    return () => {
      live = false
      off()
    }
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

  /**
   * Move the CLI onto the `latest` channel, then update — one press, because
   * the two halves are useless apart. Switching the channel and leaving the
   * install where it is achieves nothing until the next six-hourly check;
   * updating without switching is what `claude update` already declines to do.
   *
   * Not folded into `run` above, and the reason is `updateVerdict`'s `wanted`
   * argument. `run` reads it from the `info` already in state, which here is a
   * statement about the channel we have *just left* — on this machine it said
   * "nothing available", so a successful update from 2.1.237 to 2.1.258 would
   * have been reported against a check that expected no movement. The re-check
   * between the write and the run is what makes the verdict describe the thing
   * that actually happened.
   *
   * Stoke never reaches this by itself. The channel is the user's setting,
   * drawn a section away in the Claude Code panel, and silently rewriting it
   * would be Stoke overruling a pin it merely displays — a deliberate `stable`
   * is a legitimate choice and this is an offer, not a correction.
   */
  const switchToLatest = async (): Promise<void> => {
    setBusy('channel')
    setOutput(null)
    setVerdict(null)
    try {
      const written = await window.stoke.claudeConfig.set('autoUpdatesChannel', 'latest')
      if (!written.ok) {
        setVerdict({
          tone: 'danger',
          text:
            written.error ??
            'The channel could not be written to ~/.claude/settings.json.'
        })
        return
      }
      const rechecked = await window.stoke.updates.check()
      setInfo(rechecked)
      const result = await window.stoke.updates.run()
      setOutput(result.output || null)
      setVerdict(updateVerdict(result, rechecked.updateAvailable))
      setInfo(await window.stoke.updates.check())
    } catch (err) {
      // Same reason as `run`'s catch: a rejected invoke would otherwise clear
      // `busy` in the finally and leave the panel exactly as it started, which
      // is indistinguishable from the click never having landed.
      setVerdict({
        tone: 'danger',
        text: `Stoke could not switch the channel: ${
          err instanceof Error ? err.message : String(err)
        }`
      })
    } finally {
      setBusy(null)
    }
  }

  const update = updateButton(info)
  const lag = info?.behindLatest ? channelLagNotice(info.behindLatest) : null
  /*
    The quiet state, which is the one the panel is in almost all the time and
    the one it used to say least about. `Date.now()` is read during render on
    purpose: this is a settings sheet the user has just opened, the value is
    re-derived on every re-render, and a ticking clock for a line that reads
    "checked at 14:32" would be motion for its own sake.
  */
  const cliOk = cliUpToDate(info, Date.now())

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
        {cliOk && (
          <span className="pill" data-tone="success" title={cliOk.title}>
            {cliOk.badge}
          </span>
        )}
      </span>
      {/*
        The channel is named whenever it is not the CLI's own default, and that
        sentence is the whole point of the row.

        "Running 2.1.237, latest is 2.1.236" reads as a typo until you know the
        channel; with `on the stable channel` in front of it, it reads as the
        fact it is — this install is ahead of the stream it follows, so there is
        genuinely nothing to install and `claude update` will keep saying so.
        Naming `latest` too would be noise on every machine that never touched
        the setting, which is most of them.
      */}
      <span className="field-hint">
        {info
          ? info.error
            ? `Running ${info.current ?? 'unknown'}. Could not check for updates: ${info.error}`
            : info.channel === 'disabled'
              ? `Running ${info.current ?? 'unknown'}${
                  info.latest ? `, newest is ${info.latest}` : ''
                }. The CLI's own auto-updates are switched off, so Stoke will not install this for you.`
              : info.channel && info.channel !== 'latest'
                ? `Running ${info.current ?? 'unknown'} on the ${info.channel} channel${
                    info.latest ? `, which has ${info.latest}` : ''
                  }.`
                : `Running ${info.current ?? 'unknown'}${info.latest ? `, latest is ${info.latest}` : ''}.`
          : 'Checking…'}
        {cliOk && cliOk.checked && <span className="field-stamp">{cliOk.checked}</span>}
      </span>

      {/*
        The channel gap, and the one press that closes it.

        Above the buttons rather than beside them because it is a different
        question from the ones they answer: "Update now" is about this channel
        and is correctly disabled while the channel has nothing newer. This row
        exists precisely for the state where every button below is right to say
        there is nothing to do and the install is still weeks behind. Drawn only
        when there IS a gap, so a machine on `latest` — most of them — never
        sees it.
      */}
      {lag && (
        <div className="field-hint" data-tone="warning" style={{ display: 'grid', gap: 'var(--space-8)', justifyItems: 'start' }}>
          <span>{lag.text}</span>
          <button
            className="btn"
            data-variant="primary"
            disabled={busy !== null}
            title="Writes autoUpdatesChannel: latest to ~/.claude/settings.json, then runs claude update."
            onClick={() => void switchToLatest()}
          >
            {busy === 'channel' ? 'Switching…' : lag.action}
          </button>
        </div>
      )}

      {/*
        What the automatic checker did while nobody was watching. Shown above
        the buttons because it explains the version line directly above it —
        "Running 2.1.237" is a different sentence when the line under it says
        Stoke installed that itself twenty minutes ago.

        Toned by outcome rather than always neutral: an automatic update that
        FAILED is the case worth noticing, and it is also the case that has no
        other way of ever being seen — there was no dialog and no button press
        to attach it to.
      */}
      {note && (
        <span className="field-hint" data-tone={/failed/i.test(note) ? 'danger' : 'success'}>
          {note}
        </span>
      )}

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

      <label className="check-row">
        <input
          type="checkbox"
          checked={autoUpdate}
          onChange={(e) => onChangeAuto(e.target.checked)}
        />
        <span>
          <span className="field-label">Keep the CLI up to date automatically</span>
          {/*
            Says what it does NOT change as well as what it does, because the
            section above this one is Stoke's own updates and the two are
            independent. Someone who has just read "Betas have not had their
            riskiest paths exercised yet" a few rows up will reasonably wonder
            whether this is the same switch.
          */}
          <FieldHint
            more={
              <>
                Checked a few seconds after launch and every six hours after that. Only an update
                that a <em>successful</em> check found is installed — a check that could not reach
                the registry reports nothing rather than triggering a blind{' '}
                <span className="mono">claude update</span>. A failed attempt is not retried for an
                hour, because the usual causes (an npm-global install Stoke cannot write to, a{' '}
                <span className="mono">claude</span> that has moved) do not fix themselves in a
                minute. This never touches Stoke&rsquo;s own version, which is the section above.
              </>
            }
          >
            Runs <span className="mono">claude update</span> for you, and says what happened.
          </FieldHint>
        </span>
      </label>

      {/*
        What happens to the sessions already open once a newer CLI is on disk.
        They keep running the old binary until they are relaunched — there is
        no swapping it underneath a live process — so this is a real choice,
        not a detail of the update above.
      */}
      <div className="field">
        <span className="field-label">After the CLI updates</span>
        <div className="segmented" role="group" aria-label="After the CLI updates">
          {RELAUNCH_MODES.map((m) => (
            <button
              key={m.id}
              aria-pressed={relaunch === m.id}
              title={m.hint}
              onClick={() => onChangeRelaunch(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <FieldHint
          more={
            <>
              A relaunch resumes the same conversation on the new version. In the background it only
              ever touches a session that is idle, not the tab in front, and not one with anything
              typed and unsent; a busy one is relaunched the moment its turn ends. Anything the
              session was running outside the conversation — a background shell, an MCP server’s
              state — ends with the old process, which is why this is off unless you ask for it.
            </>
          }
        >
          Open sessions keep the version they started on until they are relaunched.
        </FieldHint>
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
            padding: 'var(--space-8)'
          }}
        >
          {output}
        </pre>
      )}
    </div>
  )
}
