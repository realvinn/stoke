declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process'
  const spawn: {
    (file: string, args: string[], options?: SpawnOptions): ChildProcess
    _parse(file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): {
      command: string
      args: string[]
      options: { windowsVerbatimArguments?: boolean }
    }
  }
  export default spawn
}
