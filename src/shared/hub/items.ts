/*
 * What syncs through the hub, how one item is addressed and sealed, and how
 * two devices that edited the same thing agree on the result.
 *
 * Item paths (spec §5.1) are the client's names for things — `t1/settings/
 * themeId`, `t2/secret/providers.anthropicApiKey`, `t3/host/<id>`,
 * `t4/ssh-key/<id>`. The hub never sees one: it stores an envelope under an
 * opaque id (an HMAC of the path under a key derived from the vault key), and
 * the reader re-derives that id from the decrypted path (spec §4.7). This
 * module is the grammar of those paths, the envelope's shape, the AAD and
 * plaintext the crypto seals, the hub's compare-and-swap rule, and the
 * last-writer-wins rule clients resolve a conflict with.
 *
 * Pure (gotcha 27); `verify:hub` runs it under strip-types with the relative
 * `.ts` imports gotcha 78 requires.
 */
import { canonicalJson, isB64u, isId, isNonNegInt, isRecord, labelled } from './codec.ts'
import { HUB_LABELS } from './labels.ts'
import { PARTIAL_KEYS, PORTABLE_KEYS } from '../setupFile.ts'
import { secretLabel, secretSpecFor } from '../secrets.ts'

/* ------------------------------------------------------------- paths */

/**
 * T1: one item per portable setting. `hosts` is not here — each host is its
 * own T3 item — and the two PARTIAL blocks are, carrying only their portable
 * sub-keys. verify:hub holds this list to the portable half of the settings
 * partition (setupFile.ts), so a new portable setting fails the suite until
 * it is placed.
 */
export const T1_KEYS: readonly string[] = [
  ...PORTABLE_KEYS.filter((k) => k !== 'hosts'),
  ...Object.keys(PARTIAL_KEYS)
]

/**
 * Account-wide preferences, synced like any item.
 * - `sync-keys`: `{ on: boolean }`, whether T2 API keys sync at all (the owner ticks it once).
 * - `device-names`: `{ names: { [deviceId]: string } }`, what the owner renamed devices to.
 *   A chain entry's `label` is signed at join and cannot change, so a rename is
 *   a vault item every device reads over it (added by the desktop client,
 *   2026-10-01; the hub never parses paths, so this needs no server change).
 */
export const ACCOUNT_PREFS = ['sync-keys', 'device-names'] as const
export type AccountPref = (typeof ACCOUNT_PREFS)[number]

export type ItemPath =
  | { tier: 't1'; kind: 'settings'; key: string }
  | { tier: 't2'; kind: 'secret'; secretPath: string }
  | { tier: 't3'; kind: 'host'; hostId: string }
  | { tier: 't4'; kind: 'ssh-key'; keyId: string }
  | { tier: 'acct'; kind: 'pref'; pref: AccountPref }

export const MAX_PATH_CHARS = 200

/**
 * Parse an item path, or null. Every segment is checked against what it may
 * name: a T1 key must be in T1_KEYS, a T2 path must be a concrete path a
 * PORTABLE secret spec names (so the phone key and machine-local account keys
 * can never be addressed at all), ids must be ids.
 */
export function parseItemPath(path: unknown): ItemPath | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARS) return null
  const slash1 = path.indexOf('/')
  const slash2 = path.indexOf('/', slash1 + 1)
  if (slash1 < 0 || slash2 < 0) return null
  const tier = path.slice(0, slash1)
  const kind = path.slice(slash1 + 1, slash2)
  const name = path.slice(slash2 + 1)
  if (name === '') return null
  if (tier === 't1' && kind === 'settings') return T1_KEYS.includes(name) ? { tier, kind, key: name } : null
  if (tier === 't2' && kind === 'secret') {
    return secretSpecFor(name)?.portable === true ? { tier, kind, secretPath: name } : null
  }
  // A host's SYNC id (`h…`), never its settings id: those are per-machine counters (codec.ts ID_BYTES).
  if (tier === 't3' && kind === 'host') return isId('host', name) ? { tier, kind, hostId: name } : null
  if (tier === 't4' && kind === 'ssh-key') return isId('sshKey', name) ? { tier, kind, keyId: name } : null
  if (tier === 'acct' && kind === 'pref') {
    return (ACCOUNT_PREFS as readonly string[]).includes(name) ? { tier, kind, pref: name as AccountPref } : null
  }
  return null
}

