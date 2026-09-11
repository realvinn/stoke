import { useMemo, useState } from 'react'
import type { Project, ProjectMeta, SessionIndexEntry, SessionMeta } from '@shared/types'
import { ContextBar } from './ContextMeter'
import type { ResolvedProfile } from '@shared/profiles'
import { foldGroup } from '@shared/profiles'
import { Highlight } from './Highlight'
import { IconChevron, IconFolder, IconPin, IconPlus, IconSearch } from './Icons'
import { ProjectMetaPicker } from './ProjectMetaPicker'
import { relativeTime } from '../lib/format'
import {
  capSessions,
  indexPending,
  scopeProjects,
  searchProjects,
  snippet,
  type ProjectHit
} from '../lib/projectSearch'

/* One stable empty index, so the matcher's per-index grouping is not rebuilt per keystroke. */
const NO_INDEX: SessionIndexEntry[] = []

interface Props {
  projects: Project[]
  loading: boolean
  query: string
  /**
   * Every session's title and first prompt, across every listed project, for
   * search. Null until the first search fetched it — it is not loaded for a
   * sidebar nobody is searching.
   */
  sessionIndex: SessionIndexEntry[] | null
  /** True while that index is being (re)fetched. */
  sessionIndexLoading: boolean
  /** Why the last fetch failed, or null. Project matching carries on without it. */
  sessionIndexError: string | null
  selectedPath: string | null
  expandedPath: string | null
  /**
   * Every fetched session list, keyed by project path — not one array for
   * "the selected project".
   *
   * One array was wrong in a way that only showed after two clicks: expanding
   * project A fetched A's sessions, then a single click on project B moved the
   * selection (and the fetch) to B while A's row stayed expanded — so A's open
   * row listed B's conversations, under A's name, with A's chevron pointing
   * down. Clicking one resumed a session in a different folder. Keyed by path,
   * a row can only ever draw its own.
   */
  sessionsByPath: Record<string, SessionMeta[]>
  /** The path being fetched right now, or null. A row shows its own spinner. */
  sessionsLoadingPath: string | null
  /**
   * Session ids that currently have a tab open. The row backing the terminal
   * you are looking at is the one row in this list worth finding again, and it
   * had no state of its own at all.
   */
  openSessionIds: string[]
  /**
   * Folders with a session running right now. Drives the row's live dot, which
   * is the one thing the sidebar could not say: with six projects open across
   * a dozen tabs there was no way to tell, from the list, which ones you were
   * already in.
   */
  runningPaths: string[]
  onQueryChange: (q: string) => void
  onSelectProject: (p: Project) => void
  onToggleExpand: (p: Project) => void
  onStartNew: (p: Project) => void
  /** A full `SessionMeta` from an expanded list, or an index entry from a search hit. */
  onResume: (s: SessionIndexEntry) => void
  onPin: (p: Project) => void
  /** Set or clear one folder's icon and display name. `null` clears the record. */
  onSetMeta: (project: Project, meta: ProjectMeta | null) => void
  /** Stop listing this folder. Nothing on disk is touched. */
  onHide: (project: Project) => void
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
  sessionIndex,
  sessionIndexLoading,
  sessionIndexError,
  selectedPath,
  expandedPath,
  sessionsByPath,
  sessionsLoadingPath,
  openSessionIds,
  runningPaths,
  onQueryChange,
  onSelectProject,
  onToggleExpand,
  onStartNew,
  onResume,
  onPin,
  onSetMeta,
  onHide,
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
  const running = useMemo(() => new Set(runningPaths), [runningPaths])

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

  const searching = query.trim() !== ''

  /*
   * Searching reaches across every profile on purpose (`scopeProjects` says
   * why). The profile applies only to browsing.
   */
  const scoped = useMemo(
    () =>
      scopeProjects(
        projects,
        query,
        activeGroups ? (p) => activeGroups.has(foldGroup(p.group)) : null
      ),
    [projects, query, activeGroups]
  )

  /*
   * One ranked list while a query is active: project label, name and path, and
   * every session's title and first prompt — the label is what the user sees,
   * so it is what they will type, and a conversation is as often what they
   * remember as the folder it happened in. Before the index has arrived the
   * projects still match on their own fields; the sessions join when it lands.
   */
  const hits = useMemo(
    () => (searching ? searchProjects(scoped, sessionIndex ?? NO_INDEX, query) : null),
    [searching, scoped, sessionIndex, query]
  )

  /* No session has been looked at yet — including the frame before App's effect starts the fetch. */
  const pending = indexPending(sessionIndex, sessionIndexLoading, sessionIndexError)

