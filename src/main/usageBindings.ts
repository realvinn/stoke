import { createHash } from 'node:crypto'
import type { UsageSnapshot, UsageTarget } from '../shared/types.ts'
import { usageKey, usageRouteFor, usageTargetKey } from '../shared/usageSources.ts'
import { planUsageSources, toReading, type UsagePlanInput, type UsageSourcePlan } from './usageBoard.ts'
import { accountEnv } from '../shared/accounts.ts'

/** Cache identity includes private read configuration, never the display name. */
export function usageCacheKey(plan: UsageSourcePlan): string {
  const sorted = (env: Record<string, string | undefined> | undefined) => env ? Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) : undefined
  const identity = { source: plan.source, claudeHome: plan.claudeHome, claudeCredentials: plan.claudeCredentials, codexHome: plan.codexHome, clinePath: plan.clinePath, clineEnv: sorted(plan.clineEnv), kimiPath: plan.kimiPath, kimiEnv: sorted(plan.kimiEnv), openrouterKey: plan.openrouterKey }
  return `${plan.key}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

export function boundUsageReading(plan: UsageSourcePlan, snapshot: UsageSnapshot) {
  return { ...toReading(plan, snapshot), key: usageCacheKey(plan) }
}

/** No tokens are written to disk or sent across IPC. Bindings end with the PTY. */
export class UsageBindings {
  private sessions = new Map<string, { target: string; plan: UsageSourcePlan | null }>()
  capture(target: UsageTarget, input: UsagePlanInput, environment: Record<string, string | undefined>, home: string, fake?: string): void {
    if (!target.ptyId || this.sessions.size >= 512) return
    const account = input.accounts[target.accountId]
    const env = { ...environment, ...(account?.kind === 'login' ? accountEnv(account) : {}) }
    const route = usageRouteFor(target, input)
    // An inherited external credential/gateway can override the Default
    // sign-in. Reading another token from its native store cannot prove usage.
    const inheritedAuth = target.cli === 'claude' && (account?.kind === 'login' || ((!target.accountId || target.accountId === 'default') && input.claudeAuth === 'default')) &&
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'].some(key => !!env[key]?.trim())
    const selected = route && !inheritedAuth ? planUsageSources(input, env, home, fake).find(plan => plan.key === usageKey(route.source, route.accountId)) : null
    const plan = selected ? { ...selected,
      ...(selected.clineEnv ? { clineEnv: { ...selected.clineEnv } } : {}),
      ...(selected.kimiEnv ? { kimiEnv: { ...selected.kimiEnv } } : {})
    } : null
    this.sessions.set(target.ptyId, { target: usageTargetKey(target), plan })
  }
  for(target: UsageTarget): UsageSourcePlan | null {
    const binding = target.ptyId ? this.sessions.get(target.ptyId) : null
    return binding?.target === usageTargetKey(target) ? binding.plan : null
  }
  plans(): UsageSourcePlan[] { return [...this.sessions.values()].flatMap(binding => binding.plan ? [binding.plan] : []) }
  drop(id: string): void { this.sessions.delete(id) }
  clear(): void { this.sessions.clear() }
}
