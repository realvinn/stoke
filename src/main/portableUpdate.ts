/*
 * A portable Stoke updating itself: find out what kind of copy this is, fetch
 * the new portable zip, unpack it beside the running folder, and start the
 * helper that swaps the two once Stoke has quit (portableSwap.ts).
 *
 * The decision of WHAT kind of copy this is lives in src/shared/installKind.ts
 * and is pure; this file only gathers the facts it needs and does the I/O. No
 * electron import — the network call is handed in (selfUpdate.ts passes
 * Electron's `net.fetch`, which honours the system proxy the way
 * electron-updater's own downloads do) — so verify:portable can drive every
 * step here against a local server and a scratch folder.
 *
 * Every step is refused rather than guessed at:
 *   - the download must match the size and the BASE64 sha512 that release's
 *     own latest.yml lists for the zip (the publish job injects those entries,
 *     scripts/add-portable-to-manifest.mjs), or the file is deleted;
 *   - the unpacked copy must hold Stoke.exe, resources/app.asar and
 *     resources/app-update.yml — the last because a copy without it could never
 *     update again, and nothing else would notice (electron-builder writes it
 *     only when an nsis target is in the same run);
 *   - the version inside the unpacked app.asar must be the version offered.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { UNINSTALLER_NAME, type InstallFacts } from '../shared/installKind.ts'
import { SWAP_SCRIPT, isLeftover, planJson, swapArgs, type SwapPlan } from './portableSwap.ts'

const execFileAsync = promisify(execFile)

/*
 * Every recursive delete goes through this, and in Stoke it is `original-fs`'s.
 * Electron's own `fs` treats any `app.asar` as a directory — that is how
 * `asarVersion` below can read a file inside one — so a recursive `rm` of an
 * unpacked copy walks INTO its archive and fails on the first virtual file.
 * selfUpdate.ts hands in the unpatched remover; a suite runs under plain node,
 * where the default is already the real thing.
 */
type Remover = (path: string, opts: { recursive?: boolean; force?: boolean }) => Promise<void>
let remove: Remover = rm
export function useRemover(fn: Remover): void {
  remove = fn
}

/** A promise that gives up after `ms`, resolving to `fallback` (gotcha 40: never bet boot on a disk). */
function within<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(fallback)
      }
    )
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a folder can be made beside `dir`. `fs.access(W_OK)` cannot answer
 * this on Windows — it "does not check the ACL" (Node's own docs) — so a real
 * folder is made and removed, in the PARENT, which is where the portable swap
 * needs rights: the new copy is unpacked there and both renames happen there.
 */
export async function canWriteBeside(dir: string): Promise<boolean> {
  try {
    const probe = await mkdtemp(join(dirname(dir), '.stoke-write-probe-'))
    await rmdir(probe)
    return true
  } catch {
    return false
  }
}

export interface ProbeEnv {
  platform: string
  packaged: boolean
  execPath: string
  env: NodeJS.ProcessEnv
}

/**
 * The facts `classifyInstall` decides on. On Windows the exe's folder is
 * resolved through `realpath` first: a copy reached through a junction or a
 * winget `Links` symlink must be judged, and later swapped, where it really is.
 */
export async function gatherInstallFacts(e: ProbeEnv): Promise<InstallFacts> {
  const env = {
    PORTABLE_EXECUTABLE_FILE: e.env.PORTABLE_EXECUTABLE_FILE,
    LOCALAPPDATA: e.env.LOCALAPPDATA,
    USERPROFILE: e.env.USERPROFILE,
    SCOOP: e.env.SCOOP,
    SCOOP_GLOBAL: e.env.SCOOP_GLOBAL,
    ProgramData: e.env.ProgramData ?? e.env.PROGRAMDATA,
    ChocolateyInstall: e.env.ChocolateyInstall
  }
  if (e.platform !== 'win32' || !e.packaged) {
    return { platform: e.platform, packaged: e.packaged, execPath: e.execPath, env, hasUninstaller: false, canWriteBeside: null }
  }
  const execPath = await within(3000, realpath(e.execPath), e.execPath)
  const dir = dirname(execPath)
  const [hasUninstaller, writable] = await Promise.all([
    within(3000, exists(join(dir, UNINSTALLER_NAME)), false),
    within(3000, canWriteBeside(dir), null as boolean | null)
  ])
  return { platform: e.platform, packaged: e.packaged, execPath, env, hasUninstaller, canWriteBeside: writable }
}

export interface DownloadInput {
  url: string
  /** BASE64 sha512, as electron-builder writes it into latest.yml. */
  sha512: string
  size?: number
  dest: string
  fetchImpl: (url: string) => Promise<Response>
  onProgress?: (percent: number) => void
}

/**
 * Stream the file to `dest`, hashing as it goes; delete it and throw on any
 * mismatch. The hash is compared as base64, never hex: latest.yml's sha512 is
 * base64, and a hex comparison can never match (gotcha 71).
 */
export async function downloadVerified(i: DownloadInput): Promise<void> {
  const res = await i.fetchImpl(i.url)
  if (!res.ok || !res.body) throw new Error(`The download failed: HTTP ${res.status} for ${i.url}`)
  const total = Number(res.headers.get('content-length')) || i.size || 0
  const hash = createHash('sha512')
  const out = createWriteStream(i.dest)
  let done = 0
  let lastPct = -1
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      hash.update(value)
      done += value.byteLength
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      if (total > 0 && i.onProgress) {
        const pct = Math.min(99, Math.floor((done / total) * 100))
        if (pct !== lastPct) {
          lastPct = pct
          i.onProgress(pct)
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject)
      out.end(() => resolve())
    })
  } catch (err) {
    out.destroy()
    await remove(i.dest, { force: true })
    throw err
  }
  const got = hash.digest('base64')
  if (i.size !== undefined && done !== i.size) {
    await remove(i.dest, { force: true })
    throw new Error(`The download was ${done} bytes, not the ${i.size} the release lists, so it was thrown away.`)
  }
  if (got !== i.sha512) {
    await remove(i.dest, { force: true })
    throw new Error('The download does not match the checksum the release lists, so it was thrown away.')
  }
}

