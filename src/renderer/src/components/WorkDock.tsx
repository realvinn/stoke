import { useState } from 'react'
import { ActivityPanel } from './ActivityPanel'
import { WorkPanel } from './WorkPanel'
import { IconClose } from './Icons'
import { StatsPanel } from './StatsPanel'

export function WorkDock({ onClose, onOpenSettings, session }: { onClose: () => void; onOpenSettings?: () => void; session?: { id: string; title: string; notesPtyId?: string } }): React.JSX.Element {
  const [panel, setPanel] = useState<'stats' | 'activity' | 'work'>('stats')
  return <div className="work-dock">
    <div className="work-dock-tabs" onKeyDown={event => { if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation() }}>
      <button className="btn" aria-pressed={panel === 'stats'} onClick={() => setPanel('stats')}>Stats</button>
      <button className="btn" aria-pressed={panel === 'activity'} onClick={() => setPanel('activity')}>Activity</button>
      <button className="btn" aria-pressed={panel === 'work'} onClick={() => setPanel('work')}>Work boards</button>
      {panel !== 'activity' && <button className="icon-btn" title={panel === 'stats' ? 'Close Stats panel' : 'Close Work panel'} onClick={onClose}><IconClose /><span className="sr-only">{panel === 'stats' ? 'Close Stats panel' : 'Close Work panel'}</span></button>}
    </div>
    {panel === 'stats' ? <StatsPanel onOpenSettings={onOpenSettings} /> : panel === 'activity' ? <ActivityPanel onClose={onClose} /> : <div className="work-dock-body"><WorkPanel session={session} /></div>}
  </div>
}
