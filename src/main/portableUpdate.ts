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
import { createWriteStream, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { UNINSTALLER_NAME, isStokeBuildPath, winPathKey, type InstallFacts } from '../shared/installKind.ts'
import { SWAP_SCRIPT, isLeftover, planJson, stagedMarkerJson, swapArgs, type SwapPlan } from './portableSwap.ts'

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

/**
 * Delete a folder tree through the injected remover — for selfUpdate.ts, whose
 * own `rm` is Electron's patched one and fails part-way through an unpacked
 * copy's app.asar (gotcha 98), leaving half a folder behind (found by review).
 */
export function removeTree(path: string): Promise<void> {
  return remove(path, { recursive: true, force: true })
}

/** The two build folders a person can drop a file into, and so the two listed one level down. */
const INNER_FOLDERS = ['resources', 'locales']

/**
 * A folder's names as `InstallFacts.entries` wants them: the top level, and one
 * level down in `resources` and `locales` as `resources\<name>` (always a
 * backslash — these are identifiers compared as Windows compares names, never
 * paths handed to fs). Throws when any of it cannot be read; every caller turns
 * that into "unknown", and unknown never swaps or deletes.
 */
export async function listBuild(dir: string): Promise<string[]> {
  const top = await readdir(dir)
  const out = [...top]
  for (const name of top) {
    if (!INNER_FOLDERS.includes(name.toLowerCase())) continue
    for (const inner of await readdir(join(dir, name))) out.push(`${name}\\${inner}`)
  }
  return out
}

/** The same listing, synchronously — for the quit path, where an await could lose the race. */
export function listBuildSync(dir: string): string[] {
  const top = readdirSync(dir)
  const out = [...top]
  for (const name of top) {
    if (!INNER_FOLDERS.includes(name.toLowerCase())) continue
    for (const inner of readdirSync(join(dir, name))) out.push(`${name}\\${inner}`)
  }
  return out
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
 * Whether a folder can be made beside `dir`, and if not, why. `fs.access(W_OK)`
 * cannot answer this on Windows — it "does not check the ACL" (Node's own docs)
 * — so a real folder is made and removed, in the PARENT, which is where the
 * portable swap needs rights: the new copy is unpacked there and both renames
 * happen there. The errno is kept so the panel can name the reason instead of
 * guessing one (a read-only stick is not fixed by administrator rights).
 */
export async function probeWriteBeside(dir: string): Promise<{ ok: boolean; code: string | null }> {
  try {
    const probe = await mkdtemp(join(dirname(dir), '.stoke-write-probe-'))
    await rmdir(probe)
    return { ok: true, code: null }
  } catch (err) {
    return { ok: false, code: String((err as { code?: unknown }).code ?? 'unknown') }
  }
}

export interface ProbeEnv {
  platform: string
  packaged: boolean
  execPath: string
  env: NodeJS.ProcessEnv
  /** `realpath`, replaceable so a suite can make it hang or fail. */
  resolve?: (p: string) => Promise<string>
  /** Each probe's deadline; 3 s unless a suite shortens it. */
  deadlineMs?: number
}

/**
 * The facts `classifyInstall` decides on. On Windows the exe's folder is
 * resolved through `realpath` first: a copy reached through a junction or a
 * winget `Links` symlink must be judged, and later swapped, where it really is.
 *
 * Every probe runs under a deadline (gotcha 40), and a deadline answers NULL —
 * "could not tell" — never a guess. The first version answered `false` for a
 * slow uninstaller check, and "no uninstaller" is exactly the fact that routes
 * an INSTALLED copy into the portable swap, which would then delete its
 * uninstaller (found by review: six queued thread-pool jobs were enough).
 */
export async function gatherInstallFacts(e: ProbeEnv): Promise<InstallFacts> {
  const env = {
    PORTABLE_EXECUTABLE_FILE: e.env.PORTABLE_EXECUTABLE_FILE,
    LOCALAPPDATA: e.env.LOCALAPPDATA,
    USERPROFILE: e.env.USERPROFILE,
    SCOOP: e.env.SCOOP,
    SCOOP_GLOBAL: e.env.SCOOP_GLOBAL,
    ProgramData: e.env.ProgramData ?? e.env.PROGRAMDATA,
    ChocolateyInstall: e.env.ChocolateyInstall,
    TEMP: e.env.TEMP,
    TMP: e.env.TMP
  }
  if (e.platform !== 'win32' || !e.packaged) {
    return { platform: e.platform, packaged: e.packaged, execPath: e.execPath, env, hasUninstaller: null, canWriteBeside: null, entries: null }
  }
  const ms = e.deadlineMs ?? 3000
  /*
   * A realpath that times out answers null like every other probe: falling back
   * to the unresolved path was a guess, and a junctioned portable folder would
   * then settle on the junction's path and the swap would rename the junction
   * (found by review). Every other probe is skipped too — they would be judged
   * at a place that is not where Stoke is — so the classifier's "could not tell
   * yet" answer is the one given. A realpath that FAILS is an answer, though:
   * this path cannot be resolved (some virtual and RAM drives refuse the call
   * `fs.realpath` makes), so the path as started is the only one there is.
   */
  const resolved = await within(ms, (e.resolve ?? realpath)(e.execPath).catch(() => e.execPath), null as string | null)
  if (resolved === null) {
    return { platform: e.platform, packaged: e.packaged, execPath: e.execPath, execPathRaw: e.execPath, env, hasUninstaller: null, canWriteBeside: null, writeError: null, entries: null }
  }
  const execPath = resolved
  const dir = dirname(execPath)
  const [hasUninstaller, write, entries] = await Promise.all([
    within(ms, exists(join(dir, UNINSTALLER_NAME)), null as boolean | null),
    within(ms, probeWriteBeside(dir), null as { ok: boolean; code: string | null } | null),
    within(ms, listBuild(dir), null as string[] | null)
  ])
  return {
    platform: e.platform,
    packaged: e.packaged,
    execPath,
    execPathRaw: e.execPath,
    env,
    hasUninstaller,
    canWriteBeside: write ? write.ok : null,
    writeError: write ? write.code : null,
    entries
  }
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
 *
 * Through `stream.pipeline`, so a failure on EITHER side — the network, or the
 * disk filling up mid-write — rejects here and reaches the cleanup. A
 * hand-written read/write loop had no 'error' listener on the file while it
 * ran, so ENOSPC was an uncaught exception in the main process and the
 * download never settled (found by review; reproduced with `ulimit -f`).
 */
export async function downloadVerified(i: DownloadInput): Promise<void> {
  const res = await i.fetchImpl(i.url)
  if (!res.ok || !res.body) throw new Error(`The download failed: HTTP ${res.status} for ${i.url}`)
  const total = Number(res.headers.get('content-length')) || i.size || 0
  const hash = createHash('sha512')
  let done = 0
  let lastPct = -1
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      done += chunk.length
      if (total > 0 && i.onProgress) {
        const pct = Math.min(99, Math.floor((done / total) * 100))
        if (pct !== lastPct) {
          lastPct = pct
          i.onProgress(pct)
        }
      }
      cb(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(i.dest))
  } catch (err) {
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
  /**
   * Where the zip itself is downloaded to — userData, not beside the app. Only
   * the unpacked folder has to be on the app's volume (the swap is a rename); a
   * zip left by a quit mid-download beside the app would otherwise sit on
   * somebody's Desktop for good (found by review).
   */
  zip: string
  /**
   * The helper's proof that `staged` is finished and checked (`SwapPlan.stagedMarker`),
   * in userData beside the zip — never inside the copy, which becomes the app
   * folder and must hold nothing but Stoke.
   */
  marker: string
  version: string
  exeName: string
  fetchImpl: (url: string) => Promise<Response>
  tools: ExtractTools
  readVersion: (dir: string) => Promise<string | null>
  onProgress?: (percent: number) => void
}

/**
 * Download, verify, unpack and check, leaving a complete new copy at
 * `staged` and its marker — or nothing at all. The zip is deleted once
 * unpacked. The marker goes FIRST, before the folder is touched, and comes back
 * only after every check has passed: a helper that starts in between finds no
 * marker and changes nothing.
 */
export async function stagePortable(s: StageInput): Promise<void> {
  const zip = s.zip
  await mkdir(dirname(zip), { recursive: true })
  await remove(s.marker, { force: true })
  await remove(s.staged, { recursive: true, force: true })
  await remove(zip, { force: true })
  try {
    await downloadVerified({ url: s.url, sha512: s.sha512, size: s.size, dest: zip, fetchImpl: s.fetchImpl, onProgress: s.onProgress })
    await extractZip(zip, s.staged, s.tools)
    const problem = await stagedProblem(s.staged, s.exeName, s.version, s.readVersion)
    if (problem) throw new Error(problem)
    await writeFile(s.marker, stagedMarkerJson(s.staged, s.version), 'utf8')
  } catch (err) {
    await remove(s.marker, { force: true })
    await remove(s.staged, { recursive: true, force: true })
    throw err
  } finally {
    await remove(zip, { force: true })
  }
}

/** The staged-copy marker, written synchronously — for the Windows workflow, which stages a copy by hand. */
export function writeStagedMarkerSync(marker: string, staged: string, version: string): void {
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, stagedMarkerJson(staged, version), 'utf8')
}

/** A build-listing name as Windows compares it. */
function nameKey(n: string): string {
  return n.replace(/\//g, '\\').toLowerCase()
}

/**
 * What the swap would carry away that is not Stoke's: names in the app folder's
 * build listing (`listBuild`) that the new copy does not have AND that are not
 * part of a Stoke build (`isStokeBuildPath`). The swap renames the WHOLE folder,
 * so anything listed here would leave with the old copy — and the old copy is
 * deleted a minute into the next launch. Checked after staging and again right
 * before the helper starts; a non-empty answer refuses the swap.
 *
 * Stoke's own names that the new build no longer ships (an Electron upgrade
 * dropping a DLL) are NOT listed: they are the old version's files and leave
 * with it. Listing them refused the swap, while the classifier — which judges
 * by the same shapes — kept calling the folder portable, so every launch
 * downloaded ~100 MB and refused again (found by review). Every name listed
 * here is one the classifier also calls foreign, so a refusal is always the
 * classifier's answer at the next launch too.
 */
export function entriesNotIn(appDirEntries: readonly string[], stagedEntries: readonly string[]): string[] {
  const next = new Set(stagedEntries.map(nameKey))
  return appDirEntries.filter((n) => !next.has(nameKey(n)) && !isStokeBuildPath(n))
}

/** The same check, read from disk synchronously — for the quit path, where an await could lose the race. */
export function swapWouldCarryAway(appDir: string, staged: string): string[] {
  try {
    return entriesNotIn(listBuildSync(appDir), listBuildSync(staged))
  } catch (err) {
    // Unreadable means unknown, and unknown refuses.
    return [`(could not list the folder: ${(err as Error).message})`]
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
  rmSync(plan.resultFile, { force: true })
  rmSync(plan.startedFile, { force: true })
  writeFileSync(planPath, planJson(plan), 'utf8')
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
      // Only a folder that is visibly a Stoke build is ever deleted — down into
      // its resources and locales too, where a file of the user's passed a
      // top-level look. The swap refuses a shared folder, but this is the one
      // irreversible step, so it checks for itself: a leftover-shaped name
      // holding anything else is left alone, whatever put it there.
      const inside = await listBuild(full)
      if (!inside.every(isStokeBuildPath)) continue
      await remove(full, { recursive: true, force: true })
      removed.push(full)
    } catch {
      // In use, or already gone: next time.
    }
  }
  return removed
}

/**
 * The helper's "I am running" marker: its own pid, written before it waits.
 * With it the next launch can tell "PowerShell never ran the helper" (no
 * marker) from "the helper is STILL waiting" (marker, pid alive) — the second
 * happens whenever somebody quits and reopens Stoke within the wait, and it
 * used to be reported as a Group Policy block while the helper's staged copy
 * was swept out from under it (found by review).
 */
export interface StartedMarker {
  pid: number
  alive: boolean
  /**
   * False when the file is there but holds no pid \u2014 which is also what a read
   * lands on while the helper's WriteAllText is still writing it.
   */
  readable: boolean
}

export async function readStarted(file: string): Promise<StartedMarker | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const pid = Number((JSON.parse(raw.replace(/^\uFEFF/, '')) as { pid?: unknown }).pid)
    if (!Number.isInteger(pid) || pid <= 0) return { pid: 0, alive: false, readable: false }
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch (err) {
      // EPERM means it exists and is someone else's to signal: alive.
      alive = (err as { code?: string }).code === 'EPERM'
    }
    return { pid, alive, readable: true }
  } catch {
    return { pid: 0, alive: false, readable: false }
  }
}

/**
 * When the last swap's plan was written (its `createdAt`, else the file's
 * mtime), or null when there is no plan \u2014 meaning no helper was started.
 */
export async function readPlanAt(file: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const at = Number((JSON.parse(raw.replace(/^\uFEFF/, '')) as { createdAt?: unknown }).createdAt)
    if (Number.isFinite(at) && at > 0) return at
  } catch {
    // A plan cut short by the quit: its mtime is when it was written.
  }
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

/**
 * How long a started helper may take to write its started marker before its
 * silence means PowerShell never ran it. A cold Windows PowerShell 5.1 behind a
 * busy disk and Defender's first scan of a new script is seconds, not tens.
 */
export const HELPER_START_ALLOWANCE_MS = 30_000

/**
 * What the last quit's helper is doing, from the files it and Stoke leave:
 *
 *   idle       no helper was started.
 *   finished   it wrote a result.
 *   pending    it is still waiting (its pid is alive), or may still be starting
 *              (no readable started marker yet, and the plan is younger than
 *              the allowance) \u2014 its plan and staged copy must be left alone.
 *   never-ran  a plan, no result, no started marker, well past the allowance:
 *              PowerShell never ran a line (an AllSigned Group Policy).
 *   stopped    it started and went away without a result.
 *
 * "Never ran" used to be decided on the started marker alone, so a Stoke opened
 * again before a slow helper wrote it was told PowerShell never ran it, and its
 * staged copy was swept out from under the helper (found by review).
 */
export type HelperVerdict = 'idle' | 'finished' | 'pending' | 'never-ran' | 'stopped'

export function helperVerdict(i: { planAt: number | null; now: number; hasResult: boolean; started: StartedMarker | null }): HelperVerdict {
  if (i.hasResult) return 'finished'
  if (i.planAt === null) return 'idle'
  if (i.started?.alive) return 'pending'
  const young = Math.abs(i.now - i.planAt) < HELPER_START_ALLOWANCE_MS
  if ((!i.started || !i.started.readable) && young) return 'pending'
  return i.started ? 'stopped' : 'never-ran'
}

/**
 * A swap refused because the folder holds something that is not Stoke's,
 * remembered in userData so the next pass does not download ~100 MB only to
 * refuse again. It stands only while one of the names it gave is still there:
 * moving the stranger out lifts it at once, with nothing to clear by hand.
 */
export interface Refusal {
  dir: string
  version: string
  entries: string[]
  message: string
}

export function writeRefusalSync(file: string, r: Refusal): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(r), 'utf8')
}

export async function readRefusal(file: string): Promise<Refusal | null> {
  try {
    const r = JSON.parse(await readFile(file, 'utf8')) as Partial<Refusal>
    if (typeof r.dir !== 'string' || typeof r.version !== 'string' || typeof r.message !== 'string' || !Array.isArray(r.entries)) return null
    return { dir: r.dir, version: r.version, entries: r.entries.map(String), message: r.message }
  } catch {
    return null
  }
}

/** Whether a remembered refusal still applies to this folder and version. A folder that cannot be listed keeps it standing. */
export async function refusalStands(r: Refusal, appDir: string, version: string): Promise<boolean> {
  if (winPathKey(r.dir) !== winPathKey(appDir) || r.version !== version) return false
  let now: string[]
  try {
    now = await listBuild(appDir)
  } catch {
    return true
  }
  const here = new Set(now.map(nameKey))
  return r.entries.some((e) => here.has(nameKey(e)))
}
