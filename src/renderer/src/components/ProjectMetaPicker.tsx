import { useEffect, useState } from 'react'
import type { Project, ProjectMeta } from '@shared/types'
import { IconFolder } from './Icons'

/**
 * An emoji and a display name for one folder.
 *
 * Neither touches the disk. Renaming the folder would break every transcript
 * path Claude has already written for it — the encoded history directory is the
 * absolute cwd with its punctuation replaced — so the name here is a label over
 * the top and the folder keeps whatever it is really called. The row's tooltip
 * still shows the real path, which is the one thing a label must not hide.
 *
 * A fixed palette rather than a text field: an arbitrary string would have to be
 * validated as an emoji somehow, and every rule for that is wrong for somebody's
 * script. Twenty-four is enough to tell a sidebar apart at a glance.
 */
const EMOJI = [
  '🔥', '🚀', '🧪', '🛠️', '📦', '🌱',
  '🐙', '🎯', '💡', '📓', '🧠', '🎨',
  '🕹️', '🛒', '💳', '📊', '🔒', '🌐',
  '⚙️', '🧩', '🍀', '🐳', '⚡', '🗂️'
]

export interface ProjectMetaPickerProps {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `null` clears the record entirely. */
  onCommit: (meta: ProjectMeta | null) => void
}

/** The record as it stands, so a change to one field cannot drop the others. */
function currentMeta(p: Project): ProjectMeta {
  const meta: ProjectMeta = {}
  if (p.emoji) meta.emoji = p.emoji
  if (p.label) meta.label = p.label
  if (p.addedManually) meta.addedManually = true
  return meta
}

/** An empty record means "no record", which is a delete rather than a write. */
function commitOrClear(meta: ProjectMeta): ProjectMeta | null {
  return Object.keys(meta).length ? meta : null
}

export function ProjectMetaPicker({
  project,
  open,
  onOpenChange,
  onCommit
}: ProjectMetaPickerProps): React.JSX.Element {
  const [label, setLabel] = useState(project.label ?? '')

  // The row re-renders whenever the project list refreshes; the field must
  // follow the stored value rather than keep a stale edit alive.
  useEffect(() => {
    setLabel(project.label ?? '')
  }, [project.label, open])

  const setEmoji = (emoji: string | null): void => {
    const meta = currentMeta(project)
    if (emoji) meta.emoji = emoji
    else delete meta.emoji
    onCommit(commitOrClear(meta))
  }

  const commitLabel = (): void => {
    const next = label.trim()
    if (next === (project.label ?? '')) return
    const meta = currentMeta(project)
    if (next) meta.label = next
    else delete meta.label
    onCommit(commitOrClear(meta))
  }

  return (
    <div
      className="project-meta-picker"
      /* Closing on focus leaving the whole popover, rather than on a document
         click: a native WebContentsView paints above renderer DOM, so a
         full-screen click-catching layer is not reliable here (gotcha 14). */
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onOpenChange(false)
      }}
    >
      <button
        className="icon-btn project-emoji"
        aria-expanded={open}
        aria-label={`Icon and name for ${project.name}`}
        title="Icon and display name"
        onClick={(e) => {
          e.stopPropagation()
          onOpenChange(!open)
        }}
        /* The row above is a role="button" that acts on Enter and Space, so
           without this every key that opens the picker also starts a session. */
        onKeyDown={(e) => e.stopPropagation()}
      >
        {project.emoji ? (
          <span className="project-emoji-glyph" aria-hidden="true">
            {project.emoji}
          </span>
        ) : (
          <IconFolder />
        )}
      </button>

      {open && (
        <div
          className="project-meta-pop"
          role="dialog"
          aria-label={`Icon and name for ${project.name}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            /* Every key, not just Escape: the row above acts on Enter and on
               Space, so a space typed into the name field would select the
               project and never reach the field. */
            e.stopPropagation()
            if (e.key === 'Escape') onOpenChange(false)
          }}
        >
          <div className="project-meta-grid">
            {EMOJI.map((glyph) => (
              <button
                key={glyph}
                className="project-emoji-option"
                aria-pressed={project.emoji === glyph}
                onClick={() => setEmoji(glyph)}
                title={glyph}
              >
                <span aria-hidden="true">{glyph}</span>
                <span className="sr-only">{glyph}</span>
              </button>
            ))}
          </div>

          <label className="sr-only" htmlFor={`label-${project.path}`}>
            Display name for {project.name}
          </label>
          <input
            id={`label-${project.path}`}
            className="input"
            value={label}
            placeholder={project.name}
            spellCheck={false}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitLabel()
                onOpenChange(false)
              }
            }}
          />
          <p className="project-meta-note">
            Shown in this list only. The folder on disk keeps its own name.
          </p>

          <div className="project-meta-actions">
            <button
              className="btn"
              data-variant="ghost"
              onClick={() => setEmoji(null)}
              disabled={!project.emoji}
            >
              No icon
            </button>
            {project.addedManually && (
              <button
                className="btn"
                data-variant="danger"
                onClick={() => {
                  onCommit(null)
                  onOpenChange(false)
                }}
                title="Stop listing this folder. Nothing on disk is deleted."
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
