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

const QUICK: readonly Key[] = [
  { label: 'Esc', name: 'Escape', key: 'Escape' },
  { label: 'Tab', name: 'Tab', key: 'Tab' },
  { label: '↑', name: 'Up arrow', key: 'ArrowUp', repeat: true },
  { label: '↓', name: 'Down arrow', key: 'ArrowDown', repeat: true },
  { label: 'Enter', name: 'Enter', key: 'Enter' }
]
const NAVIGATION: readonly Key[] = [
  { label: '←', name: 'Left arrow', key: 'ArrowLeft', repeat: true },
  { label: '↑', name: 'Up arrow', key: 'ArrowUp', repeat: true },
  { label: '↓', name: 'Down arrow', key: 'ArrowDown', repeat: true },
  { label: '→', name: 'Right arrow', key: 'ArrowRight', repeat: true },
  { label: 'Home', name: 'Home', key: 'Home' },
  { label: 'End', name: 'End', key: 'End' },
  { label: 'Pg up', name: 'Page up', key: 'PageUp' },
  { label: 'Pg dn', name: 'Page down', key: 'PageDown' }
]
const SHORTCUTS: readonly Key[] = [
  { label: 'Shift+Tab', name: 'Shift-Tab: cycle permission mode', sequence: '\x1b[Z' },
  { label: 'Ctrl+C', name: 'Control-C: interrupt', sequence: '\x03' },
  { label: 'Ctrl+R', name: 'Control-R: search history', sequence: '\x12' },
  { label: 'Ctrl+L', name: 'Control-L: clear screen', sequence: '\x0c' }
]
const EDIT: readonly Key[] = [
  { label: '⌫', name: 'Backspace', key: 'Backspace', repeat: true },
  { label: 'Insert', name: 'Insert', key: 'Insert' },
  { label: 'Delete', name: 'Delete', key: 'Delete' }
]

/**
 * Keep the composer's focus (and the phone's keyboard) through a tap on a
 * control that acts on its click: cancel the MOUSEDOWN, whose default moves
 * focus. Never cancel such a control's pointerdown: WebKit then drops the
 * tap's click, though Chromium still fires it, so in WebKit 26.6 the key row's
 * toggle, More, the group tabs, Ctrl+D and every key sent on click did nothing.
 * A key that acts on the press itself (a repeat key, a modifier) may cancel it.
 */
export function keepFocusOnTap(control: HTMLElement, signal: AbortSignal): void {
  control.addEventListener('mousedown', event => event.preventDefault(), { signal })
}

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
    keepFocusOnTap(button, signal)
    // A repeat key sends on the press; any other key on its click (keepFocusOnTap).
    button.addEventListener('pointerdown', event => {
      if (!enabled || event.button !== 0 || !key.repeat) return
      event.preventDefault()
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
  const quick = el('div', { class: 'keys-quick', role: 'group', 'aria-label': 'Quick terminal keys' }, ...QUICK.map(keyButton))
  const tabs = el('div', { class: 'keys-tabs', role: 'tablist', 'aria-label': 'Terminal key groups' })
  const body = el('div', { class: 'keys-panel-body' })
  const panel = el('div', { class: 'keys-panel', id: `${root.id}-panel`, hidden: true }, modifierRow, tabs, body, hint)
  const moreButton = el('button', { type: 'button', class: 'key key-more-toggle', 'aria-label': 'More terminal keys', 'aria-expanded': 'false', 'aria-controls': panel.id }, 'More')
  const groups = [
    { id: 'navigate', label: 'Navigate', keys: NAVIGATION },
    { id: 'shortcuts', label: 'Shortcuts', keys: SHORTCUTS },
    { id: 'functions', label: 'F keys', keys: TERMINAL_FUNCTION_KEYS.map(key => ({ label: key, name: key, key })) },
    { id: 'edit', label: 'Edit', keys: EDIT }
  ]
  const panels = groups.map(group => el('div', { class: `keys-page keys-${group.id}`, role: 'tabpanel', id: `${root.id}-${group.id}`, 'aria-labelledby': `${root.id}-tab-${group.id}`, hidden: true }, ...group.keys.map(keyButton)))
  const groupButtons: HTMLButtonElement[] = []
  const selectGroup = (index: number): void => {
    stopRepeat(); disarm()
    panels.forEach((page, i) => { page.hidden = i !== index })
    groupButtons.forEach((button, i) => { button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1 })
  }
  groups.forEach((group, index) => {
    const button = el('button', { type: 'button', class: 'key key-group-toggle', role: 'tab', id: `${root.id}-tab-${group.id}`, 'aria-controls': panels[index].id }, group.label)
    keepFocusOnTap(button, signal)
    button.addEventListener('click', () => selectGroup(index), { signal })
    button.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % groups.length : event.key === 'ArrowLeft' ? (index + groups.length - 1) % groups.length : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); event.stopPropagation(); selectGroup(next); groupButtons[next].focus()
    }, { signal })
    groupButtons.push(button); tabs.append(button)
  })
  keepFocusOnTap(moreButton, signal)
  moreButton.addEventListener('click', () => {
    const opening = panel.hidden
    if (!opening) reset()
    panel.hidden = !opening
    moreButton.setAttribute('aria-expanded', String(opening))
    root.dataset.expanded = String(opening)
  }, { signal })
  quick.append(moreButton)
  body.append(...panels)
  const eof = el('button', { type: 'button', class: 'key key-eof', 'data-key': 'ctrl-d', 'aria-label': 'Control-D: end of input. Tap twice.', disabled: true }, 'Ctrl+D')
  inputs.push(eof)
  const disarm = (): void => {
    if (eofTimer) clearTimeout(eofTimer)
    eofTimer = null
    eof.classList.remove('armed'); eof.textContent = 'Ctrl+D'; eof.setAttribute('aria-label', 'Control-D: end of input. Tap twice.')
  }
  keepFocusOnTap(eof, signal)
  eof.addEventListener('click', () => {
    if (!enabled) return
    if (eofTimer) {
      if (performance.now() - eofAt < 350) return
      disarm(); if (write('\x04')) consume()
    } else {
      eof.classList.add('armed'); eof.textContent = 'Confirm'; eof.setAttribute('aria-label', 'Confirm Control-D: end of input'); eofAt = performance.now()
      eofTimer = setTimeout(disarm, 3000)
    }
  }, { signal })
  panels[3].append(eof)
  root.replaceChildren(quick, panel)
  root.addEventListener('keydown', event => {
    if (event.target instanceof HTMLButtonElement && (event.key === ' ' || event.key === 'Enter')) event.stopPropagation()
  }, { signal })
  const reset = (): void => {
    stopRepeat(); disarm(); held.clear()
    panel.hidden = true; moreButton.setAttribute('aria-expanded', 'false'); root.dataset.expanded = 'false'
    for (const modifier of ['shift', 'ctrl', 'alt'] as const) { latches[modifier] = 'off'; taps[modifier] = -Infinity }
    paint()
  }
  window.addEventListener('blur', reset, { signal })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') reset() }, { signal })
  signal.addEventListener('abort', reset, { once: true })
  selectGroup(0)
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
