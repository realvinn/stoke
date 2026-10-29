import { useEffect, useState } from 'react'
import type { StatsView } from '@shared/stats'

export const STATS_PANEL_REFRESH_MS = 60_000
export function useStats(): { view: StatsView | null; error: string } {
  const [view, setView] = useState<StatsView | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    const accept = (next: StatsView): void => { if (live) { setView(current => !current || next.revision >= current.revision ? next : current); setError('') } }
    const off = window.stoke.stats.onChange(accept)
    const read = (): void => { void window.stoke.stats.read().then(accept).catch(error => { if (live) setError(error instanceof Error ? error.message : 'Unknown error') }) }
    read(); const timer = window.setInterval(read, STATS_PANEL_REFRESH_MS)
    return () => { live = false; off(); window.clearInterval(timer) }
  }, [])
  return { view, error }
}
