import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { getSettings } from './store.ts'

const execFileAsync = promisify(execFile)

/**
 * Stoke updating itself.
 *
 * electron-updater reads the `publish` block in electron-builder.yml, so a
 * release published to GitHub is enough to make installed copies notice. The
 * download is deliberately not automatic: pulling ~100MB in the background
 * without asking is rude, and a session may be mid-turn.
 *
 * Nothing here runs in development — there is no installed app to replace, and
 * electron-updater throws rather than no-oping.
 */

const { autoUpdater } = electronUpdater

export interface SelfUpdateState {
  supported: boolean
  currentVersion: string
  availableVersion: string | null
  downloaded: boolean
  downloading: boolean
  progress: number
  error: string | null
  checkedAt: number | null
  blocked: string | null
}

const state: SelfUpdateState = {
  supported: false,
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloaded: false,
  downloading: false,
  progress: 0,
  error: null,
  checkedAt: null,
  blocked: null
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
 * Only macOS has such a case today. Squirrel.Mac verifies the downloaded bundle
 * against the *running* bundle's designated requirement; for an ad-hoc signature
 * that requirement is `cdhash H"…"` — the hash of this exact binary — which no
 * other build can satisfy by construction. CI builds are ad-hoc because
 * `CSC_IDENTITY_AUTO_DISCOVERY: false` is set with no Developer ID available, so
 * this is the shipped state, not a corner case. Measured: `codesign -dv` prints
 * `Signature=adhoc` on **stderr** for such a binary, and an `Authority=` line
 * instead for anything signed with a real certificate — including a self-signed
 * one, whose requirement pins a certificate rather than a hash and so *can* be
 * satisfied by the next build.
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
    // `codesign -dv` writes its report to stderr, not stdout, and exits non-zero
    // when the target carries no signature at all — so the failure path carries
    // the answer just as often as the success path, and both are read.
    let report = ''
    try {
      report = (
        await execFileAsync('codesign', ['-dv', process.execPath], {
          timeout: 10_000,
          encoding: 'utf8'
        })
      ).stderr
    } catch (err) {
      report = (err as { stderr?: string }).stderr ?? ''
    }
    if (/Signature=adhoc/.test(report)) {
      return 'This build is ad-hoc signed, so macOS will refuse to swap it for a downloaded one. Updates have to be installed by hand from the .dmg.'
    }
    return null
  })()
  return blockerProbe
}

function push(): void {
  notify?.({ ...state })
}

function wire(): void {
  if (wired) return
  wired = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info) => {
    state.availableVersion = info.version
    state.error = null
    push()
  })
  autoUpdater.on('update-not-available', () => {
    state.availableVersion = null
    push()
  })
  autoUpdater.on('download-progress', (p) => {
    state.downloading = true
    state.progress = Math.round(p.percent)
    push()
  })
  autoUpdater.on('update-downloaded', () => {
    state.downloading = false
    state.downloaded = true
    state.progress = 100
    push()
  })
  autoUpdater.on('error', (err) => {
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
    state.blocked = why
    push()
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
  state.blocked = await detectBlocker()
  wire()
  /*
   * Read on every check rather than wired once.
   *
   * GitHub's "latest release" endpoint excludes prereleases by definition, so
   * with this false the app is told the newest stable version and correctly
   * reports nothing new — a beta is invisible rather than declined. Setting it
   * here means flipping the switch in Settings takes effect on the next press of
   * Check, with no restart.
   */
  autoUpdater.allowPrerelease = getSettings().betaUpdates
  try {
    await autoUpdater.checkForUpdates()
    state.error = null
  } catch (err) {
    // No published release yet is the common case; report it without alarm.
    state.error = friendlyError(err)
  }
  return selfUpdateState()
}

export async function downloadSelfUpdate(): Promise<SelfUpdateState> {
  if (!app.isPackaged || !state.availableVersion) return selfUpdateState()
  wire()
  state.downloading = true
  state.error = null
  push()
  try {
    await autoUpdater.downloadUpdate()
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

/** Quit and install now. Callers should warn that running sessions will end. */
export function installSelfUpdate(): void {
  if (!state.downloaded) return
  // isSilent = false so the installer's progress is visible; isForceRunAfter so
  // Stoke comes back up afterwards.
  autoUpdater.quitAndInstall(false, true)
}
