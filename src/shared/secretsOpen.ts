/*
 * Opening the secret store without holding up the window.
 *
 * The vault (main/secrets.ts) is opened through the OS key store, and on macOS
 * the first read in a run can be a Keychain password dialog. Measured on
 * 2026-10-27 on the owner's Mac, after an auto-update: main sat 18 s and then
 * 8 s inside the blocking `safeStorage.decryptString`, before any window
 * existed — no window, a beachball, and the dialog possibly behind other apps.
 * (Why it asks again after each update is the signature: a self-signed build
 * has no Team ID, so the Keychain's grant is pinned to the binary's hash.)
 *
 * So the store is opened with Electron's async calls AFTER the window is
 * created (store.ts `initSecretStore`), and the rules that make that safe live
 * here, pure, so `verify:secrets` can hold them:
 *
 * - `SecretsGate`: one open per process; nothing that reads a secret runs
 *   before it has settled (`settled()`), and nothing may treat an empty sealed
 *   field as "none" while it is opening (`readable()`).
 * - `remoteKeyVerdict`: the phone key and the Web Push pair are minted only
 *   once the store has opened. Before that an empty `remote.token` means "not
 *   read yet", and minting would lock out every paired phone (gotcha 53).
 * - `keepUnseenSecrets`: a renderer patch sent before the store opened was
 *   built from settings whose sealed keys all read `''`; those empties are
 *   not deletions.
 * - `secretsNotice`: what the window says while it waits.
 *
 * No `node:` import and no DOM: both tsconfigs compile this (gotcha 27), and
 * the renderer reads the notice and the state type.
 */
import { applySecrets, collectSecrets, secretSpecFor } from './secrets.ts'

/**
 * `closed` before main asked; `opening` while the key store is being asked;
 * `open` once the vault is read (protected or not); `off` when opening failed
 * and this run keeps its keys in settings.json, as builds before the vault
 * did. Both `open` and `off` are settled: what settings hold is final.
 */
export type SecretsPhase = 'closed' | 'opening' | 'open' | 'off'

/** What main tells the renderer (`CH.secretStoreState`). */
export interface SecretsOpenState {
  phase: SecretsPhase
  /** `process.platform` in main: the notice names the Keychain only on macOS. */
  platform: string
  /** How long the open had been waiting when this was sent, by main's clock; 0 unless opening. */
  waitedMs: number
}

/**
 * The open's lifecycle, as a small state machine with no I/O.
 *
 * `claim` is the one way in, taken synchronously before the first await
 * (gotcha 20), so a second caller — `activate`, a second window — shares the
 * first open instead of starting another. `settle` is the one way out, and
 * only from `opening`. A waiter added at any point before `settle` resolves
 * only after it; one added after resolves at once.
 */
export class SecretsGate {
  private phase: SecretsPhase
  private startedAt: number
  private readonly now: () => number
  private readonly waiters: Array<() => void>
  private readonly listeners: Set<(phase: SecretsPhase) => void>

  constructor(now: () => number = Date.now) {
    this.phase = 'closed'
    this.startedAt = 0
    this.now = now
    this.waiters = []
    this.listeners = new Set()
  }

  get current(): SecretsPhase {
    return this.phase
  }

  /** True for exactly one caller: the one that must open the store. */
  claim(): boolean {
    if (this.phase !== 'closed') return false
    this.phase = 'opening'
    this.startedAt = this.now()
    this.emit()
    return true
  }

  /** The open's outcome. Ignored unless the store is opening, so a late or second settle changes nothing. */
  settle(outcome: 'open' | 'off'): boolean {
    if (this.phase !== 'opening') return false
    this.phase = outcome
    for (const resolve of this.waiters.splice(0)) resolve()
    this.emit()
    return true
  }

  /**
   * Whether what settings hold for a secret is final. Never while closed or
   * opening: an empty sealed field then means "not read yet", not "none".
   */
  readable(): boolean {
    return this.phase === 'open' || this.phase === 'off'
  }

  /** Resolves once the open has settled. Never rejects: a failed open is settled too (`off`). */
  settled(): Promise<void> {
    if (this.readable()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  waitedMs(): number {
    return this.phase === 'opening' ? Math.max(0, this.now() - this.startedAt) : 0
  }

  state(platform: string): SecretsOpenState {
    return { phase: this.phase, platform, waitedMs: this.waitedMs() }
  }

  onChange(fn: (phase: SecretsPhase) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.phase)
      } catch {
        // A listener's failure is its own; the open goes on.
      }
    }
  }
}

/** The two sealed fields a phone depends on (shared/secrets.ts `SECRET_PATHS`). */
export const REMOTE_TOKEN_PATH = 'remote.token'
export const REMOTE_PUSH_KEY_PATH = 'remote.push.vapidPrivate'

