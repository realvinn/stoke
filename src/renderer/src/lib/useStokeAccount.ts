import { useEffect, useState } from 'react'
import type { HubView } from '@shared/hub/client'

/** Read the local Stoke sign-in; remembered email alone is not an active login. */
export function useStokeAccount(): HubView | null {
  const [view, setView] = useState<HubView | null>(null)
  useEffect(() => {
    let live = true
    let changed = false
    const off = window.stoke.hub.onChange(next => { changed = true; if (live) setView(next) })
    void window.stoke.hub.view().then(next => { if (live && !changed) setView(next) }).catch(() => {})
    return () => { live = false; off() }
  }, [])
  return view
}

export function stokeAccountSummary(view: HubView | null): { signedIn: boolean; identity: string; status: string } {
  const signedIn = !!view && ['new-account', 'locked', 'active'].includes(view.phase)
  return {
    signedIn,
    identity: signedIn ? view?.email || 'Signed in' : view?.phase === 'revoked' ? 'Device removed' : view ? 'Not signed in' : 'Checking sign-in…',
    status: view?.phase === 'active' ? 'Account & sync' : view?.phase === 'locked' ? 'Unlock sync on this device' : view?.phase === 'new-account' ? 'Finish sync setup' : 'Sign in to Stoke'
  }
}
