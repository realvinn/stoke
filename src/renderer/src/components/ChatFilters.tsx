import { CHAT_IMPORTS, CHAT_SOURCES } from '@shared/chatIndex'
import { chatDateBoundary, hasChatSearchFilters, type ChatSearchFilters } from '@shared/chatSearch'

function dateValue(ms: number | undefined, end: boolean): string {
  if (ms === undefined) return ''
  const date = new Date(end ? ms - 1 : ms)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function amount(value: string, multiplier = 1): number | undefined {
  if (!value.trim()) return undefined
  const n = Number(value) * multiplier
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? Math.round(n) : undefined
}

export function ChatFilters({ filters, onChange, onClear }: {
  filters: ChatSearchFilters
  onChange: (patch: Partial<ChatSearchFilters>) => void
  onClear: () => void
}): React.JSX.Element {
  const active = hasChatSearchFilters(filters)
  return (
    <details className="chat-filters">
      <summary>History filters{active && <span className="pill">On</span>}</summary>
      <div className="chat-filters-body">
        <p className="field-hint">Filter this computer’s indexed chats. Leave the search box empty to browse matches.</p>
        <div className="chat-filter-grid">
          <label>Last active from
            <input className="input" type="date" value={dateValue(filters.afterMs, false)}
              onChange={(e) => onChange({ afterMs: chatDateBoundary(e.target.value, false) })} />
          </label>
          <label>Through
            <input className="input" type="date" value={dateValue(filters.beforeMs, true)}
              onChange={(e) => onChange({ beforeMs: chatDateBoundary(e.target.value, true) })} />
          </label>
        </div>
        <label>Agent or source
          <select className="input" value={filters.source ?? ''}
            onChange={(e) => onChange({ source: e.target.value as ChatSearchFilters['source'] || undefined })}>
            <option value="">All sources</option>
            {CHAT_SOURCES.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
            {Object.entries(CHAT_IMPORTS).map(([id, source]) => <option key={id} value={id}>{source.label}</option>)}
          </select>
        </label>
        <label>Model contains
          <input className="input" value={filters.model ?? ''} spellCheck={false}
            onChange={(e) => onChange({ model: e.target.value || undefined })} />
        </label>
        <label>Folder contains
          <input className="input" value={filters.folder ?? ''} spellCheck={false}
            onChange={(e) => onChange({ folder: e.target.value || undefined })} />
        </label>
        <div className="chat-filter-grid">
          <label>Est. span, min minutes
            <input className="input" type="number" min="0" step="any" value={filters.minSpanMs === undefined ? '' : filters.minSpanMs / 60_000}
              onChange={(e) => onChange({ minSpanMs: amount(e.target.value, 60_000) })} />
          </label>
          <label>Max minutes
            <input className="input" type="number" min="0" step="any" value={filters.maxSpanMs === undefined ? '' : filters.maxSpanMs / 60_000}
              onChange={(e) => onChange({ maxSpanMs: amount(e.target.value, 60_000) })} />
          </label>
        </div>
        <div className="chat-filter-grid">
          <label>Context tokens, min
            <input className="input" type="number" min="0" step="1" value={filters.minContextTokens ?? ''}
              onChange={(e) => onChange({ minContextTokens: amount(e.target.value) })} />
          </label>
          <label>Max tokens
            <input className="input" type="number" min="0" step="1" value={filters.maxContextTokens ?? ''}
              onChange={(e) => onChange({ maxContextTokens: amount(e.target.value) })} />
          </label>
        </div>
        <p className="field-hint">Estimated span uses recorded start and last activity, which may use file dates and include idle time. Context tokens use Codex’s latest snapshot, not billed usage. Metric filters exclude unknown values. Rebuild the index to read snapshots from older chats.</p>
        <button className="btn" disabled={!active} onClick={onClear}>Clear filters</button>
      </div>
    </details>
  )
}
