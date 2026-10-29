import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { terminalLinkClick, terminalLinkRepairs } from '@shared/terminalLinks'
import { captureTerminalViewport, restoreTerminalViewport } from '@shared/terminalViewport'
import type { TerminalSettings, Theme, VoiceSettings } from '@shared/types'
import type { RemoteBarMode } from '@shared/ui'
import { REMOTE_TYPE_MAX, remoteTypeVerdict, type RemoteTabFrame, type RemoteTabView } from '@shared/hub/remote'
import { voiceSupported } from '@shared/voice'
import { CLI_OWNS_SPACE, spaceOwner } from '@shared/voiceRoute'
import { floatInset } from '@shared/paneFloats'
import { decideResize } from '@shared/phoneUi'
import { isTerminalReport } from '@shared/remotePhone'
import { SizeClaimer, isGrid, type ClaimTrigger, type Grid } from '@shared/sizeClaim'
import { terminalTheme } from '../lib/theme'
import { recentlyUsed } from '../lib/lastInput'
import { platformName } from '../lib/hubRemote'
import { installMotionGuard, installOsc52, installShiftSelection, installTerminalClipboard, pasteVerdict, takesSessionCopy, trackActs, viewportText } from '../lib/terminalSelection'
import { toast } from '../lib/toasts'
import type { Tab } from '../types'
import { RemoteFab } from './RemoteFab'
import { legacyRemoteDraft, markLegacyDraftRestored, splitLegacyDraft, unmarkLegacyDraftRestored, type RecoveryDraft } from '../../../remote/draftCache'
import { ContextMenu } from './ContextMenu'
import { useDictation } from './Dictation'

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
 * - Dictation (⇧⌘D, or Dictate on the link's button) is THIS computer's:
 *   its microphone, its speech service, and the words typed into the session
 *   over there by the host, as Claude Code takes typing and with no Enter
 *   (`HubRemote.type`). Claude Code's own `/voice` would record the other
 *   machine's microphone — the other room — so Space here is always Stoke's
 *   (`spaceOwner`). A tab that may only watch is refused with a sentence, and
 *   words whose link dropped while they were being transcribed stay on the
 *   strip to type again or copy (Dictation.tsx).
 *
 * The device and the link's state are always on screen, so it can never be
 * mistaken for a local session: a small floating button by default (open on
 * hover or keyboard focus for the whole sentence, Close and Try again), or the
 * full banner (Settings › Account & sync, `remoteBar`).
 */

/** Live remote terminals by tab id, for a CDP probe (the buffer, gotcha 5). Nothing in the app reads it. */
const remoteTerms = new Map<string, Terminal>()
;(window as unknown as { stokeRemoteTerminals?: Map<string, Terminal> }).stokeRemoteTerminals = remoteTerms

/** Said for a paste whose clipboard holds only an image or files: nothing carries those to the other computer yet. */
const NOT_TEXT_PASTE = 'Images and files can’t be pasted into another computer’s session yet. Paste text, or send the file from that computer.'

/** A paste of the viewer's clipboard into the remote session, or the sentence for one that cannot go (files first: Finder's names name nothing there). */
function pasteInto(term: Terminal | null): void {
  const verdict = pasteVerdict(window.stoke.clipboard.readSync(), true)
  if (verdict?.kind === 'text') term?.paste(verdict.text)
  else if (verdict?.kind === 'not-text') toast({ title: NOT_TEXT_PASTE })
}

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
  /** Stoke's dictation: the hold threshold and the chosen microphone, read per press. */
  voice: VoiceSettings
  onClose: (tabId: string) => void
  onOpenUrl: (url: string) => void
}

