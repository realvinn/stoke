import { useMemo } from 'react'
import type { Project, SessionMeta } from '@shared/types'
import { ContextBar } from './ContextMeter'
import { profilesFor } from '@shared/profiles'
import { IconChevron, IconFolder, IconPin, IconPlus, IconSearch } from './Icons'
import { UsageMeter } from './UsageMeter'
import { relativeTime } from '../lib/format'

interface Props {
  projects: Project[]
  loading: boolean
  query: string
  selectedPath: string | null
  expandedPath: string | null
  sessions: SessionMeta[]
  sessionsLoading: boolean
  onQueryChange: (q: string) => void
  onSelectProject: (p: Project) => void
  onToggleExpand: (p: Project) => void
  onStartNew: (p: Project) => void
  onResume: (s: SessionMeta) => void
  onPin: (p: Project) => void
  onAddRoot: () => void
  onOpenFolder: () => void
  onStartScratch: () => void
  /** Profile whose projects are shown; null shows everything. */
  activeProfile: string | null
  onSelectProfile: (id: string | null) => void
}

export function Sidebar({
  projects,
  loading,
  query,
  selectedPath,
  expandedPath,
  sessions,
  sessionsLoading,
  onQueryChange,
  onSelectProject,
  onToggleExpand,
  onStartNew,
  onResume,
  onPin,
  onAddRoot,
  onOpenFolder,
  onStartScratch,
  activeProfile,
  onSelectProfile
}: Props): React.JSX.Element {
  /*
   * Only show profiles that actually have projects on this machine, so the row
   * never advertises a folder the user does not use.
   */
  const available = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of projects) counts.set(p.group, (counts.get(p.group) ?? 0) + 1)
    return profilesFor(counts)
  }, [projects])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    /*
     * Searching reaches across every profile on purpose. The profile narrows
     * what you browse; it must never hide something you went looking for by
     * name — it is a view, not a permission.
     */
    const scoped = q || !activeProfile ? projects : projects.filter((p) => p.group === activeProfile)
    if (!q) return scoped
    return scoped.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
    )
  }, [projects, query, activeProfile])

  /*
   * Three stable buckets, ordered the way you actually reach for a project.
   *
   * Grouping by parent folder was tried first and read badly: most parents hold
   * exactly one project, so the sidebar filled with single-item headings like
   * "NORMALZOMBIEHORDESHOOTER". Recency is the useful axis; the parent folder
   * is demoted to a per-row detail instead.
   */
  const groups = useMemo(() => {
    const pinned: Project[] = []
    const recent: Project[] = []
    const rest: Project[] = []

    for (const p of filtered) {
      if (p.pinned) pinned.push(p)
      else if (p.sessionCount > 0) recent.push(p)
      else rest.push(p)
    }

    recent.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
    rest.sort((a, b) => a.name.localeCompare(b.name))

    const out: [string, Project[]][] = []
    if (pinned.length) out.push(['Pinned', pinned])
    if (recent.length) out.push(['Recent', recent])
    if (rest.length) out.push(['Other projects', rest])
    return out
  }, [filtered])

  return (
    <nav className="sidebar" style={{ width: '100%' }} aria-label="Projects">
      <div className="sidebar-head">
        {/* One profile plus All is still a useful choice; hiding the row below
            two meant a machine with a single work folder saw nothing at all. */}
        {available.length > 0 && (
          <div className="profiles" role="group" aria-label="Profile">
            <button
              className="profile-chip"
              aria-pressed={activeProfile === null}
              onClick={() => onSelectProfile(null)}
              title="Every project"
            >
              All
            </button>
            {available.map((p) => (
              <button
                key={p.id}
                className="profile-chip"
                aria-pressed={activeProfile === p.id}
                onClick={() => onSelectProfile(activeProfile === p.id ? null : p.id)}
                title={`${p.label} — ${p.id}`}
                style={
                  {
                    '--chip': p.accent,
                    '--chip-ink': p.accentContrast,
                    '--chip-soft': p.accentSoft,
                    '--chip-second': p.secondary ?? p.accent
                  } as React.CSSProperties
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        <label className="sr-only" htmlFor="project-search">
          Search projects
        </label>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <IconSearch
            style={{
              position: 'absolute',
              left: '0.5rem',
              color: 'var(--text-faint)',
              pointerEvents: 'none'
            }}
          />
          <input
            id="project-search"
            className="input"
            style={{ paddingLeft: '1.875rem' }}
            placeholder="Search projects"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            spellCheck={false}
          />
        </div>
        {/* Both routes into a session that is not a saved project. */}
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button className="btn" style={{ flex: 1 }} onClick={onOpenFolder}>
            <IconFolder />
            Open
          </button>
          <button
            className="btn"
            style={{ flex: 1 }}
            onClick={onStartScratch}
            title="Start a session in a fresh throwaway folder"
          >
            <IconPlus />
            Scratch
          </button>
        </div>
      </div>

      <div className="sidebar-scroll">
        {loading && (
          <p className="sidebar-group" aria-live="polite">
            Loading projects…
          </p>
        )}

        {!loading && projects.length === 0 && (
          <div className="empty">
            <h3>No projects yet</h3>
            <p>
              Stoke lists every folder you have used Claude Code in. Open a folder to start
              your first session, or add a folder to scan for projects.
            </p>
            <button className="btn" data-variant="primary" onClick={onOpenFolder}>
              Open a folder
            </button>
            <button className="btn" data-variant="ghost" onClick={onAddRoot}>
              Add a scan folder
            </button>
          </div>
        )}

        {!loading && projects.length > 0 && filtered.length === 0 && (
          <div className="empty">
            <h3>Nothing matches</h3>
            <p>No project name or path contains &ldquo;{query}&rdquo;.</p>
          </div>
        )}

        {groups.map(([group, items]) => (
          <div key={group}>
            <div className="sidebar-group">{group}</div>
            {items.map((project) => {
              const expanded = expandedPath === project.path
              return (
                <div key={project.path}>
                  <div
                    className="project"
                    aria-current={selectedPath === project.path}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectProject(project)}
                    onDoubleClick={() => onStartNew(project)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        onStartNew(project)
                      } else if (e.key === ' ') {
                        e.preventDefault()
                        onSelectProject(project)
                      }
                    }}
                    title={project.path}
                  >
                    <div className="project-top">
                      <button
                        className="icon-btn"
                        style={{
                          width: '1.125rem',
                          height: '1.125rem',
                          rotate: expanded ? '90deg' : '0deg',
                          transition: 'rotate var(--dur) var(--ease)'
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleExpand(project)
                        }}
                        aria-expanded={expanded}
                        title={expanded ? 'Hide sessions' : 'Show sessions'}
                      >
                        <IconChevron width={12} height={12} />
                        <span className="sr-only">
                          {expanded ? 'Hide sessions' : 'Show sessions'}
                        </span>
                      </button>

                      <span className="project-name">{project.name}</span>

                      <button
                        className="icon-btn project-pin"
                        style={{ width: '1.25rem', height: '1.25rem' }}
                        aria-pressed={project.pinned}
                        onClick={(e) => {
                          e.stopPropagation()
                          onPin(project)
                        }}
                        title={project.pinned ? 'Unpin' : 'Pin to top'}
                      >
                        <IconPin width={12} height={12} />
                        <span className="sr-only">{project.pinned ? 'Unpin' : 'Pin'}</span>
                      </button>
                    </div>

                    {/* Projects with history show their activity; ones without
                        show where they live, which is more use than repeating
                        "no sessions · never" down the whole list. */}
                    <div className="project-meta">
                      {!project.exists && <span className="project-missing">missing</span>}
                      {project.sessionCount > 0 ? (
                        <>
                          <span>
                            {project.sessionCount} session
                            {project.sessionCount === 1 ? '' : 's'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{relativeTime(project.lastModified)}</span>
                        </>
                      ) : (
                        <span className="truncate">{project.group || project.path}</span>
                      )}
                    </div>
                  </div>

                  {expanded && (
                    <div className="sessions">
                      {sessionsLoading && <div className="session-meta">Loading…</div>}
                      {!sessionsLoading && sessions.length === 0 && (
                        <div className="session-meta">
                          No saved sessions. Press Enter to start one.
                        </div>
                      )}
                      {!sessionsLoading &&
                        sessions.map((s) => (
                          <button
                            key={s.id}
                            className="session"
                            onClick={() => onResume(s)}
                            title={s.firstPrompt ?? s.id}
                          >
                            <span className="session-title">
                              {s.title ?? s.firstPrompt ?? 'Untitled session'}
                            </span>
                            <span className="session-meta">
                              <span>{relativeTime(s.modified)}</span>
                              {s.contextTokens > 0 && (
                                <ContextBar
                                  used={s.contextTokens}
                                  limit={s.contextLimit}
                                  showLabel={false}
                                />
                              )}
                              {s.gitBranch && s.gitBranch !== 'HEAD' && (
                                <span className="truncate">{s.gitBranch}</span>
                              )}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}

        {!loading && projects.length > 0 && (
          <button
            className="btn"
            data-variant="ghost"
            style={{ width: '100%', marginTop: 'var(--sp-4)' }}
            onClick={onAddRoot}
          >
            Add a scan folder
          </button>
        )}
      </div>

      {/*
        Outside the scrolling list deliberately. How much of the window is left
        is something you glance at mid-task, and it is no use if you have to
        scroll to find it.
      */}
      <UsageMeter />
    </nav>
  )
}
