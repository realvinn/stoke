import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, win32 as winPath } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { cdpCookieToImported } from './chromeCookies.ts'
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
 *      user-data-dir. The ABE key is bound to the machine, the Windows user and
 *      the exe path, NOT to the profile directory, so the copy still decrypts.
 *   3. Launch that .exe HEADLESS against the copy with a loopback debugging
 *      port. Chrome 136+ ignores the debug flag on the DEFAULT dir; a non-standard
 *      --user-data-dir is exactly why the copy is required (and why the copy
 *      never needs the user's live Chrome closed — a separate instance, own lock).
 *   4. `Storage.getCookies` returns already-decrypted values, HttpOnly included,
 *      which map to `ImportedCookie` by the same gotcha-107 rules as the SQLite
 *      path (host-only → no domain, samesite, 30-day session expiry, skip CHIPS).
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

/**
 * The exe path from the registry's App Paths, HKLM then HKCU, or null. Read
 * through PowerShell (never reg.exe, which mangles non-ASCII — gotcha 99); the
 * exe NAME travels in the environment, not spliced into the script (gotcha 101).
 */
async function appPathsExe(exeName: string): Promise<string | null> {
  const ps = join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
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
  const viaReg = await appPathsExe(browser.winExe)
  if (viaReg && !isWindowsAppsAlias(viaReg) && (await isFile(viaReg))) return viaReg
  const bases = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(
    (b): b is string => Boolean(b)
  )
  for (const sub of INSTALL_SUBPATHS[browser.id] ?? []) {
    for (const base of bases) {
      const p = winPath.join(base, sub)
      if (!isWindowsAppsAlias(p) && (await isFile(p))) return p
    }
  }
  return null
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
async function copyProfile(profileDir: string): Promise<{ copyDir: string; profileName: string }> {
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
  try {
    await copyMaybeLocked(localState, join(copyDir, 'Local State'))
    const cookieDst = join(copyDir, profileName, ...cookieRel)
    await mkdir(dirname(cookieDst), { recursive: true })
    await copyMaybeLocked(cookieSrc, cookieDst)
    // Sidecars are best-effort: a hot WAL carries committed rows not yet folded in,
    // but an absent one is normal, not a lock.
    for (const suffix of ['-wal', '-journal']) {
      await copyFile(cookieSrc + suffix, cookieDst + suffix).catch(() => {})
    }
  } catch (err) {
    await rm(copyDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return { copyDir, profileName }
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
}

/**
 * Read one Windows Chrome-family profile's cookies by driving the browser's own
 * binary. Returns already-decrypted, mapped cookies; throws an Error whose
 * message is fit to show the user (bookmarks still import around it), or a
 * `ProfileLockedError` when the profile files cannot be copied.
 */
export async function readChromeCookiesWin(
  browser: ChromiumBrowser,
  profileDir: string,
  opts: WinReadOptions = {}
): Promise<{ cookies: ImportedCookie[]; skipped: number }> {
  const exePath = opts.exePath ?? (await locateChromiumExe(browser))
  if (!exePath) {
    throw new Error(`Stoke could not find ${browser.name}'s program on this PC, so it could not open its logins.`)
  }

  let copy: { copyDir: string; profileName: string }
  try {
    copy = await copyProfile(profileDir)
  } catch (err) {
    // A locked copy is the one case where the user must close their own browser.
    // Stoke asks — it never forces it to quit (the repo-wide "never force-kill").
    if (err instanceof ProfileLockedError) {
      throw new Error(
        `${browser.name} is holding its logins open, so Stoke could not copy them. Close ${browser.name} completely, then import again — Stoke never forces it to quit.`
      )
    }
    throw err
  }
  const { copyDir, profileName } = copy
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
    await withBrowserWs(wsUrl, async (send) => {
      const result = (await send('Storage.getCookies')) as { cookies?: CdpCookie[] }
      for (const c of result.cookies ?? []) {
        const mapped = cdpCookieToImported(c, now)
        if (typeof mapped === 'string') skipped++
        else cookies.push(mapped)
      }
      // Graceful close flushes the browser and ends its child processes.
      await send('Browser.close').catch(() => {})
    })
    return { cookies, skipped }
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
