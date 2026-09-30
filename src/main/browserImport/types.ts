/**
 * The shape every import source shares: find the profiles a browser has, then
 * read one of them. Main runs both; nothing here reaches the renderer except a
 * `SourceProfile` and the counts in an `ImportReport` — a decrypted cookie value
 * never crosses IPC and never touches a log. It DOES reach disk: `cookies.set`
 * writes it into the profile's partition, which is why `runImport` refuses
 * logins unless Stoke's own cookie store is encrypted (`cookieStoreEncrypted`).
 *
 * Bookmarks import on macOS and Windows (the profile files are identical); logins
 * are macOS-only, where Chrome's cookie key lives in the login Keychain. On
 * Windows it is DPAPI with app-bound encryption, on Linux libsecret — neither
 * done. Safari is macOS-only outright.
 */

export type ImportBrowserId = 'chrome' | 'chrome-beta' | 'brave' | 'edge' | 'arc' | 'vivaldi' | 'chromium' | 'safari'

export type SourceStatus =
  /** Readable now; importing may still raise a Keychain prompt (Chrome). */
  | 'ready'
  /** macOS refused the folder (App Data protection, EPERM): Stoke must be allowed to access other apps' data. */
  | 'needsAppData'
  /** Safari's files need Full Disk Access for Stoke, then a relaunch. */
  | 'needsFullDiskAccess'
  /** Present but could not be read for another reason; `note` says which. */
  | 'unreadable'

export interface SourceProfile {
  /** Stable across scans: `chrome/Profile 1`, `safari/default`, `safari/<uuid>`. Also a Stoke profile's `origin`. */
  key: string
  browser: ImportBrowserId
  /** "Chrome", "Safari". */
  browserName: string
  /** The profile's own name in that browser: "Person 1", "Work", "Personal". */
  name: string
  /** The signed-in account, when the browser records one; else ''. */
  detail: string
  status: SourceStatus
  note?: string
}

/** Exactly what `session.cookies.set` takes (Electron's CookiesSetDetails). */
export interface ImportedCookie {
  url: string
  name: string
  value: string
  /** Absent for a host-only cookie: Electron prefixes a dot to any domain it is given. */
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** Unix seconds. Absent is a session cookie. */
  expirationDate?: number
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

export interface ReadWhat {
  cookies: boolean
  bookmarks: boolean
  /**
   * Windows only: the user has consented to Stoke closing their browser for a
   * moment (its files were locked, or some app-bound logins would not decrypt),
   * copying the logins, then reopening it. Off by default and never taken
   * without an explicit second press in the import panel.
   */
  closeReopen?: boolean
}

export interface ReadResult {
  cookies: ImportedCookie[]
  /** Cookies that could not be carried over: expired, partitioned (CHIPS), undecryptable. */
  skippedCookies: number
  /** http(s) URLs, in the browser's own order, duplicates removed. */
  bookmarks: string[]
  /**
   * Why the logins could not be read, when they could not — a Keychain prompt
   * refused, Full Disk Access missing. The bookmarks above are still good: a
   * failure on one half never throws the other half away.
   */
  cookieError?: string
  /**
   * Windows only: this read's `cookieError` is one that closing and reopening
   * the browser could resolve — the profile files were locked by a running
   * browser, or some app-bound logins came back sealed and a clean, fully
   * flushed copy might do better. The panel may then offer the close-and-reopen
   * button. Never set once a close-and-reopen was already tried (no loop).
   */
  needsClose?: boolean
}

export interface BrowserSource {
  /** Every profile of every installed browser this source covers. Never throws. */
  list(): Promise<SourceProfile[]>
  /** Read one profile. Throws an Error whose message is fit to show the user. */
  read(profile: SourceProfile, what: ReadWhat): Promise<ReadResult>
}

/** What an import did, per source profile, for the Settings panel. Counts only. */
export interface ImportReport {
  key: string
  /** The Stoke browser profile it went into. */
  profileId: string
  cookies: number
  skippedCookies: number
  bookmarks: number
  /** Nothing came from this source: why. */
  error?: string
  /** The bookmarks came, the logins did not: why. */
  cookieError?: string
  /**
   * Windows only: the panel may offer to close and reopen the browser to get
   * these logins (a locked profile, or app-bound rows a clean copy might read).
   */
  needsChromeClose?: boolean
}
