import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '@shared/types'
import { DEFAULT_THEME_ID } from '@shared/themes'

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
    effort: 'default'
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
    requireAccessHeader: false,
    autoStartTunnel: false,
    tunnelName: 'stoke'
  },
  sidebarWidth: 260,
  claudePath: null,
  confirmBypass: true
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
    customThemes: Array.isArray(r.customThemes) ? r.customThemes : [],
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
