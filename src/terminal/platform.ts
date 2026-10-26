import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import crossSpawn from 'cross-spawn'

export { TERMINAL_TARGETS } from './targets.ts'

/** Terminal PATH comes from the invoking shell. On Windows environment keys
 * are case-insensitive; npm shims also need PATHEXT rather than X_OK alone. */
export function findExecutable(names: readonly string[], env = process.env, platform = process.platform): string | null {
  const win = platform === 'win32'
  const paths = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const extensions = win ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : []
  for (const name of names) {
    const candidates = isAbsolute(name) || (win && win32.isAbsolute(name)) || /[\\/]/.test(name)
      ? [resolve(name)] : paths.split(win ? ';' : delimiter).filter(Boolean).map((dir) => join(dir.replace(/^"|"$/g, ''), name))
    for (const candidate of candidates) for (const file of [candidate, ...(!/\.[^\\/]+$/.test(candidate) ? extensions.map((ext) => candidate + ext.toLowerCase()) : [])]) {
      try { accessSync(file, win ? constants.F_OK : constants.X_OK); if (statSync(file).isFile()) return file } catch { /* next entry */ }
    }
  }
  return null
}

/** npm's generated Windows shims identify their JS entry explicitly. Launch
 * that entry with node, keeping prompts and quotes out of cmd's parser. */
export function npmShimEntry(file: string): string | null {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const match = /"%(?:dp0|~dp0)%?[\\/]([^"\r\n]+\.(?:[cm]?js))"\s+%\*/i.exec(text)
  if (!match) return null
  const entry = resolve(dirname(file), match[1].replace(/\\/g, '/'))
  try { accessSync(entry, constants.R_OK); return entry } catch { return null }
}

export function terminalSpawnSpec(file: string, args: string[], env = process.env): { file: string; args: string[] | string } {
  if (process.platform !== 'win32') return { file, args }
  if (/\.(cmd|bat)$/i.test(file)) {
    const entry = npmShimEntry(file)
    if (entry) {
      const node = findExecutable(['node.exe'], env) || process.execPath
      return { file: node, args: [entry, ...args] }
    }
    if (args.some((arg) => /[\r\n\0]/.test(arg))) throw new Error('This batch launcher cannot accept a multiline argument. Configure its native executable or npm JS entry instead.')
  }
  const parsed = crossSpawn._parse(file, args, { env })
  // node-pty accepts a raw Windows command line: do not escape cmd's already
  // quoted /s /c string a second time through CommandLineToArgvW rules.
  return { file: parsed.command, args: parsed.options.windowsVerbatimArguments ? parsed.args.join(' ') : parsed.args }
}
