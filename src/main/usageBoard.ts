/*
 * Every usage source Stoke reads, each on its own schedule, keyed per account.
 *
 * One `UsageScheduler` holds a cache, an attempt time and a backoff PER
 * SOURCE KEY (`<source>:<account>`, shared/usageSources.ts `usageKey`). That
 * isolation is the point: a 429 on one Claude account's endpoint must not
 * pause another's, and one account's last good reading must never be kept in
 * place of another's (`keepLastGood`, gotcha 36; gotcha 45's wrong number).
 * The rules inside each key are exactly the single-account ones the chip had:
 * a poll floor and a smaller message floor, `nextBackoff` after a failure,
 * the last good figures kept through one.
 *
 * `planUsageSources` says what exists: the Default account and every login
 * account of Claude Code, Codex, Kimi Code and Cline, plus the OpenRouter key
 * when there is one. A plan can hold a key (OpenRouter's) or name a file
 * holding a token (Kimi's, Cline's); a plan never leaves main — the renderer gets `UsageReading`s,
 * built by `toReading`, which copy the snapshot and the names only.
 *
 * No electron import: `verify:usage` drives the scheduler and the planner
 * with synthetic clocks, settings and homes (gotcha 74).
 */
import { join } from 'node:path'
import { DEFAULT_ACCOUNT_ID, type AgentAccount } from '../shared/accounts.ts'
import { clineBalanceResponse, clineProvidersPath } from '../shared/clineUsage.ts'
import { kimiCredentialsPath, kimiUsageResponse } from '../shared/kimiUsage.ts'
import { codexUsageSnapshot, lastCodexLimits } from '../shared/codexUsage.ts'
import type { CodingCliId } from '../shared/codingClis.ts'
import { parseOpenRouterKey } from '../shared/openRouterUsage.ts'
import type { ClaudeAuthMode } from '../shared/providers.ts'
import type { UsageReading, UsageReadReason, UsageSnapshot, UsageSourceId } from '../shared/types.ts'
import { openRouterSharers, sharedByText, usageKey, type UsageRouteContext } from '../shared/usageSources.ts'
import { readCodexUsage } from './codexUsage.ts'
import { credentialSources, fakeUsage, fetchUsage, keepLastGood, nextBackoff } from './usage.ts'
import { fetchClineUsage, fetchKimiUsage, fetchOpenRouterUsage } from './usageVendors.ts'

/* ------------------------------------------------------------- schedule */

export interface UsageFloors {
  /** The idle cadence's floor: a cached reading younger than this is returned as is. */
  poll: number
  /** The floor for a read a new message asked for. */
  message: number
}

/**
 * Per source. Anthropic's are the chip's long-standing 30s / 5s (the renderer
 * polls at 30s). Codex is a local file, so cheap, but only moves once a turn.
 * OpenRouter's is documented but changes slowly. Cline's endpoint is
 * undocumented and a balance moves slowly: asked least often.
 */
export const USAGE_FLOORS: Readonly<Record<UsageSourceId, UsageFloors>> = {
  anthropic: { poll: 30_000, message: 5_000 },
  codex: { poll: 10_000, message: 5_000 },
  kimi: { poll: 30_000, message: 10_000 },
  openrouter: { poll: 60_000, message: 30_000 },
  cline: { poll: 120_000, message: 60_000 }
}

interface SourceState {
  cache: UsageSnapshot | null
  /** When the source was last actually ASKED — not `cache.fetchedAt`, which belongs to the data. */
  attemptedAt: number
  /** The wait in force after a failure; 0 after a success. */
  backoff: number
  /** The read in flight, which a second caller shares instead of starting another. */
  inflight: Promise<UsageSnapshot> | null
}

export class UsageScheduler {
  private states = new Map<string, SourceState>()

  private state(key: string): SourceState {
    let s = this.states.get(key)
    if (!s) {
      s = { cache: null, attemptedAt: 0, backoff: 0, inflight: null }
      this.states.set(key, s)
    }
    return s
  }

