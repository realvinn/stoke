import { useEffect, useRef, useState } from 'react'
import {
  NO_STALL,
  newStall,
  sameStallView,
  stallExit,
  stallInput,
  stallKeepWaiting,
  stallOutput,
  stallPingAnswered,
  stallPingSent,
  stallProbeSent,
  stallText,
  stallVerdict,
  type StallState,
  type StallView
} from '@shared/terminalStall'
import type { Tab } from '../types'
import { Spinner } from './Spinner'

/*
 * The grey scrim over a tab terminal that has not answered (the owner,
 * 2026-10-27: "just have like a gray screen with a like a spinner … so we know
 * that it isn't stoke that's frozen, it's the actual terminal itself").
 *
 * Which scrim, and when, is shared/terminalStall.ts's alone; this file is the
 * clock, the two effects it asks for (a ping to main, a colour-scheme probe to
 * the program) and the card. Tab terminals only: the quick terminal is a local
 * login shell that prints its prompt at once and echoes from the kernel, and a
 * hub remote tab (RemoteTerminal) already says its link's own states.
 *
 * Never takes the keyboard: the scrim lets the pointer through, every button
 * keeps focus where it was on press (`keep`), so keys go on reaching the pty
 * — a program that was only slow answers them, and the scrim goes the moment it
 * does.
 */

export interface TerminalStall {
  view: StallView
  /** A Force restart is running. */
  restarting: boolean
  /** A new pty is attached: start over. Call before its history replays. */
  start(): void
  /** The pty is detached (unmount, or a new one coming). */
  stop(): void
  output(data: string): void
  /** What `onData` sent: only typed keys count (`isTypedInput`). */
  input(data: string): void
  exit(): void
  keepWaiting(): void
  /** Run a restart once; a press while one runs does nothing (gotchas 20, 51). */
  forceRestart(run: () => Promise<unknown>): void
}

/**
 * The imperative half: one per pane, its methods stable for the life of the
 * pane, so the pty effect (bound once per ptyId) can call them from its sinks.
 * Fields assigned in the constructor, never parameter properties.
 */
class StallWatch {
  state: StallState
  live: boolean
  shown: StallView
  timer: number | undefined
  timerAt: number | null
  restarting: boolean
  setView: (v: StallView) => void
  setRestarting: (v: boolean) => void
  probe: () => void

  constructor(setView: (v: StallView) => void, setRestarting: (v: boolean) => void, probe: () => void) {
    this.state = newStall(Date.now())
    this.live = false
    this.shown = NO_STALL
    this.timer = undefined
    this.timerAt = null
    this.restarting = false
    this.setView = setView
    this.setRestarting = setRestarting
    this.probe = probe
  }

  start(): void {
    // The ping counter carries over, so an answer for the last pty's ping can never match this one's.
    this.state = { ...newStall(Date.now()), pingSeq: this.state.pingSeq }
    this.live = true
    this.clearTimer()
    this.evaluate()
  }

  stop(): void {
    this.live = false
    this.clearTimer()
    this.show(NO_STALL)
  }

  output(data: string): void {
    this.state = stallOutput(this.state, data, Date.now())
    // Only a scrim on show needs taking down now; a timer still pending finds nothing to do.
    if (this.shown.kind !== 'none') this.evaluate()
  }

  input(data: string): void {
    const before = this.state
    this.state = stallInput(before, data, Date.now())
    if (this.state !== before) this.evaluate()
  }

  exit(): void {
    this.state = stallExit(this.state)
    this.evaluate()
  }

  keepWaiting(): void {
    this.state = stallKeepWaiting(this.state)
    this.evaluate()
  }

  forceRestart(run: () => Promise<unknown>): void {
    // Claimed before anything is called, never after an await (gotcha 20).
    if (this.restarting) return
    this.restarting = true
    this.setRestarting(true)
    void Promise.resolve()
      .then(run)
      .catch(() => {})
      .finally(() => {
        this.restarting = false
        this.setRestarting(false)
      })
  }

  private evaluate(): void {
    if (!this.live) return
    const now = Date.now()
    let v = stallVerdict(this.state, now)
    if (v.act === 'ping') {
      this.ping(now)
      v = stallVerdict(this.state, now)
    } else if (v.act === 'probe') {
      this.probe()
      this.state = stallProbeSent(this.state, now)
      v = stallVerdict(this.state, now)
    }
    this.show(v.view)
    this.schedule(v.nextAt)
  }

  private ping(now: number): void {
    const sent = stallPingSent(this.state, now)
    this.state = sent.state
    // Any answer — a rejection too — means main's loop ran to give it.
    const answered = (): void => {
      this.state = stallPingAnswered(this.state, sent.seq, Date.now())
      this.evaluate()
    }
    window.stoke.pty.ping().then(answered, answered)
  }

