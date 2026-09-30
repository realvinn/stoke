/*
 * Codex's plan limits, from its own rollout file.
 *
 * Codex writes every session to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`,
 * and after each turn appends an `event_msg` whose payload is `token_count`.
 * From Codex 0.15x that payload carries `rate_limits` — the same snapshot its
 * own `/status` draws (codex-rs/tui/src/status/rate_limits.rs). Read on this
 * machine, 2026-09-30, from a real rollout:
 *
 *   {"timestamp":"2026-09-28T06:07:36.795Z","type":"event_msg","payload":{
 *     "type":"token_count","info":{…},
 *     "rate_limits":{"limit_id":"codex","limit_name":null,
 *       "primary":{"used_percent":0.0,"window_minutes":300,"resets_at":1790593487},
 *       "secondary":{"used_percent":4.0,"window_minutes":10080,"resets_at":1791008940},
 *       "credits":{"has_credits":false,"unlimited":false,"balance":null},
 *       "individual_limit":null,"spend_control_reached":null,
 *       "plan_type":"team","rate_limit_reached_type":null}}}
 *
 * So there is no account endpoint to poll and nothing to sign in to: the
 * reading is the agent's own record of its LAST TURN, "as of the last Codex
 * turn", stale the moment nobody is using it (`usageView.isStale`). Three
 * traps, each a wrong number if missed:
 *
 *   - `resets_at` is epoch SECONDS, like Claude's payload and unlike every
 *     other timestamp in Stoke. `codexResetMs` is the one place that converts
 *     it (gotcha 21's rule, for a second agent).
 *   - A window whose reset has PASSED since that turn has been emptied by
 *     Codex's side. Its old percent is no longer true and the new one is not
 *     known, so it is dropped with a note — never drawn at the old figure, and
 *     never guessed as 0% (another client on the same plan may have spent it).
 *   - The newest rollout may hold no `token_count` at all: a session opened
 *     and left, or one whose first turn has not finished. The reader walks
 *     back to the newest rollout that does (main/codexUsage.ts).
 *
 * Pure, compiled by both tsconfigs: no `node:` import (gotcha 27); suites
 * load it under strip-types, so shared imports are relative with `.ts` (78).
 */
import type { UsageBalance, UsageSnapshot, UsageWindow } from './types'

/** One window as a turn stated it. `percent` null is unknown, never 0. */
export interface CodexWindowReading {
  /** 0-100, rounded (the file carries float noise like 4.000000000000001). */
  percent: number | null
  /** The window's length in minutes, as stated, or null. */
  minutes: number | null
  /** Epoch ms, converted once by `codexResetMs`. */
  resetsAt: number | null
}

export interface CodexLimits {
  primary: CodexWindowReading | null
  secondary: CodexWindowReading | null
  /** `plan_type` as Codex states it ("plus", "pro", "team"), or null. */
  planType: string | null
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  /** Epoch ms of the line that stated them (its `timestamp`), or null. */
  at: number | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * The ONE place a Codex reset becomes epoch ms. `resets_at` is epoch seconds;
 * an older Codex stated `resets_in_seconds` instead, relative to the turn, so
 * that is honoured too when the turn's own time is known. Anything else is
 * unknown.
 */
export function codexResetMs(raw: Record<string, unknown>, turnAt: number | null): number | null {
  const at = finite(raw.resets_at)
  if (at !== null && at > 0) return Math.round(at * 1000)
  const inSeconds = finite(raw.resets_in_seconds)
  if (inSeconds !== null && inSeconds >= 0 && turnAt !== null) return turnAt + Math.round(inSeconds * 1000)
  return null
}

function windowFrom(raw: unknown, turnAt: number | null): CodexWindowReading | null {
  if (!isRecord(raw)) return null
  const used = finite(raw.used_percent)
  const minutes = finite(raw.window_minutes)
  return {
    percent: used === null ? null : Math.round(Math.max(0, Math.min(100, used))),
    minutes: minutes !== null && minutes > 0 ? Math.round(minutes) : null,
    resetsAt: codexResetMs(raw, turnAt)
  }
}

/** A plan name fit to print: letters, digits, spaces, dashes and underscores, short. */
function planName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.length <= 40 && /^[A-Za-z0-9 _-]+$/.test(s) ? s : null
}

/** One rollout line's limits, or null when it is not a `token_count` stating any. */
export function limitsFromLine(line: string): { limits: CodexLimits; limitId: string | null } | null {
  // Cheap test first: a rollout line can be a megabyte of tool output.
  if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.type !== 'event_msg' || !isRecord(parsed.payload)) return null
  const payload = parsed.payload
  if (payload.type !== 'token_count' || !isRecord(payload.rate_limits)) return null
  const rl = payload.rate_limits
  const stamp = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN
  const at = Number.isNaN(stamp) ? null : stamp
  const primary = windowFrom(rl.primary, at)
  const secondary = windowFrom(rl.secondary, at)
  const c = rl.credits
  const credits = isRecord(c)
    ? {
        hasCredits: c.has_credits === true,
        unlimited: c.unlimited === true,
        balance: typeof c.balance === 'string' ? c.balance : typeof c.balance === 'number' ? String(c.balance) : null
      }
    : null
  if (!primary && !secondary && !credits) return null
  return {
    limits: { primary, secondary, planType: planName(rl.plan_type), credits, at },
    limitId: typeof rl.limit_id === 'string' ? rl.limit_id : null
  }
}

