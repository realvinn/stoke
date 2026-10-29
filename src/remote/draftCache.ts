/** Local, unsent text only. Each editor owns a separate slot so another tab
 * cannot overwrite it. Cleared records prevent old drafts resurfacing. */
export const DRAFT_TTL = 14 * 24 * 60 * 60 * 1000
export const DRAFT_MAX = 100_000
export interface DraftRecord { version: 1; text: string; at: number; kind: 'draft' | 'queued' | 'cleared'; retired: string[]; context?: string }
export interface RecoveryDraft extends DraftRecord { key: string }
export interface DraftStorage { length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const NAMESPACE = 'stoke.drafts.v2.'
const identifier = (): string => globalThis.crypto.randomUUID?.() ?? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join('-')
const token = (entry: RecoveryDraft): string => `${entry.key}@${entry.at}`

/** Find an old desktop-remote draft without modifying storage or crossing sessions. */
const restoredKey = (scope: string): string => `stoke.remote-restored.v1.${encodeURIComponent(scope)}`
function restoredTokens(storage: DraftStorage, scope: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(restoredKey(scope)) || '[]')
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(-1024) : []
  } catch { return [] }
}

export function legacyRemoteDraft(storage: DraftStorage, scope: string, now = Date.now()): RecoveryDraft | null {
  const prefix = `${NAMESPACE}${encodeURIComponent(scope)}::`
  const entries: RecoveryDraft[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(prefix)) continue
    try {
      const item: unknown = JSON.parse(storage.getItem(key) || 'null')
      if (!item || typeof item !== 'object') continue
      const value = item as Partial<DraftRecord>
      if (value.version !== 1 || typeof value.text !== 'string' || value.text.length > DRAFT_MAX || !Number.isSafeInteger(value.at) || (value.at ?? 0) < 0 || now - (value.at ?? 0) > DRAFT_TTL || !['draft', 'queued', 'cleared'].includes(value.kind ?? '') || !Array.isArray(value.retired) || value.retired.some(v => typeof v !== 'string') || value.retired.length > 1024) continue
      entries.push({ ...value, key } as RecoveryDraft)
    } catch { /* Ignore invalid records without changing them. */ }
  }
  const retired = new Set(entries.flatMap(entry => entry.retired))
  const restored = new Set(restoredTokens(storage, scope))
  return entries.filter(entry => entry.kind !== 'cleared' && !!entry.text.trim() && !retired.has(token(entry)) && !restored.has(token(entry))).sort((a, b) => b.at - a.at || b.key.localeCompare(a.key))[0] ?? null
}

/** Record only the revision identity; the original draft is never removed. */
export function markLegacyDraftRestored(storage: DraftStorage, scope: string, entry: RecoveryDraft): void {
  const tokens = restoredTokens(storage, scope)
  const id = token(entry)
  if (!tokens.includes(id)) tokens.push(id)
  storage.setItem(restoredKey(scope), JSON.stringify(tokens.slice(-1024)))
}

/** A known-unsent attempt may be offered again without changing the draft. */
export function unmarkLegacyDraftRestored(storage: DraftStorage, scope: string, entry: RecoveryDraft): void {
  storage.setItem(restoredKey(scope), JSON.stringify(restoredTokens(storage, scope).filter(id => id !== token(entry))))
}

