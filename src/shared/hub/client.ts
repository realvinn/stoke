/*
 * The Stoke side of hub sync, pure: what one device keeps between syncs (the
 * shape of `<userData>/hub-state.json` and its repair), what counts as a local
 * change, the plan a sync pass carries out, where a received SSH key lands, and
 * the view Settings › Account & sync draws.
 *
 * The wire contract (routes, chain, items, crypto) is the rest of this folder
 * and `src/main/hub/crypto.ts`; the impure client that follows these rules is
 * `src/main/hub/service.ts`. Everything here is a function of its arguments —
 * no clock, no randomness, no digest of its own (the caller hands one in) — so
 * `verify:hub-client` can hold every rule with synthetic inputs (gotcha 74).
 *
 * Pure and compiled by both tsconfigs (gotcha 27); relative `.ts` imports only
 * (gotcha 78). Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md §5.
 */
import type { Settings } from '../types.ts'
import { isB64u, isId, isNonNegInt, isRecord, stableJson } from './codec.ts'
import { chainEntryProblem, type ChainEntry, type PinnedChain } from './chain.ts'
import { HUB_LIMITS } from './protocol.ts'
import {
  conflictNote,
  decideConflict,
  isItemId,
  itemLabel,
  nextEditedAt,
  parseItemPath,
  T1_KEYS,
  type ConflictNote
} from './items.ts'
import type { PairState } from './pairing.ts'
import type { RecoveryWrap } from './protocol.ts'
import {
  hostPayloadFor,
  isSafeSshKeyName,
  sshKeyPayloadProblem,
  sshKeyTarget,
  t1ValuesFrom,
  t2ValuesFrom,
  type HostPayload,
  type SshKeyPayload,
  type SshNameProbe,
  type SyncableHost,
  type SyncedIncoming
} from './settings.ts'

/* ------------------------------------------------------------ what syncs */

/** Which tiers this pass may touch. `keys` is the device switch AND the account's `sync-keys`. */
export interface SyncScope {
  settings: boolean
  hosts: boolean
  keys: boolean
}

/**
 * Whether an item path is one the generic pass handles under `scope`. T4 (SSH
 * private keys) never is: a key is uploaded only when the owner picks it and
 * installed only when they press Install, never by a background pass.
 */
export function inScope(path: string, scope: SyncScope): boolean {
  const p = parseItemPath(path)
  if (!p) return false
  switch (p.tier) {
    case 't1':
      return scope.settings
    case 't2':
      return scope.keys
    case 't3':
      return scope.hosts
    case 't4':
      return false
    case 'acct':
      return true
  }
}

/** A deletion is an edit only where a value can be absent: an API key cleared, a host removed. */
function tombstonable(path: string): boolean {
  const p = parseItemPath(path)
  return p?.tier === 't2' || p?.tier === 't3'
}

/** Account preferences, held in hub-state.json (never Settings). Null: this device has no value yet. */
export interface HubPrefs {
  syncKeys: { on: boolean } | null
  deviceNames: { names: Record<string, string> } | null
}

/** One path's local value. `deleted` is a value that was synced before and is gone here now. */
export interface LocalValue {
  deleted: boolean
  value: unknown
}

/**
 * Every item this device would say is true right now, by path, for the tiers
 * in scope. `settings` must already have been through `hydrateSettings` once
 * more than the cache (gotcha 116): `hydrateSettings` is not idempotent, and a
 * value that moves on the next hydrate would be a phantom WRITE on every
 * device on every pass.
 */
export function localValues(f: {
  settings: Settings
  scope: SyncScope
  prefs: HubPrefs
  /** Host sync id → the T4 key ids it uses. */
  keyRefs: Record<string, string[]>
}): Map<string, LocalValue> {
  const out = new Map<string, LocalValue>()
  if (f.scope.settings) {
    const t1 = t1ValuesFrom(f.settings)
    for (const k of T1_KEYS) if (t1[k] !== undefined) out.set(`t1/settings/${k}`, { deleted: false, value: t1[k] })
  }
  if (f.scope.keys) {
    for (const [path, value] of Object.entries(t2ValuesFrom(f.settings))) {
      const item = `t2/secret/${path}`
      if (parseItemPath(item)) out.set(item, { deleted: false, value })
    }
  }
  if (f.scope.hosts) {
    for (const h of f.settings.hosts as SyncableHost[]) {
      if (!isId('host', h.syncId)) continue
      out.set(`t3/host/${h.syncId}`, { deleted: false, value: hostPayloadFor(h, { keyRefs: [...(f.keyRefs[h.syncId] ?? [])].sort() }) })
    }
  }
  if (f.prefs.syncKeys) out.set('acct/pref/sync-keys', { deleted: false, value: { on: f.prefs.syncKeys.on } })
  if (f.prefs.deviceNames) out.set('acct/pref/device-names', { deleted: false, value: { names: f.prefs.deviceNames.names } })
  return out
}

