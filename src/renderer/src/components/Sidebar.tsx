import { useMemo, useState } from 'react'
import type { Project, ProjectMeta, SessionMeta } from '@shared/types'
import { ContextBar } from './ContextMeter'
import type { ResolvedProfile } from '@shared/profiles'
import { foldGroup } from '@shared/profiles'
import { IconChevron, IconFolder, IconPin, IconPlus, IconSearch } from './Icons'
import { ProjectMetaPicker } from './ProjectMetaPicker'
import { relativeTime } from '../lib/format'

interface Props {
  projects: Project[]
  loading: boolean
  query: string
  selectedPath: string | null
  expandedPath: string | null
  sessions: SessionMeta[]
  sessionsLoading: boolean
  /**
   * Session ids that currently have a tab open. The row backing the terminal
   * you are looking at is the one row in this list worth finding again, and it
   * had no state of its own at all.
   */
  openSessionIds: string[]
  onQueryChange: (q: string) => void
  onSelectProject: (p: Project) => void
  onToggleExpand: (p: Project) => void
  onStartNew: (p: Project) => void
  onResume: (s: SessionMeta) => void
  onPin: (p: Project) => void
  /** Set or clear one folder's icon and display name. `null` clears the record. */
  onSetMeta: (project: Project, meta: ProjectMeta | null) => void
  onAddRoot: () => void
  onOpenFolder: () => void
  onStartScratch: () => void
  /**
   * Profiles this machine actually has. Resolved once in App and passed down, so
   * the chip row and the accent can never resolve against different lists.
   */
  profiles: ResolvedProfile[]
  /** Id of the profile whose projects are shown; null shows everything. */
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
  openSessionIds,
  onQueryChange,
  onSelectProject,
  onToggleExpand,
  onStartNew,
  onResume,
  onPin,
  onSetMeta,
  onAddRoot,
  onOpenFolder,
  onStartScratch,
  profiles,
  activeProfile,
  onSelectProfile
}: Props): React.JSX.Element {
  /* One picker open at a time, keyed by path — two open popovers in a scrolling
     list is a way to change the wrong folder without noticing. */
  const [pickerPath, setPickerPath] = useState<string | null>(null)

  /*
   * Only profiles that actually have projects on this machine, so the row never
   * advertises a folder the user does not use. Derived in App and passed in.
   */
  const available = profiles

  /* A Set so a project with a long history is one lookup per row, not a scan. */
  const openSessions = useMemo(() => new Set(openSessionIds), [openSessionIds])

  /*
   * The folders the selected chip covers, case-folded.
   *
   * A profile can cover more than one folder, and `Project.group` carries
   * whatever casing the path had, so comparing the selection to the group
   * directly matched nothing on a folder the user had typed differently.
   *
   * An id with no profile behind it is treated as a group name. App only passes
   * a selection that resolves, so this is defence rather than a live path.
   */
  const activeGroups = useMemo(() => {
    if (!activeProfile) return null
    const hit = profiles.find((p) => foldGroup(p.id) === foldGroup(activeProfile))
    return new Set((hit ? hit.groups : [activeProfile]).map(foldGroup))
  }, [profiles, activeProfile])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    /*
     * Searching reaches across every profile on purpose. The profile narrows
     * what you browse; it must never hide something you went looking for by
     * name — it is a view, not a permission.
     */
    const scoped =
      q || !activeGroups ? projects : projects.filter((p) => activeGroups.has(foldGroup(p.group)))
    if (!q) return scoped
    // The label is what the user sees, so it is what they will type. Searching
    // only the basename made a renamed folder unfindable by its own name.
    return scoped.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (p.label ?? '').toLowerCase().includes(q)
    )
  }, [projects, query, activeGroups])

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
            {available.map((p) => {
              const on = activeProfile !== null && foldGroup(activeProfile) === foldGroup(p.id)
              return (
                <button
                  key={p.id}
                  className="profile-chip"
                  aria-pressed={on}
                  onClick={() => onSelectProfile(on ? null : p.id)}
                  title={`${p.label} — ${p.groups.join(', ')}`}
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
              )
            })}
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
        <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
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
            <p>No project name, path, or label contains &ldquo;{query}&rdquo;.</p>
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
                      /*
                       * Enter and Space both do exactly what a click does.
                       *
                       * This row announces itself as `role="button"`, and the
                       * one promise that role makes is that both keys fire the
                       * element's own click. It used to start a session on
                       * Enter and select on Space, so assistive tech said
                       * "button", the user pressed the obvious key, and got a
                       * spawned process instead of a selection.
                       *
                       * Starting a session is the double-click escalation, so
                       * it keeps a modifier of its own rather than losing its
                       * keyboard route. metaKey OR ctrlKey, so the component
                       * needs no platform prop to be right on both.
                       */
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        onStartNew(project)
                      } else if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectProject(project)
                      }
                    }}
                    title={`${project.path}\nEnter selects · Cmd/Ctrl+Enter starts a session`}
                  >
                    <div className="project-top">
                      <button
                        className="icon-btn project-chevron"
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleExpand(project)
                        }}
                        aria-expanded={expanded}
                        title={expanded ? 'Hide sessions' : 'Show sessions'}
                      >
                        <IconChevron />
                        <span className="sr-only">
                          {expanded ? 'Hide sessions' : 'Show sessions'}
                        </span>
                      </button>

                      <ProjectMetaPicker
                        project={project}
                        open={pickerPath === project.path}
                        onOpenChange={(v) => setPickerPath(v ? project.path : null)}
                        onCommit={(meta) => onSetMeta(project, meta)}
                      />

                      {/* The label replaces the basename in this list only; the
                          row's title attribute still carries the real path. */}
                      <span className="project-name">{project.label ?? project.name}</span>

                      <button
                        className="icon-btn project-pin"
                        aria-pressed={project.pinned}
                        onClick={(e) => {
                          e.stopPropagation()
                          onPin(project)
                        }}
                        title={project.pinned ? 'Unpin' : 'Pin to top'}
                      >
                        <IconPin />
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
                            aria-current={openSessions.has(s.id) ? 'true' : undefined}
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
            style={{ width: '100%', marginTop: 'var(--space-12)' }}
            onClick={onAddRoot}
          >
            Add a scan folder
          </button>
        )}
      </div>

    </nav>
  )
}
