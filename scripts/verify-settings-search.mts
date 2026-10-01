/*
 * Settings search and the Settings menu's tree (shared/settingsIndex.ts).
 *
 * Four things, each of which fails quietly in the app:
 *
 * - The index and the sheet agree. Search can only land on a row the sheet
 *   marks with `data-setting`, and can only find a row the index names; a row
 *   added to a component and not the index is unfindable, and a row renamed in
 *   one and not the other lands on nothing. So every `.tsx` is read for its
 *   marks and the two lists are compared both ways, with the component each
 *   mark sits in held to the page its row belongs to.
 * - The tree: Agents opens to the Agent manager and each installed agent,
 *   Claude Code to its three pages, and the keyboard walks what is on screen.
 * - Every old section id lands. Other panels, `stoke update` and the palette
 *   open Settings by id; `providers`, `claude` and `agents` moved.
 * - Ranking and synonyms, and how the palette interleaves settings with
 *   projects.
 *
 * What it cannot see is the wire from a keystroke to a scrolled, flashed row;
 * that is driven over CDP against the built app (gotcha 31).
 *
 *   node scripts/verify-settings-search.mts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENTS_NODE,
  CLAUDE_NODE,
  CLAUDE_SUBPAGES,
  SETTING_ROWS,
  SETTINGS_PAGES,
  agentRowId,
  allRowIds,
  ancestorsOf,
  claudeSettingRows,
  navAgents,
  navTree,
  nodeIdOf,
  paletteTier,
  pathOf,
  resolveSettingsTarget,
  searchSettings,
  settingsEntries,
  visibleHolder,
  visibleNodes,
  type SettingsHit,
  type SettingsTarget
} from '../src/shared/settingsIndex.ts'
import { CODING_CLIS, type CodingCliId } from '../src/shared/codingClis.ts'
import { CLAUDE_SETTINGS } from '../src/shared/claudeConfig.ts'
import { endpointProblem } from '../src/shared/agents.ts'
import { openRouterResponse } from '../src/shared/openRouterUsage.ts'
import { paletteRows } from '../src/renderer/src/lib/paletteRows.ts'
import type { ProjectHit } from '../src/renderer/src/lib/projectSearch.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

// fileURLToPath, not `.pathname`: on Windows that is `/D:/a/...` (verify-layers).
const root = fileURLToPath(new URL('../', import.meta.url))
const rendererDir = join(root, 'src/renderer/src')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(path))
    else if (entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

const read = (rel: string): string => readFileSync(join(rendererDir, rel), 'utf8')

/* ------------------------------------------------ the index and the marks */

