import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import type { ClipboardPeek } from '@shared/api'
import type { Theme } from '@shared/types'
import { createRecorder, voiceSupported, type Recorder } from '@shared/voice'
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
  /*
   * Dictation. Off until asked for, because arming it takes Space away from the
   * terminal — the most-pressed key there after Enter — so it must never be a
   * mode you are in without having said so.
   */
  const [voiceOn, setVoiceOn] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'recording' | 'working'>('idle')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const recorderRef = useRef<Recorder | null>(null)
  /*
   * getUserMedia is async and the first call waits on a permission prompt, so
   * Space is routinely released before recording has begun. Tracking the key
   * rather than the recorder's state is what lets that release still count.
   */
  const spaceDownRef = useRef(false)
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
      /*
       * Without this, the terminal cannot be selected with the mouse on macOS
       * at all. Claude Code turns mouse reporting on, so xterm forwards the
       * drag to the application unless `shouldForceSelection` says otherwise —
       * and that method reads
       *
       *   isMac ? event.altKey && rawOptions.macOptionClickForcesSelection
       *         : event.shiftKey
       *
       * (SelectionService.ts:437, xterm 6.0.0). The option defaults to false,
       * so the Mac branch could only ever return false: Option-drag did
       * nothing, Cmd+C had nothing to copy, and the right-click menu's Copy was
       * permanently disabled. The non-Mac branch needs no option, which is why
       * Shift-drag has always worked on Windows and Linux and this was a
       * macOS-only defect.
       *
       * Option is what Terminal.app and iTerm2 use for the same bypass, so it
       * is the modifier a Mac terminal user already reaches for. It does not
       * collide with `macOptionIsMeta` above: that governs the keyboard (Option
       * sends an ESC prefix), this one governs the mouse.
       */
      macOptionClickForcesSelection: true,
      /*
       * Off, because the option above turned Option into the selection
       * modifier and these two then fight over the same key.
       *
       * `altClickMovesCursor` is on by default. On mouseup it checks
       * `event.altKey` — which is still held, because holding Option is how you
       * selected at all — and if the selection is one character or less and the
       * drag took under half a second, it sends a cursor-move sequence with
       * `wasUserInput: true`. SelectionService listens to its own
       * `onUserInput` and clears the selection on any of it
       * (SelectionService.ts:139-143, :708). So the selection is painted while
       * the button is down and gone the instant it comes up.
       *
       * Measured, not reasoned: `npm run verify:selection` drives this exact
       * gesture through a real xterm in a real Chromium, under the mouse modes
       * the shipped `claude` binary actually asks for (1000/1004/1006/1007 —
       * it never requests motion reports). With the default the one-character
       * drag comes back "", with this line it comes back intact, and every
       * other case is identical either way. That suite is the reason this is a
       * one-line change rather than a guess.
       *
       * Nothing is lost by turning it off: Option-click-to-move-cursor is a
       * readline convenience that never worked here anyway, since Option is
       * spoken for.
       */
      altClickMovesCursor: false,
      minimumContrastRatio: 1,
      theme: terminalTheme(theme)
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    // Unicode 15 widths with grapheme clustering. xterm's built-in tables are
    // Unicode 6, so every emoji added since 2010 is measured one cell wide
    // while the CLI that drew it assumed two — which is why box drawing and
    // status lines tear, locally and over SSH. Set explicitly even though the
    // addon selects it, so the version this app depends on is greppable.
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = '15-graphemes'

    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        openUrlRef.current(uri)
      })
    )

    term.open(host)

    /*
     * A read-only handle on the live terminals, keyed by pty id.
     *
     * xterm draws through WebGL, so `.xterm-rows` is empty and nothing about
     * what the terminal renders is readable from the DOM (CLAUDE.md gotcha 5).
     * Cell widths, the active Unicode version and the cursor column are only
     * readable from the Terminal object, and a CDP probe has no other route to
     * it. Nothing in the app reads this map.
     */
    const live = window as unknown as { stokeTerminals?: Map<string, Terminal> }
    live.stokeTerminals ??= new Map()
    live.stokeTerminals.set(tab.ptyId, term)

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
      live.stokeTerminals?.delete(tab.ptyId)
      termRef.current = null
      fitRef.current = null
    }
    // Rebuild only when the process changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.ptyId])

  /*
   * Dictation's keys, bound on the host in the capture phase so they are taken
   * before xterm's hidden textarea ever sees them — the same technique the
   * right-click uses, and for the same reason: while Claude Code is running,
   * anything that reaches the terminal is forwarded to the CLI.
   *
   * Terminal-scoped rather than in `lib/shortcuts.ts` with the app's chords.
   * Those act on the window; this one acts on *this* terminal and the transcript
   * goes into *this* PTY, so it belongs to the pane that owns them. It is also
   * why the listeners hang off `host` rather than `window`: dictation follows
   * the focused terminal with no routing, and a background tab cannot record.
   */
  useEffect(() => {
    const host = hostRef.current
    if (!host || !active) return

    const isMac = window.stoke.platform === 'darwin'

    const recorder = (recorderRef.current ??= createRecorder(async (wav) => {
      // The renderer never reaches the speech server itself; main proxies it,
      // because the sidecar has no authentication of its own.
      const res = await window.stoke.audio.transcribe(wav)
      if (!res.ok) throw new Error(res.error)
      return res.text
    }))

    const fail = (err: unknown, fallback: string): void => {
      setVoiceStatus('idle')
      setVoiceError(err instanceof Error && err.message ? err.message : fallback)
    }

    const beginRecording = async (): Promise<void> => {
      setVoiceError(null)
      setVoiceStatus('recording')
      try {
        await recorder.start()
        // Released while the permission prompt was up: throw the clip away
        // rather than leaving a microphone open that nobody asked to keep on.
        if (!spaceDownRef.current) {
          recorder.cancel()
          setVoiceStatus('idle')
        }
      } catch (err) {
        fail(err, 'Could not open the microphone.')
      }
    }

    const finishRecording = async (): Promise<void> => {
      if (!recorder.recording()) return
      setVoiceStatus('working')
      try {
        const text = await recorder.finish()
        setVoiceStatus('idle')
        /*
         * paste() rather than a raw pty write, for the reason the clipboard
         * path already documents: it wraps the text in bracketed-paste markers
         * when the CLI has advertised DECSET 2004, so a transcript that came
         * back with a newline in it does not submit the prompt early.
         */
        if (text) termRef.current?.paste(text)
      } catch (err) {
        fail(err, 'Transcription failed.')
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const chord = isMac
        ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
        : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
      if (chord && e.code === 'KeyD') {
        e.preventDefault()
        e.stopPropagation()
        setVoiceError(null)
        setVoiceOn((on) => !on)
        return
      }

      if (!voiceOn) return

      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setVoiceOn(false)
        return
      }

      // `repeat` matters: holding Space fires keydown continuously, and without
      // this each repeat would start a new recording over the live one.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      e.stopPropagation()
      spaceDownRef.current = true
      void beginRecording()
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!voiceOn || e.code !== 'Space') return
      e.preventDefault()
      e.stopPropagation()
      spaceDownRef.current = false
      void finishRecording()
    }

    host.addEventListener('keydown', onKeyDown, true)
    host.addEventListener('keyup', onKeyUp, true)
    return () => {
      host.removeEventListener('keydown', onKeyDown, true)
      host.removeEventListener('keyup', onKeyUp, true)
    }
  }, [active, voiceOn])

  /*
   * Leaving voice mode — by Esc, by switching tabs, or by the pane going away —
   * must release the microphone. Without this the OS recording indicator stays
   * lit after the mode is off, which is exactly the kind of thing that makes a
   * person stop trusting an app with their microphone.
   */
  useEffect(() => {
    if (voiceOn && active) return
    recorderRef.current?.cancel()
    spaceDownRef.current = false
    setVoiceStatus('idle')
  }, [voiceOn, active])

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
    }
  }, [])

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
          /*
           * Only when there is nothing selected, which is exactly when a user
           * has just discovered that dragging does not select. Claude Code
           * keeps mouse reporting on, so the drag goes to the CLI unless it
           * carries the platform's bypass modifier — Option on macOS, Shift
           * elsewhere, per xterm's `shouldForceSelection`.
           */
          footer={
            menu.selection
              ? undefined
              : window.stoke.platform === 'darwin'
                ? 'Hold ⌥ Option while dragging to select text.'
                : 'Hold Shift while dragging to select text.'
          }
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
            /*
             * The only place dictation announces itself. A mode reachable by
             * one undocumented chord is a mode nobody finds; hidden outright
             * where the browser has no microphone API at all, so it never
             * offers something that cannot work.
             */
            ...(voiceSupported()
              ? [
                  {
                    label: voiceOn ? 'Stop dictation' : 'Dictate…',
                    onSelect: () => {
                      setVoiceError(null)
                      setVoiceOn((on) => !on)
                      termRef.current?.focus()
                    }
                  }
                ]
              : []),
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
      {voiceOn && (
        <div className="voice-strip" role="status" data-tone={voiceError ? 'error' : undefined}>
          <span className="voice-dot" data-state={voiceError ? 'error' : voiceStatus} />
          <span className="voice-text">
            {voiceError
              ? voiceError
              : voiceStatus === 'recording'
                ? 'Listening — release Space to transcribe'
                : voiceStatus === 'working'
                  ? 'Transcribing…'
                  : 'Hold Space to speak · Esc to exit'}
          </span>
        </div>
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
