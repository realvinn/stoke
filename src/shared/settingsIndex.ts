/**
 * Every page and row of the Settings sheet, as data: the menu's tree, the rows
 * a search can find, where an old section id lands now, and the search itself.
 *
 * Why a table and not a crawl of the DOM. A search that reads the rendered
 * sheet can only find the page that is open — the rest are not mounted — and
 * the command palette has no sheet at all. So the rows are named here, and the
 * sheet marks each one it draws with `data-setting="<id>"` so a jump can find
 * it. The two lists cannot drift apart silently: `verify:settings-search` reads
 * every `.tsx` for those marks and fails on a mark this file does not name, and
 * on a row this file names that no component marks. A row that is only drawn
 * in some states (a key field that exists only in one auth mode) says where a
 * jump should land instead (`fallback`).
 *
 * The menu itself used to be sixteen flat sections, three of them about Claude
 * Code (Claude Code, Providers, and Claude's page under Agents) and nowhere a
 * list of the agents you actually have. It is a tree now: Agents opens to the
 * Agent manager and each installed agent, and Claude Code opens to its launch
 * defaults, its own settings file, and its provider and keys. The old ids
 * still resolve (`resolveSettingsTarget`), because other panels, `stoke update`
 * and the palette open Settings by id.
 *
 * Imported by the renderer through `@shared/settingsIndex` and by the suite by
 * relative path; runtime imports here carry `.ts` (gotcha 78). No `node:` and no
 * DOM (gotcha 27).
 */
import { CODING_CLIS, type CodingCliId } from './codingClis.ts'
import { CLAUDE_SETTINGS, WORKFLOW_SIZE_KEY } from './claudeConfig.ts'

/* ------------------------------------------------------------------- pages */

export type SettingsPageId =
  | 'appearance'
  | 'terminal'
  | 'profiles'
  | 'sessions'
  /** The Agent manager: install, show in the launcher, the default, colours. */
  | 'agents'
  /** One agent's own page; the agent is `SettingsLocation.agent`. */
  | 'agent'
  | 'claude-launch'
  | 'claude-settings'
  | 'providers'
  | 'chats'
  | 'voice'
  | 'projects'
  | 'hosts'
  | 'browser'
  | 'worklog'
  | 'remote'
  | 'updates'
  | 'account'
  | 'backup'

/** Where the sheet is: a page, and for an agent's page, which agent. */
export interface SettingsLocation {
  page: SettingsPageId
  agent?: CodingCliId
}

/**
 * Section ids from before the tree that are not page ids any more. `claude` was
 * the "Claude Code" section, Claude Code's own settings file; `claudecode` and
 * `claude-code` are the spellings anyone would reach for next.
 */
export type LegacySectionId = 'claude' | 'claudecode' | 'claude-code'

/** Anything `openSettings` takes. */
export type SettingsTarget = SettingsPageId | LegacySectionId | SettingsLocation

export interface SettingsPageDef {
  id: SettingsPageId
  label: string
  /** The nav row's tooltip, and a search field. */
  hint: string
  keywords: readonly string[]
}

/*
 * In the order the menu draws them, which is also the order search breaks ties
 * in. `agent` is a template: its label is the agent's.
 */
export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    hint: 'Theme, and how big everything is',
    keywords: ['look', 'theme', 'dark mode', 'light mode', 'scale', 'zoom', 'wallpaper']
  },
  {
    id: 'terminal',
    label: 'Terminal',
    hint: 'Font, line height, cursor, and the frame',
    keywords: ['font', 'typeface', 'text size', 'cursor', 'xterm']
  },
  {
    id: 'profiles',
    label: 'Profiles',
    hint: 'Per-folder colours and scan roots',
    keywords: ['accent', 'folder colour', 'workspace', 'new profile']
  },
  {
    id: 'sessions',
    label: 'Sessions',
    hint: 'Where a new session opens, and what it tells you',
    keywords: ['new session', 'notifications', 'status line', 'default folder']
  },
  {
    id: 'agents',
    label: 'Agent manager',
    hint: 'Install agents, choose which the launcher shows, the default agent, and each one’s colour',
    keywords: ['agents', 'install', 'download', 'launcher', 'colours', 'coding agents', 'cli']
  },
  {
    id: 'agent',
    label: 'Agent',
    hint: 'Where it sends requests, its default model, accounts, tools and tab tag',
    keywords: []
  },
  {
    id: 'claude-launch',
    label: 'Launch defaults',
    hint: 'The permissions, model, effort and Ultracode every new Claude Code session starts with',
    keywords: ['permissions', 'model', 'effort', 'ultracode', 'defaults', 'new session']
  },
  {
    id: 'claude-settings',
    label: 'Claude Code settings',
    hint: 'What Claude Code keeps in ~/.claude/settings.json',
    keywords: ['settings.json', 'config', 'claude config', 'cli settings', '~/.claude']
  },
  {
    id: 'providers',
    label: 'Provider & keys',
    hint: 'Claude Code’s API keys and gateway, and the shared OpenRouter key',
    keywords: ['api key', 'keys', 'providers', 'anthropic', 'openrouter', 'gateway', 'auth', 'token']
  },
  {
    id: 'chats',
    label: 'Chat history',
    hint: 'A searchable copy of your AI chats: which tools, how much, and where the copy is',
    keywords: ['chats', 'conversations', 'history', 'index', 'transcripts', 'search chats']
  },
  {
    id: 'voice',
    label: 'Voice',
    hint: 'The microphone, Claude Code’s /voice, and Stoke’s dictation and who transcribes it',
    keywords: ['microphone', 'mic', 'dictation', 'speech', 'transcription', 'whisper', 'talk']
  },
  {
    id: 'projects',
    label: 'Projects',
    hint: 'Which folders the sidebar scans',
    keywords: ['folders', 'scan', 'hidden', 'sidebar', 'repositories']
  },
  {
    id: 'hosts',
    label: 'SSH hosts',
    hint: 'Remote machines to open sessions on',
    keywords: ['ssh', 'remote', 'server', 'machine', 'host']
  },
  {
    id: 'browser',
    label: 'Browser',
    hint: 'Profiles for the docked browser, each with its own logins',
    keywords: ['cookies', 'logins', 'chrome', 'safari', 'import', 'bookmarks', 'web']
  },
  {
    id: 'worklog',
    label: 'Worklog',
    hint: 'The Notion / ClickUp review queue',
    keywords: ['notion', 'clickup', 'review', 'tasks']
  },
  {
    id: 'remote',
    label: 'Phone access',
    hint: 'Reaching this window from a phone',
    keywords: ['phone', 'mobile', 'remote', 'tunnel', 'cloudflare', 'tailscale', 'qr code']
  },
  {
    id: 'updates',
    label: 'Updates',
    hint: 'Stoke, the CLI, and where it lives',
    keywords: ['version', 'upgrade', 'beta', 'release', 'cli path', 'stoke command']
  },
  {
    id: 'account',
    label: 'Account & sync',
    hint: 'Stoke Hub: keep settings, API keys, SSH hosts and chosen SSH keys in step across your computers',
    keywords: ['stoke hub', 'hub', 'sync', 'account', 'sign in', 'log in', 'devices', 'vault', 'recovery kit', 'other machines', 'remote', 'nuc', 'transfer keys']
  },
  {
    id: 'backup',
    label: 'Backup & transfer',
    hint: 'Where your API keys are kept, and a passphrase-sealed file that moves this setup to another computer',
    keywords: ['export', 'import', 'setup file', 'keys', 'secrets', 'keychain', 'transfer', 'new computer']
  }
]

