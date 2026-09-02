import { useCallback, useEffect, useState } from 'react'
import type { CloudflareSetup as Setup, CloudflareStepState, StepResult } from '@shared/api'
import { IconCopy } from './Icons'

/**
 * Setting up a Cloudflare Tunnel, one step at a time.
 *
 * This replaces a box that printed four commands and left you to it. That is
 * fine if you already know what `cloudflared tunnel route dns` does, and it has
 * one specific failure otherwise: it cannot tell you WHICH of the four you are
 * stuck on. Every step here says what it found, runs itself where that is
 * possible, and quotes cloudflared rather than paraphrasing it when it fails.
 *
 * What each step can and cannot detect is not uniform, and pretending otherwise
 * is how a wizard lies. Install and login are local facts (a binary on PATH, a
 * certificate on disk). Whether the tunnel exists is a live API call, so it has
 * a third answer — "could not ask" — because a laptop with no network must not
 * be told its tunnel is missing. And the DNS route cannot be read back at all;
 * see the copy on that step.
 */

interface Props {
  tunnelName: string
  hostname: string
  /** Stoke's own cloudflared child, which the account API cannot tell apart. */
  running: boolean
  /** Runs the named tunnel — the last step, and already owned by the panel. */
  onRun: () => void
  busy: boolean
}

const PILL: Record<CloudflareStepState, { label: string; tone?: 'success' | 'danger' | 'accent' }> = {
  todo: { label: 'to do' },
  done: { label: 'done', tone: 'success' },
  failed: { label: 'failed', tone: 'danger' },
  unknown: { label: 'unknown', tone: 'accent' }
}

