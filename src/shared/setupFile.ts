/*
 * The portable setup file (`.stoke-setup`): what goes into one, what may come
 * out of one, and how an import is merged and previewed.
 *
 * Phase 1 of the auth-hub design (docs/superpowers/specs/2026-09-30-auth-hub-
 * design.md §16): no server, just a file the user carries between their own
 * machines. It is one JSON object — a header naming the KDF and cipher, then
 * the ciphertext — so the header can be read, and refused, before any key is
 * derived:
 *
 *   { format: "stoke-setup", v: 1,
 *     kdf: { alg: "scrypt", N: 131072, r: 8, p: 1, salt },
 *     aead: "AES-256-GCM", nonce, ciphertext }
 *
 * The ciphertext carries the GCM tag in its last 16 bytes, and the header is
 * the AAD, so a header edited to name a weaker KDF fails the tag like any
 * other flipped byte. The crypto itself is node:crypto in
 * `src/main/setupFile.ts`; this half is pure so the renderer can judge a
 * passphrase and `verify:secrets` can run the merge without a window
 * (gotchas 27, 78: no `node:` import, relative `.ts` imports only).
 */
import type { Settings } from './types.ts'
import { agentsFormatOf, hydrateEndpoint, upgradeEndpoint } from './agents.ts'
import {
  applySecrets,
  collectSecrets,
  scrubSecrets,
  secretLabel,
  secretSpecFor,
  SECRET_PATHS,
  type SecretPathSpec
} from './secrets.ts'

export const SETUP_FORMAT = 'stoke-setup'
export const SETUP_VERSION = 1
export const SETUP_EXTENSION = 'stoke-setup'
export const SETUP_AEAD = 'AES-256-GCM'
export const SETUP_PAYLOAD_KIND = 'stoke-setup-payload'

/**
 * scrypt at N = 2^17, r = 8, p = 1: OWASP's floor for scrypt, and 128 MiB of
 * memory per guess. Measured inside Electron 43 on an M1 (BoringSSL build of
 * Node's crypto): ~0.5 s, run off the main thread by the async `scrypt`.
 */
export const SETUP_KDF_DEFAULTS = { alg: 'scrypt', N: 131072, r: 8, p: 1 } as const

/**
 * What a file may ask the KDF for. A header is DATA until the tag checks, and
 * a crafted one naming N = 2^30 would ask this process for 128 GiB before the
 * passphrase was ever compared — so the bounds are checked first, and the
 * memory ceiling is what `scrypt`'s own `maxmem` is set to.
 */
export const KDF_N_MIN = 1 << 14
export const KDF_N_MAX = 1 << 18
export const KDF_MEM_MAX = 256 * 1024 * 1024

export interface SetupKdf {
  alg: 'scrypt'
  N: number
  r: number
  p: number
  /** base64, at least 16 bytes. */
  salt: string
}

export interface SetupHeader {
  format: typeof SETUP_FORMAT
  v: typeof SETUP_VERSION
  kdf: SetupKdf
  aead: typeof SETUP_AEAD
  /** base64 of the 12-byte GCM nonce. */
  nonce: string
}

export interface SetupEnvelope extends SetupHeader {
  /** base64 of AES-256-GCM(plaintext) with the 16-byte tag appended. */
  ciphertext: string
}

/** Why a file was refused, for the one sentence the import shows. */
export type SetupRefusal =
  | 'not-a-setup-file'
  | 'newer-version'
  | 'unknown-kdf'
  | 'unknown-cipher'
  | 'damaged'
  | 'wrong-passphrase'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const isPow2 = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

export function validKdf(k: unknown): k is SetupKdf {
  if (!isRecord(k) || k.alg !== 'scrypt') return false
  const { N, r, p, salt } = k
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number') return false
  if (!isPow2(N) || N < KDF_N_MIN || N > KDF_N_MAX) return false
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 4) return false
  if (128 * N * r > KDF_MEM_MAX) return false
  // 16 bytes is 24 base64 characters; fewer cannot be a salt worth the name.
  return typeof salt === 'string' && salt.length >= 22 && BASE64.test(salt)
}

