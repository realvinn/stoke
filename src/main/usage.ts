import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { UsageSnapshot, UsageWindow } from '../shared/types'

export type { UsageSnapshot, UsageWindow }

/**
 * Plan limits: the 5-hour rolling window, the weekly window, and any
 * model-scoped weekly window (Fable has its own).
 *
 * There is no supported programmatic source for this. `/usage` is a slash
 * command with no headless equivalent, nothing under `~/.claude` records the
 * windows — `stats-cache.json` is daily token counts and `usage-data/` is
 * session telemetry — and the transcripts carry per-turn token usage but no
 * limit state at all. Every community monitor does what this does: read the
 * OAuth token Claude Code already stores and call the endpoint the CLI itself
 * calls. Verified against the live account before it was written.
 *
 * Being undocumented, the shape can change without warning. Everything here
 * tolerates missing fields and reports unavailability rather than guessing —
 * a wrong number in a status bar is worse than a blank one.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** Window lengths, used to place the pace marker. `resets_at` gives only the end. */
const WINDOW_MS: Record<UsageWindow['kind'], number> = {
  session: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  weekly_scoped: 7 * 24 * 60 * 60 * 1000
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function stamp(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

const execFileAsync = promisify(execFile)

/**
 * The connected MCP servers' own OAuth records, which sit beside the account's.
 *
 * This is the trap that makes a first-match-wins scan wrong. The credential
 * blob is not just the account: `mcpOAuth` holds one record per connected MCP
 * server, each with an `accessToken` field of its own, and several of them are
 * non-empty (a Figma `figu_…` on this machine). Those keys satisfy the lenient
 * search below and are enumerated *before* `claudeAiOauth`, so a scan that took
 * the first access-token-shaped key handed back a connector's token — which the
 * usage endpoint answers 401 to, a failure indistinguishable from being signed
 * out. Hence two passes, prefix first, and this subtree skipped in the second.
 */
const CONNECTOR_KEY = 'mcpOAuth'

/** `sk-ant-oat` is the OAuth prefix, so a value carrying it is unambiguous. */
function findPrefixedToken(node: unknown, depth = 0): string | null {
  if (!node || depth > 5) return null
  if (typeof node === 'string') return node.startsWith('sk-ant-oat') ? node : null
  if (typeof node !== 'object') return null
  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = findPrefixedToken(value, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * The lenient pass: the token has moved between shapes across Claude Code
 * versions, so a key that merely looks like an access token still counts. Only
 * reached when nothing carried the prefix at all.
 */
function findAccessToken(node: unknown, depth = 0): string | null {
  if (!node || depth > 5 || typeof node !== 'object') return null
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === CONNECTOR_KEY) continue
    if (typeof value === 'string' && /access.?token/i.test(key) && value) return value
    const found = findAccessToken(value, depth + 1)
    if (found) return found
  }
  return null
}

/** Exported for `verify:usage`, which pins the connector-token trap above. */
export function findToken(node: unknown): string | null {
  return findPrefixedToken(node) ?? findAccessToken(node)
}

export interface StoredCredentials {
  token: string
  /**
   * Epoch ms at which the token stops being accepted, or null when the store
   * does not say. Only Claude Code can refresh it — Stoke reads, never writes,
   * because rotating the token would invalidate the copy the CLI is holding.
   */
  expiresAt: number | null
  source: 'file' | 'keychain'
}

function credentialsFrom(raw: string, source: StoredCredentials['source']): StoredCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const token = findToken(parsed)
  if (!token) return null
  const account = (parsed as { claudeAiOauth?: { expiresAt?: unknown } } | null)?.claudeAiOauth
  const at = account?.expiresAt
  return {
    token,
    expiresAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null,
    source
  }
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * macOS keeps the token in the login Keychain, not in a file.
 *
 * This is why the chip used to need a live session here: `fetchUsage` found no
 * `.credentials.json`, reported "Not signed in", and the statusLine payload —
 * which only exists while `claude` is running — was the only plan-limit source
 * left (CLAUDE.md gotcha 21). Reading the Keychain instead makes the account
 * route work with nothing running at all.
 *
 * Bounded by a timeout because `security` blocks on a GUI Keychain prompt when
 * the item's ACL does not already trust it. A prompt is the normal first-run
 * experience on a machine where nothing has read this item, and a status chip
 * is not worth hanging a main-process handler for; an unanswered prompt simply
 * reports unavailable, exactly like every other failure here.
 */
async function readKeychain(): Promise<StoredCredentials | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      // The blob carries every connected MCP server's record too - 22 KB on
      // this machine - so the 1 MB default is raised well clear of it.
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }
    )
    return credentialsFrom(stdout, 'keychain')
  } catch {
    return null
  }
}

/**
 * The token and what is known about it, from whichever store holds it.
 *
 * File first: it is the Linux and Windows location, it costs one read, and a
 * Mac that does have the file is answered without ever touching the Keychain.
 */
export async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    const found = credentialsFrom(raw, 'file')
    if (found) return found
  } catch {
    // No file is the ordinary case on macOS, not an error worth reporting.
  }
  return platform() === 'darwin' ? readKeychain() : null
}

export async function readOauthToken(): Promise<string | null> {
  return (await readCredentials())?.token ?? null
}

