import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, win32 as winPath } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import {
  appPathMatchesBrowser,
  browserCloseScript,
  BROWSER_CLOSE_DEADLINE_MS,
  cdpCookieToImported,
  cookieIdentity,
  reopenArgs,
  sealedCookiesMissed
} from './chromeCookies.ts'
import type { CdpCookie } from './chromeCookies.ts'
import type { ChromiumBrowser } from './chromiumProfiles.ts'
import type { ImportBrowserId, ImportedCookie } from './types.ts'

/*
 * Windows Chrome-family logins, without cracking the seal.
 *
 * Since Chrome 127 the cookie key is wrapped with DPAPI + app-bound encryption
 * (a v20 tag), unwrappable only by the browser's own signed binary through its
 * elevation service — a wall no third-party app, Electron included, can climb.
 * So Stoke does not try: it asks the user's OWN chrome.exe to do the decrypting,
 * on the user's own machine, and reads the plaintext back over CDP. The browser
 * itself is the only thing that can open its jar, and here it opens it for its
 * owner, who asked.
 *
 * The flow (all on the user's machine, own profile, own consent):
 *   1. Locate the browser's real .exe from the registry App Paths or a standard
 *      install dir — never a WindowsApps alias (gotcha 99), which is a Store
 *      stub that would fail the elevation service's path check anyway.
 *   2. Copy the minimum — `Local State` (carries the wrapped key) and the
 *      profile's `Network/Cookies` (+ its -wal/-journal) — into a throwaway
 *      user-data-dir. The INTENT is that the ABE key is bound to the machine, the
 *      Windows user and the exe path, not the profile directory, so the copy
 *      still decrypts — UNPROVEN for v20 on real Windows (see gotcha 130); step 5
 *      reports any app-bound row the browser then refuses to hand back.
 *   3. Launch that .exe HEADLESS against the copy with a loopback debugging
 *      port. Chrome 136+ ignores the debug flag on the DEFAULT dir; a non-standard
 *      --user-data-dir is exactly why the copy is required (and why the copy
 *      never needs the user's live Chrome closed — a separate instance, own lock).
 *   4. `Storage.getCookies` returns already-decrypted values, HttpOnly included,
 *      which map to `ImportedCookie` by the same gotcha-107 rules as the SQLite
 *      path (host-only → no domain, samesite, 30-day session expiry, skip CHIPS).
 *      A cookie the browser could NOT decrypt is dropped from that list with no
 *      error, so before the launch the copied DB's app-bound (v20) rows are noted
 *      (`readCookieTags`) and any that do not come back are reported, not lost
 *      (`sealedCookiesMissed`) — the whole answer is the DB, not what CDP returns.
 *   5. Always close the browser, kill the child and delete the copy (finally):
 *      the copy holds a decryptable jar, so its removal is a security step.
 *
 * Values never leave main, never cross IPC, never touch a log — the same rule
 * the macOS path keeps. Nothing here runs on the boot path: chrome.ts imports
 * this module lazily, only when a Windows login import is asked for (gotcha 40).
 */

/** A copy this cannot make means the user's Chrome is holding the file. */
export class ProfileLockedError extends Error {}

/** Whether a path is inside `%LOCALAPPDATA%\Microsoft\WindowsApps` (a Store alias). Mirrors cli.ts's `isWindowsAppsAlias` (gotcha 99). */
function isWindowsAppsAlias(p: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(p)
}

/** Standard install locations, tried after the registry, relative to each base below. */
const INSTALL_SUBPATHS: Partial<Record<ImportBrowserId, string[]>> = {
  chrome: ['Google\\Chrome\\Application\\chrome.exe'],
  'chrome-beta': ['Google\\Chrome Beta\\Application\\chrome.exe'],
  brave: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  edge: ['Microsoft\\Edge\\Application\\msedge.exe'],
  vivaldi: ['Vivaldi\\Application\\vivaldi.exe'],
  chromium: ['Chromium\\Application\\chrome.exe']
}