export const SETTINGS_PAGE_IDS: readonly SettingsPageId[] = SETTINGS_PAGES.map((p) => p.id)

export function pageDef(id: SettingsPageId): SettingsPageDef {
  return SETTINGS_PAGES.find((p) => p.id === id) ?? SETTINGS_PAGES[0]
}

function agentLabel(id: CodingCliId): string {
  return CODING_CLIS.find((c) => c.id === id)?.label ?? id
}

/* -------------------------------------------------------------------- tree */

/** The Agents disclosure. Not a page: it only opens and closes. */
export const AGENTS_NODE = 'agents-menu'

/** Claude Code's node: its own page, and the parent of its three sub-pages. */
export const CLAUDE_NODE = 'agent:claude'

/** The pages under Claude Code, in menu order. */
export const CLAUDE_SUBPAGES: readonly SettingsPageId[] = ['claude-launch', 'claude-settings', 'providers']

export interface NavNode {
  /** A page id, `agent:<id>`, or `AGENTS_NODE`. Unique in the tree. */
  id: string
  label: string
  hint: string
  /** Where selecting it goes; null for a node that only opens (Agents). */
  loc: SettingsLocation | null
  /** The agent a node stands for, for its colour dot. */
  agent?: CodingCliId
  children?: NavNode[]
}

export interface NavGroup {
  title: string
  nodes: NavNode[]
}

function pageNode(id: SettingsPageId): NavNode {
  const p = pageDef(id)
  return { id, label: p.label, hint: p.hint, loc: { page: id } }
}

function agentNode(id: CodingCliId): NavNode {
  const node: NavNode = {
    id: `agent:${id}`,
    label: agentLabel(id),
    hint: `${agentLabel(id)}: where it sends requests, its default model, accounts, tools and tab tag`,
    loc: { page: 'agent', agent: id },
    agent: id
  }
  if (id === 'claude') {
    node.hint = 'Claude Code: its accounts, tools and tab tag — and under it, its launch defaults, its own settings and its keys'
    node.children = CLAUDE_SUBPAGES.map(pageNode)
  }
  return node
}

/**
 * The agents the menu lists under Agents: Claude Code first, always — its
 * launch defaults, settings file and keys live under it whether or not the CLI
 * answered yet — then every other INSTALLED agent in table order. `extra` is an
 * agent whose page is open without being installed (reached from the manager),
 * so the page on screen always has a row in the menu.
 */
export function navAgents(installed: ReadonlySet<CodingCliId>, extra?: CodingCliId | null): CodingCliId[] {
  const out: CodingCliId[] = ['claude']
  for (const c of CODING_CLIS) if (c.id !== 'claude' && (installed.has(c.id) || c.id === extra)) out.push(c.id)
  return out
}

/*
 * The groups and their order are the old menu's, with Agents in the place the
 * old Agents row had and the separate Claude Code and Providers rows folded
 * into it.
 */
export function navTree(agents: readonly CodingCliId[]): NavGroup[] {
  return [
    { title: 'Appearance', nodes: ['appearance', 'terminal', 'profiles'].map((id) => pageNode(id as SettingsPageId)) },
    {
      title: 'Configuration',
      nodes: [
        pageNode('sessions'),
        {
          id: AGENTS_NODE,
          label: 'Agents',
          hint: 'Your coding agents, and the Agent manager that installs them',
          loc: null,
          children: [pageNode('agents'), ...agents.map(agentNode)]
        },
        ...(['chats', 'voice', 'projects', 'hosts', 'browser'] as const).map(pageNode)
      ]
    },
    { title: 'Integrations', nodes: [pageNode('worklog'), pageNode('remote')] },
    { title: 'System', nodes: [pageNode('updates'), pageNode('account'), pageNode('backup')] }
  ]
}

/** The node a location selects. */
export function nodeIdOf(loc: SettingsLocation): string {
  return loc.page === 'agent' ? `agent:${loc.agent ?? 'claude'}` : loc.page
}

/**
 * The nodes that must be open for `loc`'s row to be on screen, outermost
 * first. Pure: it does not need the tree, because only two nodes ever open.
 */
export function ancestorsOf(loc: SettingsLocation): string[] {
  if (CLAUDE_SUBPAGES.includes(loc.page)) return [AGENTS_NODE, CLAUDE_NODE]
  if (loc.page === 'agents' || loc.page === 'agent') return [AGENTS_NODE]
  return []
}

/** The labels from the menu's top down to `loc`, for a breadcrumb or a search result. */
export function pathOf(loc: SettingsLocation): string[] {
  if (CLAUDE_SUBPAGES.includes(loc.page)) return ['Agents', 'Claude Code', pageDef(loc.page).label]
  if (loc.page === 'agent') return ['Agents', agentLabel(loc.agent ?? 'claude')]
  if (loc.page === 'agents') return ['Agents', pageDef('agents').label]
  return [pageDef(loc.page).label]
}

/** One visible row of the tree, flattened in the order it is drawn. */
export interface VisibleNode {
  node: NavNode
  /** 1 for a group's own rows. */
  level: number
  /** The node it sits under, or null at the top of a group. */
  parent: string | null
  setSize: number
  posInSet: number
  group: string
}

/**
 * What the menu shows with `expanded` open: every group's nodes, and the
 * children of each open node, depth first. The arrow keys walk exactly this
 * list, so it is the one order the keyboard and the eye agree on.
 */
export function visibleNodes(tree: readonly NavGroup[], expanded: ReadonlySet<string>): VisibleNode[] {
  const out: VisibleNode[] = []
  const walk = (nodes: readonly NavNode[], level: number, parent: string | null, group: string): void => {
    nodes.forEach((node, i) => {
      out.push({ node, level, parent, setSize: nodes.length, posInSet: i + 1, group })
      if (node.children && expanded.has(node.id)) walk(node.children, level + 1, node.id, group)
    })
  }
  for (const g of tree) walk(g.nodes, 1, null, g.title)
  return out
}

