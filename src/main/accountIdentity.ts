import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { accountEnv, DEFAULT_ACCOUNT_ID, type AgentAccount } from '../shared/accounts.ts'
import { accountIdentityKey, nativeAccountIdentity, type AccountIdentity, type AccountIdentityTarget } from '../shared/accountIdentity.ts'
import type { Settings } from '../shared/types.ts'
import { spawnSpec } from './cli.ts'

export interface AccountIdentityPlan {
  target: AccountIdentityTarget
  label: string
  env: Record<string, string | undefined>
  cwd: string
  claudePath: string | null
  native: 'claude' | 'codex' | null
  fallback: Pick<AccountIdentity, 'state' | 'method' | 'detail'>
}
type IdentitySettings = Pick<Settings, 'accounts' | 'providers' | 'agents' | 'claudePath'>

export function planAccountIdentity(target: AccountIdentityTarget, settings: IdentitySettings, environment: Record<string, string | undefined>, cwd: string): AccountIdentityPlan {
  const account: AgentAccount | undefined = target.accountId === DEFAULT_ACCOUNT_ID ? undefined : settings.accounts[target.accountId]
  const valid = target.accountId === DEFAULT_ACCOUNT_ID || account?.cli === target.cli
  const env = { ...environment, ...(valid && account?.kind === 'login' ? accountEnv(account) : {}) }
  const plan: AccountIdentityPlan = { target: { ...target }, label: valid ? account?.label || 'Default' : target.accountId, env, cwd, claudePath: settings.claudePath, native: null, fallback: { state: 'unavailable', method: 'Agent sign-in', detail: 'This agent does not expose a readable sign-in identity to Stoke yet.' } }
  if (!valid) { plan.fallback.detail = 'This account is no longer configured for this agent.'; return plan }
  if (account?.kind === 'key') {
    plan.fallback = { state: account.apiKey ? 'ready' : 'unavailable', method: 'API key', detail: account.apiKey ? 'This account uses its configured API key. The key owner’s email is not available.' : 'This account has no readable API key configured.' }
    return plan
  }
  const mode = target.cli === 'claude' ? account ? 'default' : settings.providers.claudeAuth : settings.agents.endpoints[target.cli]?.mode ?? 'default'
  if (mode !== 'default') {
    plan.fallback = { state: 'ready', method: mode === 'anthropic' ? 'Anthropic API key' : mode === 'openrouter' ? 'OpenRouter' : 'Custom provider', detail: 'This account uses the selected provider configuration. A native agent login would describe a different authentication source.' }
    return plan
  }
  if (target.cli === 'claude' && ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'].some(key => !!env[key]?.trim())) {
    plan.fallback = { state: 'unavailable', method: 'External authentication', detail: 'This session inherits external authentication; its native saved login cannot identify that credential.' }
    return plan
  }
  if (target.cli === 'claude' || target.cli === 'codex') plan.native = target.cli
  return plan
}

export const ACCOUNT_IDENTITY_TIMEOUT_MS = 5_000
const OUTPUT_LIMIT = 128 * 1024

/** One owned read-only child. Never starts a turn, signs in, or refreshes tokens. */
export type AccountIdentitySpawn = (file: string, args: string[], options: SpawnOptions) => ChildProcess
export async function probeAccountIdentity(plan: AccountIdentityPlan, executable: string, env: Record<string, string>, timeout = ACCOUNT_IDENTITY_TIMEOUT_MS, spawnProcess: AccountIdentitySpawn = spawn, signal?: AbortSignal): Promise<unknown> {
  if (!plan.native || signal?.aborted) return null
  const args = plan.native === 'claude' ? ['auth', 'status', '--json'] : ['app-server', '--listen', 'stdio://']
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable) && /[&|<>^%!\r\n]/.test([executable, ...args].join(' '))) return null
  const spec = spawnSpec(executable, args)
  return new Promise(resolve => {
    let child: ChildProcess
    let result: unknown = null
    let buffer = ''
    let bytes = 0
    let finished = false
    let stopping = false
    let reading = false
    let failed = false
    const decoder = new StringDecoder('utf8')
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(stopTimer); clearTimeout(hardTimer); signal?.removeEventListener('abort', abort); resolve(result) }
    const terminate = () => {
      if (finished) return
      if (process.platform === 'win32' && child.pid) {
        // A .cmd launcher owns descendants. Stop its tree before its shell exits.
        execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { timeout: 2_000, maxBuffer: 4096, windowsHide: true }, (error) => { if (error && !finished) child.kill('SIGKILL') })
      } else { child.kill('SIGTERM'); hardTimer = setTimeout(() => child.kill('SIGKILL'), 500) }
    }
    const stop = () => {
      if (stopping || finished) return
      stopping = true
      child.stdin?.end()
      stopTimer = setTimeout(terminate, 250)
    }
    const abort = () => { failed = true; result = null; stop() }
    const timer = setTimeout(abort, timeout)
    try { child = spawnProcess(spec.file, spec.args, { env, cwd: plan.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch { finish(); return }
    child.on('error', finish)
    child.on('close', (code) => {
      buffer += decoder.end()
      if (plan.native === 'claude' && !failed && bytes <= OUTPUT_LIMIT) {
        try { const parsed = JSON.parse(buffer); if (code === 0 || code === 1 && parsed.loggedIn === false) result = parsed } catch { result = null }
      }
      finish()
    })
    child.stdin?.on('error', () => { failed = true; result = null; stop() })
    child.stderr?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_LIMIT) { failed = true; result = null; stop() } })
    const send = (value: unknown) => child.stdin?.write(`${JSON.stringify(value)}\n`)
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > OUTPUT_LIMIT) { failed = true; result = null; stop(); return }
      if (stopping) return
      buffer += decoder.write(chunk)
      if (plan.native === 'claude') return
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        try {
          const message = JSON.parse(line)
          if (message.id === 1 && !reading) {
            if (message.error || !message.result) { stop(); return }
            reading = true
            send({ method: 'initialized', params: {} })
            send({ id: 2, method: 'account/read', params: { refreshToken: false } })
          } else if (message.id === 2 && reading) { result = message.error ? null : message.result; stop(); return }
          else if (message.id !== undefined && message.method) { result = null; stop(); return }
        } catch { result = null; stop(); return }
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    if (plan.native === 'codex') send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'stoke_account_identity', title: 'Stoke account identity', version: '1' } } })
    else child.stdin?.end()
  })
}

