/**
 * What the docked browser is allowed to load, and how a typed address becomes a
 * URL.
 *
 * Pure and in `shared/` because it is a *decision*, not a navigation: the same
 * answer has to be reachable from `browser.ts` (the address bar), from
 * `mcp/page.ts` (the agent) and from a verify suite that may not import
 * `electron`. Nothing here touches `node:` anything, so both tsconfigs compile
 * it.
 */

/**
 * The schemes a docked tab may be loaded from.
 *
 * `file:` is not one of them for anything the *agent* drives. `browser_read`
 * turns whatever is loaded into text for the model, so a `file://` load is an
 * arbitrary local-file read performed by whoever holds the browser tools:
 * `browser_open('file:///Users/you/.ssh/id_rsa')` followed by `browser_read` was
 * a complete exfiltration path with no prompt anywhere along it.
 *
 * A person typing into the address bar is a different actor with a real use for
 * it — previewing a local build — so `EmbeddedBrowser.navigate` passes
 * `allowLocalFiles` and nothing else does.
 *
 * `javascript:` and `data:` are refused on both paths. Each executes in the
 * context it lands in, and neither is ever what a typed address, an OSC 8
 * terminal link or a tool call meant.
 */
export const BROWSABLE_SCHEMES = new Set(['http', 'https', 'about'])

export interface UrlOpts {
  /** Permit `file://`. The address bar passes this; no tool call may. */
  allowLocalFiles?: boolean
}

/**
 * The scheme of `input` if this build refuses it, else null.
 *
 * Callers with somewhere to report it — the MCP tools answer a model — use it to
 * say why nothing loaded. `normalizeUrl` uses it to fall back to a search, which
 * is all an address bar can do with an address it cannot open.
 */
export function refusedScheme(input: string, opts: UrlOpts = {}): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(input.trim())
  if (!m) return null
  const scheme = m[1].toLowerCase()
  // Scheme-shaped and not a scheme: `localhost:3000` is a host and a port.
  if (scheme === 'localhost') return null
  if (BROWSABLE_SCHEMES.has(scheme)) return null
  if (scheme === 'file' && opts.allowLocalFiles) return null
  return scheme
}

const searchFor = (raw: string): string => `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`

/** Accepts URLs, bare hostnames, localhost:port and free text (searched). */
export function normalizeUrl(input: string, opts: UrlOpts = {}): string {
  const raw = input.trim()
  if (!raw) return 'about:blank'
  /*
   * Host-and-port BEFORE the scheme test, because `localhost:3000` matches the
   * scheme shape. It used to be returned untouched, so Chromium was handed a
   * URL whose scheme was `localhost` and the commonest development address
   * there is failed to load — into `loadURL`'s own swallowed `.catch`, so the
   * address bar simply did nothing and said nothing.
   */
  if (/^localhost(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)) return `http://${raw}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return refusedScheme(raw, opts) ? searchFor(raw) : raw
  }
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$|:\d)/.test(raw)) return `https://${raw}`
  return searchFor(raw)
}
