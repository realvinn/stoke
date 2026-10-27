import type { Terminal } from '@xterm/xterm'
import { bufferRows, clipboardChord, copyAction, joinBufferRows, osc52Write, safePasteText, type ChordKey } from '../../../shared/clipboardText.ts'
import { isButtonlessMotionReport } from './mouseReport.ts'

/*
 * Copy and paste for a terminal whose session runs on ANOTHER computer: a hub
 * remote tab (RemoteTerminal) and the phone/web UI (src/remote/session.ts,
 * which imports this file by path). The clipboard is the viewer's, never the
 * host's, and every rule here is one the desktop's own TerminalView already
 * learned (gotchas 10, 28, 34). No electron, no React: node's strip-types mode
 * loads this file in verify:phone-ui, so its imports carry `.ts`.
 */

const retold = new WeakSet<MouseEvent>()

/** Same Shift-drag gesture as a local terminal (terminal.md gotcha 17).
 * macOS mouse reporting requires Option; a plain shell with no selection
 * needs Shift removed to avoid xterm's empty extend-selection branch.
 */
export function installShiftSelection(host: HTMLElement, term: Terminal, isMac: boolean): () => void {
  const down = (event: MouseEvent): void => {
    if (event.button !== 0 || event.altKey || !event.shiftKey || retold.has(event)) return
    const reporting = term.modes.mouseTrackingMode !== 'none'
    if (reporting ? !isMac : term.hasSelection()) return
    event.preventDefault()
    event.stopPropagation()
    const clone = new MouseEvent(event.type, {
      bubbles: true, cancelable: true, view: window,
      clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
      button: event.button, buttons: event.buttons, detail: event.detail,
      altKey: reporting && isMac, shiftKey: false, ctrlKey: event.ctrlKey, metaKey: event.metaKey
    })
    retold.add(clone)
    event.target?.dispatchEvent(clone)
  }
  host.addEventListener('mousedown', down, true)
  return () => host.removeEventListener('mousedown', down, true)
}

/**
 * Withdraw xterm's "this was user input" claim from bare pointer motion, so a
 * selection survives the mouse moving under an application that reports it
 * (Claude Code's mode 1003). The report still reaches the far application
 * byte for byte. TerminalView's guard, gotcha 10; `isButtonlessMotionReport`
 * is the whole rule. Reached through `_core` because `coreService` is not
 * public: if a future xterm moves it, this does nothing rather than throw.
 */
export function installMotionGuard(term: Terminal): () => void {
  const core = (term as unknown as { _core?: { coreService?: { triggerDataEvent(data: string, wasUserInput?: boolean): void } } })._core?.coreService
  if (!core) return () => {}
  const original = core.triggerDataEvent
  const send = original.bind(core)
  core.triggerDataEvent = (data: string, wasUserInput = false): void => send(data, wasUserInput && !isButtonlessMotionReport(data))
  return () => {
    core.triggerDataEvent = original
  }
}

/**
 * What a key does to a remote session's clipboard: copy (and clear the
 * highlight), take the key and do nothing (and clear it), paste, or nothing —
 * the key is xterm's.
 */
export type RemoteChord = 'copy' | 'copy-clear' | 'swallow' | 'swallow-clear' | 'paste' | null

/**
 * The desktop's own chord rules (`clipboardChord` and `copyAction` in
 * shared/clipboardText.ts, so any layout: `chordLetter`), with what a remote
 * session adds. A key-up or an Alt chord is never the clipboard's (Option is
 * Meta here). Shift+Insert pastes off macOS. A bare macOS Ctrl+V is the far
 * application's ^V (Claude Code's image paste reads the FAR clipboard; vim,
 * readline). Cmd+C with nothing selected is taken and does nothing, as it
 * always was here; Ctrl+Shift+C with nothing selected is xterm's (^C), as on
 * the desktop. A blank-cell selection takes Ctrl+C and clears it
 * (`swallow-clear`), so the next press interrupts: before, it was taken
 * forever and the agent could not be stopped until someone clicked.
 * `selection` is read only for a copy chord.
 */
