import { useEffect, useRef, useState } from 'react'
import { DEFAULT_HUB_URL, emptyHubView, type HubLocalKeyView, type HubResult, type HubView } from '@shared/hub/client'
import { FieldHint } from './FieldHint'
import { useHubRemote } from '../lib/hubRemote'
import { Spinner } from './Spinner'

/*
 * Settings › Account & sync: this computer's side of Stoke Hub — the address,
 * signing in, the vault and its Recovery Kit, joining, what syncs, SSH keys,
 * the device list, and signing out.
 *
 * Main owns every step (src/main/hub/service.ts) and pushes a `HubView`; this
 * component only draws it and presses buttons. What arrives here is names,
 * counts, times and the pairing code — never a key, a token or an SSH private
 * key. The one exception is the Recovery Kit, shown once when it is made,
 * because the owner has to read it; main forgets it once it is confirmed.
 *
 * Copy rule for this panel: say what leaves the computer (only ciphertext
 * sealed here) and what the hub can see (the account email, device names and
 * platforms, how many items and how big, and when) — in those words, where the
 * choice is made.
 */

type Note = { tone?: 'success' | 'warning' | 'danger'; text: string } | null

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
const platformName = (p: string): string => PLATFORM_NAMES[p] ?? p

function ago(at: number | null, now: number): string {
  if (!at) return 'never'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(at).toLocaleDateString()
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * One busy slot for the whole panel. The ref is the correctness half (a
 * second press lands before React re-renders the disabled button, gotchas 20
 * and 51); main refuses a second action too.
 */
function useRun(): {
  busy: string | null
  note: Note
  setNote: (n: Note) => void
  run: <T extends object>(key: string, fn: () => Promise<HubResult<T>>, ok?: (r: { ok: true } & T) => Note) => void
} {
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const claimed = useRef(false)
  const run = <T extends object>(key: string, fn: () => Promise<HubResult<T>>, ok?: (r: { ok: true } & T) => Note): void => {
    if (claimed.current) return
    claimed.current = true
    setBusy(key)
    setNote(null)
    void fn()
      .then((r) => {
        if (r.ok) setNote(ok ? ok(r) : null)
        else if (r.message) setNote({ tone: 'danger', text: r.message })
      })
      .catch((err) => setNote({ tone: 'danger', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        claimed.current = false
        setBusy(null)
      })
  }
  return { busy, note, setNote, run }
}

function Busy({ on, idle, working }: { on: boolean; idle: string; working: string }): React.JSX.Element {
  return (
    <>
      {on && <Spinner />}
      {on ? working : idle}
    </>
  )
}

function Status({ note }: { note: Note }): React.JSX.Element | null {
  if (!note || !note.text) return null
  return (
    <span className="field-hint" data-tone={note.tone} role="status">
      {note.text}
    </span>
  )
}

export function AccountSyncSettings(): React.JSX.Element {
  const [view, setView] = useState<HubView>(emptyHubView())
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let live = true
    void window.stoke.hub.view().then((v) => {
      if (!live) return
      setView(v)
      setLoaded(true)
    })
    const off = window.stoke.hub.onChange((v) => {
      setView(v)
      setLoaded(true)
    })
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      live = false
      off()
      clearInterval(t)
    }
  }, [])

  if (!loaded) {
    return (
      <div className="field">
        <span className="field-label">Account &amp; sync</span>
        <span className="field-hint">Asking Stoke Hub…</span>
      </div>
    )
  }

  return (
    <>
      <Overview view={view} now={now} />
      {(view.phase === 'off' || view.phase === 'signed-out') && <HubAddress view={view} />}
      {view.phase === 'signed-out' && <SignIn view={view} />}
      {view.kitPending && <KitPanel />}
      {view.phase === 'new-account' && !view.kitPending && <CreateVault view={view} />}
      {view.phase === 'locked' && view.alarm && <Alarm view={view} />}
      {view.phase === 'locked' && !view.kitPending && <Join view={view} />}
      {view.phase === 'active' && (
        <>
          {view.alarm && <Alarm view={view} />}
          {view.held.length > 0 && <Held view={view} />}
          {view.pairs.length > 0 && <Requests view={view} />}
          <Syncing view={view} now={now} />
          {view.notes.length > 0 && <Conflicts view={view} />}
          <SshKeys view={view} />
          <Devices view={view} />
          <OtherMachinesSettings />
          <RecoveryKit view={view} />
        </>
      )}
      {view.phase !== 'off' && (view.phase !== 'signed-out' || (view.device !== null && view.email !== '')) && <SignOut view={view} />}
    </>
  )
}

/* ------------------------------------------------------------------ overview */