/**
 * The digest a value is compared by: the same bytes for the same value (keys
 * sorted at every depth, gotcha 116), and never the value itself, so
 * hub-state.json holds no key in the clear. The service hands in a KEYED
 * digest (HMAC under a per-device key sealed in hub-device.json): a plain
 * SHA-256 of a short secret — an MCP variable, a header — in an unsealed
 * file is a guess checked offline. Digests never leave the device, so the
 * key may differ on every one.
 */
export function valueDigest(digest: (text: string) => string, v: LocalValue): string {
  return digest(stableJson({ deleted: v.deleted, value: v.deleted ? null : v.value }))
}

/* ---------------------------------------------------- the device's record */

/** What this device last agreed with the hub about one path. */
export interface SyncedRecord {
  /** The opaque id the item sat under at `epoch` (ids change with the epoch). */
  id: string
  epoch: number
  version: number
  /** Digest of the value the HUB holds. */
  hash: string
  /**
   * Digest of this device's own value right after it agreed. Usually `hash`;
   * different when applying an item and hydrating it here moved it — and then
   * comparing the local value with `hash` would upload that difference forever.
   */
  localHash: string
  editedAt: number
  author: string
  deleted: boolean
}

/** One item as this device opened it from the hub. */
export interface RemoteItem {
  path: string
  id: string
  epoch: number
  version: number
  editedAt: number
  author: string
  /** Who wrote the value, when a re-seal put it under `author`'s name (`ItemPlaintext.by`). */
  by?: string
  deleted: boolean
  value: unknown
  /** `valueDigest` of `{ deleted, value }`. */
  hash: string
}

/* ------------------------------------------------------------ the plan */

export interface PlannedUpload {
  path: string
  local: LocalValue
  hash: string
  editedAt: number
  /** What the hub holds for this path now (the put goes on top of it when it is at the current epoch). */
  over: RemoteItem | null
}

export interface SyncPlan {
  /** Fold these into this device. */
  apply: RemoteItem[]
  /** Put these. */
  upload: PlannedUpload[]
  /** Same value both sides (or a re-sealed copy): only the record moves. */
  adopt: RemoteItem[]
  notes: ConflictNote[]
  /** The hybrid clock after this plan's edits. */
  lastEditedAt: number
}

/**
 * Decide one pass, path by path (spec §5.2).
 *
 * `local` is what this device holds, `remote` what the hub holds (latest
 * version per path, newest epoch first), `records` what the two last agreed.
 * A side "changed" when its digest moved from that agreement.
 *
 * - Neither changed: nothing, but a re-sealed copy (new epoch or id, same
 *   value) is adopted so the next put lands on the right slot.
 * - Only this device changed: upload.
 * - Only the hub changed: apply.
 * - Both, to the same value: adopt.
 * - Both, differently, having agreed before: a conflict. `decideConflict`
 *   (later edit time, then larger author id) picks the side, deterministically
 *   on every device, and a note names what lost.
 * - Never agreed (a device's first sync of that path): the hub's copy wins, so
 *   a device joining takes the account's settings instead of pushing its own
 *   defaults over everyone's — except that a TOMBSTONE never deletes a value
 *   this device holds and never agreed to lose: its key or host is uploaded
 *   again. Deletions reach only devices that had the value.
 *
 * `stamps` are the edit times the service noted when it first saw a local
 * change (a path's own time, while its digest still matches); anything
 * unstamped takes the hybrid clock now.
 */
export function planSync(f: {
  local: Map<string, LocalValue>
  remote: Map<string, RemoteItem>
  records: Record<string, SyncedRecord>
  scope: SyncScope
  me: string
  now: number
  lastEditedAt: number
  digest: (text: string) => string
  stamps?: Record<string, { editedAt: number; hash: string }>
  label?: (path: string) => string
}): SyncPlan {
  const plan: SyncPlan = { apply: [], upload: [], adopt: [], notes: [], lastEditedAt: f.lastEditedAt }
  const paths = new Set<string>([...f.local.keys(), ...f.remote.keys(), ...Object.keys(f.records)])
  const stampFor = (path: string, hash: string): number => {
    const s = f.stamps?.[path]
    const at = s && s.hash === hash ? Math.max(s.editedAt, 0) : nextEditedAt(f.now, plan.lastEditedAt)
    plan.lastEditedAt = Math.max(plan.lastEditedAt, at)
    return at
  }
  for (const path of [...paths].sort()) {
    if (!inScope(path, f.scope)) continue
    const R = f.remote.get(path) ?? null
    const S = f.records[path] ?? null
    let L = f.local.get(path) ?? null
    if (!L && tombstonable(path) && S && !S.deleted) L = { deleted: true, value: null }
    if (!L && !R) continue
    const lh = L ? valueDigest(f.digest, L) : null
    const localChanged = L !== null && (S ? lh !== S.localHash : !L.deleted)
    const remoteChanged = R !== null && (!S || R.hash !== S.hash)
    const upload = (editedAt: number): void => {
      plan.upload.push({ path, local: L as LocalValue, hash: lh as string, editedAt, over: R })
    }
    if (!localChanged && !remoteChanged) {
      if (R && S && (R.id !== S.id || R.version !== S.version || R.epoch !== S.epoch)) plan.adopt.push(R)
      continue
    }
    if (localChanged && !remoteChanged) {
      upload(stampFor(path, lh as string))
      continue
    }
    const r = R as RemoteItem
    if (!localChanged) {
      if (lh !== null && r.hash === lh) plan.adopt.push(r)
      else plan.apply.push(r)
      continue
    }
    if (r.hash === lh) {
      plan.adopt.push(r)
      continue
    }
    if (!S) {
      if (r.deleted) upload(stampFor(path, lh as string))
      else plan.apply.push(r)
      continue
    }
    const mine = { editedAt: stampFor(path, lh as string), author: f.me }
    const theirs = { editedAt: r.editedAt, author: r.author }
    plan.notes.push(conflictNote({ path, label: f.label?.(path), mine, theirs, now: f.now }))
    if (decideConflict(mine, theirs) === 'mine') upload(mine.editedAt)
    else plan.apply.push(r)
  }
  return plan
}