const execFileAsync = promisify(execFile)
const WIN_PROBE_TIMEOUT_MS = 15_000
/** How long to wait for the headless browser to write its DevToolsActivePort. */
const DEVTOOLS_PORT_TIMEOUT_MS = 20_000
/** A single CDP request's ceiling. */
const CDP_CALL_TIMEOUT_MS = 15_000
/** How long a `copyFile` may be retried while the source is briefly locked. */
const COPY_RETRIES = 3

async function isFile(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Windows PowerShell 5.1's own path — the interpreter Stoke drives for every Windows probe. */
function powershellPath(): string {
  return join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

/**
 * The exe path from the registry's App Paths, HKLM then HKCU, or null. Read
 * through PowerShell (never reg.exe, which mangles non-ASCII — gotcha 99); the
 * exe NAME travels in the environment, not spliced into the script (gotcha 101).
 */
async function appPathsExe(exeName: string): Promise<string | null> {
  const ps = powershellPath()
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$n = $env:STOKE_EXE_NAME',
    "foreach ($root in 'HKLM:', 'HKCU:') {",
    "  $k = Join-Path $root ('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + $n)",
    '  try {',
    "    $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)'",
    '    if ($v) { [Console]::Out.WriteLine($v); break }',
    '  } catch { }',
    '}'
  ].join('\n')
  try {
    const run = execFileAsync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: WIN_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, STOKE_EXE_NAME: exeName }
    })
    run.child.stdin?.end()
    const { stdout } = await run
    const line = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    return line || null
  } catch {
    return null
  }
}

/**
 * The browser's real executable, or null. App Paths first, then the standard
 * install dirs under Program Files and %LOCALAPPDATA%. A WindowsApps alias is
 * never returned — it is a Store stub, and the elevation service would reject it.
 */
export async function locateChromiumExe(browser: Pick<ChromiumBrowser, 'id' | 'winExe'>): Promise<string | null> {
  if (!browser.winExe) return null
  const subpaths = INSTALL_SUBPATHS[browser.id] ?? []
  const viaReg = await appPathsExe(browser.winExe)
  // Accept the registry hit only if it is THIS browser's own binary: chrome.exe
  // is shared by Stable/Beta/Chromium under one App Paths key, so the lookup can
  // point at another channel's exe, which decrypts nothing here (gotcha 130).
  if (viaReg && !isWindowsAppsAlias(viaReg) && appPathMatchesBrowser(viaReg, subpaths) && (await isFile(viaReg))) {
    return viaReg
  }
  const bases = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(
    (b): b is string => Boolean(b)
  )
  for (const sub of subpaths) {
    for (const base of bases) {
      const p = winPath.join(base, sub)
      if (!isWindowsAppsAlias(p) && (await isFile(p))) return p
    }
  }
  return null
}

/**
 * Ask the browser at `exePath` to close every top-level window gracefully, then
 * wait (bounded) for its processes to exit. Returns whether it was RUNNING at
 * entry — so the caller reopens only a browser it actually closed (never opens
 * one the user had already shut). All variable data travels in the environment
 * (gotcha 101); the script is a constant (`browserCloseScript`). A close probe
 * that cannot run reports "not running" (false), so a failure never reopens.
 */
async function closeBrowserGracefully(exePath: string, deadlineMs: number): Promise<boolean> {
  try {
    const run = execFileAsync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', browserCloseScript()], {
      timeout: deadlineMs + 10_000,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, STOKE_BROWSER_EXE: exePath, STOKE_CLOSE_DEADLINE: String(deadlineMs) }
    })
    run.child.stdin?.end()
    const { stdout } = await run
    const m = /started=(\d+)/.exec(stdout)
    return m ? Number(m[1]) > 0 : false
  } catch {
    return false
  }
}

/**
 * Reopen the user's browser on `profileName` after Stoke borrowed it. Detached
 * and unref'd so it outlives this import, with no `--user-data-dir` so it opens
 * the user's normal session (and restores its tabs if the browser is set to).
 * Best-effort: a failure just means the user reopens it themselves.
 */
function reopenBrowser(exePath: string, profileName: string): void {
  try {
    const child = spawn(exePath, reopenArgs(profileName), { windowsHide: false, stdio: 'ignore', detached: true })
    child.unref()
  } catch {
    /* the user can reopen it themselves */
  }
}

