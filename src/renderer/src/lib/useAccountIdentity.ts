import { useEffect, useRef, useState } from 'react'
import { accountIdentityKey, accountIdentityTarget, identityFor, unavailableAccountIdentity, type AccountIdentity, type AccountIdentityTarget } from '@shared/accountIdentity'

export const ACCOUNT_IDENTITY_CHANGED = 'stoke-account-identity-changed'

/** Public account ids only; native credentials never enter renderer events. */
export function accountIdentityChanged(target: AccountIdentityTarget): void {
  window.dispatchEvent(new CustomEvent(ACCOUNT_IDENTITY_CHANGED, { detail: target }))
}

/** Scope both the request and the displayed result to the exact account/PTY. */
export function useAccountIdentity(target: AccountIdentityTarget | null): { identity: AccountIdentity | null; refresh: () => void } {
  const [value, setValue] = useState<AccountIdentity | null>(null)
  const [revision, setRevision] = useState(0)
  const key = target ? accountIdentityKey(target) : null
  const targetRef = useRef(target)
  targetRef.current = target
  useEffect(() => {
    if (!key || !targetRef.current) return
    let live = true
    let generation = 0
    const pull = (refresh = false) => {
      const mine = ++generation
      const requested = targetRef.current
      if (!requested) return
      void window.stoke.accounts.identity(requested, refresh).then(result => {
        if (live && mine === generation && accountIdentityKey(requested) === key) setValue(result || unavailableAccountIdentity(requested))
      }).catch(() => {
        if (live && mine === generation) setValue(unavailableAccountIdentity(requested))
      })
    }
    pull(revision > 0)
    const focus = () => pull()
    const changed = (event: Event) => {
      const account = accountIdentityTarget((event as CustomEvent).detail)
      if (account && account.cli === targetRef.current?.cli && account.accountId === targetRef.current?.accountId) pull(true)
    }
    window.addEventListener('focus', focus)
    window.addEventListener(ACCOUNT_IDENTITY_CHANGED, changed)
    const timer = window.setInterval(focus, 30_000)
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener(ACCOUNT_IDENTITY_CHANGED, changed) }
  }, [key, revision])
  return { identity: target ? identityFor(target, value) : null, refresh: () => setRevision(v => v + 1) }
}