/**
 * What a person calls each synced setting, for conflict notes. The contract's
 * `itemLabel` names a T1 item by its key ("Setting “themeId”"), which is a
 * field name, not a sentence; anything not named here falls back to it.
 */
const SETTING_LABELS: Record<string, string> = {
  themeId: 'Theme',
  themeIdLight: 'Light theme',
  followSystemTheme: 'Follow the system theme',
  customThemes: 'Custom themes',
  fontFamily: 'Terminal font',
  fontSize: 'Font size',
  terminal: 'Terminal',
  zoomTarget: 'What zoom scales',
  fullScreenReveal: 'Full-screen menu bar',
  defaults: 'Session defaults',
  voice: 'Voice',
  profiles: 'Profiles',
  worklogGroups: 'Worklog folders',
  worklogAuto: 'Worklog auto-scan',
  betaUpdates: 'Beta updates',
  cliAutoUpdate: 'Claude Code updates',
  cliRelaunch: 'Relaunch after a CLI update',
  selfUpdateAuto: 'Stoke updates',
  worklogBoards: 'Worklog boards',
  hideStatusLine: 'Status line',
  showBrand: 'Brand mark',
  sshKeyEnroll: 'SSH key offers',
  notifications: 'Notifications',
  providers: 'Providers',
  agents: 'Agents',
  wallpaper: 'Wallpaper',
  browser: 'Browser home and bookmarks'
}

/** A human label for any item path; `host`/`sshKey` name those by the local host or key. */
export function syncLabel(path: string, names: { host?: (id: string) => string; sshKey?: (id: string) => string } = {}): string {
  const p = parseItemPath(path)
  if (p?.tier === 't1' && SETTING_LABELS[p.key]) return SETTING_LABELS[p.key]
  return itemLabel(path, names)
}

/** What `applySyncedSettings` takes, and the account preferences, from items to apply. */
export function incomingFrom(items: readonly RemoteItem[]): {
  incoming: SyncedIncoming
  prefs: Partial<HubPrefs>
  /** Host sync id → the key ids its payload names (kept for installing received keys). */
  keyRefs: Record<string, string[]>
} {
  const incoming: SyncedIncoming = {}
  const prefs: Partial<HubPrefs> = {}
  const keyRefs: Record<string, string[]> = {}
  for (const it of items) {
    const p = parseItemPath(it.path)
    if (!p) continue
    switch (p.tier) {
      case 't1':
        if (!it.deleted) (incoming.settings ??= {})[p.key] = it.value
        break
      case 't2':
        if (it.deleted) (incoming.secrets ??= {})[p.secretPath] = null
        else if (typeof it.value === 'string') (incoming.secrets ??= {})[p.secretPath] = it.value
        break
      case 't3': {
        if (it.deleted) {
          ;(incoming.hosts ??= {})[p.hostId] = null
          keyRefs[p.hostId] = []
          break
        }
        const payload = it.value as HostPayload
        if (!isRecord(payload) || !isRecord(payload.host)) break
        ;(incoming.hosts ??= {})[p.hostId] = payload
        keyRefs[p.hostId] = Array.isArray(payload.keyRefs) ? payload.keyRefs.filter((k) => isId('sshKey', k)) : []
        break
      }
      case 'acct':
        if (it.deleted || !isRecord(it.value)) break
        if (p.pref === 'sync-keys' && typeof it.value.on === 'boolean') prefs.syncKeys = { on: it.value.on }
        if (p.pref === 'device-names' && isRecord(it.value.names)) prefs.deviceNames = { names: cleanNames(it.value.names) }
        break
      case 't4':
        break
    }
  }
  return { incoming, prefs, keyRefs }
}