/** Copy one file, retrying a transient Windows sharing violation; a persistent one is a locked profile. */
async function copyMaybeLocked(from: string, to: string): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < COPY_RETRIES; i++) {
    try {
      await copyFile(from, to)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      // ENOENT is not a lock — the sidecar or the file is simply absent.
      if (code === 'ENOENT') throw err
      lastErr = err
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        await new Promise((r) => setTimeout(r, 150))
        continue
      }
      throw err
    }
  }
  throw new ProfileLockedError(String((lastErr as { message?: string })?.message ?? lastErr))
}

/**
 * Copy `Local State` and the profile's cookie DB (with its sidecars) into a
 * fresh throwaway user-data-dir, keeping the layout Chrome expects
 * (`<copy>/Local State`, `<copy>/<Profile>/Network/Cookies`). Returns the copy
 * root and the profile subdirectory name for `--profile-directory`.
 */
async function copyProfile(profileDir: string): Promise<{ copyDir: string; profileName: string; cookieCopyPath: string }> {
  const root = dirname(profileDir)
  const profileName = basename(profileDir)
  const localState = join(root, 'Local State')
  if (!(await isFile(localState))) {
    throw new Error("This profile has no Local State file, so its cookie key cannot be found — has the browser been opened on this PC?")
  }
  // The cookie DB is under Network/ on current Chrome; some builds put it at the
  // profile root. Mirror WHICHEVER the source uses into the copy — the relaunched
  // browser is the same build and reads from the same place.
  const cookieRel = (await isFile(join(profileDir, 'Network', 'Cookies')))
    ? ['Network', 'Cookies']
    : (await isFile(join(profileDir, 'Cookies')))
      ? ['Cookies']
      : null
  if (!cookieRel) throw new Error('This profile has no cookie store to read.')
  const cookieSrc = join(profileDir, ...cookieRel)

  const copyDir = await mkdtemp(join(tmpdir(), 'stoke-winimport-'))
  const cookieCopyPath = join(copyDir, profileName, ...cookieRel)
  try {
    await copyMaybeLocked(localState, join(copyDir, 'Local State'))
    await mkdir(dirname(cookieCopyPath), { recursive: true })
    await copyMaybeLocked(cookieSrc, cookieCopyPath)
    // Sidecars are best-effort: a hot WAL carries committed rows not yet folded in,
    // but an absent one is normal, not a lock.
    for (const suffix of ['-wal', '-journal']) {
      await copyFile(cookieSrc + suffix, cookieCopyPath + suffix).catch(() => {})
    }
  } catch (err) {
    await rm(copyDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return { copyDir, profileName, cookieCopyPath }
}

/**
 * The `(host_key, name, tag)` of every row in the copied cookie DB, read BEFORE
 * the browser reopens the copy. `tag` is the 3-byte scheme prefix — `v10` plain
 * DPAPI, `v20` app-bound — used only to tell which un-returned rows were sealed
 * (`sealedCookiesMissed`). Best-effort: a read failure returns null, and the
 * import proceeds without the sealed-count check rather than throwing.
 */
async function readCookieTags(dbPath: string): Promise<{ host_key: string; name: string; tag: string }[] | null> {
  try {
    // Lazy, like chrome.ts: only an import ever needs SQLite (gotcha 40).
    const { DatabaseSync } = await import('node:sqlite')
    // Read-write on the private copy, as chrome.ts does: a read-only open fails
    // outright on a hot journal, which a fresh copy of a live DB can carry.
    const db = new DatabaseSync(dbPath)
    try {
      const rows = db
        .prepare('SELECT host_key AS host_key, name AS name, hex(substr(encrypted_value, 1, 3)) AS tag FROM cookies')
        .all() as { host_key: string; name: string; tag: string | null }[]
      return rows.map((r) => ({
        host_key: String(r.host_key ?? ''),
        name: String(r.name ?? ''),
        tag: r.tag ? Buffer.from(String(r.tag), 'hex').toString('latin1') : ''
      }))
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Read the first line (the port) of the browser's DevToolsActivePort file once it appears. */
async function waitForDebugPort(copyDir: string, deadline: number): Promise<number> {
  const file = join(copyDir, 'DevToolsActivePort')
  for (;;) {
    try {
      const text = await readFile(file, 'utf8')
      const port = Number(text.split(/\r?\n/)[0]?.trim())
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) {
      throw new Error(
        'The browser never opened its debugging endpoint — it may be blocked by policy, or debugging was refused on this profile.'
      )
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** A tiny CDP client over the browser-level WebSocket: one request/response at a time. */
async function withBrowserWs<T>(wsUrl: string, fn: (send: (method: string, params?: object) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  let nextId = 0
  ws.on('message', (data: Buffer) => {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message ?? 'CDP error'))
    else waiter.resolve(msg.result ?? {})
  })
  const send = (method: string, params: object = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`))
      }, CDP_CALL_TIMEOUT_MS)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP socket did not open')), CDP_CALL_TIMEOUT_MS)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    return await fn(send)
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error('CDP socket closed'))
    pending.clear()
    try {
      ws.close()
    } catch {
      /* already closing */
    }
  }
}

export interface WinReadOptions {
  /** Override the located executable (the CI e2e passes the runner's Chrome). */
  exePath?: string
  /**
   * The user consented to Stoke closing the browser first (its files were
   * locked, or app-bound logins would not decrypt), then reopening it after the
   * read. Off by default — taken only on an explicit second press.
   */
  closeAndReopen?: boolean
}

export interface WinReadResult {
  cookies: ImportedCookie[]
  skipped: number
  cookieError?: string
  /** True when the `cookieError` is one closing and reopening the browser could resolve. */
  needsClose?: boolean
}

/**
 * Read one Windows Chrome-family profile's cookies by driving the browser's own
 * binary. Returns already-decrypted, mapped cookies; a `cookieError` is set (with
 * the cookies that DID come over) when some app-bound logins could not be
 * decrypted or the profile files were locked — never a silent short read
 * (gotcha 130). `needsClose` marks the cases the close-and-reopen flow could
 * resolve. With `opts.closeAndReopen`, the browser is gracefully closed first
 * and reopened afterwards (never force-killed). Throws only for a hard failure
 * whose message is fit to show the user (bookmarks still import around it).
 */
export async function readChromeCookiesWin(
  browser: ChromiumBrowser,
  profileDir: string,
  opts: WinReadOptions = {}
): Promise<WinReadResult> {
  const exePath = opts.exePath ?? (await locateChromiumExe(browser))
  if (!exePath) {
    throw new Error(`Stoke could not find ${browser.name}'s program on this PC, so it could not open its logins.`)
  }

  // The flow the owner asked for: with the user's consent, close the browser for
  // a moment, copy the logins from a clean/unlocked profile, then reopen it. The
  // reopen runs however the read ends (finally), so a failure never leaves the
  // browser shut. Nothing here force-kills it.
  let closedARunningBrowser = false
  if (opts.closeAndReopen) {
    closedARunningBrowser = await closeBrowserGracefully(exePath, BROWSER_CLOSE_DEADLINE_MS)
  }
  try {
    return await readCopyAndDecrypt(browser, profileDir, exePath, opts.closeAndReopen === true)
  } finally {
    // Reopen only what we actually closed — never open a browser the user had shut.
    if (closedARunningBrowser) reopenBrowser(exePath, basename(profileDir))
  }
}

/** Copy the profile, launch the browser headless against the copy, and read its cookies over CDP. */
async function readCopyAndDecrypt(
  browser: ChromiumBrowser,
  profileDir: string,
  exePath: string,
  closedFirst: boolean
): Promise<WinReadResult> {
  let copy: { copyDir: string; profileName: string; cookieCopyPath: string }
  try {
    copy = await copyProfile(profileDir)
  } catch (err) {
    if (!(err instanceof ProfileLockedError)) throw err
    // The files are held by a running browser. Stoke never force-quits it: if it
    // has not already asked (closedFirst), it offers the close-and-reopen flow;
    // if it just asked and the files are STILL held, it tells the user to close
    // the browser themselves and does not offer to try again (no loop).
    const cookieError = closedFirst
      ? `${browser.name} is still holding its logins even after Stoke asked it to close. Close every ${browser.name} window yourself, then import again — Stoke never forces it to quit.`
      : `${browser.name} is holding its logins open, so Stoke could not copy them. Stoke can close ${browser.name} for a moment and bring it back, or you can close it yourself and import again — it never forces it to quit.`
    return { cookies: [], skipped: 0, cookieError, needsClose: !closedFirst }
  }
  const { copyDir, profileName, cookieCopyPath } = copy
  // Ground truth BEFORE the browser reopens the copy: which rows are app-bound.
  // If any v20 row does not come back over CDP, the browser dropped it as
  // undecryptable and we must say so rather than report a silent short read.
  const dbRows = await readCookieTags(cookieCopyPath)
  let child: ChildProcess | null = null
  try {
    const args = [
      `--user-data-dir=${copyDir}`,
      `--profile-directory=${profileName}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--remote-debugging-port=0',
      // Bind the debug endpoint to loopback only; never a routable address.
      '--remote-debugging-address=127.0.0.1',
      'about:blank'
    ]
    child = spawn(exePath, args, { windowsHide: true, stdio: 'ignore' })
    const spawnFailed = new Promise<never>((_, reject) => {
      child?.once('error', (e) => reject(new Error(`Could not start ${browser.name}: ${e.message}`)))
    })

    const port = await Promise.race([waitForDebugPort(copyDir, Date.now() + DEVTOOLS_PORT_TIMEOUT_MS), spawnFailed])
    const version = (await Promise.race([
      fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>),
      spawnFailed
    ])) as { webSocketDebuggerUrl?: string }
    const wsUrl = version.webSocketDebuggerUrl
    if (!wsUrl) throw new Error('The browser opened a debugging endpoint but gave no WebSocket to attach to.')

    const now = Math.floor(Date.now() / 1000)
    const cookies: ImportedCookie[] = []
    let skipped = 0
    // What the browser handed back, by identity, so a v20 row it silently dropped
    // (could not decrypt) can be counted against the DB it was read from.
    const cdpIdentities = new Set<string>()
    await withBrowserWs(wsUrl, async (send) => {
      const result = (await send('Storage.getCookies')) as { cookies?: CdpCookie[] }
      for (const c of result.cookies ?? []) {
        cdpIdentities.add(cookieIdentity(String(c.domain ?? ''), String(c.name ?? '')))
        const mapped = cdpCookieToImported(c, now)
        if (typeof mapped === 'string') skipped++
        else cookies.push(mapped)
      }
      // Graceful close flushes the browser and ends its child processes.
      await send('Browser.close').catch(() => {})
    })
    // A v20 row the browser did not return is a login it could not decrypt here.
    // Report it (with whatever DID come over) instead of a silent success — the
    // failure a copied, non-default profile dir can cause on real Windows.
    const sealed = dbRows ? sealedCookiesMissed(dbRows, cdpIdentities) : 0
    if (sealed === 0) return { cookies, skipped }
    // Offer the close-and-reopen retry once: a browser closed cleanly leaves a
    // fully flushed profile, which a hot copy (WAL mid-write) is not, and which
    // MAY read where the running copy did not. Honest, not a promise — a v20 row
    // a copied non-default dir genuinely cannot decrypt stays sealed either way.
    const cookieError = closedFirst
      ? `${sealed} ${sealed === 1 ? 'login is' : 'logins are'} sealed with app-bound encryption that ${browser.name} would not open for Stoke on this PC, so ${sealed === 1 ? 'it' : 'they'} stayed behind. Any others came over; you stay signed in in ${browser.name}.`
      : `${sealed} ${sealed === 1 ? 'login' : 'logins'} could not be handed over while ${browser.name} was running. Stoke can close ${browser.name} for a moment and try once more; some may still stay behind, and you stay signed in in ${browser.name} regardless.`
    return { cookies, skipped, cookieError, needsClose: !closedFirst }
  } finally {
    if (child) {
      // A graceful Browser.close ends the whole tree; give it a moment, then insist.
      const exited = await waitExit(child, 3000)
      if (!exited) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        await waitExit(child, 2000)
      }
    }
    // The copy holds a decryptable jar: a leftover handle must not leave it on disk.
    await rmRetry(copyDir)
  }
}

/** Resolve true if the child has exited within `ms`, false on timeout. */
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** Remove the throwaway copy, retrying while a just-closed browser still holds a handle. */
async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