function Overview({ view, now }: { view: HubView; now: number }): React.JSX.Element {
  const pill: { tone?: string; text: string } =
    view.phase === 'off'
      ? { text: 'not set up' }
      : view.phase === 'signed-out'
        ? { text: 'signed out' }
        : view.phase === 'new-account'
          ? { tone: 'accent', text: 'no vault yet' }
          : view.phase === 'locked'
            ? { tone: 'accent', text: 'vault locked' }
            : view.phase === 'revoked'
              ? { tone: 'danger', text: 'removed' }
              : view.alarm
                ? { tone: 'danger', text: 'stopped' }
                : view.busy
                  ? { tone: 'accent', text: 'syncing' }
                  : view.error
                    ? { tone: 'danger', text: 'error' }
                    : view.notes.length
                      ? { tone: 'accent', text: 'conflict' }
                      : { tone: 'success', text: 'in sync' }
  return (
    <div className="field" data-hub="overview" data-phase={view.phase}>
      <span className="field-label">
        Stoke Hub{' '}
        <span className="pill" data-tone={pill.tone} data-hub="state">
          {pill.text}
        </span>
      </span>
      <FieldHint
        more={
          <>
            Everything leaves this computer only as ciphertext, sealed here with a vault key the hub never holds (AES-256-GCM,
            keys exchanged between your devices with X25519). The hub stores what it cannot open. It does see your account
            email, each device&rsquo;s name and platform, how many items you sync and how big they are, and when they change.
            Your password only decides who may sign in: no key is made from it, so resetting it on the hub cannot open the
            vault. Agent sign-ins (Claude, Codex and the rest), the phone access key and this computer&rsquo;s folders never
            sync.
          </>
        }
      >
        Your settings, API keys, SSH hosts and — only the ones you pick — SSH keys, kept in step on every computer you sign
        in on.
      </FieldHint>
      {view.phase !== 'off' && view.email && (
        <span className="field-hint">
          <span className="mono">{view.email}</span> on <span className="mono">{view.url}</span>
          {view.device && (
            <>
              {' '}
              · this computer is <strong>{view.device.label}</strong>
            </>
          )}
        </span>
      )}
      {view.phase === 'revoked' && view.error && (
        <span className="field-hint" data-tone="danger" data-hub="revoked">
          {view.error.message}
        </span>
      )}
      {view.phase === 'active' && view.error && !view.alarm && (
        <span className="field-hint" data-tone="danger" data-hub="error">
          Last sync failed at {clock(view.error.at)}: {view.error.message}
          {view.error.retryAt ? ` Stoke tries again ${view.error.retryAt > now ? `at ${clock(view.error.retryAt)}` : 'shortly'}.` : ''}
        </span>
      )}
      {view.busy && (
        <span className="field-hint" data-hub="busy">
          {view.busy}
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ address */

function HubAddress({ view }: { view: HubView }): React.JSX.Element {
  const [url, setUrl] = useState(view.url || DEFAULT_HUB_URL)
  const { busy, note, run } = useRun()
  const saved = view.url !== '' && url.trim() === view.url
  return (
    <div className="field" data-hub="address">
      <span className="field-label">Hub address</span>
      <span className="field-hint">
        Your hub (the NUC, behind <span className="mono">stoke.vinn.dev/hub</span>). A LAN or Tailscale address works
        too, like <span className="mono">http://nuc.local:8788</span>.
      </span>
      <input
        className="input mono"
        aria-label="Hub address"
        spellCheck={false}
        value={url}
        disabled={busy !== null}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run('save', () => window.stoke.hub.setUrl(url), (r) => ({ tone: r.warning ? 'warning' : 'success', text: r.warning ?? 'Saved.' }))
        }}
      />
      {view.urlWarning && saved && (
        <span className="field-hint" data-tone="warning">
          {view.urlWarning}
        </span>
      )}
      <div className="btn-row">
        <button
          className="btn"
          disabled={busy !== null}
          aria-busy={busy === 'check' || undefined}
          onClick={() =>
            run('check', () => window.stoke.hub.checkUrl(url), (r) => ({
              tone: 'success',
              text: `A Stoke hub${r.version ? ` (${r.version})` : ''} answered at ${r.base}.${r.needsBootstrap ? ' It has no account yet: create one with the invite it printed.' : ''}${r.warning ? ` ${r.warning}` : ''}`
            }))
          }
        >
          <Busy on={busy === 'check'} idle="Check" working="Checking…" />
        </button>
        <button
          className="btn"
          data-variant="primary"
          disabled={busy !== null || saved}
          aria-busy={busy === 'save' || undefined}
          data-hub="save-url"
          onClick={() => run('save', () => window.stoke.hub.setUrl(url), (r) => ({ tone: r.warning ? 'warning' : 'success', text: r.warning ?? 'Saved.' }))}
        >
          <Busy on={busy === 'save'} idle={saved ? 'Saved' : 'Use this hub'} working="Saving…" />
        </button>
      </div>
      <Status note={note} />
    </div>
  )
}

/* ------------------------------------------------------------------ sign in */

function SignIn({ view }: { view: HubView }): React.JSX.Element {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState(view.email)
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [label, setLabel] = useState(view.device?.label ?? '')
  const { busy, note, run } = useRun()
  const submit = (): void =>
    run('sign-in', () =>
      window.stoke.hub.signIn({ email, password, label: label.trim() || undefined, ...(mode === 'up' ? { invite } : {}) })
    )
  const ready = view.url !== '' && email.trim() !== '' && password !== '' && (mode === 'in' || invite.trim() !== '')
  return (
    <div className="field" data-hub="sign-in">
      <span className="field-label">{mode === 'in' ? 'Sign in' : 'Create your account'}</span>
      <div className="segmented" role="group" aria-label="Sign in or create an account">
        <button aria-pressed={mode === 'in'} onClick={() => setMode('in')} disabled={busy !== null}>
          Sign in
        </button>
        <button aria-pressed={mode === 'up'} onClick={() => setMode('up')} disabled={busy !== null} data-hub="mode-up">
          New account (invite)
        </button>
      </div>
      {mode === 'up' && (
        <input
          className="input mono"
          aria-label="Invite"
          placeholder="INV-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
          autoComplete="off"
          value={invite}
          disabled={busy !== null}
          onChange={(e) => setInvite(e.target.value)}
        />
      )}
      <input
        className="input"
        type="email"
        aria-label="Email"
        placeholder="Email"
        autoComplete="username"
        spellCheck={false}
        value={email}
        disabled={busy !== null}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        className="input"
        type="password"
        aria-label="Password"
        placeholder={mode === 'up' ? 'Password (12 characters or more)' : 'Password'}
        autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
        spellCheck={false}
        value={password}
        disabled={busy !== null}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ready) submit()
        }}
      />
      <input
        className="input"
        aria-label="This computer’s name"
        placeholder="This computer’s name (what your other devices will call it)"
        value={label}
        disabled={busy !== null}
        onChange={(e) => setLabel(e.target.value)}
      />
      <span className="field-hint">
        {mode === 'up'
          ? 'The hub printed a one-use invite when it first started (journalctl -u stoke-hub). '
          : ''}
        The password goes to the hub and nowhere else; it opens nothing.
      </span>
      <div className="btn-row">
        <button
          className="btn"
          data-variant="primary"
          disabled={!ready || busy !== null}
          aria-busy={busy === 'sign-in' || undefined}
          data-hub="submit-sign-in"
          onClick={submit}
        >
          <Busy on={busy === 'sign-in'} idle={mode === 'in' ? 'Sign in' : 'Create account'} working={mode === 'in' ? 'Signing in…' : 'Creating…'} />
        </button>
      </div>
      <Status note={note} />
    </div>
  )
}

