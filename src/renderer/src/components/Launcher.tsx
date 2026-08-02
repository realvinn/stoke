import { useEffect, useRef } from 'react'
import type { CliInfo, EffortLevel, PermissionMode, Project, SessionMeta } from '@shared/types'
import { ContextBar } from './ContextMeter'
import { IconFolder } from './Icons'
import { relativeTime } from '../lib/format'
import { EFFORT_LEVELS, MODEL_OPTIONS, PERMISSION_MODES } from '../lib/permissions'

interface Props {
  project: Project | null
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  sessions: SessionMeta[]
  cli: CliInfo | null
  onChangeMode: (m: PermissionMode) => void
  onChangeModel: (m: string) => void
  onChangeEffort: (e: EffortLevel) => void
  onStart: () => void
  onContinueLast: () => void
  onResume: (s: SessionMeta) => void
  onOpenFolder: () => void
}

export function Launcher({
  project,
  permissionMode,
  model,
  effort,
  sessions,
  cli,
  onChangeMode,
  onChangeModel,
  onChangeEffort,
  onStart,
  onContinueLast,
  onResume,
  onOpenFolder
}: Props): React.JSX.Element {
  const startRef = useRef<HTMLButtonElement>(null)

  // Focus the primary action so the app is one keystroke from a live session.
  useEffect(() => {
    startRef.current?.focus()
  }, [project?.path])

  if (!project) {
    return (
      <div className="launcher">
        <div className="empty">
          <h3>Pick a project to begin</h3>
          <p>
            Choose a project on the left to start a Claude Code session in it, or open any
            folder on disk. Sessions you have run before can be resumed with their full
            history.
          </p>
          <button className="btn" data-variant="primary" onClick={onOpenFolder}>
            <IconFolder />
            Open a folder
          </button>
        </div>
      </div>
    )
  }

  const bypass = permissionMode === 'bypassPermissions'
  const activeMode = PERMISSION_MODES.find((m) => m.id === permissionMode)
  const recent = sessions.slice(0, 4)

  return (
    <div className="launcher">
      <div className="launcher-card">
        <div className="launcher-head">
          <h1 className="launcher-title">{project.name}</h1>
          <span className="launcher-path mono">{project.path}</span>
          {!project.exists && (
            <span className="pill" data-tone="danger">
              This folder no longer exists on disk
            </span>
          )}
        </div>

        <div>
          <div className="launcher-row">
            <span className="launcher-row-label">
              <b>Permissions</b>
              <span>{activeMode?.hint}</span>
            </span>
            <div className="segmented" role="group" aria-label="Permission mode">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.id}
                  aria-pressed={permissionMode === m.id}
                  data-danger={m.danger ? 'true' : undefined}
                  onClick={() => onChangeMode(m.id)}
                  title={m.hint}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="launcher-row">
            <span className="launcher-row-label">
              <b>Model</b>
              <span>Passed to the CLI as --model.</span>
            </span>
            <select
              className="select"
              value={model}
              onChange={(e) => onChangeModel(e.target.value)}
              aria-label="Model"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id || 'default'} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="launcher-row">
            <span className="launcher-row-label">
              <b>Effort</b>
              <span>How much reasoning Claude spends per turn.</span>
            </span>
            <select
              className="select"
              value={effort}
              onChange={(e) => onChangeEffort(e.target.value as EffortLevel)}
              aria-label="Effort level"
            >
              {EFFORT_LEVELS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Inline rather than a confirmation dialog: the warning stays visible
            for as long as the setting is armed, instead of once at launch. */}
        {bypass && (
          <div className="banner" style={{ borderRadius: 'var(--r-lg)', border: '1px solid var(--border)' }}>
            <span>
              <b>Permissions are bypassed.</b> Claude will run commands and edit files in this
              folder without asking. Use it only where you trust the contents.
            </span>
          </div>
        )}

        {cli && !cli.ok && (
          <div className="banner">
            <span>{cli.error}</span>
          </div>
        )}

        <div className="launcher-actions">
          <button
            ref={startRef}
            className="btn"
            data-variant="primary"
            onClick={onStart}
            disabled={!!cli && !cli.ok}
          >
            Start session
          </button>
          {sessions.length > 0 && (
            <button className="btn" onClick={onContinueLast} disabled={!!cli && !cli.ok}>
              Continue last
            </button>
          )}
          <span className="launcher-hint">
            <span className="kbd">Enter</span> to start
          </span>
        </div>

        {recent.length > 0 && (
          <div>
            <div className="sidebar-group" style={{ padding: '0 0 var(--sp-2)' }}>
              Resume a session
            </div>
            <div className="sessions" style={{ margin: 0, paddingLeft: 0, borderLeft: 'none' }}>
              {recent.map((s) => (
                <button key={s.id} className="session" onClick={() => onResume(s)}>
                  <span className="session-title">
                    {s.title ?? s.firstPrompt ?? 'Untitled session'}
                  </span>
                  <span className="session-meta">
                    <span>{relativeTime(s.modified)}</span>
                    <span>{s.messageCount} msgs</span>
                    {s.contextTokens > 0 && (
                      <ContextBar used={s.contextTokens} limit={s.contextLimit} />
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
