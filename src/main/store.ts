import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '@shared/types'
import { hydrateSettings } from './settingsSchema.ts'
import { safeStorageBackend, SecretStore, vaultItemPaths, writePrivateFile, type SecretStoreStatus } from './secrets.ts'
import { REMOTE_PUSH_KEY_PATH, REMOTE_TOKEN_PATH, SecretsGate, type SecretsOpenState } from '../shared/secretsOpen.ts'

let cache: Settings | null = null
/** Every `setSettings`, counted: whether anything wrote while the secret store was opening. */
let settingsWrites = 0
const listeners = new Set<(s: Settings) => void>()

/**
 * Where secrets go, once the store has opened (`initSecretStore`). Null before
 * that, and while it opens, when `persist` writes settings.json exactly as it
 * always has — `safeStorage` is not usable before `ready` on Windows and Linux,
 * and settings.json then holds no sealed key to expose.
 */
let secrets: SecretStore | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * The open's lifecycle (shared/secretsOpen.ts). Everything that reads a
 * secret waits on `secretsSettled()`; nothing may take an empty sealed field
 * for "no key" until `secretsReadable()`.
 */
const gate = new SecretsGate()

/**
 * For a run whose open FAILED (`off`): the known paths secrets.json holds,
 * none of which reached the settings. An empty sealed field at one of them is
 * stored but unread, never "none" (`secretsStoredUnread`).
 */
let unreadWhenOff: string[] = []

/**
 * Open the secret store and migrate a plaintext settings.json into it —
 * WITHOUT blocking the main thread.
 *
 * It used to be synchronous, first thing in `whenReady`, before any window:
 * `safeStorage.decryptString`, which on macOS waits on the main thread for a
 * Keychain password dialog. Measured 2026-10-27 after an auto-update: 18 s and
 * 8 s with no window on screen, a beachball, and the dialog possibly behind
 * other apps — the only Stoke hang macOS recorded that week. Now the two files
 * are read here (small, in userData, as before), the key store is asked
 * through its async calls (`SecretStore.prepare`), and the caller creates the
 * window meanwhile; the renderer says what it is waiting for
 * (`SecretsWaitNotice`). The store is consulted only when there is something
 * to seal or open, so a profile with no keys settles in a microtask and never
 * touches the Keychain.
 *
 * Until it settles, sealed keys read `''` in `getSettings()`, which means "not
 * opened yet": the renderer's `settings:get` waits, a launch waits rather than
 * start keyless, the phone key is never minted (`remoteKeyVerdict`, gotcha
 * 53), and the hub waits (index.ts). Writes made meanwhile go to settings.json
 * the old way, which holds no sealed key; the finish step overlays the vault's
 * keys on the settings as they stand then, with no await between reading them
 * and installing the result.
 *
 * Anything still coalescing is written first, the old way, both now and just
 * before the finish: a write queued before the vault was read carries empty
 * keys, and routing it through the vault afterwards would read as "every key
 * was deleted". A failure leaves the store off for this run — today's
 * behaviour — rather than taking settings down with it, and still settles.
 *
 * One open per process: claimed before the first await (gotcha 20); a second
 * call shares it.
 */
