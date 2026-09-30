/*
 * Joining a device to the vault, and getting back in without one.
 *
 * Pairing is numeric comparison with a commitment (spec §4.4): the new device
 * commits to its keys and nonce, the approving device answers with its own
 * nonce, the new device reveals, and both screens show six digits cut from a
 * hash over both devices' keys and both nonces. The owner presses Approve
 * only when the two match. A hub in the middle had to fix its own values
 * before the last random one was known, so it gets one guess in a million.
 * node:crypto has no PAKE; this needs only SHA-256.
 *
 * The Recovery Kit is 16 random bytes a person can copy onto paper and type
 * back: Crockford base32 with a mod-37 check symbol, so a typo is caught
 * before any key is derived.
 *
 * Pure (gotcha 27); the hash is computed by the caller and handed in.
 */
import {
  base32Decode,
  base32Encode,
  base32Length,
  checkSymbol,
  groupsOf,
  isB64u,
  isId,
  isRecord,
  labelled,
  normalizeBase32
} from './codec.ts'
import { deviceRecordProblem, type DeviceRecord } from './chain.ts'
import { HUB_LABELS } from './labels.ts'

/** A pairing request lives this long from the new device's first post. */
export const PAIR_TTL_MS = 10 * 60_000
/** Bytes of each side's pairing nonce. */
export const PAIR_NONCE_BYTES = 32
/** Mismatched or refused pairs a pending device may make in an hour before the hub refuses more. */
export const PAIR_ATTEMPTS_PER_HOUR = 3

/**
 * `waiting`  the new device posted its commitment
 * `nonce`    an approver posted its nonce and id
 * `revealed` the new device posted its record and nonce; the codes can be compared
 * `approved` the approver's `add` entry landed
 * `refused`  either side said no, or the commitment did not check out
 * `expired`  PAIR_TTL_MS passed first
 */
export type PairState = 'waiting' | 'nonce' | 'revealed' | 'approved' | 'refused' | 'expired'
export type PairEvent = 'nonce' | 'reveal' | 'approve' | 'refuse' | 'expire'

/** The hub's state machine for one pair. Null: that event is not allowed now (409). */
export function pairTransition(state: PairState, event: PairEvent): PairState | null {
  if (state === 'approved' || state === 'refused' || state === 'expired') return null
  switch (event) {
    case 'nonce':
      return state === 'waiting' ? 'nonce' : null
    case 'reveal':
      return state === 'nonce' ? 'revealed' : null
    case 'approve':
      return state === 'revealed' ? 'approved' : null
    case 'refuse':
      return 'refused'
    case 'expire':
      return 'expired'
  }
}

/** The part of a device record the pairing texts bind. */
function keysOf(d: Pick<DeviceRecord, 'id' | 'sign' | 'box'>): { id: string; sign: string; box: string } {
  return { id: d.id, sign: d.sign, box: d.box }
}

/**
 * What the new device hashes into its commitment: its whole record (so the
 * label and caps it will be added with are fixed too) and its nonce.
 */
export function pairCommitText(f: { account: string; device: DeviceRecord; nonce: string }): string {
  return labelled(HUB_LABELS.pairCommit, { account: f.account, device: f.device, nonce: f.nonce })
}

/** What both screens' code is cut from. */
export function pairSasText(f: {
  account: string
  pair: string
  device: Pick<DeviceRecord, 'id' | 'sign' | 'box'>
  approver: Pick<DeviceRecord, 'id' | 'sign' | 'box'>
  nonceN: string
  nonceE: string
}): string {
  return labelled(HUB_LABELS.pairSas, {
    account: f.account,
    pair: f.pair,
    device: keysOf(f.device),
    approver: keysOf(f.approver),
    nonceN: f.nonceN,
    nonceE: f.nonceE
  })
}

/**
 * Six digits from a SHA-256 digest: the first four bytes as a big-endian
 * unsigned integer, mod 10^6, zero-padded, shown `482 915`. The bias of
 * 2^32 mod 10^6 is under one part in four thousand.
 */
