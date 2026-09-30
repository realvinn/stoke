/*
 * The signed device list: which devices hold the account's vault key, as an
 * append-only chain the hub stores and cannot extend.
 *
 * Every client verifies the whole chain on every sync and pins its head; the
 * hub serialises appends and checks the same rules before storing one (it runs
 * this very function), but a client never trusts that it did. The signature
 * and hash functions are INJECTED, so this module stays pure (gotcha 27) and
 * the same rules run in main (node:crypto), on the hub, and in verify:hub with
 * real Ed25519 or a fake.
 *
 * Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md §4.3.
 */
import { isB64u, isId, isNonNegInt, isRecord, labelled } from './codec.ts'
import { HUB_LABELS } from './labels.ts'

/** What a device may do. Every desktop gets all three; a phone later gets no `vault`. */
export type DeviceCap = 'vault' | 'remote-host' | 'remote-guest'
export const DEVICE_CAPS: readonly DeviceCap[] = ['vault', 'remote-host', 'remote-guest']

/** One device as the chain records it. `sign`/`box` are b64url raw 32-byte public keys. */
export interface DeviceRecord {
  id: string
  /** What the owner calls it ("Vinh's MacBook"). Plaintext to the hub, a self-hosted simplification. */
  label: string
  /** `process.platform` of the device. */
  platform: string
  /** Ed25519 public key. */
  sign: string
  /** X25519 public key. */
  box: string
  caps: DeviceCap[]
  /** ms since epoch, by the adding device's clock (informational). */
  addedAt: number
}

export type ChainKind = 'genesis' | 'add' | 'revoke' | 'rotate'

export interface ChainEntry {
  v: 1
  account: string
  seq: number
  /** `chainLinkHash` of the previous entry; '' for genesis. */
  prev: string
  kind: ChainKind
  /** The vault epoch in force AFTER this entry. */
  epoch: number
  /** ms since epoch, signer's clock (informational; never compared). */
  ts: number
  /** A device id active at this point, or 'recovery'. */
  signer: string
  /** genesis, add: the device added. */
  device?: DeviceRecord
  /** revoke: the device revoked. */
  target?: string
  /** genesis (required), rotate (optional): the Recovery Kit's Ed25519 public key. */
  recovery?: string
  /**
   * genesis, revoke, rotate (required; never on an add): b64url commitment to
   * the vault key of the epoch this entry opens (crypto.ts `vaultKeyCommit`).
   * A vault-key wrap is an anonymous box — anyone holding a device's public
   * box key can make one, of a key they chose — so a device refuses any key
   * it unwraps that this signed value does not vouch for. Without it the hub
   * could plant a key it knows on every device that joins or fetches a new
   * epoch, and read everything they seal after.
   */
  vk?: string
  /** b64url Ed25519 signature over `chainSigningText(entry)`. */
  sig: string
}

/** The kinds that open an epoch, and so must commit to its vault key. */
export function opensEpoch(kind: ChainKind): boolean {
  return kind === 'genesis' || kind === 'revoke' || kind === 'rotate'
}

export const MAX_LABEL_CHARS = 64
export const MAX_PLATFORM_CHARS = 24

/** Crypto the chain rules need, supplied by the caller. */
export interface ChainCrypto {
  /** Ed25519 verify: `pub` and `sig` b64url, `text` signed as UTF-8. */
  verify(pub: string, text: string, sig: string): boolean
  /** b64url SHA-256 of `text` as UTF-8. */
  digest(text: string): string
}

/** The text a chain entry's signature covers: everything but `sig`. */
export function chainSigningText(entry: Omit<ChainEntry, 'sig'> & { sig?: string }): string {
  const { sig: _sig, ...rest } = entry
  return labelled(HUB_LABELS.chain, rest as Record<string, unknown>)
}

/** The text whose digest is the next entry's `prev`: the whole entry, signature included. */
export function chainLinkText(entry: ChainEntry): string {
  return labelled(HUB_LABELS.chainLink, entry as unknown as Record<string, unknown>)
}

/** Why a device record is malformed, or null. */
export function deviceRecordProblem(d: unknown): string | null {
  if (!isRecord(d)) return 'not an object'
  if (!isId('device', d.id)) return 'bad device id'
  if (typeof d.label !== 'string' || d.label.trim() === '' || [...d.label].length > MAX_LABEL_CHARS) return 'bad label'
  if (typeof d.platform !== 'string' || !/^[a-z0-9]{1,24}$/.test(d.platform)) return 'bad platform'
  if (!isB64u(d.sign, 32)) return 'bad signing key'
  if (!isB64u(d.box, 32)) return 'bad box key'
  if (d.sign === d.box) return 'signing and box keys are the same bytes'
  if (!Array.isArray(d.caps) || d.caps.some((c) => !DEVICE_CAPS.includes(c as DeviceCap))) return 'bad caps'
  if (new Set(d.caps).size !== d.caps.length) return 'repeated cap'
  if (!isNonNegInt(d.addedAt)) return 'bad addedAt'
  const allowed = new Set(['id', 'label', 'platform', 'sign', 'box', 'caps', 'addedAt'])
  if (Object.keys(d).some((k) => !allowed.has(k))) return 'unknown field'
  return null
}

