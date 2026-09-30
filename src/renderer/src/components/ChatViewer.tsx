import { useEffect, useMemo, useRef, useState } from 'react'
import {
  chatAssistantName,
  chatOriginBadge,
  chatOriginLabel,
  highlightRanges,
  isChatImportKind,
  type ChatSearchHit,
  type ChatTranscript
} from '@shared/chatIndex'
import { Highlight } from './Highlight'
import { IconCheck, IconClose, IconCopy } from './Icons'
import { Spinner } from './Spinner'
import { baseName, ipcErrorMessage, relativeTime } from '../lib/format'

/** What the sidebar handed over: the hit (for a header while the text loads), the query it matched, and why this is not a live session. */
export interface ChatViewTarget {
  hit: ChatSearchHit
  query: string
  note: string | null
}

function stampLabel(ms: number | null): string {
  if (ms === null) return ''
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The whole chat as plain text, for Copy all: who, when, then what they said. */
function asText(t: ChatTranscript, title: string): string {
  const who = chatAssistantName(t.source)
  const lines = [`# ${title}`, '']
  for (const m of t.messages) {
    lines.push(`${m.role === 'user' ? 'You' : who}${m.atMs !== null ? ` — ${stampLabel(m.atMs)}` : ''}`, m.text, '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * A chat that cannot be taken back up, read-only: an import, a Zed or Cowork
 * thread, a subagent's transcript, an agent that is not installed or cannot be
 * handed a session id. Messages in order, who said each and when, the search's
 * words marked, and a copy button per message and for the whole chat.
 *
 * A column of `.body-row` (App places it beside the main column), never an
 * overlay: the docked browser is a native view that paints over every pixel of
 * the page (gotcha 14), and a chat you are reading should stay beside the
 * terminal you might paste it into.
 *
 * Main re-reads a local chat from its own tool's file when it is opened, so
 * what shows is the tool's copy now, not the index's; the header says when it
 * is the index's instead (an import, or an original that is gone).
 */
export function ChatViewer({ target, onClose }: { target: ChatViewTarget; onClose: () => void }): React.JSX.Element {
  const { hit, query, note } = target
  const [state, setState] = useState<{ chatId: number; t: ChatTranscript | null; error: string | null } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const scrolledFor = useRef<number | null>(null)

  // Numbered like every other load here: a slow answer for the chat before must not land on this one.
  const req = useRef(0)
  useEffect(() => {
    const n = ++req.current
    setState(null)
    window.stoke.chats.open(hit.chatId).then(
      (t) => {
        if (n === req.current) setState({ chatId: hit.chatId, t, error: t ? null : 'This chat is no longer in the index.' })
      },
      (e: unknown) => {
        if (n === req.current) setState({ chatId: hit.chatId, t: null, error: ipcErrorMessage(e) })
      }
    )
  }, [hit.chatId])

  const t = state?.chatId === hit.chatId ? state.t : null
  const marks = useMemo(() => (t ? t.messages.map((m) => highlightRanges(m.text, query)) : []), [t, query])
  const hits = marks.reduce((n, r) => n + r.length, 0)

  // To the first message that says what was searched for, once per chat.
  useEffect(() => {
    if (!t || scrolledFor.current === t.chatId) return
    scrolledFor.current = t.chatId
    const first = listRef.current?.querySelector('[data-hit="true"]')
    if (first) first.scrollIntoView({ block: 'center' })
    else listRef.current?.scrollTo({ top: 0 })
  }, [t])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(null), 1400)
    return () => clearTimeout(id)
  }, [copied])

  const title = t?.title ?? hit.title ?? hit.firstPrompt ?? 'Untitled chat'
  const who = chatAssistantName(hit.source)
  const copy = (key: string, text: string): void => {
    window.stoke.clipboard.writeText(text)
    setCopied(key)
  }
  const updated = t?.updatedMs ?? hit.updatedMs
  const cwd = t?.cwd ?? hit.cwd

  return (
    <section className="chat-view" aria-label={`Chat: ${title}`}>
      <header className="chat-view-head">
        <div className="chat-view-heading">
          <span className="chat-view-title truncate" title={title}>
            {title}
          </span>
          <span className="chat-view-meta">
            <span className="pill chat-badge">{chatOriginBadge(hit.source)}</span>
            {updated !== null && <span className="chat-hit-age">{relativeTime(updated)}</span>}
            {cwd && (
              <span className="truncate" title={cwd}>
                {baseName(cwd)}
              </span>
            )}
            {t && (
              <span className="chat-hit-age">
                {t.messages.length.toLocaleString()} {t.messages.length === 1 ? 'message' : 'messages'}
              </span>
            )}
          </span>
        </div>
        <button
          className="btn"
          data-variant="ghost"
          disabled={!t || t.messages.length === 0}
          onClick={() => t && copy('all', asText(t, title))}
          title="Copy the whole chat as text"
        >
          {copied === 'all' ? <IconCheck /> : <IconCopy />}
          {copied === 'all' ? 'Copied' : 'Copy all'}
        </button>
        <button className="icon-btn" onClick={onClose} title="Close the chat">
          <IconClose />
          <span className="sr-only">Close the chat</span>
        </button>
      </header>

      <div className="chat-view-notes">
        {note && <p className="chat-view-note">{note}</p>}
        {isChatImportKind(hit.source) && (
          <p className="chat-view-note">From your {chatOriginLabel(hit.source)}: the index’s copy, the only one Stoke has.</p>
        )}
        {t?.fallback && (
          <p className="chat-view-note" data-tone="warning">
            {t.fallback}
          </p>
        )}
        {t?.partial && (
          <p className="chat-view-note">
            Part of this chat is not shown: the middle of a very long conversation, or a file past the size read in one go.
          </p>
        )}
        {t && query.trim() && (
          <p className="chat-view-note">
            {hits === 0
              ? `“${query.trim()}” is not in what is shown here.`
              : `${hits.toLocaleString()} ${hits === 1 ? 'match' : 'matches'} for “${query.trim()}”, marked below.`}
          </p>
        )}
      </div>

      {!state ? (
        <p className="chat-view-status" aria-live="polite">
          <Spinner /> Reading the chat…
        </p>
      ) : state.error || !t ? (
        <p className="chat-view-status" role="status">
          {state.error ?? 'This chat could not be read.'}
        </p>
      ) : t.messages.length === 0 ? (
        <p className="chat-view-status">This chat has no text to show.</p>
      ) : (
        <ol className="chat-view-list" ref={listRef}>
          {t.messages.map((m, i) => {
            const key = `m${i}`
            const ranges = marks[i] ?? []
            return (
              <li key={key} className="chat-msg" data-role={m.role} data-hit={ranges.length > 0 ? 'true' : undefined}>
                <div className="chat-msg-head">
                  <span className="chat-msg-who">{m.role === 'user' ? 'You' : who}</span>
                  {m.atMs !== null && <time className="chat-msg-at">{stampLabel(m.atMs)}</time>}
                  <button
                    className="icon-btn chat-msg-copy"
                    onClick={() => copy(key, m.text)}
                    title="Copy this message"
                  >
                    {copied === key ? <IconCheck /> : <IconCopy />}
                    <span className="sr-only">Copy this message</span>
                  </button>
                </div>
                <div className="chat-msg-text">
                  <Highlight text={m.text} ranges={ranges} />
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