export function remoteChord(e: ChordKey & { type: string }, isMac: boolean, selection: () => string, hasSelection: boolean): RemoteChord {
  if (e.type !== 'keydown' || e.altKey) return null
  if (!isMac && e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey) return 'paste'
  const chord = clipboardChord(e, isMac)
  if (!chord) return null
  if (chord.op === 'paste') return isMac && chord.via === 'ctrl' ? null : 'paste'
  const action = copyAction(chord, selection(), hasSelection)
  if (action === 'xterm') return null
  return action === 'browser' ? 'swallow' : action
}

/** The clipboard as a viewer holds it: its text, and whether an image or files are there instead. */
export interface ClipboardRead {
  text: string
  hasImage?: boolean
  files?: number
}

/**
 * What a paste into a remote session can send: the text, cleaned of every
 * control a paste must not carry (`safePasteText`: an ESC[201~ inside it would
 * end the bracket and type the rest), or `not-text` for a clipboard holding
 * only an image or files, which nothing can carry to the other computer yet —
 * said, never swallowed. Null for an empty clipboard.
 *
 * `filesFirst` is for main's peek (`ClipboardPeek`), whose `files` counts
 * only what a file manager copied: Finder also puts the bare NAMES on as
 * text, which name nothing on the other computer, so files go first there,
 * as the desktop's `pasteAction` does. A browser paste event keeps text
 * first, since its `files` also counts an image copied beside real text.
 */
export function pasteVerdict(clip: ClipboardRead | string, filesFirst = false): { kind: 'text'; text: string } | { kind: 'not-text' } | null {
  const read = typeof clip === 'string' ? { text: clip } : clip
  if (filesFirst && (read.files ?? 0) > 0) return { kind: 'not-text' }
  const text = safePasteText(read.text ?? '')
  if (text) return { kind: 'text', text }
  if (read.hasImage || (read.files ?? 0) > 0) return { kind: 'not-text' }
  return null
}

/**
 * How long after this viewer's last key or press a copy made in the session is
 * still taken as this viewer's: a relay round trip, the far program's own work,
 * and a drag that ends long after its press (Claude Code copies on release).
 */
export const SESSION_COPY_ACT_MS = 10_000

/**
 * Whether an OSC 52 copy from the session is THIS viewer's to take. Every
 * viewer of a pty is sent the same sequence — the host's own tab, a remote tab
 * on a laptop, a phone — so without this, someone selecting in Claude Code at
 * the host's desk silently overwrote the clipboard of a laptop whose remote tab
 * merely sat open. A copy follows the act of whoever asked for it, so it is
 * taken only by a viewer that is shown, focused, and was acted on within
 * `SESSION_COPY_ACT_MS`.
 */
export function takesSessionCopy(ctx: { shown: boolean; focused: boolean; sinceActMs: number }): boolean {
  return ctx.shown && ctx.focused && ctx.sinceActMs >= 0 && ctx.sinceActMs < SESSION_COPY_ACT_MS
}

/**
 * When someone last pressed a key or a pointer inside `target`, for
 * `takesSessionCopy`. Trusted events only, in the capture phase, so nothing a
 * script dispatches (our own retold presses included) counts as a person.
 */
export function trackActs(target: EventTarget, now: () => number = () => performance.now()): { since(): number; dispose(): void } {
  let at = -Infinity
  const mark = (event: Event): void => {
    if (event.isTrusted) at = now()
  }
  const types = ['keydown', 'pointerdown', 'pointerup'] as const
  // The options object, not `true`: node's EventTarget (the suite's) ignores a boolean on remove.
  for (const type of types) target.addEventListener(type, mark, { capture: true })
  return {
    since: () => now() - at,
    dispose: () => {
      for (const type of types) target.removeEventListener(type, mark, { capture: true })
    }
  }
}