/** Session plans survive settings changes; a mismatched or ended PTY never falls back to Default. */
export class AccountIdentities {
  private sessions = new Map<string, AccountIdentityPlan>()
  private reads = new Map<string, { started: number; until: number; pending: boolean; value: Promise<AccountIdentity> }>()
  private generation = 0
  private owned = new Map<AbortController, string | undefined>()
  private jobs = new Set<Promise<AccountIdentity>>()
  private active = 0
  private waiting: Array<() => void> = []
  private acquire(): Promise<boolean> {
    if (this.active < 2) { this.active++; return Promise.resolve(true) }
    if (this.waiting.length >= 16) return Promise.resolve(false)
    return new Promise(resolve => {
      const enter = () => { clearTimeout(timer); resolve(true) }
      const timer = setTimeout(() => { this.waiting = this.waiting.filter(v => v !== enter); resolve(false) }, 5_000)
      this.waiting.push(enter)
    })
  }
  private release(): void { const next = this.waiting.shift(); if (next) next(); else this.active-- }
  capture(plan: AccountIdentityPlan): void { if (plan.target.ptyId && this.sessions.size < 512) this.sessions.set(plan.target.ptyId, plan) }
  drop(id: string): void {
    this.sessions.delete(id)
    for (const [controller, ptyId] of this.owned) if (ptyId === id) controller.abort()
  }
  clear(): void {
    this.generation++; this.sessions.clear(); this.reads.clear()
    for (const controller of this.owned.keys()) controller.abort()
  }
  get pendingCount(): number { return this.jobs.size }
  async shutdown(timeoutMs = 3_000): Promise<number> {
    this.clear()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.allSettled([...this.jobs]), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
      return this.jobs.size
    } finally { clearTimeout(timer) }
  }
  invalidate(): void { this.reads.clear() }
  async read(target: AccountIdentityTarget, configured: AccountIdentityPlan, probe: (plan: AccountIdentityPlan, signal: AbortSignal) => Promise<unknown>, now = Date.now(), refresh = false): Promise<AccountIdentity> {
    const session = target.ptyId ? this.sessions.get(target.ptyId) : null
    const plan = session && accountIdentityKey(session.target) === accountIdentityKey(target) ? session : target.ptyId ? null : configured
    const missing = (): AccountIdentity => ({ target, label: configured.label, state: 'unavailable', method: 'Agent sign-in', email: null, organization: null, plan: null, detail: 'This session’s account can no longer be identified. No other account was read.', checkedAt: now })
    if (!plan) return missing()
    const key = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
    const kept = this.reads.get(key)
    if (kept && (kept.pending || kept.until > now && (!refresh || now - kept.started < 2_000))) return kept.value
    if (this.reads.size >= 256) {
      for (const [k, r] of this.reads) if (!r.pending && r.until <= now) this.reads.delete(k)
      for (const [k, r] of this.reads) { if (this.reads.size < 256) break; if (!r.pending) this.reads.delete(k) }
    }
    const generation = this.generation
    const work = async (): Promise<AccountIdentity> => {
      let value: AccountIdentity = { target: { ...target }, label: plan.label, ...plan.fallback, email: null, organization: null, plan: null, checkedAt: now }
      if (plan.native && await this.acquire()) {
        const controller = new AbortController()
        this.owned.set(controller, target.ptyId)
        try { if (generation === this.generation && (!target.ptyId || this.sessions.get(target.ptyId) === session)) value = { ...value, ...nativeAccountIdentity(plan.native, await probe(plan, controller.signal)) } }
        catch { /* no native output or credentials leave main */ }
        finally { this.owned.delete(controller); this.release() }
      } else if (plan.native) value.detail = 'Other account checks are still running. Try Refresh shortly.'
      if (generation !== this.generation || target.ptyId && this.sessions.get(target.ptyId) !== session) return missing()
      return value
    }
    const promise = work()
    const entry = { started: now, until: now + 15_000, pending: true, value: promise }
    this.reads.set(key, entry)
    this.jobs.add(promise)
    void promise.finally(() => { entry.pending = false; this.jobs.delete(promise) })
    return promise
  }
}
