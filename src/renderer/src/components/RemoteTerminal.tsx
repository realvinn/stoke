import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalSettings, Theme } from '@shared/types'
import type { RemoteBarMode } from '@shared/ui'
import type { RemoteTabFrame, RemoteTabView } from '@shared/hub/remote'
import { decideResize } from '@shared/phoneUi'
import { isTerminalReport } from '@shared/remotePhone'
import { SizeClaimer, isGrid, type ClaimTrigger, type Grid } from '@shared/sizeClaim'
import { terminalTheme } from '../lib/theme'
import { recentlyUsed } from '../lib/lastInput'
import { platformName } from '../lib/hubRemote'
import type { Tab } from '../types'
import { RemoteFab } from './RemoteFab'

/*
 * A remote tab: another of the owner's machines' session, streamed through
 * the hub relay, end to end encrypted between the two devices
 * (src/main/hub/remote.ts). It speaks the PHONE's pty-socket protocol, so the
 * phone's rules hold here too, with one deliberate difference:
 *
 * - The grid is the pty's, and LAST ACTIVE WINS (shared/sizeClaim.ts). While
 *   this tab is being used — it takes focus, a key, a click, or its pane
 *   changes size while its terminal holds the keyboard — it asks the other
 *   machine to size the pty to this pane, so the session fills it with no
 *   empty space. When someone uses the session's own tab over there, that
 *   machine takes the grid back and this tab draws it as it is: empty space
 *   round it, or a scroll. Nothing claims on being merely shown, on a timer,
 *   or on the other side's resize, so the two cannot fight over it (gotcha 87
 *   has the phone's rule, which this path replaces; the phone keeps its own).
 * - xterm's own replies (device attributes, cursor and colour reports, focus
 *   in/out) are never typed into it (`isTerminalReport`): the terminal at the
 *   other machine answers those already.
 *
 * The device and the link's state are always on screen, so it can never be
 * mistaken for a local session: a small floating button by default (open on
 * hover or keyboard focus for the whole sentence, Close and Try again), or the
 * full banner (Settings › Account & sync, `remoteBar`).
 */

/** Live remote terminals by tab id, for a CDP probe (the buffer, gotcha 5). Nothing in the app reads it. */
const remoteTerms = new Map<string, Terminal>()
;(window as unknown as { stokeRemoteTerminals?: Map<string, Terminal> }).stokeRemoteTerminals = remoteTerms

const STATE_WORDS: Record<RemoteTabView['state'], string> = {
  connecting: 'Connecting through your hub…',
  asking: 'Waiting for the other machine to allow this…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  refused: 'Not allowed',
  ended: 'Session ended',
  lost: 'Could not connect'
}

/** The floating button's one word for the state. */
const STATE_SHORT: Record<RemoteTabView['state'], string> = {
  connecting: 'connecting',
  asking: 'waiting',
  open: 'live',
  reconnecting: 'reconnecting',
  refused: 'not allowed',
  ended: 'ended',
  lost: 'lost'
}

interface Props {
  tab: Tab
  view: RemoteTabView | undefined
  active: boolean
  theme: Theme
  fontFamily: string
  fontSize: number
  terminal: TerminalSettings
  accent: string | null
  alpha: number
  /** A floating button (default) or the full banner. */
  bar: RemoteBarMode
  onClose: (tabId: string) => void
}