/** Why an entry is malformed on its own (before any chain rule), or null. */
export function chainEntryProblem(e: unknown): string | null {
  if (!isRecord(e)) return 'not an object'
  if (e.v !== 1) return 'unknown version'
  if (!isId('account', e.account)) return 'bad account'
  if (!isNonNegInt(e.seq)) return 'bad seq'
  if (typeof e.prev !== 'string' || (e.prev !== '' && !isB64u(e.prev, 32))) return 'bad prev'
  if (e.kind !== 'genesis' && e.kind !== 'add' && e.kind !== 'revoke' && e.kind !== 'rotate') return 'bad kind'
  if (!isNonNegInt(e.epoch) || e.epoch < 1) return 'bad epoch'
  if (!isNonNegInt(e.ts)) return 'bad ts'
  if (e.signer !== 'recovery' && !isId('device', e.signer)) return 'bad signer'
  if (!isB64u(e.sig, 64)) return 'bad signature encoding'
  const allowed = new Set(['v', 'account', 'seq', 'prev', 'kind', 'epoch', 'ts', 'signer', 'device', 'target', 'recovery', 'vk', 'sig'])
  if (Object.keys(e).some((k) => !allowed.has(k))) return 'unknown field'
  if (opensEpoch(e.kind as ChainKind)) {
    if (!isB64u(e.vk, 32)) return `${e.kind as string} without a vault key commitment`
  } else if (e.vk !== undefined) return 'vault key commitment on an add'
  const needsDevice = e.kind === 'genesis' || e.kind === 'add'
  if (needsDevice) {
    const p = deviceRecordProblem(e.device)
    if (p) return `device: ${p}`
  } else if (e.device !== undefined) return 'device on a non-add entry'
  if (e.kind === 'revoke') {
    if (!isId('device', e.target)) return 'revoke without a target'
  } else if (e.target !== undefined) return 'target on a non-revoke entry'
  if (e.kind === 'genesis') {
    if (!isB64u(e.recovery, 32)) return 'genesis without a recovery key'
  } else if (e.kind === 'rotate') {
    if (e.recovery !== undefined && !isB64u(e.recovery, 32)) return 'bad recovery key'
  } else if (e.recovery !== undefined) return 'recovery key on an add or revoke'
  return null
}

export type ChainVerdict =
  | {
      ok: true
      /** seq of the last entry. */
      seq: number
      /** `chainLinkHash` of the last entry: what a client pins. */
      head: string
      /** `links[i]` is the link hash of entry i. */
      links: string[]
      epoch: number
      /** Active devices after the last entry, in the order they were added. */
      active: DeviceRecord[]
      /** Every id ever revoked. */
      revoked: string[]
      /** The recovery key in force. */
      recovery: string
      /**
       * `vkCommits[e]`: the commitment to epoch e's vault key, from the entry
       * that opened e. Hand it to `unwrapVaultKey`/`openRecoveryWrap`, which
       * refuse a key it does not vouch for — take it from THIS verified chain,
       * never from anything the hub says beside it.
       */
      vkCommits: Record<number, string>
    }
  | { ok: false; at: number; reason: string }

/**
 * Verify a whole chain from genesis.
 *
 * - entry 0 is `genesis`, seq 0, prev '', epoch 1, self-signed by the device
 *   it adds, naming a recovery key;
 * - every later entry has seq = index, prev = the previous entry's link hash,
 *   and the same account;
 * - its signer is a device active at that point, or 'recovery' verified
 *   against the recovery key in force;
 * - `add` introduces an id never seen before (active or revoked) and keeps
 *   the epoch; `revoke` removes an active device and increments the epoch;
 *   `rotate` increments the epoch and may replace the recovery key;
 * - genesis, revoke and rotate each commit to the vault key of the epoch they
 *   open (`vk`, returned as `vkCommits`); an add carries none;
 * - a device may not be added whose signing key an earlier device used, so
 *   one key is never two devices.
 */
