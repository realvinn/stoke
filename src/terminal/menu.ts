import stringWidth from 'string-width'
import type { MenuForm } from './forms.ts'
import { composerView } from './input.ts'

export type MenuSection = 'new' | 'chats' | 'agents' | 'models' | 'remote' | 'settings' | 'help' | 'commands'
export const MENU_SECTIONS: MenuSection[] = ['new', 'chats', 'agents', 'models', 'remote', 'settings', 'help']
export interface MenuItem { id: string; title: string; subtitle: string; detail: string[] }
export interface MenuView {
  section: MenuSection
  query: string
  selected: number
  items: MenuItem[]
  notice: string
  active: string
  theme?: 'ember' | 'ocean' | 'terminal'
  context?: string
  form?: MenuForm
}
const strip = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export function fit(value: string, width: number): string {
  let result = '', used = 0
  for (const { segment } of segments.segment(strip(value))) {
    const size = stringWidth(segment)
    if (used + size > width) break
    result += segment; used += size
  }
  return result + ' '.repeat(Math.max(0, width - used))
}
export function menuItems(view: Pick<MenuView, 'items' | 'query'>): MenuItem[] {
  const terms = view.query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return view.items.filter((item) => terms.every((term) => `${item.title} ${item.subtitle} ${item.detail.join(' ')}`.toLowerCase().includes(term)))
}

export function wrap(value: string, width: number): string[] {
  if (width < 1) return []
  const rows: string[] = []
  let row = ''
  for (const word of strip(value).split(/\s+/).filter(Boolean)) {
    if (row && stringWidth(`${row} ${word}`) <= width) { row += ` ${word}`; continue }
    if (row) { rows.push(row); row = '' }
    for (const { segment } of segments.segment(word)) {
      if (stringWidth(row + segment) > width) { rows.push(row); row = '' }
      if (stringWidth(segment) <= width) row += segment
    }
  }
  rows.push(row)
  return rows
}

const THEMES = {
  ember: { accent: '\x1b[38;2;231;163;108m', muted: '\x1b[38;2;140;146;158m', selected: '\x1b[48;2;48;53;64m\x1b[38;2;236;230;222m', border: '\x1b[38;2;73;80;91m' },
  ocean: { accent: '\x1b[38;2;130;191;210m', muted: '\x1b[38;2;140;146;158m', selected: '\x1b[48;2;39;57;68m\x1b[38;2;224;236;240m', border: '\x1b[38;2;73;80;91m' },
  terminal: { accent: '\x1b[36m', muted: '\x1b[2m', selected: '\x1b[7m', border: '\x1b[2m' }
}
const LABELS: Record<MenuSection, string> = { new: 'New', chats: 'Sessions', agents: 'Agents', models: 'Models', remote: 'Connections', settings: 'Settings', help: 'Help', commands: 'Commands' }

export function renderWelcome(agent: string, model: string, cwd: string, themeName: keyof typeof THEMES, columns: number, promptSupported: boolean): string {
  const theme = THEMES[themeName]
  const width = Math.max(1, columns - 1)
  const color = (style: string, value: string): string => process.env.NO_COLOR !== undefined ? value : style + value + '\x1b[0m'
  return '\r\n' + [
    color(theme.accent + '\x1b[1m', fit(' ● stoke', width)),
    color(theme.muted, fit(' Your agents, one workspace', width)),
    '',
    fit(` ${agent}  /  ${model || 'agent default'}`, width),
    color(theme.muted, fit(` ${cwd}`, width)),
    '',
    fit(promptSupported ? ' Type a message to start a chat.' : ' Type /new to open this agent and start a chat.', width),
    color(theme.accent, fit(' F5 workspace   ·   /settings   ·   /connections', width)),
    ''
  ].join('\r\n')
}

/** A theme-friendly terminal layout: searchable navigation on the left,
 * selection details and persistent shortcut hints on the right. */
