import type { CliInfo, EffortLevel, PermissionMode, Settings, Theme } from '@shared/types'
import type { ResolvedProfile } from '@shared/profiles'
import { BUILT_IN_THEMES } from '@shared/themes'
import { IconClose } from './Icons'
import { useEffect, useState } from 'react'
import { HostsSettings } from './HostsSettings'
import { MicrophoneNotice } from './MicrophoneNotice'
import { ProfilesSettings } from './ProfilesSettings'
import { RemoteSettings, SelfUpdateSettings, UpdatesSettings } from './RemoteSettings'
import { WorklogSettings } from './WorklogSettings'
import { EFFORT_LEVELS, MODEL_OPTIONS, PERMISSION_MODES } from '../lib/permissions'

interface Props {
  settings: Settings
  /**
   * The resolved profile list, passed in rather than derived here so the worklog
   * checkboxes and the sidebar chips can never disagree about which profiles
   * exist.
   */
  profiles: ResolvedProfile[]
  /** Resolved default working directory, shown when none is configured. */
  defaultCwd: string
  cli: CliInfo | null
  onPatch: (patch: Partial<Settings>) => void
  onAddRoot: () => void
  onClose: () => void
}

export function SettingsSheet({
  settings,
  profiles,
  defaultCwd,
  cli,
  onPatch,
  onAddRoot,
  onClose
}: Props): React.JSX.Element {
  const themes: Theme[] = [...BUILT_IN_THEMES, ...settings.customThemes]

  /*
   * Offer the Host aliases the user already has rather than making them retype
   * connection details. Read once when the sheet opens; ~/.ssh/config is not
   * something that changes while it is on screen.
   */
  const [sshAliases, setSshAliases] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void window.stoke.ssh.configHosts().then((a) => {
      if (live) setSshAliases(a)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close settings">
            <IconClose />
            <span className="sr-only">Close settings</span>
          </button>
        </div>

        <div className="sheet-body">
          <div className="field">
            <span className="field-label">Theme</span>
            <div className="theme-grid">
              {themes.map((t) => (
                <button
                  key={t.id}
                  className="theme-swatch"
                  aria-pressed={settings.themeId === t.id}
                  onClick={() => onPatch({ themeId: t.id })}
                >
                  <span className="theme-chips">
                    <span className="theme-chip" style={{ background: t.colors.bg }} />
                    <span className="theme-chip" style={{ background: t.colors.surface }} />
                    <span className="theme-chip" style={{ background: t.colors.accent }} />
                    <span className="theme-chip" style={{ background: t.colors.text }} />
                  </span>
                  <span className="theme-name">{t.name}</span>
                </button>
              ))}
            </div>
            <span className="field-hint">
              Themes are plain CSS custom properties. Add your own by editing
              <span className="mono"> settings.json</span> in the app data folder — anything you
              put in <span className="mono">customThemes</span> shows up here.
            </span>
          </div>

          <div className="field">
            <span className="field-label">Terminal font</span>
            <input
              className="input mono"
              value={settings.fontFamily}
              spellCheck={false}
              onChange={(e) => onPatch({ fontFamily: e.target.value })}
            />
            <span className="field-hint">A CSS font stack. The first installed family wins.</span>
          </div>

          <div className="field">
            <span className="field-label">Terminal size</span>
            <input
              className="input"
              type="number"
              min={8}
              max={28}
              value={settings.fontSize}
              onChange={(e) => onPatch({ fontSize: Number(e.target.value) || 13 })}
            />
          </div>

          <div className="field">
            <span className="field-label">Interface scale</span>
            <input
              className="input"
              type="number"
              min={0.8}
              max={1.6}
              step={0.05}
              value={settings.uiScale}
              onChange={(e) => onPatch({ uiScale: Number(e.target.value) || 1 })}
            />
            <span className="field-hint">Scales everything except the terminal contents.</span>
          </div>

          <div className="field">
            <span className="field-label">Default permissions</span>
            <div className="segmented" role="group" aria-label="Default permission mode">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.id}
                  aria-pressed={settings.defaults.permissionMode === m.id}
                  data-danger={m.danger ? 'true' : undefined}
                  title={m.hint}
                  onClick={() =>
                    onPatch({
                      defaults: { ...settings.defaults, permissionMode: m.id as PermissionMode }
                    })
                  }
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="field-hint">Applied to every new session unless changed at launch.</span>
          </div>

          <div className="field">
            <span className="field-label">Default model</span>
            <select
              className="select"
              value={settings.defaults.model}
              onChange={(e) => onPatch({ defaults: { ...settings.defaults, model: e.target.value } })}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id || 'default'} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field-label">Default effort</span>
            <select
              className="select"
              value={settings.defaults.effort}
              onChange={(e) =>
                onPatch({
                  defaults: { ...settings.defaults, effort: e.target.value as EffortLevel }
                })
              }
            >
              {EFFORT_LEVELS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field-label">Default folder</span>
            <div style={{ display: 'flex', gap: 'var(--space-8)' }}>
              <input
                className="input mono"
                placeholder={defaultCwd}
                value={settings.defaultCwd ?? ''}
                spellCheck={false}
                onChange={(e) => onPatch({ defaultCwd: e.target.value.trim() || null })}
              />
              <button
                className="btn"
                onClick={async () => {
                  const dir = await window.stoke.pickFolder()
                  if (dir) onPatch({ defaultCwd: dir })
                }}
              >
                Choose
              </button>
            </div>
            <span className="field-hint">
              Where <b>Start here</b> opens a session when no project is selected. Leave it
              empty to auto-detect — currently <span className="mono">{defaultCwd}</span>.
            </span>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.startOnLaunch}
              onChange={(e) => onPatch({ startOnLaunch: e.target.checked })}
            />
            <span>
              <span className="field-label">Start a session on launch</span>
              <span className="field-hint">
                Opens a session in the default folder the moment Stoke starts, so the app is
                never sitting on an empty screen.
              </span>
            </span>
          </label>

          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.hideStatusLine}
              onChange={(e) => onPatch({ hideStatusLine: e.target.checked })}
            />
            <span>
              <span className="field-label">Hide Claude&rsquo;s status line in Stoke</span>
              <span className="field-hint">
                Stoke reads the context window and your plan limits from the status line the CLI
                pipes to it, and by default prints nothing back — the line duplicates chrome the
                app already draws. Turn this off to keep your own status line, which still runs and
                still shows exactly what it did before. Your{' '}
                <span className="mono">~/.claude/settings.json</span> is never modified, and either
                way this applies to sessions started after the change. Plan limits also depend on
                being signed in through a Claude.ai plan rather than an API key — with an API key
                there is nothing for them to draw on, and they stay blank no matter how this is set.
              </span>
            </span>
          </label>

          <div className="field">
            <span className="field-label">Scanned folders</span>
            {settings.projectRoots.length === 0 && (
              <span className="field-hint">
                None yet. Add a folder such as your code directory and every project inside it
                appears in the sidebar, even ones Claude has never opened.
              </span>
            )}
            {settings.projectRoots.map((root) => (
              <div
                key={root}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}
              >
                <span className="mono truncate" style={{ flex: 1, fontSize: 'var(--fs-xs)' }}>
                  {root}
                </span>
                <button
                  className="icon-btn"
                  data-size="sm"
                  title={`Stop scanning ${root}`}
                  onClick={() =>
                    onPatch({ projectRoots: settings.projectRoots.filter((r) => r !== root) })
                  }
                >
                  <IconClose />
                  <span className="sr-only">Remove {root}</span>
                </button>
              </div>
            ))}
            <button className="btn" onClick={onAddRoot}>
              Add a folder
            </button>
          </div>

          <SelfUpdateSettings
            betaUpdates={settings.betaUpdates}
            onChangeBeta={(betaUpdates) => onPatch({ betaUpdates })}
          />

          <UpdatesSettings />

          <ProfilesSettings settings={settings} onPatch={onPatch} />

          <WorklogSettings
            profiles={profiles}
            worklogGroups={settings.worklogGroups}
            auto={settings.worklogAuto}
            boards={settings.worklogBoards}
            onChangeBoards={(worklogBoards) => onPatch({ worklogBoards })}
            onChange={(worklogGroups) => onPatch({ worklogGroups })}
            onChangeAuto={(worklogAuto) => onPatch({ worklogAuto })}
          />

          <HostsSettings
            hosts={settings.hosts}
            suggestions={sshAliases}
            onChange={(hosts) => onPatch({ hosts })}
          />

          <MicrophoneNotice />

          <RemoteSettings settings={settings} onPatch={onPatch} />

          <div className="field">
            <span className="field-label">Claude CLI path</span>
            <input
              className="input mono"
              placeholder="Auto-detected"
              value={settings.claudePath ?? ''}
              spellCheck={false}
              onChange={(e) => onPatch({ claudePath: e.target.value.trim() || null })}
            />
            <span className="field-hint">
              {cli?.ok
                ? `Using ${cli.path}${cli.version ? ` — ${cli.version}` : ''}`
                : (cli?.error ?? 'Looking for the claude executable…')}
            </span>
          </div>

          {settings.hiddenProjects.length > 0 && (
            <div className="field">
              <span className="field-label">Hidden projects</span>
              <span className="field-hint">
                {settings.hiddenProjects.length} hidden from the sidebar.
              </span>
              <button className="btn" onClick={() => onPatch({ hiddenProjects: [] })}>
                Show them all again
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