/**
 * The node that holds `loc` on screen: its own when visible, else the nearest
 * closed ancestor, so a collapsed Agents still says the page is in it.
 */
export function visibleHolder(visible: readonly VisibleNode[], loc: SettingsLocation): string | null {
  const own = nodeIdOf(loc)
  if (visible.some((v) => v.node.id === own)) return own
  for (const a of [...ancestorsOf(loc)].reverse()) if (visible.some((v) => v.node.id === a)) return a
  return null
}

/* ----------------------------------------------------- where old ids land */

/**
 * Where any `openSettings` argument lands. Every old section id is still a
 * valid target: the ones that are still page ids are themselves (Providers is
 * under Claude Code now, and `providers` still opens it); `claude`, the old
 * "Claude Code" section, is Claude Code's settings page; `agents`, the old
 * Agents section, is the Agent manager. An unknown string opens Appearance
 * rather than a blank pane.
 */
export function resolveSettingsTarget(target: SettingsTarget | null | undefined): SettingsLocation {
  if (!target) return { page: 'appearance' }
  if (typeof target === 'object') {
    if (target.page === 'agent') return target.agent ? { page: 'agent', agent: target.agent } : { page: 'agents' }
    return SETTINGS_PAGE_IDS.includes(target.page) ? { page: target.page } : { page: 'appearance' }
  }
  if (target === 'claude' || target === 'claudecode' || target === 'claude-code') return { page: 'claude-settings' }
  if (target === 'agent') return { page: 'agents' }
  return SETTINGS_PAGE_IDS.includes(target) ? { page: target } : { page: 'appearance' }
}

export function sameLocation(a: SettingsLocation, b: SettingsLocation): boolean {
  return a.page === b.page && (a.page !== 'agent' || (a.agent ?? 'claude') === (b.agent ?? 'claude'))
}

/* -------------------------------------------------------------------- rows */

export interface SettingRow {
  /** `<page>.<name>`, or `agent.<name>` for a row every agent's page draws. */
  id: string
  page: SettingsPageId
  /** What search shows and matches first. Worded as the sheet words it, or clearer. */
  label: string
  keywords: readonly string[]
  /**
   * The row a jump lands on when this one is not drawn right now — a key field
   * that exists only in one auth mode lands on the mode.
   */
  fallback?: string
  /** For `agent.*` rows: which agents' pages draw it. Absent means every agent. */
  agents?: (id: CodingCliId) => boolean
  /**
   * The platforms (`window.stoke.platform`) whose sheet draws it at all. Absent
   * means every one. A search on any other leaves it out rather than land on a
   * page where it can never be.
   */
  platforms?: readonly string[]
}

const notClaude = (id: CodingCliId): boolean => id !== 'claude'
const hasCustomEndpoint = (id: CodingCliId): boolean =>
  id !== 'claude' && (CODING_CLIS.find((c) => c.id === id)?.endpoints.custom ?? null) !== null

/*
 * Every row a component marks with a literal `data-setting` (or `settingId`)
 * attribute. In page order, and within a page in the order the page draws
 * them — search breaks ties by this order.
 */
