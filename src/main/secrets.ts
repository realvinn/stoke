/*
 * Secrets at rest: `<userData>/secrets.json`, sealed by Electron `safeStorage`,
 * with settings.json keeping an empty string in each secret's place.
 *
 * `store.ts` owns WHEN settings are written (coalescing, gotcha 63); this owns
 * WHAT is written where. Every write of settings goes through `save`, which
 * seals the secrets into secrets.json first and then writes settings.json with
 * them emptied; `load` does the reverse at boot, plus the one-time migration of
 * a settings.json that still holds plaintext.
 *
 * No `electron` import, on purpose: `scripts/verify-secrets.mts` drives this
 * whole file against a synthetic userData and an injected backend (gotcha 74:
 * fake every input — the directory as well as the key store), so the real
 * Keychain is never touched by a suite. `safeStorageBackend` adapts the real
 * `safeStorage`, which `store.ts` passes in.
 *
 * Downgrade: a build from before this one reads settings.json only, so after
 * the migration it sees every key as empty — sessions in API-key mode refuse
 * to start ("Anthropic API key is empty") and Phone access mints a new key.
 * Nothing is lost: secrets.json is untouched by the older build, and a key
 * typed into the older build lands in settings.json as plaintext, which the
 * next boot of this build migrates in (plaintext wins, being the newer write).
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applySecrets,
  collectSecrets,
  judgeProtection,
  parseSecretsFile,
  scrubSecrets,
  sealedText,
  secretSpecFor,
  serializeSecretsFile,
  SECRETS_FILE_NAME,
  unsealedValue,
  type SecretProtection,
  type SecretStoreStatus
} from '../shared/secrets.ts'

export type { SecretStoreStatus }

/** What Stoke needs from a key store. `safeStorage`'s shape, minus the parts it does not use. */
export interface SecretBackend {
  /** Only meaningful after the app is ready. */
  isEncryptionAvailable(): boolean
  /** Linux's `getSelectedStorageBackend()`; null on every other platform. */
  selectedBackend(): string | null
  encrypt(plain: string): Buffer
  /** Throws when the item was sealed by another key. */
  decrypt(sealed: Buffer): string
}

/** Structural, so this file never imports `electron`. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(sealed: Buffer): string
  getSelectedStorageBackend?: () => string
}

export function safeStorageBackend(ss: SafeStorageLike, platform: string): SecretBackend {
  return {
    isEncryptionAvailable: () => ss.isEncryptionAvailable(),
    selectedBackend: () =>
      platform === 'linux' && typeof ss.getSelectedStorageBackend === 'function' ? ss.getSelectedStorageBackend() : null,
    encrypt: (plain) => ss.encryptString(plain),
    decrypt: (sealed) => ss.decryptString(sealed)
  }
}


/** Written 0600 via temp + rename, like settings.json always was, so a crash cannot truncate it. */
export function writePrivateFile(file: string, text: string): void {
  const tmp = `${file}.tmp`
  // A leftover temp from a crash may be 0644 and holding plaintext; start clean.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readJson(file: string): unknown {
  const text = readText(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Best effort. A stale temp that cannot be removed is no reason to fail the
 * boot: the store would then stay off and this run would see no keys at all.
 */
function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch (err) {
    console.error(`[stoke] could not remove ${file}`, err)
  }
}

function fileExists(file: string): boolean {
  return readText(file) !== null
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k])
}

export class SecretStore {
  readonly dir: string
  private readonly backend: SecretBackend
  private readonly platform: string
  /** Null until the key store has been asked (`decide`). */
  private protection: SecretProtection | null
  /** path -> value, as last written to (or read from) secrets.json. */
  private values: Record<string, string>
  /** path -> base64 ciphertext of `values[path]`. */
  private sealed: Record<string, string>
  /** Items carried verbatim: stranded (would not open) or foreign (a newer build's path). */
  private kept: Record<string, string>
  private strandedPaths: string[]
  /** Set while secrets.json is behind the settings because its last write failed. */
  private vaultWriteError: string | null

  constructor(dir: string, backend: SecretBackend, platform: string) {
    this.dir = dir
    this.backend = backend
    this.platform = platform
    this.protection = null
    this.values = {}
    this.sealed = {}
    this.kept = {}
    this.strandedPaths = []
    this.vaultWriteError = null
  }

  get settingsFile(): string {
    return join(this.dir, 'settings.json')
  }