function elapsedFraction(resetsAt: number | null, windowMs: number, now: number): number | null {
  if (resetsAt === null) return null
  const startedAt = resetsAt - windowMs
  const through = (now - startedAt) / windowMs
  return Math.max(0, Math.min(1, through))
}

interface RawLimit {
  kind?: unknown
  group?: unknown
  percent?: unknown
  severity?: unknown
  resets_at?: unknown
  is_active?: unknown
  scope?: { model?: { display_name?: unknown } | null } | null
}

export function parseUsage(body: unknown, now: number): UsageSnapshot {
  const root = (body ?? {}) as Record<string, unknown>
  const windows: UsageWindow[] = []

  /*
   * Prefer the `limits` array: it is the only place the model-scoped weekly
   * window appears, and it carries severity. The top-level `five_hour` and
   * `seven_day` objects are a summary of the same numbers.
   */
  const limits = Array.isArray(root.limits) ? (root.limits as RawLimit[]) : []

  for (const limit of limits) {
    const rawKind = String(limit.kind ?? '')
    const kind: UsageWindow['kind'] =
      rawKind === 'session' ? 'session' : rawKind === 'weekly_scoped' ? 'weekly_scoped' : 'weekly'

    const model = limit.scope?.model?.display_name
    const label =
      kind === 'session' ? '5 hours' : kind === 'weekly_scoped' ? String(model ?? 'Scoped') : 'Weekly'

    // A scoped window with no reset time has never been used; it still belongs
    // on screen, just without a countdown.
    const resetsAt = stamp(limit.resets_at)

    windows.push({
      kind,
      label,
      // Rounded at the edge, as statusLineWindows already does for the
      // payload: gotcha 21's 7.000000000000001 is a real value one side sent,
      // and the chip prints whatever it is handed.
      percent: Math.round(Math.max(0, Math.min(100, num(limit.percent)))),
      severity: String(limit.severity ?? 'normal'),
      resetsAt,
      elapsed: elapsedFraction(resetsAt, WINDOW_MS[kind], now),
      active: limit.is_active === true
    })
  }

  const extra = (root.extra_usage ?? null) as { is_enabled?: unknown; utilization?: unknown } | null

  return {
    windows,
    extraCredits: extra
      ? { percent: num(extra.utilization), enabled: extra.is_enabled === true }
      : null,
    fetchedAt: now,
    error: null
  }
}

/*
 * A fixture, for when the real numbers cannot be had.
 *
 * The endpoint rate-limits, and when it does the meter correctly renders
 * nothing — which makes the meter itself impossible to look at. Stubbing from
 * the page does not work either: contextBridge freezes `window.stoke`, so
 * assigning over the IPC method silently does nothing and every assertion fails
 * for a reason that has nothing to do with the component.
 *
 * Off unless STOKE_FAKE_USAGE is set, so it can never reach a real window by
 * accident. The two windows straddle the pace marker deliberately: one under,
 * one over, so both styles are exercised.
 */
function fakeUsage(now: number): UsageSnapshot {
  return {
    windows: [
      { kind: 'session', label: '5 hours', percent: 9, severity: 'normal', resetsAt: now + 84 * 60_000, elapsed: 0.72, active: true },
      { kind: 'weekly', label: 'Weekly', percent: 64, severity: 'normal', resetsAt: now + 3 * 86_400_000, elapsed: 0.41, active: true },
      { kind: 'weekly_scoped', label: 'Fable', percent: 0, severity: 'normal', resetsAt: null, elapsed: null, active: false }
    ],
    extraCredits: null,
    fetchedAt: now,
    error: null
  }
}

export async function fetchUsage(now = Date.now()): Promise<UsageSnapshot> {
  if (process.env.STOKE_FAKE_USAGE) return fakeUsage(now)

  const empty = (error: string): UsageSnapshot => ({
    windows: [],
    extraCredits: null,
    fetchedAt: now,
    error
  })

  const creds = await readCredentials()
  if (!creds) return empty('Not signed in to Claude Code.')
  /*
   * Stated before the call rather than discovered as a 401, because the two
   * are different problems: an expired token is not "signed out", and only a
   * Claude Code session can refresh it.
   */
  if (creds.expiresAt !== null && creds.expiresAt <= now) {
    return empty('Claude Code sign-in has expired \u2014 start a session to refresh it.')
  }
  const token = creds.token

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) {
      /*
       * 429 is the endpoint asking to be left alone, and it does happen - it
       * arrived during development after a run of repeated calls. Honour
       * Retry-After when it is sent, and otherwise back off far longer than the
       * normal poll, because continuing to knock on an undocumented endpoint
       * that has just said no is how access gets worse rather than better.
       */
      // A bare "Usage unavailable (401)" names the one failure a reader could
      // actually act on, and names it as a number.
      if (res.status === 401 || res.status === 403) {
        return empty('Claude Code sign-in was refused \u2014 start a session to refresh it.')
      }
      const snapshot = empty(`Usage unavailable (${res.status}).`)
      if (res.status === 429 || res.status >= 500) {
        const header = Number(res.headers.get('retry-after'))
        snapshot.retryAfter = Number.isFinite(header) && header > 0 ? header * 1000 : 15 * 60_000
      }
      return snapshot
    }
    return parseUsage(await res.json(), now)
  } catch (err) {
    return empty(err instanceof Error ? err.message : 'Usage request failed.')
  }
}