export const SETTING_ROWS: readonly SettingRow[] = [
  // Appearance
  // Both drawn only while no theme is being edited; the editor is where a jump lands then.
  { id: 'appearance.follow-system', page: 'appearance', label: 'Follow my system', keywords: ['dark mode', 'light mode', 'auto theme', 'system appearance', 'night'], fallback: 'appearance.make-theme' },
  { id: 'appearance.theme', page: 'appearance', label: 'Theme', keywords: ['colour scheme', 'palette', 'dark', 'light', 'colours'], fallback: 'appearance.make-theme' },
  // Also the editor's own controls, drawn in its place while a theme is edited.
  { id: 'appearance.make-theme', page: 'appearance', label: 'Make your own theme', keywords: ['custom theme', 'theme editor', 'duplicate theme', 'accent colour', 'theme name', 'hue', 'page colour', 'tint', 'colour notation', 'true black', 'oled'] },
  { id: 'appearance.claude-theme', page: 'appearance', label: 'Draw Claude Code in this theme’s colours', keywords: ['ansi', 'claude theme', 'terminal colours'] },
  { id: 'appearance.wallpaper', page: 'appearance', label: 'Wallpaper', keywords: ['background image', 'blur', 'dim', 'panel opacity', 'picture', 'photo'] },
  { id: 'appearance.brand', page: 'appearance', label: 'Show the Stoke mark in the title bar', keywords: ['logo', 'brand', 'title bar'] },
  { id: 'appearance.interface-scale', page: 'appearance', label: 'Interface scale', keywords: ['zoom', 'ui size', 'bigger', 'smaller', 'text size'] },
  { id: 'appearance.zoom-keys', page: 'appearance', label: 'Zoom keys change', keywords: ['zoom', 'keyboard shortcut', 'cmd plus', 'ctrl plus'] },
  { id: 'appearance.full-screen', page: 'appearance', label: 'Menu bar in full screen', keywords: ['fullscreen', 'menu bar', 'tabs', 'macos'] },

  // Terminal
  { id: 'terminal.font', page: 'terminal', label: 'Font', keywords: ['font family', 'typeface', 'monospace', 'nerd font'] },
  { id: 'terminal.font-size', page: 'terminal', label: 'Font size', keywords: ['text size', 'bigger text', 'smaller text'] },
  { id: 'terminal.line-height', page: 'terminal', label: 'Line height', keywords: ['leading', 'line spacing'] },
  { id: 'terminal.letter-spacing', page: 'terminal', label: 'Letter spacing', keywords: ['tracking', 'character spacing'] },
  { id: 'terminal.cursor', page: 'terminal', label: 'Cursor', keywords: ['cursor shape', 'blink', 'bar', 'block', 'underline'] },
  { id: 'terminal.bold-weight', page: 'terminal', label: 'Bold weight', keywords: ['bold', 'semibold', 'font weight'] },
  { id: 'terminal.contrast', page: 'terminal', label: 'Text contrast', keywords: ['minimum contrast', 'accessibility', 'aa', 'aaa', 'dim text', 'readability'] },
  { id: 'terminal.smooth-scroll', page: 'terminal', label: 'Smooth scrolling', keywords: ['scroll', 'scrolling'] },
  { id: 'terminal.frame', page: 'terminal', label: 'Frame the terminal', keywords: ['card', 'border', 'rounded'] },
  { id: 'terminal.padding', page: 'terminal', label: 'Inner padding', keywords: ['padding', 'margin', 'inset'] },

  // Profiles
  { id: 'profiles.list', page: 'profiles', label: 'Your profiles', keywords: ['accent', 'colour', 'folder', 'scan root', 'new profile', 'workspace'] },

  // Sessions
  { id: 'sessions.default-folder', page: 'sessions', label: 'Default folder', keywords: ['working directory', 'cwd', 'start here', 'home folder'] },
  { id: 'sessions.start-on-launch', page: 'sessions', label: 'Start a session on launch', keywords: ['startup', 'auto start', 'open on launch'] },
  { id: 'sessions.notifications', page: 'sessions', label: 'Notify me when Claude finishes', keywords: ['notifications', 'alert', 'done', 'finished', 'system notification'] },
  { id: 'sessions.status-line', page: 'sessions', label: 'Hide Claude’s status line in Stoke', keywords: ['status line', 'statusline', 'usage', 'plan limits', 'context'] },

  // Agents › Agent manager
  { id: 'agents.default', page: 'agents', label: 'Default agent', keywords: ['new session', 'start', 'default cli', 'choose agents', 'look again', 'detect'] },
  { id: 'agents.list', page: 'agents', label: 'Your agents', keywords: ['installed', 'colour', 'agent colours', 'show in launcher', 'hide agent', 'launcher'] },
  // Drawn only while some agent is not installed.
  { id: 'agents.more', page: 'agents', label: 'More agents', keywords: ['install', 'download', 'not installed', 'add agent', 'get'], fallback: 'agents.list' },
  { id: 'agents.tags', page: 'agents', label: 'Show agent tags on tabs', keywords: ['tab tag', 'tabs', 'label'] },
  { id: 'agents.skills', page: 'agents', label: 'Skills', keywords: ['skill.md', 'shared skills', 'plugins', 'lend claude code the shared skills'] },

  // Agents › <an agent>
  { id: 'agent.endpoint', page: 'agent', label: 'Where it sends requests', keywords: ['endpoint', 'openrouter', 'provider', 'base url'], agents: notClaude },
  { id: 'agent.custom-endpoint', page: 'agent', label: 'Custom endpoint', keywords: ['base url', 'api key', 'server', 'local model'], agents: hasCustomEndpoint, fallback: 'agent.endpoint' },
  { id: 'agent.model', page: 'agent', label: 'Default model', keywords: ['model'], agents: notClaude },
  { id: 'agent.accounts', page: 'agent', label: 'Accounts', keywords: ['sign in', 'login', 'account', 'api key', 'work account', 'second account'] },
  { id: 'agent.tools', page: 'agent', label: 'Tools (MCP)', keywords: ['mcp', 'servers', 'tools', 'browser tools'] },
  // Drawn as "In the tab strip".
  { id: 'agent.look', page: 'agent', label: 'Colour and tab tag', keywords: ['colour', 'tab tag', 'tag', 'label', 'tab strip'] },

  // Agents › Claude Code › Launch defaults
  { id: 'claude-launch.permissions', page: 'claude-launch', label: 'Default permissions', keywords: ['permission mode', 'bypass', 'plan mode', 'accept edits', 'yolo', 'dangerously skip'] },
  { id: 'claude-launch.model', page: 'claude-launch', label: 'Default model', keywords: ['opus', 'sonnet', 'haiku', 'claude model'] },
  { id: 'claude-launch.effort', page: 'claude-launch', label: 'Default effort', keywords: ['thinking', 'effort level', 'reasoning'] },
  { id: 'claude-launch.ultracode', page: 'claude-launch', label: 'Start sessions with Ultracode', keywords: ['ultracode', 'max effort'] },

  // Agents › Claude Code › Provider & keys
  { id: 'providers.auth-mode', page: 'providers', label: 'Auth mode', keywords: ['authentication', 'login', 'api key', 'claude.ai', 'subscription', 'gateway', 'openrouter'] },
  { id: 'providers.anthropic-key', page: 'providers', label: 'Anthropic API key', keywords: ['anthropic_api_key', 'console key', 'claude api key'], fallback: 'providers.auth-mode' },
  { id: 'providers.openrouter-key', page: 'providers', label: 'OpenRouter API key', keywords: ['openrouter key', 'shared key'], fallback: 'providers.auth-mode' },
  { id: 'providers.gateway-models', page: 'providers', label: 'Gateway model picker', keywords: ['model discovery', 'openrouter models'], fallback: 'providers.auth-mode' },
  { id: 'providers.gateway-url', page: 'providers', label: 'Gateway base URL', keywords: ['custom gateway', 'base url', 'anthropic_base_url', 'proxy', 'endpoint'], fallback: 'providers.auth-mode' },
  { id: 'providers.gateway-token', page: 'providers', label: 'Gateway bearer token', keywords: ['auth token', 'anthropic_auth_token', 'api key'], fallback: 'providers.auth-mode' },

  // Chat history
  { id: 'chats.enabled', page: 'chats', label: 'Keep a searchable copy of my AI chats', keywords: ['chat history', 'index chats', 'on', 'off'] },
  // Also holds "Include subagent chats" and "Leave out anything that looks like an API key".
  {
    id: 'chats.sources',
    page: 'chats',
    label: 'Where Stoke looks',
    keywords: ['sources', 'codex', 'chatgpt', 'claude.ai', 'tools', 'include subagent chats', 'leave out anything that looks like an api key', 'redact', 'secrets', 'api key', 'private key']
  },
  { id: 'chats.imported', page: 'chats', label: 'Imported chats', keywords: ['import', 'export', 'chatgpt export', 'claude.ai export', 'zip'] },
  { id: 'chats.limits', page: 'chats', label: 'Limits', keywords: ['how much', 'size', 'cap', 'preset'] },
  { id: 'chats.index', page: 'chats', label: 'The index', keywords: ['database', 'sqlite', 'rebuild', 'delete copy', 'storage'] },

  // Voice
  { id: 'voice.mic-access', page: 'voice', label: 'Microphone access', keywords: ['permission', 'privacy', 'allow microphone'], fallback: 'voice.microphone' },
  { id: 'voice.claude-voice', page: 'voice', label: 'Claude Code’s /voice', keywords: ['/voice', 'voice mode', 'hold space'] },
  { id: 'voice.dictation', page: 'voice', label: 'Stoke’s dictation', keywords: ['dictate', 'speech to text', 'keyboard shortcut'] },
  { id: 'voice.microphone', page: 'voice', label: 'Microphone for Stoke’s dictation', keywords: ['mic', 'input device', 'audio', 'test microphone'] },
  { id: 'voice.hold', page: 'voice', label: 'Hold Space for', keywords: ['hold threshold', 'push to talk', 'space bar'] },
  { id: 'voice.service', page: 'voice', label: 'Speech service', keywords: ['transcription', 'provider', 'whisper', 'stt', 'speech to text'] },
  { id: 'voice.server', page: 'voice', label: 'Speech server address', keywords: ['sidecar', 'url', 'local server'], fallback: 'voice.service' },
  { id: 'voice.base-url', page: 'voice', label: 'Speech server base URL', keywords: ['custom', 'url', 'endpoint'], fallback: 'voice.service' },
  { id: 'voice.model', page: 'voice', label: 'Speech model', keywords: ['whisper model', 'transcription model'], fallback: 'voice.service' },
  { id: 'voice.key', page: 'voice', label: 'Speech service API key', keywords: ['api key', 'openai key', 'groq key'], fallback: 'voice.service' },
  { id: 'voice.test', page: 'voice', label: 'Test the speech service', keywords: ['test', 'check dictation'] },

  // Projects
  { id: 'projects.roots', page: 'projects', label: 'Scanned folders', keywords: ['scan', 'add folder', 'code directory', 'roots'] },
  { id: 'projects.hidden', page: 'projects', label: 'Hidden projects', keywords: ['hide', 'unhide', 'show again'] },

  // SSH hosts
  /*
   * Also every machine's own controls, each inside its row's disclosure: its
   * name and alias, the command it runs on connect, keeping its sessions
   * running (tmux), writing up its work, and the key offer.
   */
  {
    id: 'hosts.list',
    page: 'hosts',
    label: 'Remote machines',
    keywords: ['ssh hosts', 'add host', 'server', 'alias', 'ssh config', 'command on connect', 'keep sessions running', 'kept session', 'persistent', 'tmux', 'byobu', 'write up work done', 'worklog', 'offer to add a key', 'asks for a password']
  },
  { id: 'hosts.key-enroll', page: 'hosts', label: 'When a remote asks for a password', keywords: ['ssh key', 'key login', 'password', 'ssh-copy-id'] },

  // Browser
  { id: 'browser.profiles', page: 'browser', label: 'Browser profiles', keywords: ['logins', 'cookies', 'site data', 'profile'] },
  // macOS and Windows only (BrowserSettings); `platforms` keeps it out of a Linux search.
  { id: 'browser.import', page: 'browser', label: 'Import from other browsers', keywords: ['chrome', 'safari', 'edge', 'arc', 'brave', 'cookies', 'logins', 'bookmarks'], platforms: ['darwin', 'win32'], fallback: 'browser.profiles' },

  // Worklog
  { id: 'worklog.agent', page: 'worklog', label: 'Worklog agent', keywords: ['review', 'notion', 'clickup', 'profiles'] },
  { id: 'worklog.auto', page: 'worklog', label: 'Scan while I work', keywords: ['automatic', 'auto scan', 'background'] },
  { id: 'worklog.targets', page: 'worklog', label: 'Where reviews are filed', keywords: ['notion', 'clickup', 'destination'] },
  { id: 'worklog.notion', page: 'worklog', label: 'Notion data source', keywords: ['notion id', 'database'] },
  { id: 'worklog.clickup', page: 'worklog', label: 'ClickUp list id', keywords: ['clickup id', 'list'] },

  // Phone access
  { id: 'remote.enabled', page: 'remote', label: 'Open on phone', keywords: ['phone access', 'turn on', 'qr code', 'link', 'turn off'] },
  { id: 'remote.reach', page: 'remote', label: 'Reach it from', keywords: ['wifi', 'lan', 'tailscale', 'tunnel', 'anywhere'] },
  // Drawn as "Reach it from outside your network", a disclosure that also holds the tunnel log.
  { id: 'remote.tunnel', page: 'remote', label: 'Cloudflare tunnel', keywords: ['cloudflared', 'named tunnel', 'hostname', 'domain', 'reach it from outside your network', 'tunnel log'] },
  { id: 'remote.hostname', page: 'remote', label: 'Public hostname', keywords: ['domain', 'url'], fallback: 'remote.tunnel' },
  { id: 'remote.tunnel-name', page: 'remote', label: 'Tunnel name', keywords: ['cloudflared name'], fallback: 'remote.tunnel' },
  { id: 'remote.tunnel-auto', page: 'remote', label: 'Start the tunnel whenever phone access is on', keywords: ['auto start tunnel'], fallback: 'remote.tunnel' },
  // Also holds the team domain and AUD tag fields.
  { id: 'remote.access', page: 'remote', label: 'Require Cloudflare Access', keywords: ['zero trust', 'jwt', 'sso', 'access policy', 'team domain', 'aud', 'audience tag', 'application audience'], fallback: 'remote.tunnel' },
  { id: 'remote.port', page: 'remote', label: 'Port', keywords: ['server port', 'listen'] },
  { id: 'remote.key', page: 'remote', label: 'Phone access key', keywords: ['token', 'bearer', 'new key', 'secret'] },

  // Updates
  { id: 'updates.stoke', page: 'updates', label: 'Stoke updates', keywords: ['self update', 'new version', 'restart and install', 'release'] },
  { id: 'updates.background', page: 'updates', label: 'Download updates in the background', keywords: ['auto update', 'automatic'], fallback: 'updates.stoke' },
  { id: 'updates.beta', page: 'updates', label: 'Offer beta releases', keywords: ['beta', 'prerelease', 'channel'], fallback: 'updates.stoke' },
  { id: 'updates.command', page: 'updates', label: 'Command line', keywords: ['stoke command', 'terminal', 'path', 'cli'] },
  { id: 'updates.cli', page: 'updates', label: 'Claude Code CLI', keywords: ['claude version', 'claude update', 'cli version'] },
  { id: 'updates.cli-auto', page: 'updates', label: 'Keep the CLI up to date automatically', keywords: ['auto update', 'claude update'] },
  { id: 'updates.cli-relaunch', page: 'updates', label: 'After the CLI updates', keywords: ['relaunch', 'restart sessions'] },
  { id: 'updates.cli-path', page: 'updates', label: 'Claude CLI path', keywords: ['claude executable', 'where is claude', 'not found', 'binary'] },

  // Backup & transfer
  { id: 'account.overview', page: 'account', label: 'Stoke Hub status', keywords: ['sync status', 'signed in', 'hub', 'in sync', 'conflict', 'sync stopped', 'waiting for you on this computer', 'waiting to join', 'changed in two places'] },
  { id: 'account.create-vault', page: 'account', label: 'Create your vault', keywords: ['vault', 'first device', 'recovery kit', 'encryption'], fallback: 'account.overview' },
  { id: 'account.join', page: 'account', label: 'Join your vault', keywords: ['pair', 'pairing code', 'approve device', 'new computer', 'recovery kit'], fallback: 'account.overview' },
  { id: 'account.address', page: 'account', label: 'Hub address', keywords: ['hub url', 'server', 'nuc', 'stoke.vinn.dev', 'self-hosted'], fallback: 'account.overview' },
  { id: 'account.sign-in', page: 'account', label: 'Sign in to Stoke Hub', keywords: ['log in', 'login', 'create account', 'invite', 'password', 'email'], fallback: 'account.overview' },
  { id: 'account.syncing', page: 'account', label: 'What syncs', keywords: ['sync settings', 'sync api keys', 'ssh hosts', 'sync now', 'api keys, for the whole account', 'api keys on this computer'], fallback: 'account.overview' },
  { id: 'account.ssh-keys', page: 'account', label: 'SSH keys', keywords: ['share ssh key', 'private key', 'transfer ssh', 'id_ed25519'], fallback: 'account.overview' },
  { id: 'account.devices', page: 'account', label: 'Your devices', keywords: ['remove device', 'revoke', 'rename device', 'computers'], fallback: 'account.overview' },
  { id: 'account.other-machines', page: 'account', label: 'Other machines', keywords: ['remote sessions', 'open sessions elsewhere', 'share sessions', 'relay', 'let my other devices see and open my sessions'], fallback: 'account.overview' },
  { id: 'account.recovery', page: 'account', label: 'Recovery Kit', keywords: ['recovery code', 'lost device', 'new kit'], fallback: 'account.overview' },
  { id: 'account.sign-out', page: 'account', label: 'Sign out of Stoke Hub', keywords: ['log out', 'logout', 'disconnect hub'], fallback: 'account.overview' },
  { id: 'backup.storage', page: 'backup', label: 'Where your keys live', keywords: ['keychain', 'secrets', 'encryption', 'api keys', 'safe storage'] },
  { id: 'backup.export', page: 'backup', label: 'Export this setup', keywords: ['backup', 'setup file', 'passphrase', 'another computer', 'transfer', 'include api keys'] },
  { id: 'backup.import', page: 'backup', label: 'Import a setup', keywords: ['restore', 'setup file', 'transfer'] }
]