export type EnvelopeResult =
  | { ok: true; envelope: SetupEnvelope }
  | { ok: false; reason: SetupRefusal; message: string }

/**
 * Read a file's outer JSON and refuse anything this build cannot open, BEFORE
 * any key is derived. Checks the shape only; the tag is what proves the rest.
 */
export function parseSetupEnvelope(text: string): EnvelopeResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not-a-setup-file', message: 'That file is not a Stoke setup file.' }
  }
  if (!isRecord(raw) || raw.format !== SETUP_FORMAT) {
    return { ok: false, reason: 'not-a-setup-file', message: 'That file is not a Stoke setup file.' }
  }
  if (raw.v !== SETUP_VERSION) {
    return typeof raw.v === 'number' && raw.v > SETUP_VERSION
      ? {
          ok: false,
          reason: 'newer-version',
          message: 'That setup file was made by a newer Stoke. Update this copy of Stoke, then import it again.'
        }
      : { ok: false, reason: 'damaged', message: 'That setup file is damaged: it names no version this Stoke knows.' }
  }
  if (!validKdf(raw.kdf)) {
    return {
      ok: false,
      reason: 'unknown-kdf',
      message: 'That setup file asks for a key-derivation this Stoke does not use, so it was not opened.'
    }
  }
  if (raw.aead !== SETUP_AEAD) {
    return {
      ok: false,
      reason: 'unknown-cipher',
      message: 'That setup file is sealed with a cipher this Stoke does not use, so it was not opened.'
    }
  }
  if (
    typeof raw.nonce !== 'string' ||
    !BASE64.test(raw.nonce) ||
    typeof raw.ciphertext !== 'string' ||
    !BASE64.test(raw.ciphertext)
  ) {
    return { ok: false, reason: 'damaged', message: 'That setup file is damaged.' }
  }
  const kdf = raw.kdf
  return {
    ok: true,
    envelope: {
      format: SETUP_FORMAT,
      v: SETUP_VERSION,
      kdf: { alg: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt },
      aead: SETUP_AEAD,
      nonce: raw.nonce,
      ciphertext: raw.ciphertext
    }
  }
}

/**
 * The header as AAD: fixed key order, rebuilt from the parsed fields rather
 * than sliced from the file's text, so whitespace or key order in a file
 * written by some other tool changes nothing while every VALUE is bound.
 */
export function headerAad(h: SetupHeader): string {
  return JSON.stringify({
    format: h.format,
    v: h.v,
    kdf: { alg: h.kdf.alg, N: h.kdf.N, r: h.kdf.r, p: h.kdf.p, salt: h.kdf.salt },
    aead: h.aead,
    nonce: h.nonce
  })
}

/* --------------------------------------------------------------- payload */

export interface SetupPayload {
  kind: typeof SETUP_PAYLOAD_KIND
  /** ISO time the file was made. */
  createdAt: string
  /** Which Stoke made it, for the preview's first line. */
  from: { version: string; platform: string }
  /** `portableSettings` of the exporting machine; secret paths empty. */
  settings: Record<string, unknown>
  /** Portable secrets, only when the user ticked the box; else `{}`. */
  secrets: Record<string, string>
}

/** Validate a decrypted payload's shape. Its CONTENTS are repaired by the merge. */
export function parseSetupPayload(text: string): SetupPayload | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.kind !== SETUP_PAYLOAD_KIND || !isRecord(raw.settings)) return null
  const from = isRecord(raw.from) ? raw.from : {}
  const secrets: Record<string, string> = {}
  if (isRecord(raw.secrets)) {
    for (const [k, v] of Object.entries(raw.secrets)) if (typeof v === 'string') secrets[k] = v
  }
  return {
    kind: SETUP_PAYLOAD_KIND,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    from: {
      version: typeof from.version === 'string' ? from.version : '',
      platform: typeof from.platform === 'string' ? from.platform : ''
    },
    settings: raw.settings,
    secrets
  }
}

/* ------------------------------------------------- what travels, and why */

