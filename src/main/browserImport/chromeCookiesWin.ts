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
  closeStuckMessage,
  closeVerdict,
  cookieIdentity,
  lockedCopyReport,
  parseCloseReport,
  reopenArgs,
  RESTART_MANAGER_SOURCE,
  sealedCookiesMissed,
  sealedReport
} from './chromeCookies.ts'
import type { CdpCookie, CloseReport } from './chromeCookies.ts'
import type { ChromiumBrowser } from './chromiumProfiles.ts'
import type { ImportBrowserId, ImportedCookie } from './types.ts'

/*
 * Windows Chrome-family logins, without cracking the seal — and without the ones
 * the seal keeps.
 *
 * Stoke never decrypts a Windows cookie itself: it has the user's OWN browser exe
 * open a copy of the profile and reads the plaintext back over CDP. That hands
 * over every plain-DPAPI (v10) row. It can NEVER hand over an app-bound (v20)
 * row, by Chromium's design (gotcha 130): app-bound decryption is available only
 * in the DEFAULT user-data dir (`kNotUsingDefaultUserDataDir` for any other), and
 * remote debugging — port or pipe — is refused on the default dir. v20 is what a
 * system-level Chrome (Program Files, elevation service installed) writes; a
 * per-user install has no service and writes v10, as do other browsers that
 * never adopted it. So the v20 rows are counted and reported, never lost
 * silently.
 *
 * The flow (all on the user's machine, own profile, own consent):
 *   1. Locate the browser's real .exe from the registry App Paths or a standard
 *      install dir — never a WindowsApps alias (gotcha 99).
 *   2. Copy the minimum — `Local State` (carries the wrapped key) and the
 *      profile's `Network/Cookies` (+ its -wal/-journal) — into a throwaway
 *      user-data-dir. On Windows Chromium holds the cookie DB under an EXCLUSIVE
 *      lock while the profile is open, so a running browser makes this fail
 *      (`lockedCopyReport` → the panel offers to close it, `closeBrowserForImport`,
 *      once per browser around the whole import — gotcha 135).
 *   3. Launch that .exe HEADLESS against the copy with a loopback debugging
 *      port (allowed there because the dir is not the default one).
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
 * How long the whole close script may run: Stoke's own wait for the processes to
 * go, plus room for `Add-Type` to compile and `RmShutdown` to deliver its
 * messages (it blocks until the app answers). Past it, PowerShell is killed and
 * the verdict is `timeout` — the browser is not reopened, since its state is
 * unknown.
 */
const CLOSE_SCRIPT_GRACE_MS = 60_000

export interface BrowserCloseOutcome {
  /** The browser's exe, when it could be found. */
  exePath: string | null
  /** It was running and has really exited: reopen it once the reads are done. */
  closed: boolean
  /** Why it is still holding its files, fit to show; its logins are then NOT read. */
  stillOpen?: string
  /** The script's own report, for the Windows e2e (`windows-e2e.mts chrome-close`). */
  report: CloseReport
}

/**
 * End the browser that owns the profile root `root` the way a Windows sign-out
 * does, so its whole session — every window — is kept for its next start
 * (gotcha 135), then wait (bounded) for its processes to be gone. Called ONCE per
 * browser per import, only on the user's explicit second press (`runImport`'s
 * lease). All variable data travels in the environment (gotcha 101); the scripts
 * are constants (`browserCloseScript`, `RESTART_MANAGER_SOURCE`). Never throws and
 * never force-kills: anything it cannot prove closed is a `stillOpen` message.
 */