/*
 * The two row families a component draws from a table rather than one by one.
 * Each is marked with a call (`data-setting={claudeSettingRowId(spec.key)}`)
 * that the suite looks for, and each is listed here from that same table, so
 * the list and the rows are one source.
 */

/** A Claude Code settings-file row: one per `CLAUDE_SETTINGS` key, plus the workflow size. */
export function claudeSettingRowId(key: string): string {
  return `claude-settings.${key}`
}

/** An agent's row in the Agent manager, installed or under More agents. */
export function agentRowId(id: CodingCliId): string {
  return `agents.agent.${id}`
}

export function claudeSettingRows(): SettingRow[] {
  return [
    ...CLAUDE_SETTINGS.map((s) => ({
      id: claudeSettingRowId(s.key),
      page: 'claude-settings' as const,
      label: s.label,
      keywords: [s.key, s.group.toLowerCase()]
    })),
    {
      id: claudeSettingRowId(WORKFLOW_SIZE_KEY),
      page: 'claude-settings' as const,
      label: 'Dynamic workflow size',
      keywords: [WORKFLOW_SIZE_KEY, 'subagents', 'workflows']
    }
  ]
}

/** Every row id the sheet can hold, static and generated — what the suite checks marks against. */
export function allRowIds(): string[] {
  return [...SETTING_ROWS.map((r) => r.id), ...claudeSettingRows().map((r) => r.id), ...CODING_CLIS.map((c) => agentRowId(c.id))]
}

