import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { terminalLinkClick, terminalLinkRepairs } from '@shared/terminalLinks'
import { QuickTerminalReplay, type QuickTerminalApi, type QuickTerminalAppearance, type QuickTerminalShell, type QuickTerminalState, type QuickTerminalSurface } from '@shared/quickTerminal'
import { terminalTheme } from '../lib/theme'
import { installShiftSelection } from '../lib/terminalSelection'
import { IconPin } from './Icons'
import '@xterm/xterm/css/xterm.css'

/** Like the agent and relay registries: read the real buffer in packaged probes. */
const quickTerms = new Map<string, Terminal>()
;(window as unknown as { stokeQuickTerminals?: Map<string, Terminal> }).stokeQuickTerminals = quickTerms

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

interface FocusRequest { sequence: number; contextId: string | null }
interface Props { api: QuickTerminalApi; state: QuickTerminalState; appearance: QuickTerminalAppearance; surface: QuickTerminalSurface; focusRequest?: FocusRequest; onOpenUrl?: (url: string) => void }
interface TerminalScope { key: string }
interface TerminalAction { owner: TerminalScope }
export function QuickTerminalPanel({ api, state, appearance, surface, focusRequest, onOpenUrl }: Props): React.JSX.Element {
  const [shells, setShells] = useState<QuickTerminalShell[]>([])
  const [shellError, setShellError] = useState('')
  const [actionError, setActionError] = useState<{ owner: TerminalScope; message: string } | null>(null)
  const [pending, setPending] = useState<TerminalAction | null>(null)
  const claimed = useRef<TerminalAction | null>(null)
  const [search, setSearch] = useState<{ owner: TerminalScope; query: string } | null>(null)
  const find = useRef<SearchAddon | null>(null)
  const focusTerminal = useRef<(() => void) | null>(null)
  const scopeKey = JSON.stringify([state.contextId, state.id])
  const currentScope = useRef<TerminalScope>({ key: scopeKey })
  const focusTarget = useRef({ focusRequest, contextId: state.contextId, pinned: state.pinned })
  focusTarget.current = { focusRequest, contextId: state.contextId, pinned: state.pinned }
  const consumedFocusRequest = useRef(0)
  const claimFocusRequest = useCallback((): boolean => {
    const { focusRequest: request, contextId, pinned } = focusTarget.current
    if (!request || request.sequence <= consumedFocusRequest.current || (!pinned && request.contextId !== contextId)) return false
    consumedFocusRequest.current = request.sequence
    return true
  }, [])
  const focusKey = JSON.stringify([focusRequest?.sequence, state.contextId, state.pinned])
  // Returning A -> B -> A creates a new owner: an old A operation cannot
  // clear or report errors for a newer operation in that same tab/shell.
  if (currentScope.current.key !== scopeKey) currentScope.current = { key: scopeKey }
  const owner = currentScope.current
  const busy = pending?.owner === owner
  const error = (actionError?.owner === owner ? actionError.message : '') || shellError
  const query = search?.owner === owner ? search.query : null
  const setQuery = (value: string | null): void => setSearch(value === null ? null : { owner: currentScope.current, query: value })
  const closeFind = (): void => { setQuery(null); find.current?.clearDecorations(); focusTerminal.current?.() }
  useEffect(() => {
    find.current?.clearDecorations()
  }, [owner])
  useEffect(() => {
    let alive = true
    void api.shells().then(choices => { if (alive) setShells(choices) }).catch(() => { if (alive) setShellError('Installed shells could not be listed. Hide and reopen the terminal to try again.') })
    return () => { alive = false }
  }, [api])
  const run = async (action: () => ReturnType<QuickTerminalApi['end']>): Promise<void> => {
    const owner = currentScope.current
    if (claimed.current?.owner === owner) return
    const operation = { owner }
    claimed.current = operation
    setPending(operation); setActionError(null)
    try { const result = await action(); if (!result.ok && currentScope.current === owner && claimed.current === operation) setActionError({ owner, message: result.message }) }
    catch { if (currentScope.current === owner && claimed.current === operation) setActionError({ owner, message: 'The terminal could not finish this action.' }) }
    finally {
      if (claimed.current === operation) {
        claimed.current = null
        setPending(previous => previous === operation ? null : previous)
      }
    }
  }
  return (
    <section className="quick-terminal" data-quick-terminal data-context={state.contextId} data-pinned={state.pinned} aria-label="Quick terminal" onKeyDown={event => event.stopPropagation()} onKeyDownCapture={event => {
      // This whole panel owns its keys, including buttons and the find field.
      if ((api.platform === 'darwin' ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); if (query === null) setQuery(''); else closeFind() }
    }}>
      <header className="quick-terminal-header">
        <div className="quick-terminal-heading"><strong>Quick terminal</strong><span>Local shell</span></div>
        <div className="quick-terminal-actions">
          <button className="btn" data-variant="ghost" disabled={busy || state.phase === 'starting'} onClick={() => void run(() => api.move(surface === 'panel' ? 'popout' : 'panel'))}>{surface === 'panel' ? 'Pop out' : 'Dock'}</button>
          <button className="btn" data-variant="ghost" disabled={busy} onClick={() => void run(() => api.move('hidden'))} title="Hide the view; commands keep running">Hide</button>
        </div>
      </header>
      <div className="quick-terminal-shell">
        <label>
          <span>Shell</span>
          <select aria-label="Terminal shell" value={state.shellId} disabled={busy || !shells.length || state.phase === 'starting' || state.phase === 'stopping'} onChange={event => { const id = event.target.value; void run(() => api.selectShell(id)) }} title={shells.find(shell => shell.id === state.shellId)?.path}>
            {!shells.length && <option value={state.shellId}>Loading installed shells…</option>}
            {shells.map(shell => <option key={shell.id} value={shell.id}>{shell.label}{state.sessions.some(session => session.shellId === shell.id && session.phase === 'running') ? ' · Running' : ''}</option>)}
          </select>
        </label>
        <button className="btn quick-terminal-pin" data-variant="ghost" aria-label="Keep terminal across tabs" aria-pressed={state.pinned} disabled={busy || !state.id || state.phase === 'starting' || state.phase === 'stopping'} title={state.pinned ? 'Unpin to use each tab’s own terminal' : 'Pin this terminal to keep it when you switch tabs'} onClick={() => void run(() => api.pin(!state.pinned))}><IconPin /><span>{state.pinned ? 'Pinned across tabs' : 'This tab'}</span></button>
      </div>
      <div className="quick-terminal-folder" title={state.cwd}>{state.cwd || (state.phase === 'starting' ? 'Opening local shell…' : 'Local home folder')}</div>
      {query !== null && <form className="quick-terminal-find" onSubmit={event => { event.preventDefault(); find.current?.findNext(query) }}>
        <input aria-label="Find in quick terminal" autoFocus value={query} onChange={event => { setQuery(event.target.value); find.current?.findNext(event.target.value) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeFind() } }} />
        <button className="btn" type="submit">Next</button><button className="btn" type="button" onClick={closeFind}>Close</button>
      </form>}
      {error && <p className="quick-terminal-error" role="alert">{error}</p>}
      {state.id && <QuickTerminalScreen key={state.id} api={api} id={state.id} appearance={appearance} phase={state.phase} find={find} focusTerminal={focusTerminal} focusKey={focusKey} claimFocusRequest={claimFocusRequest} onOpenUrl={onOpenUrl} />}
      {!state.id && <div className="quick-terminal-empty">{state.phase === 'starting' ? 'Opening shell…' : 'Open a shell for this tab to run quick commands.'}</div>}
      <footer className="quick-terminal-footer">
        <span role="status">{state.phase === 'running' ? state.pinned ? 'Pinned; commands keep running across tabs' : 'This tab’s shell; commands keep running while hidden' : state.phase === 'exited' ? `Shell ended${state.exitCode === null ? '' : ` · Exit ${state.exitCode}`}` : state.phase === 'stopping' ? 'Stopping shell…' : state.phase === 'starting' ? 'Opening shell…' : 'No shell open for this tab'}</span>
        {state.phase === 'exited' || state.phase === 'idle'
          ? <button className="btn" disabled={busy || !state.enabled} onClick={() => void run(() => api.restart())}>{state.phase === 'idle' ? 'Open shell' : 'New shell'}</button>
          : <button className="btn" data-variant="ghost" disabled={busy || state.phase === 'stopping'} onClick={() => void run(() => api.end())}>End shell</button>}
      </footer>
    </section>
  )
}