  /**
   * The source's reading, asking it only when due.
   *
   * The claim — `attemptedAt` and `inflight` — is set before the first await
   * (gotcha 20): two reads arriving together share one request rather than
   * making two.
   */
  read(key: string, reason: UsageReadReason, now: number, fetch: () => Promise<UsageSnapshot>, floors: UsageFloors): Promise<UsageSnapshot> {
    const s = this.state(key)
    if (s.inflight) return s.inflight
    const floor = reason === 'message' ? floors.message : floors.poll
    // The backoff outranks both floors: a message is no reason to knock on a
    // door that has just said no.
    const wait = Math.max(s.backoff, floor)
    if (s.cache && now - s.attemptedAt < wait) return Promise.resolve(s.cache)
    s.attemptedAt = now
    const run = (async (): Promise<UsageSnapshot> => {
      try {
        const fresh = await fetch()
        if (!fresh.error) {
          s.backoff = 0
          s.cache = fresh
          return fresh
        }
        s.backoff = nextBackoff(s.backoff, fresh.retryAfter)
        s.cache = keepLastGood(s.cache, fresh, now + s.backoff)
        return s.cache
      } finally {
        s.inflight = null
      }
    })()
    s.inflight = run
    return run
  }

  /** The cached reading, without asking anything. */
  peek(key: string): UsageSnapshot | null {
    return this.states.get(key)?.cache ?? null
  }

  /** The wait in force for a key, for the suite. */
  backoffOf(key: string): number {
    return this.states.get(key)?.backoff ?? 0
  }

  /** Forget sources that no longer exist (a removed account), so a new one of the same id starts clean. */
  retain(keys: Iterable<string>): void {
    const keep = new Set(keys)
    for (const k of [...this.states.keys()]) if (!keep.has(k)) this.states.delete(k)
  }
}

/* ----------------------------------------------------------------- plans */

/** One source as main reads it. Holds what reading it needs; never sent to the renderer. */
export interface UsageSourcePlan {
  key: string
  source: UsageSourceId
  cli: CodingCliId | null
  accountId: string
  label: string
  detail: string | null
  /** anthropic: the account's config dir, or null for Default. */
  claudeHome?: string | null
  /** Captured credential locations, including inherited secure-store overrides. */
  claudeCredentials?: ReturnType<typeof credentialSources>
  /** codex: the account's CODEX_HOME. */
  codexHome?: string
  /** cline: its providers.json, and the environment its Cline sees. */
  clinePath?: string
  clineEnv?: Record<string, string | undefined>
  /** kimi: its credentials file, and the environment its Kimi Code sees. */
  kimiPath?: string
  kimiEnv?: Record<string, string | undefined>
  /** openrouter: the key. A secret — it stays in main. */
  openrouterKey?: string
}

export interface UsagePlanInput {
  accounts: Record<string, AgentAccount>
  claudeAuth: ClaudeAuthMode
  endpointModes: UsageRouteContext['endpointModes']
  openrouterKey: string
}

/** The Settings fields the plan reads, gathered in one place. */
export function usagePlanInput(settings: {
  accounts: Record<string, AgentAccount>
  providers: { claudeAuth: ClaudeAuthMode; openrouterApiKey: string }
  agents: { endpoints: Partial<Record<CodingCliId, { mode: 'default' | 'openrouter' | 'custom' }>> }
}): UsagePlanInput {
  const endpointModes: UsageRouteContext['endpointModes'] = {}
  for (const [cli, ep] of Object.entries(settings.agents.endpoints) as [CodingCliId, { mode: 'default' | 'openrouter' | 'custom' } | undefined][]) {
    if (ep) endpointModes[cli] = ep.mode
  }
  return {
    accounts: settings.accounts,
    claudeAuth: settings.providers.claudeAuth,
    endpointModes,
    openrouterKey: settings.providers.openrouterApiKey
  }
}

/**
 * Every source this Stoke can read, in the panel's order within each agent:
 * the Default account first, then each login account in the order made.
 *
 * @param env       the environment Stoke inherited (the Default accounts' homes)
 * @param userHome  the user's home folder
 * @param fake      `STOKE_FAKE_USAGE`: `multi` lists the OpenRouter key even
 *                  with none set, so every kind of source can be looked at
 */