/** A command the user may prefer to run themselves, and the button that takes it. */
function Command({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="step-cmd">
      <pre className="mono">{text}</pre>
      <button
        className="btn"
        data-variant="ghost"
        onClick={() => {
          window.stoke.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        }}
      >
        <IconCopy />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function Step({
  n,
  title,
  state,
  detail,
  children
}: {
  n: number
  title: string
  state: CloudflareStepState
  /** The one line that says what was found. Shown in the closed summary too. */
  detail: string
  children?: React.ReactNode
}): React.JSX.Element {
  const pill = PILL[state]
  return (
    /*
     * Open unless it is settled. A native <details> rather than a useState, for
     * FieldHint's reasons: keyboard-operable, announced, and Cmd+F finds text
     * inside a closed one. Uncontrolled, so opening a finished step to re-read
     * it does not fight the component.
     */
    <details className="settings-item" open={state !== 'done' || undefined}>
      <summary className="settings-item-summary">
        <span className="settings-item-name">
          {n} · {title}
        </span>
        <span className="settings-item-sub truncate">{detail}</span>
        <span className="pill" data-tone={pill.tone}>
          {pill.label}
        </span>
      </summary>
      <div className="settings-item-body">{children}</div>
    </details>
  )
}

export function CloudflareSetup({
  tunnelName,
  hostname,
  running,
  onRun,
  busy
}: Props): React.JSX.Element {
  const [setup, setSetup] = useState<Setup | null>(null)
  /** Which step is running, so only that one's button says so. */
  const [step, setStep] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, StepResult>>({})

  const probe = useCallback(async (): Promise<void> => {
    setSetup(await window.stoke.remote.cloudflareSetup())
  }, [])

  useEffect(() => {
    void probe()
    // The name and the hostname decide two of the answers, so re-ask when
    // either moves rather than leaving a stale "no tunnel named X".
  }, [probe, tunnelName, hostname, running])

  const act = async (
    id: 'login' | 'create' | 'route',
    opts?: { overwriteDns?: boolean }
  ): Promise<void> => {
    setStep(id)
    try {
      const res = await window.stoke.remote.cloudflareStep(id, opts)
      setResult((prev) => ({ ...prev, [id]: res }))
      await probe()
    } finally {
      setStep(null)
    }
  }

  const name = tunnelName.trim() || 'stoke'
  const host = hostname.trim()
  const loginResult = result.login
  const createResult = result.create
  const routeResult = result.route
  /*
   * "Already exists" is the one route failure with a specific remedy, and it is
   * the common one: a hostname that has ever been pointed anywhere has a record.
   */
  const routeClash = Boolean(routeResult && !routeResult.ok && /already exists/i.test(routeResult.output))

  const outcome = (res: StepResult | undefined): React.JSX.Element | null =>
    res ? (
      <>
        {res.error && (
          <span className="field-hint" data-tone="danger">
            {res.error}
          </span>
        )}
        {res.output && (
          <details className="field-detail" open={res.ok ? undefined : true}>
            <summary>What cloudflared printed</summary>
            <div className="field-detail-body">
              <pre className="mono step-log">{res.output}</pre>
            </div>
          </details>
        )}
      </>
    ) : null

  return (
    <div className="field">
      <span className="field-label">
        Set it up, step by step{' '}
        <button className="btn" data-variant="ghost" disabled={step !== null} onClick={() => void probe()}>
          Check again
        </button>
      </span>

      <Step
        n={1}
        title="Install cloudflared"
        state={setup?.install.state ?? 'unknown'}
        detail={setup?.install.path ?? 'Not found on this machine.'}
      >
        {setup?.install.state === 'done' ? (
          <span className="field-hint">
            Found at <span className="mono">{setup.install.path}</span>.
          </span>
        ) : (
          <>
            <span className="field-hint">
              Stoke cannot install this for you — it is a system package. Run this, then press Check
              again.
            </span>
            <Command text={setup?.install.hint ?? 'brew install cloudflared'} />
          </>
        )}
      </Step>

      <Step
        n={2}
        title="Log in to Cloudflare"
        state={setup?.login.state ?? 'unknown'}
        detail={
          setup?.login.state === 'done'
            ? 'Signed in on this machine.'
            : 'Needs a browser, once.'
        }
      >
        {setup?.login.state === 'done' ? (
          <span className="field-hint">
            The certificate is at <span className="mono">{setup.login.certPath}</span>. Delete it to
            sign in as somebody else.
          </span>
        ) : (
          <>
            <span className="field-hint">
              Opens Cloudflare in your browser and waits. Pick the domain you want to use — the
              certificate it downloads is what lets the next two steps talk to your account.
            </span>
            <div className="btn-row">
              <button
                className="btn"
                data-variant="primary"
                disabled={step !== null || setup?.install.state !== 'done'}
                onClick={() => void act('login')}
              >
                {step === 'login' ? 'Waiting for your browser…' : 'Log in'}
              </button>
              {loginResult?.url && (
                <span className="field-hint mono truncate">{loginResult.url}</span>
              )}
            </div>
            <Command text="cloudflared tunnel login" />
          </>
        )}
        {outcome(loginResult)}
      </Step>

      <Step
        n={3}
        title="Create the tunnel"
        state={setup?.create.state ?? 'unknown'}
        detail={setup?.create.detail ?? ''}
      >
        {setup?.create.state === 'done' ? (
          <span className="field-hint">
            Tunnel <span className="mono">{name}</span>
            {setup.create.id && (
              <>
                {' '}
                is <span className="mono">{setup.create.id}</span>
              </>
            )}
            . Its credentials are on this machine.
          </span>
        ) : (
          <>
            <span className="field-hint">
              {setup?.create.state === 'unknown'
                ? 'Cloudflare could not be asked, so this may already exist. Creating a duplicate name fails harmlessly and is treated as done.'
                : `Creates a tunnel named ${name} in your account and writes its credentials here.`}
            </span>
            <div className="btn-row">
              <button
                className="btn"
                data-variant="primary"
                disabled={step !== null || setup?.login.state !== 'done'}
                onClick={() => void act('create')}
              >
                {step === 'create' ? 'Creating…' : `Create ${name}`}
              </button>
            </div>
            <Command text={`cloudflared tunnel create ${name}`} />
          </>
        )}
        {outcome(createResult)}
      </Step>

      <Step
        n={4}
        title="Point your hostname at it"
        state={routeResult ? (routeResult.ok ? 'done' : 'failed') : 'unknown'}
        detail={host ? `${host} → ${name}` : 'Set a public hostname above first.'}
      >
        <span className="field-hint">
          {setup?.route.detail ?? ''} Running it twice is safe.
        </span>
        <div className="btn-row">
          <button
            className="btn"
            data-variant="primary"
            disabled={step !== null || !host || setup?.create.state === 'todo'}
            onClick={() => void act('route')}
            title={host ? undefined : 'Set a public hostname above first'}
          >
            {step === 'route' ? 'Routing…' : 'Add the DNS record'}
          </button>
          {routeClash && (
            <button
              className="btn"
              disabled={step !== null}
              onClick={() => void act('route', { overwriteDns: true })}
              title="Repoints an existing record at this tunnel. Anything currently answering on that hostname stops."
            >
              Replace the existing record
            </button>
          )}
        </div>
        <Command text={`cloudflared tunnel route dns ${name} ${host || 'code.example.com'}`} />
        {outcome(routeResult)}
      </Step>

      <Step
        n={5}
        title="Run it"
        state={running ? 'done' : 'todo'}
        detail={running ? 'Stoke is running the tunnel.' : 'Stoke runs this for you.'}
      >
        <span className="field-hint">
          Stoke supervises <span className="mono">cloudflared tunnel run</span> itself, so there is
          nothing to leave open in a terminal. Tick the box below to start it with phone access.
        </span>
        {!running && (
          <div className="btn-row">
            <button className="btn" data-variant="primary" disabled={busy || !host} onClick={onRun}>
              Run the tunnel
            </button>
          </div>
        )}
      </Step>
    </div>
  )
}
