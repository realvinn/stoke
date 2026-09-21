import { execFile } from 'node:child_process'
import { access, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app, net } from 'electron'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { signatureBlocker } from './codesign.ts'
import { getSettings } from './store.ts'
import { shouldAutoDownload } from '../shared/updateCheck.ts'
import type { SelfUpdateState } from '../shared/api.ts'
import { RELEASES_URL, classifyInstall, portableAssetFor, usesInstallerRoute, type InstallKind } from '../shared/installKind.ts'
import { backupDirFor, stagedDirFor } from './portableSwap.ts'
import {
  asarVersion,
  entriesNotIn,
  gatherInstallFacts,
  launchSwap,
  readStarted,
  readSwapResult,
  stagePortable,
  sweepLeftovers,
  swapWouldCarryAway,
  useRemover,
  windowsTools,
  writeSwapFilesSync
} from './portableUpdate.ts'

const execFileAsync = promisify(execFile)

/**
 * Stoke updating itself.
 *
 * electron-updater reads the `publish` block in electron-builder.yml, so a
 * release published to GitHub is enough to make installed copies notice.
 *
 * The download is automatic when `Settings.selfUpdateAuto` is on (the default)
 * and this build could actually install what it fetched. It used to be
 * manual-only, on the reasoning that ~100MB unasked is rude and a session may be
 * mid-turn — but a download touches no session, and the cost of asking was
 * measured on this machine: 0.9.6 sat found-and-not-downloaded for six days.
 * The INSTALL is still never unasked: it happens on a quit
 * (`autoInstallOnAppQuit`) or a "Restart and install", and the latter checks
 * for running turns first (App.tsx `requestSelfRestart`).
 *
 * Nothing here runs in development — there is no installed app to replace, and
 * electron-updater throws rather than no-oping.
 */

/**
 * electron-updater, loaded the first time something actually updates.
 *
 * It was a static import, and electron-vite externalises dependencies rather
 * than bundling them, so it became a synchronous `require` at the top of the
 * built main bundle — 23-51ms of every single launch, measured inside a real
 * Electron main process, before `app.whenReady` fires. Nothing on the boot path
 * needs it: the first check is deliberately deferred to +8s (`index.ts`), and
 * `initSelfUpdate` only records state and starts the signature probe.
 *
 * `wire()` is the only caller that has to run before any listener fires, and it
 * is already called from `checkSelfUpdate`/`downloadSelfUpdate` rather than at
 * module scope, so nothing changes about ordering — only about when the cost is
 * paid. Node caches the module, so the second call is free.
 */
let cached: AppUpdater | null = null
function updater(): AppUpdater {
  // `require` rather than `await import`, so the call sites stay synchronous —
  // `wire()` and `installSelfUpdate()` are not async and should not become so
  // just to move an import.
  cached ??= (require('electron-updater') as { autoUpdater: AppUpdater }).autoUpdater
  return cached
}

export type { SelfUpdateState }

const state: SelfUpdateState = {
  supported: false,
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloaded: false,
  downloading: false,
  progress: 0,
  error: null,
  checkedAt: null,
  blocked: null,
  installKind: null
}

/*
 * The portable route (src/main/portableUpdate.ts): a copy of Stoke that the
 * Windows installer did not put down cannot be updated by electron-updater —
 * NsisUpdater would install a SECOND copy under %LOCALAPPDATA%\Programs and
 * leave this one stale forever (src/shared/installKind.ts has the whole story).
 * electron-updater still does the CHECKING for it — the feed, the version
 * comparison and betas are identical — and this file does the rest.
 */
/** The release electron-updater last reported, whose `files` name the portable zip. */
let lastInfo: UpdateInfo | null = null
/** A new copy unpacked beside this one and checked, waiting for the swap. */
let staged: { dir: string; version: string } | null = null
/** Claimed before the first await, so two presses cannot both start a download (gotcha 20). */
let portableBusy = false
/** Set once the helper has been started, so the quit handler never starts a second. */
let swapStarted = false
/** The folder this copy runs from, once the probe has resolved it. */
let appDirResolved: string | null = null
/**
 * Why the last swap did not happen, kept apart from `state.error` because a
 * successful check clears that — 8 s after launch, before anybody could read
 * it. Re-applied after every check until the next download, and while it
 * stands `shouldAutoDownload` refuses, so a swap that keeps failing (something
 * holding the folder) waits for a deliberate press instead of repeating on
 * every quit.
 */
