/*
 * Which settings are secrets, and the on-disk shape of the file that holds them.
 *
 * Through 0.9.97 every API key Stoke held — and the phone access key, a bearer
 * that grants a SHELL on this machine — sat in plain text in
 * `<userData>/settings.json`, mode 0644. `secrets.json` beside it now holds
 * them, each value sealed by Electron `safeStorage` (the macOS Keychain,
 * Windows DPAPI, or libsecret/KWallet on Linux), and settings.json keeps an
 * empty string in each place. `src/main/secrets.ts` does the sealing and the
 * one-time migration; this module is the part that needs no key: the registry
 * of secret paths and the functions that move values between a settings object
 * and a flat `{ path: value }` map.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import and nothing that
 * only a browser has (gotcha 27). `scripts/verify-secrets.mts` loads it under
 * strip-types, so a shared import here must be relative with `.ts` (gotcha 78).
 */

import { STT_PROVIDERS, STT_PROVIDER_IDS } from './speechProviders.ts'

/* ------------------------------------------------------------- registry */

/** `openai` → `OpenAI`, from the one provider table. */
function sttProviderNames(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of STT_PROVIDER_IDS) out[id] = STT_PROVIDERS[id].name
  return out
}

/**
 * One kind of secret in `Settings`.
 *
 * `pattern` is a dotted path; `*` stands for any ONE key of an object, which
 * is how a per-agent key is named without listing every agent.
 */
export interface SecretPathSpec {
  pattern: string
  /** What the user calls it, for status lines and the import preview. */
  label: string
  /**
   * Travels in a `.stoke-setup` export when the user ticks "include keys".
   *
   * False for the phone access key: it authorises a shell on THIS machine,
   * and a copy on a second one would be a second device holding the same
   * door key, which nothing would ever revoke (auth-hub design §8, tier T0).
   */
  portable: boolean
  /**
   * What a `*` segment is called in a sentence, where capitalising the key
   * would misspell it (`openai` is "OpenAI", not "Openai"). Optional: a
   * segment not named here is capitalised, as agent ids always were.
   */
  names?: Readonly<Record<string, string>>
}

/**
 * THE list. A later feature that stores a secret — a speech-to-text key, a
 * per-account API key — adds a line here and gets encryption at rest, the
 * one-time migration, the scrub of settings.json and the export tick for free;
 * no other code names these paths.
 *
 * `verify:secrets` holds every entry to a path that exists in DEFAULT_SETTINGS
 * (a pattern that matches nothing encrypts nothing, silently).
 */
export const SECRET_PATHS: readonly SecretPathSpec[] = [
  { pattern: 'providers.anthropicApiKey', label: 'Anthropic API key', portable: true },
  { pattern: 'providers.openrouterApiKey', label: 'OpenRouter API key', portable: true },
  { pattern: 'providers.customAuthToken', label: 'Custom gateway token', portable: true },
  { pattern: 'agents.endpoints.*.apiKey', label: 'endpoint key', portable: true },
  /*
   * A speech-to-text key per provider (Settings → Voice). Portable like the
   * other API keys: it bills the account it belongs to, not this machine.
   */
  { pattern: 'voice.keys.*', label: 'speech-to-text key', portable: true, names: sttProviderNames() },
  { pattern: 'remote.token', label: 'Phone access key', portable: false }
]

/**
 * Keys a path segment may never be, anywhere in this module.
 *
 * `applySecrets` creates the objects on its way down a path, and a `*` segment
 * is filled from DATA — a secrets.json item or an imported setup file. Written
 * as `agents.endpoints.__proto__.apiKey`, a naive walk would reach
 * `Object.prototype` and set `apiKey` on every object in the process.
 */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

function segmentsOf(path: string): string[] | null {
  const parts = path.split('.')
  if (parts.some((p) => p === '' || UNSAFE_SEGMENTS.has(p))) return null
  return parts
}

/** The registered spec a CONCRETE path belongs to, or null. */
export function secretSpecFor(path: string, specs: readonly SecretPathSpec[] = SECRET_PATHS): SecretPathSpec | null {
  const parts = segmentsOf(path)
  if (!parts) return null
  for (const spec of specs) {
    const pat = spec.pattern.split('.')
    if (pat.length !== parts.length) continue
    if (pat.every((seg, i) => seg === '*' || seg === parts[i])) return spec
  }
  return null
}

