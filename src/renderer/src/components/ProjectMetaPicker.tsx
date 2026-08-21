import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  /** Hide a folder that has no record to clear — see the dismiss button. */
  onHide: () => void
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
  onCommit,
  onHide
}: ProjectMetaPickerProps): React.JSX.Element {
  const [label, setLabel] = useState(project.label ?? '')

  // The row re-renders whenever the project list refreshes; the field must
  // follow the stored value rather than keep a stale edit alive.
  useEffect(() => {
    setLabel(project.label ?? '')
  }, [project.label, open])

  const triggerRef = useRef<HTMLButtonElement>(null)
  // Set for the one synchronous tick where returnFocusToTrigger() moves focus
  // itself, so the label input's own onBlur doesn't read that programmatic
  // move as the user leaving the field and commit an edit Escape meant to discard.
  const suppressNextCommit = useRef(false)

  const popRef = useRef<HTMLDivElement>(null)
  // Opens below the row by default. `.sidebar-scroll` clips anything past its
  // own box, so on a long list a row near the bottom pushed the popover's
  // label field and both action buttons past the visible area, unreachable.
  // Measured against the *scroll container's* box, not the window's — the
  // trigger can be fully visible while the room around it is still tight.
  // A layout effect so the flip lands before the browser paints — no visible
  // jump from one side to the other. Unrelated to the focus-return below:
  // this only ever runs when `open` turns true, never on the close paths
  // that ordering protects.
  const [side, setSide] = useState<'below' | 'above'>('below')
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const pop = popRef.current
    if (!trigger || !pop) return
    // `.project-meta-pop` is positioned against the *row* (`top: calc(100% +
    // var(--space-4))` on `.project` in app.css), not against this trigger
    // button. Measuring from the trigger understated how much room the
    // popover actually needs by the row's padding below the trigger plus the
    // gap — a constant that let the popover stay "below" while it was
    // already clipping the container's bottom edge.
    const row = (trigger.closest('.project') as HTMLElement | null) ?? trigger

    const measure = (): void => {
      const scrollEl = trigger.closest('.sidebar-scroll')
      if (!scrollEl) {
        // No scroll-clipping ancestor found. This component is only ever
        // mounted inside `.sidebar-scroll` today, so this is purely
        // defensive: the viewport is neither the real clipping ancestor nor
        // a safe stand-in for one, so guessing against it can decide "flip"
        // against a box the popover was never actually constrained by. Stay
        // at the pre-flip default instead — the position every popover had
        // before this effect existed, and never wrong, only occasionally
        // not flipped when it could have been.
        setSide('below')
        return
      }
      const bounds = scrollEl.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const popRect = pop.getBoundingClientRect()
      // The gap is the same length token (`--space-4`) on both the "below"
      // and "above" CSS rules, so recover its current rendered value from
      // whichever side the popover is actually on right now instead of
      // duplicating the token here — a duplicate would drift the moment
      // `--ui-scale` changes the rem base the token resolves against.
      // Geometry decides which side is current, not the `side` state: this
      // function is also called from the scroll listener below, where a
      // stale closure over `side` would use the wrong side's formula for a
      // stretch of scroll events after every flip.
      const gapBelow = popRect.top - rowRect.bottom
      const gapAbove = rowRect.top - popRect.bottom
      const gap = gapBelow >= 0 ? gapBelow : gapAbove
      const needed = popRect.height
      const spaceBelow = bounds.bottom - (rowRect.bottom + gap)
      const spaceAbove = rowRect.top - gap - bounds.top
      setSide(spaceBelow < needed && spaceAbove > spaceBelow ? 'above' : 'below')
    }

    measure()

    // Wheel-scrolling `.sidebar-scroll` doesn't move focus, so the root
    // `onBlur` that closes the popover never fires: it can stay open while
    // the row it's anchored to scrolls anywhere in the list. Re-measure on
    // scroll so a flip decided at one offset doesn't survive stale into an
    // offset where it clips the opposite edge instead. Listener lives only
    // while the popover is open — attached here, removed by this same
    // effect's cleanup on close and on unmount, never left on the scroll
    // container past that (this component is instantiated once per project
    // row, so a leaked listener here is a leak per row, not just one).
    const scrollEl = trigger.closest('.sidebar-scroll')
    scrollEl?.addEventListener('scroll', measure, { passive: true })
    return () => scrollEl?.removeEventListener('scroll', measure)
  }, [open])

  const setEmoji = (emoji: string | null): void => {
    const meta = currentMeta(project)
    if (emoji) meta.emoji = emoji
    else delete meta.emoji
    onCommit(commitOrClear(meta))
  }

  const commitLabel = (): void => {
    if (suppressNextCommit.current) {
      suppressNextCommit.current = false
      return
    }
    const next = label.trim()
    if (next === (project.label ?? '')) return
    const meta = currentMeta(project)
    if (next) meta.label = next
    else delete meta.label
    onCommit(commitOrClear(meta))
  }

  /** Returns focus to the trigger before the popover subtree unmounts, for
      every close path that isn't the user clicking away to something else.
      Doing it here — synchronously, before the state update that unmounts
      the popover — is what makes it reliable: a `useEffect` keyed on `open`
      runs after that unmount, by which point the focused node is already
      gone and focus has already dropped to <body>. */
  const returnFocusToTrigger = (): void => {
    suppressNextCommit.current = true
    triggerRef.current?.focus()
    suppressNextCommit.current = false
  }

  return (
    <div
      className="project-meta-picker"
      /* Closing on focus leaving the whole popover, rather than on a document
         click: a native WebContentsView paints above renderer DOM, so a
         full-screen click-catching layer is not reliable here (gotcha 14).
         Focus isn't returned to the trigger here: relatedTarget is whatever
         the user clicked instead, and that's where their focus should stay. */
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onOpenChange(false)
      }}
    >
      <button
        ref={triggerRef}
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
          ref={popRef}
          className={`project-meta-pop${side === 'above' ? ' project-meta-pop--above' : ''}`}
          role="dialog"
          aria-label={`Icon and name for ${project.name}`}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            /* Every key, not just Escape: the row above acts on Enter and on
               Space, so a space typed into the name field would select the
               project and never reach the field. */
            e.stopPropagation()
            if (e.key === 'Escape') {
              returnFocusToTrigger()
              onOpenChange(false)
            }
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
                returnFocusToTrigger()
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
            {/*
              Every folder can be dismissed, by one of two routes.

              A folder the user added by hand is removed by dropping its record,
              which is what put it in the list at all. Everything else was
              discovered from Claude Code's own history, so there is no record to
              drop — it is hidden instead, which is what `hiddenProjects` is for
              and is reversible from Settings.

              Only the first of those existed, gated on `addedManually`. On the
              machine this was found on that left fifteen `missing` rows —
              folders since deleted, renamed, or on a drive that is not plugged
              in — with no way to dismiss them by any gesture the UI offered,
              and `projects.hide` sitting fully built with no caller.
            */}
            <button
              className="btn"
              data-variant="danger"
              onClick={() => {
                if (project.addedManually) onCommit(null)
                else onHide()
                returnFocusToTrigger()
                onOpenChange(false)
              }}
              title={
                project.addedManually
                  ? 'Stop listing this folder. Nothing on disk is deleted.'
                  : 'Hide this folder from the sidebar. Nothing on disk is deleted, and Settings can bring it back.'
              }
            >
              {project.addedManually ? 'Remove' : 'Hide'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
