import { app } from 'electron'
import electronUpdater from 'electron-updater'

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
}

const state: SelfUpdateState = {
  supported: false,
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloaded: false,
  downloading: false,
  progress: 0,
  error: null,
  checkedAt: null
}

let wired = false
let notify: ((s: SelfUpdateState) => void) | null = null

/**
 * electron-updater reports a missing feed as a 404 with the full HTTP response
 * attached, which is several hundred characters of headers. The overwhelmingly
 * common cause is simply that no release has been published yet, so say that.
 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('404')) {
    return 'No published releases found yet. Push the repo to GitHub and publish a release.'
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT/.test(raw)) return 'Could not reach GitHub.'
  return raw.split('\n')[0].slice(0, 200)
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
  wire()
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
    state.error = err instanceof Error ? err.message : String(err)
  }
  return selfUpdateState()
}

/** Quit and install now. Callers should warn that running sessions will end. */
export function installSelfUpdate(): void {
  if (!state.downloaded) return
  // isSilent = false so the installer's progress is visible; isForceRunAfter so
  // Stoke comes back up afterwards.
  autoUpdater.quitAndInstall(false, true)
}