export function planUsageSources(
  input: UsagePlanInput,
  env: Record<string, string | undefined>,
  userHome: string,
  fake?: string
): UsageSourcePlan[] {
  const plans: UsageSourcePlan[] = []
  const pickEnv = (source: Record<string, string | undefined>, keys: string[]) =>
    Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
  const kimiEnv = (source: Record<string, string | undefined>) => pickEnv(source, ['KIMI_CODE_OAUTH_HOST', 'KIMI_OAUTH_HOST', 'KIMI_CODE_BASE_URL'])
  const clineEnv = (source: Record<string, string | undefined>) => pickEnv(source, ['CLINE_API_BASE_URL', 'CLINE_ENVIRONMENT_OVERRIDE', 'CLINE_ENVIRONMENT'])
  const login = (cli: CodingCliId): AgentAccount[] =>
    Object.values(input.accounts).filter((a) => a.cli === cli && a.kind === 'login' && a.home)

  plans.push({ key: usageKey('anthropic', DEFAULT_ACCOUNT_ID), source: 'anthropic', cli: 'claude', accountId: DEFAULT_ACCOUNT_ID, label: 'Default', detail: null, claudeHome: null, claudeCredentials: credentialSources(null, env, userHome) })
  for (const a of login('claude')) {
    plans.push({ key: usageKey('anthropic', a.id), source: 'anthropic', cli: 'claude', accountId: a.id, label: a.label, detail: null, claudeHome: a.home, claudeCredentials: credentialSources(a.home, env, userHome) })
  }

  const codexDefault = env.CODEX_HOME?.trim() || join(userHome, '.codex')
  plans.push({ key: usageKey('codex', DEFAULT_ACCOUNT_ID), source: 'codex', cli: 'codex', accountId: DEFAULT_ACCOUNT_ID, label: 'Default', detail: null, codexHome: codexDefault })
  for (const a of login('codex')) {
    plans.push({ key: usageKey('codex', a.id), source: 'codex', cli: 'codex', accountId: a.id, label: a.label, detail: null, codexHome: a.home })
  }

  plans.push({
    key: usageKey('kimi', DEFAULT_ACCOUNT_ID),
    source: 'kimi',
    cli: 'kimi',
    accountId: DEFAULT_ACCOUNT_ID,
    label: 'Default',
    detail: null,
    kimiPath: kimiCredentialsPath(env, userHome, join),
    kimiEnv: kimiEnv(env)
  })
  for (const a of login('kimi')) {
    const accountEnv = { ...env, KIMI_CODE_HOME: a.home }
    plans.push({
      key: usageKey('kimi', a.id),
      source: 'kimi',
      cli: 'kimi',
      accountId: a.id,
      label: a.label,
      detail: null,
      kimiPath: kimiCredentialsPath(accountEnv, userHome, join),
      kimiEnv: kimiEnv(accountEnv)
    })
  }

  plans.push({
    key: usageKey('cline', DEFAULT_ACCOUNT_ID),
    source: 'cline',
    cli: 'cline',
    accountId: DEFAULT_ACCOUNT_ID,
    label: 'Default',
    detail: null,
    clinePath: clineProvidersPath(env, userHome, join),
    clineEnv: clineEnv(env)
  })
  for (const a of login('cline')) {
    // What that account's Cline sees: Stoke's environment plus its CLINE_DIR
    // (`accountEnv`), so an inherited CLINE_DATA_DIR still wins, as it would there.
    const accountEnv = { ...env, CLINE_DIR: a.home }
    plans.push({
      key: usageKey('cline', a.id),
      source: 'cline',
      cli: 'cline',
      accountId: a.id,
      label: a.label,
      detail: null,
      clinePath: clineProvidersPath(accountEnv, userHome, join),
      clineEnv: clineEnv(accountEnv)
    })
  }

  if (input.openrouterKey || fake === 'multi') {
    const n = openRouterSharers(input).length
    plans.push({
      key: usageKey('openrouter', ''),
      source: 'openrouter',
      cli: null,
      accountId: 'key',
      label: 'OpenRouter key',
      detail: sharedByText(n),
      openrouterKey: input.openrouterKey
    })
  }
  return plans
}

