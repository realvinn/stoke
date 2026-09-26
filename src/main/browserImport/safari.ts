/**
 * Safari as an import source: its profiles, their cookies, the bookmarks.
 *
 * Every file here sits behind Full Disk Access. Safari's container and
 * `~/Library/Safari` are TCC-protected, and an app without the grant is refused
 * with EPERM on open — not a prompt, as Chrome's Keychain item gives, and not
 * ENOENT, so "Safari has no data" and "Stoke may not look" are told apart by the
 * error code alone. The grant also only takes effect in a process started after
 * it, which is why every message about it says to reopen Stoke.
 *
 * Profiles (Safari 17 and later) are rows in `SafariTabs.db`. Each non-default
 * profile keeps its cookies in its own WebKit data store, named by the row's
 * UUID; the bookmarks file is one file shared by all of them.
 *
 * `node:sqlite` is loaded on first use, never at import (gotcha 40), and only
 * ever opens a copy, WAL included: the live database is Safari's, open and
 * possibly mid-write while Stoke reads.
 */
import { execFile } from 'node:child_process'
import { access, copyFile, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePlistXml } from './plist.ts'
import { parseBinaryCookies, safariCookieToElectron, type SafariCookie } from './safariCookies.ts'
import type { BrowserSource, ReadResult, ReadWhat, SourceProfile, SourceStatus } from './types.ts'

const DEFAULT_KEY = 'safari/default'

/** What `SafariTabs.db` calls the profile every Safari has. */
const DEFAULT_PROFILE_UUID = 'DefaultProfile'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * How long one probe of Safari's files may take. The home folder can be on a
 * volume that is asleep (gotcha 40); past this the file is called unreadable,
 * and the next scan asks again.
 */
const PROBE_DEADLINE_MS = 3000

/** plutil on a bookmarks file with years of Reading List in it: generous on both. */
const PLUTIL_TIMEOUT_MS = 20_000
const PLUTIL_MAX_BUFFER = 32 * 1024 * 1024

export const FULL_DISK_ACCESS_MESSAGE =
  "Safari's files need Full Disk Access for Stoke — turn Stoke on in System Settings › Privacy & Security › Full Disk Access, then quit and reopen Stoke. It covers everything Stoke runs, every Claude session and terminal included, for as long as it stays on: turn it off again once the import is done."

function paths(home = homedir()): {
  container: string
  data: string
  tabsDb: string
  bookmarks: string
} {
  const container = join(home, 'Library/Containers/com.apple.Safari')
  return {
    container,
    data: join(container, 'Data/Library'),
    tabsDb: join(container, 'Data/Library/Safari/SafariTabs.db'),
    bookmarks: join(home, 'Library/Safari/Bookmarks.plist')
  }
}

/**
 * Where a profile's cookie file may be, most likely first. The default
 * profile's jar lives in Safari's container on current macOS; the older
 * `~/Library/Cookies` path is read only when that one is absent. A profile's data store is named by its UUID, tried in both
 * cases so a case-sensitive volume finds it too.
 */
function cookieCandidates(key: string, home = homedir()): string[] | null {
  const { data } = paths(home)
  if (key === DEFAULT_KEY) {
    return [join(data, 'Cookies/Cookies.binarycookies'), join(home, 'Library/Cookies/Cookies.binarycookies')]
  }
  const uuid = profileUuid(key)
  if (!uuid) return null
  return [...new Set([uuid, uuid.toUpperCase()])].map((u) =>
    join(data, 'WebKit/WebsiteDataStore', u, 'Cookies/Cookies.binarycookies')
  )
}

/**
 * The lower-case UUID a non-default key names, or null. The key arrives over
 * IPC and becomes part of a path, so it must be exactly a UUID — anything else
 * (a `..`, a separator) is refused here, before it can name a file.
 */
export function profileUuid(key: string): string | null {
  const rest = key.startsWith('safari/') ? key.slice('safari/'.length) : ''
  return UUID.test(rest) ? rest.toLowerCase() : null
}

type ProbeState = 'ok' | 'missing' | 'denied' | 'failed'

interface Probe {
  state: ProbeState
  /** The errno, for a note, when `state` is `failed`. */
  code?: string
}

function stateFor(code: string | undefined): ProbeState {
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  if (code === 'EPERM' || code === 'EACCES') return 'denied'
  return 'failed'
}

function withDeadline<T>(work: Promise<T>, late: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), PROBE_DEADLINE_MS)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Can this file be opened? Opening is the test because opening is what TCC
 * decides on, and what the read will do: any lesser check could say yes to a
 * file the import is then refused. The handle closes itself even if the
 * deadline has already given up on it.
 */
