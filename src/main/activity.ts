/**
 * What was worked on, from Claude Code's own transcripts.
 *
 * Pure and electron-free on purpose: `scripts/verify-activity.mts` runs this
 * module directly under `node --experimental-strip-types`, which is also why
 * the relative imports here carry explicit `.ts` extensions and why nothing in
 * this file uses a TypeScript parameter property.
 *
 * Discovery — which sessions belong to which project, and which of those
 * projects the user asked to watch — deliberately does NOT live here. `index.ts`
 * resolves that through the existing `listProjects` / `listSessions` /
 * worklog-gate helpers and hands this module a flat list, so every number below
 * can be tested without a filesystem and without a settings object.
 */

/**
 * A gap longer than this is not work.
 *
 * One fixed number, stated in the UI, rather than a setting. Measured on a real
 * session here: 127.7h of wall-clock, 12.5h of activity at a 5-minute cap and
 * 18.4h at 15. Those are three defensible-sounding answers to one question, so
 * the value has to be pinned and disclosed — a number that moves with a knob is
 * a number nobody can defend when a manager asks how it was measured.
 */
export const IDLE_GAP_MS = 15 * 60 * 1000

/**
 * Local calendar day, because "what did I do today" is a local question.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which is UTC: east of
 * Greenwich that reports the morning's work as yesterday.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * Elapsed active time per local day.
 *
 * Each gap is attributed to the day it *starts* in, and capped at `idleGapMs`.
 * Attributing to the start is what stops a session running past midnight from
 * booking the whole overnight stretch to the following day.
 *
 * The input is sorted rather than assumed sorted. A transcript interleaves
 * sidechain entries from sub-agents, which do not arrive in wall-clock order,
 * and an unsorted pass would read those as negative gaps and silently drop
 * real time.
 */
export function bucketActiveMs(stampsMs: number[], idleGapMs = IDLE_GAP_MS): Map<string, number> {
  const out = new Map<string, number>()
  const sorted = [...stampsMs].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]
    const delta = sorted[i] - from
    if (delta <= 0) continue
    const key = dayKey(from)
    out.set(key, (out.get(key) ?? 0) + Math.min(delta, idleGapMs))
  }
  return out
}
