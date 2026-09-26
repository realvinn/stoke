import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, session } from 'electron'
import { mergeBookmarks, newProfileId, partitionFor } from '../../shared/browserProfiles.ts'
import type { BrowserProfile } from '../../shared/browserProfiles.ts'
import type { Settings } from '../../shared/types.ts'
import { chromeSource, forgetChromeKeys } from './chrome.ts'
import { safariSource } from './safari.ts'
import type { ImportedCookie, ImportReport, ReadWhat, SourceProfile } from './types.ts'

/*
 * Importing another browser's profiles into the docked browser.
 *
 * Each source profile lands in a Stoke browser profile of its OWN — reused if
 * it came from the same source before (`origin`), made otherwise — and never
 * in Default. Two reasons, both about what the import widens: two accounts on
 * one site would overwrite each other in a shared jar, and Claude's browser
 * tools act in whichever profile is in use, so a login is only handed to them
 * where the user chose to put it.
 *
 * Decrypted cookie values never cross IPC: the renderer is sent the source list
 * and the counts, nothing else. They DO reach disk, in the profile's partition —
 * so logins are only imported into a cookie store that encrypts what it writes
 * (`cookieStoreEncrypted`). Stoke's packaged builds shipped with Electron's
 * cookie-encryption fuse off, and a plaintext jar is one any program running as
 * the user can read with no prompt at all, a Claude session's shell included;
 * in Chrome the same cookies sat behind the Keychain.
 */

const SOURCES = [chromeSource, safariSource]

/** Stoke keeps one flat bookmark list; this bounds what an import can add to settings.json. */
const MAX_BOOKMARKS = 2000
/** `cookies.set` calls in flight at once. */
const COOKIE_BATCH = 50

export async function scanImportSources(): Promise<SourceProfile[]> {
  const found = await Promise.all(SOURCES.map((s) => s.list().catch(() => [])))
  return found.flat()
}

/*
 * Whether this Stoke's cookie store encrypts what it writes, found by writing
 * one and looking, not by reading a build flag: a marker cookie goes into a
 * throwaway partition, is flushed, and the partition's own SQLite file is read
 * back. Encrypted means an empty `value` beside a non-empty `encrypted_value`.
 * Anything that goes wrong reads as "not encrypted" — this gate fails closed.
 */
const PROBE_PARTITION = 'persist:stoke-encryption-probe'
let encryptionProbe: Promise<boolean> | null = null

export function cookieStoreEncrypted(): Promise<boolean> {
  // The synthetic-profile tests (chrome.ts's test hook) run unpackaged, where
  // the fuse is Electron's default; they write only made-up cookies.
  if (!app.isPackaged && process.env.STOKE_TEST_CHROME_SAFE_STORAGE) return Promise.resolve(true)
  encryptionProbe ??= (async () => {
    const ses = session.fromPartition(PROBE_PARTITION)
    const marker = `probe-${randomUUID()}`
    try {
      await ses.cookies.set({
        url: 'https://stoke-probe.test/',
        name: 'stoke-probe',
        value: marker,
        expirationDate: Math.floor(Date.now() / 1000) + 3600
      })
      await ses.cookies.flushStore()
      const { DatabaseSync } = await import('node:sqlite')
      for (const file of [join(ses.storagePath ?? '', 'Network', 'Cookies'), join(ses.storagePath ?? '', 'Cookies')]) {
        let db: InstanceType<typeof DatabaseSync> | null = null
        try {
          db = new DatabaseSync(file, { readOnly: true })
          const row = db
            .prepare("SELECT value, length(encrypted_value) AS n FROM cookies WHERE name = 'stoke-probe'")
            .get() as { value?: string; n?: number } | undefined
          if (row) return row.value === '' && Number(row.n) > 0
        } catch {
          /* not this file */
        } finally {
          db?.close()
        }
      }
      return false
    } catch {
      return false
    } finally {
      await ses.clearStorageData().catch(() => {})
      if (ses.storagePath) await rm(ses.storagePath, { recursive: true, force: true }).catch(() => {})
    }
  })()
  return encryptionProbe
}

interface ImportDeps {
  getSettings(): Settings
  /** Write the browser block and let every listener hear it (index.ts's `writeBrowser`). */
  writeBrowser(patch: Partial<Settings['browser']>): Settings
}

