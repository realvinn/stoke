import { execFile } from 'node:child_process'
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { chromeKey, chromeRowToCookie, decryptChromeValue } from './chromeCookies.ts'
import type { ChromeCookieRow } from './chromeCookies.ts'
import type { BrowserSource, ImportBrowserId, ImportedCookie, ReadResult, ReadWhat, SourceProfile } from './types.ts'

const execFileAsync = promisify(execFile)

/*
 * Chrome, and the browsers built on the same Chromium profile layout, on macOS.
 *
 * Where each keeps its profiles and which Keychain item holds its cookie key.
 * Chrome's entry is the one proven on this machine's layout; the others follow
 * the same Chromium conventions and the Keychain names other importers use
 * (yt-dlp's), and are only ever touched when their folder exists.
 */
interface ChromiumBrowser {
  id: ImportBrowserId
  name: string
  /** Under ~/Library/Application Support. */
  dir: string
  /** The Keychain generic password's service. */
  keychain: string
}

const BROWSERS: ChromiumBrowser[] = [
  { id: 'chrome', name: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  { id: 'chrome-beta', name: 'Chrome Beta', dir: 'Google/Chrome Beta', keychain: 'Chrome Safe Storage' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { id: 'edge', name: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', keychain: 'Vivaldi Safe Storage' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium', keychain: 'Chromium Safe Storage' }
]

/** Long enough to answer a Keychain prompt; it waits on a person. */
const KEYCHAIN_TIMEOUT_MS = 120_000
/** Rows folded between yields, so a big jar never holds the event loop (gotcha 40). */
const ROWS_PER_TURN = 200

const support = (): string => join(homedir(), 'Library', 'Application Support')
const browserOf = (profile: SourceProfile): ChromiumBrowser | undefined => BROWSERS.find((b) => b.id === profile.browser)
const profileDirOf = (profile: SourceProfile, b: ChromiumBrowser): string =>
  join(support(), b.dir, profile.key.slice(b.id.length + 1))

const denied = (err: unknown): boolean => {
  const code = (err as { code?: string }).code
  return code === 'EPERM' || code === 'EACCES'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (err) {
    // A folder macOS will not let us into still exists — that is the case to report.
    return denied(err)
  }
}

/*
 * The cookie key, from the login Keychain, through Apple's own `security` tool.
 *
 * There is no Electron API for another app's Keychain item. The prompt macOS
 * shows names `security` asking for "Chrome Safe Storage". ALLOW is the safe
 * answer: it hands the password over once. "Always Allow" adds `security` to
 * the item's access list for good, after which any program on the Mac can read
 * the key without asking — so the UI says which button to press. The key is
 * kept only for the length of one import (`forgetChromeKeys`), never written,
 * and a refusal is remembered for that import too, so one Deny does not raise
 * a fresh prompt for every remaining profile of the same browser.
 */
const keys = new Map<string, Buffer | Error>()

/*
 * A test hook: an UNPACKAGED run may be handed the Keychain password in the
 * environment, so the whole read path can be driven against a synthetic
 * profile folder without any real Keychain item or browser file. A packaged
 * build never reads it.
 */
const testPassword = (): string | undefined =>
  app.isPackaged ? undefined : process.env.STOKE_TEST_CHROME_SAFE_STORAGE || undefined

async function keyFor(b: ChromiumBrowser): Promise<Buffer> {
  const cached = keys.get(b.keychain)
  if (cached instanceof Error) throw cached
  if (cached) return cached
  const test = testPassword()
  if (test) {
    const key = chromeKey(test)
    keys.set(b.keychain, key)
    return key
  }
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-w', '-s', b.keychain], {
      timeout: KEYCHAIN_TIMEOUT_MS,
      encoding: 'utf8'
    })
    const password = stdout.replace(/\n$/, '')
    if (!password) throw new Error('empty')
    const key = chromeKey(password)
    keys.set(b.keychain, key)
    return key
  } catch (err) {
    const e = err as { killed?: boolean; code?: number | string }
    // `killed` before the code: a timeout has no exit code at all (gotcha 25).
    const refusal = e.killed
      ? new Error(`macOS's Keychain prompt for ${b.name} was not answered in time, so no logins were read.`)
      : e.code === 44
        ? new Error(`${b.name}'s cookie key is not in your Keychain — has ${b.name} been opened on this Mac?`)
        : new Error(`macOS did not hand Stoke ${b.name}'s cookie key: the Keychain prompt was denied or closed.`)
    keys.set(b.keychain, refusal)
    throw refusal
  }
}

