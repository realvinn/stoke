import type { Terminal } from '@xterm/xterm'

/** Same Shift-drag gesture as a local terminal (terminal.md gotcha 17).
 * macOS mouse reporting requires Option; a plain shell with no selection
 * needs Shift removed to avoid xterm's empty extend-selection branch.
 */
export function installShiftSelection(host: HTMLElement, term: Terminal, isMac: boolean): () => void {
  const retold = new WeakSet<MouseEvent>()
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
