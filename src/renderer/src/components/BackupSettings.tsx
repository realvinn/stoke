import { useEffect, useRef, useState } from 'react'
import type { SecretStoreStatus } from '@shared/secrets'
import { secretLabel } from '@shared/secrets'
import { judgePassphrase, type SetupPreview } from '@shared/setupFile'
import { FieldHint } from './FieldHint'
import { Spinner } from './Spinner'

/*
 * Settings › Backup & transfer: where this machine keeps its keys, and a
 * passphrase-sealed file that carries the setup to another machine.
 *
 * Phase 1 of the auth-hub design (docs/superpowers/specs/2026-09-30-auth-hub-
 * design.md §16) — no account and no server. The passphrases live only in this
 * component's state for as long as the form is up; the decrypted import never
 * reaches the renderer at all (main holds it between Unlock and Apply, and
 * sends back only what would change, never a key).
 */

type Note = { tone?: 'success' | 'warning' | 'danger'; text: string } | null

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export function BackupSettings(): React.JSX.Element {
  const [status, setStatus] = useState<SecretStoreStatus | null | 'loading'>('loading')

  useEffect(() => {
    let live = true
    void window.stoke.backup.status().then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <>
      <KeyStorage status={status} />
      <ExportSetup />
      <ImportSetup onImported={() => void window.stoke.backup.status().then(setStatus)} />
    </>
  )
}

function KeyStorage({ status }: { status: SecretStoreStatus | null | 'loading' }): React.JSX.Element {
  if (status === 'loading') {
    return (
      <div className="field" data-setting="backup.storage">
        <span className="field-label">Where your keys live</span>
        <span className="field-hint">Asking the key store…</span>
      </div>
    )
  }
  const stranded = status?.stranded ?? []
  return (
    <div className="field" data-backup="storage" data-setting="backup.storage">
      <span className="field-label">
        Where your keys live{' '}
        {status && (
          <span className="pill" data-tone={status.protected ? 'success' : 'danger'}>
            {status.protected ? 'encrypted' : 'plain text'}
          </span>
        )}
      </span>
      {status === null ? (
        <span className="field-hint" data-tone="warning">
          The key store did not open this run, so keys are in settings.json in plain text, as in earlier versions.
        </span>
      ) : status.protected ? (
        <span className="field-hint">
          {status.why} API keys, endpoint keys and the phone access key are kept in{' '}
          <span className="mono">secrets.json</span>, readable only by Stoke on this computer;{' '}
          <span className="mono">settings.json</span> holds empty placeholders.
          {status.held.length > 0
            ? ` ${status.held.length === 1 ? 'One key is' : `${status.held.length} keys are`} stored there now.`
            : ' No key is stored yet; the first one you add goes there.'}
        </span>
      ) : (
        <span className="field-hint" data-tone="warning">
          {status.why}
        </span>
      )}
      {status?.vaultWriteError && (
        <span className="field-hint" data-tone="warning" data-backup="vault-write-error">
          The last change to your keys could not be written to <span className="mono">secrets.json</span> (
          {status.vaultWriteError}), so the changed key is in settings.json in plain text for now. Stoke tries again on
          the next change to any setting, and moves it back at the next start.
        </span>
      )}
      {stranded.length > 0 && (
        <span className="field-hint" data-tone="warning">
          {stranded.length === 1 ? 'One saved key' : `${stranded.length} saved keys`} could not be opened on this run (
          {stranded.map((p) => secretLabel(p)).join(', ')}). They are kept, not deleted: type a key again in Providers
          or Agents to replace it.
        </span>
      )}
      <FieldHint>
        Earlier versions kept these keys in plain text in settings.json, so a backup of this computer made before
        this version may still hold them — rotate them at console.anthropic.com/settings/keys and
        openrouter.ai/settings/keys if that matters. An older version of Stoke opened on this computer sees the keys as
        empty.
      </FieldHint>
    </div>
  )
}

function ExportSetup(): React.JSX.Element {
  const [includeKeys, setIncludeKeys] = useState(false)
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note>(null)
  // The claim (gotcha 20/51): state has not re-rendered the disabled button
  // by the time a double click's second press lands.
  const claimed = useRef(false)

  const verdict = judgePassphrase(pass)
  const mismatch = again.length > 0 && again !== pass
  const ready = verdict.acceptable && again === pass && !busy

  const run = (): void => {
    if (!ready || claimed.current) return
    claimed.current = true
    setBusy(true)
    setNote(null)
    void window.stoke.backup
      .exportSetup({ passphrase: pass, includeSecrets: includeKeys })
      .then((res) => {
        if (res.ok) {
          setPass('')
          setAgain('')
          setNote({
            tone: 'success',
            text: `Saved ${res.path}${res.keys ? `, with ${res.keys === 1 ? 'one key' : `${res.keys} keys`}` : ', without keys'}.`
          })
        } else if (!res.canceled) {
          setNote({ tone: 'danger', text: res.message })
        }
      })
      .finally(() => {
        claimed.current = false
        setBusy(false)
      })
  }

  const tone = pass ? (verdict.score >= 3 ? 'success' : verdict.acceptable ? undefined : 'warning') : undefined

  return (
    <div className="field" data-backup="export" data-setting="backup.export">
      <span className="field-label">Export this setup</span>
      <span className="field-hint">
        One file to carry to another computer: theme, fonts, terminal, session defaults, profiles, SSH hosts, coding
        agents and their endpoints, worklog boards. Not this computer’s folders, window, <span className="mono">claude</span>{' '}
        location or phone access. Sealed with your passphrase (scrypt and AES-256-GCM).
      </span>
      <label className="check-row">
        <input type="checkbox" checked={includeKeys} disabled={busy} onChange={(e) => setIncludeKeys(e.target.checked)} />
        <span>
          <span>Include API keys</span>
          <span className="field-hint">
            Anthropic, OpenRouter and gateway keys, and each coding agent’s endpoint key. Never the phone access key,
            which opens a shell on this computer only.
          </span>
        </span>
      </label>
      <input
        className="input"
        type="password"
        aria-label="Passphrase"
        placeholder="Passphrase"
        autoComplete="new-password"
        spellCheck={false}
        value={pass}
        disabled={busy}
        onChange={(e) => setPass(e.target.value)}
      />
      <input
        className="input"
        type="password"
        aria-label="Repeat the passphrase"
        placeholder="Repeat the passphrase"
        autoComplete="new-password"
        spellCheck={false}
        value={again}
        disabled={busy}
        onChange={(e) => setAgain(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run()
        }}
      />
      <span className="field-hint" data-tone={tone} aria-live="polite">
        {verdict.label ? `${verdict.label}. ` : ''}
        {mismatch ? 'The two passphrases differ.' : verdict.hint}
      </span>
      <div className="settings-item-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn" data-variant="primary" disabled={!ready} aria-busy={busy || undefined} onClick={run}>
          {busy && <Spinner />}
          {busy ? 'Sealing…' : 'Export…'}
        </button>
      </div>
      {note && (
        <span className="field-hint" data-tone={note.tone} role="status">
          {note.text}
        </span>
      )}
    </div>
  )
}

function ImportSetup({ onImported }: { onImported: () => void }): React.JSX.Element {
  const [picked, setPicked] = useState<string | null>(null)
  const [pass, setPass] = useState('')
  const [preview, setPreview] = useState<SetupPreview | null>(null)
  const [takeKeys, setTakeKeys] = useState(true)
  const [busy, setBusy] = useState<'pick' | 'unlock' | 'apply' | null>(null)
  const [note, setNote] = useState<Note>(null)
  const claimed = useRef(false)

  /*
   * Leaving the section (or closing the sheet, which unmounts it with no blur
   * — gotcha 63) drops main's copy of the unlocked file, so a decrypted setup
   * does not sit in memory behind a form nobody can see.
   */
  const pending = useRef(false)
  pending.current = picked !== null
  useEffect(
    () => () => {
      if (pending.current) void window.stoke.backup.cancelImport()
    },
    []
  )

  const claim = (kind: 'pick' | 'unlock' | 'apply'): boolean => {
    if (claimed.current) return false
    claimed.current = true
    setBusy(kind)
    return true
  }
  const release = (): void => {
    claimed.current = false
    setBusy(null)
  }

  const pick = (): void => {
    if (!claim('pick')) return
    setNote(null)
    void window.stoke.backup
      .pickImport()
      .then((res) => {
        if (res.ok) {
          setPicked(res.name)
          setPass('')
          setPreview(null)
        } else if (!res.canceled) {
          setNote({ tone: 'danger', text: res.message })
        }
      })
      .finally(release)
  }

  const unlock = (): void => {
    if (!pass || !claim('unlock')) return
    setNote(null)
    void window.stoke.backup
      .previewImport(pass)
      .then((res) => {
        if (res.ok) {
          setPreview(res.preview)
          setTakeKeys(true)
        } else {
          setNote({ tone: 'danger', text: res.message })
        }
      })
      .finally(release)
  }

  const apply = (): void => {
    if (!preview || !claim('apply')) return
    void window.stoke.backup
      .applyImport({ includeSecrets: takeKeys && preview.secrets.length > 0 })
      .then((res) => {
        if (res.ok) {
          setPicked(null)
          setPass('')
          setPreview(null)
          setNote({
            tone: 'success',
            text: `Imported: ${res.changed === 0 ? 'no setting needed changing' : res.changed === 1 ? 'one setting changed' : `${res.changed} settings changed`}${res.keys ? `, ${res.keys === 1 ? 'one key' : `${res.keys} keys`}` : ''}.`
          })
          onImported()
        } else {
          setNote({ tone: 'danger', text: res.message })
        }
      })
      .finally(release)
  }

  const cancel = (): void => {
    void window.stoke.backup.cancelImport()
    setPicked(null)
    setPass('')
    setPreview(null)
    setNote(null)
  }

  const made = preview?.createdAt ? new Date(preview.createdAt) : null

  return (
    <div className="field" data-backup="import" data-setting="backup.import">
      <span className="field-label">Import a setup</span>
      <span className="field-hint">
        A setup file is merged into this computer’s: SSH hosts, themes and profiles are added to yours, and anything
        that belongs to this computer stays as it is. You see what would change before anything does.
      </span>
      <div className="settings-item-actions" style={{ justifyContent: 'flex-start' }}>
        <button
          className="btn"
          disabled={busy !== null}
          aria-busy={busy === 'pick' || undefined}
          onClick={pick}
        >
          {busy === 'pick' && <Spinner />}
          {busy === 'pick' ? 'Opening…' : picked ? 'Choose another file…' : 'Choose file…'}
        </button>
      </div>

      {picked && !preview && (
        <>
          <span className="field-hint">
            <span className="mono">{picked}</span>
          </span>
          <input
            className="input"
            type="password"
            aria-label="Passphrase for the setup file"
            placeholder="The passphrase it was made with"
            autoComplete="off"
            spellCheck={false}
            value={pass}
            disabled={busy !== null}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') unlock()
            }}
          />
          <div className="settings-item-actions" style={{ justifyContent: 'flex-start' }}>
            <button
              className="btn"
              data-variant="primary"
              disabled={!pass || busy !== null}
              aria-busy={busy === 'unlock' || undefined}
              onClick={unlock}
            >
              {busy === 'unlock' && <Spinner />}
              {busy === 'unlock' ? 'Unlocking…' : 'Unlock'}
            </button>
            <button className="btn" data-variant="ghost" disabled={busy !== null} onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {preview && (
        <div className="settings-item-card backup-preview" style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="field-hint">
            From <span className="mono">{picked}</span>
            {preview.from.version && `, Stoke ${preview.from.version}`}
            {preview.from.platform && ` on ${PLATFORM_NAMES[preview.from.platform] ?? preview.from.platform}`}
            {made && !Number.isNaN(made.getTime()) && `, made ${made.toLocaleString()}`}.
          </span>
          {preview.changes.length === 0 ? (
            <span className="field-hint">Every setting in the file already matches this computer.</span>
          ) : (
            <ul className="backup-changes">
              {preview.changes.map((c) => (
                <li key={c.key}>
                  <span className="backup-change-label">{c.label}</span>
                  <span className="backup-change-detail">{c.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {preview.unchanged > 0 && (
            <span className="field-hint">
              {preview.unchanged === 1 ? 'One other setting is' : `${preview.unchanged} other settings are`} the same
              already.
            </span>
          )}
          {preview.skipped.map((s) => (
            <span key={s.key} className="field-hint" data-tone="warning">
              Not imported — {s.label}: {s.why}
            </span>
          ))}
          {preview.secrets.length > 0 && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={takeKeys}
                disabled={busy !== null}
                onChange={(e) => setTakeKeys(e.target.checked)}
              />
              <span>
                <span>
                  Also import the {preview.secrets.length === 1 ? 'key' : `${preview.secrets.length} keys`} in this file
                </span>
                <span className="field-hint">
                  {preview.secrets
                    .map((s) => `${s.label} (${s.action === 'add' ? 'new here' : s.action === 'replace' ? 'replaces yours' : 'same as yours'})`)
                    .join(', ')}
                </span>
              </span>
            </label>
          )}
          <div className="settings-item-actions" style={{ justifyContent: 'flex-start' }}>
            <button
              className="btn"
              data-variant="primary"
              disabled={busy !== null}
              aria-busy={busy === 'apply' || undefined}
              onClick={apply}
            >
              {busy === 'apply' && <Spinner />}
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </button>
            <button className="btn" data-variant="ghost" disabled={busy !== null} onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {note && (
        <span className="field-hint" data-tone={note.tone} role="status">
          {note.text}
        </span>
      )}
    </div>
  )
}
