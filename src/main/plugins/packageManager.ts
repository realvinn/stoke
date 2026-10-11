import { mkdir, rm, writeFile, rename, stat } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import {
  BUILTIN_PACKAGES,
  PLUGIN_CATALOG,
  isPluginId,
  parsePluginPackage,
  pluginEntry,
  type PluginRunResult,
  type PluginsView,
  type StokePluginPackage
} from '../../shared/pluginPackages.ts'
import { PluginFile } from './files.ts'
import { PluginProcesses, pluginEnvironment } from './processes.ts'

interface SavedPlugin {
  package: StokePluginPackage
  enabled: boolean
}
interface State {
  schema: 1
  revision: number
  installed: Record<string, SavedPlugin>
}
interface Options {
  root: string
  executable: string
  environment: NodeJS.ProcessEnv
  workEnabled: () => Promise<boolean>
  builtinToggle: (id: string, enabled: boolean) => Promise<void>
  builtinRevoke?: (id: string) => void
  changed: (view: PluginsView) => void
}
const assetVersion = (pkg: StokePluginPackage): string =>
  `${pkg.version}-${createHash('sha256').update(JSON.stringify(pkg)).digest('hex').slice(0, 24)}`
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export class PluginPackages {
  private options: Options
  private file: PluginFile<State>
  private state: State | null = null
  private revoked = new Set<string>()
  private generations = new Map<string, number>()
  private revoke(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.revoked.add(id)
    this.runners.get(id)?.stop()
    this.options.builtinRevoke?.(id)
    if (this.state) this.options.changed(this.view(this.state))
  }
  private runners = new Map<string, PluginProcesses>()
  constructor(options: Options) {
    this.options = options
    this.file = new PluginFile(join(options.root, 'registry.json'), 16 * 1024 * 1024)
  }
  private async load(signal: AbortSignal): Promise<State> {
    if (this.state) return this.state
    const raw = await this.file.read(signal)
    const state: State = { schema: 1, revision: 0, installed: {} }
    if (raw !== null) {
      if (
        !record(raw) ||
        raw.schema !== 1 ||
        !Number.isSafeInteger(raw.revision) ||
        !record(raw.installed) ||
        Object.keys(raw.installed).length > 64
      )
        throw new Error('The plugin registry cannot be read. Keep it for recovery.')
      state.revision = raw.revision as number
      for (const [id, entry] of Object.entries(raw.installed)) {
        if (!isPluginId(id) || !record(entry) || typeof entry.enabled !== 'boolean')
          throw new Error('The plugin registry contains an invalid entry.')
        const pkg = parsePluginPackage(entry.package, true)
        if (pkg.id !== id) throw new Error('A plugin registry entry has the wrong identity.')
        state.installed[id] = { package: pkg, enabled: entry.enabled }
      }
    }
    // Work's durable flag predates the registry; preserve it on migration.
    const enabled = await this.options.workEnabled()
    signal.throwIfAborted()
    state.installed.work = { package: structuredClone(BUILTIN_PACKAGES[0]), enabled }
    this.state = state
    return state
  }
  private view(state: State): PluginsView {
    const packages = new Map(PLUGIN_CATALOG.map(entry => [entry.package.id, entry.package]))
    for (const entry of Object.values(state.installed)) packages.set(entry.package.id, entry.package)
    return {
      revision: state.revision,
      entries: [...packages.values()].map((pkg) =>
        pluginEntry(
          pkg,
          !!state.installed[pkg.id],
          !!state.installed[pkg.id]?.enabled && !this.revoked.has(pkg.id)
        )
      )
    }
  }
  read(): Promise<PluginsView> {
    return this.file.transaction(async (signal) => this.view(await this.load(signal)))
  }
  private async commit(state: State, signal: AbortSignal, ready?: () => void): Promise<PluginsView> {
    await this.file.write(state, signal)
    this.state = state
    ready?.()
    const view = this.view(state)
    this.options.changed(view)
    return view
  }
  enabled(id: string): Promise<boolean> {
    if (this.revoked.has(id)) return Promise.resolve(false)
    return this.file.transaction(
      async (signal) => !!(await this.load(signal)).installed[id]?.enabled && !this.revoked.has(id)
    )
  }
  setEnabled(id: string, enabled: boolean): Promise<PluginsView> {
    if (!isPluginId(id) || typeof enabled !== 'boolean')
      return Promise.reject(new Error('Choose a plugin and enabled state.'))
    // Revoke before the first await, so a pending preparation cannot launch.
    if (!enabled) {
      this.revoke(id)
    }
    return this.file.transaction(async (signal) => {
      const state = await this.load(signal),
        current = state.installed[id]
      if (!current) throw new Error('Install this plugin first.')
      await this.options.builtinToggle(id, enabled)
      signal.throwIfAborted()
      const next = structuredClone(state)
      next.revision++
      next.installed[id].enabled = enabled
      return this.commit(next, signal, () => {
        if (enabled) {
          this.revoked.delete(id)
          this.runners.get(id)?.resume()
        }
      })
    })
  }
  /** An older Work control is still a valid writer during migration. */
  syncWork(enabled: boolean): Promise<PluginsView> {
    return this.file.transaction(async (signal) => {
      const state = await this.load(signal),
        next = structuredClone(state)
      next.installed.work.enabled = enabled
      next.revision++
      if (enabled) this.revoked.delete('work')
      else this.revoked.add('work')
      return this.commit(next, signal)
    })
  }
  install(raw: unknown): Promise<PluginsView> {
    const pkg = parsePluginPackage(raw, true)
    this.revoke(pkg.id)
    return this.file.transaction(async (signal) => {
      const state = await this.load(signal)
      if (!state.installed[pkg.id] && Object.keys(state.installed).length >= 64)
        throw new Error('Remove a plugin before adding another.')
      if (pkg.kind === 'extension') {
        const root = join(this.options.root, 'packages', pkg.id)
        const stage = join(root, `.install-${randomUUID()}`)
        const target = join(root, assetVersion(pkg))
        try {
          await mkdir(stage, { recursive: true, mode: 0o700 })
          signal.throwIfAborted()
          for (const [path, content] of Object.entries(pkg.files)) {
            const destination = join(stage, path)
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
            signal.throwIfAborted()
            await writeFile(destination, content, { mode: 0o600, signal })
            signal.throwIfAborted()
          }
          // Version folders are never shared with another plugin or its data.
          try {
            await rename(stage, target)
          } catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          }
          signal.throwIfAborted()
        } finally {
          await rm(stage, { recursive: true, force: true }).catch(() => {})
        }
      }
      if (pkg.kind === 'builtin') {
        await this.options.builtinToggle(pkg.id, false)
        signal.throwIfAborted()
      }
      const next = structuredClone(state)
      next.revision++
      next.installed[pkg.id] = { package: pkg, enabled: false }
      return this.commit(next, signal)
    })
  }
  remove(id: string): Promise<PluginsView> {
    if (!isPluginId(id) || id === 'work')
      return Promise.reject(new Error('Built-in Work can be disabled; its saved records remain available.'))
    this.revoke(id)
    return this.file.transaction(async (signal) => {
      const state = await this.load(signal)
      await this.options.builtinToggle(id, false)
      signal.throwIfAborted()
      const next = structuredClone(state)
      delete next.installed[id]
      next.revision++
      // Saved plugin data and credentials are intentionally retained. Removing
      // an extension does not erase an account or someone's task history.
      return this.commit(next, signal)
    })
  }
  package(id: string): Promise<StokePluginPackage> {
    return this.file.transaction(async (signal) => {
      const pkg = (await this.load(signal)).installed[id]?.package
      if (!pkg) throw new Error('This plugin is not installed.')
      return structuredClone(pkg)
    })
  }
  async run(id: string, actionId: string, project: string | null): Promise<PluginRunResult> {
    if (
      !isPluginId(id) ||
      !isPluginId(actionId) ||
      (project !== null &&
        (typeof project !== 'string' || project.length > 4096 || /[\u0000-\u001f]/.test(project)))
    )
      throw new Error('Choose a plugin action and local project.')
    const generation = this.generations.get(id) ?? 0
    if (!(await this.enabled(id))) throw new Error('Enable this plugin first.')
    const pkg = await this.package(id)
    const action = pkg.panel.actions.find((entry) => entry.id === actionId)
    if (!action || !pkg.permissions.includes('local-code'))
      throw new Error('This plugin does not have this action.')
    let runner = this.runners.get(id)
    if (!runner) {
      runner = new PluginProcesses()
      this.runners.set(id, runner)
    }
    return runner
      .run(async (signal) => {
        if (this.revoked.has(id) || generation !== (this.generations.get(id) ?? 0))
          throw new Error('The plugin was disabled.')
        if (project && pkg.permissions.includes('project-context')) {
          if (!isAbsolute(project) || !(await stat(project)).isDirectory())
            throw new Error('Choose an existing local project folder.')
          signal.throwIfAborted()
        }
        const data = join(this.options.root, 'data', id)
        await mkdir(data, { recursive: true, mode: 0o700 })
        signal.throwIfAborted()
        if (this.revoked.has(id) || generation !== (this.generations.get(id) ?? 0))
          throw new Error('The plugin was disabled.')
        return {
          executable: this.options.executable,
          args: [join(this.options.root, 'packages', id, assetVersion(pkg), action.entry), ...action.args],
          cwd: data,
          env: {
            ...pluginEnvironment(this.options.environment),
            STOKE_PLUGIN_ID: id,
            STOKE_PLUGIN_DATA_DIR: data
          },
          input: JSON.stringify({
            apiVersion: 1,
            pluginId: id,
            dataDirectory: data,
            project: pkg.permissions.includes('project-context') ? project : null
          })
        }
      })
      .then((result) => ({
        ok: result.code === 0,
        output: (result.stdout || result.stderr).slice(0, 256 * 1024),
        ...(result.code ? { message: `The plugin exited with status ${result.code}.` } : {})
      }))
  }
  stop(): void {
    for (const runner of this.runners.values()) runner.stop()
    for (const id of Object.keys(this.state?.installed ?? {})) this.revoke(id)
  }
}