  private show(view: StallView): void {
    if (sameStallView(this.shown, view)) return
    this.shown = view
    this.setView(view)
  }

  /** One timer, at the earliest time anything is due; a later one waits its turn. */
  private schedule(at: number | null): void {
    if (at === null) return
    if (this.timer !== undefined && this.timerAt !== null && this.timerAt <= at) return
    this.clearTimer()
    this.timerAt = at
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      this.timerAt = null
      this.evaluate()
    }, Math.max(0, at - Date.now()))
  }

  private clearTimer(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = null
  }
}

/**
 * The stall watch for one pane. `probe` writes the colour-scheme report to the
 * pty (`schemeProbe`); it is read at the moment of use, so it may close over
 * this render's values.
 */
export function useTerminalStall(probe: () => void): TerminalStall {
  const [view, setView] = useState<StallView>(NO_STALL)
  const [restarting, setRestarting] = useState(false)
  const probeRef = useRef(probe)
  probeRef.current = probe
  const [watch] = useState(() => new StallWatch(setView, setRestarting, () => probeRef.current()))
  useEffect(() => () => watch.stop(), [watch])
  return {
    view,
    restarting,
    start: () => watch.start(),
    stop: () => watch.stop(),
    output: (data) => watch.output(data),
    input: (data) => watch.input(data),
    exit: () => watch.exit(),
    keepWaiting: () => watch.keepWaiting(),
    forceRestart: (run) => watch.forceRestart(run)
  }
}

/** A press that leaves focus where it was: the terminal keeps the keyboard. */
const keep = (e: React.MouseEvent): void => e.preventDefault()

interface OverlayProps {
  stall: TerminalStall
  tab: Tab
  /** The SSH host's label for a tab that runs on another machine, else null. */
  hostLabel: string | null
  /** Kill the tab's process tree and bring it back (App's `forceRestartTab`). */
  onForceRestart?: (tab: Tab) => Promise<boolean>
}

export function TerminalStallOverlay({ stall, tab, hostLabel, onForceRestart }: OverlayProps): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false)
  const { view, restarting } = stall
  // The question goes with the scrim, and with the process it was about.
  useEffect(() => {
    if (view.kind === 'none' || view.kind === 'stoke-busy') setConfirming(false)
  }, [view.kind])
  useEffect(() => setConfirming(false), [tab.ptyId])

  if (view.kind === 'none' && !restarting) return null
  const text = stallText(view, tab, hostLabel)
  const canRestart = text.canRestart && !!onForceRestart

  const restart = (): void => {
    setConfirming(false)
    if (onForceRestart) stall.forceRestart(() => onForceRestart(tab))
  }

  return (
    <div
      className="term-stall"
      data-stall={restarting ? 'restarting' : view.kind}
      data-slow={view.kind === 'starting' && view.slow ? 'true' : undefined}
      role="status"
      aria-live="polite"
      aria-busy={restarting || undefined}
    >
      <div
        className="term-stall-card"
        // A press on the card's text or padding would otherwise drop focus to the page body, and keys would stop reaching the pty.
        onMouseDown={keep}
        onKeyDown={(e) => {
          /*
           * A focused button takes its own Enter and Space. Left to bubble, App's
           * unclaimed-key route would type them into the terminal instead
           * (`typeThroughKey`, gotcha 145's note). Escape backs out of the question.
           */
          if (e.key === 'Escape' && confirming) {
            e.stopPropagation()
            setConfirming(false)
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation()
          }
        }}
      >
        <Spinner />
        <p className="term-stall-title">{restarting ? text.restarting : text.title}</p>
        {!restarting && text.detail && <p className="term-stall-detail">{text.detail}</p>}
        {!restarting && confirming && canRestart ? (
          <div className="term-stall-confirm">
            <p className="term-stall-detail">{text.confirm}</p>
            <div className="term-stall-actions">
              <button className="btn" data-variant="danger" data-stall-action="confirm" onMouseDown={keep} onClick={restart}>
                {text.confirmLabel}
              </button>
              <button
                className="btn"
                data-variant="ghost"
                data-stall-action="cancel"
                onMouseDown={keep}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          !restarting &&
          (text.canWait || canRestart) && (
            <div className="term-stall-actions">
              {text.canWait && (
                <button
                  className="btn"
                  data-variant="ghost"
                  data-stall-action="wait"
                  onMouseDown={keep}
                  onClick={() => stall.keepWaiting()}
                >
                  Keep waiting
                </button>
              )}
              {canRestart && (
                <button className="btn" data-stall-action="restart" onMouseDown={keep} onClick={() => setConfirming(true)}>
                  Force restart
                </button>
              )}
            </div>
          )
        )}
      </div>
    </div>
  )
}