export function verifyChain(entries: readonly unknown[], crypto: ChainCrypto, opts: { account?: string } = {}): ChainVerdict {
  if (!Array.isArray(entries) || entries.length === 0) return { ok: false, at: 0, reason: 'empty chain' }
  const active = new Map<string, DeviceRecord>()
  const seen = new Set<string>()
  const seenKeys = new Set<string>()
  const revoked: string[] = []
  const links: string[] = []
  const vkCommits: Record<number, string> = {}
  let recovery = ''
  let epoch = 0
  let account = ''
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i]
    const problem = chainEntryProblem(raw)
    if (problem) return { ok: false, at: i, reason: problem }
    const e = raw as ChainEntry
    if (e.seq !== i) return { ok: false, at: i, reason: 'seq out of order' }
    if (i === 0) {
      if (e.kind !== 'genesis') return { ok: false, at: 0, reason: 'first entry is not genesis' }
      if (e.prev !== '') return { ok: false, at: 0, reason: 'genesis has a prev' }
      if (e.epoch !== 1) return { ok: false, at: 0, reason: 'genesis epoch is not 1' }
      if (opts.account !== undefined && e.account !== opts.account) return { ok: false, at: 0, reason: 'another account' }
      const d = e.device as DeviceRecord
      if (e.signer !== d.id) return { ok: false, at: 0, reason: 'genesis is not self-signed' }
      if (!crypto.verify(d.sign, chainSigningText(e), e.sig)) return { ok: false, at: 0, reason: 'bad signature' }
      account = e.account
      recovery = e.recovery as string
      epoch = 1
      vkCommits[1] = e.vk as string
      active.set(d.id, d)
      seen.add(d.id)
      seenKeys.add(d.sign)
      links.push(crypto.digest(chainLinkText(e)))
      continue
    }
    if (e.kind === 'genesis') return { ok: false, at: i, reason: 'second genesis' }
    if (e.account !== account) return { ok: false, at: i, reason: 'another account' }
    if (e.prev !== links[i - 1]) return { ok: false, at: i, reason: 'prev does not link' }
    // Who signed it, judged BEFORE this entry changes anything.
    const signerKey = e.signer === 'recovery' ? recovery : active.get(e.signer)?.sign
    if (!signerKey) return { ok: false, at: i, reason: 'signer is not active' }
    if (!crypto.verify(signerKey, chainSigningText(e), e.sig)) return { ok: false, at: i, reason: 'bad signature' }
    switch (e.kind) {
      case 'add': {
        const d = e.device as DeviceRecord
        if (seen.has(d.id)) return { ok: false, at: i, reason: 'device id used before' }
        if (seenKeys.has(d.sign)) return { ok: false, at: i, reason: 'signing key used before' }
        if (e.epoch !== epoch) return { ok: false, at: i, reason: 'add changed the epoch' }
        active.set(d.id, d)
        seen.add(d.id)
        seenKeys.add(d.sign)
        break
      }
      case 'revoke': {
        const t = e.target as string
        if (!active.has(t)) return { ok: false, at: i, reason: 'revoked device is not active' }
        if (e.epoch !== epoch + 1) return { ok: false, at: i, reason: 'revoke must increment the epoch' }
        active.delete(t)
        revoked.push(t)
        epoch = e.epoch
        vkCommits[epoch] = e.vk as string
        break
      }
      case 'rotate': {
        if (e.epoch !== epoch + 1) return { ok: false, at: i, reason: 'rotate must increment the epoch' }
        epoch = e.epoch
        vkCommits[epoch] = e.vk as string
        if (e.recovery) recovery = e.recovery
        break
      }
    }
    links.push(crypto.digest(chainLinkText(e)))
  }
  return {
    ok: true,
    seq: entries.length - 1,
    head: links[links.length - 1],
    links,
    epoch,
    active: [...active.values()],
    revoked,
    recovery,
    vkCommits
  }
}

/** What a client pins after verifying: where the chain was when it last agreed. */
export interface PinnedChain {
  seq: number
  head: string
}

/**
 * How a freshly verified chain relates to the one this device pinned.
 * `rollback` (shorter) and `fork` (a different entry at a pinned seq) are an
 * alarm, never applied silently — a restored hub looks like `rollback` too,
 * and the owner decides (spec §7.3).
 */
export function compareToPinned(pinned: PinnedChain | null, links: readonly string[]): 'new' | 'same' | 'extends' | 'rollback' | 'fork' {
  if (!pinned) return 'new'
  const last = links.length - 1
  if (last < pinned.seq) return 'rollback'
  if (links[pinned.seq] !== pinned.head) return 'fork'
  return last === pinned.seq ? 'same' : 'extends'
}

/**
 * The devices a `revoke` or `rotate` must upload wraps for, in the same
 * request, for its new epoch: every device active after it. The hub refuses
 * the append unless the wraps cover exactly these (plus the recovery wrap),
 * so no remaining device is ever left without the new key.
 */
export function wrapsRequiredAfter(verdict: Extract<ChainVerdict, { ok: true }>): string[] {
  return verdict.active.filter((d) => d.caps.includes('vault')).map((d) => d.id)
}