/** Bound each insert without splitting a UTF-16 surrogate pair. */
export function splitLegacyDraft(text: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 2) return []
  const parts: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length)
    if (end < text.length && ((/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) || (text[end - 1] === '\r' && text[end] === '\n'))) end--
    parts.push(text.slice(start, end)); start = end
  }
  return parts
}
export class DraftJournal {
  readonly prefix: string
  readonly key: string
  private source: string | null = null
  private retired = new Set<string>()
  private lastAt = 0
  private storage: DraftStorage
  private now: () => number
  private context: string
  constructor(storage: DraftStorage, scope: string, now = Date.now, id = identifier(), context = '') {
    this.storage = storage; this.now = now
    this.context = context.slice(0, 200)
    // Expired drafts from sessions never revisited should not fill the quota.
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    for (const key of keys) if (key?.startsWith(NAMESPACE)) {
      try {
        const entry = JSON.parse(storage.getItem(key) || 'null')
        if (entry?.version === 1 && Number.isSafeInteger(entry.at) && now() - entry.at > DRAFT_TTL) storage.removeItem(key)
      } catch { /* Other slots remain available even if one cannot be read. */ }
    }
    this.prefix = `${NAMESPACE}${encodeURIComponent(scope)}::`
    this.key = this.prefix + id
  }
  records(): RecoveryDraft[] { return this.read(this.prefix) }
  private read(prefix: string): RecoveryDraft[] {
    const entries: RecoveryDraft[] = []
    const keys = Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i)).filter((key): key is string => !!key && key.startsWith(prefix))
    for (const key of keys) {
      try {
        const record = JSON.parse(this.storage.getItem(key) || 'null') as DraftRecord
        if (!record || record.version !== 1 || typeof record.text !== 'string' || record.text.length > DRAFT_MAX || !Number.isSafeInteger(record.at) || record.at < 0 || !['draft', 'queued', 'cleared'].includes(record.kind) || !Array.isArray(record.retired) || record.retired.some((item) => typeof item !== 'string') || record.retired.length > 1024 || (record.context !== undefined && (typeof record.context !== 'string' || record.context.length > 200))) continue
        if (this.now() - record.at > DRAFT_TTL) { this.storage.removeItem(key); continue }
        entries.push({ ...record, key })
      } catch { /* An invalid slot must not prevent recovery of other slots. */ }
    }
    return entries.sort((a, b) => b.at - a.at || b.key.localeCompare(a.key))
  }
  private visible(all = false): RecoveryDraft[] {
    const entries = this.read(all ? NAMESPACE : this.prefix)
    for (const entry of entries) for (const retired of entry.retired) this.retired.add(retired)
    return entries.filter((entry) => !this.retired.has(token(entry)))
  }
  initial(): RecoveryDraft | null {
    const entry = this.visible().filter((item) => item.kind !== 'queued')[0] ?? null
    this.source = entry ? token(entry) : null
    return entry
  }
  recoveries(all = false): RecoveryDraft[] { return this.visible(all).filter((entry) => entry.key !== this.key && entry.kind !== 'cleared' && entry.text) }
  save(text: string, kind: DraftRecord['kind'] = text ? 'draft' : 'cleared'): void {
    if (text.length > DRAFT_MAX) throw new Error('Draft exceeds the local recovery limit.')
    const entries = this.records()
    for (const entry of entries) for (const retired of entry.retired) this.retired.add(retired)
    if (this.source) this.retired.add(this.source)
    // Keep retirement markers only while their source revision still exists.
    const live = new Set(entries.map(token))
    const retired = [...this.retired].filter((item) => live.has(item))
    if (retired.length > 1024) throw new Error('Too many recovery revisions.')
    const at = Math.max(this.now(), this.lastAt + 1, ...entries.map((entry) => entry.at + 1))
    this.storage.setItem(this.key, JSON.stringify({ version: 1, text, at, kind, retired, context: this.context } satisfies DraftRecord))
    this.lastAt = at
  }
  clear(): void { this.save('', 'cleared') }
  archiveQueued(text: string): string {
    if (text.length > DRAFT_MAX) throw new Error('Queued recovery exceeds the local limit.')
    const key = this.prefix + identifier()
    this.storage.setItem(key, JSON.stringify({ version: 1, text, at: this.now(), kind: 'queued', retired: [], context: this.context } satisfies DraftRecord))
    return key
  }
  restore(entry: RecoveryDraft, current: string): string {
    if (current && current !== entry.text) {
      // Save a separate copy before replacing anything the user is editing.
      this.storage.setItem(this.prefix + identifier(), JSON.stringify({ version: 1, text: current, at: this.now(), kind: 'draft', retired: [], context: this.context } satisfies DraftRecord))
    }
    const oldSource = this.source, oldRetired = new Set(this.retired)
    this.source = entry.key.startsWith(this.prefix) ? token(entry) : null
    try { this.save(entry.text) } catch (error) { this.source = oldSource; this.retired = oldRetired; throw error }
    return entry.text
  }
}

