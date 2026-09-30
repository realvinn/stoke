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
 * 0-login "success" — which is what EVERY v20 row gives a copy, since Chromium
 * refuses app-bound decryption outside the default user-data dir (gotcha 130) —
 * into an honest error. v10 rows are plain DPAPI and out of scope; a
 * legitimately dropped one (expired, GC'd on load) is not counted, so the signal
 * is app-bound only.
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
 * What the Windows reader says when some v20 rows did not come back, or nothing.
 *
 * Never an offer to close the browser: Chromium unseals app-bound (v20) data only
 * for its own DEFAULT user-data dir (`GetAppBoundEncryptionSupportLevel` returns
 * `kNotUsingDefaultUserDataDir` for any other, and the provider then answers
 * "decrypts will not work"), and it refuses remote debugging on the default dir —
 * so no copy, open or closed, headless or not, can hand a v20 row over (gotcha
 * 130). Nor does it say "while it was running": on Windows the copy only
 * succeeds once the browser has let go of the file, so there is nothing running
 * to blame.
 */
export function sealedReport(browserName: string, sealed: number): { cookieError?: string } {
  if (sealed <= 0) return {}
  const one = sealed === 1
  return {
    cookieError: `${sealed} ${one ? 'login' : 'logins'} could not come over: ${browserName} seals ${one ? 'it' : 'them'} with app-bound encryption and unseals ${one ? 'it' : 'them'} only inside its own everyday profile, never for a copy another app reads. ${one ? 'It stays' : 'They stay'} in ${browserName}, where you are still signed in; any others came over.`
  }
}

/**
 * What the Windows reader says when the profile's cookie file could not be
 * copied because it is locked.
 *
 * On Windows Chromium opens the cookie DB with an EXCLUSIVE lock
 * (`exclusive_cookie_database_locking_ = true`, network_context.cc), so while the
 * browser has that profile open the copy always fails — a hot copy never happens
 * there. The first time, that is an offer (`needsClose`) for the one thing that
 * helps: closing the browser for a moment (gotcha 135). After a close was already
 * tried (`afterClose`) it is not offered again — no loop.
 */
export function lockedCopyReport(browserName: string, afterClose: boolean): { cookieError: string; needsClose?: true } {
  if (afterClose) {
    return {
      cookieError: `${browserName}'s login file is still locked after Stoke asked it to close — another copy of ${browserName}, or another program, is holding it. Quit it yourself, then import again; Stoke never forces anything to quit.`
    }
  }
  return {
    cookieError: `${browserName} is open, and while it is, Windows keeps its login file locked, so Stoke could not copy it. Stoke can close ${browserName} for a moment and reopen it, or you can quit it yourself and import again.`,
    needsClose: true
  }
}

/**
 * How long Stoke waits, after asking, for the browser's processes to be gone
 * before it gives up. It NEVER force-kills it (the repo-wide rule, gotcha 94); on
 * a timeout the logins are not read and the user is told how to quit it.
 */
export const BROWSER_CLOSE_DEADLINE_MS = 20_000

/**
 * The Restart Manager half of the close, in C#, compiled by `Add-Type` inside
 * `browserCloseScript`. It travels in `$env:STOKE_RM_SOURCE`, not in the
 * `-Command` text, so that text carries no double quote for Windows'
 * command-line quoting to mangle. Written for Windows PowerShell 5.1's C# 5
 * compiler: no interpolated strings, `?.`, `out var` or `=>` members.
 *
 * `Shutdown` registers the browser's MAIN process(es) with a Restart Manager
 * session and calls `RmShutdown` with flags 0 — never `RmForceShutdown`. For a
 * windowed app that sends WM_QUERYENDSESSION and then WM_ENDSESSION
 * (ENDSESSION_CLOSEAPP), the same messages a Windows sign-out sends, and every
 * Chromium browser frame answers WM_ENDSESSION with `chrome::SessionEnding()`:
 * the session is written with EVERY window in it and the process ends. Closing
 * windows one by one instead commits each close but the last (gotcha 135).
 * Returns the Win32 result code (0 is success); a process that has already gone
 * is skipped.
 */
export const RESTART_MANAGER_SOURCE = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Diagnostics;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  '',
  'public static class StokeRestartManager',
  '{',
  '    [StructLayout(LayoutKind.Sequential)]',
  '    private struct RM_UNIQUE_PROCESS',
  '    {',
  '        public int dwProcessId;',
  '        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;',
  '    }',
  '',
  '    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]',
  '    private static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);',
  '',
  '    [DllImport("rstrtmgr.dll")]',
  '    private static extern int RmEndSession(uint pSessionHandle);',
  '',
  '    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]',
  '    private static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);',
  '',
  '    [DllImport("rstrtmgr.dll")]',
  '    private static extern int RmShutdown(uint pSessionHandle, uint lActionFlags, IntPtr fnStatus);',
  '',
  '    public static int Shutdown(int[] pids)',
  '    {',
  '        List<RM_UNIQUE_PROCESS> apps = new List<RM_UNIQUE_PROCESS>();',
  '        foreach (int pid in pids)',
  '        {',
  '            try',
  '            {',
  '                long started = Process.GetProcessById(pid).StartTime.ToFileTime();',
  '                RM_UNIQUE_PROCESS app = new RM_UNIQUE_PROCESS();',
  '                app.dwProcessId = pid;',
  '                app.ProcessStartTime.dwLowDateTime = (int)(started & 0xFFFFFFFF);',
  '                app.ProcessStartTime.dwHighDateTime = (int)(started >> 32);',
  '                apps.Add(app);',
  '            }',
  '            catch (Exception)',
  '            {',
  '            }',
  '        }',
  '        if (apps.Count == 0) return 0;',
  '        uint session;',
  '        StringBuilder key = new StringBuilder(64);',
  '        int rc = RmStartSession(out session, 0, key);',
  '        if (rc != 0) return rc;',
  '        try',
  '        {',
  '            rc = RmRegisterResources(session, 0, null, (uint)apps.Count, apps.ToArray(), 0, null);',
  '            if (rc != 0) return rc;',
  '            return RmShutdown(session, 0, IntPtr.Zero);',
  '        }',
  '        finally',
  '        {',
  '            RmEndSession(session);',
  '        }',
  '    }',
  '}'
].join('\n')