console.log('every row the sheet marks is in the index, and every row in the index is marked')
{
  const literal = /\b(?:data-setting|settingId)="([^"]+)"/g
  const dynamic = /\bdata-setting=\{([^}]+)\}/g
  const marks = new Map<string, Set<string>>()
  const expressions: { file: string; expr: string }[] = []
  for (const path of tsxFiles(rendererDir)) {
    const rel = relative(rendererDir, path).split(sep).join('/')
    const src = readFileSync(path, 'utf8')
    for (const m of src.matchAll(literal)) {
      if (!marks.has(m[1])) marks.set(m[1], new Set())
      marks.get(m[1])!.add(rel)
    }
    for (const m of src.matchAll(dynamic)) expressions.push({ file: rel, expr: m[1].trim() })
  }

  const indexed = new Set(SETTING_ROWS.map((r) => r.id))
  const unindexed = [...marks.keys()].filter((id) => !indexed.has(id))
  const unmarked = SETTING_ROWS.map((r) => r.id).filter((id) => !marks.has(id))
  check('no component marks a row the index does not name', unindexed, [])
  check('no row in the index goes unmarked by every component', unmarked, [])
  check(
    'no row is marked in two different files (search would land on whichever mounted)',
    [...marks].filter(([, files]) => files.size > 1).map(([id, files]) => `${id}: ${[...files].join(', ')}`),
    []
  )
  check('the scan found the marks it was written against (at least 80)', marks.size >= 80, true)

  /*
   * A row in a component belongs to the pages that component draws. A mark
   * copied into the wrong file would send a jump to a page that never shows it.
   */
  const pagesOf: Record<string, string[]> = {
    'components/SettingsSheet.tsx': ['appearance', 'terminal', 'sessions', 'projects', 'updates'],
    'components/ThemeEditor.tsx': ['appearance'],
    'components/ProfilesSettings.tsx': ['profiles'],
    'components/ProvidersSettings.tsx': ['providers'],
    'components/ChatHistorySettings.tsx': ['chats'],
    'components/VoiceSettings.tsx': ['voice'],
    'components/MicPicker.tsx': ['voice'],
    'components/SpeechServiceSettings.tsx': ['voice'],
    'components/WorklogSettings.tsx': ['worklog'],
    'components/HostsSettings.tsx': ['hosts'],
    'components/BrowserSettings.tsx': ['browser'],
    'components/BackupSettings.tsx': ['backup'],
    'components/AccountSyncSettings.tsx': ['account'],
    'components/RemoteSettings.tsx': ['remote', 'updates'],
    'components/AgentsSettings.tsx': ['agents', 'agent', 'claude-launch']
  }
  const misplaced: string[] = []
  for (const [id, files] of marks) {
    const row = SETTING_ROWS.find((r) => r.id === id)
    if (!row) continue
    for (const f of files) if (!(pagesOf[f] ?? []).includes(row.page)) misplaced.push(`${id} (${row.page}) in ${f}`)
  }
  check("each mark sits in a component that draws its row's page", misplaced, [])

  /*
   * Two families are marked with a call rather than a literal, because the
   * component draws them from a table. The calls are pinned here, and the
   * index lists the same tables, so the family cannot drift either.
   */
  const allowed = new Set([
    'components/ClaudeCodeSettings.tsx: claudeSettingRowId(spec.key)',
    'components/ClaudeCodeSettings.tsx: claudeSettingRowId(WORKFLOW_SIZE_KEY)',
    'components/AgentsSettings.tsx: agentRowId(cli.id)',
    'components/ProvidersSettings.tsx: settingId'
  ])
  check(
    'every computed mark is one of the four known families',
    expressions.map((e) => `${e.file}: ${e.expr}`).filter((e) => !allowed.has(e)),
    []
  )
  const cc = read('components/ClaudeCodeSettings.tsx')
  check(
    "Claude Code's settings rows are marked for both kinds of row (the select and the number)",
    (cc.match(/data-setting=\{claudeSettingRowId\(spec\.key\)\}/g) ?? []).length,
    2
  )
  check('...and the workflow-size row too', /data-setting=\{claudeSettingRowId\(WORKFLOW_SIZE_KEY\)\}/.test(cc), true)
  check(
    '...and the index lists one row per CLAUDE_SETTINGS key plus the workflow size',
    claudeSettingRows().length,
    CLAUDE_SETTINGS.length + 1
  )
  const agentsSrc = read('components/AgentsSettings.tsx')
  check(
    "the Agent manager marks every agent's row, installed (the roster) or not (More agents)",
    (agentsSrc.match(/data-setting=\{agentRowId\(cli\.id\)\}/g) ?? []).length,
    2
  )
  check(
    'row ids are unique across the static rows, the generated ones and the agents',
    allRowIds().length,
    new Set(allRowIds()).size
  )

  const prefixOff = SETTING_ROWS.filter((r) => !r.id.startsWith(`${r.page}.`)).map((r) => r.id)
  check("every static row's id starts with its page", prefixOff, [])
  const badFallback = SETTING_ROWS.filter(
    (r) => r.fallback && SETTING_ROWS.find((x) => x.id === r.fallback)?.page !== r.page
  ).map((r) => r.id)
  check('every fallback names a row on the same page', badFallback, [])

  const sheet = read('components/SettingsSheet.tsx')
  check(
    'the sheet draws every page the index names',
    SETTINGS_PAGES.map((p) => p.id).filter((id) => !sheet.includes(`loc.page === '${id}'`)),
    []
  )
}

/* ------------------------------------------------------------------ tree */

