import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '@shared/types'
import { hydrateSettings } from './settingsSchema.ts'

let cache: Settings | null = null
const listeners = new Set<(s: Settings) => void>()

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = hydrateSettings(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    // A fresh install (readFileSync throws ENOENT) or an unreadable file both
    // land here. Route through the same repair as a real settings.json rather
    // than a bare `{ ...DEFAULT_SETTINGS }` spread — that spread is shallow
    // and would hand out DEFAULT_WORKLOG_BOARDS and DEFAULT_SETTINGS.projectMeta
    // by reference, letting a later in-place mutation corrupt the shared
    // module constants for the rest of the process.
    cache = hydrateSettings(null)
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
  const next = hydrateSettings({ ...getSettings(), ...patch })
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