/** Drop every key read during an import. Called when the import ends, however it ends. */
export function forgetChromeKeys(): void {
  for (const key of keys.values()) if (Buffer.isBuffer(key)) key.fill(0)
  keys.clear()
}

async function listBrowser(b: ChromiumBrowser): Promise<SourceProfile[]> {
  const root = join(support(), b.dir)
  if (!(await exists(root))) return []
  let state: { profile?: { info_cache?: Record<string, { name?: string; user_name?: string }>; profiles_order?: string[] } }
  try {
    state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'))
  } catch (err) {
    return [
      {
        key: `${b.id}/*`,
        browser: b.id,
        browserName: b.name,
        name: b.name,
        detail: '',
        status: denied(err) ? 'needsAppData' : 'unreadable',
        note: denied(err)
          ? `macOS is keeping ${b.name}'s folder from Stoke. Press Look again and choose Allow when macOS asks whether Stoke may access data from other apps.`
          : `${b.name}'s profile list could not be read.`
      }
    ]
  }
  const cache = state.profile?.info_cache ?? {}
  const order = (state.profile?.profiles_order ?? []).filter((d) => d in cache)
  const dirs = [...order, ...Object.keys(cache).filter((d) => !order.includes(d))]
  return dirs.map((dir) => ({
    key: `${b.id}/${dir}`,
    browser: b.id,
    browserName: b.name,
    name: cache[dir]?.name || dir,
    detail: cache[dir]?.user_name || '',
    status: 'ready' as const
  }))
}

/**
 * A copy of a live SQLite file and the sidecars that carry data: the browser
 * may be running and holding them. The WAL holds committed rows not yet in the
 * main file; a hot rollback journal is how SQLite undoes a half-written
 * transaction on the copy. Not `-shm`: it is an index SQLite rebuilds from the
 * WAL, and a copy of one taken mid-write points at the wrong frames.
 */
async function snapshot(dbPath: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'stoke-import-'))
  const path = join(dir, 'db.sqlite')
  try {
    await copyFile(dbPath, path)
    for (const suffix of ['-wal', '-journal']) await copyFile(dbPath + suffix, path + suffix).catch(() => {})
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  return { dir, path }
}

