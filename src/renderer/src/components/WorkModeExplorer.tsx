/**
 * Work mode's explorer: the project's tree as main listed it (code, markup, Markdown and
 * a few well-known names only, never anything secret-named). Folders are
 * closed except the ones holding an open file; a loaded file opens in the
 * active editor, any other file is only selected.
 */
import { useMemo, useState } from 'react'
import { explorerNodes, extOf, type ExplorerNode } from '@shared/workMode'
import { IconChevron } from './Icons'

/** A press on a row must not take focus: a key typed after it would match `:focus-visible` there (see WorkModeEditor's `keepFocus`). */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

interface Props {
  project: string
  tree: readonly string[]
  /** Loaded file paths and their index in the session. */
  loaded: ReadonlyMap<string, number>
  touched: ReadonlySet<string>
  open: readonly string[]
  activePath: string | null
  onOpen: (file: number) => void
}

export function WorkModeExplorer({ project, tree, loaded, touched, open, activePath, onOpen }: Props): React.JSX.Element {
  const nodes = useMemo(() => explorerNodes(tree), [tree])
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const onPath = useMemo(() => {
    const dirs = new Set<string>()
    for (const p of open) {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    return dirs
  }, [open])
  const isOpen = (path: string): boolean => (onPath.has(path) && !closed.has(path)) || opened.has(path)
  const toggle = (path: string): void => {
    const now = isOpen(path)
    setOpened((cur) => {
      const next = new Set(cur)
      if (now) next.delete(path)
      else next.add(path)
      return next
    })
    setClosed((cur) => {
      const next = new Set(cur)
      if (now) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const draw = (list: readonly ExplorerNode[], depth: number): React.JSX.Element[] =>
    list.flatMap((n) => {
      const style = { ['--wm-depth' as string]: depth } as React.CSSProperties
      if (n.dir) {
        const shown = isOpen(n.path)
        return [
          <button key={n.path + '/'} type="button" className="wm-node" style={style} data-open={shown || undefined} onMouseDown={keepFocus} onClick={() => toggle(n.path)} tabIndex={-1}>
            <IconChevron className="wm-node-chevron" />
            <span className="wm-node-name">{n.name}</span>
          </button>,
          ...(shown ? draw(n.children, depth + 1) : [])
        ]
      }
      const index = loaded.get(n.path)
      // The active editor's file; a file that is only shown (never loaded) is highlighted while it is the one clicked.
      const active = activePath === n.path || (selected === n.path && index === undefined)
      return [
        <button
          key={n.path}
          type="button"
          className="wm-node"
          style={style}
          data-active={active || undefined}
          onMouseDown={keepFocus}
          onClick={() => {
            setSelected(n.path)
            if (index !== undefined) onOpen(index)
          }}
          tabIndex={-1}
        >
          <span className="wm-node-chevron" aria-hidden="true" />
          <span className="wm-glyph" data-ext={extOf(n.path)} aria-hidden="true" />
          <span className="wm-node-name">{n.name}</span>
          {touched.has(n.path) && <span className="wm-node-badge">M</span>}
        </button>
      ]
    })

  return (
    <aside className="wm-explorer" aria-label="Explorer">
      <div className="wm-explorer-head">Explorer</div>
      <div className="wm-explorer-project">
        <IconChevron className="wm-node-chevron" style={{ rotate: '90deg' }} />
        <span className="wm-node-name">{project}</span>
      </div>
      <div className="wm-tree">{draw(nodes, 1)}</div>
    </aside>
  )
}
