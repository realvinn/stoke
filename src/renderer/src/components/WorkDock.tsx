import { useState } from 'react'
import { ActivityPanel } from './ActivityPanel'
import { WorkPanel } from './WorkPanel'
import { IconClose } from './Icons'

export function WorkDock({ onClose, session }: { onClose: () => void; session?: { id: string; title: string } }): React.JSX.Element {
  const [panel, setPanel] = useState<'activity' | 'work'>('activity')
  return <div className="work-dock">
    <div className="work-dock-tabs">
      <button className="btn" aria-pressed={panel === 'activity'} onClick={() => setPanel('activity')}>Activity</button>
      <button className="btn" aria-pressed={panel === 'work'} onClick={() => setPanel('work')}>Work boards</button>
      {panel === 'work' && <button className="icon-btn" title="Close Work panel" onClick={onClose}><IconClose /><span className="sr-only">Close Work panel</span></button>}
    </div>
    {panel === 'activity' ? <ActivityPanel onClose={onClose} /> : <div className="work-dock-body"><WorkPanel session={session} /></div>}
  </div>
}