export function rowById(id: string): SettingRow | undefined {
  return SETTING_ROWS.find((r) => r.id === id) ?? claudeSettingRows().find((r) => r.id === id)
}

/* ------------------------------------------------------------------ search */

/** What a search can land on: a page, or one row on it. */
export interface SettingsEntry {
  /** Unique across one search's entries. */
  key: string
  loc: SettingsLocation
  /** The row to scroll to and flash, or null for the page itself. */
  row: string | null
  /** Where to land when `row` is not drawn right now. */
  fallback: string | null
  label: string
  /** Menu labels above it: `['Agents', 'Claude Code', 'Provider & keys']` for a row there. */
  path: string[]
  keywords: readonly string[]
  hint: string
}

export interface SettingsContext {
  /** The agents with a page in the menu (`navAgents`); Claude Code at least. */
  agents: readonly CodingCliId[]
  /** `window.stoke.platform`, for rows drawn only on some (`SettingRow.platforms`). Absent: every row. */
  platform?: string
}

/**
 * Everything a search can find, for the agents this machine has. An agent the
 * menu lists is found as its page and its page's rows are found once per such
 * agent; one it does not list is found as its row in the Agent manager, which
 * is where it is installed.
 */
export function settingsEntries(ctx: SettingsContext): SettingsEntry[] {
  const out: SettingsEntry[] = []
  const listed = new Set<CodingCliId>(ctx.agents.length ? ctx.agents : ['claude'])
  const drawnHere = (r: SettingRow): boolean => !r.platforms || !ctx.platform || r.platforms.includes(ctx.platform)
  const rowsOf = (page: SettingsPageId): SettingRow[] =>
    page === 'claude-settings' ? claudeSettingRows() : SETTING_ROWS.filter((r) => r.page === page && drawnHere(r))
  const pageEntry = (loc: SettingsLocation, label: string, keywords: readonly string[], hint: string): void => {
    const path = pathOf(loc)
    out.push({ key: `page:${nodeIdOf(loc)}`, loc, row: null, fallback: null, label, path: path.slice(0, -1), keywords, hint })
  }
  const rowEntry = (loc: SettingsLocation, r: SettingRow, extraKeywords: readonly string[] = []): void => {
    out.push({
      key: `row:${r.id}${loc.page === 'agent' ? `@${loc.agent}` : ''}`,
      loc,
      row: r.id,
      fallback: r.fallback ?? null,
      label: r.label,
      path: pathOf(loc),
      keywords: [...r.keywords, ...extraKeywords],
      hint: ''
    })
  }

  for (const p of SETTINGS_PAGES) {
    if (p.id === 'agent') {
      for (const c of CODING_CLIS) {
        if (!listed.has(c.id)) continue
        const loc: SettingsLocation = { page: 'agent', agent: c.id }
        pageEntry(loc, c.label, [c.vendor, ...c.bins.posix, 'agent'], c.blurb)
        for (const r of SETTING_ROWS) {
          if (r.page !== 'agent' || (r.agents && !r.agents(c.id)) || !drawnHere(r)) continue
          rowEntry(loc, r, [c.label])
        }
      }
      continue
    }
    const loc: SettingsLocation = { page: p.id }
    pageEntry(loc, p.label, p.keywords, p.hint)
    for (const r of rowsOf(p.id)) rowEntry(loc, r)
    if (p.id === 'agents') {
      for (const c of CODING_CLIS) {
        if (listed.has(c.id)) continue
        out.push({
          key: `row:${agentRowId(c.id)}`,
          loc,
          row: agentRowId(c.id),
          fallback: 'agents.more',
          label: c.label,
          path: pathOf(loc),
          keywords: [c.vendor, ...c.bins.posix, 'install', 'agent'],
          hint: c.blurb
        })
      }
    }
  }
  return out
}

