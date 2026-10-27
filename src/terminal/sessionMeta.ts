import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { binNamesFor, cliFor, isSafeResumeId, type CodingCliId } from '../shared/codingClis.ts'
import { isModelId } from '../shared/modelId.ts'
import { terminalHome, type TerminalConfig } from './config.ts'
import { findExecutable } from './platform.ts'

export type SessionKind = CodingCliId | 'shell'
export const sessionLabel = (agent: SessionKind): string => agent === 'shell' ? 'Shell' : cliFor(agent).label

export interface Chat {
  id: string
  agent: SessionKind
  cwd: string
  title: string
  createdAt: number
  model: string
  nativeId?: string
}
export function executableFor(agent: SessionKind, config: TerminalConfig): string | null {
  if (agent === 'shell') return shellExecutable()
  const custom = config.agents[agent]?.executable
  const names = custom ? [custom] : binNamesFor(cliFor(agent), process.platform)
  return findExecutable(names)
}

export function launchArgs(chat: Chat, config: TerminalConfig, prompt = '', resume = false): string[] {
  if (chat.agent === 'shell') {
    if (prompt || resume) throw new Error('An ended shell cannot be resumed. Start a new shell in its folder.')
    return []
  }
  const cli = cliFor(chat.agent)
  const args = [...(config.agents[chat.agent]?.args ?? [])]
  if (chat.model) {
    if (!isModelId(chat.model)) throw new Error('Invalid model ID')
    const modelArgs = chat.agent === 'claude' ? (m: string): string[] => ['--model', m] : cli.modelArgs
    if (!modelArgs) throw new Error(`${cli.label} selects models inside its own interface.`)
    args.push(...modelArgs(chat.model))
  }
  if (chat.agent === 'claude') {
    if (resume && !chat.nativeId) throw new Error('No exact resume ID recorded for this chat. Use /continue in its agent.')
    args.push(resume ? '--resume' : '--session-id', chat.nativeId || chat.id)
  } else if (resume) {
    if (!chat.nativeId || !isSafeResumeId(chat.nativeId) || !cli.resumeArgs) {
      throw new Error(`No exact resume ID recorded. Use /continue to open ${cli.label}'s most recent chat in this folder.`)
    }
    args.push(...cli.resumeArgs(chat.nativeId))
  }
  if (prompt) {
    // Native interactive startup prompts, not print/API mode or timed PTY input.
    if (chat.agent === 'opencode') args.push('--prompt', prompt)
    else if (chat.agent === 'claude' || chat.agent === 'codex') args.push('--', prompt)
    else throw new Error(`Use /new to open ${cli.label}, then type your prompt in its terminal.`)
  }
  return args
}

export function history(home = terminalHome()): Chat[] {
  let files: string[]
  try { files = readdirSync(join(home, 'chats')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const chats: Chat[] = []
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const chat = JSON.parse(readFileSync(join(home, 'chats', file), 'utf8')) as Chat
      if (typeof chat.id === 'string' && isSafeResumeId(chat.id) && typeof chat.cwd === 'string' &&
          typeof chat.title === 'string' && typeof chat.model === 'string' &&
          Number.isFinite(chat.createdAt) && typeof chat.agent === 'string' &&
          (chat.agent === 'shell' || cliFor(chat.agent).id === chat.agent) &&
          (chat.nativeId === undefined || isSafeResumeId(chat.nativeId))) chats.push(chat)
    } catch { /* A broken chat record must not hide the rest of history. */ }
  }
  return chats.sort((a, b) => b.createdAt - a.createdAt)
}

export function createChat(agent: SessionKind, cwd: string, model: string, prompt = ''): Chat {
  const id = randomUUID()
  return { id, agent, cwd, model, title: prompt.slice(0, 90) || (agent === 'shell' ? 'Shell' : `${cliFor(agent).label} chat`), createdAt: Date.now(),
    ...(agent === 'claude' ? { nativeId: id } : {}) }
}

/** Treat SHELL/ComSpec as a path, never as a command string or shell expression. */
export function shellExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const candidates = platform === 'win32' ? [env.ComSpec || env.COMSPEC || 'cmd.exe', 'powershell.exe'] : [env.SHELL || '/bin/sh', '/bin/sh']
  return findExecutable(candidates, env, platform)
}