let swapNote: string | null = null
const EXE_NAME = 'Stoke.exe'
/** The repository the `publish` block in electron-builder.yml names. */
const RELEASE_DOWNLOAD = 'https://github.com/realvinn/stoke/releases/download'

function portableDir(): string {
  return join(app.getPath('userData'), 'portable-update')
}
function swapResultFile(): string {
  return join(portableDir(), 'result.json')
}
function swapStartedFile(): string {
  return join(portableDir(), 'started.json')
}

/** Whether the last run started the helper: its plan is written only then. */
async function planWasWritten(): Promise<boolean> {
  try {
    await access(join(portableDir(), 'plan.json'))
    return true
  } catch {
    return false
  }
}

let wired = false
let notify: ((s: SelfUpdateState) => void) | null = null

/**
 * electron-updater reports a missing feed as a 404 with the full HTTP response
 * attached, which is several hundred characters of headers. The overwhelmingly
 * common cause is simply that no release has been published yet, so say that.
 */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  /*
   * macOS updates are a ZIP, always. Squirrel.Mac installs by swapping a bundle
   * out of an archive, so `MacUpdater` looks for a .zip in the feed and throws
   * before downloading a byte when there is none (MacUpdater.js:81-83 in
   * electron-updater 6.8.9, which rejects "pkg" and "dmg" by name). A release
   * built with only a dmg target therefore cannot update a Mac at all, however
   * healthy the rest of the pipeline looks — and until this branch existed, the
   * failure surfaced as several hundred characters of stringified JSON.
   */
  if (raw.includes('ZIP file not provided') || raw.includes('ERR_UPDATER_ZIP_FILE_NOT_FOUND')) {
    return 'This release has no macOS update archive, so it cannot be installed automatically. Download the .dmg from the releases page instead.'
  }
  // Squirrel.Mac checks the downloaded app against the running app's designated
  // requirement before swapping it in, so a mismatch lands here at the very end,
  // after the whole download has been paid for.
  if (/code signature|codesign|SQRL|Team ID|signature.*(mismatch|verif)/i.test(raw)) {
    return 'The downloaded update is signed by a different identity than this copy, so macOS refused it. Download the .dmg from the releases page instead.'
  }
  if (raw.includes('404')) {
    return 'No published releases found yet. Push the repo to GitHub and publish a release.'
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT/.test(raw)) return 'Could not reach GitHub.'
  return raw.split('\n')[0].slice(0, 200)
}

/**
 * Why this build could never install an update, decided before one is offered.
 *
 * Only macOS has such a case today. The rule itself lives in `codesign.ts`,
 * which imports no electron and so can be tested; all this does is get the
 * report to it. `codesign -dvv` writes that report to **stderr** and exits
 * non-zero for a binary carrying no signature at all, so the failure path
 * carries the answer as often as the success path and both are read.
 *
 * "Ad-hoc means blocked" was the whole rule until 0.5.3, and it let the more
 * common failure through. A *self-signed* build is not ad-hoc — at two levels of
 * verbosity `codesign` prints an `Authority=` line for it — so the probe returned null, the panel
 * offered the update, and Squirrel refused the swap only after the archive had
 * been downloaded in full. That is what a locally-built copy of Stoke is: the
 * one this was found on reported `Authority=MyTouchBar Local`, a certificate
 * from an unrelated project that happened to be the only code-signing identity
 * in the keychain. See CLAUDE.md gotcha 24.
 *
 * Returns null whenever the answer is not a confident yes, the probe included: a
 * check that cannot answer must not stand in the way of a path that might work.
 */
/*
 * The *promise* is memoised, not a "have we probed yet" boolean. Startup fires
 * this and the Settings panel awaits it, so the two overlap; a boolean set
 * before the await lets the second caller through with the answer not computed
 * yet, which is the same shape as gotcha 20 in CLAUDE.md. Holding the promise
 * makes the second caller wait for the first one's result instead.
 */
