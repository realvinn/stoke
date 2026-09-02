/**
 * The settings schema: defaults and repair, with no `electron` import.
 *
 * `hydrateSettings` is the only thing standing between a hand-edited
 * `settings.json` and the app. It used to live inside `store.ts`, behind an
 * `import { app } from 'electron'`, which meant none of it could ever run
 * outside a window — see `scripts/verify-settings.mts`.
 */
import type { ProfileConfig, ProjectMeta, Settings, SshHost, Theme, WorklogBoards } from '@shared/types'
import { tidy } from './projectMeta.ts'
import { DEFAULT_THEME_ID, validateTheme } from '../shared/themes.ts'
import { DEFAULT_WORKLOG_BOARDS, WORKLOG_TARGETS } from '../shared/worklog.ts'
import {
  clampFontSize,
  clampPort,
  clampTerminal,
  clampUiScale,
  clampWallpaper,
  clampZoomTarget,
  TERMINAL_DEFAULTS,
  WALLPAPER_DEFAULTS
} from '../shared/ui.ts'

/**
 * Structural check only. A stored profile that is missing colours is still
 * useful - resolveProfiles fills them from the derived seed - so this rejects
 * only what cannot be identified at all.
 */
function isProfileConfig(v: unknown): v is ProfileConfig {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<ProfileConfig>
  return typeof p.id === 'string' && p.id.length > 0 && Array.isArray(p.groups)
}

export const DEFAULT_SETTINGS: Settings = {
  themeId: DEFAULT_THEME_ID,
  customThemes: [],
  wallpaper: { ...WALLPAPER_DEFAULTS },
  fontFamily:
    "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 13,
  uiScale: 1,
  terminal: { ...TERMINAL_DEFAULTS },
  zoomTarget: 'both',
  defaults: {
    permissionMode: 'default',
    model: '',
    effort: 'default',
    ultracode: false
  },
  projectRoots: [],
  // null = auto-detect. workspace.ts prefers G:\Code on Windows, then ~/Code.
  defaultCwd: null,
  startOnLaunch: false,
  pinnedProjects: [],
  hiddenProjects: [],
  browser: {
    // Canonical URL — the older docs.claude.com path 301s here.
    homepage: 'https://code.claude.com/docs',
    lastUrl: '',
    width: 460,
    bookmarks: []
  },
  remote: {
    enabled: false,
    port: 7878,
    token: '',
    hostname: '',
    bindLan: false,
    bindTailscale: false,
    requireAccessHeader: false,
    autoStartTunnel: false,
    tunnelName: 'stoke',
    /*
     * The speech sidecar's documented local port. Nothing is contacted unless
     * the microphone is actually used, and if no sidecar is listening the phone
     * gets a plain "unreachable" message rather than a silent failure.
     */
    sttUrl: 'http://127.0.0.1:17890'
  },
  activeProfile: null,
  profiles: [],
  hosts: [],
  worklogGroups: [],
  // Safe to default on: worklogGroups is the switch that actually costs money,
  // and it ships empty. With nothing watched this does nothing at all.
  worklogAuto: true,
  // Off. A beta is a build whose risky paths have not been run; it has to be
  // asked for rather than arrive.
  betaUpdates: false,
  // On: the CLI already updates itself, so this makes an existing behaviour
  // visible and switchable rather than introducing a new one. See the type.
  cliAutoUpdate: true,
  sidebarWidth: 260,
  claudePath: null,
  confirmBypass: true,
  projectMeta: {},
  worklogBoards: DEFAULT_WORKLOG_BOARDS,
  // Default true: the wrapper is how the context window and the plan limits
  // reach the app at all, and the line it suppresses duplicates chrome Stoke
  // already draws.
  hideStatusLine: true,
  // Background only: a notification for the tab in front is noise, one for a
  // tab behind another — or a window behind another app — is the point.
  notifications: 'background'
}