function probe(path: string): Promise<Probe> {
  const attempt = open(path, 'r').then(
    async (handle): Promise<Probe> => {
      await handle.close().catch(() => {})
      return { state: 'ok' }
    },
    (err: NodeJS.ErrnoException): Probe => ({ state: stateFor(err.code), code: err.code })
  )
  return withDeadline(attempt, { state: 'failed', code: 'ETIMEDOUT' })
}

function exists(path: string): Promise<boolean> {
  return withDeadline(
    access(path).then(
      () => true,
      () => false
    ),
    false
  )
}

/** The first candidate that is not missing; all missing is the first one, missing. */
async function locate(candidates: string[]): Promise<{ path: string; probe: Probe }> {
  for (const path of candidates) {
    const result = await probe(path)
    if (result.state !== 'missing') return { path, probe: result }
  }
  return { path: candidates[0], probe: { state: 'missing' } }
}

/** Safari is on this Mac: in /Applications, in the system cryptex (Ventura on), or it has left a container. */
async function safariInstalled(): Promise<boolean> {
  for (const path of [
    '/Applications/Safari.app',
    '/System/Cryptexes/App/System/Applications/Safari.app',
    paths().container
  ]) {
    if (await exists(path)) return true
  }
  return false
}

interface ProfileRow {
  uuid: string
  title: string
}

/**
 * The profiles `SafariTabs.db` lists, read from a copy. `null` means the
 * database is not there, or could not be read for a reason Full Disk Access
 * would not fix — the caller falls back to the default profile alone.
 */
async function readProfileRows(dbPath: string): Promise<ProfileRow[] | null> {
  const dir = await mkdtemp(join(tmpdir(), 'stoke-safari-'))
  try {
    const copy = join(dir, 'SafariTabs.db')
    await copyFile(dbPath, copy)
    // The WAL holds whatever Safari has not checkpointed yet: recent profiles live there.
    for (const suffix of ['-wal', '-shm']) {
      await copyFile(dbPath + suffix, copy + suffix).catch(() => {})
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const rows = db
        .prepare('select title, external_uuid from bookmarks where parent = 0 and type = 1 and subtype = 2')
        .all()
      return rows.map((r) => ({
        uuid: typeof r.external_uuid === 'string' ? r.external_uuid : '',
        title: typeof r.title === 'string' ? r.title.trim() : ''
      }))
    } finally {
      db.close()
    }
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function statusOf(probes: Probe[]): { status: SourceStatus; note?: string } {
  if (probes.some((p) => p.state === 'denied')) {
    return { status: 'needsFullDiskAccess', note: FULL_DISK_ACCESS_MESSAGE }
  }
  const failed = probes.find((p) => p.state === 'failed')
  if (failed) {
    const why = failed.code === 'ETIMEDOUT' ? 'the disk did not answer in time' : (failed.code ?? 'unknown error')
    return { status: 'unreadable', note: `Stoke could not open Safari's files (${why}).` }
  }
  return { status: 'ready' }
}

function profile(key: string, name: string, status: { status: SourceStatus; note?: string }): SourceProfile {
  const out: SourceProfile = { key, browser: 'safari', browserName: 'Safari', name, detail: '', status: status.status }
  if (status.note) out.note = status.note
  return out
}

async function listSafari(): Promise<SourceProfile[]> {
  if (!(await safariInstalled())) return []
  const p = paths()

  const tabsDb = await probe(p.tabsDb)
  if (tabsDb.state === 'denied') {
    return [profile(DEFAULT_KEY, 'Safari', statusOf([tabsDb]))]
  }

  // Without the database (Safari before 17, or never opened) there is one profile and no name for it.
  const rows = tabsDb.state === 'ok' ? await readProfileRows(p.tabsDb) : null
  const found: Array<{ key: string; name: string }> = []
  if (rows) {
    const defaultRow = rows.find((r) => r.uuid === DEFAULT_PROFILE_UUID)
    found.push({ key: DEFAULT_KEY, name: defaultRow?.title || 'Personal' })
    const seen = new Set<string>()
    for (const r of rows) {
      if (!UUID.test(r.uuid)) continue
      const uuid = r.uuid.toLowerCase()
      if (seen.has(uuid)) continue
      seen.add(uuid)
      found.push({ key: `safari/${uuid}`, name: r.title || 'Profile' })
    }
  } else {
    found.push({ key: DEFAULT_KEY, name: 'Safari' })
  }

  const bookmarks = await probe(p.bookmarks)
  const out: SourceProfile[] = []
  for (const f of found) {
    const cookies = await locate(cookieCandidates(f.key) ?? [])
    // A missing cookie file is an empty jar, not a problem.
    out.push(profile(f.key, f.name, statusOf([cookies.probe, bookmarks])))
  }
  return out
}

/**
 * Every http(s) bookmark in Safari's bookmarks tree, in Safari's order, each
 * once. Folders are walked depth-first as Safari lists them; the Reading List
 * is a folder like any other and comes along.
 */
export function bookmarkUrls(root: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 64) return
    const n = node as Record<string, unknown>
    if (n.WebBookmarkType === 'WebBookmarkTypeLeaf' && typeof n.URLString === 'string') {
      const url = n.URLString.trim()
      if (/^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url)
        out.push(url)
      }
    }
    if (Array.isArray(n.Children)) for (const child of n.Children) walk(child, depth + 1)
  }
  walk(root, 0)
  return out
}