/**
 * A constant PowerShell script that ends the browser whose full executable path
 * is in `$env:STOKE_BROWSER_EXE` the way a Windows sign-out does, then waits up to
 * `$env:STOKE_CLOSE_DEADLINE` ms for its processes to be gone.
 *
 * Everything variable travels in the ENVIRONMENT, never spliced into the script
 * (gotcha 101: a curly apostrophe in a path is a PowerShell single quote), and
 * the body is pure ASCII with no double quote, so Windows PowerShell 5.1 and its
 * command line cannot misread it. It never `Stop-Process`es, `-Force`s or
 * `RmForceShutdown`s (gotcha 94's rule).
 *
 * Which processes: `Get-CimInstance Win32_Process` on `ExecutablePath` (a 32-bit
 * PowerShell cannot read a 64-bit process's `.Path` — gotcha 94), narrowed to the
 * ONE instance that owns this profile root (`$env:STOKE_BROWSER_ROOT`): a command
 * line naming no `--user-data-dir` (the default dir, and every child of the
 * default instance, since Chromium copies the switch to its children) or naming
 * this root. Another instance on another `--user-data-dir` — a test browser, an
 * automation profile — is left alone. The crashpad handler is not counted. The
 * main process is the one with no `--type=`.
 *
 * It prints `started=<n>` (main processes at entry; 0 means nothing to close and
 * nothing to reopen), `windows=<n>` (of those, how many had a window — 0 is a
 * browser running in the background), `rm=<code>` (RmShutdown's result),
 * `remaining=<n>` (its processes still alive when it stopped waiting; 0 means it
 * really exited), or `error=<type>` when PowerShell could not do it at all — an
 * `Add-Type` a locked-down PC refuses, say. `closeVerdict` reads them.
 */
export function browserCloseScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'try {',
    '  $exe = $env:STOKE_BROWSER_EXE',
    '  $root = $env:STOKE_BROWSER_ROOT',
    '  $deadline = [int]$env:STOKE_CLOSE_DEADLINE',
    '  function StokeOwns($p) {',
    '    if ($p.ExecutablePath -ne $exe) { return $false }',
    '    $cl = [string]$p.CommandLine',
    "    if ($cl -match '--type=crashpad-handler') { return $false }",
    "    if ($cl.IndexOf('--user-data-dir', [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $true }",
    '    return $cl.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0',
    '  }',
    '  function StokeInstance { @(Get-CimInstance Win32_Process | Where-Object { StokeOwns $_ }) }',
    "  $main = @(StokeInstance | Where-Object { ([string]$_.CommandLine) -notmatch ' --type=' })",
    "  [Console]::Out.WriteLine('started=' + $main.Count)",
    "  if ($main.Count -eq 0) { [Console]::Out.WriteLine('remaining=0'); exit 0 }",
    '  $windows = 0',
    '  foreach ($m in $main) {',
    '    $gp = Get-Process -Id $m.ProcessId -ErrorAction SilentlyContinue',
    '    if ($gp -and $gp.MainWindowHandle -ne 0) { $windows++ }',
    '  }',
    "  [Console]::Out.WriteLine('windows=' + $windows)",
    '  Add-Type -TypeDefinition $env:STOKE_RM_SOURCE',
    '  $pids = [int[]]@($main | ForEach-Object { [int]$_.ProcessId })',
    "  [Console]::Out.WriteLine('rm=' + [StokeRestartManager]::Shutdown($pids))",
    '  $until = (Get-Date).AddMilliseconds($deadline)',
    '  while (@(StokeInstance).Count -gt 0 -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 300 }',
    "  [Console]::Out.WriteLine('remaining=' + @(StokeInstance).Count)",
    '} catch {',
    "  [Console]::Out.WriteLine('error=' + $_.Exception.GetType().Name)",
    '}'
  ].join('\n')
}

