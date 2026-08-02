import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { relativeTime } from '../lib/format'

interface Props {
  projects: Project[]
  onPick: (p: Project) => void
  onClose: () => void
}

/** Subsequence match, so "hrth" still finds "stoke". */
function score(project: Project, query: string): number {
  if (!query) return 1
  const name = project.name.toLowerCase()
  const path = project.path.toLowerCase()
  if (name.startsWith(query)) return 1000 - name.length
  if (name.includes(query)) return 500 - name.length
  if (path.includes(query)) return 250

  let i = 0
  for (const ch of name) {
    if (ch === query[i]) i++
    if (i === query.length) return 100
  }
  return 0
}

export function CommandPalette({ projects, onPick, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects
      .map((p) => ({ p, s: score(p, q) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.p)
  }, [projects, query])

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
              commit(results[index])
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && (
            <div className="empty" style={{ padding: 'var(--sp-6)' }}>
              <p>No project matches that.</p>
            </div>
          )}
          {results.map((p, i) => (
            <button
              key={p.path}
              className="palette-item"
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => commit(p)}
            >
              <span className="palette-item-name truncate">{p.name}</span>
              <span className="palette-item-path truncate">{p.path}</span>
              <span className="palette-item-path">{relativeTime(p.lastModified)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
