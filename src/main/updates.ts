import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildEnvPath, findClaude, spawnSpec } from './cli.ts'

const execFileAsync = promisify(execFile)

/**
 * Version and health for the Claude Code CLI.
 *
 * The CLI already auto-updates itself; the value Stoke adds is telling you when
 * a newer version exists without silently changing anything, and surfacing the
 * warnings `claude doctor` produces (a stale npm-global install shadowing the
 * native one is easy to miss and hard to diagnose).
 */

export interface UpdateInfo {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  checkedAt: number
  error: string | null
}

const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'

/** Extract "2.1.220" from "2.1.220 (Claude Code)". */
function parseVersion(raw: string | null): string | null {
  if (!raw) return null
  const m = /(\d+\.\d+\.\d+)/.exec(raw)
  return m ? m[1] : null
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

async function currentVersion(claudePath: string | null): Promise<string | null> {
  const exe = await findClaude(claudePath)
  if (!exe) return null
  try {
    const spec = spawnSpec(exe, ['--version'])
    const { stdout } = await execFileAsync(spec.file, spec.args, {
      timeout: 15_000,
      encoding: 'utf8',
      env: { ...process.env, PATH: await buildEnvPath() }
    })
    return parseVersion(stdout.trim())
  } catch {
    return null
  }
}

/**
 * Read-only check. The npm registry is used rather than running `claude update`,
 * which would install as a side effect of merely looking.
 */
export async function checkForUpdate(claudePath: string | null): Promise<UpdateInfo> {
  const current = await currentVersion(claudePath)
  const info: UpdateInfo = {
    current,
    latest: null,
    updateAvailable: false,
    checkedAt: Date.now(),
    error: null
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(REGISTRY, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`registry responded ${res.status}`)
    const body = (await res.json()) as { version?: string }
    info.latest = body.version ?? null
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err)
    return info
  }

  if (info.current && info.latest) {
    info.updateAvailable = compare(info.latest, info.current) > 0
  }
  return info
}

/** Runs the CLI's own updater and returns its combined output. */
export async function runUpdate(claudePath: string | null): Promise<string> {
  const exe = await findClaude(claudePath)
  if (!exe) return 'Could not find the claude executable.'
  try {
    const spec = spawnSpec(exe, ['update'])
    const { stdout, stderr } = await execFileAsync(spec.file, spec.args, {
      timeout: 180_000,
      encoding: 'utf8',
      env: { ...process.env, PATH: await buildEnvPath() }
    })
    return `${stdout}${stderr}`.trim() || 'No output.'
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'Update failed.'
  }
}

/** `claude doctor` output, including the warnings it finds. */
export async function runDoctor(claudePath: string | null): Promise<string> {
  const exe = await findClaude(claudePath)
  if (!exe) return 'Could not find the claude executable.'
  try {
    const spec = spawnSpec(exe, ['doctor'])
    const { stdout, stderr } = await execFileAsync(spec.file, spec.args, {
      timeout: 60_000,
      encoding: 'utf8',
      env: { ...process.env, PATH: await buildEnvPath() }
    })
    return `${stdout}${stderr}`.trim() || 'No output.'
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'Doctor failed.'
  }
}
