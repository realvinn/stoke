import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { QuickTerminalAppearance } from '@shared/quickTerminal'
import { QuickTerminalPanel, useQuickTerminal } from './components/QuickTerminal'
import { applyAppearance, applyTypography } from './lib/theme'
import './styles/app.css'

const api = window.stokeQuickTerminal
function QuickTerminalWindow(): React.JSX.Element {
  const state = useQuickTerminal(api)
  const [appearance, setAppearance] = useState<QuickTerminalAppearance | null>(null)
  useEffect(() => {
    let alive = true
    const update = (value: QuickTerminalAppearance): void => { if (alive) { applyAppearance(value.theme, null); applyTypography(value.fontFamily, value.fontSize, value.uiScale, value.terminal); setAppearance(value) } }
    const off = api.onAppearance(update)
    void api.appearance().then(update)
    return () => { alive = false; off() }
  }, [])
  return <div className="quick-terminal-window">{state && appearance && state.mode === 'popout' && <QuickTerminalPanel api={api} state={state} appearance={appearance} surface="popout" />}</div>
}
createRoot(document.getElementById('root')!).render(<QuickTerminalWindow />)