export type Range = readonly [start: number, end: number]

export interface SettingsHit {
  entry: SettingsEntry
  /** Higher is better; see `searchSettings`. */
  score: number
  /** Where the query lands in `entry.label`, for a highlight. */
  ranges: Range[]
}

/* Folding: lower case, no accents, curly apostrophes straight. */
interface Folded {
  text: string
  /** Original index of each folded code unit's character, and the end of it. */
  from: number[]
  to: number[]
}

function fold(text: string): Folded {
  let out = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  for (const ch of text) {
    const next = at + ch.length
    const f = ch
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[‘’ʼ]/g, "'")
    for (let k = 0; k < f.length; k++) {
      from.push(at)
      to.push(next)
    }
    out += f
    at = next
  }
  return { text: out, from, to }
}

function foldPlain(text: string): string {
  return fold(text).text.replace(/\s+/g, ' ').trim()
}

/*
 * Words spelled two ways. British spelling is the sheet's own, and a search for
 * "color" should not come back empty because of it. Singular only: a plural is
 * folded to its singular first (`singulars`).
 */
const SPELLINGS: Record<string, string> = {
  color: 'colour',
  gray: 'grey',
  customize: 'customise',
  behavior: 'behaviour',
  center: 'centre',
  dialog: 'dialogue',
  favorite: 'favourite',
  license: 'licence'
}

/*
 * What people type for something the sheet names differently. Each query word
 * on the left — or its singular — also tries the words on the right; the match
 * is scored as a synonym, a step below the word itself.
 */
const SYNONYMS: Record<string, readonly string[]> = {
  mic: ['microphone'],
  microphone: ['mic'],
  dark: ['theme'],
  light: ['theme'],
  apikey: ['api key'],
  key: ['api key', 'token'],
  token: ['key'],
  password: ['key', 'passphrase'],
  zoom: ['scale'],
  size: ['scale', 'font size'],
  text: ['font'],
  typeface: ['font'],
  cli: ['agent', 'command'],
  agent: ['cli'],
  login: ['sign in', 'account', 'auth'],
  signin: ['sign in', 'account'],
  account: ['sign in', 'login'],
  mobile: ['phone'],
  phone: ['mobile', 'remote'],
  notification: ['notify'],
  alert: ['notify'],
  voice: ['dictation', 'microphone', 'speech'],
  dictate: ['dictation'],
  speech: ['voice', 'dictation'],
  upgrade: ['update'],
  version: ['update'],
  backup: ['export'],
  restore: ['import'],
  server: ['host', 'remote'],
  machine: ['host', 'remote'],
  colour: ['accent'],
  mcp: ['tools'],
  secret: ['key'],
  keyboard: ['shortcut']
}

/**
 * What a plural word would be in the singular, for a word of four letters or
 * more: "fonts" is font, "boxes" box, "entries" entry, "cookies" cookie. Every
 * row is named in the singular ("Font", "Theme", "ssh key"), and a query word
 * has to land as the start of a word, so without this "fonts" and "ssh keys"
 * found nothing at all. A guess, not a dictionary: a wrong one ("status" to
 * "statu") only ever tries a prefix of the word typed, which matches wherever
 * the word itself would.
 */
