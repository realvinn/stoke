/*
 * Secrets at rest: `<userData>/secrets.json`, sealed by Electron `safeStorage`,
 * with settings.json keeping an empty string in each secret's place.
 *
 * `store.ts` owns WHEN settings are written (coalescing, gotcha 63); this owns
 * WHAT is written where. Every write of settings goes through `save`, which
 * seals the secrets into secrets.json first and then writes settings.json with
 * them emptied; `prepare` does the reverse at boot without blocking the main
 * thread (`load` is its blocking form), plus the one-time migration of a
 * settings.json that still holds plaintext.
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
  /**
   * The key store's non-blocking twins (Electron's `isAsyncEncryptionAvailable`
   * and `decryptStringAsync`), which the boot open uses (`prepare`). On macOS
   * the blocking pair waits on the main thread for a Keychain password dialog
   * — measured 18 s and 8 s before any window existed — while these wait off
   * it. Optional: a backend without them is opened with the blocking calls, as
   * every build before this one did.
   */
  isEncryptionAvailableAsync?(): Promise<boolean>
  decryptAsync?(sealed: Buffer): Promise<string>
}

/** Structural, so this file never imports `electron`. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(sealed: Buffer): string
  getSelectedStorageBackend?: () => string
  isAsyncEncryptionAvailable?: () => Promise<boolean>
  decryptStringAsync?: (sealed: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

export function safeStorageBackend(ss: SafeStorageLike, platform: string): SecretBackend {
  const backend: SecretBackend = {
    isEncryptionAvailable: () => ss.isEncryptionAvailable(),
    selectedBackend: () =>
      platform === 'linux' && typeof ss.getSelectedStorageBackend === 'function' ? ss.getSelectedStorageBackend() : null,
    encrypt: (plain) => ss.encryptString(plain),
    decrypt: (sealed) => ss.decryptString(sealed)
  }
  /*
   * Opening only. Electron documents that `decryptStringAsync` opens what
   * `encryptString` sealed; sealing stays on `encryptString`, so what is
   * written — and what an older build can open — does not change.
   * `shouldReEncrypt` is not acted on for the same reason: re-sealing with the
   * async encryptor is a change of format nobody has proven an older build
   * reads. (Measured under --use-mock-keychain on macOS, Electron 43.2: both
   * write `v10`, the same length, and each opens the other's.)
   */
  const available = ss.isAsyncEncryptionAvailable
  const decrypt = ss.decryptStringAsync
  if (typeof available === 'function' && typeof decrypt === 'function') {
    backend.isEncryptionAvailableAsync = () => available.call(ss)
    backend.decryptAsync = async (sealed) => (await decrypt.call(ss, sealed)).result
  }
  return backend
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

/** What a boot reads before it may need the key store. */
interface BootRead {
  raw: unknown
  items: Record<string, string>
  tmp: string
  tmpExists: boolean
}

/**
 * The known secret paths `<dir>/secrets.json` holds, read without asking the
 * key store: for a run whose open FAILED (store.ts), whose settings never got
 * the vault's keys, so an empty sealed field there is "stored but unread", not
 * "none" (`remoteKeyVerdict`). Never throws; an unreadable file holds nothing.
 */