export const MAX_DEVICE_NAME_CHARS = 64

function cleanNames(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, name] of Object.entries(raw)) {
    if (!isId('device', id) || typeof name !== 'string') continue
    const t = name.trim()
    if (t) out[id] = [...t].slice(0, MAX_DEVICE_NAME_CHARS).join('')
  }
  return out
}

/* ------------------------------------------------ T4: SSH keys arriving */

export interface SshKeyInstallPlan {
  /** The private key's file name in `~/.ssh`. */
  name: string
  pubName: string
  /** `reuse`: an identical key is already there under this name; nothing is written. */
  action: 'write' | 'reuse'
}

/**
 * Where a received key goes (spec §5.4): `sshKeyTarget`'s rule — the wanted
 * name when free, the same name when an identical key is already there, else
 * `<name>-stoke-2`, `-3`… — for a payload that is a well-formed key. `probe`
 * must answer `free` only when neither `<name>` nor `<name>.pub` exists,
 * `same` only when `<name>` holds exactly this private key, and `different`
 * otherwise: a lone `.pub` is somebody's, and is never overwritten either.
 */
export function sshKeyInstallPlan(payload: unknown, probe: SshNameProbe): SshKeyInstallPlan | { error: string } {
  const problem = sshKeyPayloadProblem(payload)
  if (problem) return { error: `That key did not arrive whole (${problem}), so nothing was written.` }
  const p = payload as SshKeyPayload
  const t = sshKeyTarget(p.name, probe)
  if (!t) return { error: `There is no free name for ${p.name} in your SSH folder (tried ${p.name} to ${p.name}-stoke-99).` }
  return { name: t.name, pubName: `${t.name}.pub`, action: t.action }
}

/**
 * The hosts that should offer a received key: every local host whose synced
 * payload names it (`keyRefs`), by alias. Only hosts that carry a sync id —
 * a host this device never synced cannot have been named by another.
 */
export function hostsUsingKey(keyId: string, hosts: readonly SyncableHost[], keyRefs: Record<string, string[]>): SyncableHost[] {
  return hosts.filter((h) => isId('host', h.syncId) && (keyRefs[h.syncId as string] ?? []).includes(keyId))
}

/** `ssh-ed25519 AAAA… comment` → its type, base64 blob and comment, or null. */
export function parsePublicKeyLine(text: string): { type: string; blob: string; comment: string } | null {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  const m = /^([a-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/.exec(line)
  if (!m) return null
  return { type: m[1], blob: m[2], comment: (m[3] ?? '').trim() }
}

/** Whether `name` could be a private key's file in `~/.ssh` that the picker lists. */
export function isListableKeyName(name: string): boolean {
  return isSafeSshKeyName(name)
}

/* ------------------------------------------------ hub-state.json */

export const HUB_STATE_FILE = 'hub-state.json'
export const HUB_DEVICE_FILE = 'hub-device.json'
export const HUB_STATE_VERSION = 1

/** A key this device uploaded (T4), by key id. Never the key itself. */
export interface SharedKeyRecord {
  name: string
  fingerprint: string
  comment: string
  passphrase: boolean
  /** Where it was read from, so the list can say which file it is. */
  path: string
  at: number
}

/** A key another device shared, as the vault lists it: metadata only — the key itself is fetched at Install. */
export interface OfferedKeyRecord {
  name: string
  fingerprint: string
  comment: string
  passphrase: boolean
  /** The device that shared it. */
  from: string
  at: number
}

/** A key another device shared, as installed here. */
export interface ReceivedKeyRecord {
  /** The file it was written to (or found identical as), or null before Install. */
  installedAs: string | null
  at: number
  /** The hosts an `IdentityFile` line was added for. */
  hosts: string[]
}

export type HubAlarm = { kind: 'rollback' | 'fork' | 'version' | 'chain' | 'key'; message: string; at: number }

/**
 * Where THIS device entered the chain: the link hash of its own genesis, of
 * the `add` it accepted after the owner confirmed the pairing code here, or of
 * the `add` it signed with the Recovery Kit. A verified chain proves only that
 * its entries sign each other — a hub can build a whole one, genesis and all,
 * that lists this device by the public keys it posted at sign-in. So a device
 * counts itself in a vault only when the served chain holds this exact link
 * at this seq (`anchorHolds`), and the anchor is dropped only by signing out.
 */
export interface ChainAnchor {
  seq: number
  link: string
}

export function anchorHolds(links: readonly string[], anchor: ChainAnchor | null | undefined): boolean {
  return !!anchor && links[anchor.seq] === anchor.link
}

/**
 * Whether a served chain (its link hashes) is an EARLIER copy of the one this
 * device holds — every served entry the held one at its seq. The only chain a
 * device republishes over after a hub went back in time (spec §7.3); anything
 * else is a different list, and re-trusting it would be taking the hub's word.
 */
export function isPrefixOf(served: readonly string[], held: readonly string[]): boolean {
  return served.length <= held.length && served.every((link, i) => link === held[i])
}

/**
 * The devices that have had the CURRENT Recovery Kit in hand, by the chain:
 * the one that made it (genesis, or the `rotate` that named it — the Kit was
 * shown there, and "Save as file…" wrote it there), every device added with it
 * (`signer: 'recovery'`: it was typed there), and every device that signed a
 * revoke or rotate after it without replacing it (it was typed there too).
 * Any of them could open a new epoch's recovery wrap with it, so removing one
 * needs a NEW Kit (gotcha 141).
 */
export function kitHandlers(chain: readonly ChainEntry[]): string[] {
  let from = -1
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].recovery) {
      from = i
      break
    }
  }
  if (from < 0) return []
  const out = new Set<string>()
  if (chain[from].signer !== 'recovery') out.add(chain[from].signer)
  for (const e of chain.slice(from + 1)) {
    if (e.kind === 'add' && e.signer === 'recovery' && e.device) out.add(e.device.id)
    if ((e.kind === 'revoke' || e.kind === 'rotate') && e.signer !== 'recovery') out.add(e.signer)
  }
  return [...out].sort()
}

