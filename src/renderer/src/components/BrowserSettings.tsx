import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserProfile } from '@shared/browserProfiles'
import { DEFAULT_BROWSER_PROFILE_ID } from '@shared/browserProfiles'
import type { Settings } from '@shared/types'
import type { ImportResult, ImportSource } from '@shared/api'
import { FieldHint } from './FieldHint'
import { IconClose, IconPlus } from './Icons'
import { Spinner } from './Spinner'

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

    {(window.stoke.platform === 'darwin' || window.stoke.platform === 'win32') && (
      <ImportFromBrowsers profiles={browser.profiles} />
    )}
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
 *
 * On Windows the panel imports logins too, by a different route: Stoke briefly
 * launches the user's own browser in the background against a copy of the
 * profile and reads the plaintext cookies back — never a password. That brings
 * every v10 row and never a v20 (app-bound) one, which the browser unseals only
 * in its own default profile (gotcha 130); those are counted, not hidden. While
 * the browser is open its login file is locked, so the panel offers ONE explicit
 * close-and-reopen for the sources that reported it (gotcha 135). It still needs
 * an encrypting Stoke store (`canLogins`, gotcha 108). Safari never appears there.
 */
function ImportFromBrowsers({ profiles }: { profiles: BrowserProfile[] }): React.JSX.Element {
  const isMac = window.stoke.platform === 'darwin'
  const isWin = window.stoke.platform === 'win32'
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [loginsAllowed, setLoginsAllowed] = useState(true)
  const [busyNote, setBusyNote] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [cookies, setCookies] = useState(true)
  const [bookmarks, setBookmarks] = useState(true)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)

  // Logins need an encrypting Stoke store (`loginsAllowed`, gotcha 108) and a
  // platform Stoke can read the cookie key on: macOS through the Keychain, or
  // Windows by driving the browser's own binary (chromeCookiesWin.ts).
  const canLogins = loginsAllowed && (isMac || isWin)

  /*
   * Re-entry guards, claimed before the await (gotcha 20). The old `scanning`
   * and `running` checks read the last render, so two presses inside one tick
   * both passed them. For Import that is worse than a duplicate: main refuses
   * the second run and answers null at once, and that call's `finally` would
   * clear `running` — the button back to "Import", and its spinner gone, while
   * the first import was still going. (Read from the code; not driven.)
   */
  const scanningRef = useRef(false)
  const runningRef = useRef(false)

  const scan = (): void => {
    if (scanningRef.current) return
    scanningRef.current = true
    setScanning(true)
    void window.stoke.browser
      .importScan()
      .then(({ sources: found, loginsAllowed: allowed }) => {
        setSources(found)
        setLoginsAllowed(allowed)
        if (!allowed) setCookies(false)
        setChosen(new Set(found.filter((f) => f.status === 'ready').map((f) => f.key)))
      })
      .finally(() => {
        scanningRef.current = false
        setScanning(false)
      })
  }

  // Windows: the sources whose login file was locked by their running browser —
  // the only case closing it for a moment helps (never sealed v20 rows, 130).
  const lockedKeys = isWin ? (results ?? []).filter((r) => r.needsChromeClose).map((r) => r.key) : []

  // `retryKeys` is the Windows-only second press: the user has agreed Stoke may
  // close those browsers for a moment, then reopen them. It re-runs ONLY those
  // sources (main closes each browser once around them) and keeps every other
  // source's result on screen. Off on the first Import; never taken otherwise.
  const run = (retryKeys: string[] | null = null): void => {
    const keys = retryKeys ?? [...chosen]
    if (runningRef.current || keys.length === 0) return
    runningRef.current = true
    setRunning(true)
    if (!retryKeys) setResults(null)
    setBusyNote(null)
    void window.stoke.browser
      .importRun(keys, { cookies: cookies && canLogins, bookmarks, closeReopen: retryKeys !== null })
      .then((r) => {
        if (r && retryKeys) setResults((prev) => [...(prev ?? []).filter((p) => !r.some((n) => n.key === p.key)), ...r])
        else if (r) setResults(r)
        // Null is main refusing a second run: say so rather than do nothing.
        else setBusyNote('An import is already running. Its results appear here when you reopen this page.')
      })
      .finally(() => {
        runningRef.current = false
        setRunning(false)
      })
  }

  const nameOf = (s: ImportSource): string => (s.name === s.browserName ? s.name : `${s.browserName} · ${s.name}`)
  const intoOf = (key: string): string | null => profiles.find((p) => p.origin === key)?.label ?? null

  return (
    <div className="field">
      <span className="field-label">Import from other browsers</span>
      <FieldHint>
        {isMac
          ? 'Logins come over as cookies into a browser profile of their own for each profile you pick, so nothing mixes with Default. Claude’s browser tools can use them in that profile. Saved passwords cannot come over: Safari’s are sealed to Apple’s apps, and Stoke has no password manager to put Chrome’s in. Some sites — Google accounts especially — tie a login to the browser it was made in and will ask you to sign in again.'
          : 'Logins come over as cookies into a browser profile of their own for each profile you pick. Stoke briefly launches your own browser in the background against a copy of the profile to hand them over. Chrome installed for everyone on this PC seals newer logins with app-bound encryption, which it opens only inside its own profile — those cannot come over, and Stoke tells you how many stayed. Saved passwords cannot come over either — Stoke has no password manager to put them in. Some sites — Google accounts especially — tie a login to the browser it was made in and will ask you to sign in again.'}
      </FieldHint>

      {sources === null ? (
        <div className="settings-item-actions">
          <button
            className="btn"
            data-variant="ghost"
            data-size="sm"
            disabled={scanning}
            aria-busy={scanning}
            onClick={scan}
          >
            {scanning && <Spinner />}
            {scanning ? 'Looking…' : 'Find browsers'}
          </button>
        </div>
      ) : sources.length === 0 ? (
        <span className="field-hint">
          {isMac
            ? 'No Chrome, Chromium-based browser or Safari profile was found on this Mac.'
            : 'No Chrome or Chromium-based browser profile was found on this PC.'}
        </span>
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
                            cookies && canLogins && !result.cookieError
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
              checked={cookies && canLogins}
              disabled={running || !canLogins}
              onChange={(e) => setCookies(e.target.checked)}
            />
            <span>
              <span className="field-label">Logins</span>
              {!loginsAllowed ? (
                <span className="field-hint" data-tone="warning">
                  Not in this build of Stoke: it stores cookies unencrypted on disk, where any program running as you
                  — a Claude session&apos;s shell included — could read them without a prompt. Your browser keeps the
                  same logins sealed, so they stay there until Stoke encrypts its own.
                </span>
              ) : isMac ? (
                <FieldHint>
                  For Chrome, macOS asks whether <span className="mono">security</span> may use &ldquo;Chrome Safe
                  Storage&rdquo; — that is Stoke reading the key Chrome encrypts its cookies with. Press{' '}
                  <strong>Allow</strong>, not Always Allow: Always Allow would let any program on this Mac read that
                  key without asking, from then on.
                </FieldHint>
              ) : (
                <FieldHint>
                  Stoke briefly launches your own browser in the background — no window, against a copy of the
                  profile — to hand the logins over decrypted, then closes that copy. While your browser is open,
                  Windows keeps its login file locked, so Stoke will offer to close it for a moment and reopen it; it
                  never forces it. Logins sealed with app-bound encryption stay behind and are counted, never dropped
                  silently.
                </FieldHint>
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
              disabled={running || chosen.size === 0 || (!(cookies && canLogins) && !bookmarks)}
              aria-busy={running}
              onClick={() => run()}
            >
              {running && <Spinner />}
              {running ? 'Importing…' : `Import ${chosen.size} profile${chosen.size === 1 ? '' : 's'}`}
            </button>
            <button
              className="btn"
              data-variant="ghost"
              data-size="sm"
              disabled={scanning || running}
              aria-busy={scanning}
              onClick={scan}
            >
              {scanning && <Spinner />}
              {scanning ? 'Looking…' : 'Look again'}
            </button>
          </div>
          {lockedKeys.length > 0 && (
            <div className="settings-item import-source-extra">
              <FieldHint>
                Your browser is open, and while it is, Windows keeps its login file locked. Stoke can close it for a
                moment the way signing out of Windows does — every window is kept for next time — copy the logins, and
                reopen it. Your windows and tabs come back if it is set to continue where you left off; otherwise they
                are in its History. Anything typed into a page and not yet sent is lost, as when Windows signs out.
                Stoke never forces it to quit.
              </FieldHint>
              <div className="settings-item-actions">
                <button
                  className="btn"
                  data-variant="primary"
                  data-size="sm"
                  disabled={running}
                  aria-busy={running}
                  onClick={() => run(lockedKeys)}
                >
                  {running && <Spinner />}
                  {running ? 'Closing and reading…' : 'Close the browser, get the logins, reopen it'}
                </button>
              </div>
            </div>
          )}
          {busyNote && <span className="field-hint">{busyNote}</span>}
        </>
      )}
    </div>
  )
}
