/**
 * Account exports as plain text: a claude.ai export's and a ChatGPT export's
 * `conversations.json`, one conversation at a time. Pure — no file is opened
 * here (`importer.ts` reads, `zip.ts` unpacks) — so `verify:chat-sources`
 * holds every rule against synthetic fixtures, the way `parse.ts` does for the
 * local tools, and with parse.ts's own text rules (`push` → `cleanText`:
 * blobs out, keys redacted when asked, one message capped).
 *
 * Neither vendor documents its schema (claude.ai's help page names the export
 * and nothing inside it; checked 2026-09-30), so every field is read by name,
 * none is required but the conversation's id, and anything unrecognised is
 * skipped rather than guessed at:
 *
 * - **claude.ai**: an array of `{uuid, name, created_at, updated_at,
 *   chat_messages[{uuid, sender: human|assistant, text, content[{type,
 *   text}], created_at, parent_message_uuid, attachments, files}],
 *   current_leaf_message_uuid}`. `content`'s `text` blocks are the words;
 *   `thinking`, `tool_use` and `tool_result` are not. An edited message is a
 *   branch: when messages carry `parent_message_uuid`, only the branch ending at
 *   `current_leaf_message_uuid` (else the newest message) is kept.
 * - **ChatGPT**: an array of `{id | conversation_id, title, create_time,
 *   update_time (epoch s), mapping{node: {message, parent, children}},
 *   current_node}`. The mapping is a TREE — every edit and regeneration is a
 *   branch — and only the path from `current_node` up to the root is the
 *   conversation the user sees. System, tool and hidden turns, and an
 *   assistant turn addressed to a tool (`recipient` not `all`), are left out.
 */
import type { ChatImportKind } from '../../shared/chatIndex.ts'
import { cleanText, emptyFold, note, push, stamp, type Fold } from './parse.ts'

export interface ExportConversation {
  id: string
  fold: Fold
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/* ------------------------------------------------------------ the array */

const BOM = [0xef, 0xbb, 0xbf]
const QUOTE = 0x22
const BACKSLASH = 0x5c

/**
 * Every OBJECT at the top of a JSON array, by byte range, without parsing the
 * whole document: a ChatGPT `conversations.json` can pass V8's ~512 MB string
 * limit, where one `JSON.parse` could not even be attempted, and each element
 * parsed on its own costs only its own size. Bytes, not characters — `"`, `\`,
 * brackets and braces are ASCII and never occur inside a UTF-8 multi-byte
 * sequence — so nothing is decoded until an element is.
 *
 * Throws when the document is not an array. `complete` is false when the
 * array never closed (a truncated file): what came before is still returned.
 */
export function forEachArrayObject(buf: Buffer, each: (start: number, end: number) => void): { count: number; complete: boolean } {
  let i = 0
  if (buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2]) i = 3
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++
  if (buf[i] !== 0x5b) throw new SyntaxError('not a JSON array')
  i++
  let depth = 0
  let start = -1
  let count = 0
  const len = buf.length
  while (i < len) {
    const c = buf[i]
    if (c === QUOTE) {
      // Jump to the closing quote: one not preceded by an odd run of backslashes.
      let q = i + 1
      for (;;) {
        q = buf.indexOf(QUOTE, q)
        if (q < 0) return { count, complete: false }
        let bs = 0
        for (let k = q - 1; k > i && buf[k] === BACKSLASH; k--) bs++
        if (bs % 2 === 0) break
        q++
      }
      i = q + 1
      continue
    }
    if (c === 0x7b || c === 0x5b) {
      if (depth === 0) start = c === 0x7b ? i : -1
      depth++
    } else if (c === 0x7d || c === 0x5d) {
      if (depth === 0) {
        // The array's own `]`.
        return { count, complete: c === 0x5d }
      }
      depth--
      if (depth === 0 && start >= 0) {
        each(start, i + 1)
        count++
        start = -1
      }
    }
    i++
  }
  return { count, complete: false }
}

/* ----------------------------------------------------------- recognising */

/** Which export a conversation belongs to, by its shape: `chat_messages` is claude.ai's, `mapping` ChatGPT's. */
export function exportKindOf(doc: unknown): ChatImportKind | null {
  if (!isObj(doc)) return null
  if (Array.isArray(doc.chat_messages)) return 'export-claude'
  if (isObj(doc.mapping)) return 'export-chatgpt'
  return null
}

/** The conversation's own id and newest stamp — all the first read of an export needs to rank it. */
export function exportIdentity(doc: unknown, kind: ChatImportKind): { id: string; updatedMs: number | null } | null {
  if (!isObj(doc)) return null
  if (kind === 'export-claude') {
    const id = str(doc.uuid)
    return id ? { id, updatedMs: stamp(doc.updated_at) ?? stamp(doc.created_at) } : null
  }
  const id = str(doc.conversation_id) ?? str(doc.id)
  return id ? { id, updatedMs: stamp(doc.update_time) ?? stamp(doc.create_time) } : null
}

/* ------------------------------------------------------------- claude.ai */

/** The branch the user last saw: from the leaf up through `parent_message_uuid`, in order. */
function claudeAiBranch(all: Obj[], leaf: string | null): Obj[] {
  if (!all.some((m) => str(m.parent_message_uuid))) return all
  const byId = new Map<string, Obj>()
  for (const m of all) {
    const id = str(m.uuid)
    if (id) byId.set(id, m)
  }
  let cur = leaf && byId.has(leaf) ? leaf : str(all[all.length - 1]?.uuid)
  const chain: Obj[] = []
  const seen = new Set<string>()
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    const m = byId.get(cur)!
    chain.push(m)
    cur = str(m.parent_message_uuid)
  }
  return chain.length ? chain.reverse() : all
}

