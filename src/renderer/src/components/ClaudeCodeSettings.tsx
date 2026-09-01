import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeConfigState, ClaudeConfigWriteResult } from '@shared/api'
import {
  CLAUDE_SETTINGS,
  WORKFLOW_SIZES,
  WORKFLOW_SIZE_DEFAULT,
  type ClaudeSettingSpec,
  type ClaudeSettingValue
} from '@shared/claudeConfig'

/**
 * The Claude Code version whose settings schema these controls were transcribed
 * from. Shown, not enforced: the CLI updates itself, so a hard version gate
 * would disable this panel within days of the next release. Naming the version
 * lets a reader judge a control that behaves oddly; disabling everything on a
 * version bump would just be a panel that is usually off.
 */
const SCHEMA_VERSION = '2.1.237'

/**
 * contextBridge freezes `window.stoke`, so this cannot be stubbed and must not
 * be assumed. ProfilesSettings reads its bridge the same defensive way.
 */
interface ConfigBridge {
  read(): Promise<ClaudeConfigState>
  set(key: string, value: ClaudeSettingValue): Promise<ClaudeConfigWriteResult>
  setWorkflowSize(value: string | undefined): Promise<ClaudeConfigWriteResult>
}

const bridge: ConfigBridge | null =
  (window.stoke as unknown as { claudeConfig?: ConfigBridge }).claudeConfig ?? null

/** `''` is the unset row. A real value is never the empty string in this schema. */
const UNSET = ''

interface Props {
  /** The CLI version Stoke found, so a schema mismatch can be named. */
  cliVersion: string | null
}

/**
 * Claude Code's own settings, edited from Stoke.
 *
 * Every control here is **tri-state** — on, off, or unset — and that is the
 * whole design rather than a detail. Absent is a distinct state in this schema,
 * not a synonym for false: `remoteControlAtStartup` unset means "let the
 * server-side rollout decide", which is precisely how Remote Control came to be
 * switched on without anyone choosing it. A two-state checkbox could not have
 * shown that, and could not have got back to it.
 */