/**
 * A synced change that would change what runs on this computer (an MCP
 * server's command, a host's command), held back until the owner applies it
 * HERE (`applySyncedSettings`' `held`). Only the digest of what the hub holds
 * is kept; Apply fetches the item again and applies it only if it still is
 * that value.
 */
export interface HeldRecord {
  /** One Apply per group: `agents`, or a host's item path. */
  group: string
  hash: string
  /** What it runs, spelled out. Never a secret value (a variable is named, not shown). */
  lines: string[]
  /** The device that wrote it: the item's `by` when a re-seal carried it, else its author. */
  author: string
  /** The device that re-sealed it under its own name, when that is not `author`. */
  sealer?: string
  at: number
}

/* ------------------------------------------------ the change feed */

/**
 * Items per page the client asks for. Small enough that a page of the
 * largest items the contract allows (128 KiB of plaintext each) stays under
 * `HUB_RESPONSE_MAX_BYTES` in http.ts.
 */
export const ITEMS_PAGE = 64

/** Pages one walk of the feed may take: every item an account may hold, twice over. */
export const MAX_FEED_PAGES = Math.ceil((2 * HUB_LIMITS.itemsPerAccount) / ITEMS_PAGE)

/**
 * One step of a walk of the change feed, judged before the next request: a
 * hub that says `more` must move the cursor forward, and a walk ends within
 * `MAX_FEED_PAGES`. Otherwise it is a hub error, never another request — the
 * walk runs inside the one queue every hub action waits behind.
 */
export function feedStep(since: number, page: Record<string, unknown>, pages: number): { next: number; more: boolean } | { error: string } {
  const next = page.next === undefined ? since : page.next
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0) return { error: 'The hub answered a page of changes without a usable cursor.' }
  const more = page.more === true
  if (more && next <= since) return { error: 'The hub said there were more changes but did not move past the ones it had sent.' }
  if (next < since) return { error: 'The hub’s change feed went backwards.' }
  if (more && pages >= MAX_FEED_PAGES) return { error: `The hub kept saying there were more changes after ${MAX_FEED_PAGES} pages.` }
  return { next, more }
}

/** Everything the client keeps between syncs apart from its keys (hub-device.json). */
export interface HubLocalState {
  v: typeof HUB_STATE_VERSION
  /** The account these records belong to; a state for another is thrown away. */
  account: string
  /** The chain as last verified (public: device records and signatures). */
  chain: ChainEntry[]
  pinned: PinnedChain | null
  /** Where this device entered `chain` (`ChainAnchor`); null until it joins. */
  anchor: ChainAnchor | null
  /** The change feed's cursor. */
  cursor: number
  records: Record<string, SyncedRecord>
  /** Highest version seen per item id: a lower one served later is a rollback (spec §5.2). */
  seen: Record<string, number>
  lastEditedAt: number
  /** Local edits noticed but not yet agreed, with when (conflicts are decided by these times). */
  stamps: Record<string, { editedAt: number; hash: string }>
  notes: ConflictNote[]
  prefs: HubPrefs
  keyRefs: Record<string, string[]>
  /**
   * Vault keys per epoch, each sealed by the OS key store (base64 of
   * `safeStorage.encryptString`); main opens them. Never written unsealed.
   */
  vaultKeys: Record<string, string>
  /** A copy of the Kit's wrap per epoch (ciphertext), for republishing after a hub restore (spec §7.3). */
  recoveryWraps: Record<string, RecoveryWrap>
  shared: Record<string, SharedKeyRecord>
  offered: Record<string, OfferedKeyRecord>
  received: Record<string, ReceivedKeyRecord>
  /** Changes that would run something, held until applied here (item path → what). */
  held: Record<string, HeldRecord>
  /** The epoch whose items this device last carried forward from older ones (`carryForward`); 0 = none. */
  carriedEpoch: number
  /** The epoch this device's own key change closed and did not finish re-sealing; 0 = none owed. */
  resealOwed: number
  alarm: HubAlarm | null
  lastSyncAt: number | null
}

