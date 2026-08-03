import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ClipboardPeek } from '@shared/api'
import type { Theme } from '@shared/types'
import { attachSink } from '../lib/ptyBus'
import { matchShortcut } from '../lib/shortcuts'
import { terminalTheme } from '../lib/theme'
import type { Tab } from '../types'
import { ContextMenu } from './ContextMenu'

/** Where the menu was opened, plus the state it should describe. */
interface MenuState {
  x: number
  y: number
  selection: string
  clip: ClipboardPeek
}

interface Props {
  tab: Tab
  active: boolean
  theme: Theme
  fontFamily: string
  fontSize: number
  /** Clicking a link in the terminal opens it in the docked browser. */
  onOpenUrl: (url: string) => void
  onRestart: (tab: Tab) => void
  onClose: (tabId: string) => void
}

export function TerminalView({
  tab,
  active,
  theme,
  fontFamily,
  fontSize,
  onOpenUrl,
  onRestart,
  onClose
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  // Kept in a ref so the resize observer can read it without re-subscribing.
  const openUrlRef = useRef(onOpenUrl)
  openUrlRef.current = onOpenUrl

  // Build the terminal once per pty. Theme and font changes are applied in
  // separate effects rather than by rebuilding, so scrollback survives them.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily,
      fontSize,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 20_000,
      allowProposedApi: true,
      allowTransparency: true,
      macOptionIsMeta: true,
      minimumContrastRatio: 1,
      theme: terminalTheme(theme)
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        openUrlRef.current(uri)
      })
    )

    term.open(host)

    // WebGL is a large win on a busy terminal but is unavailable on some GPUs
    // and inside remote sessions; the DOM renderer is the fallback.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* stay on the DOM renderer */
    }

    termRef.current = term
    fitRef.current = fit

    const detach = attachSink(tab.ptyId, (data) => term.write(data))
    const onInput = term.onData((data) => window.stoke.pty.write(tab.ptyId, data))

    // Keep the OS clipboard shortcuts working; everything else goes to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey && e.shiftKey
      const cmd = e.metaKey && !e.ctrlKey
      const isMac = window.stoke.platform === 'darwin'
      // A bare Ctrl chord, with no Shift and no Alt. Only meaningful off macOS,
      // where Cmd carries the clipboard and Ctrl+C must stay SIGINT.
      const bareCtrl = !isMac && e.ctrlKey && !e.shiftKey && !e.altKey

      // Swallow app shortcuts so they act on the window instead of being sent
      // to Claude as keystrokes. App.tsx handles them on the window listener.
      if (matchShortcut(e, isMac)) return false

      const key = e.key.toLowerCase()

      /*
       * preventDefault on every branch that handles the clipboard itself.
       * Returning false only stops xterm processing the key; the browser still
       * fires its own copy/paste event on xterm's hidden textarea, and xterm
       * listens for it. Without this, Ctrl+V pasted twice - verified in the
       * running app, where a three-line paste arrived as six lines.
       */
      if ((mod || (isMac && cmd)) && key === 'c') {
        const sel = term.getSelection()
        if (sel) {
          e.preventDefault()
          window.stoke.clipboard.writeText(sel)
          return false
        }
        // No selection: let Ctrl+C through as SIGINT.
        return !isMac || !cmd
      }

      /*
       * Bare Ctrl+C copies only when something is selected, the way Windows
       * Terminal behaves. The selection is cleared immediately after, so a
       * second press interrupts: without that, a selection left lying around
       * would quietly stop Ctrl+C from interrupting Claude, which is the most
       * pressed key in the app and the worst thing to break.
       */
      if (bareCtrl && key === 'c') {
        const sel = term.getSelection()
        if (!sel) return true
        e.preventDefault()
        window.stoke.clipboard.writeText(sel)
        term.clearSelection()
        return false
      }

      /*
       * term.paste() rather than a raw pty write. It normalises CRLF and wraps
       * the text in bracketed-paste markers when - and only when - the CLI has
       * actually advertised DECSET 2004. Writing raw made every newline in a
       * multi-line paste act as Enter, so pasting a stack trace fired one
       * prompt per line and Windows CRLF could submit twice.
       */
      if ((mod || (isMac && cmd)) && key === 'v') {
        e.preventDefault()
        const { text } = window.stoke.clipboard.readSync()
        if (text) term.paste(text)
        return false
      }

      /*
       * Plain Ctrl+V. Text is pasted here so the most common paste keystroke in
       * the world does the obvious thing. An image-only clipboard instead falls
       * through as \x16 to Claude Code, whose own handler reads the image off
       * the OS clipboard - so image paste keeps working and no image bytes ever
       * cross the PTY. Text wins when the clipboard carries both, which is what
       * copying rich content from a page produces.
       */
      if (bareCtrl && key === 'v') {
        const clip = window.stoke.clipboard.readSync()
        if (clip.text) {
          e.preventDefault()
          term.paste(clip.text)
          return false
        }
        return true
      }

      return true
    })

    /*
     * Take the right-click before xterm can see it. Claude Code turns mouse
     * reporting on, so xterm forwards the press to the PTY and the CLI answers
     * by pasting the clipboard itself - a right-click therefore pasted AND
     * opened this menu. Verified in the running app: a three-line clipboard
     * became six lines on right-click alone. Capture phase on the host stops
     * the event ever reaching xterm's listeners further down the tree.
     */
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 2) e.stopPropagation()
    }
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        selection: term.getSelection(),
        clip: window.stoke.clipboard.readSync()
      })
    }
    host.addEventListener('mousedown', onMouseDown, true)
    host.addEventListener('mouseup', onMouseDown, true)
    host.addEventListener('contextmenu', onContextMenu, true)

    const applyFit = (): void => {
      try {
        fit.fit()
        window.stoke.pty.resize(tab.ptyId, term.cols, term.rows)
      } catch {
        /* host detached mid-measure */
      }
    }

    // Observe the host rather than the window: the sidebar and browser panel
    // resize the pane without the window changing size at all.
    const ro = new ResizeObserver(() => applyFit())
    ro.observe(host)
    applyFit()

    return () => {
      ro.disconnect()
      host.removeEventListener('mousedown', onMouseDown, true)
      host.removeEventListener('mouseup', onMouseDown, true)
      host.removeEventListener('contextmenu', onContextMenu, true)
      detach()
      onInput.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Rebuild only when the process changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.ptyId])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = terminalTheme(theme)
  }, [theme])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    try {
      fitRef.current?.fit()
      window.stoke.pty.resize(tab.ptyId, term.cols, term.rows)
    } catch {
      /* ignore */
    }
  }, [fontFamily, fontSize, tab.ptyId])

  // A hidden pane cannot be measured, so refit and focus when it is revealed.
  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => {
      const term = termRef.current
      if (!term) return
      try {
        fitRef.current?.fit()
        window.stoke.pty.resize(tab.ptyId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
      term.focus()
    }, 0)
    return () => window.clearTimeout(id)
  }, [active, tab.ptyId])

  return (
    <div className="term-pane" hidden={!active}>
      {/* The right-click is handled by a capture-phase listener on this host,
          attached with the terminal, so it never reaches xterm. */}
      <div className="term-host" ref={hostRef} />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Copy',
              disabled: !menu.selection,
              onSelect: () => {
                window.stoke.clipboard.writeText(menu.selection)
                termRef.current?.clearSelection()
                termRef.current?.focus()
              }
            },
            {
              label: 'Paste',
              disabled: !menu.clip.text,
              onSelect: () => {
                termRef.current?.paste(menu.clip.text)
                termRef.current?.focus()
              }
            },
            {
              label: 'Select all',
              separated: true,
              onSelect: () => termRef.current?.selectAll()
            },
            {
              label: 'Clear',
              onSelect: () => {
                termRef.current?.clear()
                termRef.current?.focus()
              }
            }
          ]}
        />
      )}
      {tab.status === 'exited' && (
        <div className="term-exit" role="status">
          <span>
            Session ended
            {tab.exitCode !== null && tab.exitCode !== 0 ? ` (exit ${tab.exitCode})` : ''}
          </span>
          <button className="btn" data-variant="primary" onClick={() => onRestart(tab)}>
            Start again
          </button>
          <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      )}
    </div>
  )
}