function QuickTerminalScreen({ api, id, appearance, phase, find, focusTerminal, focusKey, claimFocusRequest, onOpenUrl }: { api: QuickTerminalApi; id: string; appearance: QuickTerminalAppearance; phase: QuickTerminalState['phase']; find: React.RefObject<SearchAddon | null>; focusTerminal: React.RefObject<(() => void) | null>; focusKey: string; claimFocusRequest: () => boolean; onOpenUrl?: (url: string) => void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fitCurrent = useRef<(() => void) | null>(null)
  const appearanceRef = useRef(appearance); appearanceRef.current = appearance
  const openUrlRef = useRef(onOpenUrl); openUrlRef.current = onOpenUrl
  useEffect(() => {
    const node = host.current
    if (!node) return
    let alive = true
    const a = appearanceRef.current
    let downAt: { x: number; y: number } | null = null
    const openLink = (event: MouseEvent, uri: string): void => {
      event.preventDefault()
      const action = terminalLinkClick(uri, event, downAt, api.platform === 'darwin')
      if (!alive || !action) return
      if (action === 'stoke' && openUrlRef.current) openUrlRef.current(uri)
      else api.openLink(id, uri)
    }
    const press = (event: MouseEvent): void => { downAt = { x: event.clientX, y: event.clientY } }
    node.addEventListener('mousedown', press, true)
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 2000, fontFamily: a.fontFamily, fontSize: a.fontSize, lineHeight: a.terminal.lineHeight, letterSpacing: a.terminal.letterSpacing, fontWeightBold: a.terminal.boldWeight, minimumContrastRatio: a.terminal.contrastBoost, cursorStyle: a.terminal.cursorStyle, cursorBlink: a.terminal.cursorBlink, theme: terminalTheme(a.theme), macOptionIsMeta: true, macOptionClickForcesSelection: true, altClickMovesCursor: false, allowProposedApi: true, linkHandler: { activate: openLink } })
    terminal.current = term
    quickTerms.set(id, term)
    focusTerminal.current = () => { if (alive) term.focus() }
    const fit = new FitAddon(); const search = new SearchAddon(); find.current = search
    term.loadAddon(fit); term.loadAddon(search); term.loadAddon(new UnicodeGraphemesAddon()); term.unicode.activeVersion = '15-graphemes'
    term.registerLinkProvider({ provideLinks: (line, done) => done(terminalLinkRepairs(term, line).map(link => ({ ...link, activate: openLink }))) })
    term.loadAddon(new WebLinksAddon(openLink))
    term.open(node)
    const removeSelection = installShiftSelection(node, term, api.platform === 'darwin')
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
    const focusFrom = document.activeElement
    const requestedFocus = claimFocusRequest()
    const panelControl = !!focusFrom && !!node.closest('[data-quick-terminal]')?.contains(focusFrom) && !focusFrom.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    const mayFocus = requestedFocus || !focusFrom || focusFrom === document.body || panelControl
    void api.read().then(snapshot => {
      if (!alive || snapshot.state.id !== id) return
      term.resize(snapshot.state.cols, snapshot.state.rows)
      replay.snapshot(snapshot)
      // Fit only after the replay has parsed its original grid.
      term.write('', () => {
        if (!alive) return
        hydrated = true; resize()
        // Switching tabs must not take focus back from its agent or a find
        // field while the terminal's asynchronous replay finishes.
        if (mayFocus && document.activeElement === focusFrom) term.focus()
      })
    }).catch(() => { if (alive) term.write('\r\nThe shell view could not reconnect. Hide and reopen it.\r\n') })
    return () => { alive = false; observer.disconnect(); offData(); input.dispose(); removeSelection(); node.removeEventListener('contextmenu', context); node.removeEventListener('mousedown', press, true); fitCurrent.current = null; find.current = null; focusTerminal.current = null; terminal.current = null; quickTerms.delete(id); term.dispose() }
  }, [api, id, find, focusTerminal, claimFocusRequest])
  useEffect(() => {
    // Explicitly reopening an already mounted panel also focuses its shell.
    // Automatic context changes have no unconsumed request.
    if (claimFocusRequest()) terminal.current?.focus()
  }, [focusKey, claimFocusRequest])
  useEffect(() => {
    const term = terminal.current
    if (!term) return
    term.options.theme = terminalTheme(appearance.theme); term.options.fontFamily = appearance.fontFamily; term.options.fontSize = appearance.fontSize
    term.options.lineHeight = appearance.terminal.lineHeight; term.options.cursorStyle = appearance.terminal.cursorStyle; term.options.cursorBlink = appearance.terminal.cursorBlink
    term.options.letterSpacing = appearance.terminal.letterSpacing; term.options.fontWeightBold = appearance.terminal.boldWeight; term.options.minimumContrastRatio = appearance.terminal.contrastBoost
    term.options.disableStdin = phase !== 'running'
    // ResizeObserver alone cannot detect glyph-width changes at the same box size.
    fitCurrent.current?.()
  }, [appearance, phase, id])
  // FitAddon measures its parent's full CSS box; keep padding on the outer
  // wrapper so the fitted grid uses the actual inner content area (gotcha 87).
  return <div className="quick-terminal-screen" title="Copy: Cmd+C on Mac, Ctrl+Shift+C elsewhere. Paste: Cmd+V / Ctrl+Shift+V. Right-click copies a selection or pastes."><div className="quick-terminal-host" ref={host} /></div>
}