export async function closeBrowserForImport(
  browser: ChromiumBrowser,
  root: string,
  opts: { exePath?: string; deadlineMs?: number } = {}
): Promise<BrowserCloseOutcome> {
  const empty: CloseReport = { started: null, windows: null, rm: null, remaining: null, error: null }
  const exePath = opts.exePath ?? (await locateChromiumExe(browser).catch(() => null))
  // No exe, nothing to close by — the read reports the missing program itself.
  if (!exePath) return { exePath: null, closed: false, report: empty }
  const deadlineMs = opts.deadlineMs ?? BROWSER_CLOSE_DEADLINE_MS
  let stdout = ''
  let timedOut = false
  try {
    const run = execFileAsync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', browserCloseScript()], {
      timeout: deadlineMs + CLOSE_SCRIPT_GRACE_MS,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        STOKE_BROWSER_EXE: exePath,
        STOKE_BROWSER_ROOT: root,
        STOKE_CLOSE_DEADLINE: String(deadlineMs),
        STOKE_RM_SOURCE: RESTART_MANAGER_SOURCE
      }
    })
    run.child.stdin?.end()
    stdout = (await run).stdout
  } catch (err) {
    // `killed` before anything else: a timeout has no exit code (gotcha 25).
    const e = err as { killed?: boolean; stdout?: string }
    timedOut = e.killed === true
    stdout = typeof e.stdout === 'string' ? e.stdout : ''
  }
  const report = parseCloseReport(stdout)
  const verdict = closeVerdict(report, timedOut)
  return {
    exePath,
    closed: verdict.closed,
    ...(verdict.stuck ? { stillOpen: closeStuckMessage(browser.name, verdict.stuck) } : {}),
    report
  }
}

/**
 * Reopen the user's browser after Stoke borrowed it: no arguments, so it brings
 * back every profile that was open and — if the user's own setting says so —
 * their windows and tabs (`reopenArgs`). Detached and unref'd so it outlives the
 * import; started in the browser's own folder, never Stoke's, because a process
 * whose working directory is inside Stoke's install folder can keep the portable
 * update's whole-folder rename from happening (gotcha 96). Best-effort: a failure
 * just means the user reopens it themselves.
 */
export function reopenBrowser(exePath: string): void {
  try {
    const child = spawn(exePath, reopenArgs(), {
      cwd: dirname(exePath),
      windowsHide: false,
      stdio: 'ignore',
      detached: true
    })
    child.once('error', () => {})
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
   * Stoke already asked this browser to close for this import (the user's second
   * press — `runImport` closes each browser once, around all its profiles). A copy
   * that is STILL locked is then reported without offering the close again.
   */
  afterClose?: boolean
}

export interface WinReadResult {
  cookies: ImportedCookie[]
  skipped: number
  cookieError?: string
  /** The copy was locked by the running browser: closing it for a moment would let the read happen. */
  needsClose?: boolean
}

/**
 * Read one Windows Chrome-family profile's cookies by driving the browser's own
 * binary against a copy. Returns already-decrypted, mapped cookies; a
 * `cookieError` is set (with the cookies that DID come over) when app-bound rows
 * stayed sealed (`sealedReport` — no copy can open them, gotcha 130) or the copy
 * was locked (`lockedCopyReport`, which alone sets `needsClose`) — never a silent
 * short read. It never closes or reopens the browser itself: that happens once
 * per browser around the whole import (`closeBrowserForImport`). Throws only for
 * a hard failure whose message is fit to show the user (bookmarks still import
 * around it).
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
  let copy: { copyDir: string; profileName: string; cookieCopyPath: string }
  try {
    copy = await copyProfile(profileDir)
  } catch (err) {
    if (!(err instanceof ProfileLockedError)) throw err
    // Held by the running browser (Chromium's exclusive lock). Stoke never
    // force-quits it: it offers the close once, and only once (no loop).
    return { cookies: [], skipped: 0, ...lockedCopyReport(browser.name, opts.afterClose === true) }
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
    // A v20 row the browser did not return is one it could not decrypt in a copy —
    // which, by Chromium's design, is every v20 row (gotcha 130). Report it (with
    // whatever DID come over) instead of a silent success, and never offer a
    // close for it: no close, retry or clean copy can unseal it.
    const sealed = dbRows ? sealedCookiesMissed(dbRows, cdpIdentities) : 0
    return { cookies, skipped, ...sealedReport(browser.name, sealed) }
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