let blockerProbe: Promise<string | null> | null = null

function detectBlocker(): Promise<string | null> {
  blockerProbe ??= (async () => {
    if (process.platform !== 'darwin' || !app.isPackaged) return null
    // `codesign -dvv` writes its report to stderr, not stdout, and exits non-zero
    // when the target carries no signature at all — so the failure path carries
    // the answer just as often as the success path, and both are read.
    let report = ''
    try {
      report = (
        /*
         * `-dvv`, not `-dv`, and the second v is load-bearing.
         *
         * At one level of verbosity `codesign` prints `Signature=adhoc` but no
         * `Authority=` line at all — measured against this very binary, which
         * `-dv` describes without ever naming the certificate that signed it
         * and `-dvv` reports as `Authority=MyTouchBar Local`. So the old probe
         * could only ever have detected the ad-hoc case: not because that was
         * the intended rule, but because it was the only fact in the output.
         */
        await execFileAsync('codesign', ['-dvv', process.execPath], {
          timeout: 10_000,
          encoding: 'utf8'
        })
      ).stderr
    } catch (err) {
      report = (err as { stderr?: string }).stderr ?? ''
    }
    return signatureBlocker(report)
  })()
  return blockerProbe
}

/*
 * How this copy got here, probed once and memoised as a PROMISE for the same
 * reason `blockerProbe` is: startup fires it and the first check awaits it, and
 * the two overlap. A few async stats and one mkdtemp beside the app folder,
 * each under a deadline (gotcha 40), never on the boot path.
 */
let kindProbe: Promise<InstallKind> | null = null

function detectInstallKind(): Promise<InstallKind> {
  kindProbe ??= (async () => {
    const facts = await gatherInstallFacts({
      platform: process.platform,
      packaged: app.isPackaged,
      execPath: process.execPath,
      env: process.env
    })
    appDirResolved = dirname(facts.execPath)
    const kind = classifyInstall(facts)
    // An answer a probe could not settle (a deadline passed) is never kept:
    // the next caller asks again. The boot-time probe is the one that races the
    // rest of startup for the thread pool; the +8s check usually settles it.
    if (!kind.settled) kindProbe = null
    return kind
  })()
  return kindProbe
}

/** A portable copy that must not swap after all: say why, for this session, and stop offering the route. */
function refusePortable(note: string): void {
  const dir = state.installKind?.dir ?? appDirResolved
  state.installKind = { kind: 'manual', dir, manager: null, command: null, note, settled: true }
  state.blocked = note
  kindProbe = Promise.resolve(state.installKind)
}

/** What a kind that must not update itself says instead, as a `blocked` reason. */
function blockedByKind(kind: InstallKind): string | null {
  return kind.kind === 'managed' || kind.kind === 'manual' ? kind.note : null
}

function push(): void {
  notify?.({ ...state })
}

function wire(): void {
  if (wired) return
  wired = true

  updater().autoDownload = false
  updater().autoInstallOnAppQuit = true
  updater().logger = null

  updater().on('update-available', (info) => {
    // A newer release than the one already unpacked replaces it: the staged
    // copy is now the wrong version, and installing it would be a downgrade
    // from what the panel says is available.
    if (staged && staged.version !== info.version && !swapStarted) {
      staged = null
      state.downloaded = false
    }
    lastInfo = info
    state.availableVersion = info.version
    state.error = null
    push()
  })
  updater().on('update-not-available', () => {
    lastInfo = null
    state.availableVersion = null
    push()
  })
  updater().on('download-progress', (p) => {
    state.downloading = true
    state.progress = Math.round(p.percent)
    push()
  })
  updater().on('update-downloaded', () => {
    state.downloading = false
    state.downloaded = true
    state.progress = 100
    push()
  })
  updater().on('error', (err) => {
    state.downloading = false
    state.error = friendlyError(err)
    push()
  })
}