/**
 * What `ensureRemoteToken` may do with the phone key and the Web Push pair.
 *
 * `wait` whenever the store is not readable: the fields read `''` then
 * because the vault has not been opened, and a key minted over that would
 * replace the one every paired phone holds, and a new VAPID pair would retire
 * every push subscription (gotcha 53).
 *
 * `stranded` once readable when what is missing is STORED but could not be
 * opened this run (`unread`: the vault's items a Deny, a locked key store or a
 * failed open left shut — store.ts `secretsStoredUnread`). It reads `''` all
 * the same, and a key minted over it is worse than one minted while opening:
 * unprotected, the new key goes to settings.json in plain text and the next
 * boot's migration (plaintext wins) replaces the vault's; protected, `save`
 * drops the stranded copy at once. Either way every paired phone is locked out
 * for good. Only an explicit New key replaces them (`remoteNewToken`).
 *
 * `mint` only once readable and one of the two is genuinely missing.
 */
export function remoteKeyVerdict(
  readable: boolean,
  token: string,
  pushWhole: boolean,
  unread: readonly string[]
): 'keep' | 'mint' | 'wait' | 'stranded' {
  if (!readable) return 'wait'
  if (token && pushWhole) return 'keep'
  const tokenStored = !token && unread.includes(REMOTE_TOKEN_PATH)
  const pushStored = !pushWhole && unread.includes(REMOTE_PUSH_KEY_PATH)
  return tokenStored || pushStored ? 'stranded' : 'mint'
}

/**
 * A settings patch from a renderer that could only have built it from a copy
 * taken before the store opened: every key `current` holds that the patch
 * would replace without having seen is put back.
 *
 * A panel spreads its whole copy of an object (`{ voice: { ...voice, provider } }`),
 * and `setSettings` replaces each top-level object a patch carries. A copy from
 * before the open holds `''` for every sealed key in it — or no entry at all
 * where hydrate drops an empty one (`voice.keys`) — so applying it after the
 * open would read as "every key in this object was deleted". A non-empty value
 * is kept: it was typed, and the newer write wins, as plaintext does over the
 * vault (secrets.ts `load`). Nothing is added to an object the patch does not
 * carry (it does not replace that one), and a key never brings back the entry
 * it belongs to — an account, an endpoint, an MCP server — when the patch has
 * dropped it.
 */
export function keepUnseenSecrets<T extends object>(patch: T, current: unknown): T {
  const held = collectSecrets(current)
  const typed = collectSecrets(patch)
  const restore: Record<string, string> = {}
  for (const [path, value] of Object.entries(held)) {
    const spec = secretSpecFor(path)
    if (!spec || path in typed || !patchCarries(patch, path, spec.pattern)) continue
    restore[path] = value
  }
  return Object.keys(restore).length ? (applySecrets(patch, restore) as unknown as T) : patch
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Whether applying `patch` would replace what holds `path`: its top-level
 * object is in the patch, and so is every map entry (a `*` above the leaf) on
 * the way down. A fixed object missing below the top is replaced too — the
 * merge is whole — so the key is put back there.
 */
function patchCarries(patch: unknown, path: string, pattern: string): boolean {
  const parts = path.split('.')
  const pat = pattern.split('.')
  let node: unknown = patch
  for (let i = 0; i < parts.length - 1; i++) {
    const next = isRecord(node) && Object.prototype.hasOwnProperty.call(node, parts[i]) ? node[parts[i]] : undefined
    if (isRecord(next)) {
      node = next
      continue
    }
    return i > 0 && !pat.slice(i, parts.length - 1).includes('*')
  }
  return true
}

/** macOS: long enough that a Keychain that answers at once (tens of ms) never flashes a notice. */
export const KEYCHAIN_NOTICE_AFTER_MS = 400
/** Elsewhere nothing prompts, so only a genuinely slow open says anything. */
export const KEYS_NOTICE_AFTER_MS = 1000

export interface SecretsNotice {
  /** How much longer to wait before showing it, already net of `waitedMs`. */
  afterMs: number
  title: string
  description?: string
}

/** The notice for a state, or null when there is nothing to wait for. */
export function secretsNotice(state: SecretsOpenState): SecretsNotice | null {
  if (state.phase !== 'opening') return null
  const waited = Number.isFinite(state.waitedMs) ? Math.max(0, state.waitedMs) : 0
  if (state.platform === 'darwin') {
    return {
      afterMs: Math.max(0, KEYCHAIN_NOTICE_AFTER_MS - waited),
      title: 'Waiting for macOS Keychain',
      description: 'If a password dialog is open (it can be behind other windows), choose Always Allow.'
    }
  }
  return { afterMs: Math.max(0, KEYS_NOTICE_AFTER_MS - waited), title: 'Opening your saved keys…' }
}
