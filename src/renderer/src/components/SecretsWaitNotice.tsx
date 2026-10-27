import { useEffect } from 'react'
import { secretsNotice, type SecretsOpenState } from '@shared/secretsOpen'
import { dismissToast, toast } from '../lib/toasts'

/**
 * Long enough to outlast any Keychain dialog someone is still looking for; the
 * toast is dismissed the moment the store opens, never left to time out.
 */
const NOTICE_MS = 30 * 60 * 1000

/**
 * What the window says while main opens the secret store (store.ts
 * `initSecretStore`). Draws nothing itself: it raises one toast (gotcha 154 —
 * news, not a question; nothing here needs an answer from Stoke) and takes it
 * down once the store has opened or failed to.
 *
 * Until then main holds back the settings (`settings:get` waits) and every
 * launch, because the sealed keys read '' — so the window is up but empty, and
 * on macOS the reason is usually a Keychain password dialog, often behind other
 * windows. Elsewhere nothing prompts, so it speaks only after a second
 * (`secretsNotice`). Mounted once, outside anything that waits for settings.
 */
export function SecretsWaitNotice(): null {
  useEffect(() => {
    let live = true
    let shown: number | null = null
    let timer: number | null = null
    let latest: SecretsOpenState | null = null
    // The store never closes again, so an `opening` that arrives after a settled
    // state (the asked state's reply racing the push) is stale.
    let settled = false

    const clear = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      if (shown !== null) dismissToast(shown)
      shown = null
    }

    const apply = (state: SecretsOpenState): void => {
      if (!live || (settled && state.phase === 'opening')) return
      if (state.phase === 'open' || state.phase === 'off') settled = true
      latest = state
      const notice = secretsNotice(state)
      if (!notice) {
        clear()
        return
      }
      if (shown !== null || timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        // The store may have opened while this waited; only a still-pending open speaks.
        const now = latest ? secretsNotice(latest) : null
        if (!live || !now) return
        shown = toast({ title: now.title, description: now.description, duration: NOTICE_MS })
      }, notice.afterMs)
    }

    const off = window.stoke.secretStore.onState(apply)
    void window.stoke.secretStore.state().then(apply, () => undefined)
    return () => {
      live = false
      off()
      clear()
    }
  }, [])
  return null
}