export function sasDigits(digest: Uint8Array): string {
  if (digest.length < 4) throw new Error('sasDigits needs a digest')
  const n = ((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3]
  const s = String(n % 1_000_000).padStart(6, '0')
  return `${s.slice(0, 3)} ${s.slice(3)}`
}

/** Why a reveal is not acceptable, or null. `commitDigest` is b64url SHA-256 of `pairCommitText` over the reveal. */
export function revealProblem(f: {
  commit: string
  commitDigest: string
  device: unknown
  nonce: unknown
  pendingDevice: string
}): string | null {
  const p = deviceRecordProblem(f.device)
  if (p) return `device: ${p}`
  if (!isB64u(f.nonce, PAIR_NONCE_BYTES)) return 'bad nonce'
  if ((f.device as DeviceRecord).id !== f.pendingDevice) return 'the reveal names another device'
  if (f.commit !== f.commitDigest) return 'the reveal does not match the commitment'
  return null
}

/* --------------------------------------------------------- Recovery Kit */

export const RECOVERY_PREFIX = 'RK1'
export const RECOVERY_BYTES = 16

/** `RK1-` then 26 base32 characters and the check symbol, in groups of four. */
export function formatRecoverySecret(secret: Uint8Array): string {
  if (secret.length !== RECOVERY_BYTES) throw new Error('a recovery secret is 16 bytes')
  return `${RECOVERY_PREFIX}-${groupsOf(base32Encode(secret) + checkSymbol(secret), 4)}`
}

export type RecoveryParse =
  | { ok: true; secret: Uint8Array }
  | { ok: false; problem: 'length' | 'characters' | 'check'; message: string }

/**
 * Read a typed Kit back. Case, spaces, hyphens, the `RK1` prefix and
 * Crockford's look-alikes (O for 0, I or L for 1) are forgiven; a wrong check
 * symbol is a typo, reported before any key is derived.
 */
export function parseRecoverySecret(text: string): RecoveryParse {
  let t = normalizeBase32(typeof text === 'string' ? text : '')
  const want = base32Length(RECOVERY_BYTES) + 1
  // Stripped after normalising, and only when the length says a prefix is
  // there: `rkl`/`RKI` normalise to `RK1`, and a Kit typed without its prefix
  // could itself begin with those three characters.
  if (t.length === want + RECOVERY_PREFIX.length && t.startsWith(normalizeBase32(RECOVERY_PREFIX))) {
    t = t.slice(RECOVERY_PREFIX.length)
  }
  if (t.length !== want) {
    return { ok: false, problem: 'length', message: `A Recovery Kit code has ${want} characters after “${RECOVERY_PREFIX}”.` }
  }
  const body = t.slice(0, -1)
  const check = t.slice(-1)
  const secret = base32Decode(body, RECOVERY_BYTES)
  if (!secret) {
    return { ok: false, problem: 'characters', message: 'That code has a character a Recovery Kit never uses.' }
  }
  if (checkSymbol(secret) !== check) {
    return { ok: false, problem: 'check', message: 'That code has a typo in it: its last character does not match the rest.' }
  }
  return { ok: true, secret }
}

/* ----------------------------------------------------- the pair record */

/** One pair as the hub serves it (`GET /v1/pair/:id`). Fields appear as the state reaches them. */
export interface PairRecord {
  pair: string
  state: PairState
  /** The pending device's id, label and platform — never its keys before the reveal. */
  device: { id: string; label: string; platform: string }
  commit: string
  createdAt: number
  expiresAt: number
  /** From `nonce` on. */
  approver?: Pick<DeviceRecord, 'id' | 'sign' | 'box' | 'label'>
  nonceE?: string
  /** From `revealed` on. */
  reveal?: { device: DeviceRecord; nonce: string }
}

export function isPairRecord(v: unknown): v is PairRecord {
  return isRecord(v) && isId('pair', v.pair) && typeof v.state === 'string' && isRecord(v.device)
}