export function isSecretPath(path: string, specs: readonly SecretPathSpec[] = SECRET_PATHS): boolean {
  return secretSpecFor(path, specs) !== null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Every concrete path in `obj` that a spec names and that holds a string —
 * empty or not. A `*` expands over the object's own keys, skipping any key
 * that could not round-trip through a dotted path.
 */
export function secretPathsIn(obj: unknown, specs: readonly SecretPathSpec[] = SECRET_PATHS): string[] {
  const out: string[] = []
  const walk = (node: unknown, pat: string[], at: string[]): void => {
    if (pat.length === 0) {
      if (typeof node === 'string') out.push(at.join('.'))
      return
    }
    if (!isRecord(node)) return
    const [head, ...rest] = pat
    const keys = head === '*' ? Object.keys(node) : [head]
    for (const k of keys) {
      if (k.includes('.') || UNSAFE_SEGMENTS.has(k) || !Object.prototype.hasOwnProperty.call(node, k)) continue
      walk(node[k], rest, [...at, k])
    }
  }
  for (const spec of specs) walk(obj, spec.pattern.split('.'), [])
  return out
}

function readPath(obj: unknown, path: string): unknown {
  let node: unknown = obj
  for (const seg of path.split('.')) {
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, seg)) return undefined
    node = node[seg]
  }
  return node
}

/**
 * The non-empty secret values in `obj`, as `{ path: value }`.
 *
 * Whitespace-only counts as empty — `hydrateProviders` trims every key, so a
 * value of spaces is not a key anyone could use.
 */
export function collectSecrets(
  obj: unknown,
  specs: readonly SecretPathSpec[] = SECRET_PATHS
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of secretPathsIn(obj, specs)) {
    const v = readPath(obj, path)
    if (typeof v === 'string' && v.trim() !== '') out[path] = v
  }
  return out
}

/** A deep copy of a JSON value. Settings are JSON by construction. */
function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/**
 * A deep copy of `obj` with every secret path set to `''`.
 *
 * The empty string rather than a deleted key, so an older build — which reads
 * these fields and knows nothing of secrets.json — sees "no key" rather than a
 * missing field, and every hydrate keeps its shape.
 */
export function scrubSecrets<T>(obj: T, specs: readonly SecretPathSpec[] = SECRET_PATHS): T {
  const copy = cloneJson(obj)
  for (const path of secretPathsIn(copy, specs)) {
    const parts = path.split('.')
    let node = copy as unknown as Record<string, unknown>
    for (const seg of parts.slice(0, -1)) node = node[seg] as Record<string, unknown>
    node[parts[parts.length - 1]] = ''
  }
  return copy
}

/**
 * A deep copy of `raw` with each value in `secrets` written at its path.
 *
 * Only paths a spec names are written — an item from a newer build's registry
 * or from a crafted file is not a licence to write anywhere in Settings — and
 * a path through `__proto__` is refused outright. Missing objects on the way
 * down are created, so a key whose endpoint entry was dropped (hydrate drops
 * an all-default endpoint) still lands; `hydrateSettings` repairs whatever is
 * created here like any other stored value.
 */
export function applySecrets(
  raw: unknown,
  secrets: Record<string, string>,
  specs: readonly SecretPathSpec[] = SECRET_PATHS
): Record<string, unknown> {
  const root: Record<string, unknown> = isRecord(raw) ? cloneJson(raw) : {}
  for (const [path, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || !secretSpecFor(path, specs)) continue
    const parts = segmentsOf(path)
    if (!parts) continue
    let node = root
    for (const seg of parts.slice(0, -1)) {
      const next = Object.prototype.hasOwnProperty.call(node, seg) ? node[seg] : undefined
      if (!isRecord(next)) node[seg] = {}
      node = node[seg] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
  }
  return root
}

/** A human name for one concrete path: `Codex endpoint key`, `Anthropic API key`. */
export function secretLabel(path: string, specs: readonly SecretPathSpec[] = SECRET_PATHS): string {
  const spec = secretSpecFor(path, specs)
  if (!spec) return path
  const wild = spec.pattern.split('.').findIndex((s) => s === '*')
  if (wild < 0) return spec.label
  const which = path.split('.')[wild]
  const named = spec.names && Object.prototype.hasOwnProperty.call(spec.names, which) ? spec.names[which] : null
  return `${named ?? `${which.charAt(0).toUpperCase()}${which.slice(1)}`} ${spec.label}`
}

/* ------------------------------------------------------- the vault file */

export const SECRETS_FILE_NAME = 'secrets.json'
export const SECRETS_FILE_VERSION = 1

/**
 * `<userData>/secrets.json`.
 *
 * `backend` is informational — which key store sealed these — and is what
 * turns "this item will not open" into a sentence ("sealed by kwallet, and
 * this run has basic_text"). `items` maps a concrete settings path to the
 * base64 of what `safeStorage.encryptString` returned.
 */
export interface SecretsFile {
  v: typeof SECRETS_FILE_VERSION
  backend: string
  items: Record<string, string>
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Parse secrets.json, or null for anything that is not one.
 *
 * An item whose path this build does not register is KEPT — it may be a newer
 * build's secret, carried forward verbatim until that build reads it again.
 * An item that is not base64 is dropped: nothing could ever decrypt it.
 */
export function parseSecretsFile(text: string): SecretsFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.v !== SECRETS_FILE_VERSION || !isRecord(raw.items)) return null
  const items: Record<string, string> = {}
  for (const [path, value] of Object.entries(raw.items)) {
    if (!segmentsOf(path)) continue
    if (typeof value === 'string' && value.length > 0 && BASE64.test(value)) items[path] = value
  }
  return { v: SECRETS_FILE_VERSION, backend: typeof raw.backend === 'string' ? raw.backend : 'unknown', items }
}