/**
 * Settings that mean the same thing on any machine, copied whole.
 *
 * `providers` and `agents` travel whole with their key fields emptied: which
 * gateway, which model, which agents — but a key only through `secrets`, and
 * only when ticked. `hosts` travel without `keyEnrolled`, which records that
 * a key from THIS device works there; the next device has no such key.
 */
export const PORTABLE_KEYS = [
  'themeId',
  'themeIdLight',
  'followSystemTheme',
  'customThemes',
  'fontFamily',
  'fontSize',
  'terminal',
  'zoomTarget',
  'fullScreenReveal',
  'defaults',
  'voice',
  'profiles',
  'hosts',
  'worklogGroups',
  'worklogAuto',
  'betaUpdates',
  'cliAutoUpdate',
  'cliRelaunch',
  'selfUpdateAuto',
  'worklogBoards',
  'hideStatusLine',
  'showBrand',
  'sshKeyEnroll',
  'notifications',
  'providers',
  'agents'
] as const satisfies readonly (keyof Settings)[]

/**
 * Settings that travel in part. `wallpaper.path` is a file in THIS machine's
 * userData (the file does not travel); `browser.profiles`, `currentProfile`
 * and `importOffer` name cookie partitions sealed by this machine's key
 * (gotchas 107/108); `lastUrl` and `width` are where this window was.
 */
export const PARTIAL_KEYS = {
  wallpaper: ['blur', 'dim', 'opacity'],
  browser: ['homepage', 'bookmarks']
} as const satisfies Partial<Record<keyof Settings, readonly string[]>>

/**
 * Settings that never leave the machine, and why:
 * - `projectRoots`, `defaultCwd`, `pinnedProjects`, `hiddenProjects`,
 *   `projectMeta`, `startOnLaunch`: absolute paths, realpath'd on this disk
 *   (gotcha 91), meaningless on another OS or layout — and `startOnLaunch`
 *   starts a session in `defaultCwd`, which is one of them.
 * - `claudePath`: where `claude` is installed here.
 * - `remote`: port, binds, tunnel, and the phone access key, which grants a
 *   shell on THIS machine (design §8, tier T0).
 * - `uiScale`, `sidebarWidth`: this display and this window.
 * - `activeProfile`: a view filter that follows the tab in front.
 * - `welcomeSeenVersion`: whether THIS install has shown the first-run splash.
 * - `chatIndex`, `chatIndexOptions`: consent to copy THIS machine's chat text
 *   into a local index, and which of its tools and how much. A yes given on one
 *   computer is not a yes on another, and the offer there must still be asked.
 * - `accounts`: each login account is a folder on this disk signed in on this
 *   device (shared/accounts.ts), and its key accounts' keys are not portable.
 * - `hub`: which Stoke Hub THIS device is signed in to, as which device, and
 *   the grants it gives other devices (shared/hub/settings.ts, tier T0). A
 *   copy on another machine would claim to be this device.
 *
 * `verify:secrets` asserts PORTABLE_KEYS, PARTIAL_KEYS and LOCAL_KEYS
 * partition every key of DEFAULT_SETTINGS exactly, so a new setting fails the
 * suite until somebody decides which side it is on.
 */
export const LOCAL_KEYS = [
  'uiScale',
  'projectRoots',
  'defaultCwd',
  'startOnLaunch',
  'pinnedProjects',
  'hiddenProjects',
  'projectMeta',
  'claudePath',
  'remote',
  'sidebarWidth',
  'activeProfile',
  'welcomeSeenVersion',
  'chatIndex',
  'chatIndexOptions',
  'accounts',
  'hub'
] as const satisfies readonly (keyof Settings)[]

function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function pick(src: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isRecord(src)) return out
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k]
  return out
}

/** The portable subset of `s`, with every secret path emptied. */
export function portableSettings(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PORTABLE_KEYS) out[k] = s[k]
  for (const [k, subs] of Object.entries(PARTIAL_KEYS)) out[k] = pick(s[k as keyof Settings], subs)
  out.hosts = s.hosts.map((h) => {
    const { keyEnrolled: _mine, ...rest } = h
    return rest
  })
  return scrubSecrets(out)
}

