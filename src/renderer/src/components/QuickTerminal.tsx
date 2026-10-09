import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { QuickTerminalReplay, type QuickTerminalApi, type QuickTerminalAppearance, type QuickTerminalState, type QuickTerminalSurface } from '@shared/quickTerminal'
import { terminalTheme } from '../lib/theme'
import '@xterm/xterm/css/xterm.css'

export function useQuickTerminal(api: QuickTerminalApi): QuickTerminalState | null {
  const [state, setState] = useState<QuickTerminalState | null>(null)
  useEffect(() => {
    let alive = true
    const update = (next: QuickTerminalState): void => { if (alive) setState(prev => !prev || next.revision >= prev.revision ? next : prev) }
    const off = api.onState(update)
    void api.read().then(snapshot => update(snapshot.state)).catch(() => {})
    return () => { alive = false; off() }
  }, [api])
  return state
}

interface Props { api: QuickTerminalApi; state: QuickTerminalState; appearance: QuickTerminalAppearance; surface: QuickTerminalSurface }
export function QuickTerminalPanel({ api, state, appearance, surface }: Props): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const claimed = useRef(false)
  const [query, setQuery] = useState<string | null>(null)
  const find = useRef<SearchAddon | null>(null)
  const run = async (action: () => ReturnType<QuickTerminalApi['end']>): Promise<void> => {
    if (claimed.current) return
    claimed.current = true
    setBusy(true); setError('')
    try { const result = await action(); if (!result.ok) setError(result.message) }
    catch { setError('The terminal could not finish this action.') }
    finally { claimed.current = false; setBusy(false) }
  }
  return (
    <section className="quick-terminal" data-quick-terminal aria-label="Quick terminal" onKeyDown={event => event.stopPropagation()} onKeyDownCapture={event => {
      // This whole panel owns its keys, including buttons and the find field.
      if ((api.platform === 'darwin' ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); setQuery(prev => prev === null ? '' : null) }
    }}>
      <header className="quick-terminal-header">
        <div className="quick-terminal-heading"><strong>Quick terminal</strong><span>Local shell</span></div>
        <div className="quick-terminal-actions">
          <button className="btn" data-variant="ghost" disabled={busy || state.phase === 'starting'} onClick={() => void run(() => api.move(surface === 'panel' ? 'popout' : 'panel'))}>{surface === 'panel' ? 'Pop out' : 'Dock'}</button>
          <button className="btn" data-variant="ghost" disabled={busy} onClick={() => void run(() => api.move('hidden'))} title="Hide the view; commands keep running">Hide</button>
        </div>
      </header>
      <div className="quick-terminal-folder" title={state.cwd}>{state.cwd || 'Opening local shell…'}</div>
      {query !== null && <form className="quick-terminal-find" onSubmit={event => { event.preventDefault(); find.current?.findNext(query) }}>
        <input aria-label="Find in quick terminal" autoFocus value={query} onChange={event => { setQuery(event.target.value); find.current?.findNext(event.target.value) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setQuery(null); find.current?.clearDecorations() } }} />
        <button className="btn" type="submit">Next</button><button className="btn" type="button" onClick={() => { setQuery(null); find.current?.clearDecorations() }}>Close</button>
      </form>}
      {error && <p className="quick-terminal-error" role="alert">{error}</p>}
      {state.id && <QuickTerminalScreen api={api} id={state.id} appearance={appearance} phase={state.phase} find={find} />}
      {!state.id && <div className="quick-terminal-empty">{state.phase === 'starting' ? 'Opening shell…' : 'Use Terminal in the top bar to open a shell.'}</div>}
      <footer className="quick-terminal-footer">
        <span role="status">{state.phase === 'running' ? 'Commands keep running when hidden' : state.phase === 'exited' ? `Shell ended${state.exitCode === null ? '' : ` · Exit ${state.exitCode}`}` : state.phase === 'stopping' ? 'Stopping shell…' : 'Opening shell…'}</span>
        {state.phase === 'exited' || state.phase === 'idle'
          ? <button className="btn" disabled={busy || !state.enabled} onClick={() => void run(() => api.restart())}>New shell</button>
          : <button className="btn" data-variant="ghost" disabled={busy || state.phase === 'stopping'} onClick={() => void run(() => api.end())}>End shell</button>}
      </footer>
    </section>
  )
}