export function initSelfUpdate(onChange: (s: SelfUpdateState) => void): void {
  notify = onChange
  state.supported = app.isPackaged
  state.currentVersion = app.getVersion()
  // Probed once at startup rather than on demand: a running binary's signature
  // cannot change, and doing it here means the panel already knows the answer
  // the first time it is opened instead of after a round trip.
  void detectBlocker().then((why) => {
    state.blocked = why ?? state.blocked
    push()
  })
  if (!app.isPackaged) return
  // Every remove of an unpacked copy goes through the UNPATCHED fs: Electron's
  // own treats app.asar as a folder and a recursive rm would walk into it.
  useRemover((path, opts) => (require('original-fs') as typeof import('node:fs')).promises.rm(path, opts))
  void detectInstallKind().then(async (kind) => {
    state.installKind = kind
    state.blocked = state.blocked ?? blockedByKind(kind)
    push()
    if (kind.kind !== 'portable' || !appDirResolved) return
    const appDir = appDirResolved
    // What the last swap said. A failure is shown in Settings › Updates; a
    // success needs no words — the version line already says it.
    const result = await readSwapResult(swapResultFile())
    if (result && !result.ok) {
      swapNote = `The last update did not install: ${result.message}`
      state.error = swapNote
      push()
    }
    const launched = await planWasWritten()
    const started = await readStarted(swapStartedFile())
    if (launched && !result && started?.alive) {
      // The helper is STILL waiting — this Stoke was opened again inside its
      // wait. Leave its plan and its staged copy alone; it gives up on its own
      // (this Stoke is running out of the folder it wants to rename) and says
      // so in a result the next launch reads.
      return
    }
    if (launched) {
      await rm(join(portableDir(), 'plan.json'), { force: true })
      await rm(swapStartedFile(), { force: true })
    }
    // An unpacked copy nothing is waiting to install — a swap that never ran,
    // or a download from before a restart — is swept now; it would only be
    // downloaded again. So is any zip a quit left mid-download. The OLD copy
    // from a finished swap is kept a minute longer, until this new version has
    // shown it starts and stays up: a release that crashes on launch still
    // leaves the one that worked.
    await sweepLeftovers(appDir, ['update'])
    try {
      for (const f of await readdir(portableDir())) {
        if (f.toLowerCase().endsWith('.zip')) await rm(join(portableDir(), f), { force: true })
      }
    } catch {
      // No folder yet: nothing to sweep.
    }
    if (launched && !result && !started) {
      // A plan, no result and no started marker: the helper was handed to
      // PowerShell and never ran a line. `-ExecutionPolicy Bypass` sets the
      // Process scope only, and a Group Policy allowing signed scripts alone
      // overrides it — so for this session the route is blocked outright,
      // rather than offering a download the policy will refuse again.
      refusePortable(
        `The last update was handed to PowerShell to install, and PowerShell never ran it — a Group Policy that allows only signed scripts does exactly that. Updates for this copy have to be downloaded by hand from ${RELEASES_URL}.`
      )
      push()
    } else if (launched && !result && started && !started.alive) {
      swapNote = 'The last update was started but the helper stopped without saying how it went. It will be offered again.'
      state.error = swapNote
      push()
    }
    setTimeout(() => void sweepLeftovers(appDir, ['old']), 60_000).unref?.()
  })
}

export function selfUpdateState(): SelfUpdateState {
  return { ...state }
}

export async function checkSelfUpdate(): Promise<SelfUpdateState> {
  state.checkedAt = Date.now()
  if (!app.isPackaged) {
    state.supported = false
    state.error = null
    return selfUpdateState()
  }
  state.supported = true
  // Cheap after the first call, and it closes the window where the startup
  // probe has not landed yet but Settings is already open.
  const kind = await detectInstallKind()
  state.installKind = kind
  state.blocked = (await detectBlocker()) ?? blockedByKind(kind)
  wire()
  // electron-updater installs what IT downloaded when Stoke quits. Only the
  // installer's own folder may take that route: anywhere else it would install
  // a second copy under %LOCALAPPDATA%\Programs (src/shared/installKind.ts).
  // The portable route has its own quit handler (armSwapOnQuit).
  updater().autoInstallOnAppQuit = usesInstallerRoute(kind.kind)
  /*
   * Read on every check rather than wired once.
   *
   * GitHub's "latest release" endpoint excludes prereleases by definition, so
   * with this false the app is told the newest stable version and correctly
   * reports nothing new — a beta is invisible rather than declined. Setting it
   * here means flipping the switch in Settings takes effect on the next press of
   * Check, with no restart.
   */
  updater().allowPrerelease = getSettings().betaUpdates
  try {
    await updater().checkForUpdates()
    state.error = swapNote
  } catch (err) {
    // No published release yet is the common case; report it without alarm.
    state.error = friendlyError(err)
  }
  if (shouldAutoDownload(state, getSettings().selfUpdateAuto)) void downloadSelfUpdate()
  return selfUpdateState()
}


