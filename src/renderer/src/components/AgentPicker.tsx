import { useEffect, useMemo, useRef, useState } from 'react'
import { CODING_CLIS, type CodingCliDetection, type CodingCliId } from '@shared/codingClis'
import { installSteps } from '@shared/agents'
import { isActivationKey, pickerSections, selectAllInstalled } from '@shared/launcher'
import { activationAllowed, pressClock } from '../lib/pressBurst'

/*
 * "Which coding agents do you use?" — asked once, and again whenever the user
 * opens it from Settings or the launcher.
 *
 * One list, not two. Every agent Stoke knows is a row; a checked row that is
 * installed is one you use, and a checked row that is NOT installed is one you
 * want, which Stoke installs when you continue. The install command is printed
 * on the row the moment it is checked, because what someone reads before
 * pressing the button should be exactly what runs (agents.ts).
 *
 * Detected agents start checked on a first run, so pressing Continue without
 * touching anything is the honest default: "the ones I have". A reopened picker
 * starts from what was chosen last time instead.
 *
 * When the login shell's PATH could not be read (gotcha 52), "not installed"
 * may mean "Stoke cannot see it", so the rows say that, and nothing is
 * pre-checked for installing: offering to reinstall something the user has is
 * the failure this distinction exists to avoid.
 */