/**
 * The newest limits a rollout's text states, reading from its end.
 *
 * Codex can report more than one bucket (`limit_id`): the plan's own,
 * `codex`, and model-specific ones its status puts after it. The plan's is
 * what "Codex usage" means, so the newest `codex` (or unnamed) bucket wins,
 * and another bucket answers only when no line states the plan's.
 *
 * `text` may begin mid-line (a tail read): a line that does not parse is
 * skipped, never an error.
 */
export function lastCodexLimits(text: string): CodexLimits | null {
  const lines = text.split('\n')
  let other: CodexLimits | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = limitsFromLine(lines[i])
    if (!found) continue
    if (found.limitId === null || found.limitId === 'codex') return found.limits
    other ??= found.limits
  }
  return other
}

/**
 * A window's name. 300 and 10080 minutes are the two Codex states today and
 * the two the chip draws as rows; anything else is named by its length.
 */
export function codexWindowLabel(minutes: number | null, secondary: boolean): { kind: UsageWindow['kind']; label: string; short: string } {
  if (minutes === 300) return { kind: 'session', label: '5 hours', short: '5h' }
  if (minutes === 10080) return { kind: 'weekly', label: 'Weekly', short: 'week' }
  if (minutes === null) return { kind: 'other', label: secondary ? 'Second limit' : 'Limit', short: secondary ? 'lim 2' : 'limit' }
  if (minutes % 1440 === 0) {
    const d = minutes / 1440
    return { kind: 'other', label: d === 1 ? 'Daily' : `${d} days`, short: `${d}d` }
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60
    return { kind: 'other', label: `${h} hour${h === 1 ? '' : 's'}`, short: `${h}h` }
  }
  return { kind: 'other', label: `${minutes} min`, short: `${minutes}m` }
}

function elapsedOf(resetsAt: number | null, minutes: number | null, now: number): number | null {
  if (resetsAt === null || minutes === null) return null
  const len = minutes * 60_000
  return Math.max(0, Math.min(1, (now - (resetsAt - len)) / len))
}

/**
 * Codex's credits row, as its own status draws it (`credit_status_row`):
 * "Unlimited" when unlimited; nothing when it has no credits; the balance
 * rounded to whole credits when it is a positive number, else "Available".
 * Credits are Codex's own unit and are never shown as dollars.
 */
export function codexCredits(c: CodexLimits['credits']): UsageBalance | null {
  if (!c) return null
  if (c.unlimited) return { label: 'Credits', amount: null, unit: 'credits', text: 'unlimited' }
  if (!c.hasCredits) return null
  const n = c.balance === null ? NaN : Number(c.balance.trim())
  if (c.balance !== null && c.balance.trim() !== '' && Number.isFinite(n) && n > 0) {
    return { label: 'Credits', amount: Math.round(n), unit: 'credits' }
  }
  return { label: 'Credits', amount: null, unit: 'credits', text: 'available' }
}

/**
 * What the chip and panel draw for one Codex home.
 *
 * @param limits  the newest limits found, or null when no rollout states any
 * @param now     the clock the windows are judged against
 * @param fileAt  the rollout's mtime, when the line carries no timestamp
 */
export function codexUsageSnapshot(limits: CodexLimits | null, now: number, fileAt: number | null): UsageSnapshot {
  const base = { source: 'codex' as const, asOfLastTurn: true, extraCredits: null, error: null }
  if (!limits) {
    return {
      ...base,
      windows: [],
      fetchedAt: fileAt ?? now,
      note: 'No Codex turn has stated its limits yet. They appear after the next one.'
    }
  }
  const windows: UsageWindow[] = []
  const reset: string[] = []
  for (const [reading, secondary] of [[limits.primary, false], [limits.secondary, true]] as const) {
    if (!reading) continue
    const name = codexWindowLabel(reading.minutes, secondary)
    if (reading.resetsAt !== null && reading.resetsAt <= now) {
      // Emptied on Codex's side since that turn: the old figure is no longer
      // true and the new one is not known here. Said, not drawn.
      reset.push(name.label)
      continue
    }
    if (reading.percent === null) continue
    windows.push({
      kind: name.kind,
      label: name.label,
      short: name.short,
      percent: reading.percent,
      // Codex states no severity; `tone` still colours by pace and the 90% ceiling.
      severity: 'normal',
      resetsAt: reading.resetsAt,
      elapsed: elapsedOf(reading.resetsAt, reading.minutes, now),
      active: true
    })
  }
  const credits = codexCredits(limits.credits)
  return {
    ...base,
    windows,
    fetchedAt: limits.at ?? fileAt ?? now,
    plan: limits.planType,
    ...(credits ? { balances: [credits] } : {}),
    note: reset.length
      ? `${reset.join(' and ')} ${reset.length === 1 ? 'has' : 'have'} reset since the last Codex turn; the next turn states ${reset.length === 1 ? 'it' : 'them'} again.`
      : null
  }
}