/**
 * OSC 52 copies made inside the session (tmux with `set-clipboard on`, nvim's
 * osc52, Claude Code's own copy) go to THIS viewer's clipboard. xterm drops
 * OSC 52 by default, so without this they reached only the host's. What a
 * write puts on the clipboard is the desktop's rule (`osc52Write`: capped,
 * cleaned like a paste, and the `?` read refused, never answered — a printed
 * file could otherwise read the viewer's clipboard, gotcha 29). `quiet` holds
 * a write: while a replay is drawn (an attach must not copy again what was
 * copied before it) and when the copy is not this viewer's (`takesSessionCopy`).
 */
export function installOsc52(term: Terminal, write: (text: string) => void, quiet?: () => boolean): () => void {
  const handler = term.parser.registerOscHandler(52, (data) => {
    if (quiet?.()) return true
    const copy = osc52Write(data)
    if (copy) write(copy.text)
    return true
  })
  return () => handler.dispose()
}

/**
 * The rows on screen now — the viewport, which is what the viewer is looking
 * at, not the bottom of the buffer — with soft-wrapped rows joined back into
 * the lines they were written as and the blank rows below the last line gone.
 */
export function viewportText(term: {
  rows: number
  buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trimRight?: boolean): string; isWrapped: boolean } | undefined } }
}): string {
  const buf = term.buffer.active
  return joinBufferRows(bufferRows(buf, buf.viewportY, buf.viewportY + term.rows)).replace(/\n+$/, '')
}

/**
 * Clipboard access is on this computer; Ctrl+C without a selection still
 * interrupts the agent. Secondary clicks must not become remote mouse input:
 * Claude Code answers a right-click report by pasting the HOST's clipboard.
 *
 * Two ways to reach the clipboard:
 * - `read`/`write` (Electron's): the chord is taken and done here.
 * - `native` (a browser page, the phone/web UI, often on plain http where
 *   `navigator.clipboard` does not exist): the chord is handed to the
 *   browser, whose own copy and paste events need no secure context and no
 *   permission. The selection is staged in xterm's textarea so the copy has
 *   something to take, and the capture-phase `copy` listener below writes it.
 *
 * Either way every paste event that reaches the terminal (a menu's Paste, the
 * browser's own Ctrl+V) is cleaned by `pasteVerdict`, and one with no text is
 * reported through `notText`. Without `menu` the browser's context menu is
 * left alone, with the selection staged under the pointer (`stageForMenu`),
 * so its Copy and Paste work.
 */