/** The secrets a spec lets travel, from a `{ path: value }` map. */
export function portableSecrets(
  secrets: Record<string, string>,
  specs: readonly SecretPathSpec[] = SECRET_PATHS
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value.trim() !== '' && secretSpecFor(path, specs)?.portable) out[path] = value
  }
  return out
}

export function buildSetupPayload(
  s: Settings,
  opts: { includeSecrets: boolean; version: string; platform: string; now: Date }
): SetupPayload {
  return {
    kind: SETUP_PAYLOAD_KIND,
    createdAt: opts.now.toISOString(),
    from: { version: opts.version, platform: opts.platform },
    settings: portableSettings(s),
    secrets: opts.includeSecrets ? portableSecrets(collectSecrets(s)) : {}
  }
}

/* ------------------------------------------------------------------ merge */

/**
 * Union two lists of `{ id }` records: the local order first, an incoming
 * record replacing the local one with its id, new ones appended. Import is for
 * bringing a setup IN, so a host or theme this machine has and the file does
 * not is kept rather than deleted.
 */
function mergeById<T extends { id: string }>(
  local: readonly T[],
  incoming: unknown,
  fold: (mine: T | undefined, theirs: T) => T = (_m, t) => t
): T[] {
  if (!Array.isArray(incoming)) return [...local]
  const theirs = incoming.filter((x): x is T => isRecord(x) && typeof x.id === 'string' && x.id !== '')
  const byId = new Map(theirs.map((t) => [t.id, t]))
  const out = local.map((m) => (byId.has(m.id) ? fold(m, byId.get(m.id) as T) : m))
  const have = new Set(local.map((m) => m.id))
  for (const t of theirs) if (!have.has(t.id)) out.push(fold(undefined, t))
  return out
}

function unionStrings(local: readonly string[], incoming: unknown): string[] {
  const out = [...local]
  if (!Array.isArray(incoming)) return out
  for (const x of incoming) if (typeof x === 'string' && !out.includes(x)) out.push(x)
  return out
}

export interface MergeResult {
  /** Current settings with the file folded in. NOT hydrated: the caller runs `hydrateSettings`. */
  raw: Record<string, unknown>
  /** Settings the file carried and the merge deliberately left alone. */
  skipped: { key: string; label: string; why: string }[]
}

/**
 * Fold a payload into the current settings.
 *
 * Only keys named in PORTABLE_KEYS / PARTIAL_KEYS are read from the file, so
 * anything else in it — a machine-local field, a key from a newer build, junk
 * — is dropped here, and what is read is repaired by `hydrateSettings`
 * afterwards like any stored value. Local-only settings are the current ones,
 * untouched. Current secrets are kept whether or not the file has any; the
 * file's replace them only when `includeSecrets`.
 */
