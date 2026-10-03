import { useRef, useState } from 'react'
import type { Settings } from '@shared/types'
import {
  CHAT_CAP_LIMITS,
  CHAT_IMPORTS,
  CHAT_PRESETS,
  CHAT_SOURCES,
  capsSentence,
  chatSourceInfo,
  formatBytes,
  formatCount,
  importDisclosure,
  presetOf,
  sourceDisclosure,
  type ChatDetection,
  type ChatIndexCaps,
  type ChatIndexStatus,
  type ChatPreset
} from '@shared/chatIndex'
import { FieldHint } from './FieldHint'
import { Spinner } from './Spinner'
import { ipcErrorMessage, relativeTime } from '../lib/format'
import { useDraft } from '../lib/useDraft'

interface Props {
  settings: Settings
  onPatch: (patch: Partial<Settings>) => void
  /** The index's own status, pushed by main while a pass runs. Null until the first read. */
  status: ChatIndexStatus | null
  /** Names and sizes only; null until asked for. */
  detection: ChatDetection | null
}

const PRESET_LABELS: Record<ChatPreset, { label: string; hint: string }> = {
  light: { label: 'Light', hint: '500 newest per tool, 1,500 in all, up to 512 MB read per pass' },
  standard: { label: 'Standard', hint: '2,000 newest per tool, 5,000 in all, up to 2 GB read per pass' },
  everything: {
    label: 'Everything',
    hint: 'No practical count limit. Each pass still reads at most 2 GB in 60 s, so a very large history is read over several passes'
  }
}

/**
 * Settings › Chat history: whether Stoke keeps a searchable copy of every AI
 * chat's text, which tools it reads, how much, and where the copy is.
 *
 * Every number the index is capped by is on this page and every cap that
 * bound is said per source (`sourceDisclosure`), because the owner asked for
 * caps "just in case anyone is a massive AI user" — and a cap nobody is told
 * about is a search that silently misses. Settings are patched through App,
 * the one writer (gotcha 57); number fields commit on blur or Enter
 * (`useDraft`, gotcha 63).
 */