export function RemoteTerminal({ tab, view, active, theme, fontFamily, fontSize, terminal, accent, alpha, bar, onClose }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const claimerRef = useRef<SizeClaimer | null>(null)
  const remoteId = tab.remote?.tabId ?? ''
  const stateRef = useRef<RemoteTabView['state'] | undefined>(view?.state)
  stateRef.current = view?.state
  const activeRef = useRef(active)
  activeRef.current = active
  const deviceLabel = view?.deviceLabel ?? tab.remote?.deviceLabel ?? 'another machine'
  const deviceRef = useRef(deviceLabel)
  deviceRef.current = deviceLabel
  /** The grid the pty has, as the other machine last said, for the CDP probe and the face's title. */
  const [grid, setGrid] = useState<Grid | null>(null)
  /** Set while the tab focuses its own terminal for a reason that is not use (a reconnect): that `focusin` claims nothing. */
  const quietFocusRef = useRef(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !remoteId) return
    const term = new Terminal({
      fontFamily,
      fontSize,
      // The same typography as a local pane, so another machine's session reads like one.
      lineHeight: terminal.lineHeight,
      letterSpacing: terminal.letterSpacing,
      cursorStyle: terminal.cursorStyle,
      fontWeightBold: terminal.boldWeight,
      minimumContrastRatio: terminal.contrastBoost,
      cols: 100,
      rows: 30,
      cursorInactiveStyle: 'bar',
      scrollback: 20_000,
      allowTransparency: true,
      macOptionIsMeta: true,
      theme: terminalTheme(theme, accent, alpha)
    })
    // Measures this pane's grid for a claim; never fits the terminal itself: its grid is the pty's.
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    remoteTerms.set(remoteId, term)
    /** The pty's grid as the other machine last said it. */
    let ptyGrid: Grid | null = null
    const sizeTo = (pty: { cols: number; rows: number }, desktop: { cols: number; rows: number }): void => {
      // The phone's laptop layout: the local grid IS the pty's, whoever chose it.
      const d = decideResize({
        layout: 'native',
        reason: 'attach',
        width: host.clientWidth,
        fitWidth: null,
        cellWidth: 0,
        proposed: null,
        pty,
        desktop,
        composerFocused: false,
        resized: false
      })
      if (d.local.cols > 0 && d.local.rows > 0 && (term.cols !== d.local.cols || term.rows !== d.local.rows)) term.resize(d.local.cols, d.local.rows)
      ptyGrid = { cols: pty.cols, rows: pty.rows }
      setGrid(ptyGrid)
    }
    const claimer = new SizeClaimer({
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      want: () => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return null
        const p = fit.proposeDimensions()
        return p && isGrid(p) ? { cols: p.cols, rows: p.rows } : null
      },
      have: () => ptyGrid,
      send: (g) => window.stoke.hub.remote.resize(remoteId, g.cols, g.rows)
    })
    claimerRef.current = claimer
    const use = (kind: ClaimTrigger): void => {
      claimer.trigger(kind, {
        shown: activeRef.current && stateRef.current === 'open',
        focused: host.contains(document.activeElement),
        windowFocused: document.hasFocus(),
        recentInput: recentlyUsed()
      })
    }
    const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000 ? v : dflt)
    const offFrame = window.stoke.hub.remote.onFrame((id, frame: RemoteTabFrame) => {
      if (id !== remoteId) return
      switch (frame.type) {
        case 'attached': {
          const cols = num(frame.cols, 100)
          const rows = num(frame.rows, 30)
          term.reset()
          sizeTo({ cols, rows }, { cols: num(frame.desktopCols, cols), rows: num(frame.desktopRows, rows) })
          if (typeof frame.history === 'string') term.write(frame.history)
          break
        }
        case 'data':
          if (typeof frame.data === 'string') term.write(frame.data)
          break
        case 'size': {
          const cols = num(frame.cols, term.cols)
          const rows = num(frame.rows, term.rows)
          sizeTo({ cols, rows }, { cols: num(frame.desktopCols, cols), rows: num(frame.desktopRows, rows) })
          // The other machine's doing, unless it is this tab's own claim coming back: hold claims while it settles.
          claimer.sized({ cols, rows })
          break
        }
        case 'exit':
          term.write(`\r\n\u001b[2m[The session ended on ${deviceRef.current}.]\u001b[0m\r\n`)
          break
        default:
          break
      }
    })
    const offData = term.onData((data) => {
      // Only keys: xterm's own answers to the far application are the far terminal's to give.
      if (stateRef.current !== 'open' || isTerminalReport(data)) return
      window.stoke.hub.remote.input(remoteId, data)
    })
    /*
     * Use, as sizeClaim.ts counts it. Capture phase on the pane, so xterm's own
     * handlers cannot hide a key or a press. The pane's BORDER box is watched:
     * a grid larger than the pane scrolls, and the scrollbars shrink the content
     * box, which must never read as "this pane was resized" (gotcha 151).
     */
    const onFocus = (): void => {
      if (!quietFocusRef.current) use('focus')
    }
    const onKey = (): void => use('key')
    const onPress = (): void => use('click')
    host.addEventListener('focusin', onFocus)
    host.addEventListener('keydown', onKey, true)
    host.addEventListener('mousedown', onPress, true)
    let firstObservation = true
    const ro = new ResizeObserver(() => {
      // Observing fires once at the start: that is the pane appearing, not changing.
      if (firstObservation) {
        firstObservation = false
        return
      }
      use('pane')
    })
    ro.observe(host, { box: 'border-box' })
    return () => {
      ro.disconnect()
      host.removeEventListener('focusin', onFocus)
      host.removeEventListener('keydown', onKey, true)
      host.removeEventListener('mousedown', onPress, true)
      claimer.dispose()
      claimerRef.current = null
      offFrame()
      offData.dispose()
      remoteTerms.delete(remoteId)
      termRef.current = null
      term.dispose()
    }
    // The terminal is made once per remote tab; theme and font follow below.
  }, [remoteId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme(theme, accent, alpha)
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    term.options.lineHeight = terminal.lineHeight
    term.options.letterSpacing = terminal.letterSpacing
    term.options.minimumContrastRatio = terminal.contrastBoost
  }, [theme, accent, alpha, fontFamily, fontSize, terminal])

  /*
   * Shown, or connected while shown: the keyboard goes to the terminal. A tab
   * switched to is a tab being used, so its focus counts as a claim (the
   * `focusin` above); the first time the link opens counts too — opening a
   * session from the list is using it — but a reconnect does not: a dropped
   * link coming back is the network, not a person.
   */
  const claimedOpenRef = useRef(false)
  const wasActiveRef = useRef(false)
  useEffect(() => {
    const switchedTo = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (!active) return
    const firstOpen = view?.state === 'open' && !claimedOpenRef.current
    if (view?.state === 'open') claimedOpenRef.current = true
    // Focus events fire inside focus(): a reconnect's focus is marked quiet so its focusin claims nothing.
    quietFocusRef.current = !switchedTo && !firstOpen
    termRef.current?.focus()
    quietFocusRef.current = false
    if (firstOpen || (switchedTo && view?.state === 'open')) {
      claimerRef.current?.trigger('focus', { shown: true, focused: true, windowFocused: document.hasFocus(), recentInput: recentlyUsed() })
    }
  }, [active, view?.state])

  /*
   * No view for a tab main once had: main dropped it (a sign-out, a revoke,
   * the hub client stopping), so the link is gone for good and only Close
   * means anything. Before the first view arrives it is still connecting.
   */
  const seenRef = useRef(false)
  if (view) seenRef.current = true
  const gone = !view && seenRef.current
  const state = view?.state ?? (gone ? 'lost' : 'connecting')
  const message = gone ? 'The link is gone: this computer signed out of your hub, or left it.' : (view?.message ?? null)
  const canRetry = !!view && (state === 'refused' || state === 'lost')
  const title = view?.title ?? tab.title
  const platform = platformName(view?.platform ?? tab.remote?.platform ?? '')
  const stateText = `${state === 'asking' && message ? message : STATE_WORDS[state]}${message && state !== 'open' && state !== 'asking' ? ` — ${message}` : ''}`
  const actions = (
    <>
      {canRetry && (
        <button className="btn" onClick={() => void window.stoke.hub.remote.retry(remoteId)}>
          Try again
        </button>
      )}
      <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)} title="Close this tab. The session keeps running on the other machine.">
        Close
      </button>
    </>
  )
  return (
    <div className="term-pane remote-pane" hidden={!active} data-remote-state={state} data-remote-tab={remoteId} data-remote-bar={bar} data-remote-grid={grid ? `${grid.cols}x${grid.rows}` : undefined}>
      {bar === 'bar' ? (
        <div className="remote-banner" role="status" aria-live="polite">
          <span className="remote-banner-kind">Other machine</span>
          <p className="remote-banner-text" title={`${deviceLabel} (${platform}) · ${title}`}>
            <strong>{deviceLabel}</strong>’s session · {title}
            <span className="remote-banner-state" data-state={state}>
              {' '}
              · {stateText}
            </span>
          </p>
          {actions}
        </div>
      ) : (
        <RemoteFab
          placement="pane"
          tone={state === 'open' ? 'live' : state === 'refused' || state === 'lost' || state === 'ended' ? 'down' : 'pending'}
          face={
            <>
              <span className="remote-fab-name">{deviceLabel}</span>
              <span className="remote-fab-state" data-state={state}>
                {STATE_SHORT[state]}
              </span>
            </>
          }
          faceLabel={`${deviceLabel}’s session, ${STATE_WORDS[state]}. Show details.`}
          announce={`${deviceLabel}: ${STATE_WORDS[state]}`}
        >
          <p className="remote-fab-text" title={`${deviceLabel} (${platform}) · ${title}`}>
            <span className="remote-banner-kind">Other machine</span> <strong>{deviceLabel}</strong>’s session · {title}
            <span className="remote-banner-state" data-state={state}>
              {' '}
              · {stateText}
            </span>
          </p>
          <div className="remote-fab-actions">{actions}</div>
        </RemoteFab>
      )}
      <div className="term-host remote-host" ref={hostRef} />
    </div>
  )
}