function QuickTerminalScreen({ api, id, appearance, phase, find }: { api: QuickTerminalApi; id: string; appearance: QuickTerminalAppearance; phase: QuickTerminalState['phase']; find: React.RefObject<SearchAddon | null> }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fitCurrent = useRef<(() => void) | null>(null)
  const appearanceRef = useRef(appearance); appearanceRef.current = appearance
  useEffect(() => {
    const node = host.current
    if (!node) return
    let alive = true
    const a = appearanceRef.current
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 2000, fontFamily: a.fontFamily, fontSize: a.fontSize, lineHeight: a.terminal.lineHeight, letterSpacing: a.terminal.letterSpacing, fontWeightBold: a.terminal.boldWeight, minimumContrastRatio: a.terminal.contrastBoost, cursorStyle: a.terminal.cursorStyle, cursorBlink: a.terminal.cursorBlink, theme: terminalTheme(a.theme), macOptionIsMeta: true, macOptionClickForcesSelection: true, altClickMovesCursor: false, allowProposedApi: true })
    terminal.current = term
    const fit = new FitAddon(); const search = new SearchAddon(); find.current = search
    term.loadAddon(fit); term.loadAddon(search); term.loadAddon(new UnicodeGraphemesAddon()); term.unicode.activeVersion = '15-graphemes'
    term.open(node)
    const replay = new QuickTerminalReplay(id, data => { if (alive) term.write(data) })
    const offData = api.onData(frame => replay.frame(frame))
    const input = term.onData(data => api.write(id, data))
    // Copy/paste retain interrupt keys and xterm's bracketed-paste behavior.
    term.attachCustomKeyEventHandler(event => {
      const modifier = api.platform === 'darwin' ? event.metaKey : event.ctrlKey && event.shiftKey
      if (!modifier || event.type !== 'keydown') return true
      if (event.key.toLowerCase() === 'c' && term.hasSelection()) { event.preventDefault(); api.copy(term.getSelection()); return false }
      if (event.key.toLowerCase() === 'v') { event.preventDefault(); void api.paste().then(text => { if (alive) term.paste(text) }); return false }
      return true
    })
    const context = (event: MouseEvent): void => { event.preventDefault(); if (term.hasSelection()) api.copy(term.getSelection()); else void api.paste().then(text => { if (alive) term.paste(text) }) }
    node.addEventListener('contextmenu', context)
    let hydrated = false
    const resize = (): void => { if (!alive || !hydrated || node.clientWidth < 20 || node.clientHeight < 20) return; fit.fit(); api.resize(id, term.cols, term.rows) }
    const observer = new ResizeObserver(resize); observer.observe(node)
    fitCurrent.current = resize
    void api.read().then(snapshot => {
      if (!alive || snapshot.state.id !== id) return
      term.resize(snapshot.state.cols, snapshot.state.rows)
      replay.snapshot(snapshot)
      // Fit only after the replay has parsed its original grid.
      term.write('', () => { if (!alive) return; hydrated = true; resize(); term.focus() })
    }).catch(() => { if (alive) term.write('\r\nThe shell view could not reconnect. Hide and reopen it.\r\n') })
    return () => { alive = false; observer.disconnect(); offData(); input.dispose(); node.removeEventListener('contextmenu', context); fitCurrent.current = null; find.current = null; terminal.current = null; term.dispose() }
  }, [api, id, find])
  useEffect(() => {
    const term = terminal.current
    if (!term) return
    term.options.theme = terminalTheme(appearance.theme); term.options.fontFamily = appearance.fontFamily; term.options.fontSize = appearance.fontSize
    term.options.lineHeight = appearance.terminal.lineHeight; term.options.cursorStyle = appearance.terminal.cursorStyle; term.options.cursorBlink = appearance.terminal.cursorBlink
    term.options.letterSpacing = appearance.terminal.letterSpacing; term.options.fontWeightBold = appearance.terminal.boldWeight; term.options.minimumContrastRatio = appearance.terminal.contrastBoost
    term.options.disableStdin = phase !== 'running'
    // ResizeObserver alone cannot detect glyph-width changes at the same box size.
    fitCurrent.current?.()
  }, [appearance, phase])
  return <div className="quick-terminal-screen" ref={host} title="Copy: Cmd+C on Mac, Ctrl+Shift+C elsewhere. Paste: Cmd+V / Ctrl+Shift+V. Right-click copies a selection or pastes." />
}
