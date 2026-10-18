import { TERMINAL_FUNCTION_KEYS, terminalKeySequence, type TerminalKey, type TerminalKeyModifiers } from '@shared/terminalKeys'
import { el, toast } from './dom'

interface Options {
  write: (sequence: string) => boolean
  applicationCursorMode: () => boolean
  signal: AbortSignal
}
type Modifier = 'shift' | 'ctrl' | 'alt'
type Latch = 'off' | 'next' | 'locked'
interface Key { label: string; name: string; key?: TerminalKey; sequence?: string; repeat?: boolean }

const NAVIGATION: readonly Key[] = [
  { label: 'esc', name: 'Escape', key: 'Escape' },
  { label: 'tab', name: 'Tab', key: 'Tab' },
  { label: '←', name: 'Left arrow', key: 'ArrowLeft', repeat: true },
  { label: '↑', name: 'Up arrow', key: 'ArrowUp', repeat: true },
  { label: '↓', name: 'Down arrow', key: 'ArrowDown', repeat: true },
  { label: '→', name: 'Right arrow', key: 'ArrowRight', repeat: true },
  { label: 'enter', name: 'Enter', key: 'Enter' }
]
const MORE: readonly Key[] = [
  { label: 'home', name: 'Home', key: 'Home' },
  { label: 'end', name: 'End', key: 'End' },
  { label: 'pg up', name: 'Page up', key: 'PageUp' },
  { label: 'pg dn', name: 'Page down', key: 'PageDown' },
  { label: 'ins', name: 'Insert', key: 'Insert' },
  { label: 'del', name: 'Delete', key: 'Delete' },
  { label: '⌫', name: 'Backspace', key: 'Backspace', repeat: true },
  { label: '⇧tab', name: 'Shift-Tab: cycle permission mode', sequence: '\x1b[Z' },
  { label: 'ctrl-c', name: 'Control-C: interrupt', sequence: '\x03' },
  { label: 'ctrl-r', name: 'Control-R: search history', sequence: '\x12' },
  { label: 'ctrl-l', name: 'Control-L: clear screen', sequence: '\x0c' }
]