/** The Stoke profile a source goes into, made if there is none yet. */
function profileFor(source: SourceProfile, deps: ImportDeps): string {
  const profiles = deps.getSettings().browser.profiles
  const existing = profiles.find((p) => p.origin === source.key)
  if (existing) return existing.id
  const label = (source.browser === 'safari' || source.name === source.browserName
    ? source.name
    : `${source.browserName} · ${source.name}`
  ).slice(0, 40)
  const profile: BrowserProfile = {
    id: newProfileId(profiles, randomUUID),
    label,
    source: source.detail ? `${source.browserName} · ${source.detail}` : source.browserName,
    origin: source.key
  }
  const written = deps.writeBrowser({ profiles: [...profiles, profile] })
  // The hydrate keeps at most 32 profiles: a profile it dropped has no partition
  // anything will ever show or wipe, so nothing may be written into one.
  if (!written.browser.profiles.some((p) => p.id === profile.id)) {
    throw new Error('Stoke already keeps as many browser profiles as it will (32). Remove one in Settings › Browser to import another.')
  }
  return profile.id
}

async function setCookies(profileId: string, cookies: ImportedCookie[]): Promise<{ set: number; failed: number }> {
  const ses = session.fromPartition(partitionFor(profileId))
  let set = 0
  let failed = 0
  for (let i = 0; i < cookies.length; i += COOKIE_BATCH) {
    const results = await Promise.allSettled(cookies.slice(i, i + COOKIE_BATCH).map((c) => ses.cookies.set(c)))
    for (const r of results) r.status === 'fulfilled' ? set++ : failed++
  }
  // Cookies reach disk every 30 s or 512 writes on their own; an import must not
  // depend on the app still running by then.
  await ses.cookies.flushStore()
  return { set, failed }
}

let importing = false

/** Whether an import is writing right now. Removing a profile waits for it. */
export function importInProgress(): boolean {
  return importing
}

/**
 * Import the chosen source profiles, one after another. Refuses to start a
 * second run while one is going — claimed before the first await (gotcha 20),
 * since each run can raise its own Keychain prompt and a double press would
 * stack them.
 */
export async function runImport(keys: string[], what: ReadWhat, deps: ImportDeps): Promise<ImportReport[] | null> {
  if (importing) return null
  importing = true
  try {
    // Never into a plaintext jar (see the header). Bookmarks still come over.
    const loginsRefused =
      what.cookies && !(await cookieStoreEncrypted())
        ? 'Logins were not imported: this build of Stoke stores cookies unencrypted on disk. Bookmarks still came over.'
        : null
    if (loginsRefused) what = { ...what, cookies: false }
    const sources = await scanImportSources()
    const reports: ImportReport[] = []
    const bookmarks: string[] = []
    for (const key of keys) {
      const source = sources.find((s) => s.key === key)
      if (!source) {
        reports.push({ key, profileId: '', cookies: 0, skippedCookies: 0, bookmarks: 0, error: 'That profile is no longer there.' })
        continue
      }
      try {
        const read = await (source.browser === 'safari' ? safariSource : chromeSource).read(source, what)
        // A Stoke profile only when there are logins to put in it: a source with
        // none (a Safari that was never used) must not leave an empty profile.
        const profileId = what.cookies && read.cookies.length ? profileFor(source, deps) : ''
        const { set, failed } = profileId ? await setCookies(profileId, read.cookies) : { set: 0, failed: 0 }
        bookmarks.push(...read.bookmarks)
        const cookieError = loginsRefused ?? read.cookieError
        reports.push({
          key,
          profileId,
          cookies: set,
          skippedCookies: read.skippedCookies + failed,
          bookmarks: read.bookmarks.length,
          ...(cookieError ? { cookieError } : {})
        })
      } catch (err) {
        reports.push({
          key,
          profileId: '',
          cookies: 0,
          skippedCookies: 0,
          bookmarks: 0,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    const current = deps.getSettings().browser
    const merged = mergeBookmarks(current.bookmarks, bookmarks, MAX_BOOKMARKS)
    const anything = reports.some((r) => !r.error)
    deps.writeBrowser({
      ...(merged.length !== current.bookmarks.length ? { bookmarks: merged } : {}),
      ...(anything ? { importOffer: 'done' as const } : {})
    })
    return reports
  } finally {
    forgetChromeKeys()
    importing = false
  }
}