/** plutil's own failure, in a sentence: a timeout before a numeric code (gotcha 25). */
function describePlutilError(err: {
  code?: string | number | null
  killed?: boolean
  signal?: string | null
  stderr?: string
}): string {
  if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
    return `plutil did not finish within ${PLUTIL_TIMEOUT_MS / 1000}s`
  }
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'the file is larger than Stoke will read'
  if (err.code === 'ENOENT') return '/usr/bin/plutil is missing'
  const said = (err.stderr ?? '').trim().split('\n')[0]
  if (typeof err.code === 'number') return said ? `plutil exited with code ${err.code}: ${said}` : `plutil exited with code ${err.code}`
  return said || String(err.code ?? 'unknown error')
}

function plistToXml(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/plutil',
      ['-convert', 'xml1', '-o', '-', path],
      { encoding: 'utf8', timeout: PLUTIL_TIMEOUT_MS, maxBuffer: PLUTIL_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) reject(new Error(describePlutilError({ ...err, stderr })))
        else resolve(stdout)
      }
    )
  })
}

async function readBookmarks(): Promise<string[]> {
  const { bookmarks } = paths()
  const found = await probe(bookmarks)
  if (found.state === 'missing') return []
  if (found.state === 'denied') throw new Error(FULL_DISK_ACCESS_MESSAGE)
  if (found.state === 'failed') throw new Error(`Stoke could not open Safari's bookmarks (${found.code ?? 'unknown error'}).`)
  let xml: string
  try {
    xml = await plistToXml(bookmarks)
  } catch (err) {
    throw new Error(`Stoke could not read Safari's bookmarks: ${(err as Error).message}.`)
  }
  try {
    return bookmarkUrls(parsePlistXml(xml))
  } catch {
    throw new Error("Safari's bookmarks file is not in a form Stoke can read.")
  }
}

async function readCookies(key: string): Promise<{ cookies: ReadResult['cookies']; skipped: number }> {
  const candidates = cookieCandidates(key)
  if (!candidates) throw new Error('That Safari profile is not one Stoke can find any more. Scan again and pick it from the list.')
  const found = await locate(candidates)
  if (found.probe.state === 'missing') return { cookies: [], skipped: 0 }
  if (found.probe.state === 'denied') throw new Error(FULL_DISK_ACCESS_MESSAGE)

  let buf: Buffer
  try {
    buf = await readFile(found.path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (stateFor(code) === 'missing') return { cookies: [], skipped: 0 }
    if (stateFor(code) === 'denied') throw new Error(FULL_DISK_ACCESS_MESSAGE)
    throw new Error(`Stoke could not read Safari's cookies (${code ?? 'unknown error'}).`)
  }

  let parsed: SafariCookie[]
  try {
    parsed = parseBinaryCookies(buf)
  } catch (err) {
    throw new Error(`Safari's cookie file could not be read: ${(err as Error).message}.`)
  }
  const now = Date.now() / 1000
  const cookies: ReadResult['cookies'] = []
  let skipped = 0
  for (const c of parsed) {
    const mapped = safariCookieToElectron(c, now)
    if (mapped) cookies.push(mapped)
    else skipped++
  }
  return { cookies, skipped }
}

export const safariSource: BrowserSource = {
  async list() {
    if (process.platform !== 'darwin') return []
    try {
      return await listSafari()
    } catch (err) {
      return [
        profile(DEFAULT_KEY, 'Safari', {
          status: 'unreadable',
          note: `Stoke could not look at Safari's profiles (${(err as Error).message}).`
        })
      ]
    }
  },

  async read(source: SourceProfile, what: ReadWhat): Promise<ReadResult> {
    if (process.platform !== 'darwin') throw new Error("Safari's data can only be imported on a Mac.")
    if (source.browser !== 'safari') throw new Error('That profile is not a Safari profile.')
    const result: ReadResult = { cookies: [], skippedCookies: 0, bookmarks: [] }
    // Each half on its own: a failure reading one never throws the other away.
    if (what.cookies) {
      try {
        const { cookies, skipped } = await readCookies(source.key)
        result.cookies = cookies
        result.skippedCookies = skipped
      } catch (err) {
        result.cookieError = err instanceof Error ? err.message : String(err)
      }
    }
    if (what.bookmarks) result.bookmarks = await readBookmarks()
    return result
  }
}