function singulars(word: string): string[] {
  if (word.length < 4 || !word.endsWith('s') || word.endsWith('ss')) return []
  const out = [word.slice(0, -1)]
  if (/(?:s|x|z|ch|sh)es$/.test(word)) out.push(word.slice(0, -2))
  if (word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`)
  return out
}

function spelledOtherwise(word: string): string | undefined {
  return SPELLINGS[word] ?? Object.keys(SPELLINGS).find((k) => SPELLINGS[k] === word)
}

/**
 * The ways one query word can be written, the word itself first: its other
 * spelling, then its singulars and theirs. "colors" is colors, colours,
 * color, colour.
 */
function variants(word: string): string[] {
  const out = new Set<string>([word])
  for (const w of [word, ...singulars(word)]) {
    out.add(w)
    const alt = spelledOtherwise(w)
    if (alt) out.add(alt)
  }
  return [...out]
}

/** Every synonym of every way the word can be written ("keys" gets key's). */
function synonymsOf(word: string): string[] {
  return [...new Set(variants(word).flatMap((w) => SYNONYMS[w] ?? []))]
}

/** Where `word` starts a word in `text` (after a space, punctuation, or the start). */
function wordStart(text: string, word: string): number {
  let at = text.indexOf(word)
  while (at >= 0) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) return at
    at = text.indexOf(word, at + 1)
  }
  return -1
}

/*
 * The score scale. A phrase hit on the label beats any per-word hit, a hit on
 * the label beats one on a keyword, and a keyword beats the menu path above
 * the row, which beats the page's own description. The numbers only need to
 * keep that order; `paletteTier` maps them onto the palette's project tiers.
 */
export const SETTING_SCORES = {
  exact: 100,
  labelPrefix: 90,
  labelPhrase: 80,
  keywordExact: 75,
  keywordPhrase: 70,
  labelSubstring: 60,
  words: 50
} as const

/** A word's best field, per word, when the query is not one phrase anywhere. */
const WORD_FIELD = { label: 5, keyword: 4, synonym: 3, path: 2, hint: 1 } as const

/**
 * Rank every entry against `query`. Every word of the query must land
 * somewhere in the entry — its label, a keyword, the menu path above it, or
 * (for a page) its description — as the start of a word, or anywhere for a
 * word of four letters or more (at three, "aud" was inside every "Claude" and
 * "mic" inside "Dynamic"). A plural also tries its singular, and a little
 * word that lands nowhere is passed over (`STOP_WORDS`). Entries whose whole
 * query is a phrase in the label or a keyword rank first (`SETTING_SCORES`);
 * the rest rank by their weakest word, so "font size" finds Font size before
 * a row that only mentions size. Ties go to the query as typed over its
 * singular, then keep the sheet's own order.
 */
export function searchSettings(entries: readonly SettingsEntry[], query: string): SettingsHit[] {
  const q = foldPlain(query)
  if (!q) return []
  const words = q.split(' ')
  const phrases = phraseVariants(words)
  // Little words may be passed over only beside a word that is not one.
  const carried = words.some((w) => !STOP_WORDS.has(w))
  const hits: { hit: SettingsHit; order: number; literal: boolean }[] = []
  entries.forEach((entry, order) => {
    const label = fold(entry.label)
    const keywords = entry.keywords.map(foldPlain)
    const path = foldPlain(entry.path.join(' '))
    const hint = foldPlain(entry.hint)
    let score = 0
    let ranges: Range[] = []
    /*
     * Whether the best phrase was the query as typed. Only a tie-break: "keys"
     * lists "Zoom keys change" before "Anthropic API key", which only its
     * singular found, though both are a phrase in the label.
     */
    let literal = false

    // The whole query as one phrase, in each of its spellings and numbers.
    for (const phrase of phrases) {
      let s = 0
      if (label.text === phrase) s = SETTING_SCORES.exact
      else if (label.text.startsWith(phrase)) s = SETTING_SCORES.labelPrefix
      else if (wordStart(label.text, phrase) >= 0) s = SETTING_SCORES.labelPhrase
      else if (keywords.includes(phrase)) s = SETTING_SCORES.keywordExact
      else if (keywords.some((k) => wordStart(k, phrase) >= 0)) s = SETTING_SCORES.keywordPhrase
      else if (phrase.length >= 4 && label.text.includes(phrase)) s = SETTING_SCORES.labelSubstring
      // The query as typed is the first phrase, so a tie keeps it.
      if (s > score) {
        score = s
        literal = phrase === q
        const at = label.text.indexOf(phrase)
        ranges = at >= 0 ? [toOriginal(label, at, at + phrase.length)] : []
      }
    }

    if (score === 0) {
      /*
       * Word by word: every word must land, and the weakest decides. The
       * others break a tie, a little: "codex model" finds Codex's Default
       * model (model in the label) before its Custom endpoint (model only in
       * a keyword), though Codex is a keyword to both. A little word ("on",
       * "this") that lands nowhere is passed over rather than failing the
       * row, so a label typed out whole — "Keep sessions running on this
       * machine" — finds its row by the words that carry it.
       */
      let weakest: number = WORD_FIELD.label
      let sum = 0
      let counted = 0
      const found: [number, number][] = []
      for (const w of words) {
        const best = bestField(w, label.text, keywords, path, hint)
        if (!best) {
          if (STOP_WORDS.has(w) && carried) continue
          weakest = 0
          break
        }
        weakest = Math.min(weakest, best.field)
        sum += best.field
        counted++
        if (best.at >= 0) found.push([best.at, best.at + best.length])
      }
      if (weakest > 0 && counted > 0) {
        score = SETTING_SCORES.words - 10 + weakest * 2 + (sum / counted - weakest) / 2
        ranges = merge(found.map(([s, e]) => toOriginal(label, s, e)))
      }
    }

    if (score > 0) hits.push({ hit: { entry, score, ranges }, order, literal })
  })
  hits.sort((a, b) => b.hit.score - a.hit.score || Number(b.literal) - Number(a.literal) || a.order - b.order)
  return hits.map((h) => h.hit)
}

/*
 * Words that say nothing about which setting is meant. Never dropped from a
 * phrase, and never when they land; only a word-by-word match passes over one
 * that lands nowhere.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'with', 'you', 'your'
])

/*
 * A cap on the combinations, which multiply: four words of four ways each
 * would be 256 phrases per row per keystroke, and a query that long is a
 * phrase in no row anyway — it is found word by word.
 */
const PHRASE_LIMIT = 64

/**
 * The query as a phrase, in every combination of each word's variants — so
 * "api keys" is also "api key", which is a phrase in "Anthropic API key", and
 * "keyboard colors" is also "keyboard colour". The query as typed first.
 */
function phraseVariants(words: readonly string[]): string[] {
  let out = ['']
  for (const w of words) {
    const next: string[] = []
    for (const head of out) for (const v of variants(w)) if (next.length < PHRASE_LIMIT) next.push(head ? `${head} ${v}` : v)
    out = next
  }
  return [...new Set(out)]
}

function bestField(
  word: string,
  label: string,
  keywords: readonly string[],
  path: string,
  hint: string
): { field: number; at: number; length: number } | null {
  const lands = (text: string, w: string): number => {
    const s = wordStart(text, w)
    if (s >= 0) return s
    return w.length >= 4 ? text.indexOf(w) : -1
  }
  for (const w of variants(word)) {
    const at = lands(label, w)
    if (at >= 0) return { field: WORD_FIELD.label, at, length: w.length }
  }
  for (const w of variants(word)) if (keywords.some((k) => lands(k, w) >= 0)) return { field: WORD_FIELD.keyword, at: -1, length: 0 }
  /*
   * A synonym is a whole word somebody else would type, so it lands only where
   * a word starts: "mic" for "microphone" is not the middle of "Dynamic".
   */
  for (const syn of synonymsOf(word)) {
    const at = wordStart(label, syn)
    if (at >= 0) return { field: WORD_FIELD.synonym, at, length: syn.length }
    if (keywords.some((k) => wordStart(k, syn) >= 0)) return { field: WORD_FIELD.synonym, at: -1, length: 0 }
  }
  for (const w of variants(word)) if (lands(path, w) >= 0) return { field: WORD_FIELD.path, at: -1, length: 0 }
  for (const w of variants(word)) if (w.length >= 4 && lands(hint, w) >= 0) return { field: WORD_FIELD.hint, at: -1, length: 0 }
  return null
}

function toOriginal(f: Folded, start: number, end: number): [number, number] {
  return [f.from[start] ?? start, f.to[end - 1] ?? end]
}

function merge(ranges: [number, number][]): Range[] {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: [number, number][] = []
  for (const r of ranges) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/**
 * A settings hit's place among the command palette's project tiers
 * (`TIERS` in projectSearch.ts: 6 a name prefix down to 1 a subsequence), so
 * the two lists interleave by how good a match each is. A label that starts
 * with the query sits with a project whose name does; a keyword or synonym
 * sits with a path match; a hit only in the menu path or a description sits at
 * the bottom with the palette's fuzzy matches.
 */
export function paletteTier(score: number): number {
  if (score >= SETTING_SCORES.labelPrefix) return 6
  if (score >= SETTING_SCORES.labelPhrase) return 5
  if (score >= SETTING_SCORES.labelSubstring) return 4
  if (score >= SETTING_SCORES.words) return 3
  if (score >= SETTING_SCORES.words - 6) return 2
  return 1
}
