/** Built-in Stoke modules, separate from an agent's skills and MCP servers. */
export interface StokePluginManifest {
  id: string
  version: number
  name: string
  description: string
  capabilities: readonly ('sessions' | 'projects' | 'connectors')[]
  panels: readonly string[]
  commands: readonly string[]
}

/** Modules own their durable migrations and dispose their own runtime resources. */
export interface BuiltinStokePlugin<State, Command, Result> {
  readonly manifest: StokePluginManifest
  read(): Promise<State>
  change(command: Command): Promise<Result>
  stop(): void
}

export const WORK_PLUGIN: StokePluginManifest = {
  id: 'work', version: 1, name: 'Work',
  description: 'Keep approved tasks and daily plans in two linked boards.',
  capabilities: ['sessions', 'projects', 'connectors'],
  panels: ['work'], commands: []
}