export function ClaudeCodeSettings({ cliVersion }: Props): React.JSX.Element {
  /*
   * The bare version number, not what `claude --version` prints.
   *
   * That command's stdout is `2.1.237 (Claude Code)`, and this compared the
   * whole string against `SCHEMA_VERSION` ('2.1.237') — so the mismatch warning
   * rendered on every launch, quoting the same version on both sides of its own
   * sentence, and would have gone on saying exactly that when a real mismatch
   * finally arrived. A warning that is always on is a warning nobody reads.
   *
   * `updates.ts` already extracts this with the same expression, but it imports
   * `node:child_process` and so cannot be reached from the renderer (gotcha 27
   * is the neighbouring version of this split).
   */
  const installedVersion = cliVersion ? (/(\d+\.\d+\.\d+)/.exec(cliVersion)?.[1] ?? null) : null
  const [state, setState] = useState<ClaudeConfigState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /** A write that landed, but not quietly. See `apply`. */
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge) return
    setState(await bridge.read())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const apply = useCallback(
    async (key: string, run: () => Promise<ClaudeConfigWriteResult>): Promise<void> => {
      setBusy(key)
      setFailure(null)
      setNote(null)
      try {
        const result = await run()
        setState(result.state)
        if (!result.ok) setFailure(result.error)
        /*
         * A write that succeeded but could not take the CLI's lock is worth a
         * line. It is not a failure — the value was written, read back and
         * confirmed — but it went in on the path gotcha 38 exists to describe,
         * and the honest thing is to say so rather than let "Written" stand for
         * two materially different events.
         */
        else if (result.wroteUnlocked) {
          setNote(
            'Written, but Claude Code held the lock on ~/.claude.json, so Stoke wrote without it. The value was read back and confirmed.'
          )
        } else if ((result.attempts ?? 1) > 1) {
          setNote(
            `Written on attempt ${result.attempts} — a running session rewrote the file underneath the first one.`
          )
        } else {
          setNote(null)
        }
      } finally {
        setBusy(null)
      }
    },
    []
  )

  if (!bridge) return <></>

  const values = state?.values ?? {}

  /** The current value as a select value: `''` when the key is absent. */
  const asOption = (spec: ClaudeSettingSpec): string => {
    const v = values[spec.key]
    return v === undefined ? UNSET : String(v)
  }

  const setFromOption = (spec: ClaudeSettingSpec, raw: string): void => {
    const value: ClaudeSettingValue =
      raw === UNSET ? undefined : spec.kind === 'boolean' ? raw === 'true' : raw
    void apply(spec.key, () => bridge.set(spec.key, value))
  }

  return (
    <div className="field">
      <span className="field-label">Claude Code settings</span>
      <span className="field-hint">
        these are the CLI&rsquo;s own settings, not Stoke&rsquo;s — written to{' '}
        <span className="mono">{state?.settingsPath ?? '~/.claude/settings.json'}</span>. a
        running session picks them up without a restart.
      </span>

      {state?.error && (
        <span className="field-hint" data-tone="danger">
          {state.error}
        </span>
      )}
      {failure && (
        <span className="field-hint" data-tone="danger">
          {failure}
        </span>
      )}
      {note && (
        <span className="field-hint" data-tone="warning">
          {note}
        </span>
      )}

      {/*
       * These rows were behind a collapsed <details> until the sheet grew tabs.
       * The reason given for the collapse was real at the time and is not any
       * more: the sheet was then one flat column, so fifteen always-open rows
       * pushed every later control off the bottom. This is now the whole of the
       * `claude` pane — nothing is below it to push — so the toggle only stood
       * between someone who had already chosen this section and the thing they
       * chose it for. The pane scrolls, which is the answer to length that
       * every other section here gets.
       *
       * The count it stated ("show 15 settings") went with it, and is no loss:
       * it existed to say what was hidden, and was fragile in its own right —
       * `CLAUDE_SETTINGS.length + 1` had to be hand-corrected once already for
       * the dynamic-workflow row, which `WorkflowSizeRow` draws separately
       * because it writes ~/.claude.json rather than settings.json (gotcha 39).
       * Rows you can see need no census.
       */}
      {!state && <span className="field-hint">reading…</span>}

      <div className="cc-rows">
        <WorkflowSizeRow
          state={state}
          busy={busy === '__workflow'}
          onChange={(value) => void apply('__workflow', () => bridge.setWorkflowSize(value))}
        />

        {CLAUDE_SETTINGS.map((spec) =>
          spec.kind === 'integer' ? (
            <IntegerRow
              key={spec.key}
              spec={spec}
              value={typeof values[spec.key] === 'number' ? (values[spec.key] as number) : null}
              busy={busy === spec.key}
              onCommit={(value) => void apply(spec.key, () => bridge.set(spec.key, value))}
            />
          ) : (
            <div className="cc-row" key={spec.key}>
              <span className="cc-text">
                <span className="field-label">{spec.label}</span>
                {/*
                 * What "default" means belongs here, not in the option text.
                 * A <select> cannot ellipsis its own closed value, so
                 * "default — let Claude Code decide" rendered as
                 * "default — let Claude C" and the sentence was lost at
                 * exactly the moment it mattered. Measured in the running
                 * app, not guessed.
                 */}
                <span className="field-hint">
                  {spec.hint} <span className="cc-default">default: {spec.unsetMeans}</span>
                </span>
              </span>
              <select
                className="select"
                aria-label={spec.label}
                disabled={busy === spec.key || !state}
                value={asOption(spec)}
                onChange={(e) => setFromOption(spec, e.target.value)}
              >
                <option value={UNSET}>default</option>
                {spec.kind === 'boolean' ? (
                  <>
                    <option value="true">on</option>
                    <option value="false">off</option>
                  </>
                ) : (
                  spec.options?.map((o) => (
                    <option value={o} key={o}>
                      {o}
                    </option>
                  ))
                )}
              </select>
            </div>
          )
        )}
      </div>

      {state && state.untouched.length > 0 && (
        <span className="field-hint">
          {/*
           * Named rather than hidden. This file has a life beyond the rows
           * above, and an empty-looking panel would read as an empty file —
           * which matters most to the person about to hand-edit it.
           */}
          {state.untouched.length} other key{state.untouched.length === 1 ? '' : 's'} in this file
          are left exactly as they are: <span className="mono">{state.untouched.join(', ')}</span>
        </span>
      )}

      {installedVersion && installedVersion !== SCHEMA_VERSION && (
        <span className="field-hint" data-tone="warning">
          these controls were written against Claude Code {SCHEMA_VERSION}; yours is{' '}
          {installedVersion}.
          the schema can move between versions, and an unrecognised value is dropped silently
          rather than refused.
        </span>
      )}
    </div>
  )
}

