import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserProfile } from '@shared/browserProfiles'
import { DEFAULT_BROWSER_PROFILE_ID } from '@shared/browserProfiles'
import type { Settings } from '@shared/types'
import type { ImportResult, ImportSource } from '@shared/api'
import { FieldHint } from './FieldHint'
import { IconClose, IconPlus } from './Icons'

interface Props {
  browser: Settings['browser']
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
export function BrowserSettings({ browser }: Props): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const labelOf = (p: BrowserProfile): string => drafts[p.id] ?? p.label

  /*
   * Renames go to main one profile at a time, against the list main holds NOW.
   * Sending this component's copy of the whole block could drop a profile an
   * import added a moment ago.
   */
  const commit = useCallback(
    (profile: BrowserProfile): void => {
      const draft = drafts[profile.id]
      setDrafts(({ [profile.id]: _drop, ...rest }) => rest)
      const label = draft?.trim()
      if (label && label !== profile.label) void window.stoke.browser.renameProfile(profile.id, label)
    },
    [drafts]
  )

  const flushRef = useRef<() => void>(() => {})
  flushRef.current = (): void => {
    for (const p of browser.profiles) {
      const label = drafts[p.id]?.trim()
      if (label && label !== p.label) void window.stoke.browser.renameProfile(p.id, label)
    }
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
    <>
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
                  onBlur={() => commit(profile)}
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
                    onClick={() => void window.stoke.browser.useProfile(profile.id)}
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

    {window.stoke.platform === 'darwin' && <ImportFromBrowsers profiles={browser.profiles} />}
    </>
  )
}

/**
 * Bringing logins and bookmarks over from Chrome and Safari.
 *
 * Every step is the user's: nothing is read until "Find browsers", and each
 * macOS prompt (App Data, the Keychain, Full Disk Access) is raised by a press
 * here, so none of them arrives out of nowhere. Only counts come back from
 * main; a cookie value never reaches this process.
 */