/** On-screen keys share the terminal's protocol, never the browser's key shortcuts. */
export function mountTerminalKeys(root: HTMLElement, { write, applicationCursorMode, signal }: Options): {
  reset: () => void
  setEnabled: (enabled: boolean) => void
} {
  root.classList.add('terminal-keyboard')
  const latches: Record<Modifier, Latch> = { shift: 'off', ctrl: 'off', alt: 'off' }
  const taps: Record<Modifier, number> = { shift: -Infinity, ctrl: -Infinity, alt: -Infinity }
  const held = new Map<number, { modifier: Modifier; used: boolean }>()
  const labels: Record<Modifier, string> = { shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt' }
  const modifierButtons = new Map<Modifier, HTMLButtonElement>()
  const inputs: HTMLButtonElement[] = []
  const hint = el('span', { class: 'keys-hint', role: 'status', 'aria-live': 'polite' })
  let enabled = false
  let repeatDelay: ReturnType<typeof setTimeout> | null = null
  let repeatInterval: ReturnType<typeof setInterval> | null = null
  let repeatingPointer: number | null = null
  let eofTimer: ReturnType<typeof setTimeout> | null = null
  let eofAt = 0
  const stopRepeat = (): void => {
    if (repeatDelay) clearTimeout(repeatDelay)
    if (repeatInterval) clearInterval(repeatInterval)
    repeatDelay = null; repeatInterval = null; repeatingPointer = null
  }
  const modifiers = (): TerminalKeyModifiers => Object.fromEntries(
    (['shift', 'ctrl', 'alt'] as const).map(modifier => [modifier, latches[modifier] !== 'off' || [...held.values()].some(item => item.modifier === modifier)])
  )
  const paint = (): void => {
    const active = modifiers()
    for (const [modifier, button] of modifierButtons) {
      button.setAttribute('aria-pressed', String(!!active[modifier]))
      button.dataset.state = latches[modifier]
      button.querySelector('.key-sub')!.textContent = latches[modifier] === 'locked' ? 'locked' : active[modifier] ? 'next key' : ''
      button.setAttribute('aria-label', `${labels[modifier]}${latches[modifier] === 'locked' ? ', locked. Tap to release.' : active[modifier] ? ', next key. Double-tap to lock.' : '. Tap for the next key, double-tap to lock.'}`)
    }
    const pending = (['shift', 'ctrl', 'alt'] as const).filter(key => active[key]).map(key => `${labels[key]}${latches[key] === 'locked' ? ' locked' : ''}`)
    const text = pending.length ? `${pending.join(' + ')} · arrows, navigation and F keys` : 'Tap a modifier for one key · double-tap to lock'
    if (hint.textContent !== text) hint.textContent = text
  }
  const consume = (): void => {
    for (const modifier of ['shift', 'ctrl', 'alt'] as const) if (latches[modifier] === 'next') latches[modifier] = 'off'
    for (const item of held.values()) item.used = true
    paint()
  }
  const toggleModifier = (modifier: Modifier): void => {
    if (!enabled) return
    stopRepeat()
    const now = performance.now()
    latches[modifier] = latches[modifier] === 'off' ? 'next'
      : latches[modifier] === 'next' && now - taps[modifier] < 450 ? 'locked' : 'off'
    taps[modifier] = now
    paint()
  }
  const modifierRow = el('div', { class: 'keys-modifiers', role: 'group', 'aria-label': 'Modifiers and key groups' })
  for (const modifier of ['shift', 'ctrl', 'alt'] as const) {
    const button = el('button', { type: 'button', class: 'key key-modifier', 'data-key': labels[modifier], disabled: true },
      el('span', { class: 'key-main' }, labels[modifier]), el('span', { class: 'key-sub' }))
    modifierButtons.set(modifier, button); inputs.push(button)
    button.addEventListener('pointerdown', event => {
      if (!enabled || event.button !== 0) return
      event.preventDefault()
      stopRepeat()
      held.set(event.pointerId, { modifier, used: false })
      button.setPointerCapture(event.pointerId)
      paint()
    }, { signal })
    button.addEventListener('pointerup', event => {
      const item = held.get(event.pointerId)
      if (!item) return
      stopRepeat()
      held.delete(event.pointerId)
      if (!item.used) toggleModifier(modifier)
      else paint()
    }, { signal })
    const cancel = (event: PointerEvent): void => { if (held.delete(event.pointerId)) { stopRepeat(); paint() } }
    button.addEventListener('pointercancel', cancel, { signal })
    button.addEventListener('lostpointercapture', cancel, { signal })
    button.addEventListener('click', event => { if (event.detail === 0) toggleModifier(modifier) }, { signal })
    modifierRow.append(button)
  }
  const sendKey = (key: Key, selected = modifiers()): boolean => {
    if (!enabled || signal.aborted) return false
    const sequence = key.sequence ?? terminalKeySequence(key.key!, selected, applicationCursorMode())
    if (sequence === null) { toast('Release the modifier to send this key.'); return false }
    if (!write(sequence)) return false
    consume()
    return true
  }
  const keyButton = (key: Key): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'key', 'data-key': key.key ?? key.label, 'aria-label': key.name, title: key.name, disabled: true },
      el('span', { class: 'key-main' }, key.label), key.label === '⇧tab' ? el('span', { class: 'key-sub' }, 'mode') : null)
    inputs.push(button)
    button.addEventListener('pointerdown', event => {
      if (!enabled || event.button !== 0) return
      event.preventDefault()
      if (!key.repeat) return
      const selected = modifiers()
      if (!sendKey(key, selected)) return
      stopRepeat()
      repeatingPointer = event.pointerId
      button.setPointerCapture(event.pointerId)
      repeatDelay = setTimeout(() => {
        repeatDelay = null
        repeatInterval = setInterval(() => { if (!sendKey(key, selected)) stopRepeat() }, 90)
      }, 350)
    }, { signal })
    const release = (event: PointerEvent): void => { if (event.pointerId === repeatingPointer) stopRepeat() }
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) button.addEventListener(event, release, { signal })
    button.addEventListener('click', event => { if (!key.repeat || event.detail === 0) sendKey(key) }, { signal })
    return button
  }
  const nav = el('div', { class: 'keys-main keys-navigation', role: 'group', 'aria-label': 'Navigation keys' }, ...NAVIGATION.map(keyButton))
  const functions = el('div', { class: 'keys-functions', id: `${root.id}-functions`, hidden: true, role: 'group', 'aria-label': 'Function keys' },
    ...TERMINAL_FUNCTION_KEYS.map(key => keyButton({ label: key, name: key, key })))
  const more = el('div', { class: 'keys-more', id: `${root.id}-more`, hidden: true, role: 'group', 'aria-label': 'More terminal keys' }, ...MORE.map(keyButton))
  const groupToggle = (name: string, label: string, panel: HTMLElement): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'key key-group-toggle', 'aria-label': name, 'aria-expanded': 'false', 'aria-controls': panel.id }, label)
    button.addEventListener('pointerdown', event => event.preventDefault(), { signal })
    button.addEventListener('click', () => {
      const opening = panel.hidden
      functions.hidden = true; more.hidden = true
      for (const toggle of modifierRow.querySelectorAll('[aria-expanded]')) toggle.setAttribute('aria-expanded', 'false')
      panel.hidden = !opening
      button.setAttribute('aria-expanded', String(opening))
      root.dataset.layer = opening ? panel === functions ? 'functions' : 'more' : 'navigation'
    }, { signal })
    return button
  }
  modifierRow.append(groupToggle('Function keys: F1 to F12', 'F1–F12', functions), groupToggle('More keys', 'more', more))
  const eof = el('button', { type: 'button', class: 'key key-eof', 'data-key': 'ctrl-d', 'aria-label': 'Control-D: end of input. Tap twice.', disabled: true }, 'ctrl-d')
  inputs.push(eof)
  const disarm = (): void => {
    if (eofTimer) clearTimeout(eofTimer)
    eofTimer = null
    eof.classList.remove('armed'); eof.textContent = 'ctrl-d'
  }
  eof.addEventListener('pointerdown', event => event.preventDefault(), { signal })
  eof.addEventListener('click', () => {
    if (!enabled) return
    if (eofTimer) {
      if (performance.now() - eofAt < 350) return
      disarm(); if (write('\x04')) consume()
    } else {
      eof.classList.add('armed'); eof.textContent = 'ctrl-d?'; eofAt = performance.now()
      eofTimer = setTimeout(disarm, 3000)
    }
  }, { signal })
  more.append(eof)
  root.replaceChildren(modifierRow, nav, functions, more, hint)
  root.addEventListener('keydown', event => {
    if (event.target instanceof HTMLButtonElement && (event.key === ' ' || event.key === 'Enter')) event.stopPropagation()
  }, { signal })
  const reset = (): void => {
    stopRepeat(); disarm(); held.clear()
    for (const modifier of ['shift', 'ctrl', 'alt'] as const) { latches[modifier] = 'off'; taps[modifier] = -Infinity }
    paint()
  }
  window.addEventListener('blur', reset, { signal })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') reset() }, { signal })
  signal.addEventListener('abort', reset, { once: true })
  paint()
  return {
    reset,
    setEnabled(value): void {
      if (enabled === value) return
      enabled = value
      if (!value) reset()
      for (const button of inputs) button.disabled = !value
    }
  }
}
