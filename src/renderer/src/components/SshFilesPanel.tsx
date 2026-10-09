import { useCallback, useEffect, useRef, useState } from 'react'
import type { SshHost } from '@shared/types'
import { MAX_FILE_BYTES, type PhoneFileListing } from '@shared/remoteFiles'

/** Mounted only by the explicit Browse action. Its parent keys it by host
 * and permission so switching hosts cannot paint a late previous result. */
export function SshFilesPanel({ host, onClose }: { host: SshHost; onClose: () => void }): React.JSX.Element {
  const active = useRef<string | null>(null)
  const alive = useRef(true)
  const [busy, setBusy] = useState(false)
  const [listing, setListing] = useState<PhoneFileListing | null>(null)
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<{ received: number; size: number } | null>(null)
  const run = useCallback(async (work: (requestId: string) => Promise<void>): Promise<void> => {
    if (active.current || !alive.current) return
    const id = crypto.randomUUID()
    active.current = id
    setBusy(true); setMessage(''); setProgress(null)
    try { await work(id) }
    catch { if (alive.current) setMessage('The file operation failed. Check the connection and retry.') }
    finally { if (active.current === id) { active.current = null; if (alive.current) setBusy(false) } }
  }, [])
  const browse = useCallback((path: string): Promise<void> => run(async (requestId) => {
    const result = await window.stoke.ssh.filesList({ requestId, hostId: host.id, path })
    if (!alive.current || active.current !== requestId) return
    if (result.ok) setListing(result.listing)
    else setMessage(result.message)
  }), [host.id, run])
  useEffect(() => {
    alive.current = true
    const off = window.stoke.ssh.onFilesProgress((event) => {
      if (alive.current && active.current === event.requestId) setProgress({ received: event.received, size: event.size })
    })
    void browse('')
    return () => {
      alive.current = false
      off()
      const id = active.current
      active.current = null
      if (id) window.stoke.ssh.filesCancel(id)
    }
  }, [browse])
  const save = (path: string): void => { void run(async (requestId) => {
    const result = await window.stoke.ssh.filesSave({ requestId, hostId: host.id, path })
    if (!alive.current || active.current !== requestId) return
    setMessage(result.ok ? result.saved ? 'File saved.' : 'Save cancelled.' : result.message)
  }) }
  return (
    <section className="ssh-files-panel" aria-label={`Files on ${host.label || host.alias}`}>
      <div className="settings-item-actions">
        <span className="mono ssh-files-location">{host.downloadFolder}{listing?.path ? `/${listing.path}` : ''}</span>
        <button className="btn" data-size="sm" disabled={busy} onClick={() => void browse(listing?.path ?? '')}>Refresh</button>
        <button className="btn" data-size="sm" disabled={busy || !listing?.path} onClick={() => void browse(listing!.path.split('/').slice(0, -1).join('/'))}>Up</button>
        <button className="btn" data-size="sm" onClick={onClose}>Close files</button>
      </div>
      {busy && (
        <div className="settings-item-actions">
          <span role="status">{progress ? progress.received === progress.size ? 'Verifying and saving…' : `Downloading · ${progress.size ? Math.round(progress.received / progress.size * 100) : 100}%` : 'Reading folder or waiting for save location…'}</span>
          <button className="btn" data-size="sm" onClick={() => { if (active.current) window.stoke.ssh.filesCancel(active.current) }}>Cancel</button>
        </div>
      )}
      {progress && <progress max={Math.max(1, progress.size)} value={progress.size ? progress.received : 1} aria-label="SSH download progress" />}
      <div className="ssh-files-entries" aria-busy={busy}>
        {listing?.entries.map((entry) => (
          <button key={entry.path} className="ssh-files-entry" disabled={busy || (entry.kind === 'file' && entry.size !== null && entry.size > MAX_FILE_BYTES)}
            onClick={() => { if (entry.kind === 'folder') void browse(entry.path); else save(entry.path) }}>
            <span>{entry.name}</span>
            <small>{entry.kind === 'folder' ? 'Open folder' : entry.size !== null ? `${(entry.size / 1024 / 1024).toFixed(1)} MB · Download` : 'Download'}</small>
          </button>
        ))}
        {listing && !listing.entries.length && <span className="field-hint">No visible files in this folder.</span>}
      </div>
      {listing?.truncated && <span className="field-hint">Listing limited to 200 visible entries or 2,000 scanned entries.</span>}
      {message && <span role="status" className="field-hint">{message}</span>}
    </section>
  )
}