export function itemPath(p: ItemPath): string {
  switch (p.tier) {
    case 't1':
      return `t1/settings/${p.key}`
    case 't2':
      return `t2/secret/${p.secretPath}`
    case 't3':
      return `t3/host/${p.hostId}`
    case 't4':
      return `t4/ssh-key/${p.keyId}`
    case 'acct':
      return `acct/pref/${p.pref}`
  }
}

/** A few words for a conflict note: "Theme", "Anthropic API key", "SSH host box". */
export function itemLabel(path: string, names: { host?: (id: string) => string; sshKey?: (id: string) => string } = {}): string {
  const p = parseItemPath(path)
  if (!p) return path
  switch (p.tier) {
    case 't1':
      return `Setting “${p.key}”`
    case 't2':
      return secretLabel(p.secretPath)
    case 't3':
      return `SSH host ${names.host?.(p.hostId) ?? p.hostId}`
    case 't4':
      return `SSH key ${names.sshKey?.(p.keyId) ?? p.keyId}`
    case 'acct':
      return p.pref === 'sync-keys' ? 'Sync API keys' : 'Device names'
  }
}

/* ---------------------------------------------------------- envelopes */

/** Bytes of plaintext one item may hold (a custom theme set is the largest real one). */
export const MAX_ITEM_PLAINTEXT_BYTES = 128 * 1024
/** GCM adds a 16-byte tag. */
export const MAX_ITEM_CIPHERTEXT_BYTES = MAX_ITEM_PLAINTEXT_BYTES + 16
/** Item ids: `i` + b64url of the first 24 bytes of the HMAC. */
export const ITEM_ID_BYTES = 24

/** Everything the hub stores for one item. */
export interface ItemEnvelope {
  v: 1
  /** Opaque: `i` + b64url(HMAC(idKey_epoch, path))[24 bytes]. */
  id: string
  /** 1, 2, 3 … per id; the hub's compare-and-swap. */
  version: number
  /** The vault epoch it is sealed under. */
  epoch: number
  /** The device that wrote it. */
  author: string
  /** b64url of the 12-byte GCM nonce. */
  nonce: string
  /** b64url of the ciphertext with its 16-byte tag appended. */
  ct: string
}

/** An item as the change feed serves it. */
export interface StoredItem {
  envelope: ItemEnvelope
  /** The account's change-feed position this write took. */
  seq: number
}

export function isItemId(v: unknown): v is string {
  return typeof v === 'string' && v.length === 1 + 32 && v[0] === 'i' && isB64u(v.slice(1), ITEM_ID_BYTES)
}

/** Why an envelope is malformed, or null. The hub runs this on every put. */
export function envelopeProblem(e: unknown): string | null {
  if (!isRecord(e)) return 'not an object'
  if (e.v !== 1) return 'unknown version'
  if (!isItemId(e.id)) return 'bad id'
  if (!isNonNegInt(e.version) || e.version < 1) return 'bad version'
  if (!isNonNegInt(e.epoch) || e.epoch < 1) return 'bad epoch'
  if (!isId('device', e.author)) return 'bad author'
  if (!isB64u(e.nonce, 12)) return 'bad nonce'
  if (typeof e.ct !== 'string') return 'bad ciphertext'
  const ctBytes = Math.floor((e.ct.length * 3) / 4)
  if (ctBytes < 16 || ctBytes > MAX_ITEM_CIPHERTEXT_BYTES || !isB64u(e.ct, ctBytes)) return 'bad ciphertext'
  const allowed = new Set(['v', 'id', 'version', 'epoch', 'author', 'nonce', 'ct'])
  if (Object.keys(e).some((k) => !allowed.has(k))) return 'unknown field'
  return null
}

/** The GCM additional data of one item: the slot, its version and epoch, and who wrote it. */
export function itemAadText(f: { account: string; id: string; version: number; epoch: number; author: string }): string {
  return labelled(HUB_LABELS.item, { account: f.account, id: f.id, version: f.version, epoch: f.epoch, author: f.author })
}

/** What is sealed: the path (checked against the id on open), when, whether deleted, and the value. */
export interface ItemPlaintext {
  path: string
  /** Hybrid clock, ms (`nextEditedAt`). */
  editedAt: number
  deleted: boolean
  /** Any JSON; null for a tombstone. */
  value: unknown
}

export function itemPlaintextText(p: ItemPlaintext): string {
  return canonicalJson({ path: p.path, editedAt: p.editedAt, deleted: p.deleted, value: p.deleted ? null : p.value })
}

