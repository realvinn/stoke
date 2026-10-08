import { cliFor, type CodingCliId } from './codingClis.ts'

/** A launch owns its claim through asynchronous preparation and PTY creation. */
export class AgentLifecycleGate {
  private updating: CodingCliId | null = null
  private starting = new Map<CodingCliId, number>()
  beginLaunch(cli: CodingCliId): (() => void) | null {
    if (this.updating === cli) return null
    this.starting.set(cli, (this.starting.get(cli) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.starting.get(cli) ?? 1) - 1
      if (count) this.starting.set(cli, count)
      else this.starting.delete(cli)
    }
  }
  beginUpdate(cli: CodingCliId): boolean {
    if (this.updating || this.starting.has(cli)) return false
    this.updating = cli
    return true
  }
  endUpdate(cli: CodingCliId): void {
    if (this.updating === cli) this.updating = null
  }
}

export type AgentInstallMethod = 'native' | 'npm' | 'brew' | 'unknown'
export interface AgentInstallation {
  cli: CodingCliId
  path: string
  resolvedPath: string
  version: string | null
  method: AgentInstallMethod
  packageName: string | null
  command: { file: string; args: string[]; label: string } | null
  reason: string | null
  runningSessions: number
}
export interface AgentUpdateResult {
  outcome: 'updated' | 'unchanged' | 'failed' | 'unverified' | 'blocked'
  before: string | null
  after: string | null
  message: string
  output: string
}

/** Extra packages with a documented route that is no longer the default installer. */
const LEGACY_NPM: Partial<Record<CodingCliId, readonly string[]>> = {
  codex: ['@openai/codex'], opencode: ['opencode-ai', '@opencode/cli']
}
export function agentNpmPackages(cli: CodingCliId): string[] {
  const packages = new Set(LEGACY_NPM[cli] ?? [])
  for (const command of Object.values(cliFor(cli).install)) {
    if (!command.startsWith('npm install ')) continue
    for (const word of command.split(/\s+/).slice(2)) {
      if (/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(word)) packages.add(word)
    }
  }
  return [...packages]
}

/** Only these native subcommands were verified in vendor docs or the installed CLI help. */
export const NATIVE_AGENT_UPDATE: Partial<Record<CodingCliId, string>> = {
  codex: 'update', cursor: 'update', opencode: 'upgrade'
}
export function agentVersion(text: string): string | null {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  return clean.match(/\b(?:v)?(\d+\.\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?)(?=\s|$|\))/)?.[1] ?? null
}
export function nativeUpdaterInHelp(cli: CodingCliId, text: string): boolean {
  const command = NATIVE_AGENT_UPDATE[cli]
  if (!command) return false
  return new RegExp(`^\\s*(?:${cliFor(cli).bins.posix.join('|')}\\s+)?${command}(?:\\s{2,}|\\s+\\[|$)`, 'm').test(text)
}
