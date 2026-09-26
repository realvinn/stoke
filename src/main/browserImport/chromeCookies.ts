import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import type { ImportedCookie } from './types.ts'

/*
 * Chrome's cookies on macOS: the key, the cipher, and one row into what
 * Electron's `cookies.set` takes. Pure, so `scripts/verify-chrome-import.mts`
 * runs every rule on synthetic data encrypted the way Chrome encrypts it — no
 * real cookie, Keychain item or browser file is ever needed to test it.
 *
 * Every constant here is Chromium's own, read from source:
 *   - key: PBKDF2-HMAC-SHA1 over the Keychain password ("Chrome Safe Storage"),
 *     salt "saltysalt", 1003 iterations, 16 bytes
 *     (components/os_crypt/async/browser/keychain_key_provider.mm);
 *   - cipher: AES-128-CBC, IV of sixteen spaces, the ciphertext tagged "v10"
 *     (components/os_crypt/common/encryptor.cc);
 *   - a cookie DB at meta version 24 or later puts SHA-256(host_key) in front
 *     of the plaintext value, and Chrome itself refuses a row whose prefix does
 *     not match (net/extras/sqlite/sqlite_persistent_cookie_store.cc);
 *   - `samesite` is stored -1 unspecified, 0 no_restriction, 1 lax, 2 strict,
 *     3 the deprecated "extended", read as unspecified (same file,
 *     `DBCookieSameSite`);
 *   - times are microseconds since 1601-01-01.
 */

const SALT = 'saltysalt'
const ITERATIONS = 1003
const KEY_BYTES = 16
const IV = Buffer.alloc(16, 0x20)
const V10 = Buffer.from('v10')
/** Seconds from 1601-01-01 to the Unix epoch. */
export const CHROME_EPOCH_OFFSET = 11_644_473_600
/** The first cookie DB version that prefixes a value with SHA-256 of its host. */
export const HOST_HASH_VERSION = 24

/**
 * A session cookie (no expiry) is carried over as one lasting this long.
 *
 * In Chrome it survives a restart only through "Continue where you left off";
 * imported as a real session cookie it would vanish the first time Stoke quit,
 * and the point of importing a login is to stay signed in. A month, not forever:
 * the site still decides on its side when the session is over.
 */
export const SESSION_COOKIE_DAYS = 30

/** The AES key, from the Keychain password. */
export function chromeKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, KEY_BYTES, 'sha1')
}

/**
 * One cookie's value, or null when it cannot be recovered: a tag other than
 * v10 (a newer scheme this does not know), a wrong key (padding fails), or a
 * host-hash prefix that does not match — Chrome would drop that row too.
 */
export function decryptChromeValue(
  encrypted: Uint8Array,
  key: Buffer,
  hostKey: string,
  dbVersion: number
): string | null {
  const buf = Buffer.from(encrypted)
  if (buf.length <= V10.length || !buf.subarray(0, V10.length).equals(V10)) return null
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV)
    plain = Buffer.concat([decipher.update(buf.subarray(V10.length)), decipher.final()])
  } catch {
    return null
  }
  if (dbVersion >= HOST_HASH_VERSION) {
    const hash = createHash('sha256').update(hostKey).digest()
    if (plain.length < hash.length || !plain.subarray(0, hash.length).equals(hash)) return null
    plain = plain.subarray(hash.length)
  }
  return plain.toString('utf8')
}

/** The columns read from Chrome's `cookies` table. Integers may arrive as bigint. */
export interface ChromeCookieRow {
  host_key: string
  name: string
  /** Plaintext value; Chrome only uses it for cookies it did not encrypt. */
  value: string
  encrypted_value: Uint8Array | null
  path: string
  expires_utc: number | bigint
  is_secure: number | bigint
  is_httponly: number | bigint
  has_expires: number | bigint
  samesite: number | bigint
  /** Non-empty for a partitioned (CHIPS) cookie. Absent on DBs older than the column. */
  top_frame_site_key?: string | null
}

export type SkipReason = 'expired' | 'partitioned' | 'undecryptable' | 'invalid'

const SAME_SITE: Record<number, ImportedCookie['sameSite']> = {
  [-1]: 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
  3: 'unspecified'
}

/** Microseconds since 1601 to Unix seconds, without losing a bigint on the way. */
export function chromeTimeToUnix(micros: number | bigint): number {
  const seconds = typeof micros === 'bigint' ? Number(micros / 1_000_000n) : Math.floor(micros / 1_000_000)
  return seconds - CHROME_EPOCH_OFFSET
}

/**
 * One row into a cookie Electron will accept, or why it is left behind.
 *
 * `value` is the decrypted value (or the plaintext column), null when neither
 * could be read. Host-only cookies get no `domain`: Electron puts a dot in front
 * of any domain it is handed, which would widen the cookie to every subdomain.
 * A partitioned cookie is skipped because `cookies.set` has no partition key,
 * and setting it unpartitioned would hand it to every site that embeds its host.
 */
export function chromeRowToCookie(
  row: ChromeCookieRow,
  value: string | null,
  nowSeconds: number
): ImportedCookie | SkipReason {
  if (row.top_frame_site_key) return 'partitioned'
  if (value === null) return 'undecryptable'
  const host = String(row.host_key ?? '')
  const name = String(row.name ?? '')
  if (!host || !/^[\w.\-[\]:]+$/.test(host.replace(/^\./, ''))) return 'invalid'
  const secure = Number(row.is_secure) === 1
  const hasExpiry = Number(row.has_expires) === 1 && row.expires_utc !== 0 && row.expires_utc !== 0n
  const expires = hasExpiry ? chromeTimeToUnix(row.expires_utc) : nowSeconds + SESSION_COOKIE_DAYS * 86_400
  if (expires <= nowSeconds) return 'expired'
  let sameSite = SAME_SITE[Number(row.samesite)] ?? 'unspecified'
  // SameSite=None without Secure is refused by Chromium's own setter.
  if (sameSite === 'no_restriction' && !secure) sameSite = 'unspecified'
  const path = row.path && row.path.startsWith('/') ? row.path : '/'
  const cookie: ImportedCookie = {
    url: `${secure ? 'https' : 'http'}://${host.replace(/^\./, '')}${path}`,
    name,
    value,
    path,
    secure,
    httpOnly: Number(row.is_httponly) === 1,
    expirationDate: expires,
    sameSite
  }
  if (host.startsWith('.')) cookie.domain = host
  return cookie
}
