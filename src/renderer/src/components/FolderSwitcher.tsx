import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  choiceKey,
  flatChoices,
  folderChoices,
  type FolderChoice,
  type HostLike,
  type ProjectLike
} from '@shared/launcher'
import { IconChevron, IconFolder, IconPlus } from './Icons'
import { relativeTime } from '../lib/format'

/*
 * Where the next session runs: the launcher's title, as a button that opens a
 * filterable list of every place a session can start.
 *
 * It replaces three things the launcher used to have (QA L6, L8, L19): a
 * separate "Start a session" page with Start here / Scratch / Open a folder /
 * six recent projects, which could never be reached again once any project had
 * been clicked; the Remote row, which sat on every project page although an SSH
 * session ignores the folder; and the only visible way to name the default
 * folder. All of them are one pick away from any New tab now.
 *
 * A combobox in the ARIA sense: focus stays in the filter input and the arrow
 * keys move `aria-activedescendant`, so typing and choosing never fight over
 * focus. Every key it handles stops at the popover, so the launcher card's own
 * keys (a letter types into the conversation filter, a digit resumes) never
 * see them.
 */
export function FolderSwitcher({
  label,
  hint,
  path,
  loading,
  projects,
  defaultCwd,
  hosts,
  open,
  onOpenChange,
  onChoose,
  triggerRef
}: {
  /** The target's name; empty while nothing has resolved yet. */
  label: string
  /** The disambiguating parent folder, when another project shares the name. */
  hint: string
  path: string
  loading: boolean
  /** Already scoped to the active profile (QA L18). */
  projects: readonly ProjectLike[]
  defaultCwd: string
  hosts: readonly HostLike[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (choice: FolderChoice) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(
    () => folderChoices({ projects, defaultCwd, hosts, query }),
    [projects, defaultCwd, hosts, query]
  )
  const flat = useMemo(() => flatChoices(groups), [groups])

  // A fresh list every time it opens: last time's filter is not this time's question.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1))
  }, [flat.length, active])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const close = (refocus: boolean): void => {
    onOpenChange(false)
    if (refocus) triggerRef.current?.focus()
  }

  const choose = (c: FolderChoice | undefined): void => {
    if (!c) return
    onOpenChange(false)
    onChoose(c)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // The card's keys must not see a key meant for this list.
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(flat.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!e.repeat) choose(flat[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (query) setQuery('')
      else close(true)
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  let index = -1
  return (
    <div className="switcher">
      <button
        ref={triggerRef}
        className="switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        title={`${path}\nChange where this session runs ( / )`}
      >
        <span className="switcher-title">
          {loading ? <span className="skeleton skeleton-title" /> : label}
        </span>
        {hint && <span className="switcher-hint">{hint}</span>}
        <IconChevron className="switcher-caret" />
      </button>

      {open && (
        <>
          <div className="popover-backdrop" onClick={() => close(false)} />
          <div className="popover switcher-pop" onKeyDown={onKeyDown}>
            <input
              ref={inputRef}
              className="input"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
              aria-label="Filter folders"
              placeholder="Projects, folders, machines…"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
            />
            <div className="switcher-list" role="listbox" id={listId} ref={listRef}>
              {groups.map((g) => (
                <div key={g.title || 'actions'} role="group" aria-label={g.title || 'Actions'}>
                  {g.title && <div className="switcher-group">{g.title}</div>}
                  {g.items.map((c) => {
                    index += 1
                    const i = index
                    return (
                      <div
                        key={choiceKey(c)}
                        id={`${listId}-${i}`}
                        data-index={i}
                        role="option"
                        aria-selected={i === active}
                        className="switcher-item"
                        data-kind={c.kind}
                        onMouseMove={() => setActive(i)}
                        onClick={() => choose(c)}
                      >
                        <ChoiceBody choice={c} />
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ChoiceBody({ choice: c }: { choice: FolderChoice }): React.JSX.Element {
  switch (c.kind) {
    case 'project':
      return (
        <>
          <span className="switcher-item-main">
            <span className="truncate">{c.label}</span>
            {c.hint && <span className="switcher-hint">{c.hint}</span>}
            {c.missing && <span className="project-missing">missing</span>}
          </span>
          <span className="switcher-item-side">
            {c.lastModified ? relativeTime(c.lastModified) : ''}
          </span>
        </>
      )
    case 'default':
      return (
        <>
          <span className="switcher-item-main">
            <span>{c.label}</span>
            <span className="switcher-hint mono truncate">{c.path}</span>
          </span>
        </>
      )
    case 'scratch':
      return (
        <>
          <span className="switcher-item-main">
            <IconPlus />
            <span>{c.label}</span>
          </span>
          <span className="switcher-item-side">new dated folder, starts now</span>
        </>
      )
    case 'host':
      return (
        <>
          <span className="switcher-item-main">
            <span className="truncate">{c.label}</span>
            <span className="switcher-hint mono">ssh {c.alias}</span>
          </span>
          <span className="switcher-item-side">connects now</span>
        </>
      )
    case 'open':
      return (
        <>
          <span className="switcher-item-main">
            <IconFolder />
            <span>{c.label}</span>
          </span>
          <span className="switcher-item-side">
            <span className="kbd">{window.stoke.platform === 'darwin' ? '⌘O' : 'Ctrl+O'}</span>
          </span>
        </>
      )
  }
}
