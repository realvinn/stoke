import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import type { TerminalSettings, Theme } from '@shared/types'
import type { RemoteTabFrame, RemoteTabView } from '@shared/hub/remote'
import { decideResize } from '@shared/phoneUi'
import { isTerminalReport } from '@shared/remotePhone'
import { terminalTheme } from '../lib/theme'
import { platformName } from '../lib/hubRemote'
import type { Tab } from '../types'

/*
 * A remote tab: another of the owner's machines' session, streamed through
 * the hub relay, end to end encrypted between the two devices
 * (src/main/hub/remote.ts). It speaks the PHONE's pty-socket protocol, so the
 * phone's rules hold here too:
 *
 * - It never resizes the other machine's pty. `decideResize` in `native`
 *   layout (a laptop browser's) keeps the local terminal at the pty's own grid
 *   and sends nothing (gotcha 87) — a remote viewer reflowing the terminal of
 *   whoever sits at that machine is the bug that rule exists for. A grid wider
 *   than this pane scrolls.
 * - xterm's own replies (device attributes, cursor and colour reports, focus
 *   in/out) are never typed into it (`isTerminalReport`): the terminal at the
 *   other machine answers those already.
 *
 * The banner says, always, whose session this is and what state the link is
 * in, so it can never be mistaken for a local one.
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
  onClose: (tabId: string) => void
}

export function RemoteTerminal({ tab, view, active, theme, fontFamily, fontSize, terminal, accent, alpha, onClose }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const remoteId = tab.remote?.tabId ?? ''
  const stateRef = useRef<RemoteTabView['state'] | undefined>(view?.state)
  stateRef.current = view?.state
  const deviceLabel = view?.deviceLabel ?? tab.remote?.deviceLabel ?? 'another machine'
  const deviceRef = useRef(deviceLabel)
  deviceRef.current = deviceLabel

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
    term.open(host)
    termRef.current = term
    remoteTerms.set(remoteId, term)
    const sizeTo = (pty: { cols: number; rows: number }, desktop: { cols: number; rows: number }): void => {
      // The phone's rule, in the layout that never resizes the pty: the local grid IS the pty's.
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
    return () => {
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

  useEffect(() => {
    if (active) termRef.current?.focus()
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
  return (
    <div className="term-pane remote-pane" hidden={!active} data-remote-state={state} data-remote-tab={remoteId}>
      <div className="remote-banner" role="status" aria-live="polite">
        <span className="remote-banner-kind">Other machine</span>
        <p className="remote-banner-text" title={`${deviceLabel} (${platformName(view?.platform ?? tab.remote?.platform ?? '')}) · ${view?.title ?? tab.title}`}>
          <strong>{deviceLabel}</strong>’s session · {view?.title ?? tab.title}
          <span className="remote-banner-state" data-state={state}>
            {' '}
            · {state === 'asking' && message ? message : STATE_WORDS[state]}
            {message && state !== 'open' && state !== 'asking' ? ` — ${message}` : ''}
          </span>
        </p>
        {canRetry && (
          <button className="btn" onClick={() => void window.stoke.hub.remote.retry(remoteId)}>
            Try again
          </button>
        )}
        <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)} title="Close this tab. The session keeps running on the other machine.">
          Close
        </button>
      </div>
      <div className="term-host remote-host" ref={hostRef} />
    </div>
  )
}