async function readCookies(b: ChromiumBrowser, profileDir: string): Promise<{ cookies: ImportedCookie[]; skipped: number }> {
  let dbPath = join(profileDir, 'Cookies')
  if (!(await exists(dbPath))) dbPath = join(profileDir, 'Network', 'Cookies')
  if (!(await exists(dbPath))) return { cookies: [], skipped: 0 }
  const key = await keyFor(b)
  const snap = await snapshot(dbPath)
  // Loaded here, not at the top: only an import ever needs SQLite (gotcha 40).
  const { DatabaseSync } = await import('node:sqlite')
  // Read-write, on the private copy: a hot journal can only be rolled back by a
  // connection that may write, and a read-only open of one fails outright.
  let db: InstanceType<typeof DatabaseSync>
  try {
    db = new DatabaseSync(snap.path)
  } catch (err) {
    await rm(snap.dir, { recursive: true, force: true })
    throw err
  }
  try {
    const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string })?.value ?? 0)
    const columns = new Set(
      (db.prepare('PRAGMA table_info(cookies)').all() as { name: string }[]).map((c) => c.name)
    )
    const wanted = ['host_key', 'name', 'value', 'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly', 'has_expires', 'samesite']
    if (!wanted.every((c) => columns.has(c))) throw new Error(`${b.name}'s cookie store is in a format Stoke does not know.`)
    const select = [...wanted, ...(columns.has('top_frame_site_key') ? ['top_frame_site_key'] : [])].join(', ')
    const stmt = db.prepare(`SELECT ${select} FROM cookies`)
    // Chrome's times are past 2^53 microseconds; without bigints the read throws.
    stmt.setReadBigInts(true)
    const now = Math.floor(Date.now() / 1000)
    const cookies: ImportedCookie[] = []
    let skipped = 0
    let n = 0
    for (const raw of stmt.iterate()) {
      const row = raw as unknown as ChromeCookieRow
      const plain = typeof row.value === 'string' && row.value !== '' ? row.value : null
      // No ciphertext and no plaintext is an empty cookie, not an undecryptable one.
      const cipher = row.encrypted_value && row.encrypted_value.length > 0 ? row.encrypted_value : null
      const value = plain ?? (cipher ? decryptChromeValue(cipher, key, String(row.host_key), version) : '')
      const mapped = chromeRowToCookie(row, value, now)
      if (typeof mapped === 'string') skipped++
      else cookies.push(mapped)
      if (++n % ROWS_PER_TURN === 0) await new Promise((r) => setImmediate(r))
    }
    return { cookies, skipped }
  } finally {
    db.close()
    await rm(snap.dir, { recursive: true, force: true })
  }
}

interface ChromeBookmarkNode {
  type?: string
  url?: string
  children?: ChromeBookmarkNode[]
}

async function readBookmarks(profileDir: string): Promise<string[]> {
  /*
   * Both files: `Bookmarks` is the ones kept on this Mac, and `AccountBookmarks`
   * is where current Chrome keeps the ones stored in the signed-in account. A
   * profile synced that way can have nearly everything in the second.
   */
  const trees: Record<string, ChromeBookmarkNode>[] = []
  for (const file of ['Bookmarks', 'AccountBookmarks']) {
    try {
      const parsed = JSON.parse(await readFile(join(profileDir, file), 'utf8')) as { roots?: Record<string, ChromeBookmarkNode> }
      if (parsed.roots) trees.push(parsed.roots)
    } catch {
      /* absent, or not JSON: that file contributes nothing */
    }
  }
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (node: ChromeBookmarkNode | undefined): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'url' && typeof node.url === 'string' && /^https?:\/\//i.test(node.url) && !seen.has(node.url)) {
      seen.add(node.url)
      out.push(node.url)
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  for (const roots of trees) for (const root of ['bookmark_bar', 'other', 'synced']) walk(roots[root])
  return out
}

export const chromeSource: BrowserSource = {
  async list(): Promise<SourceProfile[]> {
    if (process.platform !== 'darwin') return []
    const found = await Promise.all(BROWSERS.map((b) => listBrowser(b).catch(() => [])))
    return found.flat()
  },

  async read(profile: SourceProfile, what: ReadWhat): Promise<ReadResult> {
    const b = browserOf(profile)
    if (!b || profile.key.endsWith('/*')) throw new Error(profile.note ?? 'This profile cannot be read.')
    const dir = profileDirOf(profile, b)
    const bookmarks = what.bookmarks ? await readBookmarks(dir) : []
    if (!what.cookies) return { cookies: [], skippedCookies: 0, bookmarks }
    try {
      const { cookies, skipped } = await readCookies(b, dir)
      return { cookies, skippedCookies: skipped, bookmarks }
    } catch (err) {
      return { cookies: [], skippedCookies: 0, bookmarks, cookieError: err instanceof Error ? err.message : String(err) }
    }
  }
}
