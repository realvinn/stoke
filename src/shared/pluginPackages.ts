/** Stoke extensions are separate from an agent's skills, MCP servers and plugins. */
export const STOKE_PLUGIN_API = 1
export const PLUGIN_MARKETPLACE = 'https://stoke.vinn.dev/marketplace'
export type PluginPermission = 'local-code' | 'project-context' | 'appearance'
export interface PluginAction {
  id: string
  label: string
  entry: string
  args: string[]
}
export interface StokePluginPackage {
  format: 'stoke-plugin'
  apiVersion: 1
  id: string
  version: string
  name: string
  description: string
  author: string
  kind: 'builtin' | 'extension'
  permissions: PluginPermission[]
  panel: { title: string; text: string; actions: PluginAction[] }
  /** Text assets only; paths are relative, never links or install scripts. */
  files: Record<string, string>
  appearance: Record<string, string>
}
export interface PluginEntry {
  manifest: Omit<StokePluginPackage, 'files'>
  installed: boolean
  enabled: boolean
  builtin: boolean
}
export interface PluginsView {
  revision: number
  entries: PluginEntry[]
}
export interface PluginRunResult {
  ok: boolean
  output: string
  message?: string
}
export interface PluginCatalogEntry {
  package: StokePluginPackage
  category: string
  source: string
}

export const BUILTIN_PACKAGES: StokePluginPackage[] = [
  {
    format: 'stoke-plugin',
    apiVersion: 1,
    id: 'work',
    version: '1.0.0',
    name: 'Work',
    author: 'Stoke',
    kind: 'builtin',
    description: 'Approved tasks, daily plans and optional Notion connections.',
    permissions: [],
    panel: { title: 'Work', text: '', actions: [] },
    files: {},
    appearance: {}
  },
  {
    format: 'stoke-plugin',
    apiVersion: 1,
    id: 'grok-bot',
    version: '1.0.0',
    name: 'Grok Bot',
    author: 'Stoke',
    kind: 'builtin',
    description:
      'Keep multiple Grok Bot accounts separate, browse bots and groups, and read or send messages.',
    permissions: [],
    panel: { title: 'Grok Bot', text: 'Uses the unofficial grok-bot-cli by ScriptedAlchemy.', actions: [] },
    files: {},
    appearance: {}
  }
]

export const SAMPLE_PLUGIN: StokePluginPackage = {
  format: 'stoke-plugin',
  apiVersion: 1,
  id: 'project-summary',
  version: '1.0.0',
  name: 'Project summary',
  author: 'Stoke',
  kind: 'extension',
  description: 'A small example of a native command panel. Runs only when you choose Read project.',
  permissions: ['local-code', 'project-context'],
  panel: {
    title: 'Project summary',
    text: 'Read the current project folder without changing its files.',
    actions: [{ id: 'read', label: 'Read project', entry: 'main.mjs', args: [] }]
  },
  files: {
    'main.mjs':
      "import { readdir } from 'node:fs/promises';\nlet input = ''; for await (const chunk of process.stdin) input += chunk;\nconst context = JSON.parse(input);\nif (!context.project) throw new Error('Choose a local project first.');\nconst entries = await readdir(context.project, { withFileTypes: true });\nconsole.log(JSON.stringify({ project: context.project, files: entries.filter(entry => entry.isFile()).length, folders: entries.filter(entry => entry.isDirectory()).length }, null, 2));\n"
  },
  appearance: {}
}

export const PLUGIN_CATALOG: PluginCatalogEntry[] = [
  { package: BUILTIN_PACKAGES[0], category: 'Planning', source: 'https://github.com/realvinn/stoke' },
  {
    package: BUILTIN_PACKAGES[1],
    category: 'Agents',
    source: 'https://github.com/ScriptedAlchemy/grok-bot-cli'
  },
  { package: SAMPLE_PLUGIN, category: 'Developer examples', source: 'https://github.com/realvinn/stoke' }
]