/**
 * The portable route's download: the release's `-<arch>-win.zip`, checked
 * against the sha512 and size its own latest.yml lists, unpacked beside this
 * folder and checked again (portableUpdate.ts `stagePortable`). Nothing is
 * installed here; `staged` is what a restart or a quit then swaps in.
 */
async function downloadPortable(): Promise<SelfUpdateState> {
  // Claimed before the first await (gotcha 20): a second press, or the
  // automatic download racing a manual one, must not start a second fetch into
  // the same folder.
  if (portableBusy || swapStarted) return selfUpdateState()
  portableBusy = true
  try {
    const version = state.availableVersion
    const appDir = appDirResolved
    if (!version || !appDir || !lastInfo || lastInfo.version !== version) return selfUpdateState()
    if (staged?.version === version) {
      state.downloaded = true
      return selfUpdateState()
    }
    const asset = portableAssetFor(lastInfo.files, process.arch)
    if (!asset) {
      state.error = `Stoke ${version} has no portable build for ${process.arch} Windows, so this copy cannot update itself to it. Download it from the releases page.`
      push()
      return selfUpdateState()
    }
    swapNote = null
    state.downloading = true
    state.progress = 0
    state.error = null
    push()
    const dir = stagedDirFor(appDir, version)
    await stagePortable({
      zip: join(portableDir(), `${asset.url.replace(/[\\/:*?"<>|]/g, '_')}`),
      // electron-builder's GitHub provider tags releases `v<version>` and
      // names files relative to that tag's downloads.
      url: `${RELEASE_DOWNLOAD}/v${version}/${encodeURIComponent(asset.url)}`,
      sha512: asset.sha512,
      size: asset.size,
      staged: dir,
      version,
      exeName: EXE_NAME,
      // Chromium's network stack, so a system proxy applies exactly as it does
      // to electron-updater's own downloads.
      fetchImpl: (u) => net.fetch(u),
      tools: windowsTools(process.env),
      readVersion: asarVersion,
      onProgress: (pct) => {
        state.progress = pct
        push()
      }
    })
    // A newer release announced while this one downloaded: installing it would
    // put the older one in place under a panel naming the newer (found by
    // review). Thrown away; the newer one is fetched on the next pass.
    if (state.availableVersion !== version) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      state.downloading = false
      return selfUpdateState()
    }
    // The last guard before a swap is armed: nothing may be in this folder that
    // the new copy lacks, because the swap carries the whole folder away.
    const carried = entriesNotIn(await readdir(appDir), await readdir(dir))
    if (carried.length) {
      await sweepLeftovers(appDir, ['update'])
      state.downloading = false
      refusePortable(
        `Stoke shares its folder, ${appDir}, with other things (${carried.slice(0, 3).join(', ')}${carried.length > 3 ? ', …' : ''}). Updating itself would mean replacing that whole folder, so it does not. Move Stoke into a folder of its own, or download updates by hand from ${RELEASES_URL}.`
      )
      return selfUpdateState()
    }
    staged = { dir, version }
    state.downloading = false
    state.downloaded = true
    state.progress = 100
    armSwapOnQuit()
  } catch (err) {
    state.downloading = false
    state.error = err instanceof Error ? err.message.split('\n')[0].slice(0, 300) : String(err)
  } finally {
    portableBusy = false
    push()
  }
  return selfUpdateState()
}

/**
 * Write the plan and start the helper. False when there is nothing staged, or
 * the helper could not be written — in which case nothing has changed and the
 * caller must not quit on its account.
 */
