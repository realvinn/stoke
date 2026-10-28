import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { captureTerminalViewport, restoreTerminalViewport } from '@shared/terminalViewport'
import { selectedTerminalLink, terminalLinkClick, terminalLinkRepairs } from '@shared/terminalLinks'
import { rememberSshViewport, takeSshViewport } from '../lib/sshViewport'
import type { ClipboardPeek } from '@shared/api'
import type { SshHost, TerminalSettings, Theme, VoiceSettings } from '@shared/types'
import { copiedFilesText, dropText, imagePasteKeys } from '@shared/drop'
import {
  clipboardChord,
  copyAction,
  osc52Write,
  pasteAction,
  pasteMenuItem,
  pasteSafely,
  selectionHasText,
  typesDictation,
  typingParts,
  type ClipboardChord,
  type PasteAction
} from '@shared/clipboardText'
import { SHORTCUT_TEXT_MAX } from '@shared/topBar'
import { PRIVATE_ENDED_TEXT } from '@shared/privateChat'
import { voiceSupported } from '@shared/voice'
import { SizeClaimer, isGrid, sameGrid, type ClaimTrigger, type Grid } from '@shared/sizeClaim'
import { CLI_OWNS_SPACE, SESSION_ENDED_WORDS, spaceOwner } from '@shared/voiceRoute'
import { CORNER_FLOATS, FOOT_FLOATS, floatInset } from '@shared/paneFloats'
import { attachSink, noteInput, setTyped } from '../lib/ptyBus'
import { setToastFloor, toast } from '../lib/toasts'
import { recentlyUsed } from '../lib/lastInput'
import { isButtonlessMotionReport } from '../lib/mouseReport'
import { chordLabel, matchShortcut } from '../lib/shortcuts'
import {
  registerClipboardKeys,
  registerFinder,
  registerTerm,
  screenOf,
  unregisterTerm,
  type ClipboardKeyVerdict
} from '../lib/termRegistry'
import { findColors, terminalTheme } from '../lib/theme'
import { agentMark, paneAgent } from '../lib/agentColor'
import type { Tab } from '../types'
import { ContextMenu } from './ContextMenu'
import { TerminalFind } from './TerminalFind'
import { useSshImages } from './ImageSendStrip'
import { useDictation } from './Dictation'
import { useMicTunnel } from './MicTunnel'
import { micOwnsSpace } from '@shared/micTunnel'
import { TerminalStallOverlay, useTerminalStall } from './TerminalStallOverlay'
import { schemeProbe } from '@shared/terminalStall'

/*
 * The OSC 52 cap (`MAX_OSC52_BASE64`) and what a write puts on the clipboard
 * live in shared/clipboardText.ts (`osc52Write`), where verify:drop runs them.
 */

/** Said when a paste or a program's copy had control characters left out of it. */
function noteCleaned(what: 'paste' | 'copy'): void {
  toast(
    what === 'paste'
      ? {
          title: 'Pasted without control characters',
          description: 'The clipboard held terminal escapes. They were left out, so the paste could not type keys of its own.'
        }
      : {
          title: 'Copied without control characters',
          description: 'A program in this tab copied text holding terminal escapes. They were left out, so pasting it cannot type keys of its own.'
        }
  )
}

/**
 * Read once. The preload freezes `window.stoke` before any renderer module
 * evaluates, and this component used to re-derive it in four places under
 * four names. The render tree needs it too: the context menu spells its
 * chords out per platform.
 */
const IS_MAC = window.stoke.platform === 'darwin'


/**
 * The luminance class the CLI sorts a background into (gotcha 42): it asks
 * with OSC 11 and calls the answer light above 0.5. Only a change of CLASS is
 * worth a CSI 997 report — the CLI ignores the report's own dark/light bit and
 * simply re-runs the query — so this is what the theme effect keys on, rather
 * than the theme object, which the editor replaces on every slider pixel.
 */
function isLightBackground(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim())
  if (!m) return false
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5
}

/** Where the menu was opened, plus the state it should describe. */
interface MenuState {
  x: number
  y: number
  selection: string
  link: string | null
  /**
   * Cells really are selected, but every one of them is blank.
   *
   * Not the same as having no selection, and the difference is the whole point:
   * `hasSelection` compares coordinates while `selectionText` trims blank cells
   * (`SelectionService.ts:191-198`, `:205-250`), so a drag across the padding
   * inside Claude Code's prompt box paints a highlight the user can see and
   * hands back "". Told apart here so the menu can say which one happened
   * rather than telling someone whose gesture worked that it did not.
   */
  blank: boolean
  clip: ClipboardPeek
}

/** A context lost again this soon after it was made counts against the GPU. */
const WEBGL_QUICK_LOSS_MS = 10_000
/** That many in a row and the terminal stays on the DOM renderer. */
const WEBGL_MAX_QUICK_LOSSES = 3
/** The first retry after a loss; doubled for each quick loss before it. */
const WEBGL_RETRY_MS = 250

interface Props {
  tab: Tab
  active: boolean
  theme: Theme
  fontFamily: string
  fontSize: number
  /** Line height, cursor, weights and the rest. Applied live, without a rebuild. */
  terminal: TerminalSettings
  /** The active profile's accent, or null. Recolours the cursor and selection. */
  accent: string | null
  /** Canvas opacity, below 1 only while a wallpaper is set. */
  alpha: number
  /** Stoke's dictation: the hold threshold and the chosen microphone, read per press. */
  voice: VoiceSettings
  /**
   * Clicking a link in the terminal opens it in the docked browser. Holding
   * Shift, or Cmd/Ctrl, sends it to the real browser instead — that path does
   * not come through here, since it needs no tab of Stoke's own.
   */
  onOpenUrl: (url: string) => void
  onRestart: (tab: Tab) => void
  onClose: (tabId: string) => void
  /** A kept SSH tab waiting to reconnect (`tab.reconnect`): try now, or stop trying. */
  onReconnectNow?: (tab: Tab) => void
  onStopReconnect?: (tabId: string) => void
  /** The machine an SSH tab runs on (`tab.hostId` in settings), for sending it images. */
  host?: SshHost | null
  /** "Set up key login" from the image strip, when ssh said Permission denied. */
  onSetUpKey?: (hostId: string) => void
  /**
   * Force restart, from the scrim over a terminal that stopped answering
   * (TerminalStallOverlay): kill the whole process tree and bring the tab back.
   */
  onForceRestart?: (tab: Tab) => Promise<boolean>
}

/**
 * "Reconnecting in 5 s" — its own component so the once-a-second tick
 * re-renders this line and not the whole terminal pane.
 */