/* ------------------------------------------------------------------ the vault and its Kit */

function CreateVault({ view }: { view: HubView }): React.JSX.Element {
  const { busy, note, run } = useRun()
  return (
    <div className="field" data-hub="create-vault">
      <span className="field-label">Create your vault</span>
      <span className="field-hint">
        This account has no vault yet. Stoke makes one on this computer, with a Recovery Kit: a code that opens the vault if
        you ever lose every device signed in to it. You will see it once.
      </span>
      {!view.keyStore.protected && (
        <span className="field-hint" data-tone="warning">
          {view.keyStore.why} Stoke will not keep a vault key where it would be readable, so this computer cannot hold the
          vault.
        </span>
      )}
      <div className="btn-row">
        <button
          className="btn"
          data-variant="primary"
          disabled={busy !== null || !view.keyStore.protected}
          aria-busy={busy === 'create' || undefined}
          data-hub="create"
          onClick={() => run('create', () => window.stoke.hub.createVault())}
        >
          <Busy on={busy === 'create'} idle="Create vault and Recovery Kit" working="Making it…" />
        </button>
      </div>
      <Status note={note} />
    </div>
  )
}

function KitPanel(): React.JSX.Element {
  const [kit, setKit] = useState<{ kit: string; group: number; purpose: string } | null>(null)
  const [typed, setTyped] = useState('')
  const { busy, note, run, setNote } = useRun()
  useEffect(() => {
    let live = true
    void window.stoke.hub.kit().then((r) => {
      if (live && r.ok) setKit({ kit: r.kit, group: r.group, purpose: r.purpose })
    })
    return () => {
      live = false
    }
  }, [])
  if (!kit) return <div className="field" />
  const groups = kit.kit.split('-')
  return (
    <div className="field" data-hub="kit">
      <span className="field-label">{kit.purpose === 'genesis' ? 'Your Recovery Kit' : 'Your new Recovery Kit'}</span>
      {kit.purpose === 'recover' && (
        <span className="field-hint" data-tone="warning" data-hub="kit-recover">
          The Kit you typed opens the vault, but a Kit that has been typed may have been seen — so this computer joins with a
          new one, and the one you typed stops working. Nothing is sent until you confirm the new Kit below.
        </span>
      )}
      <span className="field-hint">
        Write it down, print it, or save it somewhere offline. With it and your hub password, anyone can open your vault;
        without it, losing every device loses the vault — the hub cannot open it either.
        {kit.purpose !== 'genesis' && kit.purpose !== 'recover' && ' Your old Kit stops working once this one is confirmed.'}
      </span>
      <div className="hub-kit mono" data-hub="kit-text" aria-label="Recovery Kit">
        {groups.map((g, i) => (
          <span key={i} data-current={i === kit.group || undefined}>
            {g}
          </span>
        ))}
      </div>
      <div className="btn-row">
        <button
          className="btn"
          disabled={busy !== null}
          aria-busy={busy === 'save' || undefined}
          data-hub="kit-save"
          onClick={() => run('save', () => window.stoke.hub.saveKit(), (r) => ({ tone: 'success', text: `Saved ${r.path}.` }))}
        >
          <Busy on={busy === 'save'} idle="Save as file…" working="Saving…" />
        </button>
        <button className="btn" disabled={busy !== null} onClick={() => run('print', () => window.stoke.hub.printKit())}>
          <Busy on={busy === 'print'} idle="Print…" working="Printing…" />
        </button>
      </div>
      <span className="field-hint">
        To show you have it, type group {kit.group} (the {ordinal(kit.group)} group after <span className="mono">RK1</span>):
      </span>
      <input
        className="input mono"
        aria-label={`Group ${kit.group} of the Recovery Kit`}
        spellCheck={false}
        autoComplete="off"
        maxLength={9}
        value={typed}
        disabled={busy !== null}
        data-hub="kit-group"
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run('confirm', () => window.stoke.hub.confirmKit(typed))
        }}
      />
      <div className="btn-row">
        <button
          className="btn"
          data-variant="primary"
          disabled={busy !== null || typed.trim() === ''}
          aria-busy={busy === 'confirm' || undefined}
          data-hub="kit-confirm"
          onClick={() => run('confirm', () => window.stoke.hub.confirmKit(typed))}
        >
          <Busy
            on={busy === 'confirm'}
            idle={kit.purpose === 'genesis' ? 'I have saved it — create the vault' : kit.purpose === 'recover' ? 'I have saved it — join the vault' : 'I have saved it — replace the Kit'}
            working="Sealing…"
          />
        </button>
        <button
          className="btn"
          data-variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            setNote(null)
            void window.stoke.hub.cancelKit()
          }}
        >
          Cancel
        </button>
      </div>
      <Status note={note} />
    </div>
  )
}

