/*
 * Which usage reading answers for which tab, and how a Claude reading is
 * put together without ever crossing accounts.
 *
 * Every source is keyed by ACCOUNT (shared/accounts.ts), because every figure
 * here is an account's: two Claude sign-ins have two sets of plan limits, two
 * Codex homes two rollout histories, and the one OpenRouter key is one
 * reading however many agents share it. A reading drawn under the wrong
 * account is gotcha 45's wrong number, which is worse than a blank.
 *
 *   anthropic  Claude Code, per login account: its account endpoint (usage.ts,
 *              the token in that account's own `.credentials.json` or Keychain
 *              item) merged with the statusLine payloads of that account's own
 *              sessions — and only those.
 *   codex      Codex, per login account: the newest rollout in that account's
 *              CODEX_HOME (codexUsage.ts).
 *   kimi       Kimi Code, per login account: its own `/usages`, with the token
 *              in that account's KIMI_CODE_HOME (kimiUsage.ts).
 *   cline      Cline, per login account: the balance of the Cline account its
 *              providers.json is signed in to (clineUsage.ts).
 *   openrouter Any agent pointed at OpenRouter, and Claude Code's Default
 *              account when Settings › Providers routes it there: the one key.
 *
 * Everything else is `null`: no source Stoke can honestly read, so nothing is
 * drawn for it (codingClis.ts `CLI_CAPS.usage` names why per agent).
 *
 * Pure; compiled by both tsconfigs, no `node:` import (gotcha 27); suites load
 * it under strip-types, so shared imports are relative with `.ts` (gotcha 78).
 */
import { DEFAULT_ACCOUNT_ID, type AgentAccount } from './accounts.ts'
import { CLI_CAPS, cliFor, CODING_CLIS, type CodingCliId } from './codingClis.ts'
import type { ClaudeAuthMode } from './providers.ts'
import { mergeUsageWindows, statusLineWindows } from './statusLine.ts'
import type { StatusLineSnapshot, UsageBoard, UsageReading, UsageSnapshot, UsageSourceId, UsageTarget, UsageWindow } from './types'

/** The account id of the OpenRouter key's reading: there is one key, not one per agent. */
export const OPENROUTER_ACCOUNT = 'key'

/** The Claude Default account's key — what the chip falls back to with nothing to follow. */
export const CLAUDE_DEFAULT_KEY = 'anthropic:default'

export function usageTargetKey(target: UsageTarget | null): string {
  return target ? `${target.cli}:${target.accountId || DEFAULT_ACCOUNT_ID}${target.ptyId ? `:${target.ptyId}` : ''}` : ''
}

/** A late reading cannot answer for a new tab, even if its figures are valid. */
export function usageChipKey(board: UsageBoard | null, target: UsageTarget | null): string | null {
  if (!board) return target ? null : CLAUDE_DEFAULT_KEY
  if (usageTargetKey(board.target ?? null) !== usageTargetKey(target)) return null
  return board.activeKey
}

/** Late replies may update other readings, while retaining the selected configuration's figures. */
export function mergeUsageBoard(previous: UsageBoard | null, next: UsageBoard, ownsSelection: boolean): UsageBoard {
  if (!previous || ownsSelection) return next
  let readings = next.readings
  const active = previous.readings.find(reading => reading.key === previous.activeKey)
  if (active) {
    const at = readings.findIndex(reading => reading.key === active.key)
    if (at < 0) readings = [...readings, active]
    else if (readings[at].snapshot.fetchedAt < active.snapshot.fetchedAt) readings = readings.map((reading, index) => index === at ? active : reading)
  }
  return { readings, activeKey: previous.activeKey, target: previous.target }
}

export function usageKey(source: UsageSourceId, accountId: string): string {
  return `${source}:${source === 'openrouter' ? OPENROUTER_ACCOUNT : accountId || DEFAULT_ACCOUNT_ID}`
}

/** Two account ids name the same account. Absent and '' are the Default account. */
export function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || DEFAULT_ACCOUNT_ID) === (b || DEFAULT_ACCOUNT_ID)
}

export interface UsageRouteContext {
  accounts: Record<string, AgentAccount>
  /** Settings › Providers' auth for Claude Code's Default account. */
  claudeAuth: ClaudeAuthMode
  /** Settings › Agents' endpoint per agent; absent is its own sign-in. */
  endpointModes: Partial<Record<CodingCliId, 'default' | 'openrouter' | 'custom'>>
}

export interface UsageRoute {
  source: UsageSourceId
  accountId: string
}

/**
 * The reading a tab of `target.cli` on `target.accountId` spends, or null
 * when nothing Stoke can read describes it.
 *
 * An account id that is not one of this agent's accounts answers null rather
 * than the Default account's figures: a tab whose account was removed is not
 * spending the Default plan.
 */