export function mergeSetup(current: Settings, payload: SetupPayload, opts: { includeSecrets: boolean }): MergeResult {
  const inc = payload.settings
  const next = cloneJson(current) as unknown as Record<string, unknown>
  const skipped: MergeResult['skipped'] = []
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(inc, k)

  for (const k of PORTABLE_KEYS) {
    if (!has(k)) continue
    const theirs = inc[k]
    switch (k) {
      case 'hosts':
        next.hosts = mergeById(current.hosts, theirs, (mine, t) => ({
          ...t,
          // A device fact, never the file's: see portableSettings.
          keyEnrolled: mine?.keyEnrolled === true
        }))
        break
      case 'customThemes':
        next.customThemes = mergeById(current.customThemes, theirs)
        break
      case 'profiles':
        next.profiles = mergeById(current.profiles, theirs)
        break
      case 'worklogGroups':
        next.worklogGroups = unionStrings(current.worklogGroups, theirs)
        break
      case 'defaults': {
        if (!isRecord(theirs)) break
        const d = { ...current.defaults, ...theirs } as Record<string, unknown>
        /*
         * Bypass is a decision made on the machine it runs on. The design (§8)
         * lets `defaults.permissionMode` travel but never lets a synced
         * `bypassPermissions` take effect unconfirmed — and an import has no
         * confirmation step for it, so it is left as it was and said so.
         */
        if (theirs.permissionMode === 'bypassPermissions' && current.defaults.permissionMode !== 'bypassPermissions') {
          d.permissionMode = current.defaults.permissionMode
          skipped.push({
            key: 'defaults.permissionMode',
            label: 'Default permission mode',
            why: 'The file starts sessions with permissions bypassed. Choose that here, in Settings › Agents › Claude Code › Launch defaults, if you want it on this machine too.'
          })
        }
        next.defaults = d
        break
      }
      case 'agents': {
        if (!isRecord(theirs)) break
        const endpoints = { ...(current.agents.endpoints as Record<string, unknown>) }
        /*
         * Upgraded HERE, by the file's own format: the merged block carries this
         * machine's `format`, so `hydrateAgents` will not upgrade it afterwards,
         * and a file exported before format 2 would otherwise bring its hidden
         * default-mode leftovers in as Default models (AGENTS_FORMAT). The rest
         * of the block is left raw for the hydrate, which repairs it anyway;
         * `hydrateEndpoint` is idempotent, so running it early changes nothing.
         */
        const from = agentsFormatOf(theirs.format)
        if (isRecord(theirs.endpoints)) {
          for (const [id, ep] of Object.entries(theirs.endpoints)) {
            if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue
            endpoints[id] = upgradeEndpoint(hydrateEndpoint(ep), from)
          }
        }
        next.agents = {
          ...current.agents,
          chosen:
            Array.isArray(theirs.chosen) && Array.isArray(current.agents.chosen)
              ? unionStrings(current.agents.chosen, theirs.chosen)
              : Array.isArray(theirs.chosen)
                ? theirs.chosen
                : current.agents.chosen,
          endpoints,
          defaultCli: theirs.defaultCli ?? current.agents.defaultCli
        }
        break
      }
      default:
        next[k] = cloneJson(theirs)
    }
  }

  for (const [k, subs] of Object.entries(PARTIAL_KEYS) as [keyof typeof PARTIAL_KEYS, readonly string[]][]) {
    const theirs = inc[k]
    if (!isRecord(theirs)) continue
    const merged: Record<string, unknown> = { ...(current[k] as unknown as Record<string, unknown>) }
    for (const sub of subs) {
      if (!Object.prototype.hasOwnProperty.call(theirs, sub)) continue
      merged[sub] =
        k === 'browser' && sub === 'bookmarks'
          ? unionStrings(current.browser.bookmarks, theirs.bookmarks)
          : cloneJson(theirs[sub])
    }
    next[k] = merged
  }

  // Whatever the file said in a secret's place, the current value stands...
  let raw = applySecrets(scrubSecrets(next), collectSecrets(current))
  // ...unless the user asked for the file's keys, and then only portable ones.
  if (opts.includeSecrets) raw = applySecrets(raw, portableSecrets(payload.secrets))
  return { raw, skipped }
}

/* ---------------------------------------------------------------- preview */

const LABELS: Record<string, string> = {
  themeId: 'Theme',
  themeIdLight: 'Light theme',
  followSystemTheme: 'Follow the system appearance',
  customThemes: 'Custom themes',
  fontFamily: 'Font',
  fontSize: 'Font size',
  terminal: 'Terminal options',
  zoomTarget: 'What zoom moves',
  fullScreenReveal: 'Full-screen menu bar',
  defaults: 'Claude Code launch defaults',
  voice: 'Voice dictation',
  profiles: 'Profiles',
  hosts: 'SSH hosts',
  worklogGroups: 'Worklog groups',
  worklogAuto: 'Worklog auto-scan',
  betaUpdates: 'Beta updates',
  cliAutoUpdate: 'Claude Code auto-update',
  cliRelaunch: 'Relaunch after a CLI update',
  selfUpdateAuto: 'Download Stoke updates',
  worklogBoards: 'Worklog boards',
  hideStatusLine: 'Hide Claude’s status line',
  showBrand: 'Show the Stoke name',
  sshKeyEnroll: 'SSH key offer',
  notifications: 'Notifications',
  providers: 'Provider & keys',
  agents: 'Agents',
  'wallpaper.blur': 'Wallpaper blur',
  'wallpaper.dim': 'Wallpaper dim',
  'wallpaper.opacity': 'Panel opacity',
  'browser.homepage': 'Browser home page',
  'browser.bookmarks': 'Bookmarks'
}