/**
 * The dynamic-workflow size guideline.
 *
 * Apart from the rest because it is not in the same file. It is dual-homed — a
 * valid settings.json key *and* a ~/.claude.json key — and the two are not
 * equivalent: `/config` writes the global config, and any value in settings.json
 * hides the `/config` row entirely. Stoke writes the global config so the CLI
 * keeps its own control, and pays for that with a lock protocol and a
 * verify-after-write, which is why this one is visibly slower than its
 * neighbours.
 */
function WorkflowSizeRow({
  state,
  busy,
  onChange
}: {
  state: ClaudeConfigState | null
  busy: boolean
  onChange: (value: string | undefined) => void
}): React.JSX.Element {
  const shadowed = state?.workflowSizeShadowed ?? false
  const current = state?.workflowSize ?? UNSET

  return (
    <div className="cc-row">
      <span className="cc-text">
        <span className="field-label">Dynamic workflow size</span>
        <span className="field-hint">
          how many subagents a workflow Claude writes should aim for &mdash; small aims under 5,
          medium under 15, large under 50. written to <span className="mono">~/.claude.json</span>,
          the same place <span className="mono">/config</span> writes it, so that row keeps working.{' '}
          <span className="cc-default">default: {WORKFLOW_SIZE_DEFAULT}</span>
        </span>
        {shadowed && (
          <span className="field-hint" data-tone="warning">
            your settings.json also sets this, and that value wins — and hides the /config row.
            clear it there for this control to have any effect.
          </span>
        )}
        {busy && <span className="field-hint">saving, then checking it survived&hellip;</span>}
      </span>
      <select
        className="select"
        aria-label="Dynamic workflow size"
        disabled={busy || !state || shadowed}
        value={current}
        onChange={(e) => onChange(e.target.value === UNSET ? undefined : e.target.value)}
      >
        <option value={UNSET}>default</option>
        {WORKFLOW_SIZES.map((size) => (
          <option value={size} key={size}>
            {size}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * A number box, committed on blur or Enter.
 *
 * The flush-on-unmount ref is not belt-and-braces: Escape closes the whole
 * sheet by unmounting this input, and React delivers no blur to a node that is
 * being unmounted — so without it a typed value is simply lost, silently, on
 * the most natural way to leave the panel.
 */
function IntegerRow({
  spec,
  value,
  busy,
  onCommit
}: {
  spec: ClaudeSettingSpec
  value: number | null
  busy: boolean
  onCommit: (value: number | undefined) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value))
  const [bad, setBad] = useState<string | null>(null)

  // Re-seed when the file changes underneath us, but never while typing.
  const settled = useRef(true)
  useEffect(() => {
    if (settled.current) setDraft(value === null ? '' : String(value))
  }, [value])

  const commit = useCallback(
    (text: string): void => {
      settled.current = true
      const trimmed = text.trim()
      if (!trimmed) {
        setBad(null)
        onCommit(undefined)
        return
      }
      const n = Number(trimmed)
      const min = spec.min ?? 1
      if (!Number.isInteger(n) || n < min) {
        setBad(`must be a whole number, ${min} or more`)
        return
      }
      setBad(null)
      onCommit(n)
    },
    [onCommit, spec.min]
  )

  const latest = useRef({ draft, commit, value })
  latest.current = { draft, commit, value }
  useEffect(
    () => () => {
      const { draft: d, commit: c, value: v } = latest.current
      if (d.trim() !== (v === null ? '' : String(v))) c(d)
    },
    []
  )

  return (
    <div className="cc-row">
      <span className="cc-text">
        <span className="field-label">{spec.label}</span>
        <span className="field-hint">{spec.hint}</span>
        {bad && (
          <span className="field-hint" data-tone="danger">
            {bad}
          </span>
        )}
      </span>
      <input
        className="input cc-number"
        type="text"
        inputMode="numeric"
        aria-label={spec.label}
        disabled={busy}
        placeholder={spec.unsetMeans}
        value={draft}
        onChange={(e) => {
          settled.current = false
          setDraft(e.target.value)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
        }}
      />
    </div>
  )
}
