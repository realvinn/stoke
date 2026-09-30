import { useEffect, useState } from 'react'
import { emptyRemoteView, type HubRemoteView } from '@shared/hub/remote'

/**
 * "Other machines" as main last pushed it (src/main/hub/remote.ts). One
 * writer: main. Reading it never starts the hub client — a Stoke with no hub
 * set up answers the empty view, and the first push arrives when one starts.
 */
export function useHubRemote(): HubRemoteView {
  const [view, setView] = useState<HubRemoteView>(emptyRemoteView())
  useEffect(() => {
    let live = true
    let pushed = false
    const off = window.stoke.hub.remote.onChange((v) => {
      pushed = true
      setView(v)
    })
    // A push that lands first is newer than this answer.
    void window.stoke.hub.remote.view().then((v) => {
      if (live && !pushed) setView(v)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return view
}

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export function platformName(p: string): string {
  return PLATFORM_NAMES[p] ?? p
}