  get secretsFile(): string {
    return join(this.dir, SECRETS_FILE_NAME)
  }

  /**
   * Ask the key store, once. Deferred until there is a secret to seal or open,
   * so a profile with no keys never touches the Keychain — on an unsigned dev
   * build that touch is a password prompt.
   */
  private decide(): SecretProtection {
    if (this.protection) return this.protection
    let available = false
    try {
      available = this.backend.isEncryptionAvailable()
    } catch {
      available = false
    }
    let linux: string | null = null
    try {
      linux = this.backend.selectedBackend()
    } catch {
      linux = null
    }
    this.protection = judgeProtection(this.platform, available, linux)
    return this.protection
  }

  private seal(path: string, value: string): string {
    return this.backend.encrypt(sealedText(path, value)).toString('base64')
  }

  private open(path: string, b64: string): string | null {
    try {
      return unsealedValue(path, this.backend.decrypt(Buffer.from(b64, 'base64')))
    } catch {
      return null
    }
  }

  /** Remember that the key store refused, and keep going in plaintext rather than lose a key. */
  private demote(why: string): void {
    const was = this.protection ?? this.decide()
    this.protection = { protected: false, backend: was.backend, why }
  }

  private writeVault(kept: Record<string, string> = this.kept, sealed: Record<string, string> = this.sealed): void {
    writePrivateFile(this.secretsFile, serializeSecretsFile(this.decide().backend, { ...kept, ...sealed }))
  }

  /**
   * Boot: read settings.json and secrets.json, migrate any plaintext secret,
   * and return the settings object to hydrate — secrets overlaid. Synchronous
   * and small (two files in userData), like the settings read it replaces; the
   * key store is consulted only when there is something to open or seal.
   */
  load(): unknown {
    const raw = readJson(this.settingsFile)
    const file = parseSecretsFile(readText(this.secretsFile) ?? '')
    const plain = collectSecrets(raw)
    const tmp = `${this.settingsFile}.tmp`
    const tmpExists = fileExists(tmp)
    const items = file?.items ?? {}
    if (Object.keys(items).length === 0 && Object.keys(plain).length === 0) {
      // Nothing secret anywhere, so the key store is not asked. A temp file is
      // a crash's leftover that never became settings.json; it may still hold
      // a key typed before a migration, and nothing ever reads it.
      if (tmpExists) removeQuietly(tmp)
      return raw
    }

    const p = this.decide()
    if (!p.protected) {
      // Today's behaviour, exactly: settings.json holds the keys. Anything in
      // secrets.json is carried, unread, for a run that can open it.
      this.kept = { ...items }
      this.strandedPaths = Object.keys(items).filter((k) => secretSpecFor(k))
      return raw
    }

    for (const [path, b64] of Object.entries(items)) {
      const value = secretSpecFor(path) ? this.open(path, b64) : null
      if (value === null) {
        this.kept[path] = b64
        if (secretSpecFor(path)) this.strandedPaths.push(path)
      } else {
        this.values[path] = value
        this.sealed[path] = b64
      }
    }

    const needsMigration = Object.keys(plain).length > 0
    if (needsMigration) {
      const fromVault = { ...this.values }
      // Plaintext wins: it is either a key typed into an older build after a
      // downgrade, or a hand edit — both newer than what the vault holds.
      try {
        for (const [path, value] of Object.entries(plain)) {
          if (this.values[path] !== value || !this.sealed[path]) this.sealed[path] = this.seal(path, value)
          this.values[path] = value
          delete this.kept[path]
          this.strandedPaths = this.strandedPaths.filter((s) => s !== path)
        }
        this.writeVault()
        // Read it back and open every item before the plaintext goes: the
        // scrub below is the one step that cannot be undone.
        const check = parseSecretsFile(readText(this.secretsFile) ?? '')
        const ok =
          !!check && Object.entries(this.values).every(([path, v]) => check.items[path] && this.open(path, check.items[path]) === v)
        if (!ok) throw new Error('secrets.json did not read back')
      } catch (err) {
        this.demote(
          `The key store would not seal keys on this run (${err instanceof Error ? err.message : String(err)}), so they stay in settings.json in plain text.`
        )
        // settings.json was not touched, so the plaintext is still there and
        // wins at the next protected boot whatever secrets.json now holds.
        // What already opened is still used this run, under the plaintext,
        // and the next write puts it in settings.json too.
        for (const path of Object.keys(plain)) delete fromVault[path]
        this.values = {}
        this.sealed = {}
        this.kept = { ...items }
        this.strandedPaths = []
        return applySecrets(raw, fromVault)
      }
      writePrivateFile(this.settingsFile, JSON.stringify(scrubSecrets(raw), null, 2))
    }
    // A temp left by a crash mid-write can hold the plaintext the scrub just removed.
    if (tmpExists) removeQuietly(tmp)
    return applySecrets(needsMigration ? scrubSecrets(raw) : raw, this.values)
  }