/** Parse a decrypted item, or null for anything that is not one (the path is checked by the caller against the id). */
export function parseItemPlaintext(text: string): ItemPlaintext | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || typeof raw.path !== 'string' || !isNonNegInt(raw.editedAt) || typeof raw.deleted !== 'boolean') return null
  if (!parseItemPath(raw.path)) return null
  if (raw.deleted && raw.value !== null) return null
  return { path: raw.path, editedAt: raw.editedAt, deleted: raw.deleted, value: raw.deleted ? null : raw.value }
}

/* ------------------------------------------------ the hub's put rule */

export type PutVerdict =
  | { ok: true }
  | { ok: false; error: 'invalid'; reason: string }
  | { ok: false; error: 'stale-epoch' }
  | { ok: false; error: 'conflict' }

/**
 * Whether the hub takes one put. `current` is the slot's stored envelope
 * (null when the id is new); `accountEpoch` the chain's epoch; `author` the
 * device the request was signed by.
 *
 * Checked in this order, so a client can act on the answer: shape, author,
 * epoch (fetch the new wrap and re-seal), then the compare-and-swap
 * (`baseVersion` must equal the slot's version, 0 when new, and the envelope
 * must carry `baseVersion + 1` — the version is inside the AAD, so this is
 * what makes a replayed old envelope unacceptable).
 */
export function putVerdict(
  current: Pick<ItemEnvelope, 'version'> | null,
  accountEpoch: number,
  put: { baseVersion: unknown; envelope: unknown },
  author: string
): PutVerdict {
  const problem = envelopeProblem(put.envelope)
  if (problem) return { ok: false, error: 'invalid', reason: problem }
  if (!isNonNegInt(put.baseVersion)) return { ok: false, error: 'invalid', reason: 'bad baseVersion' }
  const e = put.envelope as ItemEnvelope
  if (e.author !== author) return { ok: false, error: 'invalid', reason: 'author is not the signing device' }
  if (e.epoch !== accountEpoch) return { ok: false, error: 'stale-epoch' }
  if ((current?.version ?? 0) !== put.baseVersion) return { ok: false, error: 'conflict' }
  if (e.version !== put.baseVersion + 1) return { ok: false, error: 'invalid', reason: 'version must be baseVersion + 1' }
  return { ok: true }
}

/* --------------------------------------------- clocks and conflicts */

/**
 * A device's next edit time: wall-clock ms, but never at or below the last
 * one it used, so its own edits stay ordered through a clock step back.
 */
export function nextEditedAt(now: number, last: number): number {
  return Math.max(Math.floor(now), Math.floor(last) + 1)
}

export interface EditStamp {
  editedAt: number
  author: string
}

/**
 * Last writer wins, deterministically on every device: the later
 * `editedAt`, and on a tie the larger author id. `mine` is the local edit the
 * hub refused, `theirs` the envelope it holds now.
 */
export function decideConflict(mine: EditStamp, theirs: EditStamp): 'mine' | 'theirs' {
  if (mine.editedAt !== theirs.editedAt) return mine.editedAt > theirs.editedAt ? 'mine' : 'theirs'
  return mine.author > theirs.author ? 'mine' : 'theirs'
}

/** What the Hub panel lists after a conflict, until dismissed. Never a value. */
export interface ConflictNote {
  path: string
  label: string
  kept: 'mine' | 'theirs'
  /** The other side's device and edit time. */
  otherDevice: string
  otherEditedAt: number
  mineEditedAt: number
  at: number
}

export function conflictNote(f: { path: string; label?: string; mine: EditStamp; theirs: EditStamp; now: number }): ConflictNote {
  return {
    path: f.path,
    label: f.label ?? itemLabel(f.path),
    kept: decideConflict(f.mine, f.theirs),
    otherDevice: f.theirs.author,
    otherEditedAt: f.theirs.editedAt,
    mineEditedAt: f.mine.editedAt,
    at: f.now
  }
}

/**
 * A served version below the one this device already saw for that id: the
 * hub went back in time (a restore, or worse). Alarm, never apply (spec §7.3).
 */
export function versionRegression(pinned: number | undefined, served: number): boolean {
  return pinned !== undefined && served < pinned
}

/** Tombstones older than this may be purged by the hub; a device away longer does a full resync. */
export const TOMBSTONE_KEEP_MS = 90 * 24 * 60 * 60_000
