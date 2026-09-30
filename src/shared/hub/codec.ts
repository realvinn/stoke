/*
 * The byte and text encodings every other hub module builds on.
 *
 * Stoke Hub (docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md) signs,
 * hashes and encrypts TEXT that two programs build independently — a Stoke
 * and the hub on the owner's NUC — so the one thing that must never differ
 * between them is how a value becomes bytes. That is this file:
 *
 * - `canonicalJson`: JSON with object keys sorted at every depth and no
 *   whitespace. Every signed text, KDF info string and AAD is a label plus
 *   one of these, so the same fields always produce the same bytes.
 * - base64url without padding for every binary value on the wire.
 * - Crockford base32 for everything a person reads or types (the Recovery
 *   Kit, invites) and for ids, with its mod-37 check symbol.
 *
 * Pure and compiled by both tsconfigs, so no `node:` import and no `Buffer`
 * (gotcha 27); `scripts/verify-hub.mts` runs it under strip-types, so shared
 * imports are relative with `.ts` (gotcha 78).
 */

/** Thrown for a value that has no canonical JSON form. A bug at the call site, never data. */
export class HubCodecError extends Error {}

/* ------------------------------------------------------------- utf-8 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Decode UTF-8, or null for bytes that are not valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ base64url */

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64U_INDEX = new Map([...B64U].map((c, i) => [c, i]))

/** base64url, no padding (RFC 4648 §5). */
export function b64uEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63] + B64U[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63]
  }
  return out
}

/**
 * Decode strict base64url, or null. Strict means: only the url-safe alphabet,
 * no padding, no whitespace, and the unused low bits of the last character
 * zero — so every byte string has exactly ONE accepted spelling, and a value
 * compared as text (a public key, a digest) cannot be spelled two ways.
 */
export function b64uDecode(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (const c of text) {
    const v = B64U_INDEX.get(c)
    if (v === undefined) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null
  return out
}

/** True when `text` is strict base64url of exactly `bytes` bytes. */
export function isB64u(text: unknown, bytes: number): text is string {
  if (typeof text !== 'string') return false
  const d = b64uDecode(text)
  return d !== null && d.length === bytes
}

/* ---------------------------------------------------- Crockford base32 */

/** Crockford's alphabet: no I, L, O, U. Upper case for people, lower case in ids. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Check symbols for the values 32..36 of a mod-37 check. */
const CHECK_EXTRA = '*~$=U'
const CROCKFORD_INDEX = new Map([...CROCKFORD].map((c, i) => [c, i]))

/** Base32 of `bytes`, most significant bit first, the last character zero-padded. */
export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(acc >> bits) & 31]
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31]
  return out
}

/** Characters needed for `byteLength` bytes. */
export function base32Length(byteLength: number): number {
  return Math.ceil((byteLength * 8) / 5)
}

/**
 * Upper-case, drop spaces and hyphens, and read Crockford's look-alikes the
 * way he specifies: O as 0, I and L as 1. What a person typed from a printed
 * Kit becomes what was printed.
 */