export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64
}
export function isPluginAssetPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 180 &&
    /^[a-zA-Z0-9_./-]+$/.test(value) &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !part.endsWith('.') &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      ) &&
    /\.(mjs|js|json|txt|md|css|svg)$/.test(value)
  )
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function text(value: unknown, max: number, required = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    (required && !value.trim())
  )
    throw new Error('The plugin has an invalid text field.')
  return value
}
/** Rebuild every field; packages cannot contribute executable HTML or raw CSS. */
export function parsePluginPackage(raw: unknown, allowBuiltin = false): StokePluginPackage {
  if (!record(raw) || raw.format !== 'stoke-plugin' || raw.apiVersion !== STOKE_PLUGIN_API)
    throw new Error('This package requires a supported Stoke plugin API.')
  if (
    !isPluginId(raw.id) ||
    typeof raw.version !== 'string' ||
    raw.version.length > 80 ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.version)
  )
    throw new Error('The plugin needs a valid ID and version.')
  if (raw.kind === 'builtin') {
    const builtin = allowBuiltin && BUILTIN_PACKAGES.find((plugin) => plugin.id === raw.id)
    if (!builtin) throw new Error('A local package cannot replace a built-in plugin.')
    return structuredClone(builtin)
  }
  if (raw.kind !== 'extension' || BUILTIN_PACKAGES.some((plugin) => plugin.id === raw.id))
    throw new Error('Choose a new ID for this extension.')
  if (
    !Array.isArray(raw.permissions) ||
    raw.permissions.some(
      (permission) => !['local-code', 'project-context', 'appearance'].includes(permission)
    )
  )
    throw new Error('The plugin requests an unsupported permission.')
  const permissions = [...new Set(raw.permissions)] as PluginPermission[]
  if (!record(raw.files) || Object.keys(raw.files).length > 64)
    throw new Error('The plugin has too many assets.')
  const files: Record<string, string> = {}
  let bytes = 0
  const paths = new Set<string>()
  for (const [path, content] of Object.entries(raw.files)) {
    if (!isPluginAssetPath(path) || paths.has(path.toLowerCase()))
      throw new Error('Plugin files must stay inside their own folder.')
    paths.add(path.toLowerCase())
    files[path] = text(content, 512 * 1024)
    const size = new TextEncoder().encode(files[path]).length
    if (size > 512 * 1024) throw new Error('A plugin asset is too large.')
    bytes += size
  }
  if (bytes > 2 * 1024 * 1024) throw new Error('The plugin package is too large.')
  if (!record(raw.panel) || !Array.isArray(raw.panel.actions) || raw.panel.actions.length > 24)
    throw new Error('The plugin needs a supported panel.')
  const ids = new Set<string>()
  const actions: PluginAction[] = raw.panel.actions.map((action) => {
    if (
      !record(action) ||
      !isPluginId(action.id) ||
      ids.has(action.id) ||
      typeof action.entry !== 'string' ||
      !/\.(mjs|js)$/.test(action.entry) ||
      !Object.hasOwn(files, action.entry)
    )
      throw new Error('A plugin action must name one of its bundled scripts.')
    ids.add(action.id)
    if (!Array.isArray(action.args) || action.args.length > 24)
      throw new Error('The plugin action has invalid arguments.')
    return {
      id: action.id,
      label: text(action.label, 80, true),
      entry: action.entry,
      args: action.args.map((arg) => text(arg, 1024))
    }
  })
  if (actions.length && !permissions.includes('local-code'))
    throw new Error('Script actions must declare permission to run local code.')
  const appearance: Record<string, string> = {}
  if (raw.appearance !== undefined && !record(raw.appearance))
    throw new Error('The appearance settings cannot be read.')
  for (const [token, value] of Object.entries(record(raw.appearance) ? raw.appearance : {})) {
    if (
      !['--r-sm', '--r-md', '--r-lg', '--r-card', '--fs-sm', '--fs-md'].includes(token) ||
      typeof value !== 'string' ||
      !/^\d+(?:\.\d+)?(?:px|rem)$/.test(value) ||
      parseFloat(value) > 32
    )
      throw new Error('This appearance token is not supported by Stoke mods.')
    const pixels = parseFloat(value) * (value.endsWith('rem') ? 16 : 1)
    if (pixels > 32 || (token.startsWith('--fs-') && (pixels < 10 || pixels > 24)))
      throw new Error('Choose a readable font size or radius up to 32 px.')
    appearance[token] = value
  }
  if (Object.keys(appearance).length && !permissions.includes('appearance'))
    throw new Error('An appearance mod must declare its appearance permission.')
  return {
    format: 'stoke-plugin',
    apiVersion: 1,
    id: raw.id,
    version: raw.version,
    name: text(raw.name, 80, true),
    description: text(raw.description, 600, true),
    author: text(raw.author, 100, true),
    kind: 'extension',
    permissions,
    panel: { title: text(raw.panel.title, 100, true), text: text(raw.panel.text, 4000), actions },
    files,
    appearance
  }
}

export function pluginEntry(pkg: StokePluginPackage, installed: boolean, enabled: boolean): PluginEntry {
  const { files: _files, ...manifest } = pkg
  return { manifest, installed, enabled: installed && enabled, builtin: pkg.kind === 'builtin' }
}

export function pluginInstallLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 512) return null
  try {
    const url = new URL(raw)
    if (
      url.protocol !== 'stoke:' ||
      url.host !== 'plugins' ||
      url.pathname !== '/install' ||
      url.username ||
      url.password ||
      url.hash
    )
      return null
    if ([...url.searchParams].length !== 1 || !url.searchParams.has('id')) return null
    const id = url.searchParams.get('id')
    return isPluginId(id) && PLUGIN_CATALOG.some((entry) => entry.package.id === id) ? id : null
  } catch {
    return null
  }
}