export interface SetupChange {
  key: string
  label: string
  /** Short, human, never a secret: `Ember → Lagoon`, `adds devbox, vps`. */
  detail: string
}

export interface SetupPreview {
  from: SetupPayload['from']
  createdAt: string
  changes: SetupChange[]
  /** How many portable settings the file would leave as they are. */
  unchanged: number
  skipped: MergeResult['skipped']
  /** The file's keys and what each would do here. Never the values. */
  secrets: { path: string; label: string; action: 'add' | 'replace' | 'same' }[]
}

/**
 * JSON with object keys sorted, for comparing. A merged host is `{ ...theirs,
 * keyEnrolled }`, so its keys come back in a different ORDER from the stored
 * one while every value is equal — and plain `JSON.stringify` called that a
 * change ("SSH hosts: updates Box" for a file made from this very setup).
 */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    isRecord(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val
  )
}

function short(v: unknown): string {
  if (typeof v === 'string') return v.length > 40 ? `“${v.slice(0, 39)}…”` : `“${v}”`
  if (v === null || v === undefined) return 'none'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  return String(v)
}

function nameOf(x: unknown): string {
  if (!isRecord(x)) return String(x)
  for (const k of ['label', 'name', 'alias', 'id']) if (typeof x[k] === 'string' && x[k]) return x[k] as string
  return '?'
}

function describe(before: unknown, after: unknown): string {
  if (Array.isArray(before) && Array.isArray(after)) {
    const key = (x: unknown): string => (isRecord(x) && typeof x.id === 'string' ? x.id : stable(x))
    const had = new Set(before.map(key))
    const added = after.filter((x) => !had.has(key(x))).map(nameOf)
    const changed = after.filter((x) => had.has(key(x)) && !before.some((b) => stable(b) === stable(x)))
    const parts: string[] = []
    if (added.length) parts.push(`adds ${added.slice(0, 4).join(', ')}${added.length > 4 ? ` and ${added.length - 4} more` : ''}`)
    if (changed.length) parts.push(`updates ${changed.slice(0, 4).map(nameOf).join(', ')}`)
    return parts.join('; ') || 'reordered'
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (k) => stable(before[k]) !== stable(after[k])
    )
    return `changes ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '…' : ''}`
  }
  return `${short(before)} → ${short(after)}`
}

/**
 * What an import would change, from the current settings and the HYDRATED
 * merge — so the preview shows what would actually be stored, clamps and all,
 * not what the file claimed. Compared with secrets emptied on both sides, so no
 * key can reach the renderer through a detail string.
 */
export function previewSetup(
  current: Settings,
  merged: Settings,
  payload: SetupPayload,
  skipped: MergeResult['skipped']
): SetupPreview {
  const a = scrubSecrets(current) as unknown as Record<string, unknown>
  const b = scrubSecrets(merged) as unknown as Record<string, unknown>
  const changes: SetupChange[] = []
  let unchanged = 0
  const consider = (key: string, before: unknown, after: unknown): void => {
    if (stable(before) === stable(after)) {
      unchanged++
      return
    }
    changes.push({ key, label: LABELS[key] ?? key, detail: describe(before, after) })
  }
  for (const k of PORTABLE_KEYS) consider(k, a[k], b[k])
  for (const [k, subs] of Object.entries(PARTIAL_KEYS)) {
    for (const sub of subs) {
      consider(`${k}.${sub}`, (a[k] as Record<string, unknown>)?.[sub], (b[k] as Record<string, unknown>)?.[sub])
    }
  }
  const mine = collectSecrets(current)
  const secrets = Object.entries(portableSecrets(payload.secrets)).map(([path, value]) => ({
    path,
    label: secretLabel(path),
    action: (!mine[path] ? 'add' : mine[path] === value.trim() || mine[path] === value ? 'same' : 'replace') as
      | 'add'
      | 'replace'
      | 'same'
  }))
  return { from: payload.from, createdAt: payload.createdAt, changes, unchanged, skipped, secrets }
}

