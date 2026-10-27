import type { Terminal } from '@xterm/xterm'

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

/** Clipboard access is on this computer; Ctrl+C without a selection still
 * interrupts the agent. Secondary clicks must not become remote mouse input. */
export function installTerminalClipboard(host: HTMLElement, term: Terminal, options: {
  isMac: boolean
  read(): string
  write(text: string): void
  menu(event: MouseEvent, selection: string): void
}): () => void {
  term.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.altKey) return true
    const key = event.key.toLowerCase()
    const cmd = options.isMac && event.metaKey && !event.ctrlKey
    const ctrl = event.ctrlKey && !event.metaKey
    const copy = key === 'c' && (cmd || (ctrl && event.shiftKey) || (!options.isMac && ctrl && term.hasSelection()))
    if (copy) {
      event.preventDefault()
      const text = term.getSelection()
      if (text) options.write(text)
      if (!options.isMac && ctrl && !event.shiftKey && text) term.clearSelection()
      return false
    }
    if ((key === 'v' && (cmd || (ctrl && (!options.isMac || event.shiftKey)))) || (!options.isMac && key === 'insert' && event.shiftKey && !event.ctrlKey)) {
      event.preventDefault()
      const text = options.read()
      if (text) term.paste(text)
      return false
    }
    return true
  })
  let swallowed: number | null = null
  const down = (event: MouseEvent): void => {
    if (retold.has(event) || event.defaultPrevented) return
    if (event.button !== 2 && !(options.isMac && event.button === 0 && event.ctrlKey)) return
    swallowed = event.button
    event.preventDefault(); event.stopImmediatePropagation()
  }
  const up = (event: MouseEvent): void => {
    if (event.button !== swallowed) return
    swallowed = null
    event.preventDefault(); event.stopImmediatePropagation()
  }
  const context = (event: MouseEvent): void => {
    event.preventDefault(); event.stopImmediatePropagation()
    options.menu(event, term.getSelection())
  }
  host.addEventListener('mousedown', down, true)
  document.addEventListener('mouseup', up, true)
  host.addEventListener('contextmenu', context, true)
  return () => {
    host.removeEventListener('mousedown', down, true)
    document.removeEventListener('mouseup', up, true)
    host.removeEventListener('contextmenu', context, true)
    term.attachCustomKeyEventHandler(() => true)
  }
}
