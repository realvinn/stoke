import type { CliInfo, EffortLevel, PermissionMode, Settings, Theme } from '@shared/types'
import type { ResolvedProfile } from '@shared/profiles'
import { BUILT_IN_THEMES } from '@shared/themes'
import {
  clampFontSize,
  clampUiScale,
  type ZoomTarget,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_MIN
} from '@shared/ui'
import { IconClose } from './Icons'
import { useEffect, useRef, useState } from 'react'
import { HostsSettings } from './HostsSettings'
import { MicrophoneNotice } from './MicrophoneNotice'
import { ProfilesSettings } from './ProfilesSettings'
import { ClaudeCodeSettings } from './ClaudeCodeSettings'
import { RemoteSettings, SelfUpdateSettings, UpdatesSettings } from './RemoteSettings'
import { WorklogSettings } from './WorklogSettings'
import { EFFORT_LEVELS, MODEL_OPTIONS, PERMISSION_MODES } from '../lib/permissions'

/**
 * The zoom targets, worded as what they move rather than as their ids.
 *
 * "Both" first because it is the default and the one most people mean; the
 * hints say what the other two deliberately leave alone, since a zoom key that
 * visibly changes nothing is the failure mode here — pick "Interface" and the
 * terminal text genuinely will not move, because xterm takes its size in px
 * from the font setting and never from the interface scale.
 */
const ZOOM_TARGET_LABELS: { id: ZoomTarget; label: string; hint: string }[] = [
  { id: 'both', label: 'Both', hint: 'Interface scale and terminal font together' },
  { id: 'terminal', label: 'Terminal', hint: 'Terminal font only — the interface stays put' },
  { id: 'interface', label: 'Interface', hint: 'Interface only — the terminal text stays put' }
]

/**
 * The settings menu.
 *
 * This used to be one 26rem drawer holding every section end to end, and the
 * problem was not that it was long — it was that length was the only structure
 * it had. Nineteen unrelated controls in one scroll means the way to find the
 * SSH host list is to recognise it going past, and the way to know whether you
 * have seen everything is to have reached the bottom. Splitting it into named
 * sections costs a click and buys an answer to "where is X" that does not
 * involve scrolling.
 *
 * The rows are grouped by what they are about, and the groups run from what you
 * change to what merely reports. That replaced an order chosen by how often a
 * section is opened, which sounds reasonable and reads as arbitrary: frequency
 * is invisible from the menu, so the only thing a reader could see was Updates
 * sitting fourth, between Projects and Claude Code, with nothing to explain
 * why. Ten adjacent rows have no structure a reader can recover, so adjacency
 * alone could not carry the grouping — the headings are the change, and the
 * reorder follows from them.
 *
 * `hint` is the nav item's tooltip and does the job a subtitle would without
 * making every row two lines tall.
 */
type SectionId =
  | 'appearance'
  | 'profiles'
  | 'sessions'
  | 'claude'
  | 'projects'
  | 'hosts'
  | 'worklog'
  | 'remote'
  | 'updates'
  | 'advanced'

interface Section {
  id: SectionId
  label: string
  hint: string
}

/*
 * Profiles sits under Appearance rather than beside Projects because its
 * visible effect is the accent colour on the tab strip and the sidebar chip;
 * the scan root it also carries is the half nobody comes looking for. Updates
 * and Advanced are last together for the same reason they are one group: both
 * are read far more often than they are written.
 */
const GROUPS: { title: string; sections: Section[] }[] = [
  {
    title: 'Appearance',
    sections: [
      { id: 'appearance', label: 'Appearance', hint: 'Theme, fonts, and how big everything is' },
      { id: 'profiles', label: 'Profiles', hint: 'Per-folder colours and scan roots' }
    ]
  },
  {
    title: 'Configuration',
    sections: [
      { id: 'sessions', label: 'Sessions', hint: 'What a new session starts with' },
      { id: 'claude', label: 'Claude Code', hint: "Claude Code's own configuration" },
      { id: 'projects', label: 'Projects', hint: 'Which folders the sidebar scans' },
      { id: 'hosts', label: 'SSH hosts', hint: 'Remote machines to open sessions on' }
    ]
  },
  {
    title: 'Integrations',
    sections: [
      { id: 'worklog', label: 'Worklog', hint: 'The Notion / ClickUp review queue' },
      { id: 'remote', label: 'Phone access', hint: 'Reaching this window from a phone' }
    ]
  },
  {
    title: 'System',
    sections: [
      { id: 'updates', label: 'Updates', hint: 'Stoke and the Claude Code CLI' },
      { id: 'advanced', label: 'Advanced', hint: 'Where the claude executable is' }
    ]
  }
]

/*
 * The flat list the keyboard nav walks. It is DERIVED from `GROUPS` rather than
 * maintained beside it, because `onNavKey` finds the element to focus by
 * indexing `querySelectorAll('[role="tab"]')` with an index it computed from
 * this array — so the two orders are not merely expected to agree, arrow keys
 * focus the wrong row the moment they do not. Deriving it makes them the same
 * order by construction.
 */
