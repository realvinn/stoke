import { app, BrowserWindow, powerMonitor } from 'electron'
import { WATCHDOG_CONFIG, startDiagnostics, startWatchdog, type Diagnostics } from './diagnosticsLog.ts'

/**
 * Freeze telemetry, wired to Electron: `<userData>/diagnostics.log`, which
 * records a window going unresponsive and back (with how long), a renderer or
 * child process (GPU) dying, sleep and wake, the main event loop stalling past
 * half a second, and — from a watchdog thread — main held past two seconds
 * while it is still held, so a hang ended by Force Quit leaves a line too. The
 * rules, and why each is what it is, are in diagnosticsLog.ts, which
 * `verify:freeze` drives without Electron. No UI and no behaviour of its own:
 * it only listens and appends.
 */

let running: Diagnostics | null = null

/**
 * Any window shown: not hidden and not minimized. Not "on screen": a window
 * covered by another, or on another Space, still counts, so `visible=true` on
 * a line does not rule out App Nap throttling (diagnosticsLog.ts `Presence`).
 */
function anyVisible(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized())
}

/**
 * Once per process, from `whenReady`: after `ready` (powerMonitor needs it),
 * before the first window (so `browser-window-created` sees it) and before
 * anything that can block (so the sampler and the watchdog measure that too).
 */
export function installDiagnostics(): void {
  if (running) return
  try {
    running = startDiagnostics(app.getPath('userData'), {
      app,
      powerMonitor,
      focused: () => BrowserWindow.getFocusedWindow() !== null,
      visible: anyVisible,
      watchdog: (file, gone) => startWatchdog(file, WATCHDOG_CONFIG, gone),
      about: {
        version: app.getVersion(),
        electron: process.versions.electron ?? '',
        os: `${process.platform}-${process.getSystemVersion()}`,
        arch: process.arch,
        packaged: app.isPackaged
      }
    })
  } catch {
    /* telemetry never stops a boot */
  }
}
