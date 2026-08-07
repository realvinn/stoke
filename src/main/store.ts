import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProfileConfig, Settings, SshHost, Theme } from '@shared/types'
import { DEFAULT_THEME_ID, validateTheme } from '@shared/themes'
import { DEFAULT_WORKLOG_BOARDS } from '@shared/worklog'

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

const DEFAULTS: Settings = {
  themeId: DEFAULT_THEME_ID,
  customThemes: [],
  fontFamily:
    "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 13,
  uiScale: 1,
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
  sidebarWidth: 260,
  claudePath: null,
  confirmBypass: true,
  projectMeta: {},
  worklogBoards: DEFAULT_WORKLOG_BOARDS,
  hideStatusLine: true
}

let cache: Settings | null = null
const listeners = new Set<(s: Settings) => void>()

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Shallow-merge persisted values over defaults so new keys appear on upgrade. */
function hydrate(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
  const r = raw as Partial<Settings>
  return {
    ...DEFAULTS,
    ...r,
    defaults: { ...DEFAULTS.defaults, ...(r.defaults ?? {}) },
    browser: {
      ...DEFAULTS.browser,
      ...(r.browser ?? {}),
      bookmarks: Array.isArray(r.browser?.bookmarks) ? r.browser.bookmarks : []
    },
    remote: { ...DEFAULTS.remote, ...(r.remote ?? {}) },
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
    profiles: Array.isArray(r.profiles) ? r.profiles.filter(isProfileConfig) : [],
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
    worklogAuto: typeof r.worklogAuto === 'boolean' ? r.worklogAuto : DEFAULTS.worklogAuto,
    betaUpdates: r.betaUpdates === true,
    projectRoots: Array.isArray(r.projectRoots) ? r.projectRoots : [],
    pinnedProjects: Array.isArray(r.pinnedProjects) ? r.pinnedProjects : [],
    hiddenProjects: Array.isArray(r.hiddenProjects) ? r.hiddenProjects : []
  }
}

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = hydrate(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

/** Write via a temp file + rename so a crash mid-write cannot truncate settings. */
function persist(s: Settings): void {
  const target = file()
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
  renameSync(tmp, target)
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = hydrate({ ...getSettings(), ...patch })
  cache = next
  try {
    persist(next)
  } catch (err) {
    console.error('[stoke] failed to persist settings', err)
  }
  for (const fn of listeners) fn(next)
  return next
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
