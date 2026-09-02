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

/**
 * How long a burst of writes is allowed to coalesce into one.
 *
 * `persist` is `writeFileSync` + `renameSync` — synchronous, on the main
 * thread, of the WHOLE settings object — and a `<input type="range">` fires
 * `onChange` continuously while it is dragged. Seven controls in the settings
 * sheet are ranges or number fields wired straight to `onPatch` (font size,
 * line height, letter spacing, cursor width, the two wallpaper sliders,
 * interface scale), so dragging any one of them was tens of full serialise +
 * write + rename cycles a second, each one blocking the event loop and with it
 * every PTY reply and every IPC answer. Gotcha 40's class of defect exactly,
 * reached through a slider instead of a project list.
 */
const COALESCE_MS = 200

let pendingWrite: Settings | null = null
let flushTimer: NodeJS.Timeout | null = null
let lastWriteAt = 0

function writeNow(s: Settings): void {
  lastWriteAt = Date.now()
  try {
    persist(s)
  } catch (err) {
    console.error('[stoke] failed to persist settings', err)
  }
}

/*
 * Leading edge AND trailing edge, deliberately, rather than a plain debounce.
 *
 * A single discrete change — a checkbox, a segmented control, one arrow press
 * on a number field — is written immediately, exactly as it was before, so the
 * ordinary case has no new window in which a crash loses a setting. Only a
 * BURST coalesces, and a burst then costs two writes: the first tick and the
 * settled value. A plain trailing debounce would have delayed every single
 * write by 200ms to fix a problem only sliders have.
 */
function schedulePersist(s: Settings): void {
  if (!flushTimer && Date.now() - lastWriteAt >= COALESCE_MS) {
    writeNow(s)
    return
  }
  pendingWrite = s
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const s2 = pendingWrite
    pendingWrite = null
    if (s2) writeNow(s2)
  }, COALESCE_MS)
}

/**
 * Write anything still coalescing, now.
 *
 * Called from both `before-quit` and the window's own `closed` handler, because
 * on macOS closing the last window does not fire `before-quit` at all (gotcha
 * 35) — so relying on the former alone would lose the tail of a drag on the one
 * platform where the window outlives the quit.
 */
export function flushSettings(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const s = pendingWrite
  pendingWrite = null
  if (s) writeNow(s)
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = hydrateSettings({ ...getSettings(), ...patch })
  // The cache and the listeners are updated synchronously either way, so
  // nothing observable is delayed — only the bytes reaching the disk.
  cache = next
  schedulePersist(next)
  for (const fn of listeners) fn(next)
  return next
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