export interface ExtractTools {
  /** `%SystemRoot%\System32\tar.exe` — bsdtar, which reads zip. Never a bare `tar`: Git for Windows' GNU tar cannot. */
  tar: string | null
  /** `powershell.exe`, for the ZipFile fallback where there is no tar.exe (Windows 10 before 1803). */
  powershell: string | null
}

export function windowsTools(env: NodeJS.ProcessEnv): ExtractTools & { powershellExe: string } {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  const powershellExe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return { tar: join(root, 'System32', 'tar.exe'), powershell: powershellExe, powershellExe }
}

/** Describe an execFile failure honestly (gotcha 25: `killed` before any numeric `code`). */
function execFailure(err: unknown, what: string): Error {
  const e = err as { killed?: boolean; code?: unknown; stderr?: string; message?: string }
  if (e.killed) return new Error(`${what} took too long and was stopped.`)
  const detail = (e.stderr || e.message || '').trim().split('\n')[0]
  return new Error(`${what} failed${typeof e.code === 'number' ? ` (exit ${e.code})` : ''}: ${detail}`)
}

/**
 * Unpack `zip` into the empty folder `dest`. tar.exe first; PowerShell's
 * `ZipFile.ExtractToDirectory` where there is none, with both paths passed
 * through the environment rather than spliced into the command (the quoting
 * reason in portableSwap.ts). `Expand-Archive` is never used: in Windows
 * PowerShell 5.1 it is slow enough to look hung.
 */
export async function extractZip(zip: string, dest: string, tools: ExtractTools): Promise<void> {
  await mkdir(dest, { recursive: true })
  const opts = { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  if (tools.tar && (await exists(tools.tar))) {
    try {
      await execFileAsync(tools.tar, ['-xf', zip, '-C', dest], opts)
      return
    } catch (err) {
      if (!tools.powershell) throw execFailure(err, 'Unpacking the update')
      // Fall through to the second route, from an empty folder again.
      await remove(dest, { recursive: true, force: true })
      await mkdir(dest, { recursive: true })
    }
  }
  if (!tools.powershell) throw new Error('There is no tar.exe or PowerShell on this machine to unpack the update with.')
  try {
    await execFileAsync(
      tools.powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:STOKE_ZIP, $env:STOKE_DEST)'
      ],
      { ...opts, env: { ...process.env, STOKE_ZIP: zip, STOKE_DEST: dest } }
    )
  } catch (err) {
    throw execFailure(err, 'Unpacking the update')
  }
}

/**
 * What is wrong with an unpacked copy, or null. The version is read from
 * INSIDE app.asar, which works because Electron's fs reads into asar archives;
 * `readVersion` is injected so a suite can stand in for it.
 */
export async function stagedProblem(
  dir: string,
  exeName: string,
  expectVersion: string,
  readVersion: (dir: string) => Promise<string | null>
): Promise<string | null> {
  for (const rel of [exeName, join('resources', 'app.asar'), join('resources', 'app-update.yml')]) {
    if (!(await exists(join(dir, rel)))) {
      return rel.endsWith('app-update.yml')
        ? 'The downloaded copy has no resources\\app-update.yml, so it could never update itself again. It was not installed.'
        : `The downloaded copy has no ${rel}, so it is not a complete Stoke. It was not installed.`
    }
  }
  const v = await readVersion(dir).catch(() => null)
  if (v === null) return 'Could not read the version inside the downloaded copy, so it was not installed.'
  if (v !== expectVersion) return `The downloaded copy says it is ${v}, not the ${expectVersion} that was offered, so it was not installed.`
  return null
}