function ReconnectCountdown({ at, attempt }: { at: number; attempt: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const secs = Math.max(0, Math.ceil((at - now) / 1000))
  return (
    <span>
      Connection lost — {secs > 0 ? `reconnecting in ${secs} s` : 'reconnecting…'}
      {attempt > 1 ? ` (try ${attempt})` : ''}. The shell is still running on the machine.
    </span>
  )
}

export function TerminalView({
  tab,
  active,
  theme,
  fontFamily,
  fontSize,
  terminal: termOpts,
  accent,
  alpha,
  voice,
  onOpenUrl,
  onRestart,
  onClose,
  onReconnectNow,
  onStopReconnect,
  host = null,
  onSetUpKey,
  onForceRestart
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  /** The light/dark class of the terminal's background, for the stall probe below. */
  const lightRef = useRef(false)
  /*
   * Is this terminal stuck, and is it the program or Stoke (shared/terminalStall.ts)?
   * Fed every output chunk and every `onData` from the pty effect below. Its
   * probe is the colour-scheme report a program on mode 2031 answers (gotcha
   * 42), sent with the class in force so nothing repaints.
   */
  const stall = useTerminalStall(() => window.stoke.pty.write(tab.ptyId, schemeProbe(lightRef.current)))
  const termRef = useRef<Terminal | null>(null)
  /** Read by the size claim (another machine's remote tab), which is bound once per pty. */
  const activeRef = useRef(active)
  activeRef.current = active
  /*
   * Images into an SSH tab: a pasted or dropped image is copied to the machine
   * and its far path typed (ImageSendStrip.tsx). `images.on` is false for every
   * other tab, and for a host whose images are turned off.
   */
  const images = useSshImages({ tab, host, termRef, onSetUpKey })
  /*
   * The one fit, callable from every effect that resizes.
   *
   * `applyFit` below refuses to measure a hidden pane, and that refusal is the
   * whole fix for a session being reflowed into a 20x5 box every time a tab
   * was switched. The font effect and the reveal effect each used to carry
   * their own `fit(); pty.resize()` pair WITHOUT the guard — so every zoom
   * chord refitted every background pane to a dozen columns. Assigned inside
   * the PTY effect once `applyFit` exists; a no-op before mount.
   */
  const fitNowRef = useRef<(why?: 'pane' | 'shown') => void>(() => {})
  /*
   * The drawing options as of the last render, for the constructor. The
   * terminal is built once per PTY (the effect below depends on `tab.ptyId`
   * alone), so it reads these through a ref rather than closing over the
   * first render's values; later changes arrive through the options effect.
   */
  const termOptsRef = useRef(termOpts)
  termOptsRef.current = termOpts
  const accentRef = useRef(accent)
  accentRef.current = accent
  const alphaRef = useRef(alpha)
  alphaRef.current = alpha
  /**
   * Whether the child has DEC mode 2031 on, i.e. has asked to be told when the
   * terminal's colour scheme changes. Set from the output stream, so it tracks
   * the process actually holding the terminal rather than the tab.
   */
  const themeNotifyRef = useRef(false)
  const fitRef = useRef<FitAddon | null>(null)
  /** xterm's search over this terminal's buffer, the find bar's screen engine. */
  const searchRef = useRef<SearchAddon | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  /*
   * The find bar (TerminalFind). Open state lives here, with the pane, so each
   * tab keeps its own query; `findSeq` is bumped by every open request so a
   * second Cmd+F re-focuses an open bar; the ref answers "is it open" inside
   * the opener without a render in between.
   */
  const [findOpen, setFindOpen] = useState(false)
  const [findSeq, setFindSeq] = useState(0)
  const [findInitial, setFindInitial] = useState('')
  const findOpenRef = useRef(false)
  /*
   * Dictation (Dictation.tsx): the held Space, the recorder and the strip, the
   * one copy this pane and a remote tab share. What is this pane's: who owns
   * Space here (Claude Code's own /voice on a local Claude tab, gotcha 79),
   * and that a transcript is pasted into this terminal.
   */
  const dictation = useDictation({
    hostRef,
    active,
    voice,
    target: {
      /*
       * If the CLI's setting cannot be read, dictation starts as before — a
       * missed hint costs a double recording the user can see, while refusing
       * would take a feature away on a read error.
       */
      refusal: async () => {
        /*
         * A tab that lends the microphone gives Space to the far claude's
         * /voice (`spaceOwner`'s third argument, gotcha 79): Stoke's dictation
         * would take the very repeats its hold detection reads.
         */
        if (spaceOwner(tab, false, micLentRef.current) === 'cli') {
          return micOwnsSpace(host ? host.label.trim() || host.alias.trim() : 'this machine')
        }
        const state = await window.stoke.audio.voiceState().catch(() => null)
        return state && spaceOwner(tab, state.claudeVoice) === 'cli' ? CLI_OWNS_SPACE : null
      },
      /*
       * term.input, not a pty write: it goes out through onData exactly as a
       * typed space does, so the draft tracking (`noteInput`) and selection
       * clearing see a keystroke.
       */
      typeSpace: () => termRef.current?.input(' ', true),
      deliver: async (text) => {
        const term = termRef.current
        if (!term || tab.status === 'exited') return SESSION_ENDED_WORDS
        /*
         * A local Claude tab gets the words TYPED (`typesDictation`): Claude
         * Code files a bracketed paste as `<pasted_content>`, and a message
         * that is nothing but one — dictate, then Enter — is not acted on
         * (gotcha 86). `pty.type` types them as the phone does, newlines as
         * ESC CR, and presses no Enter. Noted as a draft here, since main
         * writes them and onData never sees them.
         */
        if (typesDictation(tab)) {
          const parts = typingParts(text, SHORTCUT_TEXT_MAX)
          if (!parts.length) return null
          noteInput(tab.ptyId, parts.join(''))
          for (const part of parts) {
            if (!(await window.stoke.pty.type(tab.ptyId, part, false))) return SESSION_ENDED_WORDS
          }
          return null
        }
        /*
         * Everywhere else paste() rather than a raw pty write, for the reason
         * the clipboard path documents: it wraps the text in bracketed-paste
         * markers when the program has advertised DECSET 2004, so a transcript
         * with a newline in it does not submit the prompt early. Cleaned
         * first, like every paste (`pasteSafely`).
         */
        pasteSafely(term, text)
        return null
      }
    }
  })
  /*
   * The lent microphone (MicTunnel.tsx, shared/micTunnel.ts): an SSH tab whose
   * host has "Lend this computer's microphone" on. It only reports keys and the
   * pane's state to main, and opens the microphone when main says a connection
   * from the far `arecord` was admitted. Never an "Add key" or setup tab.
   */
  const micLent = tab.kind === 'session' && !!tab.hostId && !tab.enrollHostId && host?.micTunnel === true
  const micLentRef = useRef(micLent)
  micLentRef.current = micLent
  const mic = useMicTunnel({
    ptyId: tab.ptyId,
    lending: micLent && tab.status === 'running',
    host,
    hostRef,
    active,
    dictating: dictation.on,
    voice
  })
  /** Whether a file drag is currently over this pane, for the drop ring. */
  const [dropping, setDropping] = useState(false)
  /*
   * `dragleave` fires when the pointer crosses into a CHILD, and this pane is
   * full of them — xterm's canvases and the helper textarea. Counting enters
   * against leaves is what makes the ring survive the pointer moving across
   * the terminal rather than flickering off on the first child boundary.
   */
  const dragDepth = useRef(0)
  // Kept in a ref so the resize observer can read it without re-subscribing.
  const openUrlRef = useRef(onOpenUrl)
  openUrlRef.current = onOpenUrl
  /*
   * An image-only clipboard, pasted by a chord or the menu. An SSH tab sends
   * the image to its machine and types the far path, since the `claude` there
   * cannot read this clipboard. A local tab hands the agent its own paste key
   * so it reads the clipboard itself (`imagePasteKeys`: Ctrl+V, or Alt+V for
   * Claude Code on Windows). Refs, because the key handler is bound once per
   * pty and the tab can change under it.
   */
  const pasteImageRef = useRef<() => void>(() => {})
  pasteImageRef.current = () => {
    if (images.on) {
      images.pasteClipboard()
      return
    }
    /*
     * Through noteInput, never a bare pty write: the agent puts the image in
     * its prompt, which is a draft an automatic relaunch must not kill, and a
     * write straight to the pty never reached the draft tracking at all
     * (`looksTyped` counts the paste key alone as typing).
     */
    const keys = imagePasteKeys(window.stoke.platform, tab.cliId, !!tab.hostId)
    noteInput(tab.ptyId, keys)
    window.stoke.pty.write(tab.ptyId, keys)
  }
  /**
   * The context a paste chord is decided in (`pasteAction`): whether this tab
   * sends uploads, and the agent's own image paste key. A ref, because the key
   * handler is bound once per pty and the tab can change under it.
   */
  const pasteCtxRef = useRef(() => ({ isMac: IS_MAC, uploads: false, imageKey: '\x16' }))
  pasteCtxRef.current = () => ({
    isMac: IS_MAC,
    uploads: images.on,
    imageKey: imagePasteKeys(window.stoke.platform, tab.cliId, !!tab.hostId)
  })
  /**
   * Files a file manager copied. An SSH tab that sends uploads sends them to
   * the machine and types their far paths (gotcha 152); every other tab types
   * their full LOCAL paths, as dropping them does (`copiedFilesText`) — what
   * Finder also puts on as text is only the bare names, which named nothing in
   * the session's folder, and Explorer puts on no text at all. False when no
   * path could be read, for the caller to paste what else is there.
   */
  const pasteFilesRef = useRef<(how: 'upload' | 'paths') => boolean>(() => false)
  pasteFilesRef.current = (how) => {
    if (how === 'upload') {
      images.pasteFiles()
      return true
    }
    const term = termRef.current
    if (!term) return false
    const typed = copiedFilesText(window.stoke.clipboard.filePathsSync(), tab.hostId ? 'linux' : window.stoke.platform)
    if (!typed) return false
    if ('refusal' in typed) toast({ tone: 'error', title: 'Nothing pasted', description: typed.refusal })
    else pasteSafely(term, typed.text)
    return true
  }
  /**
   * One paste, decided by `pasteAction` and carried out here: the key handler,
   * the menu's Paste and App's route from a chrome button all come through it.
   * Returns the action; only `xterm` and `xterm-image` leave the key to xterm,
   * which only the key handler can hand it to (`runClipboardChord`).
   */
  const runPasteRef = useRef<(chord: ClipboardChord, clip: ClipboardPeek) => PasteAction>(() => 'nothing')
  runPasteRef.current = (chord, clip) => {
    const term = termRef.current
    const action = pasteAction(chord, clip, pasteCtxRef.current())
    switch (action) {
      case 'upload-files':
        pasteFilesRef.current('upload')
        break
      case 'type-paths':
        if (pasteFilesRef.current('paths')) break
        // No path could be read after all (the clipboard moved): paste what else is there.
        if (clip.text && term) {
          if (pasteSafely(term, clip.text)) noteCleaned('paste')
        } else if (clip.hasImage) pasteImageRef.current()
        break
      case 'text':
        if (term && pasteSafely(term, clip.text)) noteCleaned('paste')
        break
      case 'image':
        pasteImageRef.current()
        break
      case 'xterm-image':
      case 'xterm':
      case 'nothing':
        break
    }
    return action
  }

  // Build the terminal once per pty. Theme and font changes are applied in
  // separate effects rather than by rebuilding, so scrollback survives them.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const isMacPlatform = IS_MAC
    const opts = termOptsRef.current

    /*
     * Where the last press landed, so an activated link can tell a click from a
     * drag. xterm does not: it activates on mouseup and checks only that the
     * release is still inside the link's range (`Linkifier.ts:220-233`), with no
     * modifier test and no distance test. So dragging from a URL's first
     * character to its last — which is how anyone copies a URL — both selected
     * the text and yanked the browser panel open.
     */
    let downAt: { x: number; y: number } | null = null

    /*
     * One rule for every link the terminal can produce, whether WebLinksAddon
     * matched it with a regex or the program announced it as an OSC 8 hyperlink.
     *
     * A plain click opens it in the docked browser, which is the whole point of
     * having one. Shift, or the platform's own "open this elsewhere" modifier,
     * sends it to the real browser instead — Cmd on macOS, Ctrl everywhere else,
     * because a macOS Ctrl+click is the secondary click and is spoken for below.
     */
    const openLink = (event: MouseEvent, uri: string): void => {
      event.preventDefault()
      const action = terminalLinkClick(uri, event, downAt, isMacPlatform)
      if (action === 'external') window.stoke.openExternal(uri)
      else if (action === 'stoke') openUrlRef.current(uri)
    }

    const term = new Terminal({
      fontFamily,
      fontSize,
      lineHeight: opts.lineHeight,
      letterSpacing: opts.letterSpacing,
      cursorBlink: opts.cursorBlink,
      cursorStyle: opts.cursorStyle,
      /*
       * A bar when the pane loses focus, not xterm's default hollow block. The
       * default outline appears the moment focus leaves for the sidebar or a
       * popover, and on a bar-cursor terminal it reads as a second cursor.
       */
      cursorInactiveStyle: 'bar',
      fontWeightBold: opts.boldWeight,
      minimumContrastRatio: opts.contrastBoost,
      smoothScrollDuration: opts.smoothScroll ? 100 : 0,
      // WebGL-only: glyphs wider than their cell are scaled to fit rather than
      // painted over the next one, which is what a wide ligature otherwise does.
      rescaleOverlappingGlyphs: true,
      scrollback: 20_000,
      /*
       * A kept SSH tab only (gotcha 126): tmux clears the screen with `CSI 2J`
       * when it attaches, and xterm's default ED2 simply blanks what is there.
       * A reconnect prints the session's history into this fresh terminal just
       * before attaching, so the default wiped the last screenful of it — 29
       * of the 30 lines above the prompt, measured. With this on, ED2 pushes
       * the screen into the scrollback instead (PuTTY's and Terminal.app's
       * behaviour), and nothing between the history and the live screen is
       * lost. Other tabs keep xterm's default.
       */
      scrollOnEraseInDisplay: !!tab.remoteSession,
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
       * gesture through a real xterm in a real Chromium under mouse reporting
       * (1000/1002/1006 by default; 2.1.237 also asks for 1003, any-event
       * motion, which the `triggerDataEvent` guard further down handles). With
       * the default the one-character drag comes back "", with this line it
       * comes back intact, and every other case is identical either way. That
       * suite is the reason this is a one-line change rather than a guess.
       *
       * Nothing is lost by turning it off: Option-click-to-move-cursor is a
       * readline convenience that never worked here anyway, since Option is
       * spoken for.
       */
      altClickMovesCursor: false,
      /*
       * OSC 8 hyperlinks — the ones npm, vite, gh, cargo and docker emit — are
       * handled by xterm's own `OscLinkProvider`, which is registered in the
       * constructor and so wins over any addon on a cell carrying a urlId.
       * Without a handler here it falls back to `defaultActivate`
       * (`OscLinkProvider.ts:114-129`): a blocking `confirm()` calling the link
       * "potentially dangerous", and then `window.open()` with *no argument* —
       * which arrives at the main window's handler as `about:blank`, fails its
       * `/^https?:/i` test (`index.ts:648-651`) and is denied. So the dialog was
       * followed by nothing at all. Routing it through the same rule as every
       * other link is both safer and the only way these links ever open.
       */
      linkHandler: { activate: openLink },
      theme: terminalTheme(theme, accentRef.current, alphaRef.current)
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

    // Before the ordinary web provider: repair a URL repainted across full
    // rows by SSH/tmux, whose explicit CRLF/CUP did not set isWrapped.
    term.registerLinkProvider({ provideLinks: (line, done) => done(terminalLinkRepairs(term, line).map((link) => ({ ...link, activate: openLink }))) })
    term.loadAddon(new WebLinksAddon(openLink))

    /*
     * The find bar's screen engine. It searches `buffer.active` only: the
     * scrollback on a normal-buffer tab, just the visible rows on the alternate
     * screen a fullscreen Claude Code draws on — which is why the bar also
     * searches the transcript. Decorations need `allowProposedApi`, set above.
     */
    const searcher = new SearchAddon({ highlightLimit: 2000 })
    term.loadAddon(searcher)
    searchRef.current = searcher

    /*
     * OSC 52, the only way text copied on the far side of an SSH connection can
     * reach this machine's clipboard. `pbcopy` writes to the *remote* clipboard;
     * tmux copy-mode and `vim "+y` have no other channel. xterm ships no handler
     * — 52 is listed as unimplemented in `InputHandler.ts` — so before this,
     * copying inside a VPS session simply had nowhere to go.
     *
     * The read direction is refused, not answered. `OSC 52 ; c ; ?` asks the
     * terminal to *report* the clipboard, and everything a terminal renders is
     * untrusted: a hostile file printed with `cat` could otherwise read whatever
     * the user last copied, passwords included. Writing is the safe half, and
     * the half anyone actually wants — once it cannot plant controls: the text
     * is cleaned before it reaches the clipboard (`osc52Write`), or the next
     * paste anywhere could end its own bracket and type a command.
     */
    term.parser.registerOscHandler(52, (data) => {
      const write = osc52Write(data)
      if (write) {
        window.stoke.clipboard.writeText(write.text)
        if (write.cleaned) noteCleaned('copy')
      }
      return true
    })

    term.open(host)

    // The registry also publishes the map as `window.stokeTerminals` for CDP
    // probes; there used to be a second copy of it kept here.
    registerTerm(tab.ptyId, term)

    /*
     * WebGL is a large win on a busy terminal but is unavailable on some GPUs
     * and inside remote sessions; the DOM renderer is the fallback.
     *
     * A lost context is got back, not lived without. It used to be disposed and
     * never replaced, so a terminal that lost its context once — sleep and
     * wake, a GPU reset, or a 17th terminal making Chromium drop the oldest of
     * its 16 — drew on the DOM renderer for the rest of the session. Measured
     * with two sessions streaming 150 KB/s: renderer CPU 12.9% -> 76.9% of a
     * core, and keydown input delay p90 0.8 -> 11.6 ms. A fresh addon costs
     * about 12 ms and one long frame, and brought it back to 10.3%.
     *
     * Only a pane that is showing asks for one (`applyFit` asks again when a
     * hidden pane is shown): a background tab has nothing to draw, and taking
     * a context for it would only make Chromium drop somebody else's. A
     * context that is lost again within `WEBGL_QUICK_LOSS_MS` counts against
     * the GPU; after `WEBGL_MAX_QUICK_LOSSES` in a row it stays on the DOM.
     */
    let webgl: WebglAddon | null = null
    let webglBornAt = 0
    let webglQuickLosses = 0
    let webglTimer: ReturnType<typeof setTimeout> | undefined
    const attachWebgl = (): void => {
      if (webgl || webglQuickLosses >= WEBGL_MAX_QUICK_LOSSES) return
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          addon.dispose()
          if (webgl !== addon) return
          webgl = null
          webglQuickLosses = performance.now() - webglBornAt < WEBGL_QUICK_LOSS_MS ? webglQuickLosses + 1 : 0
          clearTimeout(webglTimer)
          webglTimer = setTimeout(attachWebgl, WEBGL_RETRY_MS * 2 ** webglQuickLosses)
        })
        term.loadAddon(addon)
        webgl = addon
        webglBornAt = performance.now()
      } catch {
        /* stay on the DOM renderer */
        webglQuickLosses = WEBGL_MAX_QUICK_LOSSES
      }
    }
    attachWebgl()

    termRef.current = term
    fitRef.current = fit

    const viewportKey = tab.hostId && tab.remoteSession ? `${tab.hostId}:${tab.remoteSession}` : null
    let bookmark = viewportKey ? takeSshViewport(viewportKey) : undefined
    let viewportDisposed = false
    const cancelBookmark = (): void => { bookmark = undefined }
    host.addEventListener('wheel', cancelBookmark, { passive: true })
    host.addEventListener('pointerdown', cancelBookmark, true)
    host.addEventListener('keydown', cancelBookmark, true)
    // SSH prints the tmux history only after authentication, asynchronously.
    // Wait for the visible line to arrive; never restore against the banner.
    const viewportDeadline = bookmark ? setTimeout(() => {
      if (!viewportDisposed && bookmark) restoreTerminalViewport(term, bookmark)
      bookmark = undefined
    }, 15_000) : undefined

    // Before the replay: what the history holds is this pty's output too.
    stall.start()
    const detach = attachSink(tab.ptyId, (data) => {
      stall.output(data)
      /*
       * Track whether the child has asked to be told about colour-scheme
       * changes, so the nudge below is only ever sent to something expecting it.
       *
       * DEC private mode 2031. Claude Code turns it on for the whole time it
       * holds the terminal in raw mode and off again on exit, so this flag
       * tracks the child rather than the session: on an SSH tab running byobu
       * it goes true when `claude` starts inside a pane and false at the shell
       * prompt, which is exactly the distinction that matters. Writing the
       * report to a bare shell would type it at the prompt.
       *
       * A substring test, not a parse, because the sequence can arrive split
       * across reads in principle -- but it is emitted alone at raw-mode entry
       * in practice, and a missed one costs a repaint that the next OSC 11
       * query fixes anyway. Cheap and wrong-in-the-safe-direction.
       */
      if (data.includes('\x1b[?2031h')) themeNotifyRef.current = true
      if (data.includes('\x1b[?2031l')) themeNotifyRef.current = false
      term.write(data, () => {
        if (!viewportDisposed && bookmark && restoreTerminalViewport(term, bookmark, true)) bookmark = undefined
      })
    })
    const onInput = term.onData((data) => {
      // Noted before the write: an automatic relaunch must not kill a session
      // with a draft in its prompt box, and the registry cannot see one.
      noteInput(tab.ptyId, data)
      // Only what a person typed starts the stall clock (`isTypedInput`).
      stall.input(data)
      window.stoke.pty.write(tab.ptyId, data)
    })

    /*
     * One copy or paste chord, decided by `copyAction`/`pasteAction`
     * (shared/clipboardText.ts, held by verify:drop) and carried out here. The
     * key handler below and App's route from a chrome button
     * (`registerClipboardKeys`) both come through it, so a paste from either
     * takes the same route: files, an image, cleaned text.
     *
     * `take`: Stoke acted, and the key is cancelled. The preventDefault is
     * load-bearing: returning false only stops xterm processing the key; the
     * browser still fires its own copy/paste event on xterm's hidden textarea,
     * and xterm listens for it. Without it, Ctrl+V pasted twice - verified in
     * the running app, where a three-line paste arrived as six lines.
     * `xterm`: the key is xterm's (^C is SIGINT, ^V the agent's own paste).
     * `browser`: neither acts — Cmd+C with nothing selected.
     */
    const runClipboardChord = (chord: ClipboardChord, fromKey: boolean): ClipboardKeyVerdict => {
      if (chord.op === 'paste') {
        /*
         * xterm's paste() rather than a raw pty write. It normalises CRLF and
         * wraps the text in bracketed-paste markers when - and only when - the
         * CLI has actually advertised DECSET 2004. Writing raw made every
         * newline in a multi-line paste act as Enter, so pasting a stack trace
         * fired one prompt per line and Windows CRLF could submit twice. And
         * cleaned first (`pasteSafely`): xterm brackets the text as it is, so a
         * clipboard holding its own ESC[201~ ended the bracket and the rest
         * arrived as typed keys, its next CR submitting them.
         */
        const action = runPasteRef.current(chord, window.stoke.clipboard.readSync())
        /*
         * xterm's own ^V is the agent's image paste, and the image then sits
         * in its prompt: a draft. Only from the key handler — App's route from
         * a chrome button has no xterm to hand the key to, so there nothing
         * was pasted and nothing may be marked.
         */
        if (action === 'xterm-image' && fromKey) setTyped(tab.ptyId, true)
        return action === 'xterm' || action === 'xterm-image' ? 'xterm' : 'take'
      }
      const sel = term.getSelection()
      /*
       * A selection can be visible and still be the empty string: xterm's
       * `hasSelection` compares coordinates while `selectionText` trims blank
       * cells (`SelectionService.ts:191-198`, `:205-250`), so a drag across
       * the padding inside Claude Code's prompt box highlights real cells and
       * yields "". Letting Chromium's own copy event run then overwrote the
       * clipboard with an empty string (xterm's copy listener gates only on
       * `hasSelection`), and a bare Ctrl+C sent ^C — clearing the draft or
       * interrupting the turn under a highlight. Both are swallowed: copying
       * nothing is a no-op, not a reason to lose what you had.
       *
       * Bare Ctrl+C copies only when something is selected, the way Windows
       * Terminal behaves, and clears the selection after, so a second press
       * interrupts: a selection left lying around would otherwise quietly stop
       * Ctrl+C from interrupting Claude, the most pressed key in the app.
       */
      switch (copyAction(chord, sel, term.hasSelection())) {
        case 'copy':
          window.stoke.clipboard.writeText(sel)
          return 'take'
        case 'copy-clear':
          window.stoke.clipboard.writeText(sel)
          term.clearSelection()
          return 'take'
        case 'swallow':
          return 'take'
        case 'swallow-clear':
          term.clearSelection()
          return 'take'
        case 'xterm':
          return 'xterm'
        case 'browser':
          return 'browser'
      }
    }

    // Keep the OS clipboard shortcuts working; everything else goes to the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true

      // Swallow app shortcuts so they act on the window instead of being sent
      // to Claude as keystrokes. App.tsx handles them on the window listener.
      if (matchShortcut(e, IS_MAC)) return false

      /*
       * The letter by `chordLetter` (inside `clipboardChord`), never `e.key`
       * alone: on a Cyrillic or Greek layout Ctrl+C reports `с`, no branch
       * matched, and xterm — which keys bare Ctrl by keyCode — sent ^C, an
       * interrupt instead of a copy; Ctrl+V sent ^V.
       */
      const chord = clipboardChord(e, IS_MAC)
      if (!chord) return true
      const verdict = runClipboardChord(chord, true)
      if (verdict === 'take') e.preventDefault()
      return verdict === 'xterm'
    })
    const offClipboardKeys = registerClipboardKeys(tab.ptyId, (chord) => runClipboardChord(chord, false))

    /*
     * Take the right-click before xterm can see it. Claude Code turns mouse
     * reporting on, so xterm forwards the press to the PTY and the CLI answers
     * by pasting the clipboard itself - a right-click therefore pasted AND
     * opened this menu. Verified in the running app: a three-line clipboard
     * became six lines on right-click alone. Capture phase on the host stops
     * the event ever reaching xterm's listeners further down the tree.
     */
    /*
     * Clones this shim dispatched, so nothing downstream — including this file's
     * own listeners — judges a synthetic event as if the user had made it.
     * Declared here rather than beside `onShiftDrag` because `onMouseDown` below
     * has to consult it too.
     */
    const retold = new WeakSet<MouseEvent>()

    /*
     * The button whose press was swallowed, so its release can be swallowed too
     * and nothing else's can. Null when the last press went through.
     */
    let swallowed: number | null = null

    const onMouseDown = (e: MouseEvent): void => {
      /*
       * A macOS Ctrl+click is the secondary click, but Chromium does not renumber
       * the button for it: Blink dispatches the context menu off the *left*
       * button carrying Control, so `e.button` is 0 and `e.ctrlKey` is true.
       * (Firefox is the engine that remaps to button 2, which is why xterm binds
       * its own right-click through `contextmenu` instead —
       * `CoreBrowserTerminal.ts:346-358`.) Keyed on the button number alone, this
       * guard let a Ctrl+click through to do three things at once: report a click
       * to the CLI, open Stoke's menu, and activate whatever link was under it.
       * Now it means one thing, the same thing a right-click means everywhere.
       */
      const secondary = e.button === 2 || (isMacPlatform && e.button === 0 && e.ctrlKey)

      if (e.type === 'mousedown') {
        /*
         * Never re-judge our own clone. `onShiftDrag` runs before this listener
         * and re-dispatches the press, and that clone travels the full capture
         * path — so it arrives back here, and on macOS a Shift+Ctrl-drag matched
         * `secondary` above and was stopped dead. Two of this file's own
         * listeners cancelled each other and the gesture did nothing at all:
         * no selection, and no mouse report either.
         */
        if (retold.has(e)) return
        /*
         * `retold` alone is not enough: it only protects the *clone* from being
         * re-judged, not the original press that `onShiftDrag` already claimed.
         * `stopPropagation()` does not stop a sibling listener on the same node
         * — the two are registered on `host`, same phase, same event type — so
         * after `onShiftDrag` calls `preventDefault()` and re-dispatches a
         * Shift+Ctrl-drag as a synthetic selection drag, this handler still runs
         * on the *original* event next, sees `secondary` (Ctrl+click) true, and
         * sets `swallowed`. The matching mouseup is then stopped at capture and
         * never reaches document, so `SelectionService` never runs
         * `_removeMouseDownListeners` for the drag the clone started — the exact
         * leak this function exists to prevent, just reached through the
         * original event instead of the clone.
         *
         * `e.defaultPrevented` is the fix: `onMouseDown` and `onShiftDrag` are
         * bound to the same node, same phase, in that registration order, so
         * the DOM guarantees they run synchronously on the *same* event object
         * — `onShiftDrag`'s `preventDefault()` is visible here before this line
         * runs. Nothing else in this effect calls `preventDefault()` on a
         * mousedown before this point, so the flag means exactly one thing:
         * this press has already been claimed and re-dispatched as a clone, and
         * must not also be treated as a swallowed secondary click.
         */
        swallowed = secondary && !e.defaultPrevented ? e.button : null
        if (secondary) e.stopPropagation()
        return
      }

      /*
       * A release is swallowed only when its own press was.
       *
       * Stopping any other release is not a smaller version of the same idea, it
       * is a leak. `SelectionService` adds its drag listeners to the *document*
       * (`SelectionService.ts:_addMouseDownListeners`), and this listener is on
       * an ancestor in the CAPTURE phase — so a stopped mouseup never reaches
       * document, `_removeMouseDownListeners` never runs, and both the document
       * mousemove handler and the 50ms drag-scroll interval outlive the drag.
       * The terminal is then left extending the selection at whatever the
       * pointer passes over with no button held, and every later drag orphans
       * another interval. Reachable by pressing the right button, or Control on
       * a Mac, part-way through an ordinary left drag.
       */
      if (swallowed !== null && e.button === swallowed) {
        swallowed = null
        e.stopPropagation()
      }
    }

    const onDownPoint = (e: MouseEvent): void => {
      downAt = { x: e.clientX, y: e.clientY }
    }

    /*
     * Shift-drag selects on every platform, in either mouse mode.
     *
     * xterm decides this internally and offers no hook for it —
     * `shouldForceSelection` is
     *
     *   isMac ? event.altKey && rawOptions.macOptionClickForcesSelection
     *         : event.shiftKey
     *
     * (SelectionService.ts:437) — so there is no option meaning "use Shift on a
     * Mac". Rather than patch the library, the event is retold: a Shift-drag is
     * caught in the capture phase and re-dispatched as the same event with
     * `altKey` set, which is the only thing xterm will accept here.
     * `verify:selection` drives xterm entirely with synthetic MouseEvents, so
     * that they work is measured rather than hoped for.
     *
     * This does NOT turn into a block selection, which is the obvious thing to
     * fear from a synthetic Alt. `shouldColumnSelect` is
     * `altKey && !(isMac && macOptionClickForcesSelection)` (:591-593), so with
     * that option on — and it is, just above — Alt can never mean column-select
     * on a Mac. xterm gates it exactly so the two meanings cannot collide.
     *
     * Option-drag keeps working, because the option it needs is still on. Two
     * modifiers, one gesture, and nobody's habit is wrong.
     *
     * Only mousedown is retold. It is what starts a selection and the only
     * event whose modifiers are read; xterm tracks the rest of the drag through
     * its own document-level move and up listeners, which take no modifiers.
     *
     * With reporting OFF the clone must drop Shift rather than merely add Alt,
     * and that is the whole reason a VPS session could not be copied out of.
     * (With reporting ON the opposite holds off macOS, where Shift is exactly
     * what xterm wants — see the clone below.) xterm branches on whether
     * selection is *enabled* before it ever consults the force-selection
     * modifier:
     *
     *   if (this._enabled && event.shiftKey) { this._handleIncrementalClick(e) }
     *   else                                 { … _handleSingleClick(e) … }
     *
     * (SelectionService.ts:478). `_enabled` is true exactly when mouse reporting
     * is *off* (`CoreBrowserTerminal.ts:547-552`, `:731-739`), and
     * `_handleIncrementalClick` (`:523-527`) is a no-op when nothing is selected
     * yet — it only ever moves the end of an existing selection. So a Shift-drag
     * with Shift still set selected nothing at any plain shell prompt, while
     * working fine under `claude`. A local tab always runs `claude` and reports
     * the mouse for its whole life, so it never showed; an SSH tab is the only
     * tab that sits at a shell, which is why this read as "copying is broken on
     * the VPS" and nowhere else. Dropping Shift lands both modes on
     * `_handleSingleClick`, which is what starts a selection.
     *
     * Which is also why this is no longer macOS-only. Off macOS xterm reads
     * Shift directly (`:442`) and needs no help *while the mouse is reported* —
     * but at a shell prompt it walks into the same dead branch, natively. So the
     * retelling is keyed on the mode rather than the platform, and Alt is added
     * only where it is the thing xterm demands: macOS with reporting on.
     */
    const onShiftDrag = (e: MouseEvent): void => {
      if (e.button !== 0 || e.altKey) return
      // Our own clone, coming back around: let it through or this recurses.
      if (retold.has(e)) return

      const reporting = term.modes.mouseTrackingMode !== 'none'

      /*
       * Two mouse modes, and the retelling each needs is different — so the
       * cases are split rather than papered over with one clone shape.
       */
      if (reporting) {
        /*
         * The program owns the mouse. A drag only becomes a selection if it
         * carries the bypass modifier.
         *
         * There used to be a "Copy mode" here that made every unmodified drag
         * select while it was on. It was removed in 0.9: it existed to paper
         * over Shift-drag being undiscoverable, and the right-click hint, the
         * OSC 52 handler and `Copy screen` cover every case it did without a
         * mode to be in — and a mode that takes Escape away from the pane was
         * costing more than it saved.
         */
        if (!e.shiftKey) return
        // Off macOS a real Shift-drag needs no help — `shouldForceSelection` is
        // `event.shiftKey` there (`:442`) and xterm has already decided.
        if (!isMacPlatform) return
      } else {
        /*
         * No reporting: a plain drag already selects on every platform, so
         * Shift is the only gesture that needs rescuing here.
         */
        if (!e.shiftKey) return
        /*
         * Reporting off, with something already selected: here the branch below
         * is not a dead end but a feature — Shift-click extends a selection,
         * which is what every other terminal does too. Left alone deliberately.
         */
        if (term.hasSelection()) return
      }

      e.preventDefault()
      e.stopPropagation()

      const clone = new MouseEvent(e.type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        button: e.button,
        buttons: e.buttons,
        // Carried through: a double-click still selects a word, a triple a line.
        detail: e.detail,
        /*
         * Whichever modifier xterm reads on this platform, and only while the
         * program owns the mouse. `shouldForceSelection` is
         * `isMac ? altKey && macOptionClickForcesSelection : shiftKey`
         * (`:437-443`), so macOS is told Alt. Off macOS the clone is never
         * dispatched with reporting on (the early return above), because xterm
         * reads the real Shift there itself. `shouldColumnSelect` cannot fire:
         * it is `altKey && !(isMac && macOptionClickForcesSelection)`
         * (`:591-593`) and that option is on, so on macOS Alt cannot also mean
         * column-select.
         */
        altKey: reporting && isMacPlatform,
        /*
         * Never kept. With reporting OFF xterm branches on `_enabled &&
         * shiftKey` first (`:478`) and lands on the extend branch, which is a
         * no-op with nothing selected — that is what made a plain shell prompt
         * impossible to select in. With reporting ON the only clone that
         * reaches here is macOS's, and there Shift is not what xterm reads.
         */
        shiftKey: false,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey
      })
      retold.add(clone)
      e.target?.dispatchEvent(clone)
    }
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      // Only line breaks between blank rows is as blank as "" (`selectionHasText`).
      const raw = term.getSelection()
      const selection = selectionHasText(raw) ? raw : ''
      setMenu({
        x: e.clientX,
        y: e.clientY,
        selection,
        link: selectedTerminalLink(selection),
        blank: selection === '' && term.hasSelection(),
        clip: window.stoke.clipboard.readSync()
      })
    }
    // The press point is recorded first, so it is already right when the shim
    // below re-dispatches and when a link activates on the matching mouseup.
    host.addEventListener('mousedown', onDownPoint, true)
    host.addEventListener('mousedown', onShiftDrag, true)
    host.addEventListener('mousedown', onMouseDown, true)
    host.addEventListener('mouseup', onMouseDown, true)
    host.addEventListener('contextmenu', onContextMenu, true)

    /*
     * The copy and paste EVENTS, which reach xterm without passing the key
     * handler: the Edit menu (Stoke sets no app menu, so Electron's default one
     * is live — Edit › Copy and Paste on macOS), Shift+Insert, and Linux's
     * middle-click paste of the primary selection.
     *
     * Copy: xterm's listener gates only on `hasSelection`, so with a blank-cell
     * selection (see `runClipboardChord`) it wrote "" and wiped the clipboard,
     * the case the key handler swallows. Stopped before xterm sees it — never
     * preventDefault'ed, because a cancelled copy event writes its data, empty
     * or not; uncancelled, the browser's own copy finds no page selection and
     * leaves the clipboard alone.
     *
     * Paste: xterm's listener pastes the event's text as it is, so it is taken
     * here and pasted cleaned. The event's own data, not a fresh read: a middle
     * click pastes the primary selection, which is not the clipboard.
     */
    const onCopyEvent = (e: ClipboardEvent): void => {
      if (!selectionHasText(term.getSelection())) e.stopPropagation()
    }
    const onPasteEvent = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (pasteSafely(term, text)) noteCleaned('paste')
    }
    host.addEventListener('copy', onCopyEvent, true)
    host.addEventListener('paste', onPasteEvent, true)

    /*
     * Last active wins (shared/sizeClaim.ts). While another machine's remote
     * tab holds this pty's grid (`elsewhere`, told by main as `pty:sized`),
     * this pane draws THAT grid — empty space round it, or a scroll — and
     * fits itself again only when someone uses it here: a focus, a key, a
     * click, or the pane changing size while it holds the keyboard. The other
     * machine's resize never counts, so the two never fight over it. With no
     * remote tab attached `elsewhere` is null and every fit is exactly as it
     * was. A phone resizes the pty through the phone server, which tells the
     * renderer nothing, so a phone's Fit to phone is unchanged too (gotcha 87).
     */
    let elsewhere: Grid | null = null
    const proposed = (): Grid | null => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return null
      const p = fit.proposeDimensions()
      return p && isGrid(p) ? { cols: p.cols, rows: p.rows } : null
    }
    const setElsewhere = (g: Grid | null): void => {
      elsewhere = g
      if (g) host.dataset.sizedElsewhere = `${g.cols}x${g.rows}`
      else delete host.dataset.sizedElsewhere
    }
    const fitHere = (): void => {
      try {
        fit.fit()
        window.stoke.pty.resize(tab.ptyId, term.cols, term.rows)
      } catch {
        /* host detached mid-measure */
      }
    }
    const claimer = new SizeClaimer({
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      want: proposed,
      have: () => elsewhere ?? { cols: term.cols, rows: term.rows },
      send: () => {
        setElsewhere(null)
        fitHere()
      }
    })
    const use = (kind: ClaimTrigger): void => {
      if (!elsewhere) return
      claimer.trigger(kind, {
        shown: activeRef.current && host.clientWidth > 0,
        focused: host.contains(document.activeElement),
        windowFocused: document.hasFocus(),
        recentInput: recentlyUsed()
      })
    }
    const onUseFocus = (): void => use('focus')
    const onUseKey = (): void => use('key')
    const onUsePress = (): void => use('click')
    host.addEventListener('focusin', onUseFocus)
    host.addEventListener('keydown', onUseKey, true)
    host.addEventListener('mousedown', onUsePress, true)
    const offSized = window.stoke.pty.onSized((id, cols, rows, reason) => {
      if (id !== tab.ptyId) return
      const g = { cols, rows }
      claimer.sized(g)
      if (reason === 'restore') {
        // The last remote tab left and main put this desktop's size back: fit the pane, nobody else holds it.
        claimer.dispose()
        setElsewhere(null)
        applyFit()
        return
      }
      const mine = proposed()
      setElsewhere(mine && sameGrid(mine, g) ? null : g)
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
    })

    const applyFit = (why: 'pane' | 'shown' = 'pane'): void => {
      /*
       * A hidden pane has no size, and measuring one is how a backgrounded
       * session gets permanently mangled.
       *
       * An inactive tab's pane is `display: none`, so `host.clientWidth` is 0.
       * FitAddon divides that by the cell width and arrives at roughly twelve
       * columns; `pty.resize` clamps it to 20x5 and sends that to the CLI,
       * which reflows its whole TUI into a 20-column box. Nothing un-reflows
       * it when the tab comes back — the text has already been rewritten with
       * hard wraps — so every tab switch degrades the session you switched
       * away from, cumulatively. Measured: a single session tab plus the New
       * session tab is enough to trigger it, because the ResizeObserver fires
       * for the hidden pane as the layout settles.
       *
       * Returning early is the whole fix. The observer fires again with real
       * numbers the moment the pane is shown, which is when a fit is wanted
       * anyway.
       */
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      // Shown again: a context lost while hidden is got back now.
      attachWebgl()
      // Another machine holds the grid: only use here takes it back (a reveal is a tab switched to).
      if (elsewhere) {
        use(why === 'shown' ? 'focus' : 'pane')
        return
      }
      fitHere()
    }

    // Observe the host rather than the window: the sidebar and browser panel
    // resize the pane without the window changing size at all.
    /*
     * Stop a bare mouse *move* from destroying the selection.
     *
     * xterm routes every mouse report through
     * `CoreService.triggerDataEvent(report, true)`, and that `true` means "user
     * input", which `SelectionService` clears the selection on. Claude Code
     * 2.1.237 turns on mode 1003 (any-event tracking), so the terminal now
     * receives a motion report for every pointer move with no button held — and
     * each one wiped whatever was selected. One pixel was enough, which made
     * right-click -> Copy unreachable: right-clicking means moving the pointer.
     *
     * The report itself is untouched, so the CLI still gets every byte and
     * click-to-focus inside its TUI still works. Only the "this was user input"
     * claim is withdrawn, and only for movement with nothing pressed —
     * `isButtonlessMotionReport` is the whole rule and `verify:selection` owns
     * it.
     *
     * Reached through `_core` because `coreService` is not on the public
     * Terminal surface. Guarded rather than assumed: if a future xterm moves it,
     * this silently does nothing instead of throwing on mount, which is the
     * right failure for a fix to a copy-and-paste annoyance.
     */
    const coreService = (
      term as unknown as {
        _core?: { coreService?: { triggerDataEvent(data: string, wasUserInput?: boolean): void } }
      }
    )._core?.coreService
    if (coreService) {
      const sendData = coreService.triggerDataEvent.bind(coreService)
      coreService.triggerDataEvent = (data: string, wasUserInput = false): void => {
        sendData(data, wasUserInput && !isButtonlessMotionReport(data))
      }
    }

    /*
     * The BORDER box (gotcha 151): `.term-host` has no padding or border, so it
     * is the content box until a remote tab's larger grid scrolls here — and
     * then the scrollbars would read as a resize and take the grid straight back.
     */
    const ro = new ResizeObserver(() => applyFit())
    ro.observe(host, { box: 'border-box' })
    applyFit()
    fitNowRef.current = applyFit

    return () => {
      clearTimeout(webglTimer)
      viewportDisposed = true
      clearTimeout(viewportDeadline)
      if (viewportKey) rememberSshViewport(viewportKey, bookmark ?? captureTerminalViewport(term))
      host.removeEventListener('wheel', cancelBookmark)
      host.removeEventListener('pointerdown', cancelBookmark, true)
      host.removeEventListener('keydown', cancelBookmark, true)
      fitNowRef.current = () => {}
      ro.disconnect()
      claimer.dispose()
      offSized()
      host.removeEventListener('focusin', onUseFocus)
      host.removeEventListener('keydown', onUseKey, true)
      host.removeEventListener('mousedown', onUsePress, true)
      host.removeEventListener('mousedown', onDownPoint, true)
      host.removeEventListener('mousedown', onShiftDrag, true)
      host.removeEventListener('mousedown', onMouseDown, true)
      host.removeEventListener('mouseup', onMouseDown, true)
      host.removeEventListener('contextmenu', onContextMenu, true)
      host.removeEventListener('copy', onCopyEvent, true)
      host.removeEventListener('paste', onPasteEvent, true)
      offClipboardKeys()
      detach()
      stall.stop()
      onInput.dispose()
      term.dispose()
      unregisterTerm(tab.ptyId)
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      // The bar searched THIS terminal; a relaunch's new one starts without it.
      findOpenRef.current = false
      setFindOpen(false)
    }
    // Rebuild only when the process changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.ptyId])

  /*
   * Everything on the visible screen, with no selection involved.
   *
   * The viewport rather than the whole buffer, because the viewport is what the
   * user is looking at when they decide they want it — and on the tab that
   * prompted this it is also all there is. A pane running Claude Code is on the
   * alternate screen, so tmux keeps no history for it, and byobu deletes
   * smcup/rmcup from the outer terminal's capabilities, so nothing scrolls into
   * Stoke's scrollback either. `Select all` remains the way to take the buffer
   * on a tab that has one.
   *
   * The walk itself lives in `termRegistry`'s `screenOf` now — the tab snapshot
   * needs the same screen for every tab at once, so this calls the same helper
   * rather than repeating it. With `joinWrapped`, because this is text someone
   * takes away: a long URL or command soft-wrapped across rows comes back in
   * one piece, as a Shift-drag selection of the same rows already did, where
   * the snapshot keeps its rows to draw them back as they were.
   */
  const copyScreen = (): void => {
    const text = screenOf(tab.ptyId, { joinWrapped: true })
    if (text) window.stoke.clipboard.writeText(text)
    termRef.current?.focus()
  }

  /*
   * Open the find bar, or focus and select it when it is open already. The
   * first open starts from the selection when that is one short line — select
   * a word, Cmd+F, and it is the query.
   */
  const openFind = useCallback((): void => {
    const term = termRef.current
    if (!term) return
    if (!findOpenRef.current) {
      const sel = term.getSelection()
      setFindInitial(sel && !/[\r\n]/.test(sel) && sel.length <= 200 ? sel : '')
      findOpenRef.current = true
      setFindOpen(true)
    }
    setFindSeq((s) => s + 1)
  }, [])

  const closeFind = useCallback((): void => {
    findOpenRef.current = false
    setFindOpen(false)
    termRef.current?.focus()
  }, [])

  // Cmd+F (App), the palette's row and the browser's listener reach the bar of
  // the pane in front through the registry; a hidden pane is not listed.
  useEffect(() => {
    if (!active) return
    return registerFinder(tab.ptyId, openFind)
  }, [active, tab.ptyId, openFind])

  /*
   * The find bar floats top-right and grows with its hits; the image strip and
   * the exit card float bottom-right (the foot), and the dictation strip
   * shares the bar's corner (shared/paneFloats.ts). Same z-index, later in the
   * pane: on a short pane the foot's floats painted over the bar's last hits,
   * which no scroll could bring out from under them. While the bar is open the
   * tallest of them is its floor (`--find-floor`, app.css), and a dictation
   * strip up there is its ceiling (`--find-ceiling`): the strip keeps its
   * place and the bar starts below it. Kept with a ResizeObserver as an
   * error's ssh line wraps, a thumbnail arrives or kept words appear.
   */
  // Which floats are drawn: the dictation strip's variants change its height.
  const floatsKey = `${images.strip ? 1 : 0}${tab.status === 'exited' ? 1 : 0}${mic.strip ? 3 : dictation.stripKey}`
  useLayoutEffect(() => {
    const pane = hostRef.current?.parentElement
    if (!pane || !findOpen) return
    const foot = Array.from(pane.querySelectorAll<HTMLElement>(FOOT_FLOATS))
    const corner = Array.from(pane.querySelectorAll<HTMLElement>(CORNER_FLOATS))
    const put = (name: string, value: string | null): void => {
      if (value) pane.style.setProperty(name, value)
      else pane.style.removeProperty(name)
    }
    const set = (): void => {
      put('--find-floor', floatInset(foot.map((el) => el.offsetHeight)))
      put('--find-ceiling', floatInset(corner.map((el) => el.offsetHeight)))
    }
    set()
    const ro = new ResizeObserver(set)
    for (const el of [...foot, ...corner]) ro.observe(el)
    return () => {
      ro.disconnect()
      pane.style.removeProperty('--find-floor')
      pane.style.removeProperty('--find-ceiling')
    }
  }, [findOpen, floatsKey])

  /*
   * The foot's floats, for the toasts in `.main-col`'s bottom-right corner
   * (Toaster): while this pane is the one in front, how far above the column's
   * foot their tops reach, so a toast sits clear of Start again, Close tab and
   * an upload's Cancel instead of over them.
   */
  useLayoutEffect(() => {
    const pane = hostRef.current?.parentElement
    if (!pane || !active) return
    const column = pane.closest('.main-col')
    const floats = Array.from(pane.querySelectorAll<HTMLElement>(FOOT_FLOATS))
    const set = (): void => {
      const foot = column?.getBoundingClientRect().bottom ?? 0
      setToastFloor(Math.max(0, ...floats.map((el) => foot - el.getBoundingClientRect().top)))
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(pane)
    for (const el of floats) ro.observe(el)
    return () => {
      ro.disconnect()
      setToastFloor(0)
    }
  }, [active, floatsKey])

  const findPalette = useMemo(() => findColors(theme, accent), [theme, accent])

  /*
   * Repaint the terminal's own palette, then tell the child the scheme moved.
   *
   * The first line is all xterm needs. The second is what makes Claude Code
   * follow: with its `theme` set to `auto` the CLI picks light or dark by
   * asking the terminal for its background with OSC 11, and xterm.js 6.0.0
   * answers that from `theme.background` -- but it asks once, at startup, so a
   * theme switch mid-session leaves it painting the old scheme.
   *
   * `CSI ?997;1n` (dark) / `CSI ?997;2n` (light) is the report a terminal sends
   * when its colour scheme changes, and the CLI's handler for it ignores the
   * dark/light bit entirely and simply re-runs the OSC 11 query -- so what
   * actually decides the outcome is xterm's answer, which the line above has
   * already updated. That ordering is load-bearing: send the report first and
   * the CLI re-reads the palette it is replacing.
   *
   * xterm.js knows nothing about mode 2031 or this report -- neither string
   * appears in its bundle -- so Stoke has to synthesise it. It goes to the PTY
   * rather than through `term.write`, because it is input to the child, not
   * output to the screen.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme(theme, accent, alpha)
  }, [theme, accent, alpha])

  /*
   * Split from the repaint above on purpose, and keyed on the CLASS of the
   * background rather than the theme object. The theme editor pushes a new
   * draft Theme on every slider pixel, and this effect used to depend on it —
   * so dragging Neutral hue with a session open wrote tens of CSI 997 reports
   * a second into the PTY, each making the CLI re-run its OSC 11 query and
   * re-classify (gotcha 42), for a theme whose light/dark side never moved.
   * The CLI ignores the report's own dark/light bit and only re-queries, so
   * the class of `terminal.background` is exactly the thing worth telling it
   * about — and an override that carries a dark theme's page over 0.5 is told
   * too, where `theme.appearance` alone would not have said.
   */
  const light = isLightBackground(theme.terminal.background)
  lightRef.current = light
  useEffect(() => {
    if (!termRef.current || !themeNotifyRef.current) return
    window.stoke.pty.write(tab.ptyId, light ? '\x1b[?997;2n' : '\x1b[?997;1n')
  }, [light, tab.ptyId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    // Through the guarded fit: a hidden pane is left alone and picks the new
    // size up when it is shown, instead of being reflowed to a dozen columns.
    fitNowRef.current()
  }, [fontFamily, fontSize])

  /*
   * The drawing options, applied live so a slider in Settings moves the pane
   * under it. Everything here is safe to set on an open terminal; the ones
   * that change cell geometry (line height, letter spacing) need a refit.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.lineHeight = termOpts.lineHeight
    term.options.letterSpacing = termOpts.letterSpacing
    term.options.cursorStyle = termOpts.cursorStyle
    term.options.cursorBlink = termOpts.cursorBlink
    term.options.fontWeightBold = termOpts.boldWeight
    term.options.minimumContrastRatio = termOpts.contrastBoost
    term.options.smoothScrollDuration = termOpts.smoothScroll ? 100 : 0
    fitNowRef.current()
  }, [termOpts])

  // An exited process owes nothing: its card says so, and the scrim goes.
  useEffect(() => {
    if (tab.status === 'exited') stall.exit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.status, tab.ptyId])

  // A hidden pane cannot be measured, so refit and focus when it is revealed.
  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => {
      fitNowRef.current('shown')
      termRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(id)
  }, [active, tab.ptyId])

  /*
   * A file dropped on the pane types its own path, which is what Terminal.app
   * and iTerm2 do and the shortest way to hand Claude Code a screenshot.
   *
   * Three things make this more than an `ondrop`. Only a drag carrying FILES is
   * taken — text dragged in from another app or out of the docked browser
   * arrives as `text/plain`, and without this test it would light the drop ring
   * and then paste nothing. (The tab strip used to be one of those drags too;
   * it drags with pointer events now, `useTabDrag`, and emits no DragEvent at
   * all.) `preventDefault` on **dragover** is what makes
   * a drop happen at all; without it the browser default wins, and in Electron
   * that default is to NAVIGATE the window to the dropped file, replacing the
   * whole app with a picture (main also refuses that now, as a backstop). And
   * the path comes from `webUtils` through the preload, because Electron 32
   * removed `File.path`.
   */
  const filesInDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  const onDragEnter = (e: React.DragEvent): void => {
    if (!filesInDrag(e)) return
    dragDepth.current += 1
    setDropping(true)
  }

  const onDragOver = (e: React.DragEvent): void => {
    if (!filesInDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (e: React.DragEvent): void => {
    if (!filesInDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropping(false)
  }

  const onDrop = (e: React.DragEvent): void => {
    if (!filesInDrag(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    /*
     * `paste()` rather than a raw pty write, for the same reason the clipboard
     * path uses it: it wraps the text in bracketed paste when the application
     * asked for it, so Claude Code receives one paste rather than a burst of
     * keystrokes it might act on.
     */
    const term = termRef.current
    if (!term) return
    /*
     * An SSH tab that sends uploads sends EVERYTHING dropped on it to its
     * machine and types the far paths (the local path names nothing there,
     * gotchas 146, 152): an image from its own bytes, so a drag with no path —
     * an image out of a browser — works too, and any other file by the path
     * the preload reads off it, which main checks and reads. Local tabs, and
     * hosts with uploads off, type the local path, as before.
     */
    if (images.on && images.dropFiles(Array.from(e.dataTransfer.files))) return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.stoke.pathForFile(f))
      .filter((p): p is string => p !== null)
    /*
     * An SSH tab's shell is on the far machine, so it is quoted for THAT
     * machine's conventions rather than for the one Stoke is running on.
     *
     * `window.stoke.platform` is Stoke's own `process.platform`, and nothing
     * tracks a host's OS (gotcha 18's shape: an SSH tab's local facts are not
     * the session's facts). So Stoke on Windows dropping a file into a session
     * on a Linux VPS produced `"C:\path with spaces\x.png"` — double quotes,
     * which a POSIX shell takes literally rather than as quoting, and a
     * backslash path that means nothing there anyway.
     *
     * POSIX for any host tab: single-quoted, which is the safe direction —
     * inside single quotes every character but `'` is literal, so `$`,
     * backticks and backslashes cannot bite. An SSH target running Windows is
     * the rarer case by a wide margin, and if per-host OS is ever recorded on
     * SshHost this should key off that instead.
     */
    const text = dropText(paths, tab.hostId ? 'linux' : window.stoke.platform)
    if (!text) return
    // `dropText` already refuses a name holding a control character (`isInsertable`); cleaned anyway, like every paste.
    pasteSafely(term, text)
    term.focus()
  }

  const closeMenu = useCallback(() => setMenu(null), [])
  /*
   * A menu goes with its pane. A keyboard tab switch hides the pane and fires
   * none of ContextMenu's close events (a press, the wheel, a blur, a resize),
   * so the menu stayed mounted out of sight: it took the next Escape from the
   * terminal in front — Claude's interrupt — and held the full-screen reveal's
   * shell where it was (`holding` in App.tsx, gotcha 105).
   */
  useEffect(() => {
    if (!active) setMenu(null)
  }, [active])

  return (
    <div
      className="term-pane"
      hidden={!active}
      /* Whose pane this is: a 2px rule in the agent's colour along the top of
         the card while more than one agent is in view (app.css). */
      {...agentMark(paneAgent(tab))}
      data-drop={dropping || undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* The right-click is handled by a capture-phase listener on this host,
          attached with the terminal, so it never reaches xterm. */}
      <div className="term-host" ref={hostRef} />
      <TerminalStallOverlay
        stall={stall}
        tab={tab}
        hostLabel={host ? host.label || host.alias : null}
        onForceRestart={onForceRestart}
      />
      {findOpen && termRef.current && searchRef.current && (
        <TerminalFind
          tab={tab}
          term={termRef.current}
          search={searchRef.current}
          colors={findPalette}
          initialQuery={findInitial}
          openSeq={findSeq}
          onClose={closeFind}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          header={menu.link ? { title: 'Selected link', subtitle: menu.link } : undefined}
          /*
           * Shown only when there is something to explain, which is exactly
           * when a user has just discovered that dragging did not select.
           * Claude Code keeps mouse reporting on, so the drag goes to the CLI
           * unless it carries the bypass modifier.
           *
           * Three cases, because telling someone the wrong one is worse than
           * saying nothing. An SSH tab gets the extra sentence because the far
           * side has its own copy path and Stoke already accepts what it emits
           * (the OSC 52 handler above) — but it names no host's software as a
           * certainty, since `hostId` says only that this is a remote tab. A
           * blank selection is NOT "you did not select" — their gesture worked
           * and the cells they took are empty, and the old single sentence told
           * them to do the thing they had just done.
           *
           * One sentence per case on every platform, because Shift is the
           * gesture everywhere — the capture-phase shim above retells a Mac
           * Shift-drag as the Alt-drag xterm insists on. Option still works on
           * macOS and is deliberately not mentioned: naming two ways to do one
           * thing is how a hint stops being read.
           */
          footer={
            menu.blank
              ? 'That selection is only blank space, so there is nothing to copy.'
              : menu.selection
                ? undefined
                : tab.hostId
                  ? 'Hold Shift while dragging to select. A copy made on the far side — tmux or byobu copy-mode — lands here too.'
                  : 'Hold Shift while dragging to select text.'
          }
          items={[
            ...(menu.link ? [
              { label: 'Open selected link in Stoke', onSelect: () => openUrlRef.current(menu.link!) },
              { label: 'Open selected link in browser', onSelect: () => window.stoke.openExternal(menu.link!) }
            ] : []),
            {
              label: 'Copy',
              hint: IS_MAC ? '⌘C' : 'Ctrl+Shift+C',
              disabled: !menu.selection,
              onSelect: () => {
                window.stoke.clipboard.writeText(menu.selection)
                termRef.current?.clearSelection()
                termRef.current?.focus()
              }
            },
            {
              // An image clipboard used to show a greyed-out Paste with no
              // explanation. The CLI reads the image itself on its paste key
              // (`pasteImageRef`). Copied files go to the machine on an SSH tab
              // that sends uploads, and are typed as their full paths on every
              // other tab, as Cmd/Ctrl+V does both (`pasteMenuItem`).
              ...pasteMenuItem(menu.clip, images.on),
              hint: IS_MAC ? '⌘V' : 'Ctrl+V',
              onSelect: () => {
                // The primary chord's route, whatever the platform: the menu is never xterm's ^V.
                runPasteRef.current({ op: 'paste', via: IS_MAC ? 'cmd' : 'ctrl-shift' }, menu.clip)
                termRef.current?.focus()
              }
            },
            /*
             * Find in the screen and the conversation behind it. Here as well
             * as on the chord, because a chord nobody has been told about is a
             * feature nobody has.
             */
            {
              label: 'Find…',
              hint: chordLabel('find', IS_MAC),
              separated: true,
              onSelect: openFind
            },
            {
              label: 'Select all',
              onSelect: () => termRef.current?.selectAll()
            },
            /*
             * The one item that needs no gesture at all, for when someone wants
             * the error message on screen and does not care about precision.
             */
            {
              label: 'Copy screen',
              onSelect: copyScreen
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
                    label: dictation.on ? 'Stop dictation' : 'Dictate…',
                    onSelect: () => {
                      dictation.toggle()
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
      {images.strip}
      {/* The lent microphone's "Mic → host" takes the dictation strip's corner while it shows. */}
      {mic.strip ?? dictation.strip}
      {tab.status === 'exited' && tab.micSetup ? (
        /*
         * The microphone's setup tab: its exit is the install's. What it
         * printed above says where the stand-in went and whether a login
         * shell there finds it; nothing more is proven here.
         */
        <div className="term-exit" role="status">
          <span>
            {tab.exitCode === 0
              ? 'Installed. Fix anything a “Stoke:” line above names, then reconnect this machine’s tabs and use /voice there.'
              : `The microphone was not set up${tab.exitCode !== null ? ` (exit ${tab.exitCode})` : ''}. The reason is above.`}
          </span>
          {tab.exitCode !== 0 && (
            <button className="btn" data-variant="primary" onClick={() => onRestart(tab)}>
              Try again
            </button>
          )}
          <button className="btn" data-variant={tab.exitCode === 0 ? 'primary' : 'ghost'} onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      ) : tab.status === 'exited' && tab.enrollHostId ? (
        /*
         * An "Add key to …" tab's exit is ssh-copy-id finishing, not a session
         * ending. The verdict is main's probe, a moment later, on the strip
         * above; on a verified success App closes this tab by itself. What
         * stays is a failure, with ssh's own words above this card.
         */
        <div className="term-exit" role="status">
          <span>
            {tab.exitCode === 0
              ? 'Finished — checking that ssh now gets in without a password…'
              : `The key was not added${tab.exitCode !== null ? ` (exit ${tab.exitCode})` : ''} — ssh says why above.`}
          </span>
          <button className="btn" data-variant="primary" onClick={() => onRestart(tab)}>
            Try again
          </button>
          <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      ) : tab.status === 'exited' && tab.installing?.length ? (
        /*
         * An install tab's exit is the install's result, not a session ending.
         * The script exits non-zero when any agent failed (agents.ts), so a
         * zero is a real "installed", and the launcher has already re-detected.
         */
        <div className="term-exit" role="status">
          <span>
            {tab.exitCode === 0
              ? 'Installed. The launcher offers it now.'
              : `Not everything installed${tab.exitCode !== null ? ` (exit ${tab.exitCode})` : ''} — the reason is above.`}
          </span>
          {tab.exitCode !== 0 && (
            <button className="btn" data-variant="primary" onClick={() => onRestart(tab)}>
              Try again
            </button>
          )}
          <button className="btn" data-variant={tab.exitCode === 0 ? 'primary' : 'ghost'} onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      ) : tab.status === 'exited' && tab.reconnect ? (
        /*
         * A kept SSH tab whose link dropped, counting down to its next try
         * (gotcha 126). The shell never stopped on the machine, so the card
         * says so rather than "Session ended".
         */
        <div className="term-exit" role="status">
          <ReconnectCountdown at={tab.reconnect.at} attempt={tab.reconnect.attempt} />
          <button className="btn" data-variant="primary" onClick={() => onReconnectNow?.(tab)}>
            Reconnect now
          </button>
          <button className="btn" data-variant="ghost" onClick={() => onStopReconnect?.(tab.id)}>
            Stop
          </button>
          <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      ) : tab.status === 'exited' && tab.private ? (
        /*
         * A private chat that ended: its folder and every file it left are
         * deleted as its process exits (main's PrivateChats.finish), so there
         * is nothing to start again or resume. "New private chat" starts a
         * fresh one in this tab's slot.
         */
        <div className="term-exit" role="status" data-private="true">
          <span>{PRIVATE_ENDED_TEXT}</span>
          <button className="btn" data-variant="primary" onClick={() => onRestart(tab)}>
            New private chat
          </button>
          <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      ) : tab.status === 'exited' && (
        <div className="term-exit" role="status">
          <span>
            {tab.remoteSession && tab.exitCode !== 0
              ? 'Disconnected — the shell may still be running on the machine'
              : 'Session ended'}
            {tab.exitCode !== null && tab.exitCode !== 0 ? ` (exit ${tab.exitCode})` : ''}
          </span>
          <button className="btn" data-variant="primary" onClick={() => onRestart(tab)}>
            {tab.remoteSession && tab.exitCode !== 0 ? 'Reconnect' : 'Start again'}
          </button>
          <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      )}
    </div>
  )
}
