/**
 * Work mode's presentational chrome: the title strip, the activity bar, the
 * status bar, the bottom panel and the hint. Colours are custom properties
 * only (styles/workMode.css); the title strip mirrors the shell title bar's
 * three platform clearances (gotcha 23: the traffic lights are device px).
 */
import { useEffect, useRef } from 'react'
import { IconBell, IconBranch, IconCode, IconFolder, IconGear, IconSearch, IconTerminal } from './Icons'

const FAKE_MENUS = ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help']

export function TitleStrip({
  platform,
  fullScreen,
  title,
  project,
  onMenu
}: {
  platform: string
  fullScreen: boolean
  title: string
  project: string
  onMenu: (x: number, y: number) => void
}): React.JSX.Element {
  return (
    <header className="wm-title" data-platform={platform} data-fullscreen={fullScreen || undefined}>
      <div className="wm-menus">
        {platform !== 'darwin' &&
          FAKE_MENUS.map((m) => (
            <button
              key={m}
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                onMenu(r.left, r.bottom + 4)
              }}
            >
              {m}
            </button>
          ))}
      </div>
      <div className="wm-command" aria-hidden="true">
        <IconSearch />
        <span>{project}</span>
      </div>
      <div className="wm-title-right">{title}</div>
    </header>
  )
}

export function ActivityBar({ changed, onMenu }: { changed: number; onMenu: (x: number, y: number) => void }): React.JSX.Element {
  return (
    <nav className="wm-activity" aria-label="Views">
      <span className="wm-act" data-active="" aria-hidden="true">
        <IconFolder />
      </span>
      <span className="wm-act" aria-hidden="true">
        <IconSearch />
      </span>
      <span className="wm-act" aria-hidden="true">
        <IconBranch />
        {changed > 0 && <span className="wm-act-badge">{changed}</span>}
      </span>
      <span className="wm-act" aria-hidden="true">
        <IconTerminal />
      </span>
      <span className="wm-act" aria-hidden="true">
        <IconCode />
      </span>
      <span className="wm-act-gap" />
      <button
        type="button"
        className="wm-act"
        aria-label="Work settings"
        tabIndex={-1}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(r.right + 6, Math.max(8, r.bottom - 280))
        }}
      >
        <IconGear />
      </button>
    </nav>
  )
}

export interface StatusInfo {
  branch: string
  line: number
  col: number
  indent: string
  eol: 'LF' | 'CRLF'
  language: string
}

export function StatusBar({ info }: { info: StatusInfo | null }): React.JSX.Element {
  return (
    <footer className="wm-status">
      <span className="wm-status-item">
        <IconBranch />
        {info?.branch ?? 'main'}
      </span>
      <span className="wm-status-item">⊗ 0 ⚠ 0</span>
      <span className="wm-status-gap" />
      {info && (
        <>
          <span className="wm-status-item">
            Ln {info.line}, Col {info.col}
          </span>
          <span className="wm-status-item">{info.indent}</span>
          <span className="wm-status-item">UTF-8</span>
          <span className="wm-status-item">{info.eol}</span>
          <span className="wm-status-item">{info.language}</span>
        </>
      )}
      <span className="wm-status-item wm-status-bell" aria-hidden="true">
        <IconBell />
      </span>
    </footer>
  )
}

export interface PanelLine {
  id: number
  text: string
  /** How a terminal colours it: a prompt, plain output, a pass, a quiet detail, a run's header. */
  kind: 'prompt' | 'out' | 'ok' | 'dim' | 'info'
}

/** One terminal of the panel and its lines. */
export interface PanelTerm {
  key: string
  lines: readonly PanelLine[]
}

/** One terminal's body, stuck to its newest line. Lines wrap at its width as a terminal's do: it never scrolls sideways. */
function TerminalBody({ lines }: { lines: readonly PanelLine[] }): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = body.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <div className="wm-panel-body" ref={body}>
      {lines.map((l) => (
        <div key={l.id} className="wm-panel-line" data-kind={l.kind}>
          {l.text || ' '}
        </div>
      ))}
    </div>
  )
}

/** The bottom panel's terminal: one, or split in two when the dev server and the tests are two commands (`hasTestTerminal`). */
export function BottomPanel({ terms }: { terms: readonly PanelTerm[] }): React.JSX.Element {
  return (
    <section className="wm-panel" aria-label="Panel">
      <div className="wm-panel-tabs">
        <span>Problems</span>
        <span>Output</span>
        <span>Debug Console</span>
        <span data-active="">Terminal</span>
        <span>Ports</span>
      </div>
      <div className="wm-panel-terms" data-split={terms.length > 1 || undefined}>
        {terms.map((t) => (
          <TerminalBody key={t.key} lines={t.lines} />
        ))}
      </div>
    </section>
  )
}

export function Hint({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="wm-hint" role="status">
      {text}
    </div>
  )
}
