import { join, win32 as winPath } from 'node:path'
import type { ImportBrowserId } from './types.ts'

/*
 * Where the Chromium-family browsers keep their profiles, on macOS and Windows.
 *
 * Pure and platform-parameterised so `verify-chrome-import.mts` can hold the
 * path rules for both without this machine being either: a folder is only ever
 * touched by chrome.ts, and only when it exists. The Local State file and each
 * profile's Bookmarks JSON are byte-for-byte the same format across the two —
 * which is why bookmarks import on both. Only the cookie key differs, and that
 * is the whole reason logins are macOS-only for now: on macOS the key sits in
 * the login Keychain (chrome.ts's `keyFor`); on Windows Chrome wraps it with
 * DPAPI and, since Chrome 127, app-bound encryption tied to Chrome's own code
 * signature, unwrappable only by calling Chrome's elevation service.
 *
 * macOS root:   <home>/Library/Application Support/<macDir>
 * Windows root: %LOCALAPPDATA%\<winDir>   (winDir ends in "User Data")
 */
export interface ChromiumBrowser {
  id: ImportBrowserId
  name: string
  /** Under ~/Library/Application Support on macOS. */
  macDir: string
  /** Under %LOCALAPPDATA% on Windows; the "User Data" root. '' means not known there. */
  winDir: string
  /** The macOS Keychain generic password's service. Unused on Windows. */
  keychain: string
}

export const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  { id: 'chrome', name: 'Chrome', macDir: 'Google/Chrome', winDir: 'Google\\Chrome\\User Data', keychain: 'Chrome Safe Storage' },
  { id: 'chrome-beta', name: 'Chrome Beta', macDir: 'Google/Chrome Beta', winDir: 'Google\\Chrome Beta\\User Data', keychain: 'Chrome Safe Storage' },
  { id: 'brave', name: 'Brave', macDir: 'BraveSoftware/Brave-Browser', winDir: 'BraveSoftware\\Brave-Browser\\User Data', keychain: 'Brave Safe Storage' },
  { id: 'edge', name: 'Edge', macDir: 'Microsoft Edge', winDir: 'Microsoft\\Edge\\User Data', keychain: 'Microsoft Edge Safe Storage' },
  // Arc on Windows is a UWP-packaged app whose data path is version-specific and
  // uncertain; left blank so it is simply skipped there rather than pointed wrong.
  { id: 'arc', name: 'Arc', macDir: 'Arc/User Data', winDir: '', keychain: 'Arc Safe Storage' },
  { id: 'vivaldi', name: 'Vivaldi', macDir: 'Vivaldi', winDir: 'Vivaldi\\User Data', keychain: 'Vivaldi Safe Storage' },
  { id: 'chromium', name: 'Chromium', macDir: 'Chromium', winDir: 'Chromium\\User Data', keychain: 'Chromium Safe Storage' }
]

/**
 * The user-data root for one browser on this platform, or null when this
 * platform is not one Stoke imports from (Linux) or the browser has no known
 * folder here (Arc on Windows). `win32.join` is used for the Windows branch so
 * the path is right even when this resolves on a Mac inside a test.
 */
export function chromiumRoot(
  b: Pick<ChromiumBrowser, 'macDir' | 'winDir'>,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string | null {
  if (platform === 'win32') {
    if (!b.winDir) return null
    const base = env.LOCALAPPDATA || (home ? winPath.join(home, 'AppData', 'Local') : '')
    return base ? winPath.join(base, b.winDir) : null
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', b.macDir)
  return null
}
