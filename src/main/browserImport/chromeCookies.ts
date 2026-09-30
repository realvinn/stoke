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

/**
 * A cookie as CDP hands it back (`Storage.getCookies`/`Network.getAllCookies`).
 *
 * On Windows the value is ALREADY decrypted — Chrome unsealed its own v20
 * (DPAPI + app-bound) jar and CDP returns plaintext, HttpOnly included. So the
 * Windows path never touches `decryptChromeValue`; it copies the profile, asks
 * the user's own `chrome.exe` to open it headless, and reads these objects out.
 * Only the mapping is left, and it is the same six rules as the SQLite row
 * (gotcha 107), sourced from CDP fields instead of columns.
 */
export interface CdpCookie {
  name: string
  value: string
  /** With a leading dot for a Domain= cookie, without for a host-only one — as Chrome's SQLite host_key. */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** True for a cookie with no persistent expiry; `expires` is then -1. */
  session: boolean
  /** Unix seconds, or -1 for a session cookie. */
  expires: number
  /** CDP spells it `Strict`/`Lax`/`None`; absent is unspecified. */
  sameSite?: 'Strict' | 'Lax' | 'None'
  /**
   * Present for a partitioned (CHIPS) cookie — skipped, since `cookies.set` has
   * no partition key (gotcha 107). CDP gives it as a string or `{ topLevelSite }`.
   */
  partitionKey?: unknown
}

const CDP_SAME_SITE: Record<string, ImportedCookie['sameSite']> = {
  None: 'no_restriction',
  Lax: 'lax',
  Strict: 'strict'
}

/**
 * One CDP cookie into a cookie Electron will accept, or why it is left behind.
 *
 * Mirrors `chromeRowToCookie` — the value is already plaintext, so the only
 * difference is the source shape: `session`/`expires` for the 30-day rule,
 * `domain`'s leading dot for host-only, `partitionKey` for CHIPS, the string
 * `sameSite`. Kept a pure function so `verify:chrome-import` holds it on
 * synthetic CDP objects, with no browser anywhere.
 */
export function cdpCookieToImported(c: CdpCookie, nowSeconds: number): ImportedCookie | SkipReason {
  if (c.partitionKey !== undefined && c.partitionKey !== null && c.partitionKey !== '') return 'partitioned'
  if (typeof c.value !== 'string') return 'undecryptable'
  const host = String(c.domain ?? '')
  const name = String(c.name ?? '')
  if (!host || !/^[\w.\-[\]:]+$/.test(host.replace(/^\./, ''))) return 'invalid'
  const secure = c.secure === true
  const persistent = c.session !== true && typeof c.expires === 'number' && c.expires > 0
  const expires = persistent ? Math.floor(c.expires) : nowSeconds + SESSION_COOKIE_DAYS * 86_400
  if (expires <= nowSeconds) return 'expired'
  let sameSite = (c.sameSite && CDP_SAME_SITE[c.sameSite]) ?? 'unspecified'
  // SameSite=None without Secure is refused by Chromium's own setter.
  if (sameSite === 'no_restriction' && !secure) sameSite = 'unspecified'
  const path = c.path && c.path.startsWith('/') ? c.path : '/'
  const cookie: ImportedCookie = {
    url: `${secure ? 'https' : 'http'}://${host.replace(/^\./, '')}${path}`,
    name,
    value: c.value,
    path,
    secure,
    httpOnly: c.httpOnly === true,
    expirationDate: expires,
    sameSite
  }
  if (host.startsWith('.')) cookie.domain = host
  return cookie
}

/**
 * Whether an App Paths registry hit actually belongs to THIS browser.
 *
 * Chrome Stable, Chrome Beta and Chromium all ship an exe named `chrome.exe`,
 * and Chrome's installer writes ONE shared `App Paths\chrome.exe` value for
 * whichever channel installed last. So a lookup by exe NAME can hand back a
 * different channel's binary — and launching THAT against this channel's profile
 * decrypts nothing, because the app-bound path check is per-binary (each
 * browser's own signed exe, gotcha 130). Accept the registry result only when it
 * ends with one of this browser's own install subpaths (case-insensitively,
 * separators normalised). With no known subpaths there is nothing to check it
 * against, so it is accepted as the only lead there is.
 */