export function renderMenu(view: MenuView, columns: number, rows: number): string {
  const width = Math.max(1, columns - 1), height = Math.max(1, rows)
  if (height < 10 || width < 18) return '\x1b[?25l\x1b[H' + Array.from({ length: height }, (_, row) => fit(row === 0 ? 'Resize terminal' : row === 1 ? 'Use 20 × 10 or larger' : '', width)).join('\r\n')
  const theme = THEMES[view.theme ?? 'ember']
  const paint = (style: string, value: string): string => process.env.NO_COLOR !== undefined ? value : style + value + '\x1b[0m'
  const items = menuItems(view)
  const selected = Math.max(0, Math.min(view.selected, items.length - 1))
  const current = items[selected]
  const lines: string[] = []
  const line = (text: string, style = ''): void => { lines.push(paint(style, fit(text, width))) }
  line(' ● stoke     /     your terminal workspace', theme.accent + '\x1b[1m')
  line(` ${view.context || view.active || 'Local workspace'}     F5 / Esc: back to terminal`, theme.muted)
  const nav = MENU_SECTIONS.map((section) => ` ${LABELS[section]} `)
  if (stringWidth(nav.join(' ')) < width) {
    const text = nav.map((label, i) => paint(MENU_SECTIONS[i] === view.section ? theme.selected + '\x1b[1m' : theme.muted, label)).join(' ')
    lines.push(text + ' '.repeat(width - stringWidth(nav.join(' '))))
  } else line(` ${LABELS[view.section]}   ·   Tab to switch sections`, theme.accent)
  line(view.form ? ` ${view.form.title}  ·  Tab next field` : ` Search ${LABELS[view.section].toLowerCase()}: ${view.query || 'type to filter…'}`, view.form ? theme.accent : '')
  line('─'.repeat(width), theme.border)
  const bodyRows = Math.max(1, height - 9)
  let cursor = ''
  if (view.form) {
    const form = view.form
    const formLines: { text: string; style: string }[] = []
    const push = (text: string, style = ''): void => { formLines.push({ text, style }) }
    for (const row of wrap(form.description, Math.max(1, width - 4))) push(`  ${row}`, theme.muted)
    push('')
    let focusedRow = 0
    let focusedColumn = 1
    form.fields.forEach((field, index) => {
      push(`  ${field.label}`, index === form.focused ? theme.accent : theme.muted)
      if (index === form.focused) focusedRow = formLines.length
      const frame = composerView(field.value, field.cursor ?? field.value.length, `  ${index === form.focused ? '›' : ' '} `, width + 1)
      if (index === form.focused) focusedColumn = stringWidth(frame.beforeCursor) + 1
      push((field.value ? frame.text : `  ${index === form.focused ? '›' : ' '} ${field.placeholder || '…'}`) + (field.choices ? '   ← →' : ''), index === form.focused ? theme.selected : '')
      push('')
    })
    if (form.focused === form.fields.length) focusedRow = formLines.length
    push(`  ${form.focused === form.fields.length ? '›' : ' '} [ ${form.submit} ]`, theme.accent + '\x1b[1m')
    if (form.error) for (const row of wrap(form.error, Math.max(1, width - 4))) push(`  ${row}`, theme.accent)
    const offset = Math.max(0, focusedRow - Math.max(1, bodyRows - 2) + 1)
    for (let row = 0; row < bodyRows; row++) {
      const item = formLines[offset + row]
      line(item?.text || '', item?.style || '')
    }
    const field = form.fields[form.focused]
    if (field && !field.choices) cursor = `\x1b[${6 + focusedRow - offset};${Math.min(width, focusedColumn)}H\x1b[?25h`
  } else {
    const leftWidth = width >= 70 ? Math.min(43, Math.floor(width * 0.44)) : width
    const rightWidth = width - leftWidth - 3
    const visible = Math.max(1, Math.floor(bodyRows / 2))
    const offset = Math.max(0, selected - visible + 1)
    const details = current ? [current.title, current.subtitle, '', ...current.detail] : view.section === 'remote' && !view.items.length
      ? ['No connections configured', 'Add a connection under remotes in /config.', '', 'SSH hosts and OpenCode servers are supported.', '', 'Press / and enter config to see the file.']
      : ['No matches', 'Try another search, or F2 to open New.']
    const detailRows = details.flatMap((text) => wrap(text, Math.max(1, rightWidth - 3)))
    for (let row = 0; row < bodyRows; row++) {
      const index = offset + Math.floor(row / 2), item = items[index]
      const isSelected = !!item && selected === index
      const title = row % 2 === 0
      const text = item ? title ? `${isSelected ? '▎' : ' '} ${item.title}` : `  ${item.subtitle}` : row === 0 ? '  No matches' : ''
      const left = paint(isSelected ? theme.selected : title ? '' : theme.muted, fit(text, leftWidth))
      const right = rightWidth > 0 ? paint(theme.border, ' │ ') + paint(row === 0 ? theme.accent + '\x1b[1m' : row === 1 ? theme.muted : '', fit(` ${detailRows[row] || ''}`, rightWidth)) : ''
      lines.push(left + right)
    }
  }
  line('─'.repeat(width), theme.border)
  line(view.form ? ` ${view.form.error || 'Changes apply when you save.'}` : view.notice ? ` ${view.notice}` : ` ${items.length} ${LABELS[view.section].toLowerCase()} · ${view.active || 'Your shells and agents keep running.'}`, view.notice || view.form?.error ? theme.accent : theme.muted)
  line(view.form ? ' Tab next · ←→ choices · Ctrl+U clear · Ctrl+S save · Esc cancel' : view.section === 'remote' ? ' Enter connect · Ctrl+A add · Ctrl+E edit · Ctrl+D remove · Ctrl+T test' : view.section === 'models' ? ' Enter select · Ctrl+A custom model · F2 new' : view.section === 'settings' ? ' Enter change · Ctrl+S settings · F2 new' : ' ↑↓ browse · Enter open · F2 new · / command', theme.muted)
  line(view.form ? ' Ctrl+S saves this form · Esc cancels without saving' : ' F3/F4 switch · F6 detach · F9 settings · Tab sections · / command', theme.muted)
  // Every row is bounded to leave the final terminal column unused: no wraps
  // or extra bottom-row newline to scroll the menu off screen.
  return '\x1b[?25l\x1b[H' + lines.slice(0, height).join('\r\n') + '\x1b[0m' + cursor
}