/**
 * Two built-in profiles were renamed for 0.4.0: `gitea-company` -> `work` and
 * `gitea-vibe` -> `side`. They were one person's forge namespaces shipping as
 * two of the four built-ins, inert for everybody else — and `gitea-company`
 * held the label "Work", so a folder actually called `work` was denied the
 * chip that named it.
 *
 * A profile id doubles as the project *group* it matches (`seedToResolved`
 * sets `groups: [p.id]`), so renaming the seed alone would quietly stop
 * matching the folders it used to. Anyone who had customised one of these
 * profiles has a stored record whose `groups` still names the old folder, and
 * that record must keep working: the rename is applied to its **id** while its
 * `groups` are left exactly as found. The chip keeps its colours, keeps its
 * folders, and only its identity moves.
 *
 * A stored record already using the new id wins — this never overwrites one.
 */
const RENAMED_PROFILE_IDS: Record<string, string> = {
  'gitea-company': 'work',
  'gitea-vibe': 'side'
}

function renameProfileIds(profiles: ProfileConfig[]): ProfileConfig[] {
  const taken = new Set(profiles.map((p) => p.id))
  return profiles.map((p) => {
    const renamed = RENAMED_PROFILE_IDS[p.id]
    return renamed && !taken.has(renamed) ? { ...p, id: renamed } : p
  })
}

function hydrateProjectMeta(raw: unknown): Record<string, ProjectMeta> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ProjectMeta> = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    // Same normalisation as Project.path: trimmed, no trailing separator. A key
    // written by hand with one would never match a lookup.
    const key = path.trim().replace(/[\\/]+$/, '')
    if (!key || !value || typeof value !== 'object') continue
    // One implementation of the caps, the trim and the literal-true rule for
    // addedManually, shared with the IPC write path. See projectMeta.ts.
    const entry = tidy(value as Partial<ProjectMeta>)
    // An entry that says nothing is dropped — tidy returns null for it — so the
    // file cannot accumulate an empty object for every folder that was ever
    // right-clicked.
    if (entry) out[key] = entry
  }
  return out
}

function hydrateWorklogBoards(raw: unknown): WorklogBoards {
  const d = DEFAULT_WORKLOG_BOARDS
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...d, targets: [...d.targets] }
  }
  const r = raw as Partial<WorklogBoards>
  const notionDataSource =
    typeof r.notionDataSource === 'string' ? r.notionDataSource.trim() : d.notionDataSource
  const clickupListId =
    typeof r.clickupListId === 'string' ? r.clickupListId.trim() : d.clickupListId
  const asked = Array.isArray(r.targets) ? (r.targets as unknown[]) : [...d.targets]
  return {
    // Filtered through WORKLOG_TARGETS rather than trusted, so the write order
    // is canonical whatever order the file happened to hold — and so a typo
    // cannot name a destination no write tool exists for.
    //
    // A destination with no id is not a destination. Dropping it here means the
    // runner never has to check, and the settings sheet shows the truth.
    targets: WORKLOG_TARGETS.filter(
      (t) => asked.includes(t) && (t === 'notion' ? notionDataSource : clickupListId).length > 0
    ),
    notionDataSource,
    clickupListId
  }
}