function ImportFromBrowsers({ profiles }: { profiles: BrowserProfile[] }): React.JSX.Element {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [loginsAllowed, setLoginsAllowed] = useState(true)
  const [busyNote, setBusyNote] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [cookies, setCookies] = useState(true)
  const [bookmarks, setBookmarks] = useState(true)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)

  const scan = (): void => {
    if (scanning) return
    setScanning(true)
    void window.stoke.browser
      .importScan()
      .then(({ sources: found, loginsAllowed: allowed }) => {
        setSources(found)
        setLoginsAllowed(allowed)
        if (!allowed) setCookies(false)
        setChosen(new Set(found.filter((f) => f.status === 'ready').map((f) => f.key)))
      })
      .finally(() => setScanning(false))
  }

  const run = (): void => {
    if (running || chosen.size === 0) return
    setRunning(true)
    setResults(null)
    setBusyNote(null)
    void window.stoke.browser
      .importRun([...chosen], { cookies: cookies && loginsAllowed, bookmarks })
      .then((r) => {
        if (r) setResults(r)
        // Null is main refusing a second run: say so rather than do nothing.
        else setBusyNote('An import is already running. Its results appear here when you reopen this page.')
      })
      .finally(() => setRunning(false))
  }

  const nameOf = (s: ImportSource): string => (s.name === s.browserName ? s.name : `${s.browserName} · ${s.name}`)
  const intoOf = (key: string): string | null => profiles.find((p) => p.origin === key)?.label ?? null

  return (
    <div className="field">
      <span className="field-label">Import from other browsers</span>
      <FieldHint>
        Logins come over as cookies into a browser profile of their own for each profile you pick, so
        nothing mixes with Default. Claude&apos;s browser tools can use them in that profile. Saved
        passwords cannot come over: Safari&apos;s are sealed to Apple&apos;s apps, and Stoke has no password
        manager to put Chrome&apos;s in. Some sites — Google accounts especially — tie a login to the
        browser it was made in and will ask you to sign in again.
      </FieldHint>

      {sources === null ? (
        <div className="settings-item-actions">
          <button className="btn" data-variant="ghost" data-size="sm" disabled={scanning} onClick={scan}>
            {scanning ? 'Looking…' : 'Find browsers'}
          </button>
        </div>
      ) : sources.length === 0 ? (
        <span className="field-hint">No Chrome, Chromium-based browser or Safari profile was found on this Mac.</span>
      ) : (
        <>
          {sources.map((s) => {
            const ready = s.status === 'ready'
            const into = intoOf(s.key)
            const result = results?.find((r) => r.key === s.key)
            return (
              <div key={s.key} className="settings-item import-source">
                <label className="check-row">
                  <input
                    type="checkbox"
                    disabled={!ready || running}
                    checked={ready && chosen.has(s.key)}
                    onChange={(e) =>
                      setChosen((c) => {
                        const next = new Set(c)
                        if (e.target.checked) next.add(s.key)
                        else next.delete(s.key)
                        return next
                      })
                    }
                  />
                  <span className="import-source-text">
                    <span className="field-label">{nameOf(s)}</span>
                    <span className="field-hint">
                      {[s.detail, into ? `imports into “${into}”` : ''].filter(Boolean).join(' · ') || ' '}
                    </span>
                    {result && (
                      <span className="field-hint" data-tone={result.error ? 'danger' : undefined}>
                        {result.error ??
                          [
                            cookies && !result.cookieError
                              ? `${result.cookies} login cookie${result.cookies === 1 ? '' : 's'}`
                              : '',
                            bookmarks ? `${result.bookmarks} bookmark${result.bookmarks === 1 ? '' : 's'}` : '',
                            result.skippedCookies ? `${result.skippedCookies} could not come over` : ''
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                      </span>
                    )}
                    {result?.cookieError && (
                      <span className="field-hint" data-tone="danger">
                        {result.cookieError}
                      </span>
                    )}
                  </span>
                </label>
                {!ready && (
                  <span className="field-hint import-source-extra">{s.note ?? 'Stoke cannot read this profile yet.'}</span>
                )}
                {s.status === 'needsFullDiskAccess' && (
                  <div className="settings-item-actions import-source-extra">
                    <button
                      className="btn"
                      data-variant="ghost"
                      data-size="sm"
                      onClick={() => window.stoke.browser.openFullDiskAccess()}
                    >
                      Open Full Disk Access
                    </button>
                    <span className="field-hint">
                      Turn Stoke on there, then quit and reopen Stoke. Full Disk Access reaches everything Stoke
                      runs — every Claude session and terminal — for as long as it is on, so turn it off again
                      once the import is done.
                    </span>
                  </div>
                )}
              </div>
            )
          })}

          <label className="check-row">
            <input
              type="checkbox"
              checked={cookies && loginsAllowed}
              disabled={running || !loginsAllowed}
              onChange={(e) => setCookies(e.target.checked)}
            />
            <span>
              <span className="field-label">Logins</span>
              {loginsAllowed ? (
                <FieldHint>
                  For Chrome, macOS asks whether <span className="mono">security</span> may use &ldquo;Chrome Safe
                  Storage&rdquo; — that is Stoke reading the key Chrome encrypts its cookies with. Press{' '}
                  <strong>Allow</strong>, not Always Allow: Always Allow would let any program on this Mac read that
                  key without asking, from then on.
                </FieldHint>
              ) : (
                <span className="field-hint" data-tone="warning">
                  Not in this build of Stoke: it stores cookies unencrypted on disk, where any program running as you
                  — a Claude session&apos;s shell included — could read them without a prompt. Chrome keeps the same
                  logins behind your Keychain, so they stay there until Stoke encrypts its own.
                </span>
              )}
            </span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={bookmarks}
              disabled={running}
              onChange={(e) => setBookmarks(e.target.checked)}
            />
            <span>
              <span className="field-label">Bookmarks</span>
              <FieldHint>Added to Stoke&apos;s bookmark list; folders are not kept.</FieldHint>
            </span>
          </label>

          <div className="settings-item-actions">
            <button
              className="btn"
              data-variant="primary"
              disabled={running || chosen.size === 0 || (!cookies && !bookmarks)}
              onClick={run}
            >
              {running ? 'Importing…' : `Import ${chosen.size} profile${chosen.size === 1 ? '' : 's'}`}
            </button>
            <button className="btn" data-variant="ghost" data-size="sm" disabled={scanning || running} onClick={scan}>
              {scanning ? 'Looking…' : 'Look again'}
            </button>
          </div>
          {busyNote && <span className="field-hint">{busyNote}</span>}
        </>
      )}
    </div>
  )
}
