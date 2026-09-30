/*
 * One request to a Stoke Hub, signed as this device (spec §3.4), and the one
 * way its answer is read: `readHubResponse`, which refuses anything that is
 * not the hub BEFORE a byte is parsed — a Cloudflare challenge or a captive
 * portal answers HTML with status 200 (gotcha 71).
 *
 * `fetch` and the clock are injected so `verify:hub-client` drives this
 * against a hub on 127.0.0.1 with nothing else faked. No electron import.
 */
import { hubEndpoint } from '../../shared/hub/edge.ts'
import { HUB_ERROR_STATUS, readHubResponse, type HubErrorCode } from '../../shared/hub/protocol.ts'
import { signRequest } from './crypto.ts'

/** A request the hub refused, or that never reached it. `code` is the hub's, or `offline`. */
export class HubRequestError extends Error {
  readonly status: number
  readonly code: HubErrorCode
  readonly retryAfterMs: number | undefined
  constructor(code: HubErrorCode, message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export interface HubAuth {
  device: string
  signPriv: string
  /** Absent: a sign-in an active device proves by signature alone (spec §3.3). */
  token?: string
}

export interface HubHttpDeps {
  fetch: typeof fetch
  now: () => number
}

/** A request's whole budget. The hub answers in milliseconds; a sign-in runs one scrypt (~0.5 s). */
export const HUB_REQUEST_TIMEOUT_MS = 20_000

/** The sentence for a code the hub sent with no message worth showing. */
function sentenceFor(code: HubErrorCode, fallback: string): string {
  switch (code) {
    case 'clock-skew':
      return 'This computer’s clock is more than five minutes off the hub’s. Set the time automatically, then try again.'
    case 'replayed':
      return 'The hub saw that request twice. Try again.'
    case 'bad-signature':
      return 'The hub did not accept this device’s signature. Sign out and in again.'
    default:
      return fallback
  }
}

/**
 * `method pathFromV1` against `base` (a `hubUrlVerdict` base), JSON in and out.
 * Signed whenever `auth` is given. Resolves to the hub's JSON object; throws
 * `HubRequestError` for everything else, with a sentence the panel may show.
 */
export async function hubRequest(
  deps: HubHttpDeps,
  base: string,
  method: 'GET' | 'POST',
  pathFromV1: string,
  body: unknown,
  auth: HubAuth | null
): Promise<Record<string, unknown>> {
  const text = body === undefined ? '' : JSON.stringify(body)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (text) headers['content-type'] = 'application/json'
  if (auth) {
    Object.assign(
      headers,
      signRequest({ method, pathFromV1, device: auth.device, signPriv: auth.signPriv, token: auth.token, body: text, now: deps.now() })
    )
  }
  let res: Response
  try {
    res = await deps.fetch(hubEndpoint(base, pathFromV1), {
      method,
      headers,
      body: text || undefined,
      signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
      redirect: 'error'
    })
  } catch (err) {
    const why = err instanceof Error ? (err.name === 'TimeoutError' ? 'it did not answer in time' : (err.cause as Error | undefined)?.message ?? err.message) : String(err)
    let host = base
    try {
      host = new URL(base).host
    } catch {
      /* keep the base */
    }
    throw new HubRequestError('offline', `Could not reach the hub at ${host}: ${why}.`, 0)
  }
  const answer = await res.text()
  const read = readHubResponse(res.status, res.headers.get('content-type'), answer)
  if (read.ok) return read.body
  const code = read.error.error
  throw new HubRequestError(code, sentenceFor(code, read.error.message), read.status || HUB_ERROR_STATUS[code], read.error.retryAfterMs)
}