export function installTerminalClipboard(host: HTMLElement, term: Terminal, options: {
  isMac: boolean
  read?(): string | ClipboardRead
  write?(text: string): void
  menu?(event: MouseEvent, selection: string): void
  notText?(): void
  native?: boolean
}): () => void {
  let clearAfterCopy = false
  const native = options.native || !options.read || !options.write
  const paste = (clip: string | ClipboardRead, filesFirst: boolean): void => {
    const verdict = pasteVerdict(clip, filesFirst)
    if (verdict?.kind === 'text') term.paste(verdict.text)
    else if (verdict?.kind === 'not-text') options.notText?.()
  }
  /*
   * Empty xterm's textarea of a selection staged in it for a copy (here, or by
   * xterm's own right-click). Compared with CRLF made LF, because a textarea's
   * value is, and xterm joins a selection's lines with CRLF on Windows: an
   * exact test left that text behind, where xterm's IME reads a composition
   * from the offset of `value.length` when it starts.
   */
  const unstage = (): void => {
    const area = term.textarea
    if (!area?.value) return
    const staged = term.getSelection().replace(/\r\n?/g, '\n')
    if (staged && area.value === staged) area.value = ''
  }
  term.attachCustomKeyEventHandler(event => {
    const chord = remoteChord(event, options.isMac, () => term.getSelection(), term.hasSelection())
    if (!chord) return true
    // A native paste is not prevented: the browser's own paste event follows (`pasted`).
    if (native && chord === 'paste') return false
    // Everything else is taken here, so it is never the browser's default for
    // the chord (Ctrl+Shift+C opens DevTools in Chromium) nor xterm's ^C.
    event.preventDefault()
    if (chord === 'swallow' || chord === 'swallow-clear') {
      if (chord === 'swallow-clear') term.clearSelection()
      return false
    }
    if (chord === 'paste') {
      paste(options.read!(), true)
      return false
    }
    if (!native) {
      const text = term.getSelection()
      if (text) options.write!(text)
      if (chord === 'copy-clear' && text) term.clearSelection()
      return false
    }
    // Inside the key press, so the browser counts it as the user's: staged in
    // xterm's textarea so there is a selection to copy, written by `copied`.
    const area = term.textarea
    if (area) {
      area.value = term.getSelection()
      area.select()
    }
    clearAfterCopy = chord === 'copy-clear'
    try {
      document.execCommand('copy')
    } catch {
      // Refused: the selection stays, for the browser's own menu.
    }
    clearAfterCopy = false
    if (area) area.value = ''
    return false
  })
  const copied = (event: ClipboardEvent): void => {
    const text = term.getSelection()
    const clear = clearAfterCopy
    clearAfterCopy = false
    // Nothing selected: leave the event alone, so copying nothing never erases the clipboard.
    if (!text || !event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
    event.stopImmediatePropagation()
    unstage()
    if (clear) term.clearSelection()
  }
  const pasted = (event: ClipboardEvent): void => {
    // Electron's: main's peek, files first, the same verdict as the paste chord (an app menu's Paste lands here).
    if (!native) {
      event.preventDefault()
      event.stopImmediatePropagation()
      unstage()
      paste(options.read!(), true)
      return
    }
    const data = event.clipboardData
    if (!data) return
    event.preventDefault()
    event.stopImmediatePropagation()
    unstage()
    paste({ text: data.getData('text/plain'), files: data.files?.length ?? 0, hasImage: [...(data.types ?? [])].includes('Files') }, false)
  }
  host.addEventListener('copy', copied, true)
  host.addEventListener('paste', pasted, true)
  /*
   * The browser's own menu (no `menu`) needs xterm's textarea under the
   * pointer, holding the selection, for its Copy and Paste to work. Chromium
   * and WebKit stage it from `contextmenu`, which `context` lets through;
   * Firefox stages it from this very press (xterm's `rightClickHandler`), which
   * is stopped below — so the press stages it, as xterm would have.
   */
  const stageForMenu = (event: MouseEvent): void => {
    const area = term.textarea
    const screen = term.element?.querySelector('.xterm-screen')
    if (!area || !screen) return
    const box = screen.getBoundingClientRect()
    area.style.width = '20px'
    area.style.height = '20px'
    area.style.left = `${event.clientX - box.left - 10}px`
    area.style.top = `${event.clientY - box.top - 10}px`
    area.style.zIndex = '1000'
    area.focus()
    area.value = term.getSelection()
    area.select()
  }
  let swallowed: number | null = null
  const down = (event: MouseEvent): void => {
    if (retold.has(event) || event.defaultPrevented) return
    if (event.button !== 2 && !(options.isMac && event.button === 0 && event.ctrlKey)) return
    swallowed = event.button
    event.preventDefault(); event.stopImmediatePropagation()
    if (!options.menu) stageForMenu(event)
  }
  const up = (event: MouseEvent): void => {
    if (event.button !== swallowed) return
    swallowed = null
    event.preventDefault(); event.stopImmediatePropagation()
  }
  const menu = options.menu
  const context = (event: MouseEvent): void => {
    if (!menu) return
    event.preventDefault(); event.stopImmediatePropagation()
    menu(event, term.getSelection())
  }
  host.addEventListener('mousedown', down, true)
  document.addEventListener('mouseup', up, true)
  host.addEventListener('contextmenu', context, true)
  return () => {
    host.removeEventListener('mousedown', down, true)
    document.removeEventListener('mouseup', up, true)
    host.removeEventListener('contextmenu', context, true)
    host.removeEventListener('copy', copied, true)
    host.removeEventListener('paste', pasted, true)
    term.attachCustomKeyEventHandler(() => true)
  }
}