  /*
   * Which hit rows the user folded, and which asked for every match rather than
   * the first few — for this query only, so a new query starts clean.
   *
   * Held here and not in App's `expandedPath`/`browseExpanded`. What a search
   * expands is derived from its hits; written into the browse state it would be
   * a second writer on that value (gotcha 57), and clearing the query would not
   * give back the view the user had before they typed.
   */
  const viewKey = query.trim()
  const [searchView, setSearchView] = useState({
    query: '',
    folded: [] as string[],
    all: [] as string[]
  })
  const view =
    searchView.query === viewKey ? searchView : { query: viewKey, folded: [], all: [] }
  const flip = (list: 'folded' | 'all', path: string): void =>
    setSearchView((cur) => {
      const base = cur.query === viewKey ? cur : { query: viewKey, folded: [], all: [] }
      const on = base[list].includes(path)
      return { ...base, [list]: on ? base[list].filter((p) => p !== path) : [...base[list], path] }
    })

  /*
   * Three stable buckets, ordered the way you actually reach for a project.
   *
   * Grouping by parent folder was tried first and read badly: most parents hold
   * exactly one project, so the sidebar filled with single-item headings like
   * "NORMALZOMBIEHORDESHOOTER". Recency is the useful axis; the parent folder
   * is demoted to a per-row detail instead.
   *
   * Browsing only. A search result is one list in rank order: splitting it into
   * these buckets would put a pinned project that merely shares a path segment
   * above the conversation someone was actually looking for.
   */
  const groups = useMemo(() => {
    if (searching) return []
    const pinned: Project[] = []
    const recent: Project[] = []
    const rest: Project[] = []

    for (const p of scoped) {
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
  }, [scoped, searching])

  /* The whole list of an expanded project's sessions — browsing, or a search row with no session hits. */
  const fullSessions = (project: Project): React.JSX.Element => {
    /* This row's own sessions, never "the selected project's". */
    const rowSessions = sessionsByPath[project.path] ?? []
    const rowLoading = sessionsLoadingPath === project.path && rowSessions.length === 0
    return (
      <div className="sessions">
        {rowLoading && <div className="session-meta">Loading…</div>}
        {!rowLoading && rowSessions.length === 0 && (
          <div className="session-meta">No saved sessions. Press Enter to start one.</div>
        )}
        {!rowLoading &&
          rowSessions.map((s) => (
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
                  <ContextBar used={s.contextTokens} limit={s.contextLimit} showLabel={false} />
                )}
                {s.gitBranch && s.gitBranch !== 'HEAD' && (
                  <span className="truncate">{s.gitBranch}</span>
                )}
              </span>
            </button>
          ))}
      </div>
    )
  }

  /*
   * Only the sessions that matched, first five and then "Show N more". Clicking
   * one resumes it exactly as the same row in an expanded list does: the same
   * `onResume`, with the same id, folder, title and first prompt.
   */
  const sessionHits = (hit: ProjectHit): React.JSX.Element => {
    const path = hit.project.path
    const { shown, hidden } = capSessions(hit.sessions, view.all.includes(path))
    return (
      <div className="sessions">
        {shown.map(({ session: s, label, detail }) => (
          <button
            key={s.id}
            className="session"
            aria-current={openSessions.has(s.id) ? 'true' : undefined}
            onClick={() => onResume(s)}
            title={s.firstPrompt ?? s.id}
          >
            <span className="session-title">
              <Highlight text={label.text} ranges={label.ranges} />
            </span>
            {detail && (
              <span className="session-snippet">
                <Highlight text={detail.text} ranges={detail.ranges} />
              </span>
            )}
            <span className="session-meta">
              <span>{relativeTime(s.modified)}</span>
            </span>
          </button>
        ))}
        {hidden > 0 && (
          <button className="session-more" onClick={() => flip('all', path)}>
            Show {hidden} more
          </button>
        )}
      </div>
    )
  }

  /* Projects with history show their activity; ones without show where they
     live, which is more use than repeating "no sessions · never" down the
     whole list. */
  const defaultMeta = (project: Project): React.JSX.Element => (
    <>
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
    </>
  )

  /*
   * One project row, shared by browsing and search so the two can never drift
   * apart in what a click, a double-click or a key does. The callers differ
   * only in what the name and metadata lines say, what the chevron toggles,
   * and what is listed under the row.
   */
  const renderProject = (
    project: Project,
    row: {
      expanded: boolean
      onChevron: () => void
      name: React.ReactNode
      meta: React.ReactNode
      body: React.ReactNode
    }
  ): React.JSX.Element => (
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
              row.onChevron()
            }}
            aria-expanded={row.expanded}
            title={row.expanded ? 'Hide sessions' : 'Show sessions'}
          >
            <IconChevron />
            <span className="sr-only">{row.expanded ? 'Hide sessions' : 'Show sessions'}</span>
          </button>

          <ProjectMetaPicker
            project={project}
            open={pickerPath === project.path}
            onOpenChange={(v) => setPickerPath(v ? project.path : null)}
            onCommit={(meta) => onSetMeta(project, meta)}
            onHide={() => onHide(project)}
          />

          {/* The label replaces the basename in this list only; the
              row's title attribute still carries the real path. */}
          <span className="project-name">{row.name}</span>

          {/* A session is open in this folder right now. Placed
              before the two buttons so it never moves as they
              appear and disappear on hover. */}
          {running.has(project.path) && (
            <span className="project-live" title="A session is running here">
              <span className="sr-only">session running</span>
            </span>
          )}

          {/* Hover-revealed, like the pin. Double-click already
              starts a session and is undiscoverable; the row's own
              title says so and nobody reads a title attribute. */}
          <button
            className="icon-btn project-start"
            onClick={(e) => {
              e.stopPropagation()
              onStartNew(project)
            }}
            title={`Start a session in ${project.path}`}
          >
            <IconPlus />
            <span className="sr-only">Start a session in {project.name}</span>
          </button>

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

        <div className="project-meta">{row.meta}</div>
      </div>

      {row.body}
    </div>
  )

  /*
   * A search row. A project with matching sessions opens on them by itself —
   * derived from the hits, and folded away only by its own chevron, for this
   * query. One without them opens the ordinary way, onto its whole list.
   *
   * The metadata line swaps to the path, highlighted, when that is the only
   * place the match can be seen: a hit in a parent folder, or on a basename the
   * row hides behind a label.
   */
  const renderHit = (hit: ProjectHit): React.JSX.Element => {
    const { project } = hit
    const hasSessions = hit.sessions.length > 0
    const expanded = hasSessions
      ? !view.folded.includes(project.path)
      : expandedPath === project.path
    const pathOnly = hit.nameRanges.length === 0 && hit.pathRanges.length > 0
    const where = pathOnly ? snippet(project.path, hit.pathRanges) : null
    return renderProject(project, {
      expanded,
      onChevron: hasSessions ? () => flip('folded', project.path) : () => onToggleExpand(project),
      name: <Highlight text={project.label ?? project.name} ranges={hit.nameRanges} />,
      meta: where ? (
        <>
          {!project.exists && <span className="project-missing">missing</span>}
          <span className="truncate">
            <Highlight text={where.text} ranges={where.ranges} />
          </span>
        </>
      ) : (
        defaultMeta(project)
      ),
      body: !expanded ? null : hasSessions ? sessionHits(hit) : fullSessions(project)
    })
  }

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
          Search projects and sessions
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
            placeholder="Search projects and sessions"
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

        {/*
          Browsing with a profile that leaves nothing to show. Only reachable
          without a query — a query ignores the profile — so this is not a
          search result and says nothing about matching.
        */}
        {!loading && !searching && projects.length > 0 && scoped.length === 0 && (
          <div className="empty">
            <h3>Nothing here</h3>
            <p>No project belongs to this profile. Choose All to see every project.</p>
          </div>
        )}

        {/* Only the first fetch says so: a refresh keeps the results already on screen. */}
        {searching && pending && (
          <p className="sidebar-note" aria-live="polite">
            Searching sessions…
          </p>
        )}

        {/* Project names still match without it, so a failed index narrows the
            search rather than ending it — and says so, rather than reporting a
            conversation as absent that was never looked at. */}
        {searching && sessionIndexError && (
          <p className="sidebar-note" role="status">
            Session titles could not be searched: {sessionIndexError}
          </p>
        )}

        {/* Not with no projects at all: "No projects yet" above already says
            everything, and this would contradict it. */}
        {!loading &&
          projects.length > 0 &&
          hits !== null &&
          hits.length === 0 &&
          !pending && (
            <div className="empty">
              <h3>Nothing matches</h3>
              <p>
                {sessionIndexError ? (
                  <>No project name, path or label contains &ldquo;{query.trim()}&rdquo;.</>
                ) : (
                  <>
                    Nothing matches &ldquo;{query.trim()}&rdquo; in project names, paths, labels,
                    session titles or first prompts.
                  </>
                )}
              </p>
            </div>
          )}

        {hits?.map(renderHit)}

        {groups.map(([group, items]) => (
          <div key={group}>
            <div className="sidebar-group">{group}</div>
            {items.map((project) => {
              const expanded = expandedPath === project.path
              return renderProject(project, {
                expanded,
                onChevron: () => onToggleExpand(project),
                name: project.label ?? project.name,
                meta: defaultMeta(project),
                body: expanded ? fullSessions(project) : null
              })
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
