import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { IPty } from '@lydell/node-pty'
import { cliFor, type CodingCliId } from '../shared/codingClis.ts'
import { atomicJson, terminalHome, type TerminalConfig } from './config.ts'
import { ScreenMirror } from '../main/screenMirror.ts'
import { terminalSpawnSpec } from './platform.ts'
import { createChat, executableFor, launchArgs, type Chat } from './sessionMeta.ts'

export interface LiveChat {
  chat: Chat
  pty: IPty
  screen: ScreenMirror
  exited: boolean
  exitCode?: number
}

export class LocalSessions {
  readonly live = new Map<string, LiveChat>()
  private readonly released = new WeakSet<IPty>()
  private readonly onOutput: (session: LiveChat, data: string) => void
  private readonly onExit: (session: LiveChat) => void
  private readonly home: string
  constructor(
    onOutput: (session: LiveChat, data: string) => void,
    onExit: (session: LiveChat) => void,
    home = terminalHome()
  ) { this.onOutput = onOutput; this.onExit = onExit; this.home = home }

  create(agent: CodingCliId, cwd: string, model: string, prompt = ''): Chat {
    return createChat(agent, cwd, model, prompt)
  }

  start(chat: Chat, config: TerminalConfig, prompt = '', resume = false, override?: { file: string; args: string[] }, environment = process.env): LiveChat {
    const file = override?.file || executableFor(chat.agent, config)
    if (!file) throw new Error(`${cliFor(chat.agent).label} is not on PATH. Install it from ${cliFor(chat.agent).home}, or set agents.${chat.agent}.executable in /config.`)
    const args = override?.args ?? launchArgs(chat, config, prompt, resume)
    const env: NodeJS.ProcessEnv = { ...environment, TERM_PROGRAM: 'Stoke', STOKE_TERMINAL: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    const spec = terminalSpawnSpec(file, args, env)
    const { spawn } = createRequire(resolve(process.argv[1] || 'stoke.cjs'))('@lydell/node-pty') as typeof import('@lydell/node-pty')
    const pty = spawn(spec.file, spec.args, { cwd: chat.cwd, env, name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
    this.live.get(chat.id)?.screen.dispose()
    const session: LiveChat = { chat, pty, screen: new ScreenMirror(process.stdout.columns || 80, process.stdout.rows || 24), exited: false }
    this.live.set(chat.id, session)
    // Save metadata only; vendor credentials/transcripts stay with the vendor.
    try { atomicJson(join(this.home, 'chats', `${chat.id}.json`), chat) } catch (error) {
      pty.kill(); session.screen.dispose(); this.live.delete(chat.id); throw error
    }
    pty.onData((data) => {
      session.screen.write(data)
      this.onOutput(session, data)
    })
    pty.onExit(({ exitCode }) => {
      session.exited = true; session.exitCode = exitCode
      // The Win32 backend retains its reader worker after a natural exit.
      // kill() releases that worker even though the child itself is gone.
      if (process.platform === 'win32') this.release(pty)
      this.onExit(session)
    })
    return session
  }

  close(): void {
    for (const session of this.live.values()) {
      if (!session.exited || process.platform === 'win32') this.release(session.pty)
      session.screen.dispose()
    }
  }

  private release(pty: IPty): void {
    if (this.released.has(pty)) return
    this.released.add(pty)
    try { pty.kill() } catch { /* already released by an explicit stop */ }
  }
}
