import { useRef, useState } from 'react'
import { IconChevron, IconTerminal } from './Icons'
import { ContextMenu } from './ContextMenu'

export function QuickTerminalButton({ enabled, visible, onToggle, onPopout, onSettings }: {
  enabled: boolean
  visible: boolean
  onToggle: () => void
  onPopout: () => void
  onSettings: () => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const options = useRef<HTMLButtonElement>(null)
  const close = (): void => { setMenu(null); options.current?.focus() }
  return <div className="status-terminal" onKeyDown={event => { if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation() }}>
    <button className="status-btn status-terminal-button" data-testid="footer-terminal" aria-pressed={visible} title={enabled ? visible ? 'Hide quick terminal; commands keep running' : 'Open local quick terminal' : 'Set up quick terminal · Off by default'} onClick={enabled ? onToggle : onSettings}><IconTerminal /><span>Terminal</span></button>
    <button className="status-btn status-terminal-options" ref={options} aria-label="Terminal options" aria-haspopup="menu" aria-expanded={!!menu} onClick={() => {
      const rect = options.current?.getBoundingClientRect()
      if (rect) setMenu({ x: rect.left, y: rect.top })
    }}><IconChevron /></button>
    {menu && <ContextMenu x={menu.x} y={menu.y} header={{ title: 'Quick terminal', subtitle: enabled ? 'Local shell · Commands keep running when hidden' : 'Off · Enable in Settings to run a local shell' }} items={[
      ...(enabled ? [{ label: visible ? 'Hide panel' : 'Open in side panel', onSelect: onToggle }, { label: 'Open in separate window', onSelect: onPopout }] : []),
      { label: 'Terminal settings', onSelect: onSettings }
    ]} onClose={close} />}
  </div>
}