function ordinal(n: number): string {
  return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'][n - 1] ?? `${n}th`
}

/* ------------------------------------------------------------------ joining */

function Join({ view }: { view: HubView }): React.JSX.Element {
  const [kit, setKit] = useState('')
  const [useKit, setUseKit] = useState(false)
  const { busy, note, run } = useRun()
  const j = view.join
  const waiting = j && (j.state === 'waiting' || j.state === 'nonce' || j.state === 'revealed' || j.state === 'approved')
  return (
    <div className="field" data-hub="join">
      <span className="field-label">Join your vault</span>
      <span className="field-hint">
        You are signed in, but this computer does not hold the vault key yet. Approve it from a computer that does, or use
        your Recovery Kit.
      </span>
      {!view.keyStore.protected && (
        <span className="field-hint" data-tone="warning">
          {view.keyStore.why} Stoke will not keep a vault key where it would be readable, so this computer cannot join.
        </span>
      )}
      {waiting ? (
        <div className="settings-item-card" data-hub="join-waiting" style={{ display: 'flex', flexDirection: 'column' }}>
          {j.code ? (
            <>
              <span className="field-hint">
                {j.approver ? `${j.approver} answered. ` : ''}
                {j.confirmed
                  ? 'You confirmed the code here.'
                  : j.state === 'approved'
                    ? 'It has added this computer. Check that it showed exactly these six digits:'
                    : 'Does it show exactly these six digits?'}
              </span>
              <span className="hub-code mono" data-hub="join-code">
                {j.code}
              </span>
              {j.confirmed ? (
                <span className="field-hint" data-hub="join-confirmed">
                  <Spinner /> {j.message ?? `Waiting for ${j.approver ?? 'the other device'} to add this computer — press “They match” there too.`}
                </span>
              ) : (
                <>
                  <span className="field-hint">
                    Confirm on both computers. This one takes nothing until you do, whatever the hub says — the code is how you
                    know the other side is really your device.
                  </span>
                  <div className="btn-row">
                    <button
                      className="btn"
                      data-variant="primary"
                      disabled={busy !== null}
                      aria-busy={busy === 'match' || undefined}
                      data-hub="join-match"
                      onClick={() => run('match', () => window.stoke.hub.joinConfirm(true))}
                    >
                      <Busy on={busy === 'match'} idle="The codes match" working="Joining…" />
                    </button>
                    <button className="btn" data-variant="danger" disabled={busy !== null} data-hub="join-mismatch" onClick={() => run('mismatch', () => window.stoke.hub.joinConfirm(false))}>
                      They don’t
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <span className="field-hint">
              <Spinner /> Waiting for another device: open Settings › Account &amp; sync on one that is in the vault. The
              request lasts until {clock(j.expiresAt)}.
            </span>
          )}
          <div className="btn-row">
            <button className="btn" disabled={busy !== null} onClick={() => run('cancel', () => window.stoke.hub.joinCancel())}>
              Cancel request
            </button>
          </div>
        </div>
      ) : (
        <>
          {j?.message && (
            <span className="field-hint" data-tone="warning">
              {j.message}
            </span>
          )}
          <div className="btn-row">
            <button
              className="btn"
              data-variant="primary"
              disabled={busy !== null || !view.keyStore.protected}
              aria-busy={busy === 'join' || undefined}
              data-hub="join-start"
              onClick={() => run('join', () => window.stoke.hub.joinStart())}
            >
              <Busy on={busy === 'join'} idle="Approve from another device" working="Asking…" />
            </button>
            <button className="btn" data-variant="ghost" disabled={busy !== null} onClick={() => setUseKit((v) => !v)}>
              Use my Recovery Kit
            </button>
          </div>
        </>
      )}
      {useKit && !waiting && (
        <>
          <input
            className="input mono"
            aria-label="Recovery Kit"
            placeholder="RK1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX"
            spellCheck={false}
            autoComplete="off"
            value={kit}
            disabled={busy !== null}
            onChange={(e) => setKit(e.target.value)}
          />
          <span className="field-hint">
            Typed on this computer only. It is checked, then Stoke makes a new Kit to replace it: a Kit that has been typed may
            have been seen.
          </span>
          <div className="btn-row">
            <button
              className="btn"
              data-variant="primary"
              disabled={busy !== null || kit.trim() === ''}
              aria-busy={busy === 'recover' || undefined}
              data-hub="recover"
              onClick={() => run('recover', () => window.stoke.hub.recover(kit))}
            >
              <Busy on={busy === 'recover'} idle="Open the vault" working="Opening…" />
            </button>
          </div>
        </>
      )}
      <Status note={note} />
    </div>
  )
}

/* ------------------------------------------------------------------ active */

function Alarm({ view }: { view: HubView }): React.JSX.Element {
  const { busy, note, run } = useRun()
  const kind = view.alarm?.kind
  const wentBack = kind === 'rollback' || kind === 'version'
  return (
    <div className="field" data-hub="alarm" data-kind={kind}>
      <span className="field-label">Sync stopped</span>
      <span className="field-hint" data-tone="danger">
        {view.alarm?.message}
      </span>
      {wentBack ? (
        <>
          <FieldHint
            more="Republish only if you know why the hub went back — you restored it from a backup, say. This computer posts back the device-list entries the hub lost (only if the hub’s list is an earlier copy of this computer’s; any other list is refused), and puts its own values over any the hub serves older. Nothing the hub serves is taken on trust."
          >
            Nothing is sent or applied until you decide.
          </FieldHint>
          <div className="btn-row">
            <button
              className="btn"
              data-variant="danger"
              disabled={busy !== null}
              aria-busy={busy === 'republish' || undefined}
              data-hub="republish"
              onClick={() => run('republish', () => window.stoke.hub.republish(), () => ({ tone: 'success', text: 'Republished. The hub holds this computer’s copy again.' }))}
            >
              <Busy on={busy === 'republish'} idle="Republish from this computer" working="Republishing…" />
            </button>
          </div>
        </>
      ) : (
        <span className="field-hint">
          Nothing is sent or applied. There is nothing to put right from here: sign out on this computer (below), look at the
          hub, and join again if you still trust it.
        </span>
      )}
      <Status note={note} />
    </div>
  )
}

function Held({ view }: { view: HubView }): React.JSX.Element {
  const { busy, note, run } = useRun()
  return (
    <div className="field" data-hub="held">
      <span className="field-label">Waiting for you on this computer</span>
      <span className="field-hint">
        These synced changes would change what runs here, so they are not applied until you say so on this computer. Apply
        only what you set up yourself.
      </span>
      {view.held.map((h) => (
        <div key={h.group} className="settings-item-card" data-hub="held-item" data-group={h.group} style={{ display: 'flex', flexDirection: 'column' }}>
          <span>
            <strong>{h.label}</strong> <span className="field-hint">from {h.from}, {clock(h.at)}</span>
          </span>
          <ul className="backup-changes">
            {h.lines.map((line, i) => (
              <li key={i}>
                <span className="backup-change-detail mono">{line}</span>
              </li>
            ))}
          </ul>
          <div className="btn-row">
            <button
              className="btn"
              data-variant="primary"
              disabled={busy !== null}
              aria-busy={busy === `apply-${h.group}` || undefined}
              data-hub="held-apply"
              onClick={() => run(`apply-${h.group}`, () => window.stoke.hub.applyHeld(h.group), () => ({ tone: 'success', text: `${h.label}: applied on this computer.` }))}
            >
              <Busy on={busy === `apply-${h.group}`} idle="Apply on this computer" working="Applying…" />
            </button>
            <button className="btn" data-variant="ghost" disabled={busy !== null} data-hub="held-keep" onClick={() => run(`keep-${h.group}`, () => window.stoke.hub.keepHeld(h.group))}>
              Keep this computer’s
            </button>
          </div>
        </div>
      ))}
      <Status note={note} />
    </div>
  )
}

function Requests({ view }: { view: HubView }): React.JSX.Element {
  const { busy, note, run } = useRun()
  return (
    <div className="field" data-hub="requests">
      <span className="field-label">Waiting to join</span>
      {view.pairs.map((p) => (
        <div key={p.pair} className="settings-item-card" data-hub="request" style={{ display: 'flex', flexDirection: 'column' }}>
          <span>
            <strong>{p.device.label}</strong> <span className="field-hint">({platformName(p.device.platform)}) asked at {clock(p.createdAt)}</span>
          </span>
          {p.code ? (
            <>
              <span className="field-hint">Does that computer show exactly these six digits?</span>
              <span className="hub-code mono" data-hub="approve-code">
                {p.code}
              </span>
              <div className="btn-row">
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={busy !== null}
                  aria-busy={busy === `ok-${p.pair}` || undefined}
                  data-hub="approve-confirm"
                  onClick={() => run(`ok-${p.pair}`, () => window.stoke.hub.approveConfirm(p.pair), () => ({ tone: 'success', text: `${p.device.label} is in the vault.` }))}
                >
                  <Busy on={busy === `ok-${p.pair}`} idle="They match — add it" working="Adding…" />
                </button>
                <button className="btn" data-variant="danger" disabled={busy !== null} onClick={() => run(`no-${p.pair}`, () => window.stoke.hub.refuse(p.pair))}>
                  They don’t match
                </button>
              </div>
            </>
          ) : p.mine ? (
            <span className="field-hint">
              <Spinner /> Waiting for {p.device.label} to answer…
            </span>
          ) : (
            <div className="btn-row">
              <button
                className="btn"
                data-variant="primary"
                disabled={busy !== null}
                aria-busy={busy === `go-${p.pair}` || undefined}
                data-hub="approve-start"
                onClick={() => run(`go-${p.pair}`, () => window.stoke.hub.approveStart(p.pair))}
              >
                <Busy on={busy === `go-${p.pair}`} idle="Show the code" working="Answering…" />
              </button>
              <button className="btn" data-variant="ghost" disabled={busy !== null} onClick={() => run(`no-${p.pair}`, () => window.stoke.hub.refuse(p.pair))}>
                Refuse
              </button>
            </div>
          )}
        </div>
      ))}
      <span className="field-hint">
        Refuse anything you did not start: a request needs your password, and every one shows on every device in the vault.
      </span>
      <Status note={note} />
    </div>
  )
}

function Syncing({ view, now }: { view: HubView; now: number }): React.JSX.Element {
  const { busy, note, run } = useRun()
  const c = view.counts
  const parts = [
    `${c.settings} setting${c.settings === 1 ? '' : 's'}`,
    `${c.keys} API key${c.keys === 1 ? '' : 's'}`,
    `${c.hosts} SSH host${c.hosts === 1 ? '' : 's'}`,
    `${c.sshKeys} SSH key${c.sshKeys === 1 ? '' : 's'}`
  ]
  const scope = (patch: { settings?: boolean; hosts?: boolean; keys?: boolean }): void => run('scope', () => window.stoke.hub.setScope(patch))
  return (
    <div className="field" data-hub="syncing">
      <span className="field-label">What syncs</span>
      <span className="field-hint" data-hub="counts">
        In the vault: {parts.join(', ')}. Last synced {ago(view.lastSyncAt, now)}.
      </span>
      <label className="check-row">
        <input type="checkbox" checked={view.scope.settings} disabled={busy !== null} onChange={(e) => scope({ settings: e.target.checked })} />
        <span>
          <span>Settings</span>
          <span className="field-hint">Theme, fonts, terminal, session defaults, agents and their endpoints, voice, profiles, worklog boards.</span>
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={view.scope.hosts} disabled={busy !== null} onChange={(e) => scope({ hosts: e.target.checked })} />
        <span>
          <span>SSH hosts</span>
          <span className="field-hint">The hosts in Settings › SSH hosts. Whether a key works there stays each computer’s own.</span>
        </span>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={view.accountKeys === true}
          disabled={busy !== null}
          data-hub="account-keys"
          onChange={(e) => run('acct', () => window.stoke.hub.setAccountKeys(e.target.checked))}
        />
        <span>
          <span>API keys, for the whole account</span>
          <span className="field-hint">
            Anthropic, OpenRouter, gateway, endpoint, speech-to-text and MCP keys. Never the phone access key, account keys, the
            hub session, or any agent’s own sign-in. One switch for every device.
          </span>
        </span>
      </label>
      {view.accountKeys === true && (
        <label className="check-row">
          <input type="checkbox" checked={view.scope.keysDevice} disabled={busy !== null} onChange={(e) => scope({ keys: e.target.checked })} />
          <span>
            <span>API keys on this computer</span>
            <span className="field-hint">Off keeps this computer’s keys out of the vault, and the vault’s off this computer.</span>
          </span>
        </label>
      )}
      <div className="btn-row">
        <button
          className="btn"
          disabled={busy !== null || view.busy !== null}
          aria-busy={busy === 'sync' || view.busy === 'Syncing…' || undefined}
          data-hub="sync-now"
          onClick={() => run('sync', () => window.stoke.hub.syncNow(), () => ({ tone: 'success', text: 'Synced.' }))}
        >
          <Busy on={busy === 'sync' || view.busy === 'Syncing…'} idle="Sync now" working="Syncing…" />
        </button>
      </div>
      <Status note={note} />
    </div>
  )
}

/*
 * "Other machines" on THIS computer: the tick that lets the owner's other
 * signed-in devices see and open its sessions (default off), the devices it
 * always lets in, and who is attached now. The tick is `hub.shareSessions`,
 * written by main alone (gotcha 57); grants are this computer's own and never
 * sync, so neither the hub nor another device can give itself one.
 */
function OtherMachinesSettings(): React.JSX.Element {
  const remote = useHubRemote()
  const { busy, note, run } = useRun()
  return (
    <div className="field" data-hub="other-machines-settings">
      <span className="field-label">Other machines</span>
      <label className="check-row">
        <input
          type="checkbox"
          checked={remote.sharing}
          disabled={busy !== null}
          data-hub="share-sessions"
          onChange={(e) => run('share', () => window.stoke.hub.remote.setSharing(e.target.checked))}
        />
        <span>
          <span>Let my other devices see and open my sessions</span>
          <span className="field-hint">
            Your other signed-in computers list this one’s running sessions — a project’s folder name and the session’s title, never a
            path — and can open one as a tab. Each open asks here first: Allow once, Always, or Deny. The list and the session travel
            end to end encrypted between your devices; your hub passes them on and cannot read them.
          </span>
        </span>
      </label>
      {remote.grants.length > 0 && (
        <>
          <span className="field-hint">Always allowed here, without asking:</span>
          {remote.grants.map((g) => (
            <div key={g.device} className="settings-item-card" data-hub="grant" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
              <span style={{ flex: 1 }}>
                <strong>{g.label}</strong> <span className="field-hint">since {new Date(g.at).toLocaleDateString()}{g.mode === 'view' ? ', to watch only' : ''}</span>
              </span>
              <button className="btn" disabled={busy !== null} onClick={() => run(`grant-${g.device}`, () => window.stoke.hub.remote.revokeGrant(g.device))}>
                Take back
              </button>
            </div>
          ))}
        </>
      )}
      {remote.guests.length > 0 && (
        <div className="btn-row">
          <span className="field-hint" style={{ flex: 1 }}>
            Attached now: {remote.guests.map((g) => `${g.label} (${g.title ?? 'a session'})`).join(', ')}.
          </span>
          <button className="btn" onClick={() => void window.stoke.hub.remote.dropGuests()}>
            Disconnect
          </button>
        </div>
      )}
      <Status note={note} />
    </div>
  )
}

function Conflicts({ view }: { view: HubView }): React.JSX.Element {
  return (
    <div className="field" data-hub="conflicts">
      <span className="field-label">Changed in two places</span>
      <ul className="backup-changes">
        {view.notes.map((n, i) => (
          <li key={`${n.path}-${i}`}>
            <span className="backup-change-label">{n.label}</span>
            <span className="backup-change-detail">
              {n.kept === 'mine'
                ? `Your change here (${clock(n.mineEditedAt)}) replaced the one from ${n.otherDevice} (${clock(n.otherEditedAt)}).`
                : `The change from ${n.otherDevice} (${clock(n.otherEditedAt)}) replaced yours here (${clock(n.mineEditedAt)}).`}
            </span>
          </li>
        ))}
      </ul>
      <span className="field-hint">The later change wins on every device; nothing else was lost.</span>
      <div className="btn-row">
        <button className="btn" data-variant="ghost" onClick={() => void window.stoke.hub.dismissNotes()}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

function SshKeys({ view }: { view: HubView }): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const [local, setLocal] = useState<HubLocalKeyView[] | null>(null)
  const { busy, note, run } = useRun()
  useEffect(() => {
    if (!picking) return
    let live = true
    void window.stoke.hub.localKeys().then((k) => {
      if (live) setLocal(k)
    })
    return () => {
      live = false
    }
  }, [picking, view.sshKeys.length])
  return (
    <div className="field" data-hub="ssh-keys">
      <span className="field-label">SSH keys</span>
      <FieldHint
        more="A shared private key travels exactly as it is — a passphrase on it stays on it — sealed in the vault. It is written to another computer only when you press Install there: into ~/.ssh, owner-only, never over a file that is already there, and with an IdentityFile line added for each synced host that uses it. Stoke never deletes a key file; stopping sharing only stops new devices getting it."
      >
        Only the keys you pick. A key on many computers means removing a device later includes taking that key off every server
        it opens — a key per computer is safer.
      </FieldHint>
      {view.sshKeys.length > 0 && (
        <ul className="backup-changes" data-hub="ssh-key-list">
          {view.sshKeys.map((k) => (
            <li key={k.keyId} data-hub="ssh-key" data-key={k.name}>
              <span className="backup-change-label mono">{k.name}</span>
              <span className="backup-change-detail">
                {k.mine ? 'Shared from this computer' : `From ${k.from}`}
                {k.passphrase ? ', passphrase-protected' : ''}
                {k.hosts.length ? `, used by ${k.hosts.join(', ')}` : ''}. <span className="mono">{k.fingerprint}</span>
                <span className="btn-row" style={{ marginTop: 'var(--space-4)' }}>
                  {k.mine ? (
                    <button className="btn" disabled={busy !== null} onClick={() => run(`un-${k.keyId}`, () => window.stoke.hub.unshareKey(k.keyId), () => ({ tone: 'success', text: `${k.name} is no longer shared. Computers that installed it keep their copy.` }))}>
                      Stop sharing
                    </button>
                  ) : k.installedAs ? (
                    <span className="pill" data-tone="success" data-hub="installed">
                      installed as {k.installedAs}
                    </span>
                  ) : (
                    <button
                      className="btn"
                      data-variant="primary"
                      disabled={busy !== null}
                      aria-busy={busy === `in-${k.keyId}` || undefined}
                      data-hub="install-key"
                      onClick={() => run(`in-${k.keyId}`, () => window.stoke.hub.installKey(k.keyId), (r) => ({ tone: 'success', text: r.message }))}
                    >
                      <Busy on={busy === `in-${k.keyId}`} idle="Install on this computer" working="Installing…" />
                    </button>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="btn-row">
        <button className="btn" disabled={busy !== null} data-hub="pick-keys" onClick={() => setPicking((v) => !v)}>
          {picking ? 'Done' : 'Share a key from ~/.ssh…'}
        </button>
      </div>
      {picking && (
        <div className="settings-item-card" data-hub="key-picker" style={{ display: 'flex', flexDirection: 'column' }}>
          {local === null ? (
            <span className="field-hint">Looking in ~/.ssh…</span>
          ) : local.length === 0 ? (
            <span className="field-hint">No key pairs in ~/.ssh (a key is listed by the .pub beside it).</span>
          ) : (
            local.map((k) => (
              <div key={k.name} className="btn-row" data-hub="local-key" data-key={k.name}>
                <span className="mono">{k.name}</span>
                <span className="field-hint">
                  {k.type}
                  {k.comment ? ` · ${k.comment}` : ''}
                </span>
                {k.shared ? (
                  <span className="pill" data-tone="success">
                    shared
                  </span>
                ) : (
                  <button
                    className="btn"
                    disabled={busy !== null}
                    aria-busy={busy === `sh-${k.name}` || undefined}
                    data-hub="share-key"
                    onClick={() => run(`sh-${k.name}`, () => window.stoke.hub.shareKey(k.name), () => ({ tone: 'success', text: `${k.name} is in the vault. Install it on another computer from its own Settings.` }))}
                  >
                    <Busy on={busy === `sh-${k.name}`} idle="Share" working="Sharing…" />
                  </button>
                )}
              </div>
            ))
          )}
          <span className="field-hint">The private key is read only when you press Share. Listing reads the .pub files.</span>
        </div>
      )}
      <Status note={note} />
    </div>
  )
}

function Devices({ view }: { view: HubView }): React.JSX.Element {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [kit, setKit] = useState('')
  const { busy, note, run } = useRun()
  return (
    <div className="field" data-hub="devices">
      <span className="field-label">Devices in the vault</span>
      {view.devices.map((d) => (
        <div key={d.id} className="settings-item-card" data-hub="device" data-device={d.label} style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="btn-row">
            <strong>{d.label}</strong>
            <span className="field-hint">{platformName(d.platform)}</span>
            {d.me ? (
              <span className="pill" data-tone="accent">
                this computer
              </span>
            ) : d.online ? (
              <span className="pill" data-tone="success">
                online
              </span>
            ) : null}
            <span className="field-hint mono" title="The first bytes of its signing key">
              {d.fingerprint}
            </span>
          </span>
          {renaming === d.id ? (
            <span className="btn-row">
              <input className="input" aria-label={`New name for ${d.label}`} value={name} onChange={(e) => setName(e.target.value)} disabled={busy !== null} />
              <button
                className="btn"
                data-variant="primary"
                disabled={busy !== null}
                onClick={() =>
                  run('rename', async () => {
                    const r = await window.stoke.hub.rename(d.id, name)
                    if (r.ok) setRenaming(null)
                    return r
                  })
                }
              >
                <Busy on={busy === 'rename'} idle="Rename" working="Renaming…" />
              </button>
              <button className="btn" data-variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </span>
          ) : removing === d.id && d.kitSeen ? (
            <>
              <span className="field-hint" data-hub="revoke-kit-seen">
                Removing {d.label} changes the vault key and re-seals everything under the new one. Your current Recovery Kit was
                made or typed on {d.label}, so it could open a key sealed for that Kit: removing it makes a new Kit too, shown once
                before anything is sent.
              </span>
              <span className="btn-row">
                <button
                  className="btn"
                  data-variant="danger"
                  disabled={busy !== null}
                  aria-busy={busy === 'revoke-new' || undefined}
                  data-hub="revoke-new-kit"
                  onClick={() =>
                    run('revoke-new', async () => {
                      const r = await window.stoke.hub.revoke(d.id, { newKit: true })
                      if (r.ok) setRemoving(null)
                      return r
                    })
                  }
                >
                  <Busy on={busy === 'revoke-new'} idle={`Remove ${d.label} and make a new Kit`} working="Making it…" />
                </button>
                <button className="btn" data-variant="ghost" onClick={() => setRemoving(null)}>
                  Cancel
                </button>
              </span>
            </>
          ) : removing === d.id ? (
            <>
              <span className="field-hint">
                Removing {d.label} changes the vault key and re-seals everything under the new one, so it cannot read anything
                synced from now on. The hub needs your Recovery Kit to seal the new key for it — or make a new Kit instead.
              </span>
              <input
                className="input mono"
                aria-label="Recovery Kit"
                placeholder="RK1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX"
                spellCheck={false}
                autoComplete="off"
                value={kit}
                disabled={busy !== null}
                data-hub="revoke-kit"
                onChange={(e) => setKit(e.target.value)}
              />
              <span className="btn-row">
                <button
                  className="btn"
                  data-variant="danger"
                  disabled={busy !== null || kit.trim() === ''}
                  aria-busy={busy === 'revoke' || undefined}
                  data-hub="revoke-confirm"
                  onClick={() =>
                    run('revoke', async () => {
                      const r = await window.stoke.hub.revoke(d.id, { kit })
                      if (r.ok) {
                        setRemoving(null)
                        setKit('')
                      }
                      return r
                    })
                  }
                >
                  <Busy on={busy === 'revoke'} idle={`Remove ${d.label}`} working="Removing…" />
                </button>
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    run('revoke-new', async () => {
                      const r = await window.stoke.hub.revoke(d.id, { newKit: true })
                      if (r.ok) setRemoving(null)
                      return r
                    })
                  }
                >
                  Lost it? Remove and make a new Kit
                </button>
                <button className="btn" data-variant="ghost" onClick={() => setRemoving(null)}>
                  Cancel
                </button>
              </span>
            </>
          ) : (
            <span className="btn-row">
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() => {
                  setName(d.label)
                  setRenaming(d.id)
                }}
              >
                Rename
              </button>
              {!d.me && (
                <button className="btn" disabled={busy !== null} data-hub="revoke" onClick={() => setRemoving(d.id)}>
                  Remove…
                </button>
              )}
            </span>
          )}
        </div>
      ))}
      {view.revokeReport && (
        <span className="field-hint" data-tone="warning" data-hub="revoke-report">
          {view.revokeReport.device} is out, and cannot read anything synced from now on. It could read what was in the vault
          before: rotate {view.revokeReport.keys.length ? view.revokeReport.keys.join(', ') : 'no API keys'} at their provider
          {view.revokeReport.sshKeys.length ? `, and take ${view.revokeReport.sshKeys.join(', ')} off the servers it opens` : ''}.
          {view.revokeReport.commands.length
            ? ` It could also have changed what these run, on every computer: check ${view.revokeReport.commands.join('; ')}.`
            : ''}
        </span>
      )}
      <Status note={note} />
    </div>
  )
}

function RecoveryKit({ view }: { view: HubView }): React.JSX.Element {
  const { busy, note, run } = useRun()
  if (view.kitPending) return <></>
  return (
    <div className="field" data-hub="recovery">
      <span className="field-label">Recovery Kit</span>
      <span className="field-hint">
        Make a new one if the old one was typed on a computer you do not trust, or is lost. The vault key changes with it.
      </span>
      <div className="btn-row">
        <button className="btn" disabled={busy !== null} aria-busy={busy === 'kit' || undefined} onClick={() => run('kit', () => window.stoke.hub.newKit())}>
          <Busy on={busy === 'kit'} idle="Make a new Recovery Kit" working="Making it…" />
        </button>
      </div>
      <Status note={note} />
    </div>
  )
}

function SignOut({ view }: { view: HubView }): React.JSX.Element {
  const [sure, setSure] = useState(false)
  const { busy, note, run } = useRun()
  return (
    <div className="field" data-hub="sign-out">
      <span className="field-label">Sign out</span>
      <span className="field-hint">
        Removes this computer’s hub keys, vault keys and session. Settings, API keys and SSH keys that already arrived stay:
        they are this computer’s now.
        {view.phase === 'active' ? ' It stays on the device list until you remove it from another device.' : ''}
      </span>
      <div className="btn-row">
        {sure ? (
          <>
            <button className="btn" data-variant="danger" disabled={busy !== null} aria-busy={busy === 'out' || undefined} data-hub="sign-out-confirm" onClick={() => run('out', () => window.stoke.hub.signOut())}>
              <Busy on={busy === 'out'} idle="Sign out and forget the hub keys" working="Signing out…" />
            </button>
            <button className="btn" data-variant="ghost" disabled={busy !== null} onClick={() => setSure(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn" disabled={busy !== null} data-hub="sign-out-start" onClick={() => setSure(true)}>
            Sign out…
          </button>
        )}
      </div>
      <Status note={note} />
    </div>
  )
}