/** What `browserCloseScript` printed; a field it never printed is null. */
export interface CloseReport {
  started: number | null
  windows: number | null
  rm: number | null
  remaining: number | null
  error: string | null
}

export function parseCloseReport(stdout: string): CloseReport {
  const num = (key: string): number | null => {
    const m = new RegExp(`^${key}=(-?\\d+)\\s*$`, 'm').exec(stdout)
    return m ? Number(m[1]) : null
  }
  const err = /^error=(.*)$/m.exec(stdout)
  return {
    started: num('started'),
    windows: num('windows'),
    rm: num('rm'),
    remaining: num('remaining'),
    error: err ? err[1].trim() || 'unknown' : null
  }
}

/**
 * Why a browser is still holding its files after Stoke asked it to close:
 * `background` — running with no window (a tray icon, Edge's startup boost);
 * `refused` — it had a window and did not exit; `blocked` — PowerShell could not
 * even ask; `timeout` — the ask itself outran Stoke's wait.
 */
export type CloseStuck = 'background' | 'refused' | 'blocked' | 'timeout'

/**
 * Whether the close worked, from the script's own report — the reopen hangs on
 * it. `closed` only when the browser was running AND is now gone (`remaining=0`):
 * spawning the exe into a still-running instance would only open an extra
 * window, and a browser that was never running must not be opened. Anything the
 * report does not prove is a `stuck`, and then the logins are not read (the copy
 * would be locked) and the user is told why.
 */
export function closeVerdict(report: CloseReport, timedOut: boolean): { closed: boolean; stuck?: CloseStuck } {
  if (timedOut) return { closed: false, stuck: 'timeout' }
  if (report.started === 0 && report.error === null) return { closed: false }
  if (report.started === null || report.error !== null) return { closed: false, stuck: 'blocked' }
  if (report.remaining === 0) return { closed: true }
  return { closed: false, stuck: report.windows === 0 ? 'background' : 'refused' }
}

/** What the panel says when the browser would not close; its logins then stay behind. */
export function closeStuckMessage(browserName: string, stuck: CloseStuck): string {
  switch (stuck) {
    case 'background':
      return `${browserName} kept running in the background with no window open, so its login file stayed locked. Quit it from its icon by the clock if it shows one, or turn off its setting to keep running in the background, then import again. Stoke never forces it to quit.`
    case 'refused':
      return `${browserName} did not close when Stoke asked, so its login file stayed locked. Quit it from its own menu, then import again. Stoke never forces it to quit.`
    case 'blocked':
      return `Windows would not let Stoke ask ${browserName} to close on this PC. Quit it from its own menu, then import again. Stoke never forces it to quit.`
    case 'timeout':
      return `${browserName} had not finished closing when Stoke stopped waiting, so its logins were not read. If it is still open, quit it from its own menu, then import again.`
  }
}

/**
 * The argv Stoke reopens the browser with once the reads are done: nothing. No
 * `--profile-directory`, so the browser brings back every profile that was open
 * (its "last active profiles"), not just the one Stoke read; no
 * `--user-data-dir`, so it is the user's real default instance. Whether the tabs
 * come back is the user's own "continue where you left off" setting — Stoke does
 * not force it, and the panel says so.
 */
export function reopenArgs(): string[] {
  return []
}

/**
 * The chosen keys in runs of one browser each, in first-seen order, so the
 * close-and-reopen happens ONCE per browser around all of its profiles — never
 * once per profile, which closed the instance the previous profile's reopen had
 * just started (gotcha 135). Keys whose browser is unknown share one run (null).
 */
export function groupKeysByBrowser<B extends string>(
  keys: string[],
  browserOf: (key: string) => B | null
): { browser: B | null; keys: string[] }[] {
  const runs: { browser: B | null; keys: string[] }[] = []
  for (const key of keys) {
    const browser = browserOf(key)
    const run = runs.find((r) => r.browser === browser)
    if (run) run.keys.push(key)
    else runs.push({ browser, keys: [key] })
  }
  return runs
}