export function vaultItemPaths(dir: string): string[] {
  try {
    const items = parseSecretsFile(readText(join(dir, SECRETS_FILE_NAME)) ?? '')?.items ?? {}
    return Object.keys(items).filter((k) => secretSpecFor(k))
  } catch {
    return []
  }
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
  /** Set when `prepare` had to open the vault the blocking way (`decideAsync`). */
  private openBlocking: boolean

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
    this.openBlocking = false
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

  /** The two small files a boot reads before it may need the key store. */
  private readBoot(): BootRead {
    const tmp = `${this.settingsFile}.tmp`
    return {
      raw: readJson(this.settingsFile),
      items: parseSecretsFile(readText(this.secretsFile) ?? '')?.items ?? {},
      tmp,
      tmpExists: fileExists(tmp)
    }
  }

  /** Nothing secret anywhere, so the key store need not be asked. */
  private nothingToOpen(boot: BootRead): boolean {
    return Object.keys(boot.items).length === 0 && Object.keys(collectSecrets(boot.raw)).length === 0
  }

  /** An unprotected run: anything in secrets.json is carried, unread, for a run that can open it. */
  private keepUnopened(items: Record<string, string>): void {
    this.kept = { ...items }
    this.strandedPaths = Object.keys(items).filter((k) => secretSpecFor(k))
  }

  /** One item's outcome: opened (`value`), or kept verbatim and, if it is a known path, stranded. */
  private take(path: string, b64: string, value: string | null): void {
    if (value === null) {
      this.kept[path] = b64
      if (secretSpecFor(path)) this.strandedPaths.push(path)
    } else {
      this.values[path] = value
      this.sealed[path] = b64
    }
  }

  /**
   * Boot: read settings.json and secrets.json, migrate any plaintext secret,
   * and return the settings object to hydrate — secrets overlaid. Synchronous
   * and small (two files in userData), like the settings read it replaces; the
   * key store is consulted only when there is something to open or seal.
   *
   * The BLOCKING form: on macOS its first key-store call can wait on the main
   * thread for a Keychain password dialog. The app opens with `prepare`; this
   * stays for a backend with no async calls, and is the same decisions in the
   * same order, which is what lets `verify:secrets` hold both to one result.
   */
  load(): unknown {
    const boot = this.readBoot()
    if (this.nothingToOpen(boot)) {
      // Nothing secret anywhere, so the key store is not asked. A temp file is
      // a crash's leftover that never became settings.json; it may still hold
      // a key typed before a migration, and nothing ever reads it.
      if (boot.tmpExists) removeQuietly(boot.tmp)
      return boot.raw
    }
    const p = this.decide()
    if (!p.protected) {
      // Today's behaviour, exactly: settings.json holds the keys.
      this.keepUnopened(boot.items)
      return boot.raw
    }
    for (const [path, b64] of Object.entries(boot.items)) this.take(path, b64, secretSpecFor(path) ? this.open(path, b64) : null)
    return this.finishOpen(boot.raw, boot)
  }

  /**
   * `load` without blocking the main thread: the same reads, decisions and
   * migration, with the key store asked through its async calls. The two files
   * are read now, synchronously, as `load` reads them; the key store is asked
   * only when there is something to open or seal, exactly as there.
   *
   * Resolves with the step that FINISHES the open, to be called synchronously
   * by the owner with the settings as they stand at that moment (`current`;
   * omitted, the file read here — nothing wrote meanwhile):
   * the window is up while this waits — for a Keychain dialog, maybe for
   * seconds — and settings written meanwhile are in `current`, not on the disk
   * this read. A sealed key reads `''` there, which is "not opened yet", and
   * the vault's value goes over it; a non-empty value is newer than the vault
   * and wins, as plaintext always has (and is sealed here, the migration).
   * Handing back a step rather than the result is what lets the owner read
   * `current` and install the result in one synchronous block, with no await
   * between for another write to land in.
   */
  async prepare(): Promise<(current?: unknown) => unknown> {
    const boot = this.readBoot()
    if (this.nothingToOpen(boot)) {
      return (current = boot.raw) => {
        if (boot.tmpExists) removeQuietly(boot.tmp)
        return current
      }
    }
    const p = await this.decideAsync()
    if (!p.protected) {
      this.keepUnopened(boot.items)
      return (current = boot.raw) => current
    }
    const entries = Object.entries(boot.items)
    const opened = await Promise.all(entries.map(([path, b64]) => (secretSpecFor(path) ? this.openAsync(path, b64) : Promise.resolve(null))))
    entries.forEach(([path, b64], i) => this.take(path, b64, opened[i]))
    return (current = boot.raw) => this.finishOpen(current, boot)
  }

  /** `decide`, through the key store's async availability check where it has one. */
  private async decideAsync(): Promise<SecretProtection> {
    if (this.protection) return this.protection
    const ask = this.backend.isEncryptionAvailableAsync
    if (!ask || !this.backend.decryptAsync) {
      this.openBlocking = true
      return this.decide()
    }
    let available = false
    try {
      available = await ask.call(this.backend)
    } catch {
      available = false
    }
    /*
     * Off macOS a refusal here is asked again the blocking way, which never
     * shows a dialog there (DPAPI) or did not before this build (libsecret):
     * should a platform's async key provider be the one that is missing, the
     * keys still open, exactly as they did with `load`. Never on macOS, where
     * the blocking call is the main-thread Keychain dialog this path exists to
     * avoid — and, after a Deny, a second one. That holds for Stoke's own calls
     * only: whether Chromium's async encryptor itself falls back to the
     * blocking fetch, on the main thread, once its Keychain provider has been
     * refused is unproven (it needs a real Keychain and a Deny, with the main
     * thread sampled meanwhile).
     */
    if (!available && this.platform !== 'darwin') {
      this.openBlocking = true
      try {
        available = this.backend.isEncryptionAvailable()
      } catch {
        available = false
      }
    }
    let linux: string | null = null
    try {
      linux = this.backend.selectedBackend()
    } catch {
      linux = null
    }
    this.protection ??= judgeProtection(this.platform, available, linux)
    return this.protection
  }

  /**
   * macOS only: after an async open that opened at least one item, ask the
   * BLOCKING key store once, so the rest of the run's blocking calls answer
   * from its cache. Returns how long that took, or null when it was not asked.
   *
   * Electron 43 links two separate key fetches with separate caches: the async
   * encryptor (`KeychainKeyProvider`, which `prepare` uses) and OSCrypt's
   * blocking one (`encryptString`/`decryptString`/`isEncryptionAvailable`),
   * which `save`, the migration, the hub (hub/files.ts), account sync and the
   * plugins' credentials still use. The blocking open this replaced warmed the
   * second as a side effect; the async open does not. With "Always Allow" the
   * Keychain now lists Stoke and this returns in milliseconds. With "Allow" the
   * blocking fetch can ask again, on the main thread — and this way that second
   * dialog comes straight after the first, while the window still says it is
   * waiting for the Keychain, instead of at some later click (the hub's start,
   * the first key saved). Both caches and the dialog count are reasoned from
   * the shipped framework, not measured: --use-mock-keychain shows neither.
   *
   * Never after a refusal (nothing opened: a Deny is final for the run, and
   * this would be the dialog again), never for a profile with no keys (which
   * never touches the Keychain), never when the open was blocking already
   * (`openBlocking`), and never off macOS, where nothing prompts.
   */
  warmBlockingKeyStore(): number | null {
    if (this.platform !== 'darwin' || this.openBlocking || !this.protection?.protected) return null
    if (Object.keys(this.values).length === 0) return null
    const started = Date.now()
    try {
      this.backend.isEncryptionAvailable()
    } catch {
      // Its answer is not used: the async open has decided this run already.
    }
    return Date.now() - started
  }

  /**
   * The known items secrets.json holds that this run could not open, WITHOUT
   * asking the key store (`status()` would, to decide). What reads '' at one of
   * these paths is stored but unreadable, never "none" (`remoteKeyVerdict`).
   */
  stranded(): string[] {
    return [...this.strandedPaths]
  }

  /** `open`, through the async decrypt. Off macOS a refusal is tried once the blocking way (see `decideAsync`). */
  private async openAsync(path: string, b64: string): Promise<string | null> {
    const decrypt = this.backend.decryptAsync
    if (this.openBlocking || !decrypt) return this.open(path, b64)
    try {
      return unsealedValue(path, await decrypt.call(this.backend, Buffer.from(b64, 'base64')))
    } catch {
      return this.platform === 'darwin' ? null : this.open(path, b64)
    }
  }

  /**
   * The rest of a protected boot, once every item has been opened or kept:
   * migrate any plaintext in `raw` into the vault, then return `raw` with the
   * vault's keys overlaid. Synchronous; seals with the blocking `encrypt`
   * only when there is plaintext to migrate.
   */
  private finishOpen(raw: unknown, boot: BootRead): unknown {
    const items = boot.items
    const plain = collectSecrets(raw)
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
    if (boot.tmpExists) removeQuietly(boot.tmp)
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