export function appPathMatchesBrowser(exePath: string, installSubpaths: string[]): boolean {
  if (installSubpaths.length === 0) return true
  const lower = exePath.toLowerCase().replace(/\//g, '\\')
  return installSubpaths.some((s) => lower.endsWith(s.toLowerCase()))
}

/** One cookie's identity across the two views: `${host_or_domain}\t${name}`. */
export function cookieIdentity(hostOrDomain: string, name: string): string {
  return `${hostOrDomain}\t${name}`
}

/**
 * How many app-bound (v20) cookies the browser did NOT hand back over CDP.
 *
 * The Windows reader launches the browser against a copy and takes whatever
 * `Storage.getCookies` returns as the whole answer — but a cookie the browser
 * cannot decrypt when it loads the store is silently DROPPED from that list. It
 * never surfaces as a `skipped` either: CDP only ever returns cookies it already
 * decrypted, so `cdpCookieToImported`'s `undecryptable` branch (a non-string
 * value) can never fire for a real one. The copied DB is therefore the ground
 * truth: every v20 row whose `(host_key, name)` is absent from what CDP returned
 * is a login that stayed sealed. Counting them is the only way to turn a silent
 * 0-login "success" — the exact failure a non-default `--user-data-dir` can
 * cause, since Chrome may refuse app-bound decryption there — into an honest
 * error. v10 rows are plain DPAPI and out of scope; a legitimately dropped one
 * (expired, GC'd on load) is not counted, so the signal is app-bound only.
 */
export function sealedCookiesMissed(
  rows: { host_key: string; name: string; tag: string }[],
  cdpIdentities: Set<string>
): number {
  let sealed = 0
  for (const r of rows) {
    if (r.tag !== 'v20') continue
    if (!cdpIdentities.has(cookieIdentity(r.host_key, r.name))) sealed++
  }
  return sealed
}

/**
 * How long Stoke waits for a gracefully-closed browser to quit before it gives
 * up — it NEVER force-kills it (the repo-wide rule). On a timeout it reports the
 * browser is still holding the files and asks the user to close it themselves.
 */
export const BROWSER_CLOSE_DEADLINE_MS = 20_000

/**
 * A constant PowerShell script that gracefully closes the browser whose full
 * executable path is in `$env:STOKE_BROWSER_EXE`, then waits up to
 * `$env:STOKE_CLOSE_DEADLINE` ms for its processes to exit.
 *
 * This is the close half of the flow the owner asked for on Windows: when the
 * profile files are locked by a running browser, Stoke offers to close it for a
 * moment, copy the logins, and reopen it. Everything variable travels in the
 * ENVIRONMENT, never spliced into the script (gotcha 101: a curly apostrophe in
 * a profile path is a PowerShell single quote), and the whole body is pure
 * ASCII so Windows PowerShell 5.1 cannot misread it. It never `Stop-Process` /
 * `-Force` (gotcha 94's rule): `CloseMainWindow()` is what clicking a window's
 * × does, so the browser saves its session and can restore it on reopen. It
 * re-issues the close each pass because one browser process owns several
 * top-level windows and closing one moves the main handle to the next.
 * Processes are found with `Get-CimInstance Win32_Process` (a 32-bit PowerShell
 * cannot read a 64-bit process's `.Path` — gotcha 94), matched on
 * `ExecutablePath`. It prints `started=<n>` (how many were running at entry, so
 * the caller reopens only a browser it actually closed) and `remaining=<n>`
 * (0 means the browser closed).
 */
export function browserCloseScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$exe = $env:STOKE_BROWSER_EXE',
    '$deadline = [int]$env:STOKE_CLOSE_DEADLINE',
    'function StokeBrowserPids { @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { $_.ProcessId }) }',
    "[Console]::Out.WriteLine('started=' + @(StokeBrowserPids).Count)",
    '$until = (Get-Date).AddMilliseconds($deadline)',
    'while ($true) {',
    '  $ids = @(StokeBrowserPids)',
    '  if ($ids.Count -eq 0) { break }',
    '  if ((Get-Date) -ge $until) { break }',
    '  foreach ($procId in $ids) {',
    '    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue',
    '    if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() }',
    '  }',
    '  Start-Sleep -Milliseconds 300',
    '}',
    "[Console]::Out.WriteLine('remaining=' + @(StokeBrowserPids).Count)"
  ].join('\n')
}

/**
 * The argv to reopen the user's browser on the profile it had open. No
 * `--user-data-dir`, so it uses the real default profile root — the browser
 * reopens the user's normal session and, IF the user's own "continue where you
 * left off" setting says so, restores the tabs it had. Stoke does not force that
 * setting; the UI says the tabs come back only when the browser is set to.
 */
export function reopenArgs(profileName: string): string[] {
  return [`--profile-directory=${profileName}`]
}