console.log('\nthe menu is a tree: Agents opens to the manager and your agents, Claude Code to its three pages')
{
  const installed = new Set<CodingCliId>(['codex', 'gemini'])
  const agents = navAgents(installed)
  check('Claude Code first, then the installed agents in table order', agents, ['claude', 'codex', 'gemini'])
  check('Claude Code is listed even before its probe answers', navAgents(new Set()), ['claude'])
  check('an agent whose page is open without being installed still gets a row', navAgents(new Set(), 'grok'), ['claude', 'grok'])

  const tree = navTree(agents)
  const config = tree.find((g) => g.title === 'Configuration')
  const agentsNode = config?.nodes.find((n) => n.id === AGENTS_NODE)
  check('the groups keep their order', tree.map((g) => g.title), ['Appearance', 'Configuration', 'Integrations', 'System'])
  check('Agents only opens and closes: it is not a page', agentsNode?.loc ?? null, null)
  check(
    'under it: the Agent manager, then Claude Code, then each installed agent',
    agentsNode?.children?.map((n) => n.id),
    ['agents', CLAUDE_NODE, 'agent:codex', 'agent:gemini']
  )
  const claude = agentsNode?.children?.find((n) => n.id === CLAUDE_NODE)
  check('Claude Code is a page of its own', claude?.loc, { page: 'agent', agent: 'claude' })
  check(
    'and under it: Launch defaults, Claude Code settings, Provider & keys',
    claude?.children?.map((n) => n.label),
    ['Launch defaults', 'Claude Code settings', 'Provider & keys']
  )
  check('Providers and Claude Code are no longer rows of their own at the top', config?.nodes.map((n) => n.id), [
    'sessions',
    AGENTS_NODE,
    'chats',
    'voice',
    'projects',
    'hosts',
    'browser'
  ])
  const pagesInTree = new Set<string>()
  const walk = (nodes: typeof tree[number]['nodes']): void => {
    for (const n of nodes) {
      if (n.loc) pagesInTree.add(n.loc.page)
      if (n.children) walk(n.children)
    }
  }
  for (const g of tree) walk(g.nodes)
  check('every page is reachable from the menu', SETTINGS_PAGES.map((p) => p.id).filter((id) => !pagesInTree.has(id)), [])

  const closed = visibleNodes(tree, new Set())
  check('closed, Agents shows no children', closed.some((v) => v.parent === AGENTS_NODE), false)
  const half = visibleNodes(tree, new Set([AGENTS_NODE]))
  check('Agents open, Claude Code closed: its pages are not on screen', half.some((v) => v.parent === CLAUDE_NODE), false)
  const both = visibleNodes(tree, new Set([AGENTS_NODE, CLAUDE_NODE]))
  const at = (id: string) => both.find((v) => v.node.id === id)
  check('both open: the rows walk depth first', both.map((v) => v.node.id).slice(3, 12), [
    'sessions',
    AGENTS_NODE,
    'agents',
    CLAUDE_NODE,
    'claude-launch',
    'claude-settings',
    'providers',
    'agent:codex',
    'agent:gemini'
  ])
  check('levels, set sizes and positions are what a screen reader is told', [at('providers')?.level, at('providers')?.setSize, at('providers')?.posInSet, at('agent:codex')?.level, at('agent:codex')?.posInSet], [3, 3, 3, 2, 3])
  check('a page under a closed node is held by the nearest one on screen', visibleHolder(closed, { page: 'providers' }), AGENTS_NODE)
  check('...one level in', visibleHolder(half, { page: 'providers' }), CLAUDE_NODE)
  check('...and by its own row once it is on screen', visibleHolder(both, { page: 'providers' }), 'providers')
  check("an agent's page is its own node", nodeIdOf({ page: 'agent', agent: 'codex' }), 'agent:codex')
}

/* --------------------------------------------------------- old ids land */

