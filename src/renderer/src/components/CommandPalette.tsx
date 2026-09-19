import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { relativeTime } from '../lib/format'
import { rankForPalette } from '../lib/projectSearch'
import { Highlight } from './Highlight'

interface Props {
  projects: Project[]
  onPick: (p: Project) => void
  onClose: () => void
}

/*
 * Matching and ranking live in `projectSearch.ts`, shared with the sidebar. The
 * palette carried its own `score()` that read the name and the path and never
 * the label, so a folder renamed "Client site" could be found by that name in
 * the sidebar and not here — and was listed here under the basename it had
 * been renamed away from. It keeps its one extra, the subsequence match that
 * lets "hrth" find "stoke", as the lowest tier.
 */
export function CommandPalette({ projects, onPick, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => rankForPalette(projects, query), [projects, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    const el = listRef.current?.children[index] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const commit = (p: Project | undefined): void => {
    if (p) onPick(p)
  }

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Find a project">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Find a project…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit(results[index]?.project)
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && (
            <div className="empty" style={{ padding: 'var(--space-24)' }}>
              <p>No project matches that.</p>
            </div>
          )}
          {results.map(({ project: p, nameRanges, pathRanges }, i) => (
            <button
              key={p.path}
              className="palette-item"
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => commit(p)}
            >
              {/* The label, when the folder has one — what every other list
                  shows, and what the user renamed this project to. */}
              <span className="palette-item-name truncate">
                <Highlight text={p.label ?? p.name} ranges={nameRanges} />
              </span>
              {/* The path lights up only when the name cannot — a hit in a
                  parent folder, or a basename hidden behind a label. Both at
                  once is the same word marked twice. */}
              <span className="palette-item-path truncate">
                <Highlight text={p.path} ranges={nameRanges.length ? [] : pathRanges} />
              </span>
              <span className="palette-item-time">{relativeTime(p.lastModified)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
