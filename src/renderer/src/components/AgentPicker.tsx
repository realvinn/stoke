import { useEffect, useMemo, useRef, useState } from 'react'
import { CODING_CLIS, type CodingCliDetection, type CodingCliId } from '@shared/codingClis'
import { installSteps } from '@shared/agents'

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

  const firstButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    firstButton.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const all = CODING_CLIS.map((c) => c.id)
  const allPicked = all.every((id) => picked.has(id))
  const nonePicked = all.every((id) => !picked.has(id))
  const toInstall = detection ? [...picked].filter((id) => !installed.has(id)) : []
  const steps = installSteps(toInstall, platform)
  const unscripted = toInstall.filter((id) => !steps.some((s) => s.id === id))

  const toggle = (id: CodingCliId): void =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAll = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = !allPicked && !nonePicked
  }, [allPicked, nonePicked])

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="agent-picker" role="dialog" aria-modal="true" aria-labelledby="agent-picker-title">
        <header className="agent-picker-head">
          <h2 id="agent-picker-title">Which coding agents do you use?</h2>
          <p>
            Each one runs in its own terminal tab, in whatever folder you pick. Tick the ones you use
            and any you want to try — Stoke installs the missing ones in a tab you can watch.
          </p>
          {detection?.probeFailed && (
            <p className="field-hint" data-tone="warning">
              Stoke could not read your shell’s PATH, so an agent you have may show as not installed.
              Nothing is ticked for installing until you tick it.
            </p>
          )}
          <label className="agent-picker-all">
            <input
              ref={selectAll}
              type="checkbox"
              checked={allPicked}
              onChange={() => setPicked(allPicked ? new Set() : new Set(all))}
            />
            <span>Select all</span>
          </label>
        </header>

        <div className="agent-picker-list" role="group" aria-label="Coding agents">
          {CODING_CLIS.map((c) => {
            const on = picked.has(c.id)
            const have = installed.has(c.id)
            const step = steps.find((s) => s.id === c.id)
            const state =
              detection === null
                ? 'checking…'
                : have
                  ? 'installed'
                  : on
                    ? step
                      ? 'will install'
                      : 'install by hand'
                    : 'not installed'
            return (
              <label className="agent-row" key={c.id} data-checked={on || undefined}>
                <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
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
                  {on && !have && detection && (
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
          })}
        </div>

        <footer className="agent-picker-foot">
          <span className="agent-picker-count">
            {picked.size} selected
            {steps.length > 0 && ` · ${steps.length} to install`}
            {unscripted.length > 0 && ` · ${unscripted.length} by hand`}
          </span>
          <button ref={firstButton} className="btn" data-variant="ghost" onClick={onClose}>
            Not now
          </button>
          <button
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