export function RemoteTerminal({ tab, view, active, theme, fontFamily, fontSize, terminal, accent, alpha, bar, voice, onClose, onOpenUrl }: Props): React.JSX.Element {
  const [clipboardMenu, setClipboardMenu] = useState<{x:number;y:number;selection:string}|null>(null)
  useEffect(() => { setClipboardMenu(null) }, [active, tab.remote?.tabId])
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const openUrlRef = useRef(onOpenUrl)
  openUrlRef.current = onOpenUrl
  const claimerRef = useRef<SizeClaimer | null>(null)
  const remoteId = tab.remote?.tabId ?? ''
  const stateRef = useRef<RemoteTabView['state'] | undefined>(view?.state)
  stateRef.current = view?.state
  const recoveredDraftRef = useRef(false)
  const recoveringDraftRef = useRef(false)
  const draftScope = JSON.stringify(['remote-desktop', tab.remote?.device, tab.remote?.ptyId ?? remoteId])
  const draftScopeRef = useRef(draftScope)
  if (draftScopeRef.current !== draftScope) {
    draftScopeRef.current = draftScope
    recoveredDraftRef.current = false
    recoveringDraftRef.current = false
  }
  const activeRef = useRef(active)
  activeRef.current = active
  const deviceLabel = view?.deviceLabel ?? tab.remote?.deviceLabel ?? 'another machine'
  const deviceRef = useRef(deviceLabel)
  deviceRef.current = deviceLabel
  /** The grid the pty has, as the other machine last said, for the CDP probe and the face's title. */
  const [grid, setGrid] = useState<Grid | null>(null)
  /** Set while the tab focuses its own terminal for a reason that is not use (a reconnect): that `focusin` claims nothing. */
  const quietFocusRef = useRef(false)
  /** The view as of the last render, for dictation's refusal, which is asked later. */
  const viewRef = useRef(view)
  viewRef.current = view
  /** Main has drawn this tab at least once: no view after that is a link gone for good (below). */
  const seenRef = useRef(false)
  if (view) seenRef.current = true

  /*
   * Dictation (Dictation.tsx): the hold, the recorder and the strip are the
   * same as a local tab's. What is this tab's: Space is always Stoke's here
   * (`spaceOwner` of a remote tab — the local /voice setting says nothing
   * about the far CLI, and the far CLI's /voice would record the far room),
   * whether the tab may type at all (`remoteTypeVerdict`), and that the words
   * go through the relay for the host to type.
   */
  const dictation = useDictation({
    hostRef,
    active,
    voice,
    target: {
      refusal: async () => {
        const state = await window.stoke.audio.voiceState().catch(() => null)
        if (spaceOwner(tab, state?.claudeVoice === true) === 'cli') return CLI_OWNS_SPACE
        const v = viewRef.current
        // A link still on its way may be armed: the send says so if it never opens.
        if (!v) return seenRef.current ? remoteTypeVerdict(null) : null
        if (v.state === 'connecting' || v.state === 'asking' || v.state === 'reconnecting') return null
        return remoteTypeVerdict(v)
      },
      // Through xterm's onData, as a typed space goes: the relay's input path.
      typeSpace: () => termRef.current?.input(' ', true),
      deliver: async (text) => {
        const r = await window.stoke.hub.remote.type(remoteId, text)
        return r.ok ? null : r.message
      }
    }
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host || !remoteId) return
    const interactionHost = (host.closest('.remote-pane') ?? host) as HTMLElement
    let downAt: { x: number; y: number } | null = null
    const openLink = (event: MouseEvent, uri: string): void => {
      event.preventDefault()
      const action = terminalLinkClick(uri, event, downAt, window.stoke.platform === 'darwin')
      if (action === 'external') window.stoke.openExternal(uri)
      else if (action === 'stoke') openUrlRef.current(uri)
    }
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
      macOptionClickForcesSelection: true,
      altClickMovesCursor: false,
      allowProposedApi: true,
      linkHandler: { activate: openLink },
      theme: terminalTheme(theme, accent, alpha)
    })
    // Measures this pane's grid for a claim; never fits the terminal itself: its grid is the pty's.
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = '15-graphemes'
    term.registerLinkProvider({ provideLinks: (line, done) => done(terminalLinkRepairs(term, line).map(link => ({ ...link, activate: openLink }))) })
    term.loadAddon(new WebLinksAddon(openLink))
    term.open(host)
    const isMac = window.stoke.platform === 'darwin'
    const removeSelection = installShiftSelection(host, term, isMac)
    // Bare pointer motion under Claude Code (1003) must not clear the selection (gotcha 10).
    const removeMotion = installMotionGuard(term)
    const removeClipboard = installTerminalClipboard(host, term, {
      isMac,
      read: () => window.stoke.clipboard.readSync(),
      write: text => window.stoke.clipboard.writeText(text),
      notText: () => toast({ title: NOT_TEXT_PASTE }),
      menu: (event, selection) => setClipboardMenu({x:event.clientX,y:event.clientY,selection})
    })
    /*
     * OSC 52 from the session lands on THIS computer's clipboard. The host's own
     * tab for the session (if it has one open) handles the same sequence and
     * writes the host's clipboard too; both is the intent. Held while a replay
     * is parsed (`replays`), so an attach never copies again what was copied
     * before it, and unless this tab is the one being used (`takesSessionCopy`):
     * a copy made at the host's desk must not overwrite this computer's clipboard
     * from a tab that merely sits open here.
     */
    let replays = 0
    const acts = trackActs(interactionHost)
    const mine = (): boolean => takesSessionCopy({ shown: activeRef.current, focused: document.hasFocus(), sinceActMs: acts.since() })
    const removeOsc52 = installOsc52(term, text => window.stoke.clipboard.writeText(text), () => replays > 0 || !mine())
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
    let attached = false
    let disposed = false
    let interaction = 0
    const touched = (): void => { interaction++ }
    host.addEventListener('wheel', touched, { passive: true })
    host.addEventListener('pointerdown', touched, true)
    host.addEventListener('keydown', touched, true)
    const offFrame = window.stoke.hub.remote.onFrame((id, frame: RemoteTabFrame) => {
      if (id !== remoteId) return
      switch (frame.type) {
        case 'attached': {
          const saved = attached ? captureTerminalViewport(term) : null
          const revision = interaction
          attached = true
          const cols = num(frame.cols, 100)
          const rows = num(frame.rows, 30)
          term.reset()
          sizeTo({ cols, rows }, { cols: num(frame.desktopCols, cols), rows: num(frame.desktopRows, rows) })
          replays++
          term.write(typeof frame.history === 'string' ? frame.history : '', () => {
            replays--
            if (!disposed && saved && interaction === revision) restoreTerminalViewport(term, saved)
          })
          break
        }
        case 'data':
          if (attached && typeof frame.data === 'string') term.write(frame.data)
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
    window.stoke.hub.remote.rendererAttached(remoteId, true)
    let pendingInput: string[] = []
    let pendingBytes = 0
    let nativeEdited = false
    const offData = term.onData((data) => {
      // Only keys: xterm's own answers to the far application are the far terminal's to give.
      if (isTerminalReport(data)) return
      if (stateRef.current !== 'open') return
      if (recoveringDraftRef.current) {
        if (data === '\x1b[A' || data === '\x1bOA') return
        if (pendingBytes + data.length <= 20_000) { pendingInput.push(data); pendingBytes += data.length }
        else toast({ tone: 'error', title: 'Input was not sent', description: 'Wait for the saved draft to finish restoring, then try again.' })
        return
      }
      // A permission picker or a running agent also uses Up; never paste a
      // recovered prompt unless the host reports that the session is idle.
      if ((data === '\x1b[A' || data === '\x1bOA') && !recoveredDraftRef.current && !nativeEdited && viewRef.current?.session?.activity === 'idle') {
        let draft: RecoveryDraft | null = null
        const scope = draftScopeRef.current
        try { draft = legacyRemoteDraft(localStorage, scope) } catch { /* Storage is unavailable; use native history. */ }
        if (draft) {
          const problem = remoteTypeVerdict(viewRef.current)
          if (problem) { toast({ tone: 'error', title: 'Saved draft could not be restored', description: problem }); return }
          if (!viewRef.current?.orderedInput) {
            toast({ tone: 'error', title: 'Update Stoke on the remote computer', description: 'The saved draft needs the newer remote input handling. The saved copy is still on this device.' })
            return
          }
          if (/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(draft.text)) {
            toast({ tone: 'error', title: 'Saved draft was not inserted', description: 'It contains terminal control characters. The saved copy is still on this device.' })
            return
          }
          // Without bracketed paste, a newline in a non-Claude terminal can
          // submit the prompt. The mirrored terminal must explicitly support it.
          if (/[\r\n]/.test(draft.text) && !term.modes.bracketedPasteMode) {
            toast({ tone: 'error', title: 'Multiline draft was not inserted', description: 'The remote terminal cannot safely accept multiline text right now. The saved copy is still on this device.' })
            return
          }
          try { markLegacyDraftRestored(localStorage, scope, draft) }
          catch { toast({ tone: 'error', title: 'Saved draft could not be restored', description: 'Local storage is unavailable. The saved copy was not changed.' }); return }
          recoveringDraftRef.current = true
          // An uncertain delivery must not be repeated by another Up press.
          recoveredDraftRef.current = true
          let complete = false
          let accepted = 0
          const restore = async (): Promise<{ ok: boolean; message?: string }> => {
            for (const part of splitLegacyDraft(draft!.text, REMOTE_TYPE_MAX)) {
              if (disposed || draftScopeRef.current !== scope || stateRef.current !== 'open' || viewRef.current?.session?.activity !== 'idle') {
                if (accepted === 0) { try { unmarkLegacyDraftRestored(localStorage, scope, draft!) } catch { /* The saved draft is unchanged. */ } }
                return { ok: false, message: 'The session changed before the whole draft was typed.' }
              }
              const result = await window.stoke.hub.remote.type(remoteId, part, false)
              if (!result.ok) return result
              accepted++
            }
            return { ok: true }
          }
          void restore().then(result => {
            if (disposed || draftScopeRef.current !== scope) return
            if (result.ok) {
              complete = true
              toast({ title: 'Saved draft restored', description: 'Review the text in the agent before sending.' })
            }
            else toast({ tone: 'error', title: 'Saved draft may not have been restored', description: `${result.message || 'The connection did not confirm the insert.'} Check the agent input; the saved copy remains on this device.` })
          }).catch(() => { if (!disposed && draftScopeRef.current === scope) toast({ tone: 'error', title: 'Draft delivery is unknown', description: 'Check the agent input after reconnecting. The saved copy remains on this device.' }) })
            .finally(() => {
              if (disposed || draftScopeRef.current !== scope) return
              recoveringDraftRef.current = false
              if (complete && stateRef.current === 'open') for (const input of pendingInput) window.stoke.hub.remote.input(remoteId, input)
              else if (pendingInput.length) toast({ tone: 'error', title: 'Input was not sent', description: 'The draft did not finish restoring. Check the agent input and try again.' })
              pendingInput = []; pendingBytes = 0
            })
          return
        }
      }
      if (data !== '\x1b[A' && data !== '\x1bOA') nativeEdited = true
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
    const onPress = (event: MouseEvent): void => { downAt = { x: event.clientX, y: event.clientY }; use('click') }
    interactionHost.addEventListener('focusin', onFocus)
    interactionHost.addEventListener('keydown', onKey, true)
    interactionHost.addEventListener('mousedown', onPress, true)
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
      disposed = true
      if (pendingInput.length) toast({ tone: 'error', title: 'Input was not sent', description: 'The remote tab closed while the draft was restoring.' })
      window.stoke.hub.remote.rendererAttached(remoteId, false)
      host.removeEventListener('wheel', touched)
      host.removeEventListener('pointerdown', touched, true)
      host.removeEventListener('keydown', touched, true)
      ro.disconnect()
      interactionHost.removeEventListener('focusin', onFocus)
      interactionHost.removeEventListener('keydown', onKey, true)
      interactionHost.removeEventListener('mousedown', onPress, true)
      claimer.dispose()
      claimerRef.current = null
      offFrame()
      offData.dispose()
      removeOsc52()
      acts.dispose()
      removeClipboard()
      removeMotion()
      removeSelection()
      remoteTerms.delete(remoteId)
      termRef.current = null
      term.dispose()
    }
    // The terminal is made once per remote tab; theme and font follow below.
  }, [remoteId, draftScope])

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
   * The dictation strip sits under whatever this pane draws at its top: the
   * link's button (`fab`) or its banner (`bar`). Measured rather than summed
   * from tokens, since the banner is in the flow and the frame moves both;
   * kept by a ResizeObserver as the pane shows, hides and resizes.
   */
  useLayoutEffect(() => {
    const pane = hostRef.current?.parentElement
    if (!pane || dictation.stripKey === 0) return
    const above = pane.querySelector<HTMLElement>(':scope > .remote-banner, :scope > .remote-fab > .remote-fab-face')
    if (!above) return
    const set = (): void => {
      const top = floatInset([above.getBoundingClientRect().bottom - pane.getBoundingClientRect().top])
      if (top) pane.style.setProperty('--strip-top', top)
      else pane.style.removeProperty('--strip-top')
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(pane)
    ro.observe(above)
    return () => {
      ro.disconnect()
      pane.style.removeProperty('--strip-top')
    }
  }, [bar, dictation.stripKey])

  /*
   * No view for a tab main once had: main dropped it (a sign-out, a revoke,
   * the hub client stopping), so the link is gone for good and only Close
   * means anything. Before the first view arrives it is still connecting.
   */
  const gone = !view && seenRef.current
  const state = view?.state ?? (gone ? 'lost' : 'connecting')
  const message = gone ? 'The link is gone: this computer signed out of your hub, or left it.' : (view?.message ?? null)
  const canRetry = !!view && (state === 'refused' || state === 'lost')
  const title = view?.title ?? tab.title
  const platform = platformName(view?.platform ?? tab.remote?.platform ?? '')
  const stateText = `${state === 'asking' && message ? message : STATE_WORDS[state]}${message && state !== 'open' && state !== 'asking' ? ` — ${message}` : ''}`
  const actions = (
    <>
      {/*
        Dictation's one visible door here (a remote tab has no context menu).
        Hidden where the browser has no microphone API, so it never offers
        what cannot work; the keyboard goes back to the terminal, where the
        held Space is listened for.
      */}
      {voiceSupported() && (
        <button
          className="btn"
          data-variant="ghost"
          aria-pressed={dictation.on}
          title="Hold Space to talk; this computer’s microphone, typed into the session over there (⇧⌘D)"
          onClick={() => {
            dictation.toggle()
            termRef.current?.focus()
          }}
        >
          {dictation.on ? 'Stop dictating' : 'Dictate'}
        </button>
      )}
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
      {clipboardMenu && active && <ContextMenu x={clipboardMenu.x} y={clipboardMenu.y} onClose={() => setClipboardMenu(null)} items={[
        {label:'Copy',disabled:!clipboardMenu.selection,onSelect:()=>window.stoke.clipboard.writeText(clipboardMenu.selection)},
        // The viewport, soft wraps joined: what is on screen, never an empty write over the clipboard.
        {label:'Copy screen',onSelect:()=>{const t=termRef.current;const text=t?viewportText(t):'';if(text)window.stoke.clipboard.writeText(text)}},
        {label:'Paste',onSelect:()=>pasteInto(termRef.current)}
      ]} />}
      {dictation.strip}
    </div>
  )
}
