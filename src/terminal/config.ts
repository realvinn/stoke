import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isCodingCliId, type CodingCliId } from '../shared/codingClis.ts'
import { isModelId } from '../shared/modelId.ts'

const model = z.string().refine((v) => v === '' || isModelId(v), 'Invalid model ID')
const agent = z.object({
  executable: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  model: model.default(''),
  models: z.array(model).default([])
}).strict()
const remote = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opencode'), url: z.string().url().refine((v) => {
    const u = new URL(v)
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
  }, 'Use an HTTP(S) URL without embedded credentials') }).strict(),
  z.object({ kind: z.literal('ssh'), host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9@._-]*$/) }).strict()
])
export const configSchema = z.object({
  version: z.literal(1).default(1),
  agent: z.string().refine(isCodingCliId, 'Unknown agent').default('claude'),
  agents: z.record(z.string(), agent).refine((v) => Object.keys(v).every(isCodingCliId), 'Unknown agent').default({}),
  remotes: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), remote).default({}),
  ui: z.object({
    theme: z.enum(['ember', 'ocean', 'terminal']).default('ember'),
    startup: z.enum(['terminal', 'composer', 'menu']).default('terminal'),
    menuKey: z.enum(['f5', 'f6', 'ctrl-backslash']).default('f5')
  }).strict().default({ theme: 'ember', startup: 'terminal', menuKey: 'f5' })
}).strict()
export type TerminalConfig = z.infer<typeof configSchema>
export const terminalHome = (): string => process.env.STOKE_TERMINAL_HOME ? resolve(process.env.STOKE_TERMINAL_HOME) : join(homedir(), '.stoke', 'terminal')
export const configPath = (): string => process.env.STOKE_CONFIG || join(homedir(), '.stoke', 'config.json')

export function readConfig(file = configPath()): TerminalConfig {
  let content: string
  try { content = readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({})
    throw error
  }
  try { return configSchema.parse(JSON.parse(content)) } catch (error) {
    throw new Error(`Invalid Stoke config at ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Each chat has its own file. Terminal state never writes the desktop's store
// or vault, and concurrent terminal instances cannot replace each other's chats.
export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const stage = `${file}.${randomUUID()}.tmp`
  writeFileSync(stage, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(stage, file)
}

export function selectedAgent(config: TerminalConfig): CodingCliId {
  return config.agent as CodingCliId
}

/** Merge a settings edit against the latest file under an exclusive lock.
 * Another Stoke window cannot silently lose its edits to an older UI copy. */
export function updateConfig(edit: (latest: TerminalConfig) => void, file = configPath()): TerminalConfig {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  let descriptor: number
  try { descriptor = openSync(lock, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another config edit is in progress. Try saving again.')
    throw error
  }
  try {
    const latest = readConfig(file)
    edit(latest)
    const valid = configSchema.parse(latest)
    atomicJson(file, valid)
    return valid
  } finally { closeSync(descriptor); unlinkSync(lock) }
}

export const exampleConfig = {
  version: 1,
  agent: 'opencode',
  agents: { opencode: { model: '', models: [], args: [] }, claude: { model: '', models: [], args: [] } },
  remotes: {},
  ui: { startup: 'terminal', theme: 'terminal', menuKey: 'f5' }
}
