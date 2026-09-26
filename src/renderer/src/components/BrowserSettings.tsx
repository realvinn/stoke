import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserProfile } from '@shared/browserProfiles'
import { DEFAULT_BROWSER_PROFILE_ID } from '@shared/browserProfiles'
import type { Settings } from '@shared/types'
import { FieldHint } from './FieldHint'
import { IconClose, IconPlus } from './Icons'

interface Props {
  browser: Settings['browser']
  onPatch: (patch: Partial<Settings>) => void
}

/**
 * Settings > Browser: the docked browser's profiles.
 *
 * Each profile is its own set of logins (browserProfiles.ts), so this is the
 * one place that can add, rename, pick and remove them; the chip in the
 * browser bar only switches. Remove is two presses, because it is the one
 * destructive thing here: it signs out of everything in that profile and
 * wipes its storage, and there is no bringing it back.
 *
 * Renames are drafts committed on blur or Enter, and flushed on unmount too —
 * closing the sheet fires no blur (gotcha 63's shape, as HostsSettings does).
 */
export function BrowserSettings({ browser, onPatch }: Props): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const labelOf = (p: BrowserProfile): string => drafts[p.id] ?? p.label

  const renamed = useCallback(
    (list: BrowserProfile[], pending: Record<string, string>): BrowserProfile[] | null => {
      let moved = false
      const next = list.map((p) => {
        const draft = pending[p.id]?.trim()
        if (draft === undefined || draft === '' || draft === p.label) return p
        moved = true
        return { ...p, label: draft }
      })
      return moved ? next : null
    },
    []
  )

  const commit = useCallback(
    (id: string): void => {
      const pending = drafts[id] === undefined ? {} : { [id]: drafts[id] }
      setDrafts(({ [id]: _drop, ...rest }) => rest)
      const next = renamed(browser.profiles, pending)
      if (next) onPatch({ browser: { ...browser, profiles: next } })
    },
    [drafts, browser, onPatch, renamed]
  )

  const flushRef = useRef<() => void>(() => {})
  flushRef.current = (): void => {
    const next = renamed(browser.profiles, drafts)
    if (next) onPatch({ browser: { ...browser, profiles: next } })
  }
  useEffect(() => () => flushRef.current(), [])

  const add = (): void => {
    void window.stoke.browser.addProfile()
  }

  const remove = (id: string): void => {
    // Claimed before the await: a second press must not wipe twice (gotcha 20).
    if (busy) return
    setBusy(id)
    setConfirming(null)
    void window.stoke.browser.removeProfile(id).finally(() => setBusy(null))
  }

  return (
    <div className="field">
      <span className="field-label">Browser profiles</span>
      <FieldHint>
        Each profile keeps its own logins, cookies and site data, like people in Chrome. The chip in the
        browser bar switches between them, and Claude&apos;s browser tools act in whichever one is in use.
      </FieldHint>

      {browser.profiles.map((profile) => {
        const active = profile.id === browser.currentProfile
        const isDefault = profile.id === DEFAULT_BROWSER_PROFILE_ID
        return (
          <details key={profile.id} className="settings-item">
            <summary className="settings-item-summary">
              <span className="settings-item-name">{profile.label}</span>
              <span className="settings-item-sub truncate">
                {[active ? 'In use' : '', profile.source].filter(Boolean).join(' · ')}
              </span>
            </summary>

            <div className="settings-item-body">
              <label className="cc-text">
                <span className="field-label">Name</span>
                <input
                  className="input"
                  value={labelOf(profile)}
                  maxLength={40}
                  spellCheck={false}
                  onChange={(e) => setDrafts((d) => ({ ...d, [profile.id]: e.target.value }))}
                  onBlur={() => commit(profile.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                />
              </label>

              <div className="settings-item-actions">
                {!active && (
                  <button
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    onClick={() => onPatch({ browser: { ...browser, currentProfile: profile.id } })}
                  >
                    Use this profile
                  </button>
                )}
                {!isDefault &&
                  (confirming === profile.id ? (
                    <>
                      <button className="btn" data-variant="danger" onClick={() => remove(profile.id)}>
                        Remove {profile.label} and its logins
                      </button>
                      <button className="btn" data-variant="ghost" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn"
                      data-variant="ghost"
                      data-size="sm"
                      disabled={busy === profile.id}
                      onClick={() => setConfirming(profile.id)}
                    >
                      <IconClose />
                      {busy === profile.id ? 'Removing…' : 'Remove'}
                    </button>
                  ))}
              </div>
            </div>
          </details>
        )
      })}

      <div className="settings-item-actions">
        <button className="btn" data-variant="ghost" data-size="sm" onClick={add}>
          <IconPlus />
          Add profile
        </button>
      </div>
    </div>
  )
}
