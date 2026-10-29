import type { UsageSnapshot } from './types'

// Cursor's CLI names this dashboard RPC and its production host. The RPC is
// undocumented, so missing fields remain unknown rather than becoming zero.
export const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function cursorUsageResponse(status: number, body: unknown, now: number): UsageSnapshot {
  const snapshot: UsageSnapshot = { source: 'cursor', windows: [], extraCredits: null, fetchedAt: now, error: null }
  if (status < 200 || status >= 300) {
    snapshot.error = status === 401 || status === 403 ? 'Cursor refused this account’s sign-in. Open Cursor to sign in again.' : `Cursor usage unavailable (${status}).`
    return snapshot
  }
  const usage = record(body) && record(body.planUsage) ? body.planUsage : null
  if (!usage) { snapshot.error = 'Cursor answered without its plan usage.'; return snapshot }
  const end = record(body) && (typeof body.billingCycleEnd === 'number' || typeof body.billingCycleEnd === 'string') ? Number(body.billingCycleEnd) : NaN
  const resetsAt = Number.isFinite(end) && end > 0 ? end : null
  for (const [key, label] of [['autoPercentUsed', 'Auto'], ['apiPercentUsed', 'API']] as const) {
    const percent = usage[key]
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue
    snapshot.windows.push({ kind: 'other', label, short: label, percent: Math.max(0, Math.min(100, percent)), severity: 'normal', resetsAt, elapsed: null, active: true })
  }
  if (!snapshot.windows.length) snapshot.error = 'Cursor did not provide Auto or API usage for this account.'
  return snapshot
}
