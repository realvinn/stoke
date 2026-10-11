import { useEffect, useRef, useState } from 'react'
import { gitChip, shownGitStatus } from '@shared/gitStatus'
import { useGitStatus } from '../lib/useGitStatus'
import { ContextMenu } from './ContextMenu'
import { IconChevron } from './Icons'

/** Uses the same read-only reader as the title bar; never fetches or stores credentials. */
export function SidebarRepository({ cwd, busy, onReveal }: {
  cwd: string | null
  busy: boolean
  onReveal: (path: string) => void
}): React.JSX.Element {
  const git = useGitStatus(cwd, { enabled: !!cwd, busy })
  const [now, setNow] = useState(Date.now)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [git.status])
  const status = shownGitStatus(git.status, now)
  const chip = gitChip(status)
  const close = (): void => { setMenu(null); button.current?.focus() }
  return <div className="sidebar-repository" data-testid="sidebar-repository" onKeyDown={event => { if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation() }}>
    <button className="sidebar-repository-button" ref={button} disabled={!cwd} aria-haspopup="menu" aria-expanded={!!menu} title={chip?.title ?? cwd ?? 'Select a local project to see Git details'} onClick={() => {
      const rect = button.current?.getBoundingClientRect()
      if (rect) setMenu({ x: rect.left, y: rect.top })
    }}>
      <span className="sidebar-repository-copy"><span className="sidebar-footer-label">Repository</span><strong className="mono">{chip?.head ?? (cwd ? status ? 'No Git repository' : 'Reading Git…' : 'Select a local project')}</strong></span>
      {chip && <span className="sidebar-git-changes">{chip.changes === null ? '…' : chip.changes === 0 ? 'Clean' : `${chip.changes} changes`}</span>}
      <IconChevron />
    </button>
    {menu && cwd && <ContextMenu x={menu.x} y={menu.y} header={{ title: chip?.head ?? 'Repository', subtitle: status?.root ?? cwd, lines: chip?.title.split('\n').slice(1) ?? [status?.error ?? 'No Git repository in this folder.'] }} items={[
      { label: 'Refresh Git status', onSelect: git.refresh },
      ...(status?.branch ? [{ label: 'Copy branch name', onSelect: () => window.stoke.clipboard.writeText(status.branch!) }] : []),
      { label: 'Open repository folder', onSelect: () => onReveal(status?.root ?? cwd) }
    ]} footer="Ahead and behind are from the last fetch. Stoke does not fetch here." onClose={close} />}
  </div>
}