/** Checkpoint roughly ten changed characters or 500ms idle, plus lifecycle
 * boundaries. Composition candidates are saved only after they are committed. */
export function mountDraftCache(input: HTMLTextAreaElement, journal: DraftJournal | null, options: {
  signal: AbortSignal
  notify: (state: 'saved' | 'restored' | 'editing' | 'error', recoveries: RecoveryDraft[]) => void
}): { flush(): boolean; clear(): void; queued(text: string): string | null; recoveries(): RecoveryDraft[]; refresh(): void; restore(entry: RecoveryDraft): boolean } {
  let committed = input.value, saved: string | null = input.value, changes = 0, composing = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stateNow: 'saved' | 'restored' | 'editing' | 'error' = 'saved'
  const report = (state: typeof stateNow): void => {
    let records: RecoveryDraft[] = []
    try { records = journal?.recoveries(true) ?? [] } catch { state = 'error' }
    stateNow = state
    options.notify(state, records.filter((record) => record.text !== input.value))
  }
  try {
    const initial = journal?.initial()
    if (initial) { input.value = initial.text; committed = initial.text; saved = initial.text; report(initial.kind === 'draft' ? 'restored' : 'saved') }
    else if (journal) report('saved')
    if (!journal) report('error')
  } catch { report('error') }
  const cancel = (): void => { if (timer) clearTimeout(timer); timer = null }
  const flush = (): boolean => {
    cancel()
    const value = composing ? committed : input.value
    if (value === saved) return true
    try {
      if (!journal) throw new Error('Local storage unavailable.')
      journal.save(value); saved = value; committed = value; changes = 0; report('saved'); return true
    } catch { report('error'); return false }
  }
  input.addEventListener('input', (event) => {
    if (composing || (event as InputEvent).isComposing) return
    const value = input.value
    changes += Math.max(1, Math.abs(value.length - committed.length), (event as InputEvent).data?.length ?? 0)
    committed = value
    if (stateNow !== 'editing' && stateNow !== 'error') report('editing')
    if (!value || changes >= 10) flush()
    else { cancel(); timer = setTimeout(flush, 500) }
  }, { signal: options.signal })
  input.addEventListener('compositionstart', () => { committed = input.value; composing = true }, { signal: options.signal })
  input.addEventListener('compositionend', () => { composing = false; committed = input.value; flush() }, { signal: options.signal })
  input.addEventListener('blur', flush, { signal: options.signal })
  window.addEventListener('pagehide', flush, { signal: options.signal })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') flush() }, { signal: options.signal })
  window.addEventListener('storage', (event) => { if (journal && event.key?.startsWith(NAMESPACE)) report(stateNow) }, { signal: options.signal })
  options.signal.addEventListener('abort', () => { flush(); cancel() }, { once: true })
  return {
    flush,
    refresh: () => report(stateNow),
    clear: () => { composing = false; input.value = ''; committed = ''; saved = null; flush() },
    queued: (text) => { try { if (!journal) throw new Error('Local storage unavailable.'); const key = journal.archiveQueued(text); report(stateNow); return key } catch { report('error'); return null } },
    recoveries: () => { try { return (journal?.recoveries(true) ?? []).filter((record) => record.text !== input.value) } catch { report('error'); return [] } },
    restore: (entry) => { try { if (!journal) throw new Error('Local storage unavailable.'); cancel(); input.value = journal.restore(entry, input.value); committed = saved = input.value; composing = false; changes = 0; report('restored'); return true } catch { report('error'); return false } }
  }
}
