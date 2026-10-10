import { useEffect, useRef, useState } from 'react'
import { accountIdentityKey, identityFor, unavailableAccountIdentity, type AccountIdentity, type AccountIdentityTarget } from '@shared/accountIdentity'

/** Scope both the request and the displayed result to the exact account/PTY. */
export function useAccountIdentity(target: AccountIdentityTarget): { identity: AccountIdentity | null; refresh: () => void } {
  const [value, setValue] = useState<AccountIdentity | null>(null)
  const [revision, setRevision] = useState(0)
  const key = accountIdentityKey(target)
  const targetRef = useRef(target)
  targetRef.current = target
  useEffect(() => {
    let live = true
    let generation = 0
    const pull = (refresh = false) => {
      const mine = ++generation
      const requested = targetRef.current
      void window.stoke.accounts.identity(requested, refresh).then(result => {
        if (live && mine === generation && accountIdentityKey(requested) === key) setValue(result || unavailableAccountIdentity(requested))
      }).catch(() => {
        if (live && mine === generation) setValue(unavailableAccountIdentity(requested))
      })
    }
    pull(revision > 0)
    const focus = () => pull()
    window.addEventListener('focus', focus)
    const timer = window.setInterval(focus, 30_000)
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [key, revision])
  return { identity: identityFor(target, value), refresh: () => setRevision(v => v + 1) }
}