export function initSecretStore(): Promise<void> {
  if (!gate.claim()) return gate.settled()
  const started = Date.now()
  const writesAtStart = settingsWrites
  let warmedMs: number | null = null
  return (async () => {
    try {
      // Everything up to `prepare`'s first await runs now, synchronously, as
      // the blocking open did: the flush, and the read of the two files.
      flushSettings()
      const store = new SecretStore(app.getPath('userData'), safeStorageBackend(safeStorage, process.platform), process.platform)
      const finish = await store.prepare()
      // macOS: the blocking key fetch has a cache of its own, which the async
      // open did not fill, and `save`, the hub and the plugins use it. Asked
      // once here, while the window still says it is waiting for the Keychain:
      // a second dialog ("Allow" rather than "Always Allow") then comes straight
      // after the first instead of at a later click (`warmBlockingKeyStore`).
      // Main is blocked for as long as that takes; nothing can write meanwhile.
      warmedMs = store.warmBlockingKeyStore()
      // One synchronous block from here: nothing can write between reading
      // the settings as they stand and installing what the vault makes of them.
      flushSettings()
      // Untouched meanwhile, the settings ARE the file `prepare` read, so the
      // finish works on that and hydrate runs once, exactly as the blocking
      // boot did (gotcha 116: hydrate is not idempotent). Written meanwhile,
      // they are the cache — already hydrated, like after any write.
      const raw = finish(settingsWrites === writesAtStart ? undefined : getSettings())
      // Hydrated BEFORE the store is installed: a throw here must leave writes
      // going to settings.json, never to a vault `save` handed the old cache's
      // empty keys (which would read as every key deleted).
      const opened = hydrateSettings(raw)
      secrets = store
      cache = opened
    } catch (err) {
      console.error('[stoke] secret store unavailable; keys stay in settings.json', err)
      // What the vault holds stays shut this run: an empty phone key then means
      // "unread", and minting over it would lock every phone out (gotcha 53).
      // Never throws past here: the gate must settle whatever happens.
      try {
        unreadWhenOff = vaultItemPaths(app.getPath('userData'))
      } catch {
        // Not knowing what the vault holds, assume the phone's keys are in it.
        unreadWhenOff = [REMOTE_TOKEN_PATH, REMOTE_PUSH_KEY_PATH]
      }
      gate.settle('off')
      return
    }
    // Only what was measured. `took` is wall time from the start to here, and
    // `prepare`'s first await yields to the rest of whenReady (registerIpc,
    // createWindow, …), so it includes that boot work: it says when the store
    // opened, not how long the key store took (measured in a driven boot on
    // 2026-10-28: ~200 ms with no keys at all). The blocking check's own ms is exact.
    const took = Date.now() - started
    if (took > 50) {
      console.warn(
        `[stoke] the secret store opened ${took}ms after boot started it (that includes boot work done meanwhile; the window did not wait for it)` +
          (warmedMs === null ? '' : `, ${warmedMs}ms of it in the blocking key-store check on the main thread`)
      )
    }
    // Main's own readers (the account index, the status-line switch, …) see
    // the keys now, and only then is the open announced: the 'open' push
    // (index.ts) sends `getSettings()`, which must already hold them. Guarded:
    // a listener that throws must not leave every reader waiting on a gate
    // that never settles.
    const installed = cache
    for (const fn of listeners) {
      try {
        fn(installed)
      } catch (err) {
        console.error('[stoke] a settings listener failed as the secret store opened', err)
      }
    }
    gate.settle('open')
  })()
}

/** Resolves once the secret store has opened (or failed to, keys staying in settings.json). Never rejects. */
export function secretsSettled(): Promise<void> {
  return gate.settled()
}

/** Whether what `getSettings()` holds for a secret is final; false while the store is opening. */
export function secretsReadable(): boolean {
  return gate.readable()
}

/** For the renderer's notice (`CH.secretStoreState`). */
export function secretsOpenState(): SecretsOpenState {
  return gate.state(process.platform)
}

export function onSecretsOpenState(fn: (state: SecretsOpenState) => void): () => void {
  return gate.onChange(() => fn(secretsOpenState()))
}

/**
 * The known secret paths secrets.json holds that this run could not open — a
 * Deny, a locked key store, an unprotected run, a failed open — read without
 * asking the key store. Empty while the store is opening (nothing is readable
 * then anyway: `secretsReadable`). For `remoteKeyVerdict`, so a key that is
 * stored but shut is never minted over.
 */
export function secretsStoredUnread(): string[] {
  if (secrets) return secrets.stranded()
  return gate.current === 'off' ? [...unreadWhenOff] : []
}

/** Where the keys live, for Settings. Null until the store has opened (and for a run where it failed to). */
export function secretStoreStatus(): SecretStoreStatus | null {
  return secrets ? secrets.status() : null
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

/**
 * Write via a temp file + rename so a crash mid-write cannot truncate settings.
 *
 * Once the secret store is open, it does the writing: the secrets into
 * secrets.json (only when one moved), then settings.json with them emptied.
 * Still one synchronous call per coalesced write, so the coalescing below
 * (gotcha 63) governs both files.
 */
function persist(s: Settings): void {
  const target = file()
  mkdirSync(dirname(target), { recursive: true })
  if (secrets) {
    secrets.save(s)
    return
  }
  writePrivateFile(target, JSON.stringify(s, null, 2))
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
  settingsWrites++
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
