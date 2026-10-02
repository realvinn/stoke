import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import type { CodingCliId } from '@shared/codingClis'
import { searchSettings, settingsEntries, type SettingsHit } from '@shared/settingsIndex'
import { relativeTime } from '../lib/format'
import { rankForPalette } from '../lib/projectSearch'
import { paletteRows, SETTINGS_IN_PALETTE, type PaletteRow } from '../lib/paletteRows'
import { FIND_PALETTE_LABEL, paletteFindMatch } from '../lib/terminalFind'
import { chordLabel } from '../lib/shortcuts'
import { Highlight } from './Highlight'
import { IconGear, IconSearch } from './Icons'

interface Props {
  projects: Project[]
  /** The agents with a page in Settings (`navAgents`), so a hit on one lands on its page. */
  settingsAgents: readonly CodingCliId[]
  onPick: (p: Project) => void
  /** Open Settings at a page, and at the row when the hit is one. */
  onPickSetting: (hit: SettingsHit) => void
  /**
   * Open the find bar of the terminal in front. Absent when there is none, and
   * then "find" lists no such row.
   */
  onFind?: () => void
  onClose: () => void
}

/** The palette's one action row, first when the query asks for it. */
type Row = PaletteRow | { kind: 'find'; ranges: [number, number][] }

const IS_MAC = window.stoke.platform === 'darwin'

/*
 * Matching and ranking live in `projectSearch.ts`, shared with the sidebar. The
 * palette carried its own `score()` that read the name and the path and never
 * the label, so a folder renamed "Client site" could be found by that name in
 * the sidebar and not here — and was listed here under the basename it had
 * been renamed away from. It keeps its one extra, the subsequence match that
 * lets "hrth" find "stoke", as the lowest tier.
 *
 * It finds settings too, from the same index the Settings sheet's own search
 * reads (shared/settingsIndex.ts): "font" lists Terminal › Font and Font size,
 * and picking one opens Settings at that row. The two lists interleave by how
 * good a match each row is (`paletteRows`), so a folder whose name starts with
 * the query stays above a setting that only mentions it, and a setting whose
 * name starts with it stays above a folder that only matched letter by letter.
 */
export function CommandPalette({ projects, settingsAgents, onPick, onPickSetting, onFind, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const agentsKey = settingsAgents.join(',')
  const entries = useMemo(() => settingsEntries({ agents: settingsAgents, platform: window.stoke.platform }), [agentsKey])
  const hasFind = !!onFind
  const rows = useMemo((): Row[] => {
    const listed = paletteRows(rankForPalette(projects, query), searchSettings(entries, query).slice(0, SETTINGS_IN_PALETTE))
    const find = hasFind ? paletteFindMatch(query) : null
    return find ? [{ kind: 'find', ranges: find }, ...listed] : listed
  }, [projects, entries, query, hasFind])

  useEffect(() => {
    setIndex(0)
  }, [query])

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    const el = listRef.current?.children[index] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const commit = (i: number): void => {
    const row = rows[i]
    if (!row) return
    if (row.kind === 'find') onFind?.()
    else if (row.kind === 'project') onPick(row.hit.project)
    else onPickSetting(row.hit)
  }

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Find a project or setting">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Find a project or setting…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(rows.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit(index)
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="empty" style={{ padding: 'var(--space-24)' }}>
              <p>No project or setting matches that.</p>
            </div>
          )}
          {rows.map((row, i) =>
            row.kind === 'find' ? (
              <button
                key="find"
                className="palette-item"
                data-kind="action"
                data-active={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => commit(i)}
              >
                <span className="palette-item-name truncate">
                  <Highlight text={FIND_PALETTE_LABEL} ranges={row.ranges} />
                </span>
                <span className="palette-item-path truncate">
                  The screen and the transcript · {chordLabel('find', IS_MAC)}
                </span>
                <span className="palette-item-time palette-item-kind" aria-hidden="true">
                  <IconSearch />
                </span>
              </button>
            ) : row.kind === 'project' ? (
              <button
                key={`p:${row.hit.project.path}`}
                className="palette-item"
                data-active={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => commit(i)}
              >
                {/* The label, when the folder has one — what every other list
                    shows, and what the user renamed this project to. */}
                <span className="palette-item-name truncate">
                  <Highlight text={row.hit.project.label ?? row.hit.project.name} ranges={row.hit.nameRanges} />
                </span>
                {/* The path lights up only when the name cannot — a hit in a
                    parent folder, or a basename hidden behind a label. Both at
                    once is the same word marked twice. */}
                <span className="palette-item-path truncate">
                  <Highlight
                    text={row.hit.project.path}
                    ranges={row.hit.nameRanges.length ? [] : row.hit.pathRanges}
                  />
                </span>
                <span className="palette-item-time">{relativeTime(row.hit.project.lastModified)}</span>
              </button>
            ) : (
              <button
                key={`s:${row.hit.entry.key}`}
                className="palette-item"
                data-kind="setting"
                data-active={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => commit(i)}
              >
                <span className="palette-item-name truncate">
                  <Highlight text={row.hit.entry.label} ranges={row.hit.ranges} />
                </span>
                {/* Where it is: "Settings › Terminal", the menu path above the row. */}
                <span className="palette-item-path truncate">
                  {['Settings', ...row.hit.entry.path].join(' › ')}
                </span>
                <span className="palette-item-time palette-item-kind" aria-hidden="true">
                  <IconGear />
                </span>
              </button>
            )
          )}
        </div>
      </div>
    </>
  )
}