/** Read one source now. No scheduling here — that is `UsageScheduler`'s. */
export async function readUsageSource(plan: UsageSourcePlan, now: number, fake?: string): Promise<UsageSnapshot> {
  if (fake) return fakeSnapshot(plan, now, fake)
  switch (plan.source) {
    case 'anthropic':
      return fetchUsage(now, plan.claudeHome ?? null, plan.accountId, plan.claudeCredentials)
    case 'codex':
      return { ...(await readCodexUsage(plan.codexHome ?? '', now)), accountId: plan.accountId }
    case 'kimi':
      return { ...(await fetchKimiUsage(plan.kimiPath ?? '', plan.kimiEnv ?? {}, now)), accountId: plan.accountId }
    case 'cline':
      return { ...(await fetchClineUsage(plan.clinePath ?? '', plan.clineEnv ?? {}, now)), accountId: plan.accountId }
    case 'openrouter':
      return { ...(await fetchOpenRouterUsage(plan.openrouterKey ?? '', now)), accountId: 'key' }
  }
}

/** What the renderer may see of a plan and its reading: names and figures, no key, no path. */
export function toReading(plan: UsageSourcePlan, snapshot: UsageSnapshot): UsageReading {
  return { key: plan.key, source: plan.source, cli: plan.cli, accountId: plan.accountId, label: plan.label, detail: plan.detail, snapshot }
}

/* ------------------------------------------------------------- fixtures */

/**
 * `STOKE_FAKE_USAGE`: fixtures, with no file, Keychain or network touched.
 *
 * Any value fakes Claude Code's accounts (the Default one exactly as before;
 * each other account with figures of its own, `fakeUsage`). `multi` fakes
 * every source — each Codex home through the REAL rollout parser, the
 * OpenRouter key through the real body parser, Cline's balance in its real
 * micro-dollar unit — so a driven run can put the chip on a Claude tab and a
 * Codex tab of different accounts and see it follow.
 */
export function fakeSnapshot(plan: UsageSourcePlan, now: number, mode: string): UsageSnapshot {
  if (plan.source === 'anthropic') return fakeUsage(now, plan.accountId)
  const none: UsageSnapshot = { source: plan.source, accountId: plan.accountId, windows: [], extraCredits: null, fetchedAt: now, error: null }
  if (mode !== 'multi') return none
  if (plan.source === 'codex') {
    const turnAt = now - 4 * 60_000
    const other = plan.accountId !== DEFAULT_ACCOUNT_ID
    const line = JSON.stringify({
      timestamp: new Date(turnAt).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: other ? 71.00000000000001 : 22.0, window_minutes: 300, resets_at: Math.round((now + 150 * 60_000) / 1000) },
          secondary: { used_percent: other ? 35.0 : 8.0, window_minutes: 10080, resets_at: Math.round((now + 4 * 86_400_000) / 1000) },
          credits: other ? { has_credits: true, unlimited: false, balance: '240' } : { has_credits: false, unlimited: false, balance: null },
          plan_type: other ? 'pro' : 'team'
        }
      }
    })
    return { ...codexUsageSnapshot(lastCodexLimits(line), now, null), accountId: plan.accountId }
  }
  if (plan.source === 'openrouter') {
    return {
      ...parseOpenRouterKey(
        {
          data: {
            limit: 20,
            limit_remaining: 13.5,
            limit_reset: 'monthly',
            usage: 41.2,
            usage_daily: 0.84,
            usage_weekly: 3.1,
            usage_monthly: 6.5,
            is_free_tier: false,
            free_model_daily_requests: { used: 12, limit: 1000, remaining: 988 }
          }
        },
        now
      ),
      accountId: 'key'
    }
  }
  if (plan.source === 'kimi') {
    const day = (h: number): string => new Date(now + h * 3_600_000).toISOString()
    return {
      ...kimiUsageResponse(200, { usages: { limit_5h: { used_ratio: 0.18, reset_time: day(3) }, limit_7d: { used_ratio: '0.42', reset_time: day(90) } } }, now),
      accountId: plan.accountId
    }
  }
  // Cline: 12_340_000 micro-dollars, which its CLI prints as $12.34.
  const balance = plan.accountId === DEFAULT_ACCOUNT_ID ? 12_340_000 : 3_500_000
  return { ...clineBalanceResponse(200, { success: true, data: { balance, userId: 'usr-fixture' } }, now), accountId: plan.accountId }
}