console.log('\nevery old section id still lands, the moved ones where they went')
{
  const land = (t: SettingsTarget | undefined) => resolveSettingsTarget(t)
  check("'providers' is Provider & keys, under Claude Code", [land('providers'), pathOf(land('providers'))], [
    { page: 'providers' },
    ['Agents', 'Claude Code', 'Provider & keys']
  ])
  check("...and opening it opens Agents and Claude Code in the menu", ancestorsOf(land('providers')), [AGENTS_NODE, CLAUDE_NODE])
  check("'claude', the old Claude Code section, is Claude Code settings", land('claude'), { page: 'claude-settings' })
  check("'claudecode' and 'claude-code' land there too", [land('claudecode'), land('claude-code')], [
    { page: 'claude-settings' },
    { page: 'claude-settings' }
  ])
  check("'agents', the old Agents section, is the Agent manager", [land('agents'), pathOf(land('agents'))], [
    { page: 'agents' },
    ['Agents', 'Agent manager']
  ])
  check('an agent page with no agent is the manager, not a blank page', land({ page: 'agent' }), { page: 'agents' })
  check('nothing at all is Appearance', land(undefined), { page: 'appearance' })

  const before = ['appearance', 'terminal', 'profiles', 'sessions', 'claude', 'agents', 'chats', 'providers', 'voice', 'projects', 'hosts', 'browser', 'worklog', 'remote', 'updates', 'backup'] as const
  const pages = new Set(SETTINGS_PAGES.map((p) => p.id))
  check(
    'every section id from before the tree resolves to a page, and only claude moves id',
    before.filter((id) => !pages.has(land(id).page) || (id !== 'claude' && land(id).page !== id)),
    []
  )

  /*
   * Every `openSettings('<id>')` in the renderer, read from the source: the
   * call sites are the contract, and a new one naming a page that does not
   * exist would otherwise open Appearance and look like it worked.
   */
  const calls = new Set<string>()
  for (const path of tsxFiles(rendererDir)) {
    for (const m of readFileSync(path, 'utf8').matchAll(/openSettings\('([^']+)'/g)) calls.add(m[1])
  }
  check('the renderer still opens Settings by id (the scan found its callers)', calls.size >= 4, true)
  check(
    'every id a caller passes lands on the page it names',
    [...calls].filter((id) => land(id as SettingsTarget).page === 'appearance' && id !== 'appearance'),
    []
  )
}

/* ------------------------------------------------------------- ranking */

console.log('\nsearch: what ranks first, synonyms, spellings and highlights')
{
  const everyAgent = navAgents(new Set(CODING_CLIS.map((c) => c.id)))
  const entries = settingsEntries({ agents: ['claude', 'codex'] })
  const top = (q: string, n = 1, e = entries): string[] => searchSettings(e, q).slice(0, n).map((h) => h.entry.key)
  const has = (q: string, key: string, within = 8, e = entries): boolean => top(q, within, e).includes(key)
  const marked = (h: SettingsHit | undefined): string[] => (h ? h.ranges.map(([s, e]) => h.entry.label.slice(s, e)) : [])

  check('"font": Font, then Font size', top('font', 2), ['row:terminal.font', 'row:terminal.font-size'])
  check('"font size": Font size first', top('font size'), ['row:terminal.font-size'])
  check('"Font" and "FONT" are the same query', [top('Font'), top('FONT')], [['row:terminal.font'], ['row:terminal.font']])
  check('"api key": the two Claude Code keys lead', top('api key', 2).sort(), ['row:providers.anthropic-key', 'row:providers.openrouter-key'])
  check('...the Provider & keys page is found by it', has('api key', 'page:providers', 12), true)
  check('...so are the speech service key and where keys live', [has('api key', 'row:voice.key', 12), has('api key', 'row:backup.storage', 30)], [true, true])
  check('...and "API key" is what is highlighted in "Anthropic API key"', marked(searchSettings(entries, 'api key')[0]), ['API key'])
  check('"ssh": SSH hosts and its key login', [has('ssh', 'page:hosts', 3), has('ssh', 'row:hosts.key-enroll', 5)], [true, true])
  check('"mic" (a synonym): the microphone rows', [has('mic', 'row:voice.microphone', 4), has('mic', 'row:voice.mic-access', 4)], [true, true])
  check('"microphone": its rows lead', top('microphone', 2).sort(), ['row:voice.mic-access', 'row:voice.microphone'])
  check('"voice": the Voice page first', top('voice'), ['page:voice'])
  check('"theme": the theme cards first', top('theme'), ['row:appearance.theme'])
  check('"dark mode": Appearance and Follow my system lead', top('dark mode', 2).sort(), ['page:appearance', 'row:appearance.follow-system'])
  check('"default agent": Default agent first', top('default agent'), ['row:agents.default'])
  check('"usage": the status line that carries plan limits', has('usage', 'row:sessions.status-line', 5), true)
  check('"color" (US) finds what "colour" finds', top('color', 6), top('colour', 6))
  check('...which includes your agents\' colours', has('color', 'row:agents.list', 6), true)
  check('"effort": Claude Code\'s own Effort first, the launch default beside it', [top('effort')[0], has('effort', 'row:claude-launch.effort', 3)], ['row:claude-settings.effortLevel', true])
  check('"claude\'s status" matches the curly apostrophe in the label', has("claude's status", 'row:sessions.status-line', 1), true)
  check('"terminal padding": every word must land, across the path and the label', top('terminal padding'), ['row:terminal.padding'])
  check('"ai" matches a word that starts with it, not one that hides it (Tailscale)', [has('ai', 'row:chats.enabled', 10), has('ai', 'row:remote.reach', 40)], [true, false])
  // Plurals: every row is named in the singular, and a word has to land as a word start.
  check('"fonts": Font first', top('fonts'), ['row:terminal.font'])
  check('"themes": the theme cards first', top('themes'), ['row:appearance.theme'])
  check('"wallpapers": Wallpaper first', top('wallpapers'), ['row:appearance.wallpaper'])
  check('"microphones": the microphone rows lead', top('microphones', 2).sort(), ['row:voice.mic-access', 'row:voice.microphone'])
  // Two rows answer "ssh keys": the hub's sharing of your own keys between devices (Account & sync),
  // whose label it is, and setting up key login to a host, which has it as a keyword. They are not
  // tied (100 and 75), so the order is pinned, not sorted away: a change to it is a decision.
  check(
    '"ssh keys": the hub\'s SSH keys (its label), then key login for SSH hosts',
    top('ssh keys', 2),
    ['row:account.ssh-keys', 'row:hosts.key-enroll']
  )
  // The agent pages' own button says "Add account"; "add" used to prefix-match the hub's "address".
  check('"add account" and "new account": an agent\'s Accounts, not the hub address', [top('add account'), top('new account')], [['row:agent.accounts@claude'], ['row:agent.accounts@claude']])
  check(
    '"api keys": both Claude Code key rows ahead of Where your keys live',
    [top('api keys', 2).sort(), searchSettings(entries, 'api keys').findIndex((h) => h.entry.key === 'row:backup.storage') > 1],
    [['row:providers.anthropic-key', 'row:providers.openrouter-key'], true]
  )
  check('"shortcuts" and "keyboard shortcuts": the zoom keys and dictation, and nothing that merely says keys', [top('shortcuts', 3).sort(), top('keyboard shortcuts', 3).sort()], [
    ['row:appearance.zoom-keys', 'row:voice.dictation'],
    ['row:appearance.zoom-keys', 'row:voice.dictation']
  ])
  check('"colors" (US and plural) finds what "colour" finds first', top('colors'), top('colour'))
  check('"notifications" finds the notification row', has('notifications', 'row:sessions.notifications', 2), true)
  check('"keys" lists a label that says keys before one only its singular found', searchSettings(entries, 'keys').findIndex((h) => h.entry.key === 'row:appearance.zoom-keys') < searchSettings(entries, 'keys').findIndex((h) => h.entry.key === 'row:providers.anthropic-key'), true)
  check('"cookies": the browser rows, through its singular', [has('cookies', 'row:browser.profiles', 3), has('cookies', 'row:browser.import', 3)], [true, true])
  check(
    'a three-letter word lands only where a word starts: "mic" not inside "Dynamic", "aud" not inside every "Claude"',
    [has('mic', 'row:claude-settings.workflowSizeGuideline', 20), has('aud', 'row:agent.look@claude', 20), top('aud tag')],
    [false, false, ['row:remote.access']]
  )

  // Controls inside a row, found by what they are called.
  check('"redact": Where Stoke looks, which holds the API-key filter', top('redact'), ['row:chats.sources'])
  check('"tmux", "byobu", "kept session", "command on connect": Remote machines', ['tmux', 'byobu', 'kept session', 'command on connect'].map((q) => top(q)[0]), [
    'row:hosts.list',
    'row:hosts.list',
    'row:hosts.list',
    'row:hosts.list'
  ])
  check('"team domain" and "aud tag": Require Cloudflare Access', [top('team domain'), top('aud tag')], [['row:remote.access'], ['row:remote.access']])
  check('a label typed out whole finds its row past its little words', top('keep sessions running on this machine'), ['row:hosts.list'])
  check('…but a little word alone is still a query', has('on', 'row:sessions.start-on-launch', 3), true)

  check('nonsense finds nothing', searchSettings(entries, 'zzqxv'), [])
  check('an empty query finds nothing', searchSettings(entries, '   '), [])

  check('"codex" with Codex installed: its page', top('codex'), ['page:agent:codex'])
  const claudeOnly = settingsEntries({ agents: ['claude'] })
  check('...without it: its row in the Agent manager, where it is installed', top('codex', 1, claudeOnly), [`row:${agentRowId('codex')}`])
  check('"codex model": Codex\'s default model', top('codex model'), ['row:agent.model@codex'])
  check("Claude Code's page has no endpoint row (that is Provider & keys)", entries.some((e) => e.key === 'row:agent.endpoint@claude'), false)
  check(
    'a row every agent page draws is found once per listed agent',
    entries.filter((e) => e.row === 'agent.tools').map((e) => e.loc.agent),
    ['claude', 'codex']
  )

  /*
   * The strongest check here: every entry, searched for by its own label, is
   * among the first few results. A label no query can reach is a row nobody
   * can find, and this is the one assertion that walks all of them.
   */
  const all = settingsEntries({ agents: everyAgent })
  const lost = all.filter((e) => !searchSettings(all, e.label).slice(0, 25).some((h) => h.entry.key === e.key)).map((e) => e.key)
  check('every page and row is found by its own label', lost, [])
  check('every result says where it is', all.filter((e) => e.row && e.path.length === 0).map((e) => e.key), [])
}

/* ------------------------------------------------------------- palette */

console.log('\nthe palette interleaves settings with projects by how good a match each is')
{
  const project = (name: string, score: number): ProjectHit =>
    ({ project: { name, path: `/p/${name}` }, score, matchedBy: 'name', nameRanges: [], pathRanges: [], sessions: [] }) as unknown as ProjectHit
  const entries = settingsEntries({ agents: ['claude'] })
  const font = searchSettings(entries, 'font')
  const rows = paletteRows([project('fontkit', 6), project('f-o-n-t', 1)], font.slice(0, 3))
  const label = (r: (typeof rows)[number]): string => (r.kind === 'project' ? `project:${r.hit.project.name}` : `setting:${r.hit.entry.key}`)
  check('a folder named for the query ties with a setting named for it, and stays first', label(rows[0]), 'project:fontkit')
  check('then the settings named for it', rows.slice(1, 3).map(label), ['setting:row:terminal.font', 'setting:row:terminal.font-size'])
  check('a folder matched letter by letter goes below them', label(rows[rows.length - 1]), 'project:f-o-n-t')
  check('no project matching: settings alone, in their own order', paletteRows([], font.slice(0, 2)).map(label), ['setting:row:terminal.font', 'setting:row:terminal.font-size'])
  const tiers = [100, 90, 80, 75, 70, 60, 50, 48, 46, 44, 42].map(paletteTier)
  check('paletteTier never ranks a weaker score above a stronger one', tiers.every((t, i) => i === 0 || t <= tiers[i - 1]), true)
}

/* ---------------------------------------- what the sheet labels, findable */

console.log('\nevery control the sheet labels is found by its label, on its own page')
{
  /*
   * The marks above only compare rows that already HAVE a mark. A control
   * added inside a marked row, with no keyword for it, is exactly as
   * unfindable and passes every check there: "Leave out anything that looks
   * like an API key" and a host's "Command on connect" were. So every label a
   * settings component draws — a field label, a check row's text, a
   * disclosure's summary, a slider row's name — is searched for, and has to
   * find something on a page that component draws. Only the list below may
   * not, each for its reason.
   */
  const pagesOf: Record<string, string[]> = {
    'components/SettingsSheet.tsx': ['appearance', 'terminal', 'sessions', 'projects', 'updates'],
    'components/ThemeEditor.tsx': ['appearance'],
    'components/ProfilesSettings.tsx': ['profiles'],
    'components/ProvidersSettings.tsx': ['providers'],
    'components/ClaudeCodeSettings.tsx': ['claude-settings'],
    'components/ChatHistorySettings.tsx': ['chats'],
    'components/VoiceSettings.tsx': ['voice'],
    'components/MicPicker.tsx': ['voice'],
    'components/SpeechServiceSettings.tsx': ['voice'],
    'components/WorklogSettings.tsx': ['worklog'],
    'components/HostsSettings.tsx': ['hosts'],
    'components/BrowserSettings.tsx': ['browser'],
    'components/BackupSettings.tsx': ['backup'],
    'components/AccountSyncSettings.tsx': ['account'],
    'components/RemoteSettings.tsx': ['remote', 'updates'],
    'components/AgentsSettings.tsx': ['agents', 'agent', 'claude-launch']
  }
  const unfindable = new Map<string, string>([
    ['components/SettingsSheet.tsx: Launch defaults', "Sessions' signpost to Agents › Claude Code › Launch defaults, which the search finds itself"],
    ['components/AgentsSettings.tsx: The rest of Claude Code', "Claude Code's page's signpost to its three sub-pages, each found by name"],
    ['components/ThemeEditor.tsx: Editing', 'the editor\'s heading, "Editing <theme>"'],
    ['components/HostsSettings.tsx: Name', "one field of each machine's own row"],
    ['components/BrowserSettings.tsx: Name', "one field of each browser profile's own row"],
    ['components/RemoteSettings.tsx: Enter them by hand', "a disclosure over the Access team domain and AUD tag, which remote.access's keywords name"],
    ['components/RemoteSettings.tsx: Advanced', 'a disclosure over Port and the key, each a row of its own'],
    ['components/BackupSettings.tsx: Also import the', "the import's question about the keys in a file, drawn once one is chosen (its text stops at a count)"],
    ['components/AccountSyncSettings.tsx: Account \' sync', "the page's own heading while it asks the hub, before any row is drawn; the page is found by name"]
  ])
  const labelled = [
    /className="field-label"[^>]*>\s*([^<{]+?)\s*[<{]/g,
    // Lazily across the input: its onChange holds a `=>`, whose `>` a `[^>]*` stops at.
    /className="check-row[^"]*"[^>]*>\s*<input[\s\S]*?\/>\s*<span>\s*(?:<span[^>]*>)?\s*([^<{]+?)\s*[<{]/g,
    /<summary[^>]*>\s*(?:<span[^>]*>)?\s*([^<{]+?)\s*[<{]/g,
    /className="theme-editor-row"[^>]*>\s*<span>([^<{]+?)\s*[<{]/g
  ]
  const entries = settingsEntries({ agents: ['claude', 'codex'] })
  const lost: string[] = []
  const seen = new Set<string>()
  for (const [file, pages] of Object.entries(pagesOf)) {
    const src = read(file)
    for (const re of labelled) {
      for (const m of src.matchAll(re)) {
        const text = m[1].replace(/&[a-z]+;/g, "'").replace(/\s+/g, ' ').trim()
        // A comment the pattern ran into is not a label.
        if (text.length < 3 || text.length > 90 || text.includes('*/')) continue
        const key = `${file}: ${text}`
        seen.add(key)
        if (unfindable.has(key)) continue
        if (!searchSettings(entries, text).slice(0, 10).some((h) => pages.includes(h.entry.loc.page))) lost.push(key)
      }
    }
  }
  check('the scan found the labels it was written against (at least 110)', seen.size >= 110, true)
  check('every label is found on its own page by searching for it', lost, [])
  check('every label excused from that still exists (a stale excuse hides nothing)', [...unfindable.keys()].filter((k) => !seen.has(k)), [])
}

console.log('\na row drawn only in some states says where a jump lands instead')
{
  const fallbackOf = (id: string): string | undefined => SETTING_ROWS.find((r) => r.id === id)?.fallback
  const theme = read('components/ThemeEditor.tsx')
  // The cards and "Follow my system" are the not-editing branch; the editor replaces them.
  const notEditing = theme.slice(theme.indexOf('if (!seed || !draft) {'), theme.lastIndexOf('data-setting="appearance.make-theme"'))
  check(
    'the theme cards and Follow my system are drawn only while no theme is being edited…',
    [notEditing.includes('data-setting="appearance.theme"'), notEditing.includes('data-setting="appearance.follow-system"')],
    [true, true]
  )
  check('…so both land on the editor, which is drawn either way', [fallbackOf('appearance.theme'), fallbackOf('appearance.follow-system')], [
    'appearance.make-theme',
    'appearance.make-theme'
  ])
  check(
    'More agents is drawn only while an agent is not installed, and lands on Your agents',
    [/\{more\.length > 0 && \(\s*<details[^>]*data-setting="agents\.more"/.test(read('components/AgentsSettings.tsx')), fallbackOf('agents.more')],
    [true, 'agents.list']
  )
  const browser = read('components/BrowserSettings.tsx')
  check(
    "Import from other browsers is drawn on macOS and Windows only, and the index says so",
    [
      /\(window\.stoke\.platform === 'darwin' \|\| window\.stoke\.platform === 'win32'\) && \(\s*<ImportFromBrowsers/.test(browser),
      SETTING_ROWS.find((r) => r.id === 'browser.import')?.platforms
    ],
    [true, ['darwin', 'win32']]
  )
  const onLinux = settingsEntries({ agents: ['claude'], platform: 'linux' })
  const onMac = settingsEntries({ agents: ['claude'], platform: 'darwin' })
  check(
    '…so a Linux search never offers it, a Mac one does',
    [onLinux.some((e) => e.row === 'browser.import'), onMac.some((e) => e.row === 'browser.import')],
    [false, true]
  )
  check('…and with no platform named it lands on the profiles if it is not there', fallbackOf('browser.import'), 'browser.profiles')
  const sheet = read('components/SettingsSheet.tsx')
  const palette = read('components/CommandPalette.tsx')
  check(
    'the sheet and the palette both tell the index the platform',
    [sheet, palette].map((src) => /settingsEntries\(\{ agents: [A-Za-z]+, platform: window\.stoke\.platform \}\)/.test(src)),
    [true, true]
  )
}

/* ------------------------------------------------------ the sheet's wiring */

console.log('\nthe sheet: the scroll, the results list, and the live count')
{
  const sheet = read('components/SettingsSheet.tsx')
  check(
    "the pane's scroll resets on a page change, keyed on the page's id and not the location object",
    /scrollTo\(\{ top: 0 \}\)\s*\}, \[current\]\)/.test(sheet),
    true
  )
  check(
    '…and going to the page already on show keeps its object (a press on its own menu row moves nothing)',
    /setLoc\(\(cur\) => \(sameLocation\(cur, next\) \? cur : next\)\)/.test(sheet),
    true
  )
  const open = sheet.indexOf('role="listbox"')
  const listbox = sheet.slice(open, sheet.indexOf('{hits.map(', open))
  check('the results listbox holds only its options: no status, no empty message', [/role="status"|settings-results-empty/.test(listbox)], [false])
  const status = sheet.indexOf('role="status"')
  check(
    'the live count is mounted before the list and outside any branch on the query, so its first count is announced',
    [status > 0 && status < sheet.indexOf('{searching && hits.length === 0 ?'), /\{!searching \? '' :/.test(sheet)],
    [true, true]
  )
}

console.log('\nthe jump: a row inside a disclosure it opens, and a row taller than the pane')
{
  const jump = read('lib/settingsJump.ts')
  check(
    'after opening a disclosure the scroll waits for the row to stop moving (it is not laid out in the same frame)',
    /if \(opened\) frame = requestAnimationFrame\(\(\) => settle\(el, null, SETTLE_FRAMES\)\)/.test(jump) && /if \(top === last \|\| left <= 0\) show\(el\)/.test(jump),
    true
  )
  check(
    'a row taller than the pane is scrolled to its top, not its middle',
    /getBoundingClientRect\(\)\.height > pane\.clientHeight \? 'start' : 'center'/.test(jump),
    true
  )
  const appSrc = read('App.tsx')
  check(
    'Cmd+K over Settings goes to the sheet’s own search box (the palette would open unseen UNDER it), and Escape that closes a palette leaves the sheet',
    [
      /case 'palette': \{[\s\S]{0,900}?if \(settingsOpenRef\.current\) \{\s+const box = document\.querySelector<HTMLInputElement>\('\.settings-search-input'\)/.test(appSrc),
      /if \(paletteOpenRef\.current\) return/.test(appSrc),
      read('components/SettingsSheet.tsx').includes('className="input settings-search-input"')
    ],
    [true, true, true]
  )
  // Claude Code settings draws its dropdowns disabled until its file has loaded (review, 2026-10-02).
  const cc = read('components/ClaudeCodeSettings.tsx')
  check(
    'a row whose control is still disabled keeps focus waiting on the pane, then moves it to the control once enabled',
    [
      /disabled=\{busy === spec\.key \|\| !state\}/.test(cc),
      /if \(!control && el\.querySelector\(DISABLED_IN_ROW\)\) awaitControl\(el\)/.test(jump),
      /if \(stopped \|\| document\.activeElement !== pane\) return/.test(jump)
    ],
    [true, true, true]
  )
}

/* -------------------------------------- messages that name Provider & keys */

console.log('\nmessages that send you to Provider & keys name where it is now')
{
  const place = `Settings › ${pathOf({ page: 'providers' }).join(' › ')}`
  check('the place, from the menu itself', place, 'Settings › Agents › Claude Code › Provider & keys')
  check("an agent on OpenRouter with no key says where the key goes", (endpointProblem('codex', { mode: 'openrouter', baseUrl: '', apiKey: '', model: 'x/y' } as never, '') ?? '').includes(place), true)
  check('OpenRouter refusing the key says where the key is', openRouterResponse(401, null, 0).error?.includes(place), true)
  const vendors = readFileSync(join(root, 'src/main/usageVendors.ts'), 'utf8')
  check('no OpenRouter key at all says where one goes', vendors.includes(`'No OpenRouter key in ${place}.'`), true)
  const stale: string[] = []
  for (const dir of ['src/shared', 'src/main', 'src/renderer/src']) {
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const path = join(d, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name)) {
          // Strings only: a comment may still say where a thing used to be.
          for (const m of readFileSync(path, 'utf8').matchAll(/['`"][^'`"\n]*Settings › Providers[^'`"\n]*['`"]/g)) stale.push(`${relative(root, path)}: ${m[0]}`)
          // The permission default moved too: it is Launch defaults, and Sessions only points there.
          for (const m of readFileSync(path, 'utf8').matchAll(/['`"][^'`"\n]*permission[^'`"\n]*Settings › Sessions[^'`"\n]*['`"]/gi)) stale.push(`${relative(root, path)}: ${m[0]}`)
        }
      }
    }
    walk(join(root, dir))
  }
  check('no string still says "Settings › Providers", or sends a permission default to "Settings › Sessions"', stale, [])
}

/* ------------------------------------------------------------ the paint */

console.log('\nthe stylesheet keeps the jump honest')
{
  const css = readFileSync(join(rendererDir, 'styles/app.css'), 'utf8')
  const rule = (sel: string): string => css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  const nav = rule('.settings-nav button')
  check("the menu's rows declare border and background (gotcha 47)", [/border:\s*none/.test(nav), /background:\s*transparent/.test(nav)], [true, true])
  check('the menu column and its scrolling list both carry min-height: 0 (gotcha 47)', [/min-height:\s*0/.test(rule('.settings-nav')), /min-height:\s*0/.test(rule('.settings-tree,\n.settings-results'))], [true, true])
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\[data-setting\]\[data-flash\] \{([^}]*)\}/)?.[1] ?? ''
  check(
    'with reduced motion the flash is a still highlight, not an animation cut to nothing (gotcha 72)',
    [/animation:\s*none/.test(reduced), /background:\s*var\(--accent-soft\)/.test(reduced)],
    [true, true]
  )
  check('marking a row as a hit costs no layout: no margin, padding, border or outline', /(margin|padding|border(?!-radius)|outline)\s*:/.test(rule('[data-setting][data-hit]')), false)
}

/*
 * The tally is the LAST statement in this file and has to stay that way:
 * `process.exitCode` is set once, so an assertion below it could print FAIL and
 * still exit 0 (CLAUDE.md gotchas 50 and 62).
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