export function serializeSecretsFile(backend: string, items: Record<string, string>): string {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(items).sort()) sorted[k] = items[k]
  return `${JSON.stringify({ v: SECRETS_FILE_VERSION, backend, items: sorted }, null, 2)}\n`
}

/**
 * What goes inside each ciphertext: the path, then the value.
 *
 * Two reasons it is not the bare value. macOS's `safeStorage` is AES-128-CBC
 * with no MAC, so a value sealed under a DIFFERENT key (a Keychain item that
 * was deleted and recreated) can decrypt to garbage with valid padding about
 * one time in 256 — the prefix turns that into a refusal instead of a garbage
 * key sent to a provider. And binding the path means an item copied onto
 * another path in the file opens as nothing rather than as that path's value.
 */
export function sealedText(path: string, value: string): string {
  return `stoke-secret:v1:${path}\n${value}`
}

/** The value out of a decrypted item, or null when it was not sealed for `path`. */
export function unsealedValue(path: string, text: string): string | null {
  const head = `stoke-secret:v1:${path}\n`
  return text.startsWith(head) ? text.slice(head.length) : null
}

/* ------------------------------------------------------- protection */

/** Linux Secret Service backends that actually hold a key outside the file. */
const PROTECTED_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export interface SecretProtection {
  /** Seal into secrets.json. False keeps today's plaintext settings.json. */
  protected: boolean
  /** `keychain`, `dpapi`, a Linux backend name, or `unavailable`. */
  backend: string
  /** One sentence for Settings, in the user's terms. */
  why: string
}

/**
 * Whether this run may seal secrets, from what `safeStorage` reports.
 *
 * Linux's `basic_text` is the case this exists for. Electron falls back to it
 * when no Secret Service answers — common under i3, sway, Hyprland and
 * headless sessions — and it "encrypts" with a password hardcoded in Chromium.
 * Sealing with it would move the keys to a second file and call them
 * protected, which is worse than leaving them where they were, so it counts as
 * NOT protected and Settings says so. Never a lock-out: an unprotected run
 * keeps working exactly as every build before this one did.
 */
export function judgeProtection(platform: string, available: boolean, linuxBackend: string | null): SecretProtection {
  if (!available) {
    return {
      protected: false,
      backend: 'unavailable',
      why: 'This system offered Stoke no key store, so keys stay in settings.json in plain text, as in earlier versions.'
    }
  }
  if (platform === 'darwin') {
    return { protected: true, backend: 'keychain', why: 'Sealed with a key kept in the macOS Keychain.' }
  }
  if (platform === 'win32') {
    return { protected: true, backend: 'dpapi', why: 'Sealed with Windows DPAPI, tied to your Windows sign-in.' }
  }
  if (platform === 'linux') {
    const b = linuxBackend ?? 'unknown'
    if (PROTECTED_LINUX_BACKENDS.has(b)) {
      return {
        protected: true,
        backend: b,
        why: `Sealed with a key kept in ${b === 'gnome_libsecret' ? 'the Secret Service (GNOME Keyring)' : 'KWallet'}.`
      }
    }
    return {
      protected: false,
      backend: b,
      why:
        b === 'basic_text'
          ? 'No Secret Service (GNOME Keyring or KWallet) answered, so Electron could only obfuscate keys with a fixed password. Stoke keeps them in settings.json in plain text, as in earlier versions, rather than call that protected.'
          : `Electron reported the key store as “${b}”, which Stoke does not trust to protect anything, so keys stay in settings.json in plain text, as in earlier versions.`
    }
  }
  return {
    protected: false,
    backend: 'unknown',
    why: 'Stoke does not know this platform’s key store, so keys stay in settings.json in plain text.'
  }
}

/** Where the keys live, for Settings › Backup & transfer. */
export interface SecretStoreStatus {
  /** False until something needed the key store — a fresh profile with no keys never asks it. */
  decided: boolean
  protected: boolean
  backend: string
  why: string
  /** Where the keys live on disk right now. */
  location: 'secrets.json' | 'settings.json' | 'none'
  /** Concrete paths held, e.g. `providers.openrouterApiKey`. Never values. */
  held: string[]
  /**
   * Items in secrets.json that would not open on this run (another key store,
   * a deleted Keychain item). Kept verbatim, never deleted: re-entering the key
   * replaces its item.
   */
  stranded: string[]
  /**
   * Why the last write of secrets.json failed, while a key it should hold is
   * still waiting for the next write; null once one succeeds. Until then a
   * changed key is kept in settings.json in plain text, never dropped.
   */
  vaultWriteError: string | null
}