function startSwap(relaunch: boolean): boolean {
  if (swapStarted) return true
  if (!staged || !appDirResolved) return false
  // Checked again at the last moment, synchronously (this can run from a quit
  // handler): something put into the folder since the download is still
  // something the swap would carry away.
  const carried = swapWouldCarryAway(appDirResolved, staged.dir)
  if (carried.length) {
    refusePortable(
      `Stoke shares its folder, ${appDirResolved}, with other things (${carried.slice(0, 3).join(', ')}). Updating itself would mean replacing that whole folder, so it does not. Move Stoke into a folder of its own, or download updates by hand from ${RELEASES_URL}.`
    )
    state.downloaded = false
    push()
    return false
  }
  const tools = windowsTools(process.env)
  const plan = {
    pid: process.pid,
    appDir: appDirResolved,
    staged: staged.dir,
    backup: backupDirFor(appDirResolved, state.currentVersion),
    resultFile: swapResultFile(),
    startedFile: swapStartedFile(),
    from: state.currentVersion,
    to: staged.version,
    relaunch,
    exeName: EXE_NAME,
    waitSeconds: 120,
    renameTries: 40
  }
  swapStarted = true
  /*
   * The files are written synchronously on purpose, and only here: this runs
   * from a quit handler, where an await would let the process exit before the
   * write lands. Two small files in userData, once per update.
   */
  try {
    writeSwapFilesSync(portableDir(), plan)
    launchSwap(tools.powershellExe, join(portableDir(), 'swap.ps1'), join(portableDir(), 'plan.json'))
    return true
  } catch (err) {
    swapStarted = false
    state.error = `Could not start the update: ${err instanceof Error ? err.message : String(err)}`
    push()
    return false
  }
}

let quitArmed = false
/**
 * Install on quit, as `autoInstallOnAppQuit` does for the installer: once a
 * copy is staged, a normal quit starts the helper with no relaunch. `will-quit`
 * runs after `before-quit` has ended every session (index.ts), and is skipped
 * when "Restart and install" already started the helper.
 */
function armSwapOnQuit(): void {
  if (quitArmed) return
  quitArmed = true
  app.once('will-quit', () => {
    if (!swapStarted) startSwap(false)
  })
}

export async function downloadSelfUpdate(): Promise<SelfUpdateState> {
  if (!app.isPackaged || !state.availableVersion) return selfUpdateState()
  if (state.installKind?.kind === 'portable') return downloadPortable()
  // Never through the NSIS route for a copy that must not take it: a Download
  // press on a managed or read-only copy is refused here, not only greyed out.
  if (state.installKind && !usesInstallerRoute(state.installKind.kind)) return selfUpdateState()
  wire()
  state.downloading = true
  state.error = null
  push()
  try {
    await updater().downloadUpdate()
  } catch (err) {
    state.downloading = false
    // Through friendlyError like every other failure. Raw, this is where the
    // macOS "ZIP file not provided" case arrived as a stringified array of file
    // descriptors — the one message that most needed translating was the only
    // one not getting it.
    state.error = friendlyError(err)
  }
  // A failure inside downloadUpdate() resolves rather than throws in some
  // electron-updater paths (the 'error' event fires instead), so push the state
  // either way: the caller's returned copy is not the only reader.
  push()
  return selfUpdateState()
}

/**
 * Quit and install now. Callers should warn that running sessions will end —
 * the renderer's `requestSelfRestart` asks first when a turn is running.
 *
 * True when the install was started. False when there was nothing downloaded
 * to install, or electron-updater threw before quitting; the caller uses that
 * to take back the update-restart marker it wrote in anticipation.
 */
export function installSelfUpdate(): boolean {
  if (!state.downloaded) return false
  if (state.installKind?.kind === 'portable') {
    if (!startSwap(true)) return false
    // The helper waits for this process — and everything else running out of
    // the folder — to be gone before it touches anything. quitAndInstall does
    // the same dance for the NSIS route: start the installer, then quit.
    setImmediate(() => app.quit())
    return true
  }
  try {
    // isSilent = false so the installer's progress is visible; isForceRunAfter
    // so Stoke comes back up afterwards.
    updater().quitAndInstall(false, true)
    return true
  } catch (err) {
    state.error = friendlyError(err)
    push()
    return false
  }
}
