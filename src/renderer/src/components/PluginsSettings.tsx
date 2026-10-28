import { useEffect, useRef, useState } from 'react'
import { PLUGIN_MARKETPLACE, PLUGIN_CATALOG } from '@shared/pluginPackages'
import { usePlugins } from '../lib/usePlugins'
import { GrokBotPanel } from './GrokBotPanel'
import { WorkPanel } from './WorkPanel'
import { WorkModePanel, type WorkModeEntry } from './WorkModePanel'
import '../styles/plugins.css'
export function PluginsSettings({
  defaultProject,
  initialPlugin = '',
  workMode
}: {
  defaultProject: string
  initialPlugin?: string
  /** Work mode's folder and its Open, from App (the tab in front, chosen there). */
  workMode?: WorkModeEntry
}): React.JSX.Element {
  const { view, error: loadError } = usePlugins()
  const [selected, setSelected] = useState(initialPlugin)
  useEffect(() => { setSelected(initialPlugin) }, [initialPlugin])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [output, setOutput] = useState('')
  const [project, setProject] = useState(defaultProject),
    [id, setId] = useState(''),
    [name, setName] = useState('')
  const holder = useRef<HTMLElement>(null)
  useEffect(() => {
    holder.current?.scrollIntoView({ block: 'start' })
  }, [selected])
  const live = useRef(true),
    claimed = useRef(false)
  useEffect(() => {
    live.current = true
    const off = window.stoke.plugins.onOpen((id) => {
      if (live.current) setSelected(id)
    })
    window.stoke.plugins
      .pending(true)
      .then((id) => {
        if (live.current && id && !initialPlugin) setSelected(id)
      })
      .catch(() => {})
    return () => {
      live.current = false
      off()
    }
  }, [])
  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    if (claimed.current) return
    claimed.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (error) {
      if (live.current) setError(String(error))
    } finally {
      claimed.current = false
      if (live.current) setBusy(false)
    }
  }
  const entry = view?.entries.find((entry) => entry.manifest.id === selected)
  return (
    <section ref={holder} className="plugins-settings" data-setting="plugins.manager">
      {!entry && (
        <>
          <p className="plugin-muted">
            Add native panels and appearance mods. Installed plugins start disabled.{' '}
            <button className="plugin-link" onClick={() => window.stoke.openExternal(PLUGIN_MARKETPLACE)}>
              Browse marketplace ↗
            </button>
          </p>
          <div className="plugin-controls">
            <button disabled={busy} onClick={() => void act(() => window.stoke.plugins.import())}>
              Import package…
            </button>
            <button
              className="plugin-link"
              onClick={() => window.stoke.openExternal(`${PLUGIN_MARKETPLACE}/sdk`)}
            >
              Developer guide ↗
            </button>
          </div>
          <div className="plugin-directory">
            {view?.entries.map((item) => (
              <div className="plugin-row" key={item.manifest.id}>
                <div className="plugin-description">
                  <strong>
                    {item.manifest.name} <small>{item.manifest.version}</small>
                  </strong>
                  <p>{item.manifest.description}</p>
                  <span>
                    {item.installed ? (item.enabled ? 'Enabled' : 'Disabled') : 'Available'} ·{' '}
                    {item.manifest.author}
                  </span>
                </div>
                <div className="plugin-controls">
                  {item.installed ? (
                    <>
                      <label className="plugin-toggle">
                        <input
                          type="checkbox"
                          checked={item.enabled}
                          disabled={busy}
                          onChange={(event) =>
                            void act(() =>
                              window.stoke.plugins.toggle(item.manifest.id, event.target.checked)
                            )
                          }
                        />
                        Enable
                      </label>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setSelected(item.manifest.id)
                          setOutput('')
                        }}
                      >
                        Details
                      </button>
                      {item.manifest.id === 'work-mode' && item.enabled && workMode && (
                        <button disabled={busy} onClick={workMode.onOpen}>
                          Open
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setSelected(item.manifest.id)
                        setOutput('')
                      }}
                    >
                      Review
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {entry && (
        <section className="plugin-detail" aria-label={`${entry.manifest.name} details`}>
          <div className="plugin-controls plugin-detail-toolbar">
            <button
              data-testid="plugin-back"
              onClick={() => {
                setSelected('')
                setOutput('')
              }}
            >
              ← All plugins
            </button>
            {entry.installed && (
              <label className="plugin-toggle">
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  disabled={busy}
                  onChange={(event) =>
                    void act(() => window.stoke.plugins.toggle(entry.manifest.id, event.target.checked))
                  }
                />
                Enabled
              </label>
            )}
            {entry.enabled && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void act(() => window.stoke.plugins.export(entry.manifest.id))}
                >
                  Export…
                </button>
                {entry.manifest.id !== 'work' && (
                  <button
                    disabled={busy}
                    onClick={() => void act(() => window.stoke.plugins.remove(entry.manifest.id))}
                  >
                    Remove
                  </button>
                )}
              </>
            )}
          </div>
          {(!entry.enabled || !entry.builtin) && (
            <>
              <h3>{entry.manifest.name}</h3>
              <p>{entry.manifest.description}</p>
              <p className="plugin-muted">
                {entry.manifest.id === 'grok-bot'
                  ? 'Runs the pinned unofficial CLI and uses only the account session you select. Imported credentials stay encrypted on this device.'
                  : entry.manifest.id === 'work-mode'
                    ? 'Shows real code from the project in front, read-only: nothing is written, run or sent. It never opens secret-named, ignored, data or config files, and it masks text shaped like a key, so use it where you would be fine showing that code. With no project, it types a bundled sample website.'
                  : entry.manifest.id === 'work'
                    ? 'Local tasks and plans, with optional Notion and draft connections you configure.'
                    : entry.manifest.permissions.includes('local-code')
                      ? 'Runs local Node.js code with your user permissions. Review the author and source before enabling it. Declared permissions describe intent; they are not an OS sandbox.'
                      : 'Applies only supported appearance values.'}
              </p>
              {entry.manifest.permissions.includes('project-context') && (
                <p className="plugin-muted">Receives the project folder you choose when running an action.</p>
              )}
            </>
          )}
          {!entry.enabled && (
            <>
              <div className="plugin-controls">
                {!entry.installed && (
                  <button
                    disabled={busy}
                    onClick={() => void act(() => window.stoke.plugins.install(entry.manifest.id))}
                  >
                    Install disabled
                  </button>
                )}
                {entry.installed && (
                  <button
                    disabled={busy}
                    onClick={() => void act(() => window.stoke.plugins.export(entry.manifest.id))}
                  >
                    Export package…
                  </button>
                )}
                {entry.installed && entry.manifest.id !== 'work' && (
                  <button
                    disabled={busy}
                    onClick={() => void act(() => window.stoke.plugins.remove(entry.manifest.id))}
                  >
                    Remove plugin
                  </button>
                )}
              </div>
              <p className="plugin-muted">
                Disabling hides the plugin panel and stops its running commands. Removing preserves saved
                plugin data so you can reinstall.
              </p>
            </>
          )}
          {entry.enabled && entry.manifest.id === 'grok-bot' && <GrokBotPanel />}
          {entry.enabled && entry.manifest.id === 'work' && <WorkPanel />}
          {entry.enabled && entry.manifest.id === 'work-mode' && (
            <WorkModePanel cwd={workMode?.cwd ?? null} onOpen={workMode?.onOpen ?? (() => {})} />
          )}
          {entry.enabled && !entry.builtin && (
            <section className="plugin-panel">
              <h3>{entry.manifest.panel.title}</h3>
              <p>{entry.manifest.panel.text}</p>
              {entry.manifest.permissions.includes('project-context') && (
                <label>
                  Local project folder
                  <input value={project} onChange={(event) => setProject(event.target.value)} />
                </label>
              )}
              <div className="plugin-controls">
                {entry.manifest.panel.actions.map((action) => (
                  <button
                    key={action.id}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await window.stoke.plugins.run(
                          entry.manifest.id,
                          action.id,
                          project || null
                        )
                        if (live.current) {
                          setOutput(result.output)
                          if (!result.ok) setError(result.message ?? 'The action failed.')
                        }
                      })
                    }
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              {output && (
                <pre className="plugin-output" tabIndex={0}>
                  {output}
                </pre>
              )}
            </section>
          )}
        </section>
      )}
      {!entry && (
        <>
          <details className="plugin-create">
            <summary>Create a plugin</summary>
            <p>
              Start from the Project summary example. Choose a source folder, edit the package, then import
              your changes.
            </p>
            <div className="plugin-controls">
              <label>
                Plugin ID
                <input value={id} onChange={(event) => setId(event.target.value)} placeholder="my-plugin" />
              </label>
              <label>
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My plugin"
                />
              </label>
              <button
                disabled={busy || !id || !name}
                onClick={() => void act(() => window.stoke.plugins.create(id, name))}
              >
                Create source and install…
              </button>
            </div>
          </details>
          <p className="plugin-muted">
            Marketplace packages: {PLUGIN_CATALOG.length}. API v1 supports command panels, project context and
            appearance mods.
          </p>
        </>
      )}
      {busy && <p role="status">Working…</p>}
      {(error || loadError) && (
        <p role="alert" className="plugin-error">
          {error || loadError}
        </p>
      )}
    </section>
  )
}
