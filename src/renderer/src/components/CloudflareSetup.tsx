import { useCallback, useEffect, useState } from 'react'
import type { CloudflareSetup as Setup, CloudflareStepState, StepResult } from '@shared/api'
import { IconCopy } from './Icons'

/**
 * Said once, in the step it is about. `tunnel route` has no way to read a
 * record back — it is a proxied CNAME, so public DNS shows only Cloudflare's
 * own addresses — which is why the step asks the hostname what it answers.
 */
const ROUTE_NOTE =
  'Cloudflare publishes no way to read this record back, so Stoke asks the hostname what it answers instead.'

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
  /*
   * Open once, from the state this step had when it first rendered, and never
   * from `state` again.
   *
   * Deriving `open` from the live state is what made the panel "reset you":
   * every probe rewrote it, so opening the section showed five expanded steps
   * that all slammed shut a second later when the first answer landed, and
   * running a step collapsed it under you at the exact moment its output
   * appeared. Measured: `true,true,true,true,false` immediately after opening
   * the section, `false,false,false,true,false` once the probe returned.
   *
   * The parent renders nothing until the first probe has landed, so this seed
   * is a real answer rather than "unknown". After that the disclosure belongs
   * to whoever clicked it.
   */
  const [open, setOpen] = useState(state !== 'done')
  return (
    <details
      className="settings-item"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
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

  /*
   * Nothing until the first probe lands. Rendering the steps against a null
   * setup would seed every disclosure from "unknown" — which is the state that
   * used to make all five open and then collapse together a second later.
   */
  if (!setup) {
    return (
      <div className="field">
        <span className="field-label">Set it up, step by step</span>
        <span className="field-hint">Checking what is already done…</span>
      </div>
    )
  }
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
        state={setup.install.state}
        detail={setup.install.path ?? 'Not found on this machine.'}
      >
        {setup.install.state === 'done' ? (
          <span className="field-hint">
            Found at <span className="mono">{setup.install.path}</span>.
          </span>
        ) : (
          <>
            <span className="field-hint">
              Stoke cannot install this for you — it is a system package. Run this, then press Check
              again.
            </span>
            <Command text={setup.install.hint} />
          </>
        )}
      </Step>

      <Step
        n={2}
        title="Log in to Cloudflare"
        state={setup.login.state}
        detail={
          setup.login.state === 'done'
            ? 'Signed in on this machine.'
            : 'Needs a browser, once.'
        }
      >
        {setup.login.state === 'done' ? (
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
                disabled={step !== null || setup.install.state !== 'done'}
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
        state={setup.create.state}
        detail={setup.create.detail}
      >
        {setup.create.state === 'done' ? (
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
              {setup.create.state === 'unknown'
                ? 'Cloudflare could not be asked, so this may already exist. Creating a duplicate name fails harmlessly and is treated as done.'
                : `Creates a tunnel named ${name} in your account and writes its credentials here.`}
            </span>
            <div className="btn-row">
              <button
                className="btn"
                data-variant="primary"
                disabled={step !== null || setup.login.state !== 'done'}
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
        state={routeResult ? (routeResult.ok ? 'done' : 'failed') : setup.route.state}
        detail={host ? setup.route.detail : 'Set a public hostname above first.'}
      >
        <span className="field-hint">{ROUTE_NOTE} Running it twice is safe.</span>
        <div className="btn-row">
          <button
            className="btn"
            data-variant="primary"
            disabled={step !== null || !host || setup.create.state === 'todo'}
            onClick={() => void act('route')}
            title={host ? undefined : 'Set a public hostname above first'}
          >
            {step === 'route' ? 'Routing…' : 'Add the DNS record'}
          </button>
          {/*
            Always offered, not only after a failure. A hostname that has ever
            pointed anywhere already has a record, so `route dns` refuses — and
            the result is the tunnel running happily while the name still
            reaches whatever it used to, which is error 1033 on the phone. The
            remedy has to be reachable on the first attempt, because that is
            exactly when it is needed.
          */}
          <button
            className="btn"
            data-variant={
              routeClash || setup.route.verdict === 'tunnel-not-found' ? 'primary' : undefined
            }
            disabled={step !== null || !host}
            onClick={() => void act('route', { overwriteDns: true })}
            title="Repoints an existing record at this tunnel. Anything currently answering on that hostname stops."
          >
            Replace the existing record
          </button>
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