/**
 * A message's words: its `content` text blocks, else (an older export, with no
 * blocks) its `text`. Never `text` beside blocks: there it repeats them, with a
 * placeholder where a tool call or an artifact was. Attached and uploaded files
 * are named on a line of their own, so a file name is findable; their contents
 * are not the conversation.
 */
function claudeAiText(m: Obj): string {
  const blocks = Array.isArray(m.content) ? (m.content as unknown[]).filter(isObj) : []
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text)
  }
  if (blocks.length === 0 && typeof m.text === 'string' && m.text.trim()) parts.push(m.text)
  const names: string[] = []
  for (const list of [m.attachments, m.files]) {
    if (!Array.isArray(list)) continue
    for (const f of list) {
      const n = isObj(f) ? str(f.file_name) : null
      if (n && !names.includes(n)) names.push(n)
    }
  }
  if (names.length) parts.push(`[Attached: ${names.join(', ')}]`)
  return parts.join('\n')
}

export function foldClaudeAiConversation(doc: unknown, redact: boolean): ExportConversation | null {
  if (!isObj(doc)) return null
  const id = str(doc.uuid)
  if (!id) return null
  const all = Array.isArray(doc.chat_messages) ? (doc.chat_messages as unknown[]).filter(isObj) : []
  const fold = emptyFold()
  for (const m of claudeAiBranch(all, str(doc.current_leaf_message_uuid))) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null
    if (!role) continue
    const at = stamp(m.created_at)
    note(fold.meta, at)
    const text = claudeAiText(m)
    if (text) push(fold, role, text, at, redact)
  }
  finish(fold, { title: doc.name, created: doc.created_at, updated: doc.updated_at, model: doc.model }, redact)
  return { id, fold }
}

/* --------------------------------------------------------------- ChatGPT */

/** The conversation the user sees: from `current_node` (else the newest leaf) up to the root, in order. */
function chatgptBranch(mapping: Obj, current: string | null): Obj[] {
  let leaf = current && isObj(mapping[current]) ? current : null
  if (!leaf) {
    let best = -Infinity
    for (const [id, node] of Object.entries(mapping)) {
      if (!isObj(node) || (Array.isArray(node.children) && node.children.length > 0)) continue
      const t = isObj(node.message) ? (stamp(node.message.create_time) ?? 0) : 0
      if (t >= best) {
        best = t
        leaf = id
      }
    }
  }
  const chain: Obj[] = []
  const seen = new Set<string>()
  let cur = leaf
  while (cur && isObj(mapping[cur]) && !seen.has(cur)) {
    seen.add(cur)
    const node = mapping[cur] as Obj
    chain.push(node)
    cur = str(node.parent)
  }
  return chain.reverse()
}

/** A turn's words: `text` and `multimodal_text` string parts, and a voice turn's transcript. Images and tool payloads are not words. */
function chatgptText(content: Obj): string {
  const type = content.content_type
  if (type !== 'text' && type !== 'multimodal_text') return ''
  const parts: string[] = []
  for (const p of Array.isArray(content.parts) ? (content.parts as unknown[]) : []) {
    if (typeof p === 'string') {
      if (p.trim()) parts.push(p)
    } else if (isObj(p) && p.content_type === 'audio_transcription' && typeof p.text === 'string' && p.text.trim()) {
      parts.push(p.text)
    }
  }
  return parts.join('\n')
}

export function foldChatgptConversation(doc: unknown, redact: boolean): ExportConversation | null {
  if (!isObj(doc) || !isObj(doc.mapping)) return null
  const id = str(doc.conversation_id) ?? str(doc.id)
  if (!id) return null
  const fold = emptyFold()
  let model: unknown = doc.default_model_slug
  for (const node of chatgptBranch(doc.mapping, str(doc.current_node))) {
    const msg = node.message
    if (!isObj(msg)) continue
    const author = isObj(msg.author) ? msg.author.role : null
    if (author !== 'user' && author !== 'assistant') continue
    // An assistant turn addressed to a tool (browser, python, …) is the call, not the reply.
    if (typeof msg.recipient === 'string' && msg.recipient !== 'all') continue
    const md = isObj(msg.metadata) ? msg.metadata : {}
    if (md.is_visually_hidden_from_conversation === true) continue
    const content = isObj(msg.content) ? msg.content : {}
    const text = chatgptText(content)
    const at = stamp(msg.create_time)
    note(fold.meta, at)
    if (author === 'assistant' && typeof md.model_slug === 'string') model = md.model_slug
    if (text) push(fold, author, text, at, redact)
  }
  finish(fold, { title: doc.title, created: doc.create_time, updated: doc.update_time, model }, redact)
  return { id, fold }
}

/** The conversation's own title and stamps win over what its messages implied. */
function finish(fold: Fold, own: { title: unknown; created: unknown; updated: unknown; model: unknown }, redact: boolean): void {
  const title = str(own.title)
  if (title) fold.meta.title = cleanText(title, { redact, maxBytes: 1024 }) || null
  const created = stamp(own.created)
  const updated = stamp(own.updated)
  if (created !== null) fold.meta.createdMs = created
  if (updated !== null) fold.meta.updatedMs = Math.max(updated, fold.meta.updatedMs ?? updated)
  if (typeof own.model === 'string' && own.model) fold.meta.model = own.model
}

export function foldExportConversation(doc: unknown, kind: ChatImportKind, redact: boolean): ExportConversation | null {
  return kind === 'export-claude' ? foldClaudeAiConversation(doc, redact) : foldChatgptConversation(doc, redact)
}