export function normalizeBase32(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/**
 * Decode exactly `byteLength` bytes from normalised base32, or null — for a
 * wrong length, a character outside the alphabet, or non-zero padding bits
 * (one accepted spelling per value, as with base64url).
 */
export function base32Decode(text: string, byteLength: number): Uint8Array | null {
  if (text.length !== base32Length(byteLength)) return null
  const out = new Uint8Array(byteLength)
  let o = 0
  let acc = 0
  let bits = 0
  for (const c of text) {
    const v = CROCKFORD_INDEX.get(c)
    if (v === undefined) return null
    acc = ((acc << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      if (o < byteLength) out[o++] = (acc >> bits) & 0xff
    }
  }
  if (o !== byteLength || (acc & ((1 << bits) - 1)) !== 0) return null
  return out
}

/** Crockford's check symbol: the bytes as one big-endian integer, mod 37. */
export function checkSymbol(bytes: Uint8Array): string {
  let r = 0
  for (const b of bytes) r = (r * 256 + b) % 37
  return r < 32 ? CROCKFORD[r] : CHECK_EXTRA[r - 32]
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function groupsOf(text: string, size: number): string {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts.join('-')
}

/* ----------------------------------------------------------------- ids */

/**
 * The id shapes the protocol uses. Lower-case Crockford base32 of random bytes
 * behind a one-letter kind, so an id says what it names and can never be a
 * path segment with a dot, a slash or `__proto__` in it.
 */
export const ID_BYTES = { account: 10, device: 10, pair: 10, relay: 15, sshKey: 10, host: 10 } as const
export type IdKind = keyof typeof ID_BYTES
/**
 * `host` is an SSH host's SYNC id, never its settings id: `SshHost.id` is a
 * per-machine counter (`host-1`, `host-2`, HostsSettings' `newHostId`), so two
 * machines' `host-1` are usually two different servers.
 */
const ID_PREFIX: Record<IdKind, string> = { account: 'a', device: 'd', pair: 'p', relay: 'r', sshKey: 'k', host: 'h' }

/** A new id from `random` (which must hold `ID_BYTES[kind]` random bytes). */
export function idFromBytes(kind: IdKind, random: Uint8Array): string {
  if (random.length !== ID_BYTES[kind]) throw new HubCodecError(`an ${kind} id takes ${ID_BYTES[kind]} bytes`)
  return ID_PREFIX[kind] + base32Encode(random).toLowerCase()
}

const ID_PATTERNS: Record<IdKind, RegExp> = Object.fromEntries(
  (Object.keys(ID_BYTES) as IdKind[]).map((k) => [
    k,
    new RegExp(`^${ID_PREFIX[k]}[0-9a-hjkmnp-tv-z]{${base32Length(ID_BYTES[k])}}$`)
  ])
) as Record<IdKind, RegExp>

export function isId(kind: IdKind, v: unknown): v is string {
  return typeof v === 'string' && ID_PATTERNS[kind].test(v)
}

/* ------------------------------------------------------ canonical JSON */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * JSON with object keys sorted (by UTF-16 code unit, as `Array.prototype.sort`
 * orders them) at every depth and no whitespace.
 *
 * Mirrors `JSON.stringify` exactly where that is deterministic — string
 * escaping, number formatting (ECMAScript's Number::toString), an `undefined`
 * property omitted, `undefined` in an array as `null` — and THROWS where it is
 * not a faithful encoding: NaN and ±Infinity (stringify silently writes
 * `null`), a function, a symbol, a bigint, and any object that is not a plain
 * object or array (a Date would become a string that parses back as one).
 *
 * Everything the protocol SIGNS uses integers only (the validators check),
 * so a verifier in another language never has to reproduce float formatting.
 * Item plaintext is encrypted, never signed, and may carry any finite number.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown, inArray: boolean): string | undefined => {
    if (v === null) return 'null'
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v)
      case 'boolean':
        return v ? 'true' : 'false'
      case 'number':
        if (!Number.isFinite(v)) throw new HubCodecError('canonical JSON has no NaN or Infinity')
        return JSON.stringify(v)
      case 'undefined':
        return inArray ? 'null' : undefined
      case 'object': {
        if (Array.isArray(v)) return `[${v.map((x) => walk(x, true)).join(',')}]`
        if (!isPlainObject(v)) throw new HubCodecError('canonical JSON takes plain objects only')
        const parts: string[] = []
        for (const k of Object.keys(v).sort()) {
          const s = walk(v[k], false)
          if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`)
        }
        return `{${parts.join(',')}}`
      }
      default:
        throw new HubCodecError(`canonical JSON cannot encode a ${typeof v}`)
    }
  }
  const out = walk(value, false)
  if (out === undefined) throw new HubCodecError('canonical JSON cannot encode undefined')
  return out
}

/**
 * `canonicalJson` that never throws, for COMPARING two values (gotcha 116:
 * compare settings only with keys sorted). A value it cannot encode compares
 * as a string no real value produces, so two broken values are never "equal"
 * to a good one.
 */
export function stableJson(value: unknown): string {
  try {
    return canonicalJson(value)
  } catch (err) {
    return `\u0000unencodable:${(err as Error).message}`
  }
}

/** `label`, a newline, then the canonical JSON of `fields`: the shape of every signed text, KDF info and AAD. */
export function labelled(label: string, fields: Record<string, unknown>): string {
  return `${label}\n${canonicalJson(fields)}`
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}