/**
 * The whole import, as main runs it: merge, hydrate, and the preview of
 * exactly what would be stored. `hydrate` is `hydrateSettings`, passed in
 * because it lives in main (settingsSchema.ts) and this module is shared.
 *
 * The CURRENT settings go through `hydrate` too before anything is compared,
 * because hydrate is not idempotent on every field: `hydrateWorklogBoards`
 * returns the default `targets: ['notion']` for a file with no worklogBoards
 * key, and drops that same target (it has no id) once the object is hydrated
 * a second time. A fresh profile that had never written a setting showed
 * "Worklog boards: changes targets" for a file made from an identical fresh
 * profile — found by driving the import, not by the suite. Hydrating both
 * sides the same number of times compares like with like.
 */
export function planImport(
  current: Settings,
  payload: SetupPayload,
  opts: { includeSecrets: boolean },
  hydrate: (raw: unknown) => Settings
): { next: Settings; preview: SetupPreview } {
  const base = hydrate(current)
  const merged = mergeSetup(base, payload, opts)
  const next = hydrate(merged.raw)
  return { next, preview: previewSetup(base, next, payload, merged.skipped) }
}

/* ------------------------------------------------------------- passphrase */

export const MIN_PASSPHRASE_LENGTH = 10

export interface PassphraseVerdict {
  /** 0 too weak … 4 strong. */
  score: 0 | 1 | 2 | 3 | 4
  label: string
  hint: string
  /** Export is allowed. */
  acceptable: boolean
}

const COMMON = /^(pass(word|phrase)?|stoke|qwerty|letmein|welcome|admin|iloveyou|123456|abc123)/i

/**
 * A rough strength reading for the export form. An estimate of guessing work,
 * not a guarantee: character-pool entropy capped by distinct characters, and a
 * phrase of three or more words counted as words (about 11 bits each, a
 * 2048-word list), whichever is LOWER — so "correct horse battery staple" is
 * judged as four words rather than as 28 random characters.
 */
export function judgePassphrase(p: string): PassphraseVerdict {
  const chars = [...p]
  const len = chars.length
  if (len === 0) {
    return {
      score: 0,
      label: '',
      hint: 'The file cannot be opened without this passphrase, and Stoke keeps no copy of it.',
      acceptable: false
    }
  }
  let pool = 0
  if (/[a-z]/.test(p)) pool += 26
  if (/[A-Z]/.test(p)) pool += 26
  if (/[0-9]/.test(p)) pool += 10
  if (/[^A-Za-z0-9\s]/.test(p)) pool += 33
  if (/\s/.test(p)) pool += 1
  if (chars.some((c) => (c.codePointAt(0) ?? 0) > 0x7f)) pool += 100
  const distinct = new Set(chars).size
  const effLen = Math.min(len, distinct * 2)
  let bits = effLen * Math.log2(Math.max(pool, 2))
  const words = p.trim().split(/\s+/).filter((w) => w.length >= 3)
  if (words.length >= 3) bits = Math.min(bits, words.length * 11 + 8)
  if (COMMON.test(p.trim())) bits = Math.min(bits, 20)
  const score: PassphraseVerdict['score'] = bits < 35 ? 0 : bits < 50 ? 1 : bits < 65 ? 2 : bits < 80 ? 3 : 4
  const label = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score]
  const tooShort = len < MIN_PASSPHRASE_LENGTH
  const hint = tooShort
    ? `At least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words are easier to remember than symbols.`
    : score < 2
      ? 'Easy to guess. Add another word or two — length beats symbols.'
      : score < 3
        ? 'Acceptable. Another word would make it much harder to guess.'
        : 'Good. Keep it somewhere safe: Stoke cannot recover it.'
  return { score, label, hint, acceptable: !tooShort && score >= 2 }
}
