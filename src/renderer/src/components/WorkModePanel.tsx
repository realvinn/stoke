/**
 * Settings › Plugins › Work mode, while the plugin is enabled: what it reads,
 * Open, and the three choices (file types, characters per key, the build
 * panel). Its row is `plugins.work-mode` in SETTING_ROWS (gotcha 138): every
 * label drawn here is one of that row's keywords, which verify:settings-search
 * holds.
 */
import { useEffect, useRef, useState } from 'react'
import { WM_CHARS_MAX, WM_CHARS_MIN, WM_TYPES_SHOWN, languageOf, reasonText, type WorkModeScan } from '@shared/workMode'

export interface WorkModeEntry {
  /** The folder of the tab in front, chosen by App at render; null for none (the sample). */
  cwd: string | null
  onOpen: () => void
}

export function WorkModePanel({ cwd, onOpen }: WorkModeEntry): React.JSX.Element {
  const [scan, setScan] = useState<WorkModeScan | null>(null)
  const [error, setError] = useState('')
  const [chars, setChars] = useState('')
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    void window.stoke.workMode.scan(cwd).then(
      (s) => {
        if (!live.current) return
        setScan(s)
        setChars(String(s.options.charsPerKey))
      },
      (e) => live.current && setError(String(e))
    )
    return () => {
      live.current = false
    }
  }, [cwd])

  const types = scan?.types.slice(0, WM_TYPES_SHOWN) ?? []
  const project = scan?.project && scan.types.length ? scan.project : null
  const pick = (next: string[]): void => {
    if (!next.length) return
    void window.stoke.workMode.pick(cwd, next).then((s) => live.current && setScan(s), (e) => live.current && setError(String(e)))
  }
  const commitChars = (raw: string): void => {
    const n = Number(raw)
    if (!raw.trim() || !Number.isInteger(n) || n < WM_CHARS_MIN || n > WM_CHARS_MAX) return
    void window.stoke.workMode.options({ charsPerKey: n }).then(
      (o) => live.current && setScan((cur) => (cur ? { ...cur, options: o } : cur)),
      (e) => live.current && setError(String(e))
    )
  }

  return (
    <section className="plugin-panel wm-settings" data-setting="plugins.work-mode" aria-label="Work">
      <h3>Work</h3>
      <p>
        A simulated editor that types related files from the current project. Keys type code and the caret snaps to
        useful places as you move the mouse. It also types automatically between your keystrokes.
      </p>
      <p className="plugin-muted" data-testid="work-mode-privacy">
        Read-only: nothing is written, run or sent anywhere. It never opens .env files, keys, certificates, files named for
        a secret, a password or a credential, data and config files, or anything the project&rsquo;s git ignores, and it
        masks text shaped like a key. Everything else it shows is your project&rsquo;s real code, so open it only where
        you&rsquo;d be fine showing that code.
      </p>
      <div className="plugin-controls">
        <button type="button" className="btn" data-variant="primary" onClick={onOpen}>
          Open Work
        </button>
        <span className="plugin-muted">Leave with Esc, pressed twice.</span>
      </div>
      <p className="plugin-muted" data-testid="work-mode-source">
        Source:{' '}
        {project ? (
          <strong>
            {project.name}
            {project.branch ? ` (${project.branch})` : ''}
          </strong>
        ) : (
          `${reasonText(scan?.reason ?? 'no-folder')} the sample website.`
        )}
      </p>
      {project && (
        <>
          <span className="field-label">File types to type</span>
          <div className="wm-settings-types">
            {types.map((t) => {
              const on = scan?.picks.includes(t.ext) ?? false
              return (
                <label key={t.ext} className="check-row">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={on && scan?.picks.length === 1}
                    onChange={(e) => pick(e.target.checked ? [...(scan?.picks ?? []), t.ext] : (scan?.picks ?? []).filter((p) => p !== t.ext))}
                  />
                  <span>
                    {languageOf(t.ext)} (.{t.ext}) · {t.count} {t.count === 1 ? 'file' : 'files'}
                  </span>
                </label>
              )
            })}
          </div>
        </>
      )}
      <label className="wm-settings-chars">
        <span className="field-label">Characters per key</span>
        <input
          type="number"
          min={WM_CHARS_MIN}
          max={WM_CHARS_MAX}
          step={1}
          value={chars}
          onChange={(e) => {
            setChars(e.target.value)
            commitChars(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitChars(e.currentTarget.value)
          }}
          onBlur={() => setChars(String(scan?.options.charsPerKey ?? WM_CHARS_MIN))}
        />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={scan?.options.panel ?? true}
          onChange={(e) =>
            void window.stoke.workMode.options({ panel: e.target.checked }).then(
              (o) => live.current && setScan((cur) => (cur ? { ...cur, options: o } : cur)),
              (err) => live.current && setError(String(err))
            )
          }
        />
        <span>Show build output now and then</span>
      </label>
      {error && (
        <p role="alert" className="plugin-error">
          {error}
        </p>
      )}
    </section>
  )
}