export function emptyHubState(account: string): HubLocalState {
  return {
    v: HUB_STATE_VERSION,
    account,
    chain: [],
    pinned: null,
    anchor: null,
    cursor: 0,
    records: {},
    seen: {},
    lastEditedAt: 0,
    stamps: {},
    notes: [],
    prefs: { syncKeys: null, deviceNames: null },
    keyRefs: {},
    vaultKeys: {},
    recoveryWraps: {},
    shared: {},
    offered: {},
    received: {},
    held: {},
    carriedEpoch: 0,
    resealOwed: 0,
    alarm: null,
    lastSyncAt: null
  }
}

const num = (v: unknown, dflt = 0): number => (isNonNegInt(v) ? v : dflt)
const str = (v: unknown, max = 512): string => (typeof v === 'string' ? v.slice(0, max) : '')

function hydrateRecord(v: unknown): SyncedRecord | null {
  if (!isRecord(v) || !isItemId(v.id) || !isNonNegInt(v.epoch) || v.epoch < 1 || !isNonNegInt(v.version)) return null
  if (typeof v.hash !== 'string' || typeof v.localHash !== 'string') return null
  return {
    id: v.id,
    epoch: v.epoch,
    version: v.version,
    hash: v.hash,
    localHash: v.localHash,
    editedAt: num(v.editedAt),
    author: isId('device', v.author) ? v.author : '',
    deleted: v.deleted === true
  }
}

function hydrateNote(v: unknown): ConflictNote | null {
  if (!isRecord(v) || typeof v.path !== 'string' || !parseItemPath(v.path)) return null
  if (v.kept !== 'mine' && v.kept !== 'theirs') return null
  return {
    path: v.path,
    label: str(v.label, 200) || itemLabel(v.path),
    kept: v.kept,
    otherDevice: str(v.otherDevice, 64),
    otherEditedAt: num(v.otherEditedAt),
    mineEditedAt: num(v.mineEditedAt),
    at: num(v.at)
  }
}

/** Notes kept, newest last; older ones fall off. */
export const MAX_CONFLICT_NOTES = 50

/**
 * Repair a stored state. Rebuilt from named keys; anything malformed is
 * dropped (a dropped record only means that path is compared afresh — the
 * hub's copy wins the first meeting, never a silent push). A state for
 * another account, or of another version, starts empty.
 */
