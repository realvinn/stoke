import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Theme } from '@shared/types'
import { attachSink } from '../lib/ptyBus'
import { matchShortcut } from '../lib/shortcuts'
import { terminalTheme } from '../lib/theme'
import type { Tab } from '../types'

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

      // Swallow app shortcuts so they act on the window instead of being sent
      // to Claude as keystrokes. App.tsx handles them on the window listener.
      if (matchShortcut(e, isMac)) return false

      if ((mod || (isMac && cmd)) && e.key.toLowerCase() === 'c') {
        const sel = term.getSelection()
        if (sel) {
          void navigator.clipboard.writeText(sel)
          return false
        }
        // No selection: let Ctrl+C through as SIGINT.
        return !isMac || !cmd
      }
      if ((mod || (isMac && cmd)) && e.key.toLowerCase() === 'v') {
        void navigator.clipboard.readText().then((text) => {
          if (text) window.stoke.pty.write(tab.ptyId, text)
        })
        return false
      }
      return true
    })

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
      <div className="term-host" ref={hostRef} />
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