/** Shallow-merge persisted values over defaults so new keys appear on upgrade. */
export function hydrateSettings(raw: unknown): Settings {
  // `{}` is an object, so this falls straight into the main path below rather
  // than short-circuiting to a bare `{ ...DEFAULT_SETTINGS }` spread. A bare
  // spread is shallow: `worklogBoards` and `projectMeta` would still be the
  // exact objects DEFAULT_SETTINGS points at (DEFAULT_WORKLOG_BOARDS itself,
  // in the worklogBoards case), so an in-place mutation by a caller would
  // corrupt the shared module constant for the rest of the process. Routing
  // through `{}` rebuilds every structured field with its own repair logic,
  // which already returns fresh objects.
  if (!raw || typeof raw !== 'object') return hydrateSettings({})
  const r = raw as Partial<Settings>
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(r.defaults ?? {}) },
    browser: {
      ...DEFAULT_SETTINGS.browser,
      ...(r.browser ?? {}),
      bookmarks: Array.isArray(r.browser?.bookmarks) ? r.browser.bookmarks : []
    },
    remote: {
      ...DEFAULT_SETTINGS.remote,
      ...(r.remote ?? {}),
      // The one remote field a wrong value can silently break: a port outside
      // the range fails to bind with an EACCES nobody reads. See clampPort.
      port: clampPort(r.remote?.port ?? DEFAULT_SETTINGS.remote.port)
    },
    /*
     * Themes are repaired rather than trusted. applyTheme writes whatever keys
     * are on the object, so a custom theme missing a token used to render an
     * unreadable app - or throw during boot, before a window exists to show the
     * error. validateTheme fills gaps from the matching built-in and drops what
     * cannot be salvaged; it must never throw.
     */
    customThemes: Array.isArray(r.customThemes)
      ? r.customThemes.map(validateTheme).filter((t): t is Theme => t !== null)
      : [],
    profiles: Array.isArray(r.profiles)
      ? renameProfileIds(r.profiles.filter(isProfileConfig))
      : [],
    /*
     * A view filter, and now one the tab strip writes on every activation — so
     * it is repaired like every other structured field rather than trusted. An
     * id that matches no profile is deliberately kept: profileFor resolves it
     * against the visible list each render and yields no filter when it misses,
     * and a record can legitimately live on another machine.
     */
    activeProfile:
      typeof r.activeProfile === 'string' && r.activeProfile.trim() !== ''
        ? // Renamed alongside the stored records above, or a machine sitting on
          // one of the two old ids would come back with its filter pointing at
          // a profile that no longer exists.
          (RENAMED_PROFILE_IDS[r.activeProfile.trim()] ?? r.activeProfile.trim())
        : null,
    hosts: Array.isArray(r.hosts)
      ? r.hosts
          .filter(
            (h): h is SshHost =>
              !!h && typeof h === 'object' && typeof h.id === 'string' && typeof h.alias === 'string'
          )
          // `worklog` decides whether an agent reads that machine's transcripts,
          // so anything that is not literally `true` is off. A truthy leftover
          // from a hand-edited file must not switch it on.
          .map((h) => ({ ...h, worklog: h.worklog === true }))
      : [],
    worklogGroups: Array.isArray(r.worklogGroups)
      ? r.worklogGroups.filter((g): g is string => typeof g === 'string')
      : [],
    // A settings file written before 0.4.0 has no such key, and it must read as
    // on rather than off — the default is what an untouched machine gets.
    worklogAuto: typeof r.worklogAuto === 'boolean' ? r.worklogAuto : DEFAULT_SETTINGS.worklogAuto,
    betaUpdates: r.betaUpdates === true,
    // `!== false`, not `=== true`: a settings file written before this key
    // existed must read as the default, which is on.
    cliAutoUpdate: r.cliAutoUpdate !== false,
    projectRoots: Array.isArray(r.projectRoots) ? r.projectRoots : [],
    pinnedProjects: Array.isArray(r.pinnedProjects) ? r.pinnedProjects : [],
    hiddenProjects: Array.isArray(r.hiddenProjects) ? r.hiddenProjects : [],
    projectMeta: hydrateProjectMeta(r.projectMeta),
    worklogBoards: hydrateWorklogBoards(r.worklogBoards),
    // `!== false` and not `=== true`: a file written before this key existed
    // must read as on, which is what an untouched machine gets.
    hideStatusLine: r.hideStatusLine !== false,
    notifications:
      r.notifications === 'off' || r.notifications === 'always' || r.notifications === 'background'
        ? r.notifications
        : DEFAULT_SETTINGS.notifications,
    uiScale: clampUiScale(r.uiScale),
    fontSize: clampFontSize(r.fontSize),
    terminal: clampTerminal(r.terminal),
    wallpaper: clampWallpaper(r.wallpaper),
    zoomTarget: clampZoomTarget(r.zoomTarget)
  }
}