export function hydrateHubState(raw: unknown, account: string): HubLocalState {
  const out = emptyHubState(account)
  if (!isRecord(raw) || raw.v !== HUB_STATE_VERSION || raw.account !== account) return out
  if (Array.isArray(raw.chain) && raw.chain.every((e) => chainEntryProblem(e) === null)) out.chain = raw.chain as ChainEntry[]
  if (isRecord(raw.pinned) && isNonNegInt(raw.pinned.seq) && isB64u(raw.pinned.head, 32)) out.pinned = { seq: raw.pinned.seq, head: raw.pinned.head }
  if (isRecord(raw.anchor) && isNonNegInt(raw.anchor.seq) && isB64u(raw.anchor.link, 32)) out.anchor = { seq: raw.anchor.seq, link: raw.anchor.link }
  out.cursor = num(raw.cursor)
  if (isRecord(raw.records)) {
    for (const [path, r] of Object.entries(raw.records)) {
      const rec = parseItemPath(path) ? hydrateRecord(r) : null
      if (rec) out.records[path] = rec
    }
  }
  if (isRecord(raw.seen)) for (const [id, v] of Object.entries(raw.seen)) if (isItemId(id) && isNonNegInt(v)) out.seen[id] = v
  out.lastEditedAt = num(raw.lastEditedAt)
  if (isRecord(raw.stamps)) {
    for (const [path, s] of Object.entries(raw.stamps)) {
      if (parseItemPath(path) && isRecord(s) && isNonNegInt(s.editedAt) && typeof s.hash === 'string') out.stamps[path] = { editedAt: s.editedAt, hash: s.hash }
    }
  }
  if (Array.isArray(raw.notes)) out.notes = raw.notes.map(hydrateNote).filter((n): n is ConflictNote => n !== null).slice(-MAX_CONFLICT_NOTES)
  if (isRecord(raw.prefs)) {
    const p = raw.prefs
    if (isRecord(p.syncKeys) && typeof p.syncKeys.on === 'boolean') out.prefs.syncKeys = { on: p.syncKeys.on }
    if (isRecord(p.deviceNames) && isRecord(p.deviceNames.names)) out.prefs.deviceNames = { names: cleanNames(p.deviceNames.names) }
  }
  if (isRecord(raw.keyRefs)) {
    for (const [h, ks] of Object.entries(raw.keyRefs)) {
      if (isId('host', h) && Array.isArray(ks)) out.keyRefs[h] = ks.filter((k): k is string => isId('sshKey', k))
    }
  }
  if (isRecord(raw.vaultKeys)) {
    for (const [e, sealed] of Object.entries(raw.vaultKeys)) if (/^[1-9]\d{0,5}$/.test(e) && typeof sealed === 'string' && sealed) out.vaultKeys[e] = sealed
  }
  if (isRecord(raw.recoveryWraps)) {
    for (const [e, w] of Object.entries(raw.recoveryWraps)) {
      if (/^[1-9]\d{0,5}$/.test(e) && isRecord(w) && w.v === 1 && isB64u(w.nonce, 12) && typeof w.ct === 'string') {
        out.recoveryWraps[e] = { v: 1, nonce: w.nonce, ct: w.ct }
      }
    }
  }
  if (isRecord(raw.shared)) {
    for (const [k, s] of Object.entries(raw.shared)) {
      if (!isId('sshKey', k) || !isRecord(s) || !isSafeSshKeyName(s.name)) continue
      out.shared[k] = { name: s.name, fingerprint: str(s.fingerprint, 128), comment: str(s.comment, 256), passphrase: s.passphrase === true, path: str(s.path, 1024), at: num(s.at) }
    }
  }
  if (isRecord(raw.offered)) {
    for (const [k, o] of Object.entries(raw.offered)) {
      if (!isId('sshKey', k) || !isRecord(o) || !isSafeSshKeyName(o.name)) continue
      out.offered[k] = {
        name: o.name,
        fingerprint: str(o.fingerprint, 128),
        comment: str(o.comment, 256),
        passphrase: o.passphrase === true,
        from: isId('device', o.from) ? o.from : '',
        at: num(o.at)
      }
    }
  }
  if (isRecord(raw.received)) {
    for (const [k, r] of Object.entries(raw.received)) {
      if (!isId('sshKey', k) || !isRecord(r)) continue
      out.received[k] = {
        installedAs: typeof r.installedAs === 'string' && isSafeSshKeyName(r.installedAs) ? r.installedAs : null,
        at: num(r.at),
        hosts: Array.isArray(r.hosts) ? r.hosts.filter((h): h is string => typeof h === 'string').slice(0, 64) : []
      }
    }
  }
  if (isRecord(raw.held)) {
    for (const [path, h] of Object.entries(raw.held)) {
      if (!parseItemPath(path) || !isRecord(h) || typeof h.group !== 'string' || typeof h.hash !== 'string' || !Array.isArray(h.lines)) continue
      out.held[path] = {
        group: str(h.group, 256),
        hash: str(h.hash, 128),
        lines: h.lines.filter((l): l is string => typeof l === 'string').slice(0, 32).map((l) => l.slice(0, 1000)),
        author: isId('device', h.author) ? h.author : '',
        ...(isId('device', h.sealer) && h.sealer !== h.author ? { sealer: h.sealer as string } : {}),
        at: num(h.at)
      }
    }
  }
  out.carriedEpoch = num(raw.carriedEpoch)
  out.resealOwed = num(raw.resealOwed)
  if (isRecord(raw.alarm) && typeof raw.alarm.message === 'string' && ['rollback', 'fork', 'version', 'chain', 'key'].includes(raw.alarm.kind as string)) {
    out.alarm = { kind: raw.alarm.kind as HubAlarm['kind'], message: str(raw.alarm.message, 1000), at: num(raw.alarm.at) }
  }
  out.lastSyncAt = isNonNegInt(raw.lastSyncAt) ? raw.lastSyncAt : null
  return out
}

/* ------------------------------------------------ the panel's view */

/**
 * - `off`: no hub address yet.
 * - `signed-out`: an address, no session.
 * - `new-account`: signed in to an account with no vault yet — create it (and its Recovery Kit).
 * - `locked`: signed in, but this device holds no vault key: join by approval or the Kit.
 * - `active`: in the vault; syncing.
 * - `revoked`: another device removed this one.
 */
export type HubPhase = 'off' | 'signed-out' | 'new-account' | 'locked' | 'active' | 'revoked'

export interface HubDeviceView {
  id: string
  /** The owner's name for it (`device-names`), else the label it joined with. */
  label: string
  platform: string
  addedAt: number
  me: boolean
  online: boolean
  /** A short fingerprint of its signing key, for telling two devices of one name apart. */
  fingerprint: string
  /** It made the current Recovery Kit, or had it typed on it (`kitHandlers`): removing it needs a new Kit. */
  kitSeen: boolean
}