export function AgentPicker({
  detection,
  chosen,
  platform,
  onDone,
  onClose
}: {
  detection: CodingCliDetection | null
  /** The last saved choice, or null on a first run. */
  chosen: CodingCliId[] | null
  platform: string
  onDone: (chosen: CodingCliId[], install: CodingCliId[]) => void
  onClose: () => void
}): React.JSX.Element {
  const installed = useMemo(
    () => new Set(detection?.clis.filter((c) => c.path).map((c) => c.id) ?? []),
    [detection]
  )
  const pathOf = (id: CodingCliId): string | null => detection?.clis.find((c) => c.id === id)?.path ?? null
  const conflictOf = (id: CodingCliId): string | null =>
    detection?.clis.find((c) => c.id === id)?.conflict ?? null

  const [picked, setPicked] = useState<Set<CodingCliId>>(() => new Set(chosen ?? []))
  const seeded = useRef(chosen !== null)
  // A first run seeds from detection once it lands, and only once: after that
  // the user's own clicks are the state.
  useEffect(() => {
    if (seeded.current || !detection) return
    seeded.current = true
    setPicked(new Set(installed))
  }, [detection, installed])

  /*
   * Focus goes to Continue, the primary, as soon as it can take it (it is
   * disabled until detection answers) — it opened on "Not now", so the
   * keyboard default was the secondary action (QA L20). Until then the dialog
   * itself holds focus, so it is already inside the trap below.
   */
  const dialogRef = useRef<HTMLDivElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  const focusedContinue = useRef(false)
  useEffect(() => {
    if (focusedContinue.current) return
    if (detection && continueRef.current && !continueRef.current.disabled) {
      focusedContinue.current = true
      continueRef.current.focus()
    } else {
      dialogRef.current?.focus()
    }
  }, [detection])

  /*
   * Armed when it opens (gotcha 88). Continue takes focus at once, and on a
   * first run this opens in the middle of the Enters someone is pressing to
   * get past the splash: the QA's fresh Enter every 40ms answered it before it
   * had painted (agents.chosen saved, the picker never seen), and the next
   * Enter started `claude` behind it. An Enter or Space now presses nothing
   * here unless its burst began after this opened — stop, then press, and it
   * counts. A held key's repeats are part of the burst, so they never do.
   */
  const armedAt = useRef(pressClock())

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isActivationKey(e.key) && (e.repeat || !activationAllowed(armedAt.current))) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // Opened from Settings, the sheet's own Escape handler is underneath;
        // one Escape closes one dialog.
        e.stopPropagation()
        onClose()
        return
      }
      /*
       * A focus trap (QA L7): Tab from Continue walked out of this
       * `aria-modal` dialog onto "Toggle sidebar" in the title bar behind it.
       * The shell is `inert` while the picker is up as well (App), so this
       * wrap is what keeps Tab cycling inside rather than falling to <body>.
       */
      if (e.key === 'Tab') {
        const root = dialogRef.current
        if (!root) return
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), summary, a[href], [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null)
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const at = document.activeElement
        if (e.shiftKey && (at === first || !root.contains(at))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (at === last || !root.contains(at))) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const all = CODING_CLIS.map((c) => c.id)
  /*
   * Installed first, the rest folded (QA L20). Claude Code is locked on when it
   * is installed: it is what Stoke is built around, and unticking it hid
   * nothing but made the launcher's own primary look optional. When it is NOT
   * installed its row stays tickable, so the picker can still install it.
   */
  const sections = pickerSections(all, detection ? installed : null)
  const locked = useMemo(
    () => new Set<CodingCliId>(installed.has('claude') ? ['claude'] : []),
    [installed]
  )
  useEffect(() => {
    if (!locked.size) return
    setPicked((cur) => (cur.has('claude') ? cur : new Set(cur).add('claude')))
  }, [locked])
  const selectAllState = selectAllInstalled(picked, sections.installed, locked)
  /*
   * "More agents" is folded unless something in it is already ticked (a
   * reopened picker with a saved choice). Its own state, not derived from
   * `picked` on every render: derived, unticking the last one in it removed
   * the `open` attribute and folded the list under the pointer.
   */
  const [moreOpen, setMoreOpen] = useState(() => (chosen ?? []).some((id) => !installed.has(id)))
  /*
   * With the PATH unreadable, a saved agent that detection cannot see may well
   * be installed — so a reopened picker keeps it chosen but does not put it on
   * the install list unless the user ticks it again (found by review: the
   * first-run rule "nothing is ticked for installing" did not reach a reopen).
   */
  const [unconfirmed, setUnconfirmed] = useState<Set<CodingCliId>>(new Set())
  const unconfirmedSeeded = useRef(false)
  useEffect(() => {
    if (unconfirmedSeeded.current || !detection || chosen === null) return
    unconfirmedSeeded.current = true
    if (detection.probeFailed) setUnconfirmed(new Set(chosen.filter((id) => !installed.has(id))))
  }, [detection, chosen, installed])
  const toInstall = detection ? [...picked].filter((id) => !installed.has(id) && !unconfirmed.has(id)) : []
  const steps = installSteps(toInstall, platform)
  const unscripted = toInstall.filter((id) => !steps.some((s) => s.id === id))

  const toggle = (id: CodingCliId): void => {
    // A tick by hand is a decision; it is no longer "unconfirmed".
    setUnconfirmed((cur) => {
      if (!cur.has(id)) return cur
      const next = new Set(cur)
      next.delete(id)
      return next
    })
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectAllState.mixed
  }, [selectAllState.mixed])

  const row = (id: CodingCliId): React.JSX.Element => {
    const c = CODING_CLIS.find((x) => x.id === id)!

    const on = picked.has(c.id)
    const have = installed.has(c.id)
    const step = steps.find((s) => s.id === c.id)
    const state =
      detection === null
        ? 'checking…'
        : have
          ? 'installed'
          : on && unconfirmed.has(c.id)
            ? 'not seen — untick and tick to install'
            : on
            ? step
              ? 'will install'
              : 'install by hand'
            : 'not installed'
    return (
      <label className="agent-row" key={c.id} data-checked={on || undefined}>
        <input
          type="checkbox"
          checked={on}
          disabled={locked.has(c.id)}
          title={locked.has(c.id) ? 'Always on: Stoke is built around Claude Code' : undefined}
          onChange={() => toggle(c.id)}
        />
        <span className="agent-row-body">
          <span className="agent-row-title">
            <b>{c.label}</b>
            <span className="agent-row-vendor">{c.vendor}</span>
            <span
              className="pill"
              data-tone={have ? 'success' : on && step ? 'accent' : undefined}
              title={have ? (pathOf(c.id) ?? undefined) : undefined}
            >
              {state}
            </span>
          </span>
          <span className="agent-row-blurb">{c.blurb}</span>
          {!have && conflictOf(c.id) && (
            <span className="agent-row-cmd">
              A different program named {c.bins.posix[0]} is at{' '}
              <code className="mono">{conflictOf(c.id)}</code>; this is not it.
            </span>
          )}
          {on && !have && detection && !unconfirmed.has(c.id) && (
            <span className="agent-row-cmd">
              {step ? (
                <>
                  <code className="mono">{step.command}</code>
                  {step.needs && <span> · needs {step.needs}</span>}
                  {step.note && <span> · {step.note}</span>}
                </>
              ) : (
                <span>
                  No install command Stoke will run on this platform — see{' '}
                  <a
                    href={c.home}
                    onClick={(e) => {
                      e.preventDefault()
                      window.stoke.openExternal(c.home)
                    }}
                  >
                    {c.home}
                  </a>
                </span>
              )}
            </span>
          )}
        </span>
      </label>
    )
  }

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        className="agent-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-picker-title"
        tabIndex={-1}
      >
        <header className="agent-picker-head">
          <h2 id="agent-picker-title">Which coding agents do you use?</h2>
          <p>
            Each runs in its own terminal tab. Tick the ones you use; an agent you tick that is not
            installed is installed in a tab you can watch, with its command shown first.
          </p>
          {detection?.probeFailed && (
            <p className="field-hint" data-tone="warning">
              Stoke could not read your shell’s PATH, so an agent you have may show as not installed.
              Nothing is ticked for installing until you tick it.
            </p>
          )}
          {sections.installed.length > 1 && (
            <label className="agent-picker-all">
              <input
                ref={selectAll}
                type="checkbox"
                checked={selectAllState.checked}
                onChange={() => setPicked(selectAllState.toggle())}
              />
              <span>Select all installed</span>
            </label>
          )}
        </header>

        <div className="agent-picker-list" role="group" aria-label="Coding agents">
          {detection && sections.installed.length > 0 && (
            <div className="agent-picker-section">
              On this {platform === 'darwin' ? 'Mac' : 'computer'} ({sections.installed.length})
            </div>
          )}
          {sections.installed.map(row)}
          {detection && sections.installed.length > 0 ? (
            <details
              className="agent-more"
              open={moreOpen}
              onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="agent-picker-section">More agents ({sections.more.length})</summary>
              {sections.more.map(row)}
            </details>
          ) : (
            sections.more.map(row)
          )}
        </div>

        <footer className="agent-picker-foot">
          <span className="agent-picker-count">
            {picked.size} selected
            {steps.length > 0 && ` · ${steps.length} to install`}
            {unscripted.length > 0 && ` · ${unscripted.length} by hand`}
          </span>
          <button className="btn" data-variant="ghost" onClick={onClose}>
            Not now
          </button>
          <button
            ref={continueRef}
            className="btn"
            data-variant="primary"
            disabled={detection === null}
            onClick={() => onDone(
              all.filter((id) => picked.has(id)),
              steps.map((s) => s.id)
            )}
          >
            {steps.length ? `Install ${steps.length} and continue` : 'Continue'}
          </button>
        </footer>
      </div>
    </>
  )
}
