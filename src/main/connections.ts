import { app, clipboard, powerMonitor, shell } from 'electron'
import { ConnectionLog } from './hub/connectionLog.ts'
import { getSettings, onSettingsChanged } from './store.ts'
import type { TraceFields } from '../shared/hub/connectionTrace.ts'
import type { HubResult } from '../shared/hub/client.ts'

/**
 * "Keep a connection log", wired to Electron: the one `ConnectionLog` in main
 * (hub/connectionLog.ts, which `verify:connection-log` drives without
 * Electron), its sleep/wake/lock lines from `powerMonitor`, the setting
 * watched for its first line, and the Settings row's Show and Copy. The hub
 * service hands `connectionTrace` to "Other machines" and presence.
 */

let log: ConnectionLog | null = null

function connectionLog(): ConnectionLog {
  log ??= new ConnectionLog({
    dir: app.getPath('userData'),
    enabled: () => getSettings().hub.connectionLog === true,
    about: () => ({ version: app.getVersion(), os: process.platform, arch: process.arch, hubUrl: getSettings().hub.url })
  })
  return log
}

/** The trace hook (`HubServiceDeps.trace`): writes only while the setting is on. */
export function connectionTrace(event: string, fields?: TraceFields): void {
  connectionLog().trace(event, fields)
}

/** Once, from `whenReady` (powerMonitor needs `ready`): a `log-start` now if it is on, and whenever it is turned on. */
export function installConnectionLog(): void {
  try {
    const l = connectionLog()
    l.watchPower(powerMonitor)
    l.settingChanged()
    onSettingsChanged(() => l.settingChanged())
  } catch {
    /* the log never stops a boot */
  }
}

export function connectionLogState(): Promise<{ exists: boolean; bytes: number }> {
  return connectionLog().state()
}

export async function showConnectionLog(): Promise<HubResult> {
  const file = await connectionLog().newest()
  if (!file) return { ok: false, message: 'There is no connection log on this computer yet.' }
  shell.showItemInFolder(file)
  return { ok: true }
}

export async function copyConnectionLog(): Promise<HubResult<{ bytes: number }>> {
  const text = await connectionLog().text()
  if (!text) return { ok: false, message: 'There is no connection log on this computer yet.' }
  clipboard.writeText(text)
  return { ok: true, bytes: Buffer.byteLength(text) }
}

/**
 * On wake from sleep, check every open remote tab now (`HubService.wake` →
 * `HubRemote.wake`): a link that died asleep reconnects in about ten seconds
 * instead of looking frozen until the next keepalive. Whatever the log says.
 */
export function installHubWake(wake: () => void): void {
  try {
    powerMonitor.on('resume', () => {
      try {
        wake()
      } catch {
        /* a wake check never throws into Electron */
      }
    })
  } catch {
    /* no powerMonitor: nothing to wake on */
  }
}