/** A request from a new device, as an ACTIVE device sees it. */
export interface HubPairView {
  pair: string
  state: PairState
  device: { id: string; label: string; platform: string }
  createdAt: number
  expiresAt: number
  /** The six digits, once both nonces are in and the reveal checked out here; null before. */
  code: string | null
  /** This device answered it (posted its nonce). */
  mine: boolean
}

/** This device's own request to join, as it waits. */
export interface HubJoinView {
  pair: string
  state: PairState
  code: string | null
  /** The owner said on THIS device that the codes match; until then nothing is taken, approved or not. */
  confirmed: boolean
  expiresAt: number
  approver: string | null
  message: string | null
}

/** A held change as the panel lists it: one card per group, one Apply. */
export interface HubHeldView {
  group: string
  label: string
  /** The device whose change it is. */
  from: string
  lines: string[]
  at: number
}

export interface HubSshKeyView {
  keyId: string
  name: string
  fingerprint: string
  comment: string
  passphrase: boolean
  /** The device that shared it. */
  from: string
  mine: boolean
  /** Where it is on THIS device: the file name, or null (not installed here). */
  installedAs: string | null
  /** Aliases of the synced hosts that use it. */
  hosts: string[]
}

/** A key pair in this device's `~/.ssh` the picker can offer. Names and fingerprints only. */
export interface HubLocalKeyView {
  name: string
  type: string
  comment: string
  fingerprint: string
  /** The T4 key id when shared from this device. */
  shared: string | null
}

export interface HubView {
  phase: HubPhase
  url: string
  urlWarning: string | null
  email: string
  role: 'owner' | 'member' | null
  device: { id: string; label: string; platform: string } | null
  /** Whether this run's key store may hold vault keys (Linux `basic_text` may not). */
  keyStore: { protected: boolean; why: string }
  /** What main is doing right now, for the busy line; null when idle. */
  busy: string | null
  lastSyncAt: number | null
  error: { message: string; at: number; retryAt: number | null } | null
  scope: SyncScope & { keysDevice: boolean }
  /** The account's `sync-keys` switch; null before anyone set it. */
  accountKeys: boolean | null
  counts: { settings: number; keys: number; hosts: number; sshKeys: number }
  epoch: number
  devices: HubDeviceView[]
  pairs: HubPairView[]
  join: HubJoinView | null
  notes: ConflictNote[]
  sshKeys: HubSshKeyView[]
  alarm: HubAlarm | null
  /** Synced changes that would run something here, waiting for Apply. */
  held: HubHeldView[]
  /** A new vault (or a new Kit) is waiting for its Recovery Kit to be confirmed. */
  kitPending: boolean
  /**
   * After removing a device: what it held, to rotate by hand, and what synced
   * here runs something — it could have changed those before it was removed.
   */
  revokeReport: { device: string; keys: string[]; sshKeys: string[]; commands: string[] } | null
}

/** A fresh, empty view (the panel's first paint before main answers). */
export function emptyHubView(): HubView {
  return {
    phase: 'off',
    url: '',
    urlWarning: null,
    email: '',
    role: null,
    device: null,
    keyStore: { protected: true, why: '' },
    busy: null,
    lastSyncAt: null,
    error: null,
    scope: { settings: true, hosts: true, keys: false, keysDevice: true },
    accountKeys: null,
    counts: { settings: 0, keys: 0, hosts: 0, sshKeys: 0 },
    epoch: 0,
    devices: [],
    pairs: [],
    join: null,
    notes: [],
    sshKeys: [],
    alarm: null,
    held: [],
    kitPending: false,
    revokeReport: null
  }
}

/** Items per tier among the records (live ones only), for the panel's counts. */
export function recordCounts(records: Record<string, SyncedRecord>): HubView['counts'] {
  const c = { settings: 0, keys: 0, hosts: 0, sshKeys: 0 }
  for (const [path, r] of Object.entries(records)) {
    if (r.deleted) continue
    const p = parseItemPath(path)
    if (p?.tier === 't1') c.settings++
    else if (p?.tier === 't2') c.keys++
    else if (p?.tier === 't3') c.hosts++
    else if (p?.tier === 't4') c.sshKeys++
  }
  return c
}

/** What every hub action answers the panel: ok (with extras), or one sentence to show. */
export type HubResult<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string }

/** The default hub (the owner's NUC behind stoke.vinn.dev). Editable in the panel. */
export const DEFAULT_HUB_URL = 'https://stoke.vinn.dev/hub'

/** Background sync: how often when all is well, and the backoff after failures. */
export const SYNC_INTERVAL_MS = 5 * 60_000
export const SYNC_BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000] as const
/** A change in Settings is uploaded this long after it settles. */
export const SYNC_DEBOUNCE_MS = 3_000

/** The wait before the next background attempt after `failures` failures in a row (0 = none). */
export function nextSyncDelay(failures: number): number {
  if (failures <= 0) return SYNC_INTERVAL_MS
  return SYNC_BACKOFF_MS[Math.min(failures, SYNC_BACKOFF_MS.length) - 1]
}