export function usageRouteFor(target: UsageTarget, ctx: UsageRouteContext): UsageRoute | null {
  const accountId = target.accountId || DEFAULT_ACCOUNT_ID
  const account = accountId === DEFAULT_ACCOUNT_ID ? null : ctx.accounts[accountId]
  if (accountId !== DEFAULT_ACCOUNT_ID && (!account || account.cli !== target.cli)) return null
  // A key account spends an API key whose usage no source here can read.
  if (account && account.kind !== 'login') return null

  if (target.cli === 'claude') {
    // Providers' keys reach the Default account only (pty.ts): another
    // account is always its own sign-in.
    if (!account && ctx.claudeAuth === 'openrouter') return { source: 'openrouter', accountId: OPENROUTER_ACCOUNT }
    if (!account && ctx.claudeAuth !== 'default') return null
    return { source: 'anthropic', accountId }
  }
  const mode = ctx.endpointModes[target.cli] ?? 'default'
  if (mode === 'openrouter' && cliFor(target.cli).endpoints.openrouter) return { source: 'openrouter', accountId: OPENROUTER_ACCOUNT }
  if (mode !== 'default') return null
  const caps = CLI_CAPS[target.cli].usage
  if (caps === 'codex') return { source: 'codex', accountId }
  if (caps === 'kimi') return { source: 'kimi', accountId }
  if (caps === 'cline') return { source: 'cline', accountId }
  return null
}

/** The agents that spend the OpenRouter key right now: "shared by N agents". */
export function openRouterSharers(ctx: Pick<UsageRouteContext, 'claudeAuth' | 'endpointModes'>): CodingCliId[] {
  const out: CodingCliId[] = []
  if (ctx.claudeAuth === 'openrouter') out.push('claude')
  for (const cli of CODING_CLIS) {
    if (cli.id === 'claude') continue
    if (ctx.endpointModes[cli.id] === 'openrouter' && cli.endpoints.openrouter) out.push(cli.id)
  }
  return out
}

export function sharedByText(n: number): string {
  return n === 0 ? 'no agent is pointed at it' : `shared by ${n} agent${n === 1 ? '' : 's'}`
}

/**
 * One Claude account's windows: its account endpoint's reading merged with its
 * own sessions' payload (`mergeUsageWindows`), and nothing of any other
 * account's. A payload or a snapshot from another account is ignored, not
 * merged — in either direction — so the answer for account A is the same
 * whether account B's figures arrived first, last or not at all.
 */
export function claudeWindowsFor(
  accountId: string,
  line: StatusLineSnapshot | null | undefined,
  snap: UsageSnapshot | null | undefined,
  now: number
): { windows: UsageWindow[]; payloadAt: number; accountAt: number } {
  const ownLine = line && sameAccount(line.accountId, accountId) && (line.quotaSource === undefined || line.quotaSource === 'anthropic') ? line : null
  const ownSnap = snap && sameAccount(snap.accountId, accountId) && (snap.source ?? 'anthropic') === 'anthropic' ? snap : null
  const fromLine = ownLine ? statusLineWindows(ownLine, now) : []
  const fromAccount = ownSnap ? ownSnap.windows : []
  // -Infinity for a source with nothing to say: it loses every comparison.
  const payloadAt = fromLine.length > 0 && ownLine ? ownLine.receivedAt : -Infinity
  const accountAt = fromAccount.length > 0 && ownSnap ? ownSnap.fetchedAt : -Infinity
  return { windows: mergeUsageWindows(fromLine, fromAccount, payloadAt, accountAt), payloadAt, accountAt }
}

/**
 * The chip's rows: the two windows that run out (5 hours, weekly) when the
 * source has them, else its first two — OpenRouter's key limit and free day.
 */
export function chipRows(windows: UsageWindow[]): UsageWindow[] {
  const session = windows.find((w) => w.kind === 'session')
  const weekly = windows.find((w) => w.kind === 'weekly')
  const pair = [session, weekly].filter((w): w is UsageWindow => w !== undefined)
  return pair.length ? pair : windows.slice(0, 2)
}

/** The panel's groups, in a fixed order: agents first, the shared key last. */
export const USAGE_GROUP_ORDER: readonly UsageSourceId[] = ['anthropic', 'codex', 'kimi', 'cline', 'openrouter']

/** A group's heading. */
export function usageGroupTitle(source: UsageSourceId): string {
  if (source === 'anthropic') return cliFor('claude').label
  if (source === 'codex') return cliFor('codex').label
  if (source === 'kimi') return cliFor('kimi').label
  if (source === 'cline') return cliFor('cline').label
  return 'OpenRouter'
}

/** Whether a reading has anything to draw: a window or a balance. An error alone is not a reading. */
export function hasFigures(snap: UsageSnapshot | null | undefined, extraWindows = 0): boolean {
  if (!snap) return extraWindows > 0
  return snap.windows.length + extraWindows > 0 || (snap.balances?.length ?? 0) > 0
}

/**
 * The readings the panel lists, grouped, hiding every source with no reading.
 * The tab in front is listed even with none, so its error or note is not lost.
 */
export function panelGroups(
  readings: UsageReading[],
  activeKey: string | null,
  claudeExtra: (r: UsageReading) => number = () => 0
): { source: UsageSourceId; title: string; readings: UsageReading[] }[] {
  const out: { source: UsageSourceId; title: string; readings: UsageReading[] }[] = []
  for (const source of USAGE_GROUP_ORDER) {
    const shown = readings.filter(
      (r) => r.source === source && (r.key === activeKey || hasFigures(r.snapshot, source === 'anthropic' ? claudeExtra(r) : 0))
    )
    if (shown.length) out.push({ source, title: usageGroupTitle(source), readings: shown })
  }
  return out
}