  /**
   * Write settings: the secrets into secrets.json (only when they moved), then
   * settings.json with them emptied. Called for every coalesced settings write,
   * so an unchanged key is never re-sealed.
   *
   * "Only when they moved" compares against `values`, which is what secrets.json
   * holds ON DISK — so nothing is committed to it until the vault write has
   * returned. It used to be assigned first: one failed write (ENOSPC, or an
   * EPERM/EBUSY rename on Windows while antivirus holds the file) left `values`
   * claiming the new key was stored, every later save skipped the vault as
   * unchanged, settings.json went on being scrubbed, and the next boot brought
   * back the old key or none.
   */
  save(settings: object): void {
    const secrets = collectSecrets(settings)
    const nothingSecret =
      Object.keys(secrets).length === 0 && Object.keys(this.values).length === 0 && Object.keys(this.kept).length === 0
    if (!this.protection && nothingSecret) {
      writePrivateFile(this.settingsFile, JSON.stringify(settings, null, 2))
      return
    }
    const p = this.decide()
    if (!p.protected) {
      writePrivateFile(this.settingsFile, JSON.stringify(settings, null, 2))
      return
    }
    if (!sameMap(secrets, this.values)) {
      const sealed: Record<string, string> = {}
      try {
        for (const [path, value] of Object.entries(secrets)) {
          sealed[path] = this.values[path] === value && this.sealed[path] ? this.sealed[path] : this.seal(path, value)
        }
      } catch (err) {
        // Never lose a key the user just typed: this write, and every later
        // one this run, goes to settings.json as before.
        this.demote(
          `The key store refused to seal a key (${err instanceof Error ? err.message : String(err)}), so keys are in settings.json in plain text until Stoke restarts.`
        )
        writePrivateFile(this.settingsFile, JSON.stringify(settings, null, 2))
        return
      }
      // A key typed again replaces its stranded copy.
      const kept = { ...this.kept }
      for (const path of Object.keys(secrets)) delete kept[path]
      try {
        this.writeVault(kept, sealed)
      } catch (err) {
        // Nothing is committed, so the next save still finds the vault behind
        // and writes it again. Until one lands, a key the vault does not yet
        // hold stays in settings.json in plain text rather than nowhere: a boot
        // in between migrates it in (plaintext wins, as the newer write). Keys
        // the vault already holds stay scrubbed. A key CLEARED meanwhile cannot
        // be written anywhere and comes back if no later write succeeds — the
        // safe direction.
        // Node's fs messages run on into both full paths after the first comma;
        // Settings shows only the reason ("EBUSY: resource busy or locked").
        this.vaultWriteError = (err instanceof Error ? err.message : String(err)).split(',')[0]
        console.error('[stoke] could not write secrets.json; the changed keys stay in settings.json until it can', err)
        const unsaved: Record<string, string> = {}
        for (const [path, value] of Object.entries(secrets)) if (this.values[path] !== value) unsaved[path] = value
        writePrivateFile(this.settingsFile, JSON.stringify(applySecrets(scrubSecrets(settings), unsaved), null, 2))
        return
      }
      this.kept = kept
      this.strandedPaths = this.strandedPaths.filter((s) => !(s in secrets))
      this.values = { ...secrets }
      this.sealed = sealed
    }
    this.vaultWriteError = null
    writePrivateFile(this.settingsFile, JSON.stringify(scrubSecrets(settings), null, 2))
  }

  /** For Settings. Asks the key store if nothing has yet — the section was opened on purpose. */
  status(): SecretStoreStatus {
    const p = this.decide()
    const held = Object.keys(this.values)
    return {
      decided: true,
      protected: p.protected,
      backend: p.backend,
      why: p.why,
      location: p.protected ? (held.length ? 'secrets.json' : 'none') : 'settings.json',
      held: p.protected ? held : [],
      stranded: [...this.strandedPaths],
      vaultWriteError: p.protected ? this.vaultWriteError : null
    }
  }
}