/** The version in an unpacked copy's app.asar — Electron reads into asar archives with plain fs. */
export async function asarVersion(dir: string): Promise<string | null> {
  const raw = await readFile(join(dir, 'resources', 'app.asar', 'package.json'), 'utf8')
  const v = (JSON.parse(raw) as { version?: unknown }).version
  return typeof v === 'string' ? v : null
}

export interface StageInput {
  url: string
  sha512: string
  size?: number
  staged: string
  version: string
  exeName: string
  fetchImpl: (url: string) => Promise<Response>
  tools: ExtractTools
  readVersion: (dir: string) => Promise<string | null>
  onProgress?: (percent: number) => void
}

/**
 * Download, verify, unpack and check, leaving a complete new copy at
 * `staged` — or nothing at all. The zip itself is downloaded beside the
 * staged folder (same volume as the app, which the swap needs anyway) and
 * deleted once unpacked.
 */
export async function stagePortable(s: StageInput): Promise<void> {
  const zip = `${s.staged}.zip`
  await remove(s.staged, { recursive: true, force: true })
  await remove(zip, { force: true })
  try {
    await downloadVerified({ url: s.url, sha512: s.sha512, size: s.size, dest: zip, fetchImpl: s.fetchImpl, onProgress: s.onProgress })
    await extractZip(zip, s.staged, s.tools)
    const problem = await stagedProblem(s.staged, s.exeName, s.version, s.readVersion)
    if (problem) throw new Error(problem)
  } catch (err) {
    await remove(s.staged, { recursive: true, force: true })
    throw err
  } finally {
    await remove(zip, { force: true })
  }
}

/**
 * Write the constant helper and this swap's plan into `dir` (userData),
 * returning both paths, and clear any stale result so the next launch cannot
 * read an old outcome as this one's.
 *
 * SYNCHRONOUS, the one deliberate exception to gotcha 40 in this file: it runs
 * from Stoke's quit handler, where an await lets the process exit before the
 * write lands and the helper would start with no plan. Two small files, in
 * userData on the system disk, once per update.
 */
export function writeSwapFilesSync(dir: string, plan: SwapPlan): { scriptPath: string; planPath: string } {
  mkdirSync(dir, { recursive: true })
  const scriptPath = join(dir, 'swap.ps1')
  const planPath = join(dir, 'plan.json')
  // ASCII script, no BOM; UTF-8 plan, no BOM (Get-Content -Encoding UTF8 reads
  // it either way; JSON.parse on our side would not).
  writeFileSync(scriptPath, SWAP_SCRIPT, 'ascii')
  writeFileSync(planPath, planJson(plan), 'utf8')
  rmSync(plan.resultFile, { force: true })
  return { scriptPath, planPath }
}

/**
 * Start the helper, detached so it outlives this process — the same shape
 * electron-updater uses to run the NSIS installer from its quit handler. Its
 * cwd is the plan's folder, never the app folder, which it is about to rename.
 */
export function launchSwap(powershell: string, scriptPath: string, planPath: string): void {
  const child = spawn(powershell, swapArgs(scriptPath, planPath), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(planPath)
  })
  child.on('error', () => {
    // Nothing to report to: this runs as Stoke quits. The next launch sees the
    // staged folder with no result written and says so (readSwapResult).
  })
  child.unref()
}

export interface SwapResult {
  ok: boolean
  step: string
  message: string
  from: string
  to: string
  dir: string
  at: number
}

/** The last swap's outcome, read once and removed. Null when there is none (or it is unreadable). */
export async function readSwapResult(file: string): Promise<SwapResult | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  await remove(file, { force: true })
  try {
    const r = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<SwapResult>
    if (typeof r.ok !== 'boolean') return null
    return {
      ok: r.ok,
      step: String(r.step ?? ''),
      message: String(r.message ?? ''),
      from: String(r.from ?? ''),
      to: String(r.to ?? ''),
      dir: String(r.dir ?? ''),
      at: Number(r.at ?? 0)
    }
  } catch {
    return null
  }
}

/**
 * Remove leftovers beside the app folder — `<name>.old-<v>` from a finished
 * swap, `<name>.update-<v>` from one that never ran — except the paths in
 * `keep`. Only names `isLeftover` recognises are touched, so nothing of the
 * user's beside the folder can ever match. Best-effort: a folder still in use
 * is simply left for next time. Returns what was removed.
 */
export async function sweepLeftovers(appDir: string, kinds: readonly ('old' | 'update')[], keep: readonly string[] = []): Promise<string[]> {
  const parent = dirname(appDir)
  const name = basename(appDir)
  let entries: string[]
  try {
    entries = await readdir(parent)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    const kind = isLeftover(name, entry)
    if (!kind || !kinds.includes(kind)) continue
    const full = join(parent, entry)
    if (keep.some((k) => k.toLowerCase() === full.toLowerCase())) continue
    try {
      if (!(await stat(full)).isDirectory()) continue
      await remove(full, { recursive: true, force: true })
      removed.push(full)
    } catch {
      // In use, or already gone: next time.
    }
  }
  return removed
}