const SECTIONS: Section[] = GROUPS.flatMap((g) => g.sections)

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
  /** Forwarded to ProfilesSettings; see the comment on its `onCreated` prop. */
  onProfileCreated: () => void | Promise<void>
  onClose: () => void
}

export function SettingsSheet({
  settings,
  profiles,
  defaultCwd,
  cli,
  onPatch,
  onAddRoot,
  onProfileCreated,
  onClose
}: Props): React.JSX.Element {
  const themes: Theme[] = [...BUILT_IN_THEMES, ...settings.customThemes]
  const [section, setSection] = useState<SectionId>('appearance')

  /*
   * The scrolling pane, reset to the top on every section change.
   *
   * Without this a tall section scrolled halfway down leaves the next one
   * opening mid-content, which reads as a section with its heading missing
   * rather than as retained scroll position.
   */
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 })
  }, [section])

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

  /*
   * Escape is NOT bound here. App.tsx already owns it for every overlay
   * ("closes whichever overlay is on top", App.tsx:1266) and unmounts this
   * component outright — which several sections below depend on: WorklogSettings
   * and RemoteSettings each flush a draft field on unmount precisely because
   * React delivers no blur to a node that is disappearing. A second listener
   * here would close by the same route and change nothing, but it would put the
   * ordering of two handlers in the way of a rule that currently has one owner.
   */

  /**
   * Arrow keys move between sections, which is what a tablist is expected to
   * do and is the difference between a menu and ten buttons that happen to be
   * stacked. Home/End jump to the ends; the roving `tabIndex` below is what
   * keeps Tab itself moving out of the nav and into the pane rather than
   * through all ten.
   */
  const onNavKey = (e: React.KeyboardEvent): void => {
    const i = SECTIONS.findIndex((s) => s.id === section)
    const to =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? (i + 1) % SECTIONS.length
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? (i - 1 + SECTIONS.length) % SECTIONS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? SECTIONS.length - 1
              : -1
    if (to < 0) return
    e.preventDefault()
    setSection(SECTIONS[to].id)
    // Focus follows selection, so the reader of a screen reader hears the
    // section they just moved to rather than being told nothing happened.
    const nav = e.currentTarget as HTMLElement
    nav.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus()
  }

  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close settings (Esc)">
            <IconClose />
            <span className="sr-only">Close settings</span>
          </button>
        </div>

        <div className="settings-cols">
          {/*
           * One `tablist` per group, not one for the whole menu. A `tablist`'s
           * only permitted owned elements are tabs, so a heading placed inside
           * the old single list would have had to be hidden from assistive
           * technology to stay valid — which is the grouping, deleted for
           * exactly the readers who cannot see the indentation that would
           * otherwise convey it. A tablist per group makes each heading a real
           * accessible name instead. The keydown handler stays on the `nav`
           * above all four, so arrow keys still walk the ten rows as one run
           * and wrap end to end; `onNavKey` reads `currentTarget`, which is the
           * nav rather than the group the event started in.
           */}
          <nav className="settings-nav" aria-label="Settings sections" onKeyDown={onNavKey}>
            {GROUPS.map((g) => {
              const titleId = `settings-group-${g.title.toLowerCase()}`
              return (
                <div className="settings-nav-group" key={g.title}>
                  <div className="settings-nav-group-title" id={titleId}>
                    {g.title}
                  </div>
                  <div role="tablist" aria-orientation="vertical" aria-labelledby={titleId}>
                    {g.sections.map((s) => (
                      <button
                        key={s.id}
                        role="tab"
                        id={`settings-tab-${s.id}`}
                        aria-controls={`settings-pane-${s.id}`}
                        aria-selected={section === s.id}
                        // Roving tabIndex: exactly one nav item is in the tab
                        // order, so Tab from the close button lands on the
                        // current section and the next Tab leaves the nav
                        // entirely.
                        tabIndex={section === s.id ? 0 : -1}
                        title={s.hint}
                        onClick={() => setSection(s.id)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </nav>

          <div
            className="settings-pane"
            ref={paneRef}
            role="tabpanel"
            id={`settings-pane-${section}`}
            aria-labelledby={`settings-tab-${section}`}
            // Focusable so the pane itself can be scrolled from the keyboard
            // when the section it holds is all read-only text.
            tabIndex={0}
          >
            {section === 'appearance' && (
              <>
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
                    <span className="mono"> settings.json</span> in the app data folder — anything
                    you put in <span className="mono">customThemes</span> shows up here.
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
                  <span className="field-hint">
                    A CSS font stack. The first installed family wins.
                  </span>
                </div>

                <div className="field">
                  <span className="field-label">Terminal size</span>
                  <input
                    className="input"
                    type="number"
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    value={settings.fontSize}
                    onChange={(e) => onPatch({ fontSize: clampFontSize(e.target.value) })}
                  />
                </div>

                <div className="field">
                  <span className="field-label">Interface scale</span>
                  {/*
                    min/max are advisory inside React's onChange — the browser will
                    not stop a typed or pasted value reaching the handler — so the
                    same clamp the store enforces is applied here too, and the two
                    bounds come from one place. The field used to offer 8-28 for a
                    store that accepts 9-24, and to fall back with `|| 1`, which
                    turned a typed 0 into 1 rather than into the floor.
                  */}
                  <input
                    className="input"
                    type="number"
                    min={UI_SCALE_MIN}
                    max={UI_SCALE_MAX}
                    step={0.05}
                    value={settings.uiScale}
                    onChange={(e) => onPatch({ uiScale: clampUiScale(e.target.value) })}
                  />
                  <span className="field-hint">Scales everything except the terminal contents.</span>
                </div>

                {/*
                  Which of the two sizes above the zoom keys move. Offered rather than
                  decided, because both answers are the convention somewhere: a
                  terminal scales only its font, an editor scales everything, and
                  Stoke is an editor-shaped app full of terminal-shaped content.
                */}
                <div className="field">
                  <span className="field-label">Zoom keys change</span>
                  <div
                    className="segmented"
                    role="group"
                    aria-label="What the zoom shortcut changes"
                  >
                    {ZOOM_TARGET_LABELS.map((z) => (
                      <button
                        key={z.id}
                        aria-pressed={settings.zoomTarget === z.id}
                        title={z.hint}
                        onClick={() => onPatch({ zoomTarget: z.id })}
                      >
                        {z.label}
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">
                    {window.stoke.platform === 'darwin' ? 'Cmd' : 'Ctrl'} with <kbd>+</kbd>,{' '}
                    <kbd>−</kbd> or <kbd>0</kbd> to reset.
                  </span>
                </div>
              </>
            )}

            {section === 'sessions' && (
              <>
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
                            defaults: {
                              ...settings.defaults,
                              permissionMode: m.id as PermissionMode
                            }
                          })
                        }
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">
                    Applied to every new session unless changed at launch.
                  </span>
                </div>

                <div className="field">
                  <span className="field-label">Default model</span>
                  <select
                    className="select"
                    value={settings.defaults.model}
                    onChange={(e) =>
                      onPatch({ defaults: { ...settings.defaults, model: e.target.value } })
                    }
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
                      Stoke reads the context window and your plan limits from the status line the
                      CLI pipes to it, and by default prints nothing back — the line duplicates
                      chrome the app already draws. Turn this off to keep your own status line,
                      which still runs and still shows exactly what it did before. Your{' '}
                      <span className="mono">~/.claude/settings.json</span> is never modified, and
                      either way this applies to sessions started after the change. Plan limits
                      also depend on being signed in through a Claude.ai plan rather than an API
                      key — with an API key there is nothing for them to draw on, and they stay
                      blank no matter how this is set.
                    </span>
                  </span>
                </label>
              </>
            )}

            {section === 'projects' && (
              <>
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

                <div className="field">
                  <span className="field-label">Hidden projects</span>
                  {settings.hiddenProjects.length > 0 ? (
                    <>
                      <span className="field-hint">
                        {settings.hiddenProjects.length} hidden from the sidebar.
                      </span>
                      <button className="btn" onClick={() => onPatch({ hiddenProjects: [] })}>
                        Show them all again
                      </button>
                    </>
                  ) : (
                    // Shown empty rather than hidden entirely: in a flat scroll a
                    // missing section was invisible, but in a named section the
                    // question "where did Hidden projects go" has to have an answer.
                    <span className="field-hint">
                      None. Hide one from its right-click menu in the sidebar.
                    </span>
                  )}
                </div>
              </>
            )}

            {section === 'updates' && (
              <>
                <SelfUpdateSettings
                  betaUpdates={settings.betaUpdates}
                  onChangeBeta={(betaUpdates) => onPatch({ betaUpdates })}
                />
                <UpdatesSettings
                  autoUpdate={settings.cliAutoUpdate}
                  onChangeAuto={(cliAutoUpdate) => onPatch({ cliAutoUpdate })}
                />
              </>
            )}

            {section === 'claude' && <ClaudeCodeSettings cliVersion={cli?.version ?? null} />}

            {section === 'profiles' && (
              <ProfilesSettings settings={settings} onPatch={onPatch} onCreated={onProfileCreated} />
            )}

            {section === 'worklog' && (
              <WorklogSettings
                profiles={profiles}
                worklogGroups={settings.worklogGroups}
                auto={settings.worklogAuto}
                boards={settings.worklogBoards}
                onChangeBoards={(worklogBoards) => onPatch({ worklogBoards })}
                onChange={(worklogGroups) => onPatch({ worklogGroups })}
                onChangeAuto={(worklogAuto) => onPatch({ worklogAuto })}
              />
            )}

            {section === 'hosts' && (
              <HostsSettings
                hosts={settings.hosts}
                suggestions={sshAliases}
                onChange={(hosts) => onPatch({ hosts })}
              />
            )}

            {section === 'remote' && (
              <>
                <MicrophoneNotice />
                <RemoteSettings settings={settings} onPatch={onPatch} />
              </>
            )}

            {section === 'advanced' && (
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
            )}
          </div>
        </div>
      </div>
    </>
  )
}