export function ChatHistorySettings({ settings, onPatch, status, detection }: Props): React.JSX.Element {
  const on = settings.chatIndex === 'on'
  const opts = settings.chatIndexOptions
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState<'rebuild' | 'delete' | null>(null)
  const running = status?.state === 'running'

  const patchOpts = (patch: Partial<Settings['chatIndexOptions']>): void => onPatch({ chatIndexOptions: { ...opts, ...patch } })
  const patchCaps = (patch: Partial<ChatIndexCaps>): void => patchOpts({ caps: { ...opts.caps, ...patch } })
  const preset = presetOf(opts.caps)

  // Claimed before the await (gotcha 20): a second press does not delete twice.
  const act = (kind: 'rebuild' | 'delete'): void => {
    if (busy) return
    setBusy(kind)
    setConfirmDelete(false)
    const run = kind === 'rebuild' ? window.stoke.chats.rebuild() : window.stoke.chats.deleteIndex().then(() => undefined)
    void run.finally(() => setBusy(null))
  }

  /*
   * Importing an export. Claimed in a ref before the await (gotcha 20): a
   * second press, or a second file dropped while the first is read, is
   * refused here rather than started beside it.
   */
  const [importing, setImporting] = useState(false)
  const importingRef = useRef(false)
  const [importNote, setImportNote] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const runImport = (path: string | null): void => {
    // Nor while the index is being deleted: the import would write into a store about to go.
    if (importingRef.current || busy === 'delete') return
    importingRef.current = true
    setImporting(true)
    setImportNote(null)
    window.stoke.chats
      .importExport(path)
      .then(
        (r) => {
          if (!r) return // the dialog was cancelled
          if (r.ok) {
            const text = `${CHAT_IMPORTS[r.record.kind].label}, ${r.record.fileName}: ${importDisclosure(r.record, opts.caps)}`
            setImportNote({ tone: r.warning ? 'warning' : 'success', text: r.warning ? `${text} ${r.warning}` : text })
          } else {
            setImportNote({ tone: 'warning', text: r.error })
          }
        },
        (e: unknown) => setImportNote({ tone: 'warning', text: ipcErrorMessage(e) })
      )
      .finally(() => {
        importingRef.current = false
        setImporting(false)
      })
  }
  const removeImport = (id: number): void => {
    if (removing !== null) return
    setRemoving(id)
    void window.stoke.chats.removeImport(id).finally(() => setRemoving(null))
  }

  /*
   * The drop zone. Only a drag carrying files is taken, and `dragover` is
   * cancelled so a drop fires at all (gotcha 59) — without it Chromium would
   * navigate to the file, which `will-navigate` refuses as the backstop. The
   * depth counter keeps the ring from flickering off as the drag crosses a
   * child. The path comes from the preload (`pathForFile`): `File.path` is gone.
   */
  const dropDepth = useRef(0)
  const [dropOver, setDropOver] = useState(false)
  const carriesFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  const dropProps = {
    onDragEnter: (e: React.DragEvent): void => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      dropDepth.current++
      setDropOver(true)
    },
    onDragOver: (e: React.DragEvent): void => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = on && !importing && busy !== 'delete' ? 'copy' : 'none'
    },
    onDragLeave: (e: React.DragEvent): void => {
      if (!carriesFiles(e)) return
      e.stopPropagation()
      dropDepth.current = Math.max(0, dropDepth.current - 1)
      if (dropDepth.current === 0) setDropOver(false)
    },
    onDrop: (e: React.DragEvent): void => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      dropDepth.current = 0
      setDropOver(false)
      if (!on) {
        setImportNote({ tone: 'warning', text: 'Turn on chat history above to import an export.' })
        return
      }
      const files = Array.from(e.dataTransfer.files)
      if (files.length !== 1) {
        setImportNote({ tone: 'warning', text: 'Drop one export at a time.' })
        return
      }
      const path = window.stoke.pathForFile(files[0])
      if (!path) {
        setImportNote({ tone: 'warning', text: 'That drop has no file on disk behind it. Save the export first, then drop the saved file.' })
        return
      }
      runImport(path)
    }
  }
  const imports = status?.imports ?? []
  const importedChats = imports.reduce((n, r) => n + r.indexed, 0)

  const progress = status?.progress
  const lastPass = status?.lastPass
  return (
    <>
      <div className="field" data-setting="chats.enabled">
        <span className="field-label">Chat history</span>
        <label className="check-row">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => onPatch({ chatIndex: e.target.checked ? 'on' : 'off' })}
          />
          <span>
            <span>Keep a searchable copy of my AI chats</span>
            <FieldHint
              more={
                <>
                  Stoke reads the chats your coding tools keep on this computer, and any claude.ai or ChatGPT export
                  you import below — only what you and the model wrote, never tool output, images or pasted keys —
                  and keeps a private copy of that text so the sidebar&apos;s search can look inside them. The copy is
                  a file only your account can read, and it is never offered to the phone or to the browser tools.
                </>
              }
            >
              So the sidebar&apos;s search can look inside them. The copy stays on this computer.
            </FieldHint>
          </span>
        </label>
        <span className="chat-status" role="status" aria-live="polite">
          {running ? (
            <>
              <Spinner />
              {progress
                ? `Indexing ${chatSourceInfo(progress.source).label}: ${formatCount(progress.done)} of ${formatCount(progress.total)}…`
                : 'Indexing…'}
            </>
          ) : status?.error ? (
            status.error
          ) : lastPass ? (
            `Last indexed ${relativeTime(lastPass.startedMs + lastPass.ms)}: read ${formatBytes(lastPass.bytesRead)} in ${(lastPass.ms / 1000).toFixed(1)} s${
              lastPass.stoppedBy === 'time' || lastPass.stoppedBy === 'bytes' ? ', stopped at the pass limit; the next pass carries on' : ''
            }.`
          ) : on ? (
            'Not indexed yet.'
          ) : (
            'Off.'
          )}
        </span>
        {!on && (status?.chats ?? 0) > 0 && (
          <FieldHint tone="warning">
            Indexing is off, and search no longer looks in the copy — but the copy is still on disk ({formatBytes(status?.storeBytes ?? 0)}).
            Delete it below if you no longer want it.
          </FieldHint>
        )}
      </div>

      <div className="field" data-setting="chats.sources">
        <span className="field-label">Where Stoke looks</span>
        <FieldHint>Only these places, newest chats first. {capsSentence(opts.caps)}</FieldHint>
        <div className="chat-sources">
          {CHAT_SOURCES.map((src) => {
            const st = status?.sources.find((s) => s.id === src.id)
            const est = detection?.sources.find((s) => s.id === src.id)
            // Once a pass has listed the source, its sentence below has the counts; detection's
            // are by file name (Codex's include subagent threads), so only the size stays here.
            const listed = on && opts.sources[src.id] && st?.found !== null && st?.found !== undefined
            const found = est
              ? est.present
                ? listed || est.chats === null
                  ? `${formatBytes(est.bytes)} on disk`
                  : `Found ${formatCount(est.chats)}${est.atLeast ? '+' : ''} · ${formatBytes(est.bytes)}`
                : 'Not on this computer'
              : null
            return (
              <label key={src.id} className="check-row chat-source">
                <input
                  type="checkbox"
                  checked={opts.sources[src.id]}
                  onChange={(e) => patchOpts({ sources: { ...opts.sources, [src.id]: e.target.checked } })}
                />
                <span>
                  <span className="chat-source-head">
                    <span>{src.label}</span>
                    {found && <span className="chat-source-found">{found}</span>}
                  </span>
                  <span className="field-hint mono">{src.where}</span>
                  {on && opts.sources[src.id] && st && (st.found !== null || st.error) && (
                    <FieldHint tone={st.error ? 'warning' : undefined}>{sourceDisclosure(st, opts.caps)}</FieldHint>
                  )}
                </span>
              </label>
            )
          })}
        </div>
        <label className="check-row">
          <input type="checkbox" checked={opts.subagents} onChange={(e) => patchOpts({ subagents: e.target.checked })} />
          <span>
            <span>Include subagent chats</span>
            <FieldHint more="Off by default: on a heavy user’s machine they were nine tenths of the bytes, and nobody goes looking for them.">
              Claude Code&apos;s subagent transcripts and Codex&apos;s helper threads.
            </FieldHint>
          </span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={opts.redact} onChange={(e) => patchOpts({ redact: e.target.checked })} />
          <span>
            <span>Leave out anything that looks like an API key</span>
            <FieldHint more="Turned back on, it cleans what was kept while it was off. Chats another computer reads are cleaned whatever this says.">
              Keys, tokens, passwords and private keys pasted into a chat are replaced with [redacted] before the text is kept.
            </FieldHint>
          </span>
        </label>
      </div>

      <div className="field" data-setting="chats.imported">
        <span className="field-label">Imported chats</span>
        <FieldHint
          more={
            <>
              claude.ai and ChatGPT keep your chats on their servers, so the only way to search them here is an export:
              in claude.ai, Settings › Privacy › Export data; in ChatGPT, Settings › Data controls › Export data. Each
              emails a link to a .zip. Stoke reads only the conversations file inside it — never the images or anything
              else — and keeps each message&apos;s text, who wrote it and when, in this index and nowhere else.
              Importing the same export again, or a newer one, updates those conversations in place rather than adding
              copies. The limits below apply as they do to your tools: the newest {formatCount(opts.caps.perSource)} per
              service, {formatCount(opts.caps.total)} chats in all. Gemini and Grok exports are not read: neither has a
              documented format.
            </>
          }
        >
          A claude.ai or ChatGPT export (.zip, or its conversations.json), searched with everything else.
        </FieldHint>
        <div
          className="chat-import-drop"
          data-over={dropOver ? 'true' : undefined}
          data-disabled={!on ? 'true' : undefined}
          {...dropProps}
        >
          <button className="btn" disabled={!on || importing || busy === 'delete'} aria-busy={importing} onClick={() => runImport(null)}>
            {importing && <Spinner />}
            {importing ? 'Importing…' : 'Import an export…'}
          </button>
          <span className="field-hint">{on ? 'or drop the .zip here' : 'Turn on chat history above to import.'}</span>
        </div>
        {importNote && (
          <FieldHint tone={importNote.tone === 'warning' ? 'warning' : undefined}>
            <span role="status">{importNote.text}</span>
          </FieldHint>
        )}
        {imports.length > 0 && (
          <div className="chat-imports">
            {imports.map((r) => (
              <div key={r.id} className="chat-import">
                <div className="chat-import-main">
                  <span className="chat-source-head">
                    <span>{CHAT_IMPORTS[r.kind].label}</span>
                    <span className="chat-source-found truncate" title={r.fileName}>
                      {r.fileName} · {formatBytes(r.bytes)} · {relativeTime(r.importedMs)}
                    </span>
                  </span>
                  <FieldHint>{importDisclosure(r, opts.caps)}</FieldHint>
                </div>
                <button
                  className="btn"
                  data-variant="ghost"
                  disabled={removing !== null || importing}
                  aria-busy={removing === r.id}
                  onClick={() => removeImport(r.id)}
                  title="Remove this file’s conversations from the index"
                >
                  {removing === r.id && <Spinner />}
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="field" data-setting="chats.limits">
        <span className="field-label">Limits</span>
        <div className="segmented chat-presets" role="group" aria-label="How much to index">
          {(Object.keys(PRESET_LABELS) as ChatPreset[]).map((id) => (
            <button
              key={id}
              aria-pressed={preset === id}
              title={PRESET_LABELS[id].hint}
              onClick={() => patchCaps(CHAT_PRESETS[id])}
            >
              {PRESET_LABELS[id].label}
            </button>
          ))}
        </div>
        <FieldHint>
          {preset === 'custom' ? 'Custom limits' : PRESET_LABELS[preset].hint}. Whatever a limit leaves out is said
          beside its tool above.
        </FieldHint>
        <div className="chat-caps">
          <CapField label="Newest chats per tool" unit="chats" value={opts.caps.perSource} cap="perSource" onCommit={patchCaps} />
          <CapField label="Chats in all" unit="chats" value={opts.caps.total} cap="total" onCommit={patchCaps} />
          <CapField label="Read per pass" unit="MB" value={opts.caps.passMb} cap="passMb" onCommit={patchCaps} />
          <CapField label="Time per pass" unit="s" value={opts.caps.passSeconds} cap="passSeconds" onCommit={patchCaps} />
          <CapField label="Text kept per chat" unit="KB" value={opts.caps.chatKb} cap="chatKb" onCommit={patchCaps} />
          <CapField label="Largest file read whole" unit="MB" value={opts.caps.fileMb} cap="fileMb" onCommit={patchCaps} />
        </div>
      </div>

      <div className="field" data-setting="chats.index">
        <span className="field-label">The index</span>
        <FieldHint>
          <span className="mono">{status?.storePath ?? 'chat-index/index.sqlite in Stoke’s data folder'}</span>
          {status && status.chats > 0 && (
            <>
              {' '}
              — {formatBytes(status.storeBytes)}, {formatCount(status.chats)} chats, {formatCount(status.messages)} messages.
            </>
          )}
          {' '}A chat deleted by its own tool leaves the index at the next pass; an imported one stays until you
          remove its import or delete the index.
        </FieldHint>
        <div className="btn-row">
          <button className="btn" disabled={!on || running} onClick={() => void window.stoke.chats.indexNow()}>
            Index now
          </button>
          <button
            className="btn"
            disabled={!on || busy !== null}
            aria-busy={busy === 'rebuild'}
            onClick={() => act('rebuild')}
            title="Read every tool again from scratch. Imported chats are kept, and an import running now carries on."
          >
            {busy === 'rebuild' && <Spinner />}
            Rebuild
          </button>
          {/*
           * Delete waits for an import to end rather than stopping it: stopped,
           * the import's note under the button would report a partial import of
           * conversations the delete had just removed. Rebuild needs no such
           * wait — it keeps imports and leaves a running one alone (worker.ts).
           */}
          {confirmDelete ? (
            <>
              <button
                className="btn"
                data-variant="danger"
                disabled={importing}
                title={importing ? 'Wait for the import to finish' : undefined}
                onClick={() => act('delete')}
              >
                Delete the copy
              </button>
              <button className="btn" data-variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button
              className="btn"
              data-variant="ghost"
              disabled={busy !== null || importing || !status || status.chats === 0}
              aria-busy={busy === 'delete'}
              title={importing ? 'Wait for the import to finish' : undefined}
              onClick={() => setConfirmDelete(true)}
            >
              {busy === 'delete' && <Spinner />}
              Delete index
            </button>
          )}
        </div>
        {confirmDelete && (
          <FieldHint tone="warning">
            This deletes Stoke&apos;s copy only. Your chats in each tool are not touched.
            {importedChats > 0
              ? ` It also removes the ${formatCount(importedChats)} imported ${importedChats === 1 ? 'conversation' : 'conversations'}, which only this copy holds; import the files again to bring them back.`
              : ''}
            {on ? ' Indexing is still on, so the next pass builds it again from your tools; turn it off above to keep it gone.' : ''}
          </FieldHint>
        )}
      </div>
    </>
  )
}

/** One cap as a number box, clamped by main's hydrate, committed on blur or Enter. */
function CapField({
  label,
  unit,
  value,
  cap,
  onCommit
}: {
  label: string
  unit: string
  value: number
  cap: keyof ChatIndexCaps
  onCommit: (patch: Partial<ChatIndexCaps>) => void
}): React.JSX.Element {
  const lim = CHAT_CAP_LIMITS[cap]
  const field = useDraft(String(value), (v) => {
    const n = Number(v)
    // An emptied or non-numeric box reverts rather than writing a floor (gotcha 63).
    if (v.trim() === '' || !Number.isFinite(n)) {
      field.setDraft(String(value))
      return
    }
    onCommit({ [cap]: Math.min(lim.max, Math.max(lim.min, Math.round(n))) })
  })
  return (
    <label className="chat-cap">
      <span className="field-hint">{label}</span>
      <span className="chat-cap-input">
        <input
          className="input mono"
          inputMode="numeric"
          value={field.draft}
          onChange={(e) => field.setDraft(e.target.value)}
          onBlur={field.onBlur}
          onKeyDown={field.onKeyDown}
          aria-label={`${label} (${unit})`}
        />
        <span className="field-hint">{unit}</span>
      </span>
    </label>
  )
}
