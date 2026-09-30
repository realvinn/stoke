/*
 * The coding agents: what is stored, what is shown, what each launch is handed,
 * and what an install runs.
 *
 * The launch plans are the part worth the most care, for two reasons that fail
 * silently. A plan that forgets a model sends Grok Build to the FIRST model an
 * endpoint lists (measured: an obscure 27B model on OpenRouter), and one that
 * leaves a key in argv puts it in the process table where anything on the
 * machine can read it. Neither throws. So every plan is asserted exactly, and
 * every key is asserted to be in `env` and nowhere in `args`.
 *
 * The install script is the other: it is built from a table and run in a
 * shell, so the suite checks that nothing the renderer sends can become part of
 * a command — only ids that name a table entry survive.
 *
 *   node scripts/verify-agents.mts
 */
import {
  AGENT_TAG_MAX,
  agentLaunchPlan,
  AGENTS_FORMAT,
  agentsFormatOf,
  agentTagText,
  cleanTagLabel,
  DEFAULT_AGENTS,
  DEFAULT_ENDPOINT,
  endpointProblem,
  ENV_CUSTOM_BASE_URL,
  ENV_CUSTOM_KEY,
  ENV_CUSTOM_MODEL,
  ENV_MCP_TOKEN,
  ENV_OPENROUTER_KEY,
  hydrateAgents,
  hydrateEndpoint,
  installedAgents,
  INSTALL_SCRIPT_ENV,
  installScript,
  installSteps,
  powershellEncode,
  scriptFor,
  isEndpointUrl,
  isModelId,
  launchModel,
  MODEL_ID_MAX,
  modelIdProblem,
  NO_KEY,
  OPENROUTER_OPENAI_BASE_URL,
  PI_PROVIDER_EXTENSION,
  resolveDefaultAgent,
  tomlString,
  upgradeEndpoint,
  visibleAgents,
  windowsInstallerArgs,
  type AgentEndpoint,
  type LaunchPlanInput
} from '../src/shared/agents.ts'
import { CLI_CAPS, CODING_CLIS, type CodingCliId } from '../src/shared/codingClis.ts'
import type { AgentAccount } from '../src/shared/accounts.ts'
import {
  accountMcpLines,
  accountMcpMirror,
  accountMcpSummary,
  claudeAccountServers,
  claudeMcpConfigs,
  claudeMcpServers,
  claudeShapeMcpFile,
  codexConfiguredServers,
  codexMcp,
  copilotMcpFile,
  DEFAULT_AGENT_MCP,
  ENV_PI_MCP,
  ENV_VIBE_MCP,
  expandEnvRefs,
  hydrateAgentMcp,
  isSafeServerName,
  isTrustedFolder,
  jsonConfiguredServers,
  kimiMcpFile,
  MCP_FILE_NAME,
  mcpCatalog,
  mcpFileName,
  mcpTicksFor,
  mergeMcpJsons,
  NO_APPROVALS,
  parseJsonc,
  PI_MCP_EXTENSION,
  qwenMcpFile,
  serversForLaunch,
  specFromClaudeEntry,
  STOKE_BROWSER_SERVER,
  summarize,
  urlInArgvProblem,
  vibeConfiguredServers,
  vibeMcpEnv,
  withMcpTick,
  type McpServerSpec
} from '../src/shared/mcpServers.ts'
import {
  agentOwnMcp,
  ClaudeConfigReader,
  claudeProjectKey,
  foldersDownTo,
  foldersUpTo,
  McpFileStore,
  ownMcpSources,
  readMcpCatalog,
  resolveAccountMirror,
  resolveLaunchMcp,
  trustKeys
} from '../src/main/mcpLaunch.ts'
import {
  CLAUDE_PLUGIN_SKILLS,
  CLAUDE_SHARED_PLUGIN,
  claudeProjection,
  pluginSkillName,
  SHARED_SKILLS_DIR,
  SKILL_DIRS,
  skillReport
} from '../src/shared/skills.ts'
import {
  accentNear,
  AGENT_BRAND_FAMILIES,
  AGENT_CLEAR_DISTANCE,
  AGENT_DISTINCT_DISTANCE,
  AGENT_SEEDS,
  agentColorTokens,
  agentSeed,
  agentTokenNames,
  BRAND_SEEDS_FORMAT,
  CLAUDE_CLEAR_DISTANCE,
  clearanceFloor,
  COMMON_AGENTS,
  hydrateAgentColors,
  paintAgentColors,
  PREVIOUS_AGENT_SEEDS,
  reservedColors,
  reservedNear,
  SAME_COLOUR_DISTANCE
} from '../src/shared/agentColors.ts'
import { deriveAccent } from '../src/shared/accent.ts'
import { parseColor, perceptualDistance, toOklch } from '../src/shared/color.ts'
import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
import { scanSkills } from '../src/main/skillsScan.ts'
import {
  ClaudeSkillsProjector,
  localSettingsFiles,
  SHARED_PLUGIN_MANIFEST,
  skillOverridesFor
} from '../src/main/skillsProject.ts'
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { gitBashPath } from '../src/main/statusLine.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`)
}

const KEY = 'sk-or-v1-secret'
const CUSTOM_KEY = 'sk-custom-secret'
const MCP = { url: 'http://127.0.0.1:50465/mcp', token: 'mcp-token-secret' }
/** Stoke's browser server as every launch now gets it: spec 0, with its bearer. */
const BROWSER: McpServerSpec = {
  name: STOKE_BROWSER_SERVER,
  transport: 'http',
  command: '',
  args: [],
  env: {},
  url: MCP.url,
  headers: {},
  bearer: MCP.token
}
/*
 * The two-server fixture: a stdio server with a secret in its environment and
 * an http server with a bearer and a secret header — the three places a
 * credential can live in a server's config.
 */
const STDIO_SECRET = 'ghp-STDIO-secret-0001'
const HTTP_BEARER = 'docs-BEARER-secret-0002'
const HEADER_SECRET = 'docs-HEADER-secret-0003'
const GITHUB: McpServerSpec = {
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET },
  url: '',
  headers: {}
}
const DOCS: McpServerSpec = {
  name: 'docs',
  transport: 'http',
  command: '',
  args: [],
  env: {},
  url: 'https://mcp.example.com/mcp',
  headers: { 'X-Api-Key': HEADER_SECRET },
  bearer: HTTP_BEARER
}
const TWO = [GITHUB, DOCS]
/*
 * The fourth place a credential lives: the URL itself. Hosted servers take
 * their key in the query (Tavily `?tavilyApiKey=`, Exa `?exaApiKey=`), and
 * Codex's only route for a URL is argv.
 */
const URL_SECRET = 'url-KEY-secret-0004'
const KEYED: McpServerSpec = {
  name: 'search',
  transport: 'http',
  command: '',
  args: [],
  env: {},
  url: `https://mcp.search.example/mcp/?searchApiKey=${URL_SECRET}`,
  headers: {}
}
const MCP_SECRETS = [MCP.token, STDIO_SECRET, HTTP_BEARER, HEADER_SECRET, URL_SECRET]
const FILES_AT = '/u/Stoke/agents/mcp'
const fileFor = (name: string): string => `${FILES_AT}/${name}`
const or = (model = 'anthropic/claude-sonnet-5'): AgentEndpoint => ({ ...DEFAULT_ENDPOINT, mode: 'openrouter', model })
const custom = (over: Partial<AgentEndpoint> = {}): AgentEndpoint => ({
  mode: 'custom',
  model: 'qwen3-coder',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: CUSTOM_KEY,
  ...over
})
const plan = (id: CodingCliId, endpoint: AgentEndpoint | undefined, over: Partial<LaunchPlanInput> = {}) =>
  agentLaunchPlan({
    id,
    endpoint,
    openrouterKey: KEY,
    continueLast: false,
    mcp: [],
    piExtensionPath: '/Users/u/Library/Application Support/Stoke/agents/pi-provider.ts',
    ...over
  })
const planOk = (r: ReturnType<typeof plan>) => (r.ok ? r.plan : { args: ['<refused>'], env: {} as Record<string, string> })

/**
 * No secret may appear in argv: `ps` shows every argument of every process.
 * Every MCP secret too — a bearer, a header, a stdio server's environment —
 * which may live only in `env` or in an owner-only file the plan names.
 */
function keysOnlyInEnv(name: string, r: ReturnType<typeof plan>): void {
  const p = planOk(r)
  const argv = p.args.join('\u0000')
  ok(
    `${name}: no key in argv`,
    ![KEY, CUSTOM_KEY, ...MCP_SECRETS].some((k) => argv.includes(k)),
    JSON.stringify(p.args)
  )
}

console.log('\nwhat is stored')
check('nothing stored is never asked', hydrateAgents(undefined), {
  chosen: null,
  endpoints: {},
  defaultCli: 'claude',
  shareSkillsToClaude: true,
  mcp: { perAgent: {}, extra: {} },
  tag: { show: true, labels: {} },
  colors: {},
  defaultAccount: {},
  format: AGENTS_FORMAT
})
check('junk is never asked, not "nothing chosen"', hydrateAgents({ chosen: 'codex' }).chosen, null)
check('an empty choice is kept — it means "show none"', hydrateAgents({ chosen: [] }).chosen, [])
check(
  'unknown ids are dropped and duplicates collapse',
  hydrateAgents({ chosen: ['codex', 'banana', 'codex', 'pi'] }).chosen,
  ['codex', 'pi']
)
check(
  'an endpoint is rebuilt from named keys, trimmed, with no trailing slash',
  hydrateEndpoint({ mode: 'custom', model: ' m ', baseUrl: 'http://h/v1///', apiKey: ' k ', extra: 1 }),
  { mode: 'custom', model: 'm', baseUrl: 'http://h/v1', apiKey: 'k' }
)
check('an unknown mode is the default sign-in', hydrateEndpoint({ mode: 'magic' }).mode, 'default')
check(
  "Claude's endpoint is Settings › Providers, never here (one writer, gotcha 57)",
  hydrateAgents({ endpoints: { claude: or(), codex: or() } }).endpoints,
  { codex: or() }
)
check(
  'an untouched default endpoint is not stored at all',
  hydrateAgents({ endpoints: { codex: DEFAULT_ENDPOINT } }).endpoints,
  {}
)

console.log('\nthe default agent, as stored')
/*
 * The clamp rule (CLAUDE.md): a field the hydrator does not name comes back
 * undefined, and an undefined agent id here would be `startSession` deciding
 * what to spawn from a value nothing validated.
 */
check('Claude Code when nothing is stored', DEFAULT_AGENTS.defaultCli, 'claude')
check('an agent this build knows is kept', hydrateAgents({ defaultCli: 'codex' }).defaultCli, 'codex')
check('an id this build does not know is Claude Code, not dropped', hydrateAgents({ defaultCli: 'banana' }).defaultCli, 'claude')
check('junk of the wrong type is Claude Code', hydrateAgents({ defaultCli: 42 }).defaultCli, 'claude')
check('an older file with no such key is Claude Code', hydrateAgents({ chosen: ['codex'] }).defaultCli, 'claude')
check('a non-object agents block keeps a default', hydrateAgents('junk').defaultCli, 'claude')
check(
  'it survives the whole settings round trip',
  hydrateSettings(JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents, defaultCli: 'grok' } })))
    .agents.defaultCli,
  'grok'
)
check("DEFAULT_SETTINGS names it, so a fresh file is not undefined", DEFAULT_SETTINGS.agents.defaultCli, 'claude')
check('and a settings file with no agents block hydrates it', hydrateSettings({}).agents.defaultCli, 'claude')

console.log('\nsharing ~/.agents/skills with Claude Code, as stored')
// The clamp rule again: hydrateAgents rebuilds the block from named keys, so a
// field it does not name would come back undefined — and `undefined` is falsy,
// which would switch the feature off for everyone on the next save.
check('on by default', DEFAULT_AGENTS.shareSkillsToClaude, true)
check('DEFAULT_SETTINGS names it', DEFAULT_SETTINGS.agents.shareSkillsToClaude, true)
check('an older file with no such key is on', hydrateAgents({ chosen: ['codex'] }).shareSkillsToClaude, true)
check('an explicit false is kept', hydrateAgents({ shareSkillsToClaude: false }).shareSkillsToClaude, false)
check('junk is the default, not off', hydrateAgents({ shareSkillsToClaude: 'no' }).shareSkillsToClaude, true)
check(
  'off survives the whole settings round trip',
  hydrateSettings(JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents, shareSkillsToClaude: false } })))
    .agents.shareSkillsToClaude,
  false
)
check('a settings file with no agents block hydrates it on', hydrateSettings({}).agents.shareSkillsToClaude, true)
console.log('\nthe agent tag, as stored')
/*
 * The clamp rule again: `hydrateAgents` rebuilds the block from named keys, so a
 * field it does not name comes back undefined — and `tabLabel` would read an
 * undefined `show` as "hidden".
 */
check('on by default, with no labels', DEFAULT_AGENTS.tag, { show: true, labels: {} })
check('an older file with no tag block keeps the tag on', hydrateAgents({ chosen: ['codex'] }).tag, { show: true, labels: {} })
check('only a literal false hides it', hydrateAgents({ tag: { show: false } }).tag.show, false)
check(
  'junk show values keep it on — "0", 0, null, "false", an object',
  ['0', 0, null, 'false', {}].map((show) => hydrateAgents({ tag: { show } }).tag.show),
  [true, true, true, true, true]
)
check('a non-object tag block is the default', hydrateAgents({ tag: 'junk' }).tag, { show: true, labels: {} })
check('an array tag block is the default', hydrateAgents({ tag: [false] }).tag, { show: true, labels: {} })
check(
  'labels: unknown ids dropped, trimmed, empty and non-string dropped',
  hydrateAgents({ tag: { labels: { cursor: '  Cursor  ', banana: 'B', codex: '   ', grok: 42, pi: null } } }).tag.labels,
  { cursor: 'Cursor' }
)
check(
  `labels are cut to ${AGENT_TAG_MAX} characters`,
  hydrateAgents({ tag: { labels: { codex: 'a very long agent tag indeed' } } }).tag.labels.codex,
  'a very long agen'
)
check('whitespace runs fold to one space before the cut', cleanTagLabel('GPT\n\t  five'), 'GPT five')
check('the cut is by code point, so an emoji is never split', [...cleanTagLabel('\u{1F525}'.repeat(20))].length, AGENT_TAG_MAX)
check('a labels array is ignored, not indexed', hydrateAgents({ tag: { labels: ['x'] } }).tag.labels, {})
check('the tag says the label when there is one', agentTagText('cursor', { cursor: 'Cursor' }), 'Cursor')
check('and the executable name when there is not', agentTagText('cursor', {}), 'cursor-agent')
check(
  'it survives the whole settings round trip',
  hydrateSettings(
    JSON.parse(
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, tag: { show: false, labels: { codex: 'GPT' } } }
      })
    )
  ).agents.tag,
  { show: false, labels: { codex: 'GPT' } }
)
check('DEFAULT_SETTINGS names it', DEFAULT_SETTINGS.agents.tag, { show: true, labels: {} })

console.log('\nagent colours, as stored')
check('none by default', DEFAULT_AGENTS.colors, {})
check('DEFAULT_SETTINGS names them', DEFAULT_SETTINGS.agents.colors, {})
check(
  'kept only for known ids, normalised to lower-case #rrggbb',
  hydrateAgents({ colors: { codex: '#AABBCC', banana: '#112233', grok: 'rgb(10, 20, 30)' } }).colors,
  { codex: '#aabbcc', grok: '#0a141e' }
)
check(
  'junk is dropped: unparseable, translucent, transparent, non-string, empty',
  hydrateAgentColors({ codex: 'not a colour', grok: 'rgba(1, 2, 3, 0.5)', pi: 7, gemini: '', opencode: 'transparent' }),
  {}
)
check(
  'a value equal to the seed is not stored — reset and untouched are one state',
  hydrateAgentColors({ codex: AGENT_SEEDS.codex.toUpperCase() }),
  {}
)
check('a non-object colours block is none', hydrateAgents({ colors: ['#ffffff'] }).colors, {})
check('the override wins over the seed', agentSeed('codex', { codex: '#123456' }), '#123456')
check('and the seed stands without one', agentSeed('codex', {}), AGENT_SEEDS.codex)
check(
  'it survives the whole settings round trip',
  hydrateSettings(
    JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents, colors: { codex: '#123456' } } }))
  ).agents.colors,
  { codex: '#123456' }
)

console.log('\nagent colours: the seeds became the vendors’ own (agents format 3), and stored overrides follow sanely')
{
  check('the colour table and the agents block agree on the format that brought it', BRAND_SEEDS_FORMAT, AGENTS_FORMAT)
  // Every earlier build dropped a value equal to its own seed on write AND on
  // read, so an old seed in a file is a default carried in by hand or by an
  // import — never a choice. The first read under format 3 lets it go.
  check(
    'a format-2 file holding Claude’s old pink and Codex’s old periwinkle: both go, so both take their new colour',
    hydrateAgents({ colors: { claude: PREVIOUS_AGENT_SEEDS.claude, codex: PREVIOUS_AGENT_SEEDS.codex.toUpperCase() }, format: 2 }).colors,
    {}
  )
  check(
    'and a real pick in that same file stays',
    hydrateAgents({ colors: { claude: PREVIOUS_AGENT_SEEDS.claude, gemini: '#123456' }, format: 2 }).colors,
    { gemini: '#123456' }
  )
  check(
    'an old seed filed under ANOTHER agent is a real pick (Codex painted the old Claude pink)',
    hydrateAgents({ colors: { codex: PREVIOUS_AGENT_SEEDS.claude }, format: 2 }).colors,
    { codex: PREVIOUS_AGENT_SEEDS.claude }
  )
  check(
    'once the block says format 3, the old pink is an ordinary colour: picked on purpose, it is kept',
    hydrateAgents({ colors: { claude: PREVIOUS_AGENT_SEEDS.claude }, format: 3 }).colors,
    { claude: PREVIOUS_AGENT_SEEDS.claude }
  )
  {
    const up = hydrateAgents({ colors: { claude: PREVIOUS_AGENT_SEEDS.claude, gemini: '#123456' }, format: 2 })
    check('and the upgrade runs once: a second hydrate changes nothing (gotcha 116)', hydrateAgents(up), up)
  }
  check(
    'the new seed stored under any format is still "untouched"',
    [2, 3].map((format) => hydrateAgents({ colors: { claude: AGENT_SEEDS.claude }, format }).colors),
    [{}, {}]
  )
  check(
    'hydrateAgentColors on its own (no format) reads as this build’s: the old pink is kept',
    hydrateAgentColors({ claude: PREVIOUS_AGENT_SEEDS.claude }),
    { claude: PREVIOUS_AGENT_SEEDS.claude }
  )
  check(
    'every agent’s seed moved, so no old seed silently means the new one',
    CODING_CLIS.filter((c) => AGENT_SEEDS[c.id] === PREVIOUS_AGENT_SEEDS[c.id]).map((c) => c.id),
    []
  )
}

console.log('\nagent colours: every agent has one, and the tokens are keyed for accounts to extend')
ok('every agent in the table has a seed', CODING_CLIS.every((c) => typeof AGENT_SEEDS[c.id] === 'string'))
ok('every seed parses as an opaque colour', CODING_CLIS.every((c) => parseColor(AGENT_SEEDS[c.id])?.a === 1))
ok('no seed names an agent the table does not have', Object.keys(AGENT_SEEDS).every((id) => CODING_CLIS.some((c) => c.id === id)))
check('tokens are keyed, so a second account is one more key', agentTokenNames('claude-work'), {
  ink: '--agent-claude-work-ink',
  text: '--agent-claude-work-text',
  fill: '--agent-claude-work-fill'
})
const EMBER = BUILT_IN_THEMES.find((t) => t.id === 'ember')!
check(
  'agentColorTokens covers the whole table, in table order',
  agentColorTokens({}, 'dark', EMBER.colors).map((t) => t.key),
  CODING_CLIS.map((c) => c.id)
)
check(
  'and an override reaches the token applyAppearance writes',
  agentColorTokens({ codex: '#123456' }, 'dark', EMBER.colors).find((t) => t.key === 'codex')?.seed,
  '#123456'
)

console.log('\nagent colours: the common five are told apart, and none reads as the meter, danger or warning')
/*
 * Seeds for distinctness: that is what the user sees on a dark page, where
 * every seed here is kept byte for byte. On a light page each ink is solved
 * darker to the same 4.5:1, which pulls lightness together — so the inks are
 * held to the looser "not the same colour" floor (0.04) there, never allowed to
 * collapse.
 */
const dist = (a: string, b: string): number => perceptualDistance(parseColor(a)!, parseColor(b)!)
{
  let nearest = Infinity
  let pair = ''
  for (let i = 0; i < COMMON_AGENTS.length; i++) {
    for (let j = i + 1; j < COMMON_AGENTS.length; j++) {
      const a = COMMON_AGENTS[i]
      const b = COMMON_AGENTS[j]
      const d = dist(AGENT_SEEDS[a], AGENT_SEEDS[b])
      ok(`${a} and ${b}: seeds ${d.toFixed(3)} apart`, d >= AGENT_DISTINCT_DISTANCE, `under ${AGENT_DISTINCT_DISTANCE}`)
      if (d < nearest) [nearest, pair] = [d, `${a}/${b}`]
    }
  }
  console.log(`  nearest two common seeds: ${pair} at ${nearest.toFixed(3)} (floor ${AGENT_DISTINCT_DISTANCE})`)

  /*
   * The ink (borders, rules, dots) and the text (the tag's label, re-solved
   * darker on a light theme's chrome) are both what the user tells agents
   * apart by, so both are held to it.
   */
  for (const part of ['ink', 'text'] as const) {
    let nearestInk = Infinity
    let inkPair = ''
    for (const t of BUILT_IN_THEMES) {
      const inks = new Map(agentColorTokens({}, t.appearance, t.colors).map((x) => [x.key, x[part]]))
      for (let i = 0; i < COMMON_AGENTS.length; i++) {
        for (let j = i + 1; j < COMMON_AGENTS.length; j++) {
          const d = dist(inks.get(COMMON_AGENTS[i])!, inks.get(COMMON_AGENTS[j])!)
          if (d < nearestInk) [nearestInk, inkPair] = [d, `${t.id} ${COMMON_AGENTS[i]}/${COMMON_AGENTS[j]}`]
        }
      }
    }
    ok(
      `the common five's ${part.toUpperCase()}S never become the same colour on any theme (nearest ${inkPair} ${nearestInk.toFixed(3)})`,
      nearestInk >= 0.04
    )
  }

  let nearestAll = Infinity
  let allPair = ''
  const ids = CODING_CLIS.map((c) => c.id)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = dist(AGENT_SEEDS[ids[i]], AGENT_SEEDS[ids[j]])
      if (d < nearestAll) [nearestAll, allPair] = [d, `${ids[i]}/${ids[j]}`]
    }
  }
  ok(`no two of all eighteen seeds are the same colour (nearest ${allPair} ${nearestAll.toFixed(3)})`, nearestAll >= 0.04)

  /*
   * Where two vendors' own colours collide (six oranges, five purples, three
   * blues, two greens) the table pulled them apart by hand. Each family is
   * held to the common five's floor, so a brand that was nudged cannot drift
   * back onto its neighbour.
   */
  for (const [family, members] of Object.entries(AGENT_BRAND_FAMILIES)) {
    let near = Infinity
    let who = ''
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const d = dist(AGENT_SEEDS[members[i]], AGENT_SEEDS[members[j]])
        if (d < near) [near, who] = [d, `${members[i]}/${members[j]}`]
      }
    }
    ok(
      `the ${family} family (${members.join(', ')}) is pulled apart: nearest ${who} ${near.toFixed(3)}`,
      near >= AGENT_DISTINCT_DISTANCE,
      `under ${AGENT_DISTINCT_DISTANCE}`
    )
  }

  /*
   * Any agent can be open beside one of the five most people have, so none of
   * the other thirteen may become the same colour as one of them — ink or text,
   * on any theme. (Among the thirteen themselves only the seeds are held: on a
   * light theme every ink is solved to one lightness, and Cursor, Droid and
   * Vibe, whose only brand colour is the meter's orange, read as one grey.)
   */
  for (const part of ['ink', 'text'] as const) {
    let near = Infinity
    let who = ''
    for (const t of BUILT_IN_THEMES) {
      const toks = new Map(agentColorTokens({}, t.appearance, t.colors).map((x) => [x.key, x[part]]))
      for (const c of CODING_CLIS) {
        if (COMMON_AGENTS.includes(c.id)) continue
        for (const common of COMMON_AGENTS) {
          const d = dist(toks.get(c.id)!, toks.get(common)!)
          if (d < near) [near, who] = [d, `${t.id} ${c.id}/${common}`]
        }
      }
    }
    ok(`no other agent's ${part} becomes a common agent's on any theme (nearest ${who} ${near.toFixed(3)})`, near >= 0.04)
  }

  /*
   * Against what each theme actually paints: the meter's three tiers (solved per
   * theme by meterScale, exactly as applyAppearance writes them), --danger and
   * --warning. An agent's ink this close to one would read as context
   * pressure, an error, or "waiting for you". Held through `clearanceFloor`,
   * the one place the Claude exception is written down.
   */
  for (const c of CODING_CLIS) {
    for (const part of ['ink', 'text'] as const) {
      let worst = Infinity
      let where = ''
      let floorAt = AGENT_CLEAR_DISTANCE
      for (const t of BUILT_IN_THEMES) {
        const ink = agentColorTokens({}, t.appearance, t.colors).find((x) => x.key === c.id)![part]
        for (const r of reservedColors(t)) {
          const floor = clearanceFloor(c.id, r.name, t.appearance)
          if (floor === null) continue
          const d = dist(ink, r.colour)
          // Worst relative to its own floor, so Claude's light-theme 0.05 and
          // everyone's 0.08 are compared like for like.
          if (d - floor < worst - floorAt) [worst, where, floorAt] = [d, `${t.id} ${r.name}`, floor]
        }
      }
      ok(
        `${c.id}: its ${part} stays clear of the meter, danger and warning (nearest ${where} ${worst.toFixed(3)}, floor ${floorAt})`,
        worst >= floorAt,
        `under ${floorAt}`
      )
    }
  }
}

console.log('\nagent colours: what the owner asked for, and the one exception it costs')
{
  /*
   * "claude should default to claude[,] codex to codex colour like a orangy for
   * claude and a purplish for codex". Held by hue, so a later retune that
   * drifts Claude back to pink or Codex to blue fails here rather than in a
   * screenshot.
   */
  const hue = (hex: string): number => toOklch(parseColor(hex)!).h
  const chroma = (hex: string): number => toOklch(parseColor(hex)!).c
  ok(
    `Claude Code is orange: hue ${hue(AGENT_SEEDS.claude).toFixed(0)} in 50-70, chroma ${chroma(AGENT_SEEDS.claude).toFixed(3)} ≥ 0.12`,
    hue(AGENT_SEEDS.claude) >= 50 && hue(AGENT_SEEDS.claude) <= 70 && chroma(AGENT_SEEDS.claude) >= 0.12
  )
  ok(
    `and amber-leaning, not the red-orange of Anthropic's #d97757 (h${hue('#d97757').toFixed(0)}): at least 12° further from --danger`,
    hue(AGENT_SEEDS.claude) - hue('#d97757') >= 12
  )
  ok(
    `Codex is purple: hue ${hue(AGENT_SEEDS.codex).toFixed(0)} in 290-330, chroma ${chroma(AGENT_SEEDS.codex).toFixed(3)} ≥ 0.12`,
    hue(AGENT_SEEDS.codex) >= 290 && hue(AGENT_SEEDS.codex) <= 330 && chroma(AGENT_SEEDS.codex) >= 0.12
  )

  // The exception is Claude's, and only Claude's.
  const excepted = CODING_CLIS.flatMap((c) =>
    (['dark', 'light'] as const).flatMap((a) =>
      (['meter-low', 'meter-mid', 'meter-high', 'danger', 'warning'] as const)
        .filter((r) => clearanceFloor(c.id, r, a) !== AGENT_CLEAR_DISTANCE)
        .map((r) => `${c.id} ${a} ${r} ${clearanceFloor(c.id, r, a)}`)
    )
  )
  check(
    'every relaxed floor belongs to Claude Code: none against the meter orange, CLAUDE_CLEAR_DISTANCE from danger and warning',
    excepted,
    [
      'claude dark meter-mid null',
      `claude dark danger ${CLAUDE_CLEAR_DISTANCE.dark}`,
      `claude dark warning ${CLAUDE_CLEAR_DISTANCE.dark}`,
      'claude light meter-mid null',
      `claude light danger ${CLAUDE_CLEAR_DISTANCE.light}`,
      `claude light warning ${CLAUDE_CLEAR_DISTANCE.light}`
    ]
  )
  ok(
    'and each relaxed floor is still well past "the same colour" (0.04)',
    CLAUDE_CLEAR_DISTANCE.dark > 0.04 && CLAUDE_CLEAR_DISTANCE.light > 0.04
  )
  check('an account key is not Claude, so it is held to the full floor', clearanceFloor('claude-work', 'meter-mid', 'dark'), AGENT_CLEAR_DISTANCE)

  /*
   * What the exception does NOT relax: the meter's red and green, at the full
   * floor on every theme — so Claude's orange never reads as the red tier —
   * and --danger at its own floor on both appearances, printed separately so
   * "never an error" is its own line.
   */
  const worstFor = (appearance: 'dark' | 'light', names: readonly string[]): [number, string] => {
    let worst: [number, string] = [Infinity, '']
    for (const t of BUILT_IN_THEMES.filter((x) => x.appearance === appearance)) {
      const tok = agentColorTokens({}, t.appearance, t.colors).find((x) => x.key === 'claude')!
      for (const r of reservedColors(t).filter((x) => names.includes(x.name))) {
        for (const part of [tok.ink, tok.text]) {
          const d = dist(part, r.colour)
          if (d < worst[0]) worst = [d, `${t.id} ${r.name}`]
        }
      }
    }
    return worst
  }
  for (const appearance of ['dark', 'light'] as const) {
    const [d, w] = worstFor(appearance, ['meter-high', 'meter-low'])
    ok(`${appearance} themes: Claude clears the meter's red and green at the full ${AGENT_CLEAR_DISTANCE} (nearest ${w} ${d.toFixed(3)})`, d >= AGENT_CLEAR_DISTANCE)
    const [dd, dw] = worstFor(appearance, ['danger'])
    ok(
      `${appearance} themes: never an error — Claude's orange keeps ${CLAUDE_CLEAR_DISTANCE[appearance]} from --danger (nearest ${dw} ${dd.toFixed(3)})`,
      dd >= CLAUDE_CLEAR_DISTANCE[appearance]
    )
  }
  /*
   * And the counterfactual that justifies the exception's size: Anthropic's
   * own #d97757, painted as Claude's tag on a light theme, IS the error colour.
   */
  {
    let worst = Infinity
    for (const t of BUILT_IN_THEMES.filter((x) => x.appearance === 'light')) {
      const tok = agentColorTokens({ claude: '#d97757' }, t.appearance, t.colors).find((x) => x.key === 'claude')!
      worst = Math.min(worst, dist(tok.text, t.colors.danger), dist(tok.ink, t.colors.danger))
    }
    ok(`counterfactual: the brand's own #d97757 would sit ${worst.toFixed(3)} from a light theme's --danger — under the floor`, worst < CLAUDE_CLEAR_DISTANCE.light)
  }
  // The exception is real, not a formality: Claude's ink does sit on the
  // meter's orange, which is exactly what the owner traded the old rule for.
  {
    let near = Infinity
    for (const t of BUILT_IN_THEMES) {
      const tok = agentColorTokens({}, t.appearance, t.colors).find((x) => x.key === 'claude')!
      near = Math.min(near, dist(tok.ink, reservedColors(t).find((r) => r.name === 'meter-mid')!.colour))
    }
    ok(`and the exception is used: Claude's ink comes within ${near.toFixed(3)} of the meter's orange (under ${AGENT_CLEAR_DISTANCE})`, near < AGENT_CLEAR_DISTANCE)
  }
  // The same floors, through the function the colour picker warns with.
  check(
    'reservedNear agrees: the seeds clear every floor on every theme',
    CODING_CLIS.flatMap((c) =>
      BUILT_IN_THEMES.flatMap((t) => reservedNear(AGENT_SEEDS[c.id], t, (r) => clearanceFloor(c.id, r, t.appearance)).map((r) => `${c.id} ${t.id} ${r.name}`))
    ),
    []
  )
  check(
    'and it names what a pick lands on: Codex painted the meter orange reads as the meter on every theme',
    BUILT_IN_THEMES.filter((t) => reservedNear('#fe860f', t).some((r) => r.name === 'meter-mid')).length,
    BUILT_IN_THEMES.length
  )
}

console.log('\nagent colours against each theme\'s own accent: reported, and only the known coincidences')
{
  /*
   * Not a floor (agentColors.ts, "NOT kept clear of"): the owner's vendor
   * colours and the themes' accents were each chosen on their own, and where
   * they meet — Claude on Ember — the agent's tag and rule are drawn in the
   * accent chrome's colour. Decided and left. So this prints every common
   * agent's distance from every theme's accent ink, and holds the set under
   * "the same colour" to the one written down here: a seed or theme change
   * that makes a NEW coincidence fails until someone looks at it and adds it.
   */
  const known = [
    'ember claude',
    'nocturne gemini',
    'lagoon opencode',
    'ink gemini',
    'daylight claude',
    'paper claude',
    'mist opencode'
  ]
  const found: string[] = []
  for (const t of BUILT_IN_THEMES) {
    const accent = deriveAccent(t.colors.accent, t.appearance, t.colors.bg).accentInk
    const toks = agentColorTokens({}, t.appearance, t.colors)
    const row = COMMON_AGENTS.map((id) => {
      const tok = toks.find((x) => x.key === id)!
      const d = Math.min(dist(tok.ink, accent), dist(tok.text, accent))
      if (d < SAME_COLOUR_DISTANCE) found.push(`${t.id} ${id}`)
      return `${id} ${d.toFixed(3)}`
    })
    console.log(`  ${t.id.padEnd(9)} accent ${accent}  ${row.join('  ')}`)
  }
  check(`the common five meet a theme's accent (under ${SAME_COLOUR_DISTANCE}) only where it is written down`, found, known)
  // The picker's note reads the same thing through accentNear.
  const ember = BUILT_IN_THEMES.find((t) => t.id === 'ember')!
  const emberAccent = deriveAccent(ember.colors.accent, ember.appearance, ember.colors.bg).accentInk
  ok(
    'accentNear names Claude on Ember and not Codex there',
    accentNear(agentColorTokens({}, 'dark', ember.colors).find((x) => x.key === 'claude')!, emberAccent) !== null &&
      accentNear(agentColorTokens({}, 'dark', ember.colors).find((x) => x.key === 'codex')!, emberAccent) === null
  )
}

console.log('\nagent colours are painted only while more than one agent is in view')
check(
  'Claude Code alone: nothing painted — a Claude-only user sees no change',
  paintAgentColors('claude', ['claude'], ['claude', 'claude']),
  false
)
check('nothing installed, no tabs: nothing painted', paintAgentColors('claude', [], []), false)
check('two agents on offer: painted', paintAgentColors('claude', ['claude', 'codex'], []), true)
check(
  'one on offer but a Codex tab open (restored, since unticked): painted',
  paintAgentColors('claude', ['claude'], ['codex']),
  true
)
check('the default counts even when nothing is on offer', paintAgentColors('claude', [], ['codex']), true)
check('Codex alone, as the default and in every tab: nothing painted', paintAgentColors('codex', ['codex'], ['codex']), false)

console.log('\nwhat the launcher shows')
{
  const installed = new Set<CodingCliId>(['claude', 'codex', 'opencode'])
  check('before the picker is answered: everything installed', visibleAgents(null, installed), ['claude', 'codex', 'opencode'])
  check('after: what was chosen AND is installed', visibleAgents(['codex', 'pi'], installed), ['codex'])
  check('in table order, not click order', visibleAgents(['opencode', 'codex'], installed), ['codex', 'opencode'])
}

console.log('\nwhat counts as installed')
check(
  'a found path counts, a missing one does not',
  [...installedAgents([{ id: 'codex', path: '/bin/codex' }, { id: 'grok', path: null }], false)],
  ['codex']
)
check(
  "Claude Code counts when ITS probe answered — the one that honours Settings' explicit path",
  [...installedAgents([{ id: 'claude', path: null }, { id: 'codex', path: '/bin/codex' }], true)].sort(),
  ['claude', 'codex']
)
check(
  'and not when it did not, whatever the lookup says',
  [...installedAgents([{ id: 'claude', path: null }], false)],
  []
)

console.log('\nwhat Start starts (resolveDefaultAgent)')
/*
 * The rule that keeps a stale default from ever breaking Start: the stored
 * agent when it is on offer, else Claude Code when it is, else the first on
 * offer, else Claude Code (whose own not-runnable message is the honest one).
 */
for (const [name, stored, visible, want] of [
  ['not known yet: the stored value is trusted, not flashed to Claude', 'codex', null, 'codex'],
  ['installed and chosen: the stored value', 'codex', ['claude', 'codex'], 'codex'],
  ['the default itself, when it is on offer', 'claude', ['claude', 'codex'], 'claude'],
  ['an UNINSTALLED default falls back to Claude Code', 'codex', ['claude', 'opencode'], 'claude'],
  ['an uninstalled default with no Claude on offer: the first agent on offer', 'grok', ['codex', 'opencode'], 'codex'],
  ['Claude unticked, default still Claude: the first agent on offer', 'claude', ['codex'], 'codex'],
  ['an EMPTY choice ("show none"): Claude Code, never nothing', 'codex', [], 'claude'],
  ['nothing installed at all: Claude Code', 'claude', [], 'claude']
] as [string, CodingCliId, CodingCliId[] | null, CodingCliId][]) {
  check(name, resolveDefaultAgent(stored, visible), want)
}
check(
  'end to end: a chosen Codex that is no longer installed falls back through visibleAgents',
  resolveDefaultAgent('codex', visibleAgents(['claude', 'codex'], installedAgents([{ id: 'codex', path: null }], true))),
  'claude'
)

console.log('\nrefusing a launch that would not work')
check('the default needs nothing', endpointProblem('codex', DEFAULT_ENDPOINT, ''), null)
ok('OpenRouter with no key says where the key goes', /Settings › Providers/.test(endpointProblem('codex', or(), '') ?? ''))
ok('OpenRouter with no model says so', /no model/.test(endpointProblem('grok', or(''), KEY) ?? ''))
check(
  'and names the section by its name now — Agents, not Coding agents',
  endpointProblem('grok', or(''), KEY),
  'Grok Build is set to use OpenRouter, but no model is chosen. Set one in Settings › Agents.'
)
check(
  'a custom endpoint with no URL says where to set it',
  endpointProblem('opencode', custom({ baseUrl: '' }), KEY),
  'OpenCode’s custom endpoint needs an http(s) base URL. Set it in Settings › Agents.'
)
check(
  'a custom endpoint with no model says where to set it',
  endpointProblem('opencode', custom({ model: '' }), KEY),
  'OpenCode’s custom endpoint needs a model. Set it in Settings › Agents.'
)
ok(
  'no sentence names the old section',
  [or(''), custom({ baseUrl: '' }), custom({ model: '' }), { ...DEFAULT_ENDPOINT, model: 'a b' }].every(
    (ep) => !/Coding agents/.test(endpointProblem('codex', ep, KEY) ?? '')
  )
)
ok('a custom endpoint needs an http(s) URL', /http\(s\)/.test(endpointProblem('opencode', custom({ baseUrl: 'ftp://h' }), KEY) ?? ''))
check('a custom endpoint with no key is allowed — local servers take none', endpointProblem('opencode', custom({ apiKey: '' }), KEY), null)
check('isEndpointUrl refuses a bare word', isEndpointUrl('localhost'), false)
check('and accepts a LAN address', isEndpointUrl('http://192.168.1.4:8080/v1'), true)
{
  const r = plan('codex', or(''))
  ok('the refusal reaches the launch rather than a CLI on its own sign-in', !r.ok && /model/.test(r.ok ? '' : r.message))
}

console.log('\ncodex: -c overrides, Responses API, nothing written to config.toml')
{
  const r = plan('codex', or())
  check('OpenRouter', planOk(r), {
    args: [
      '-c', 'model_provider="stoke_openrouter"',
      '-c', 'model_providers.stoke_openrouter.name="OpenRouter"',
      '-c', `model_providers.stoke_openrouter.base_url="${OPENROUTER_OPENAI_BASE_URL}"`,
      '-c', `model_providers.stoke_openrouter.env_key="${ENV_OPENROUTER_KEY}"`,
      '-m', 'anthropic/claude-sonnet-5'
    ],
    env: { [ENV_OPENROUTER_KEY]: KEY },
    model: 'anthropic/claude-sonnet-5'
  })
  keysOnlyInEnv('codex openrouter', r)
  const c = plan('codex', custom({ apiKey: '' }))
  check('a custom endpoint with no key gets the placeholder, not an empty var', planOk(c).env[ENV_CUSTOM_KEY], NO_KEY)
  const m = plan('codex', undefined, { mcp: [BROWSER] })
  check('Stoke’s browser tools ride in as an MCP server, token by env var name', planOk(m), {
    args: [
      '-c', `mcp_servers.stoke.url="${MCP.url}"`,
      '-c', `mcp_servers.stoke.bearer_token_env_var="${ENV_MCP_TOKEN}"`
    ],
    env: { [ENV_MCP_TOKEN]: MCP.token },
    model: ''
  })
  keysOnlyInEnv('codex mcp', m)
  check('continue is its resume subcommand, after the global flags', planOk(plan('codex', or(), { continueLast: true })).args.slice(-2), ['resume', '--last'])
  check('a TOML string escapes a quote', tomlString('a"b'), '"a\\"b"')
}

console.log('\nopencode: built-in OpenRouter, everything else in OPENCODE_CONFIG_CONTENT')
{
  const r = plan('opencode', or('z-ai/glm-5'))
  check('OpenRouter', planOk(r), { args: ['-m', 'openrouter/z-ai/glm-5'], env: { OPENROUTER_API_KEY: KEY }, model: 'z-ai/glm-5' })
  const c = planOk(plan('opencode', custom(), { mcp: [BROWSER] }))
  const cfg = JSON.parse(c.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  check('custom: the model is addressed through Stoke’s provider', c.args, ['-m', 'stoke_custom/qwen3-coder'])
  check('custom: an openai-compatible provider at the base URL', cfg.provider?.stoke_custom?.options?.baseURL, 'http://127.0.0.1:11434/v1')
  check('custom: the key by reference, not by value', cfg.provider?.stoke_custom?.options?.apiKey, `{env:${ENV_CUSTOM_KEY}}`)
  check('custom: the value in the environment', c.env[ENV_CUSTOM_KEY], CUSTOM_KEY)
  check('mcp: a remote server at Stoke’s URL', cfg.mcp?.stoke?.url, MCP.url)
  check('the default sign-in with no MCP sets nothing at all', planOk(plan('opencode', undefined)), { args: [], env: {}, model: '' })
  check('continue', planOk(plan('opencode', undefined, { continueLast: true })).args, ['--continue'])
}

console.log('\ngrok build: GROK_MODELS_BASE_URL, and -m is not optional')
{
  const r = plan('grok', or('x-ai/grok-5'))
  check('OpenRouter: the xAI base moves too, or a key that is not xAI’s reads as "Not signed in"', planOk(r), {
    args: ['-m', 'x-ai/grok-5'],
    env: {
      GROK_MODELS_BASE_URL: OPENROUTER_OPENAI_BASE_URL,
      GROK_XAI_API_BASE_URL: OPENROUTER_OPENAI_BASE_URL,
      XAI_API_KEY: KEY
    },
    model: 'x-ai/grok-5'
  })
  keysOnlyInEnv('grok', r)
  check('custom', planOk(plan('grok', custom())).env.GROK_MODELS_BASE_URL, 'http://127.0.0.1:11434/v1')
}

console.log('\npi: --provider openrouter, and a Stoke-owned extension for anything else')
{
  check('OpenRouter', planOk(plan('pi', or())), {
    args: ['--provider', 'openrouter', '--model', 'anthropic/claude-sonnet-5'],
    env: { OPENROUTER_API_KEY: KEY },
    model: 'anthropic/claude-sonnet-5'
  })
  const c = plan('pi', custom())
  check('custom: the extension, then the provider it registers', planOk(c).args.slice(0, 4), [
    '-e', '/Users/u/Library/Application Support/Stoke/agents/pi-provider.ts', '--provider', 'stoke_custom'
  ])
  check('custom: endpoint, key and model all through the environment', Object.keys(planOk(c).env).sort(), [
    ENV_CUSTOM_BASE_URL, ENV_CUSTOM_KEY, ENV_CUSTOM_MODEL
  ].sort())
  keysOnlyInEnv('pi custom', c)
  ok('with no extension file the launch is refused, not silently on Pi’s default', !plan('pi', custom(), { piExtensionPath: null }).ok)
  ok(
    'the extension holds no secret — only the names of the variables',
    [ENV_CUSTOM_BASE_URL, ENV_CUSTOM_KEY, ENV_CUSTOM_MODEL].every((v) => PI_PROVIDER_EXTENSION.includes(v)) &&
      !PI_PROVIDER_EXTENSION.includes('sk-')
  )
}

console.log('\nqwen, kimi, copilot: environment only, and every key in it')
{
  const q = plan('qwen', or('qwen/qwen3-coder'))
  check('qwen: --auth-type on the command line, the key in env', planOk(q), {
    args: ['--auth-type', 'openai', '-m', 'qwen/qwen3-coder'],
    env: { OPENAI_BASE_URL: OPENROUTER_OPENAI_BASE_URL, OPENAI_API_KEY: KEY },
    model: 'qwen/qwen3-coder'
  })
  keysOnlyInEnv('qwen', q)
  const k = plan('kimi', or('moonshotai/kimi-k3'))
  check('kimi: a provider synthesised from four variables, typed openai (the default is kimi)', planOk(k), {
    args: [],
    env: {
      KIMI_MODEL_NAME: 'moonshotai/kimi-k3',
      KIMI_MODEL_API_KEY: KEY,
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: OPENROUTER_OPENAI_BASE_URL
    },
    model: 'moonshotai/kimi-k3'
  })
  const c = plan('copilot', custom())
  check('copilot: its own BYO-provider variables, model included', planOk(c), {
    args: [],
    env: {
      COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1',
      COPILOT_PROVIDER_API_KEY: CUSTOM_KEY,
      COPILOT_MODEL: 'qwen3-coder'
    },
    model: 'qwen3-coder'
  })
  check(
    'copilot: Stoke’s own MCP file, by path, so the token is not in argv',
    planOk(plan('copilot', undefined, { mcp: [BROWSER], mcpFileFor: fileFor })).args,
    ['--additional-mcp-config', `@${fileFor(mcpFileName('copilot', copilotMcpFile([BROWSER])))}`]
  )
  check(
    'qwen: the httpUrl-shaped file — a plain url is SSE there and never connects',
    planOk(plan('qwen', undefined, { mcp: [BROWSER], mcpFileFor: fileFor })).args,
    ['--mcp-config', fileFor(mcpFileName('qwen', qwenMcpFile([BROWSER])))]
  )
  check(
    'the httpUrl file carries the bearer as a header',
    JSON.parse(qwenMcpFile([BROWSER])).mcpServers.stoke,
    { httpUrl: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } }
  )
  ok('gemini refuses OpenRouter rather than silently using its own sign-in', !plan('gemini', or()).ok)
  ok('and so do cursor and amp', !plan('cursor', or()).ok && !plan('amp', custom()).ok)
}

console.log('\nkilo reads OpenCode’s inline config under its own name; aider takes LiteLLM prefixes')
{
  const k = planOk(plan('kilo', custom(), { mcp: [BROWSER] }))
  ok('kilo: KILO_CONFIG_CONTENT, not OpenCode’s variable', !!k.env.KILO_CONFIG_CONTENT && !('OPENCODE_CONFIG_CONTENT' in k.env))
  check('kilo: the same provider and MCP shape', Object.keys(JSON.parse(k.env.KILO_CONFIG_CONTENT ?? '{}')).sort(), ['mcp', 'provider'])
  check('aider: openrouter/<model> with OPENROUTER_API_KEY', planOk(plan('aider', or('deepseek/deepseek-v4'))), {
    args: ['--model', 'openrouter/deepseek/deepseek-v4'],
    env: { OPENROUTER_API_KEY: KEY },
    model: 'deepseek/deepseek-v4'
  })
  check('aider: openai/<model> at OPENAI_API_BASE for a custom endpoint', planOk(plan('aider', custom())), {
    args: ['--model', 'openai/qwen3-coder'],
    env: { OPENAI_API_BASE: 'http://127.0.0.1:11434/v1', OPENAI_API_KEY: CUSTOM_KEY },
    model: 'qwen3-coder'
  })
  check('aider continues by restoring the folder’s chat', planOk(plan('aider', undefined, { continueLast: true })).args, ['--restore-chat-history'])
  ok('crush, droid and cline refuse an endpoint rather than ignore it', ['crush', 'droid', 'cline'].every((id) => !plan(id as CodingCliId, or()).ok))
}

console.log('\nthe default model on an agent’s own sign-in: exactly its confirmed flag, and nothing where there is none')
{
  const own = (model: string): AgentEndpoint => ({ ...DEFAULT_ENDPOINT, model })
  /*
   * The exact argv per agent, each one the flag codingClis.ts records reading
   * in that vendor's own artefact or docs on 2026-09-30. Written out rather
   * than derived from `modelArgs`, so a table edit that changes a flag has to
   * change this line too.
   */
  const want: Partial<Record<CodingCliId, [string, string[]]>> = {
    codex: ['gpt-6.1-sol', ['-m', 'gpt-6.1-sol']],
    grok: ['grok-build', ['-m', 'grok-build']],
    opencode: ['anthropic/claude-sonnet-5', ['-m', 'anthropic/claude-sonnet-5']],
    pi: ['anthropic/claude-sonnet-5:high', ['--model', 'anthropic/claude-sonnet-5:high']],
    gemini: ['gemini-2.5-pro', ['-m', 'gemini-2.5-pro']],
    qwen: ['qwen3-coder-plus', ['-m', 'qwen3-coder-plus']],
    kimi: ['kimi-k3', ['-m', 'kimi-k3']],
    copilot: ['gpt-5.5', ['--model=gpt-5.5']],
    cursor: ['sonnet-5', ['--model', 'sonnet-5']],
    kilo: ['anthropic/claude-sonnet-5', ['-m', 'anthropic/claude-sonnet-5']],
    aider: ['sonnet', ['--model', 'sonnet']],
    auggie: ['sonnet5', ['-m', 'sonnet5']]
  }
  for (const c of CODING_CLIS) {
    if (c.id === 'claude') continue
    const w = want[c.id]
    const model = w?.[0] ?? 'some-model'
    const r = plan(c.id, own(model))
    check(
      w ? `${c.id}: ${w[1].join(' ')}` : `${c.id}: no confirmed flag, so nothing is passed — it chooses inside the agent`,
      planOk(r).args,
      w ? w[1] : []
    )
    check(`${c.id}: the plan reports the model the tab will carry`, planOk(r).model, w ? model : '')
    check(`${c.id}: and CLI_CAPS lets the status bar name it exactly then`, CLI_CAPS[c.id].launchFlags.model, !!w)
  }
  check('the table has a flag for exactly those, and no more', CODING_CLIS.filter((c) => c.modelArgs).map((c) => c.id), Object.keys(want))
  check('a blank default model passes nothing: the agent chooses', planOk(plan('codex', own(''))), { args: [], env: {}, model: '' })
  check(
    'codex: the model before the MCP overrides and before `resume --last`, whose global flags go first',
    planOk(plan('codex', own('gpt-6.1-sol'), { mcp: [BROWSER], continueLast: true })).args,
    [
      '-m', 'gpt-6.1-sol',
      '-c', `mcp_servers.stoke.url="${MCP.url}"`,
      '-c', `mcp_servers.stoke.bearer_token_env_var="${ENV_MCP_TOKEN}"`,
      'resume', '--last'
    ]
  )
  keysOnlyInEnv('codex default model with MCP', plan('codex', own('gpt-6.1-sol'), { mcp: [BROWSER] }))
  check(
    'qwen: the model beside its MCP file, the token still only in that file',
    planOk(plan('qwen', own('qwen3-coder-plus'), { mcp: [BROWSER], mcpFileFor: fileFor })).args,
    ['-m', 'qwen3-coder-plus', '--mcp-config', fileFor(mcpFileName('qwen', qwenMcpFile([BROWSER])))]
  )
  check(
    'opencode: a default model beside its inline MCP config, whose token stays in env',
    Object.keys(planOk(plan('opencode', own('anthropic/claude-sonnet-5'), { mcp: [BROWSER] })).env),
    ['OPENCODE_CONFIG_CONTENT']
  )
  keysOnlyInEnv('opencode default model with MCP', plan('opencode', own('anthropic/claude-sonnet-5'), { mcp: [BROWSER] }))
  check(
    'off its own sign-in the endpoint’s shape wins, not the default-model flag',
    planOk(plan('opencode', or('z-ai/glm-5'))).args,
    ['-m', 'openrouter/z-ai/glm-5']
  )
  check('and the tab carries the endpoint’s model', planOk(plan('opencode', or('z-ai/glm-5'))).model, 'z-ai/glm-5')
  check('kimi on OpenRouter: the model in env, and on the tab', planOk(plan('kimi', or('moonshotai/kimi-k3'))).model, 'moonshotai/kimi-k3')
  check('claude is never planned here, and carries no agent model', planOk(plan('claude', own('opus'))), { args: [], env: {}, model: '' })
  check('launchModel: an agent with no flag on its own sign-in picks its own', launchModel('amp', own('x')), '')
  check('launchModel: Claude Code’s model is its launch defaults’, never this', launchModel('claude', own('opus')), '')
  check('launchModel: a custom endpoint’s model, whatever the agent', launchModel('grok', custom()), 'qwen3-coder')
}

console.log('\nmodel ids: nothing that is not one reaches argv (cmd.exe reads & | ^ < > % as syntax, gotcha 13)')
{
  const real = [
    'gpt-6.1-sol',
    'anthropic/claude-sonnet-5',
    'openrouter/z-ai/glm-5',
    'qwen3-coder:30b',
    'claude-opus-5[1m]',
    '@cf/meta/llama-4',
    'provider/id:high',
    'moonshotai/kimi-k2:free',
    'gemini-2.5-pro',
    'o4_mini+beta'
  ]
  for (const id of real) ok(`a real id is accepted: ${id}`, isModelId(id))
  const junk = [
    '',
    'gpt 5',
    'x & calc',
    'a|b',
    'a^b',
    'a<b',
    'a>b',
    '%PATH%',
    '!x!',
    '(x)',
    'a;b',
    '$(whoami)',
    '`id`',
    '"quoted"',
    "it's",
    'line\nbreak',
    'tab\there',
    '-m',
    '--yolo',
    '--dangerously-bypass-approvals-and-sandbox',
    '.hidden',
    'x'.repeat(MODEL_ID_MAX + 1)
  ]
  for (const id of junk) ok(`refused: ${JSON.stringify(id.length > 30 ? `${id.slice(0, 12)}…(${id.length})` : id)}`, !isModelId(id))
  ok('the longest allowed id is allowed', isModelId('x'.repeat(MODEL_ID_MAX)))

  check('hydrate drops a metacharacter model rather than storing it', hydrateEndpoint({ mode: 'openrouter', model: 'x & calc' }).model, '')
  check('and a flag dressed as a model', hydrateEndpoint({ mode: 'default', model: '--yolo' }).model, '')
  check('but keeps a real one, trimmed', hydrateEndpoint({ mode: 'default', model: '  gpt-6.1-sol ' }).model, 'gpt-6.1-sol')
  check(
    'a stored default endpoint whose only field was junk is not stored at all',
    hydrateAgents({ endpoints: { gemini: { mode: 'default', model: '-m --yolo' } } }).endpoints,
    {}
  )
  check(
    'a default model survives hydrate for an agent with no endpoint of its own (Gemini)',
    hydrateAgents({ endpoints: { gemini: { mode: 'default', model: 'gemini-2.5-pro' } }, format: AGENTS_FORMAT }).endpoints,
    { gemini: { mode: 'default', model: 'gemini-2.5-pro', baseUrl: '', apiKey: '' } }
  )

  check(
    'endpointProblem refuses a junk model on the agent’s own sign-in, and says where to fix it',
    endpointProblem('codex', { ...DEFAULT_ENDPOINT, model: 'x & calc' }, ''),
    modelIdProblem('Codex CLI')
  )
  ok('that sentence names Settings › Agents', /Settings › Agents\.$/.test(modelIdProblem('Codex CLI')))
  check(
    'and before any other problem off it — the model is what reaches argv',
    endpointProblem('grok', or('a|b'), ''),
    modelIdProblem('Grok Build')
  )
  check('an agent with no flag is still refused a junk one', endpointProblem('amp', { ...DEFAULT_ENDPOINT, model: '%x%' }, ''), modelIdProblem('Amp'))
  for (const [id, ep] of [
    ['gemini', { ...DEFAULT_ENDPOINT, model: '--yolo' }],
    ['codex', or('x & calc')],
    ['aider', custom({ model: 'm; rm -rf ~' })],
    ['copilot', { ...DEFAULT_ENDPOINT, model: 'a"b' }]
  ] as [CodingCliId, AgentEndpoint][]) {
    const r = plan(id, ep)
    ok(`${id}: a launch with ${JSON.stringify(ep.model)} is refused, not spawned`, !r.ok && r.message === modelIdProblem(CODING_CLIS.find((c) => c.id === id)!.label), JSON.stringify(r))
  }
  check('launchModel never reports a junk id either', launchModel('codex', { ...DEFAULT_ENDPOINT, model: 'a b' }), '')
  // Every flag the table holds is a flag, and carries the model whole.
  for (const c of CODING_CLIS.filter((x) => x.modelArgs)) {
    const argv = c.modelArgs!('M-1')
    ok(
      `${c.id}: its flag is a flag and carries the model once, whole`,
      argv[0].startsWith('-') && argv.filter((a) => a === 'M-1' || a.endsWith('=M-1')).length === 1,
      JSON.stringify(argv)
    )
  }
}

console.log('\na file from before the Default model: its default-mode models are leftovers, cleared once (AGENTS_FORMAT)')
{
  /*
   * Before format 2 a model on an agent's own sign-in did nothing and was never
   * drawn, and switching back from OpenRouter kept the OpenRouter id. So the
   * reviewer's case — Codex tried on OpenRouter, then set back — is stored as
   * exactly this, and must not launch `codex -m anthropic/claude-sonnet-5` on a
   * ChatGPT sign-in after the upgrade.
   */
  const leftover: AgentEndpoint = { ...DEFAULT_ENDPOINT, model: 'anthropic/claude-sonnet-5' }
  const before = { chosen: ['codex'], endpoints: { codex: leftover } }

  check(
    'the format a block names: none, junk and fractions are 1; a whole number ≥ 1 is itself',
    [undefined, null, '2', 0, -1, 1.5, NaN, 1, 2, 3].map(agentsFormatOf),
    [1, 1, 1, 1, 1, 1, 1, 1, 2, 3]
  )
  check('this build writes format 3', AGENTS_FORMAT, 3)

  check('upgradeEndpoint from 1: a default-mode model is cleared', upgradeEndpoint(leftover, 1), DEFAULT_ENDPOINT)
  check('from 2 it is kept — it was set through the Default model field', upgradeEndpoint(leftover, 2), leftover)
  check('an OpenRouter model is never a leftover', upgradeEndpoint(or(), 1), or())
  check('nor a custom endpoint’s', upgradeEndpoint(custom(), 1), custom())
  check(
    'a default endpoint keeps its base URL and key: they reach nothing on its own sign-in, and Settings keeps them across a mode switch',
    upgradeEndpoint({ ...custom(), mode: 'default' }, 1),
    { ...custom(), mode: 'default', model: '' }
  )

  const up = hydrateAgents(before)
  check('hydrate: the leftover is gone, and with it the whole stored entry', up.endpoints, {})
  check('and the block now says this build’s format, so the upgrade runs once', up.format, AGENTS_FORMAT)
  check('so Codex launches on its own sign-in with no model flag', planOk(plan('codex', up.endpoints.codex)), { args: [], env: {}, model: '' })
  check(
    'counterfactual: the same entry in a format-2 file IS the Default model — which is what the upgrade prevents for old files',
    planOk(plan('codex', hydrateAgents({ ...before, format: 2 }).endpoints.codex)).args,
    ['-m', 'anthropic/claude-sonnet-5']
  )
  check('a second hydrate changes nothing (gotcha 116)', hydrateAgents(up), up)
  check(
    'a Default model chosen after the upgrade survives every later read',
    hydrateAgents({ ...up, endpoints: { codex: { ...DEFAULT_ENDPOINT, model: 'gpt-6.1-sol' } } }).endpoints,
    { codex: { ...DEFAULT_ENDPOINT, model: 'gpt-6.1-sol' } }
  )
  check(
    'only default-mode models go: OpenRouter and custom endpoints come through untouched',
    hydrateAgents({ endpoints: { codex: leftover, opencode: or('z-ai/glm-5'), aider: custom() } }).endpoints,
    { opencode: or('z-ai/glm-5'), aider: custom() }
  )
  check(
    'a newer build’s format is not upgraded again, and is written back as this build’s',
    [hydrateAgents({ ...before, format: 4 }).endpoints, hydrateAgents({ ...before, format: 4 }).format],
    [{ codex: leftover }, AGENTS_FORMAT]
  )
  check('a junk format is 1, and upgraded', hydrateAgents({ ...before, format: '2' }).endpoints, {})
  check('no agents block at all is this build’s format', [hydrateAgents(undefined).format, hydrateAgents('junk').format], [3, 3])
  check('the default settings carry it', DEFAULT_SETTINGS.agents.format, AGENTS_FORMAT)
}

console.log('\nidentity: a file named after the agent is not always the agent')
{
  const byId = (id: CodingCliId) => CODING_CLIS.find((c) => c.id === id)!
  const grok = byId('grok').identify!
  const amp = byId('amp').identify!
  ok('Grok Build’s own version line is Grok Build', grok.test('grok 1.0.34 (3736acbc8658)'))
  ok('the community grok-cli’s bare version is not', !grok.test('1.1.7'))
  ok('nor is Homebrew’s regex tool', !grok.test('grok v0.1.0'))
  ok('Amp’s version is Amp', amp.test('0.0.1789790452-gad4023'))
  ok('Homebrew’s amp editor is not', !amp.test('amp 0.7.1'))
  ok('cursor looks for cursor-agent, never the bare `agent` Grok also installs', !byId('cursor').bins.posix.includes('agent'))
}

console.log('\nevery agent: a continue flag only where CLI_CAPS says there is one')
for (const c of CODING_CLIS) {
  if (c.id === 'claude') continue
  const args = planOk(plan(c.id, undefined, { continueLast: true })).args
  ok(
    `${c.id}: continuing ${CLI_CAPS[c.id].resume === 'continue' ? 'appends its flag' : 'appends nothing'}`,
    CLI_CAPS[c.id].resume === 'continue' ? args.join(' ').endsWith((c.continueArgs ?? []).join(' ')) : args.length === 0,
    JSON.stringify(args)
  )
}
check('claude is never planned here — its launch is buildArgs', planOk(plan('claude', or())), { args: [], env: {}, model: '' })

console.log('\ninstalling')
{
  check('only ids from the table survive', installSteps(['codex', '$(rm -rf ~)', 'banana'], 'darwin').map((s) => s.id), ['codex'])
  check('in table order', installSteps(['pi', 'codex'], 'linux').map((s) => s.id), ['codex', 'pi'])
  const mac = installScript(['codex', 'pi'], 'darwin') ?? ''
  ok(
    'the script runs each vendor command verbatim — codex told not to stop and ask',
    mac.includes('( curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh )')
  )
  ok('and says what each needs first', /needs %s\\n' 'Node\.js 22\.19 or newer'/.test(mac), mac)
  ok('a failure is recorded and the rest still run', (mac.match(/\|\| failed=/g) ?? []).length === 2)
  ok('and the script exits non-zero if any failed, which the exit card reads', /exit 1; fi/.test(mac))
  /*
   * Run for real — but only ever a SYNTHETIC step, never a table command. The
   * first version of this test built the script from the table and swapped the
   * vendor URL with `String.replace`, which replaces the first occurrence: the
   * printed one. The executed line still fetched the real installer, and two
   * runs upgraded this machine's Codex and installed Pi globally. So the step
   * below is made up, and the script is built with `scriptFor`.
   *
   * What it proves: a download that fails must fail its step. Without pipefail
   * `curl … | sh` took sh's status — 0 on an empty pipe — and the tab printed
   * "Done." (found by review).
   */
  {
    const fake = scriptFor(
      [
        { id: 'codex', label: 'Unreachable', command: 'curl -fsSL http://127.0.0.1:9/none | sh' },
        { id: 'pi', label: 'Harmless', command: 'true' }
      ],
      'darwin'
    ) ?? ''
    ok('the synthetic script runs no table command', !/https:\/\//.test(fake))
    // A POSIX script wants a POSIX bash. Windows has none at /bin/bash — the
    // first Windows CI run died here reading `r.stdout` off an ENOENT — but it
    // has Git Bash wherever Claude Code does, found the way the CLI finds it.
    // None at all is a FAIL that says so, not a skip (gotcha 113).
    const bash = process.platform === 'win32' ? gitBashPath() : '/bin/bash'
    const r = bash ? spawnSync(bash, ['-c', fake], { encoding: 'utf8', timeout: 20_000, cwd: tmpdir() }) : null
    const out = String(r?.stdout ?? '')
    ok(
      'a failed download fails its step, the next step still runs, and the script exits 1 naming it',
      r?.status === 1 && /Did not install:.*Unreachable/.test(out) && /Installing.*Harmless/s.test(out),
      r
        ? `${bash}: status ${r.status}${r.error ? ` (${r.error.message})` : ''}: ${JSON.stringify(out.slice(-240))}`
        : 'no bash here to run a POSIX script with'
    )
  }
  const win = installScript(['codex', 'copilot'], 'win32') ?? ''
  const decode = (b64: string): string => {
    const bin = atob(b64)
    let out = ''
    for (let i = 0; i < bin.length; i += 2) out += String.fromCharCode(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8))
    return out
  }
  const encoded = [...win.matchAll(/-EncodedCommand (\S+)/g)].map((m) => decode(m[1]))
  ok(
    'windows: each step in its OWN PowerShell, so a vendor script’s `exit` ends only its step and its exit code is its own',
    encoded.length === 2 &&
      encoded[1].includes('; winget install --id GitHub.Copilot -e --source winget --accept-source-agreements --accept-package-agreements; $code = $LASTEXITCODE;'),
    JSON.stringify(encoded)
  )
  ok(
    'a machine with no winget fails the step with a reason — never `exit $null`, which is exit 0 (measured on the arm64 runner)',
    encoded[1].startsWith('if (-not (Get-Command winget') && encoded[1].includes('if ($null -eq $code) { exit 1 }') && !/exit \$LASTEXITCODE/.test(encoded[1])
  )
  ok(
    'a winget step counts "already installed" (0x8A15002B / 0x8A150061) as installed, and only a winget step does',
    encoded[1].includes('-1978335189') && !encoded[0].includes('-1978335189')
  )
  ok('every winget command in the table is non-interactive and exact', CODING_CLIS.every((c) => !c.install.win32?.startsWith('winget ') || /--id \S+ -e --source winget --accept-source-agreements --accept-package-agreements$/.test(c.install.win32)))

  /*
   * A fresh Windows has no Node.js, and every `npm install -g` agent needs it.
   * The script installs it first (winget's Node LTS), re-reads PATH so the npm
   * steps can see it, and marks those steps failed — never runs them into a
   * wall — when it cannot. PATH is re-read before EVERY step, deduplicated.
   */
  const npmWin = installScript(['claude', 'gemini'], 'win32') ?? ''
  const plainWin = installScript(['claude', 'codex'], 'win32') ?? ''
  ok('a script with an npm agent installs Node first, when npm is missing', /if \(-not \(Get-Command npm[\s\S]*winget install --id OpenJS\.NodeJS\.LTS -e --source winget/.test(npmWin))
  ok('naming who needs it', npmWin.includes("Installing Node.js, needed by Gemini CLI'"))
  ok('and with no winget, says where to get Node rather than failing obscurely', /no winget to install it with\. Get it from https:\/\/nodejs\.org/.test(npmWin))
  ok('and when winget ran but Node did not arrive, says THAT — with winget\'s exit code — not "no winget"', /if \(\$hadWinget\) \{\s*Write-Host \('    The Node\.js install did not finish \(winget exit code ' \+ \$nodeCode/.test(npmWin))
  ok('the npm step is skipped and marked failed when Node is still missing', npmWin.includes("if ($nodeMissing) { $failed += 'Gemini CLI' } else {"))
  ok('a script with no npm agent carries no Node step at all', !plainWin.includes('OpenJS.NodeJS.LTS') && !plainWin.includes('$nodeMissing'))
  ok('PATH is re-read from the registry before every step', (npmWin.match(/^Update-StokePath$/gm) ?? []).length === 3)
  ok('and deduplicated, or eighteen steps could pass the 32,767-character limit', /ContainsKey\(\$p\.ToLowerInvariant\(\)\)/.test(npmWin))
  {
    const argv = windowsInstallerArgs()
    const stub = decode(argv[argv.indexOf('-EncodedCommand') + 1] ?? '')
    ok('the install tab\'s Windows argv is a fixed stub, not -File (execution policy governs a script file; AllSigned would kill the tab)', !argv.includes('-File') && argv.includes('-EncodedCommand'), argv.join(' '))
    ok('the stub reads the script path from the environment, as data (gotcha 101), and removes the variable before running it', stub.includes(`$env:${INSTALL_SCRIPT_ENV}`) && stub.includes(`Remove-Item Env:${INSTALL_SCRIPT_ENV}`) && stub.includes('[scriptblock]::Create'), stub)
  }
  /*
   * pty.ts runs the Windows script from a FILE now: as one
   * -EncodedCommand it had to fit Windows' 32,767-character command line, and
   * with every step itself encoded inside it, "select all" measured 29,640 on
   * 2026-09-21. What still travels on a command line is each STEP's own encoded
   * body, one child PowerShell each — held well under the limit here.
   */
  {
    const everyWin = installScript(CODING_CLIS.filter((c) => c.install.win32).map((c) => c.id), 'win32') ?? ''
    const longest = Math.max(...[...everyWin.matchAll(/-EncodedCommand (\S+)/g)].map((m) => m[1].length))
    ok(`every step's own encoded command fits a command line with room to spare (longest: ${longest} characters)`, longest < 8000)
  }
  /*
   * Run through a real PowerShell where there is one (CI's ubuntu runner ships
   * pwsh). Every generated Windows script must PARSE — a syntax slip here is a
   * red card on every Windows machine and nothing else would see it — and a
   * synthetic one is EXECUTED, with `powershell.exe` stood in for by a
   * function. Synthetic steps only, never a table command (the rule above).
   */
  // `pwsh.exe` on Windows: looking only for `pwsh` found none on the one OS
  // guaranteed to have PowerShell, so the scripts went unparsed there.
  const pwshName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  const pwsh = [process.env.STOKE_PWSH, ...(process.env.PATH ?? '').split(delimiter).map((d) => d && join(d, pwshName))].find(
    (p): p is string => !!p && existsSync(p)
  )
  if (!pwsh && process.env.GITHUB_ACTIONS === 'true') {
    // Every GitHub runner image ships PowerShell 7, so none here is a broken
    // lookup rather than a machine without it (gotcha 113).
    ok('a GitHub runner has PowerShell 7 to parse the Windows scripts with', false, `looked for ${pwshName} on PATH`)
  }
  if (!pwsh) {
    console.log('  NOTE  no PowerShell here (set STOKE_PWSH to one): the Windows scripts are read above, not parsed or run. CI runs them.')
  } else {
    const parseErrors = (script: string): string[] => {
      const r = spawnSync(
        pwsh,
        ['-NoProfile', '-NonInteractive', '-Command', '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }'],
        { input: script, encoding: 'utf8', timeout: 60_000 }
      )
      return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    }
    const every = installScript(CODING_CLIS.map((c) => c.id), 'win32') ?? ''
    check('the Windows script for EVERY agent parses in PowerShell', parseErrors(every), [])
    const synthetic = scriptFor(
      [
        { id: 'claude', label: 'Works', command: 'Write-Output step-one-ran' },
        { id: 'codex', label: 'Breaks', command: 'exit 3' },
        { id: 'grok', label: 'After', command: 'Write-Output step-three-ran' }
      ],
      'win32'
    ) ?? ''
    // Exactly as pty.ts starts it: the script in a UTF-8 file with a BOM, read
    // and run by windowsInstallerArgs' stub, the path in INSTALL_SCRIPT_ENV.
    // (Not stdin: `-Command -` reads line by line like a prompt, so a
    // multi-line function and `exit` do not behave as in a script.)
    const shim = `function powershell.exe { & '${pwsh.replace(/'/g, "''")}' @args }\n`
    const runAsStoke = (script: string, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof spawnSync> => {
      const dir = mkdtempSync(join(tmpdir(), 'stoke-winscript-'))
      const file = join(dir, 'install.ps1')
      writeFileSync(file, '\uFEFF' + shim + script + '\n')
      const r = spawnSync(pwsh, ['-NonInteractive', ...windowsInstallerArgs()], { encoding: 'utf8', timeout: 120_000, cwd: dir, env: { ...env, [INSTALL_SCRIPT_ENV]: file } })
      rmSync(dir, { recursive: true, force: true })
      return r
    }
    const run = runAsStoke(synthetic)
    const noWinget = scriptFor([{ id: 'copilot', label: 'NoWinget', command: 'winget install --id Nope.Nope -e --source winget --accept-source-agreements --accept-package-agreements' }], 'win32') ?? ''
    // PATH without winget, which no machine running this suite has anyway.
    const run2 = runAsStoke(noWinget, { ...process.env, PATH: dirname(pwsh) })
    const clean = runAsStoke(scriptFor([{ id: 'claude', label: 'Fine', command: 'Write-Output fine-ran' }], 'win32') ?? '')
    ok(
      'windows, run: a script whose steps all succeed exits 0 through the stub',
      clean.status === 0 && /fine-ran/.test(String(clean.stdout)) && /Done\./.test(String(clean.stdout)),
      `status ${clean.status}: ${JSON.stringify((String(clean.stdout) + String(clean.stderr)).slice(-400))}`
    )
    /*
     * "No winget" is simulated by a PATH without it, which holds only where
     * there is no registry. On Windows the script re-reads the Machine and User
     * PATH before every step (`Update-StokePath`, so a step sees what the one
     * before it installed), and that finds the runner's real winget: the
     * windows-latest run printed winget's own "No package found matching input
     * criteria." So there it asserts what that machine can show — the step
     * that cannot install fails, is named, and is never "Done." — and the
     * no-winget-at-all branch stays proven on the Linux gate.
     */
    const run2Out = String(run2.stdout)
    const noWingetHere = process.platform !== 'win32'
    ok(
      noWingetHere
        ? 'windows, run: a winget step on a machine with NO winget is a failure that says why, not a silent "installed"'
        : 'windows, run: a winget step that cannot install is a failure, named, never a silent "installed" (this machine has winget)',
      run2.status === 1 &&
        /Did not install: NoWinget/.test(run2Out) &&
        (noWingetHere ? /has no winget/.test(run2Out) : !/Done\./.test(run2Out)),
      `status ${run2.status}: ${JSON.stringify((run2Out + String(run2.stderr)).slice(-400))}`
    )
    ok(
      'windows, run: a failing step is named, the steps after it still run, and the script exits 1',
      run.status === 1 && /step-one-ran/.test(String(run.stdout)) && /step-three-ran/.test(String(run.stdout)) && /Did not install: Breaks/.test(String(run.stdout)),
      `status ${run.status}: ${JSON.stringify((String(run.stdout) + String(run.stderr)).slice(-400))}`
    )
  }
  ok('codex on windows is told not to stop and ask, too', encoded[0]?.startsWith('$env:CODEX_NON_INTERACTIVE="1";') === true, encoded[0])
  check('powershellEncode survives non-ASCII', decode(powershellEncode('Write-Host "héllo — ✓"')), 'Write-Host "héllo — ✓"')
  ok('a failed step is recorded and the script exits 1 on any', win.includes("$failed += 'Copilot CLI'") && /exit 1 }/.test(win))
  check('nothing to install is no script at all', installScript(['banana'], 'darwin'), null)
  for (const c of CODING_CLIS) {
    for (const plat of ['darwin', 'linux', 'win32'] as const) {
      const cmd = c.install[plat]
      if (!cmd) continue
      ok(
        `${c.id}/${plat}: an https source or a package manager, and no single quote to break the printf`,
        /https:\/\/|^npm install -g |^winget install /.test(cmd) && !cmd.includes("'"),
        cmd
      )
    }
  }
}

console.log('\nskills: who can see what, from a fake home (never the real one — gotcha 74)')
{
  const home = mkdtempSync(join(tmpdir(), 'stoke-skills-'))
  const skill = (dir: string, name: string): string => {
    const at = join(home, dir, name)
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
    return at
  }
  try {
    const shared = skill('.agents/skills', 'shared-one')
    mkdirSync(join(home, '.claude/skills'), { recursive: true })
    symlinkSync(shared, join(home, '.claude/skills', 'shared-one'))
    skill('.claude/skills', 'claude-only')
    skill('.claude/skills', 'copied')
    skill('.codex/skills', 'copied')
    mkdirSync(join(home, '.agents/skills', 'not-a-skill'), { recursive: true })
    const scans = await scanSkills(home)
    const names = (dir: string) => scans.find((x) => x.dir === dir)?.skills.map((k) => k.name)
    check('a folder with no SKILL.md is not a skill', names('~/.agents/skills'), ['shared-one'])
    check('a link counts in the folder it sits in', names('~/.claude/skills'), ['claude-only', 'copied', 'shared-one'])
    const r = skillReport(scans, ['claude', 'codex', 'cursor', 'aider'])
    check('three distinct skills', r.total, 3)
    check('per agent — Codex sees its own ~/.codex/skills too', r.perAgent, [
      { id: 'claude', visible: 3 },
      { id: 'codex', visible: 2 },
      { id: 'cursor', visible: 3 },
      { id: 'aider', visible: 0 }
    ])
    check(
      'the Claude-only skill is the one Codex misses — and Aider, which has no skills, misses nothing',
      r.partial.map((x) => [x.name, x.missing]),
      [['claude-only', ['codex']]]
    )
    check('a link is one skill, not a copy; two real folders are', r.duplicated.map((x) => x.name), ['copied'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  ok('every agent has a skills entry, so a new one cannot be forgotten', CODING_CLIS.every((c) => Array.isArray(SKILL_DIRS[c.id])))
  check('the report lends Claude nothing when sharing is off', skillReport([], ['claude']).projected, [])
  ok('and the shared folder is in nearly all of them', CODING_CLIS.filter((c) => SKILL_DIRS[c.id].includes(SHARED_SKILLS_DIR)).length >= CODING_CLIS.length - 2)
}

console.log('\nskills Claude Code is lent at launch: the projection, on a fake home (gotcha 74)')
{
  // realpath'd: macOS's own tmpdir is a symlink, and the projection compares
  // real paths, so an unresolved fixture root would compare a path with itself
  // under two spellings.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-share-')))
  const skill = (dir: string, name: string): string => {
    const at = join(home, dir, name)
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
    return at
  }
  const link = (target: string, dir: string, name: string): void => {
    mkdirSync(join(home, dir), { recursive: true })
    symlinkSync(target, join(home, dir, name))
  }
  // A bystander that was deleted reads as '' — a FAIL line, not a crash that
  // skips every assertion after it.
  const readOr = (path: string): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  let userData: string | null = null
  const listing = (root: string): string[] => {
    const out: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n)
        const st = lstatSync(p)
        out.push(`${p.slice(root.length)}${st.isSymbolicLink() ? ` -> ${readlinkSync(p)}` : ''}`)
        if (st.isDirectory()) walk(p)
      }
    }
    walk(root)
    return out
  }
  try {
    // Claude already has it: linked into ~/.claude/skills under the same name.
    link(skill('.agents/skills', 'in-both'), '.claude/skills', 'in-both')
    // Claude already has it under ANOTHER name: one skill by real path.
    link(skill('.agents/skills', 'aliased'), '.claude/skills', 'my-alias')
    // A different skill with the same name in each: Claude's own wins.
    skill('.agents/skills', 'copied')
    skill('.claude/skills', 'copied')
    // Only in the shared folder: these are what the projection is for.
    const only = skill('.agents/skills', 'only-shared')
    skill('.agents/skills', 'trimmed')
    // A second shared name for one folder: projected once.
    link(only, '.agents/skills', 'second-name')
    // A shared entry that IS one of Claude's plugin skills: already seen.
    const pluginRoot = join(home, 'plugin-src', 'tools')
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
    writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tools' }))
    const helper = join(pluginRoot, 'skills', 'helper')
    mkdirSync(helper, { recursive: true })
    writeFileSync(join(helper, 'SKILL.md'), '---\nname: helper\n---\n')
    link(helper, '.agents/skills', 'via-plugin')
    // And one plugin skill nothing else has.
    mkdirSync(join(pluginRoot, 'skills', 'solo'), { recursive: true })
    writeFileSync(join(pluginRoot, 'skills', 'solo', 'SKILL.md'), '---\nname: solo\n---\n')
    // A switched-off plugin and a project-scope one are not Claude's here.
    const offRoot = join(home, 'plugin-src', 'off')
    mkdirSync(join(offRoot, 'skills', 'hidden'), { recursive: true })
    writeFileSync(join(offRoot, 'skills', 'hidden', 'SKILL.md'), 'x')
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'tools@market': [{ scope: 'user', installPath: pluginRoot }],
          'off@market': [{ scope: 'user', installPath: offRoot }],
          'proj@market': [{ scope: 'project', projectPath: '/somewhere', installPath: offRoot }]
        }
      })
    )
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@market': false } }))

    const scans = await scanSkills(home)
    const names = (dir: string) => scans.find((x) => x.dir === dir)?.skills.map((k) => k.name)
    check(
      "Claude's plugin skills are scanned as Claude invokes them, enabled user-scope only",
      names(CLAUDE_PLUGIN_SKILLS),
      ['tools:helper', 'tools:solo']
    )
    check(
      'projected: only what Claude cannot already see, each folder once',
      claudeProjection(scans).map((k) => k.name),
      ['only-shared', 'trimmed']
    )
    check(
      'a trim in skillOverrides is honoured (Claude itself ignores it for plugin skills)',
      claudeProjection(scans, { trimmed: 'off' }).map((k) => k.name),
      ['only-shared']
    )
    check(
      'so is one keyed by the namespaced name',
      claudeProjection(scans, { [`${CLAUDE_SHARED_PLUGIN}:trimmed`]: 'off' }).map((k) => k.name),
      ['only-shared']
    )
    check(
      'name-only cannot be expressed for a plugin skill, so it is left out too',
      claudeProjection(scans, { trimmed: 'name-only' }).map((k) => k.name),
      ['only-shared']
    )
    check('an explicit "on" is on', claudeProjection(scans, { trimmed: 'on' }).map((k) => k.name), ['only-shared', 'trimmed'])
    check(
      "a trim takes the folder out under every name: trimming the lent one does not lend its alias ('second-name') instead",
      claudeProjection(scans, { 'only-shared': 'off' }).map((k) => k.name),
      ['trimmed']
    )
    check(
      'nor does a trim of the name Claude shows hand that name to another folder that flattens to it',
      claudeProjection(
        [
          {
            dir: SHARED_SKILLS_DIR,
            skills: [
              { name: 'a-b', real: '/r/2' },
              { name: 'a.b', real: '/r/1' }
            ]
          }
        ],
        { 'a-b': 'off' }
      ).map((k) => k.name),
      []
    )
    check(
      'two names Claude flattens to one are projected once',
      claudeProjection([
        {
          dir: SHARED_SKILLS_DIR,
          skills: [
            { name: 'a.b', real: '/r/1' },
            { name: 'a-b', real: '/r/2' }
          ]
        }
      ]).map((k) => k.name),
      ['a-b']
    )
    check("the flattening is the CLI's own", pluginSkillName('my skill.v2'), 'my-skill-v2')

    const r = skillReport(scans, ['claude', 'codex'], { shareToClaude: true })
    check('the report counts the projected skills as visible to Claude', r.projected, ['only-shared', 'trimmed'])
    check(
      'with sharing on, Claude misses no shared skill, and a skill seen under another name or through a plugin is not missing; the plugin-only skill is Claude-only',
      r.partial.map((x) => [x.name, x.missing]),
      [['tools:solo', ['codex']]]
    )
    const off = skillReport(scans, ['claude', 'codex'], { shareToClaude: false })
    ok(
      "with sharing off, the shared-only skills are Claude's misses again",
      off.partial.some((x) => x.name === 'only-shared' && x.missing.includes('claude')) && off.projected.length === 0,
      JSON.stringify(off.partial)
    )

    // --- the projector: a real folder under a fake userData ---
    userData = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-share-ud-')))
    const agentsDir = join(userData, 'agents')
    const root = join(agentsDir, 'claude-skills')
    mkdirSync(root, { recursive: true })
    // Bystanders: beside the plugin dir, inside it under a name Stoke never
    // makes, and the target of a stale set's link, which a recursive delete
    // through the link would empty.
    writeFileSync(join(agentsDir, 'pi-provider.ts'), 'keep me')
    writeFileSync(join(root, 'README.txt'), 'keep me too')
    const staleTarget = join(userData, 'stale-target')
    mkdirSync(staleTarget)
    writeFileSync(join(staleTarget, 'SKILL.md'), 'still here')
    const stale = join(root, '0123456789abcdef')
    mkdirSync(join(stale, 'skills'), { recursive: true })
    symlinkSync(staleTarget, join(stale, 'skills', 'old'))
    const project = join(home, 'project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { trimmed: 'off' } }))
    const other = join(home, 'other')
    mkdirSync(other)
    const beforeHome = listing(home)
    const projector = (): ClaudeSkillsProjector =>
      new ClaudeSkillsProjector({ root, home, claudeDir: join(home, '.claude'), managedDir: null })

    const run1 = projector()
    const [a, b, c] = await Promise.all([run1.prepare(project), run1.prepare(project), run1.prepare(project)])
    ok('three launches at once get one set', a !== null && a === b && b === c, `${a} ${b} ${c}`)
    ok('inside its own directory', !!a && dirname(a) === root, String(a))
    check('the per-project trim reaches the launch', a ? readdirSync(join(a, 'skills')) : null, ['only-shared'])
    check(
      'each skill is a LINK to the shared folder, not a copy',
      a ? readlinkSync(join(a, 'skills', 'only-shared')) : null,
      join(home, '.agents', 'skills', 'only-shared')
    )
    check(
      'the manifest names the plugin Claude namespaces with',
      a ? JSON.parse(readFileSync(join(a, '.claude-plugin', 'plugin.json'), 'utf8')).name : null,
      'stoke-shared'
    )
    check('and is the constant one', a ? readFileSync(join(a, '.claude-plugin', 'plugin.json'), 'utf8') : null, SHARED_PLUGIN_MANIFEST)
    ok('no half-built folder is left', !readdirSync(root).some((n) => n.startsWith('.build-')), readdirSync(root).join(' '))
    const ino = a ? statSync(join(a, '.claude-plugin', 'plugin.json')).ino : -1
    check('the same set again is the same folder', await run1.prepare(project), a)
    check('and it was not rebuilt', a ? statSync(join(a, '.claude-plugin', 'plugin.json')).ino : -2, ino)
    const d = await run1.prepare(other)
    ok('another project with no trim is another set', d !== null && d !== a, String(d))
    check('holding both', d ? readdirSync(join(d, 'skills')) : null, ['only-shared', 'trimmed'])
    ok('a set handed out this run is kept: a session may be on it', !!a && existsSync(a))
    ok("an earlier run's set is removed", !existsSync(stale))
    ok(
      'without following its link: the folder it pointed at is intact',
      readOr(join(staleTarget, 'SKILL.md')) === 'still here'
    )
    ok('a bystander beside the plugin dir survives', readOr(join(agentsDir, 'pi-provider.ts')) === 'keep me')
    ok('and one inside it that Stoke did not name', readOr(join(root, 'README.txt')) === 'keep me too')

    const run2 = projector()
    check('the next run reuses a set that still matches', await run2.prepare(other), d)
    ok('and removes the one it no longer hands out', !!a && !existsSync(a))
    ok('the shared skill itself is untouched by the removal', readOr(join(only, 'SKILL.md')).includes('only-shared'))
    check('nothing was written into the fake home: ~/.claude, ~/.agents, the project', listing(home), beforeHome)

    // A set tampered with (a link re-pointed) is not trusted.
    if (d) {
      rmSync(join(d, 'skills', 'trimmed'))
      symlinkSync(staleTarget, join(d, 'skills', 'trimmed'))
    }
    const e = await run2.prepare(other)
    check(
      'a set that no longer matches is rebuilt',
      e ? readlinkSync(join(e, 'skills', 'trimmed')) : null,
      join(home, '.agents', 'skills', 'trimmed')
    )
    ok('and the rebuild did not follow the re-pointed link either', readOr(join(staleTarget, 'SKILL.md')) === 'still here')

    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-share-empty-')))
    check(
      'nothing to share is no flag at all',
      await new ClaudeSkillsProjector({ root, home: empty, claudeDir: join(empty, '.claude'), managedDir: null }).prepare(empty),
      null
    )
    const managed = join(empty, 'managed')
    mkdirSync(join(managed, 'managed-settings.d'), { recursive: true })
    writeFileSync(join(managed, 'managed-settings.d', '10-org.json'), JSON.stringify({ disableSideloadFlags: true }))
    check(
      'a policy that refuses --plugin-dir at startup gets no flag (a session that never starts)',
      await new ClaudeSkillsProjector({ root, home, claudeDir: join(home, '.claude'), managedDir: managed }).prepare(other),
      null
    )
    rmSync(empty, { recursive: true, force: true })

    // --- where the local layer lives: the repo's top, not the cwd (gotcha 117) ---
    // A real repo, made by git itself, so the worktree layout is git's and not
    // this suite's idea of it. Isolated from the user's git config (hooks,
    // templates, signing), and only ever run inside the fake home.
    const gitCfg = join(home, 'gitconfig-empty')
    writeFileSync(gitCfg, '')
    const git = (cwd: string, ...args: string[]): boolean =>
      spawnSync(
        'git',
        ['-c', 'user.name=stoke', '-c', 'user.email=stoke@example.invalid', '-c', 'commit.gpgsign=false', ...args],
        { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitCfg, GIT_TERMINAL_PROMPT: '0' } }
      ).status === 0
    // The native realpath, as main's `realpath` is: on Windows it also expands
    // 8.3 short names (a runner's TEMP is C:\Users\RUNNER~1\…), the JS one does not.
    // A folder git failed to make answers its own path, so the checks below
    // print FAIL rather than the suite dying on ENOENT.
    const real = (p: string): string => {
      try {
        return realpathSync.native(p)
      } catch {
        return p
      }
    }
    const local = (dir: string): string => join(real(dir), '.claude', 'settings.local.json')
    const repo = join(home, 'repo')
    mkdirSync(join(repo, '.claude'), { recursive: true })
    ok('git made the fixture repo', git(home, 'init', '-q', repo))
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { trimmed: 'off' } }))
    const sub = join(repo, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    const legacy = join(repo, 'legacy')
    mkdirSync(join(legacy, '.claude'), { recursive: true })
    writeFileSync(
      join(legacy, '.claude', 'settings.local.json'),
      JSON.stringify({ skillOverrides: { trimmed: 'on', 'only-shared': 'off' } })
    )
    ok('and a commit', git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'fixture'))
    // Where Stoke's own worktrees live, and where the reviewer's case was.
    const wt = join(repo, '.claude', 'worktrees', 'wt')
    ok('and a linked worktree', git(repo, 'worktree', 'add', '-q', wt))
    const uid = statSync(repo).uid
    const opts = { claudeDir: join(home, '.claude'), home, uid }

    check('a repo top is its own local layer, with no legacy one under it', await localSettingsFiles(repo, home, uid), [local(repo)])
    check(
      "a subfolder reads the repo top's settings.local.json, over its own",
      await localSettingsFiles(sub, home, uid),
      [local(sub), local(repo)]
    )
    check(
      "a linked worktree reads the MAIN worktree's, not its own checkout's",
      await localSettingsFiles(wt, home, uid),
      [local(wt), local(repo)]
    )
    check('a folder in no repo reads its own only', await localSettingsFiles(other, home, uid), [local(other)])
    check('where there are no uids, the CLI never moves it (POSIX-only)', await localSettingsFiles(sub, home, null), [local(sub)])
    check("nor off a repo that is not the user's", await localSettingsFiles(sub, home, uid + 1), [local(sub)])
    check(
      "the cwd's copy is still read, UNDER the root's: the root's 'off' wins, the cwd's own trim stays",
      await skillOverridesFor(legacy, opts),
      { trimmed: 'off', 'only-shared': 'off' }
    )
    const repoHome = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-share-homerepo-')))
    try {
      ok('git made a repo AT a home (a dotfiles repo)', git(repoHome, 'init', '-q', repoHome))
      const inHome = join(repoHome, 'proj')
      mkdirSync(inHome)
      check('a repo that IS the home is never the local layer', await localSettingsFiles(inHome, repoHome, uid), [local(inHome)])
      check('the same repo under another home is', await localSettingsFiles(inHome, home, uid), [local(inHome), local(repoHome)])
    } finally {
      rmSync(repoHome, { recursive: true, force: true })
    }

    const inRepo = new ClaudeSkillsProjector({ root, home, claudeDir: join(home, '.claude'), managedDir: null, uid })
    const fromSub = await inRepo.prepare(sub)
    check("a tab in the repo's subfolder is not lent what the repo trims", fromSub ? readdirSync(join(fromSub, 'skills')) : null, ['only-shared'])
    const fromWt = await inRepo.prepare(wt)
    check('nor is a tab in a linked worktree of it', fromWt ? readdirSync(join(fromWt, 'skills')) : null, ['only-shared'])
    check('the two layers\' trims together leave nothing to lend, so no flag', await inRepo.prepare(legacy), null)
    // The uid production passes: this process's own, which on POSIX owns the
    // fixture; Node on Windows has none, and there the CLI never moves the
    // layer either, so the repo's trim is not Claude's and is not honoured.
    const byDefault = await new ClaudeSkillsProjector({ root, home, claudeDir: join(home, '.claude'), managedDir: null }).prepare(sub)
    check(
      "with the process's own uid, as a launch has it",
      byDefault ? readdirSync(join(byDefault, 'skills')) : null,
      process.platform === 'win32' ? ['only-shared', 'trimmed'] : ['only-shared']
    )
  } finally {
    // In finally: a throw anywhere above must not leave a fixture behind.
    if (userData) rmSync(userData, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }

  // The one place the flag is pushed, and its gate. A source check, as
  // verify:cli does for PATH: `start()` needs a real pty to call.
  const pty = readFileSync(new URL('../src/main/pty.ts', import.meta.url), 'utf8')
  const pushes = pty.split('\n').filter((l) => l.includes("'--plugin-dir'"))
  ok(
    'pty.ts pushes --plugin-dir once, only for an instrumented (local Claude) session, never ssh (gotcha 19)',
    pushes.length === 1 && /\binstrumented\b/.test(pushes[0]),
    pushes.join(' | ')
  )
  const headless = readFileSync(new URL('../src/main/agent.ts', import.meta.url), 'utf8')
  ok('agent.ts (headless runs) never names --plugin-dir (gotcha 15)', !headless.includes('--plugin-dir'))
}


console.log('\nan account in the launch plan (shared/accounts.ts)')
{
  /*
   * A login account adds its home variable, LAST, over whatever the endpoint
   * set; a key account adds its key, and only on the agent's own sign-in —
   * beside an endpoint that brings a key of its own it would send one
   * vendor's key to another. An account of another agent is refused, never
   * applied: the id reached this plan through a tab or the phone.
   */
  const codexWork: AgentAccount = { id: 'codex-work', cli: 'codex', label: 'Work', kind: 'login', home: '/h/.stoke/accounts/codex-work', apiKey: '' }
  const grokTeam: AgentAccount = { id: 'grok-team', cli: 'grok', label: 'Team', kind: 'key', home: '', apiKey: 'xai-TEAM-secret' }
  const geminiTwo: AgentAccount = { id: 'gemini-2', cli: 'gemini', label: 'Gemini 2', kind: 'login', home: '/h/.stoke/accounts/gemini-2', apiKey: '' }
  const cursorKey: AgentAccount = { id: 'cursor-ci', cli: 'cursor', label: 'CI', kind: 'key', home: '', apiKey: 'cur-CI-secret' }

  const codex = plan('codex', undefined, { account: codexWork })
  check('a Codex login account sets CODEX_HOME and nothing else', planOk(codex).env, { CODEX_HOME: '/h/.stoke/accounts/codex-work' })
  check('and adds no argument', planOk(codex).args, [])
  const codexOr = plan('codex', or('gpt-6.1'), { account: codexWork })
  check(
    'on OpenRouter too: the endpoint keeps its key, the home travels beside it',
    [planOk(codexOr).env.CODEX_HOME, planOk(codexOr).env.STOKE_OPENROUTER_API_KEY],
    ['/h/.stoke/accounts/codex-work', KEY]
  )
  const grok = plan('grok', undefined, { account: grokTeam })
  check('a Grok key account sets XAI_API_KEY', planOk(grok).env, { XAI_API_KEY: 'xai-TEAM-secret' })
  ok('and its key never reaches argv', !planOk(grok).args.join(' ').includes('xai-TEAM-secret'))
  const grokOr = plan('grok', or('x-ai/grok-5'), { account: grokTeam })
  ok(
    'a key account beside an OpenRouter endpoint is refused, with a sentence',
    !grokOr.ok && /OpenRouter/.test(grokOr.message),
    JSON.stringify(grokOr)
  )
  check(
    'a Gemini login account keeps Gemini on its per-home file store',
    planOk(plan('gemini', undefined, { account: geminiTwo })).env,
    { GEMINI_CLI_HOME: '/h/.stoke/accounts/gemini-2', GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' }
  )
  check(
    'a Cursor key always travels with the in-memory store, or it would overwrite the machine\u2019s own sign-in',
    planOk(plan('cursor', undefined, { account: cursorKey })).env,
    { AGENT_CLI_CREDENTIAL_STORE: 'memory', CURSOR_API_KEY: 'cur-CI-secret' }
  )
  const mismatch = plan('grok', undefined, { account: codexWork })
  ok('an account of another agent is refused', !mismatch.ok && /not a Grok/.test(mismatch.message), JSON.stringify(mismatch))
  const empty = plan('grok', undefined, { account: { ...grokTeam, apiKey: '' } })
  ok('a key account with no key yet is refused, not launched on the machine\u2019s own sign-in', !empty.ok, JSON.stringify(empty))
  check('no account is the plan as it always was', planOk(plan('codex', undefined, { account: null })).env, {})
  check('Claude Code\u2019s plan stays empty: its account travels in pty.ts, not here', planOk(plan('claude', undefined, { account: null })), { args: [], env: {}, model: '' })
}

console.log('\nMCP servers: one model, an adapter per agent (mcpServers.ts)')
{
  /*
   * Every launch-time adapter, exactly, on the same three servers: Stoke's
   * browser (a bearer), a stdio server with a secret in its environment, and an
   * http server with a bearer and a secret header. Written out rather than
   * derived, so an adapter change has to change its line here too.
   */
  const ALL = [BROWSER, ...TWO]
  const codex = plan('codex', undefined, { mcp: ALL })
  check('codex: -c overrides, every secret by variable NAME in argv and by value in env', planOk(codex), {
    args: [
      '-c', `mcp_servers.stoke.url="${MCP.url}"`,
      '-c', `mcp_servers.stoke.bearer_token_env_var="STOKE_MCP_TOKEN"`,
      '-c', 'mcp_servers.github.command="npx"',
      '-c', 'mcp_servers.github.args=["-y", "@modelcontextprotocol/server-github"]',
      '-c', 'mcp_servers.github.env_vars=["GITHUB_PERSONAL_ACCESS_TOKEN"]',
      '-c', 'mcp_servers.docs.url="https://mcp.example.com/mcp"',
      '-c', 'mcp_servers.docs.bearer_token_env_var="STOKE_MCP_2_TOKEN"',
      '-c', 'mcp_servers.docs.env_http_headers={ "X-Api-Key" = "STOKE_MCP_2_H0" }'
    ],
    env: {
      STOKE_MCP_TOKEN: MCP.token,
      GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET,
      STOKE_MCP_2_TOKEN: HTTP_BEARER,
      STOKE_MCP_2_H0: HEADER_SECRET
    },
    model: ''
  })
  keysOnlyInEnv('codex two servers', codex)

  const oc = planOk(plan('opencode', undefined, { mcp: ALL }))
  check('opencode: the inline config in OPENCODE_CONFIG_CONTENT, local and remote', JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT ?? '{}'), {
    mcp: {
      stoke: { type: 'remote', url: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` }, enabled: true },
      github: {
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-github'],
        environment: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET },
        enabled: true
      },
      docs: {
        type: 'remote',
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-Api-Key': HEADER_SECRET, Authorization: `Bearer ${HTTP_BEARER}` },
        enabled: true
      }
    }
  })
  check('opencode: nothing in argv', oc.args, [])
  keysOnlyInEnv('opencode two servers', plan('opencode', undefined, { mcp: ALL }))
  const kilo = planOk(plan('kilo', undefined, { mcp: ALL }))
  check('kilo: the same block under KILO_CONFIG_CONTENT', kilo.env.KILO_CONFIG_CONTENT, oc.env.OPENCODE_CONFIG_CONTENT)

  const qwenFile = qwenMcpFile(ALL)
  const qwen = planOk(plan('qwen', undefined, { mcp: ALL, mcpFileFor: fileFor }))
  check('qwen: one owner-only file, by path', qwen, {
    args: ['--mcp-config', fileFor(mcpFileName('qwen', qwenFile))],
    env: {},
    model: '',
    files: [{ path: fileFor(mcpFileName('qwen', qwenFile)), content: qwenFile }]
  })
  check('qwen: the Gemini-family shape, httpUrl for streamable HTTP', JSON.parse(qwenFile), {
    mcpServers: {
      stoke: { httpUrl: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } },
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET } },
      docs: { httpUrl: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': HEADER_SECRET, Authorization: `Bearer ${HTTP_BEARER}` } }
    }
  })
  keysOnlyInEnv('qwen two servers', plan('qwen', undefined, { mcp: ALL, mcpFileFor: fileFor }))

  const copFile = copilotMcpFile(ALL)
  const cop = planOk(plan('copilot', undefined, { mcp: ALL, mcpFileFor: fileFor }))
  check('copilot: --additional-mcp-config @file', cop.args, ['--additional-mcp-config', `@${fileFor(mcpFileName('copilot', copFile))}`])
  check('copilot: its own mcp-config.json shape', JSON.parse(copFile), {
    mcpServers: {
      stoke: { type: 'http', url: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` }, tools: ['*'] },
      github: {
        type: 'local',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET },
        tools: ['*']
      },
      docs: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-Api-Key': HEADER_SECRET, Authorization: `Bearer ${HTTP_BEARER}` },
        tools: ['*']
      }
    }
  })
  keysOnlyInEnv('copilot two servers', plan('copilot', undefined, { mcp: ALL, mcpFileFor: fileFor }))

  const kimiFile = kimiMcpFile(ALL)
  const kimiOwnFile = '/h/.kimi/mcp.json'
  const kimi = planOk(plan('kimi', undefined, { mcp: ALL, mcpFileFor: fileFor, mcpKeep: [kimiOwnFile] }))
  check('kimi: Stoke’s file, then its own mcp.json — naming one stops Kimi reading the default', kimi.args, [
    '--mcp-config-file', fileFor(mcpFileName('kimi', kimiFile)),
    '--mcp-config-file', kimiOwnFile
  ])
  check('kimi: fastmcp’s MCPConfig shape, remote as transport http', JSON.parse(kimiFile), {
    mcpServers: {
      stoke: { url: MCP.url, transport: 'http', headers: { Authorization: `Bearer ${MCP.token}` } },
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET } },
      docs: { url: 'https://mcp.example.com/mcp', transport: 'http', headers: { 'X-Api-Key': HEADER_SECRET, Authorization: `Bearer ${HTTP_BEARER}` } }
    }
  })
  check('kimi: with no servers, no flag — it reads its own file itself', planOk(plan('kimi', undefined, { mcp: [], mcpFileFor: fileFor, mcpKeep: [kimiOwnFile] })).args, [])
  keysOnlyInEnv('kimi two servers', plan('kimi', undefined, { mcp: ALL, mcpFileFor: fileFor, mcpKeep: [kimiOwnFile] }))

  const vibe = planOk(plan('vibe', undefined, { mcp: ALL }))
  check('vibe: VIBE_MCP_SERVERS, nothing in argv', [vibe.args, Object.keys(vibe.env)], [[], [ENV_VIBE_MCP]])
  check('vibe: a list its environment layer unions by name', JSON.parse(vibe.env[ENV_VIBE_MCP] ?? '[]'), [
    { name: 'stoke', transport: 'streamable-http', url: MCP.url, auth: { type: 'static', headers: { Authorization: `Bearer ${MCP.token}` } } },
    { name: 'github', transport: 'stdio', command: ['npx'], args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET } },
    {
      name: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      auth: { type: 'static', headers: { 'X-Api-Key': HEADER_SECRET, Authorization: `Bearer ${HTTP_BEARER}` } }
    }
  ])
  check('vibe: the same text vibeMcpEnv writes', vibe.env[ENV_VIBE_MCP], vibeMcpEnv(ALL))

  const PI_MCP_PATH = '/u/Stoke/agents/pi-mcp.ts'
  const pi = planOk(plan('pi', undefined, { mcp: ALL, piMcpExtensionPath: PI_MCP_PATH }))
  check('pi: its MCP extension by -e, the list and every value in env', pi, {
    args: ['-e', PI_MCP_PATH],
    env: {
      STOKE_MCP_0_H0: `Bearer ${MCP.token}`,
      STOKE_MCP_1_E0: STDIO_SECRET,
      STOKE_MCP_2_H0: HEADER_SECRET,
      STOKE_MCP_2_H1: `Bearer ${HTTP_BEARER}`,
      [ENV_PI_MCP]: JSON.stringify({
        stoke: { url: MCP.url, headers: { Authorization: '${STOKE_MCP_0_H0}' } },
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${STOKE_MCP_1_E0}' } },
        docs: { url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': '${STOKE_MCP_2_H0}', Authorization: '${STOKE_MCP_2_H1}' } }
      })
    },
    model: ''
  })
  ok(
    'pi: the list Pi resolves holds no secret — a value is never inlined, since Pi runs a value starting with ! as a command',
    !MCP_SECRETS.some((v) => (pi.env[ENV_PI_MCP] ?? '').includes(v))
  )
  ok('pi: the extension is constant text naming only the variable', PI_MCP_EXTENSION.includes(ENV_PI_MCP) && !MCP_SECRETS.some((v) => PI_MCP_EXTENSION.includes(v)))
  ok('pi: and does nothing on a Pi without registerMcpServer', PI_MCP_EXTENSION.includes("typeof pi.registerMcpServer !== 'function'"))
  check(
    'pi: a custom endpoint’s extension and the MCP one side by side',
    planOk(plan('pi', custom(), { mcp: [BROWSER], piMcpExtensionPath: PI_MCP_PATH })).args,
    ['-e', '/Users/u/Library/Application Support/Stoke/agents/pi-provider.ts', '--provider', 'stoke_custom', '--model', 'qwen3-coder', '-e', PI_MCP_PATH]
  )
  const piNoExt = plan('pi', undefined, { mcp: ALL, piMcpExtensionPath: null })
  check('pi: with no extension file, no flag and every server said', [planOk(piNoExt).args, (piNoExt.ok ? piNoExt.plan.mcpSkipped ?? [] : []).map((s) => s.name)], [[], ['stoke', 'github', 'docs']])
  keysOnlyInEnv('pi two servers', plan('pi', undefined, { mcp: ALL, piMcpExtensionPath: PI_MCP_PATH }))

  // The agents with no launch-time route are handed nothing at all.
  const none = CODING_CLIS.filter((c) => CLI_CAPS[c.id].mcp === 'none').map((c) => c.id)
  check(
    'CLI_CAPS names exactly the agents with no route (each with its reason, codingClis.ts)',
    none,
    ['grok', 'gemini', 'cursor', 'amp', 'aider', 'crush', 'droid', 'cline', 'auggie']
  )
  for (const id of none) {
    check(`${id}: no MCP route, so nothing is passed`, planOk(plan(id, undefined, { mcp: ALL, mcpFileFor: fileFor })), { args: [], env: {}, model: '' })
  }
  check('claude is never planned here: its servers go in --mcp-config (claudeMcpConfigs)', planOk(plan('claude', undefined, { mcp: ALL })), { args: [], env: {}, model: '' })
  check(
    'CLI_CAPS routes',
    Object.fromEntries(CODING_CLIS.filter((c) => CLI_CAPS[c.id].mcp !== 'none').map((c) => [c.id, CLI_CAPS[c.id].mcp])),
    { claude: 'file', codex: 'flags', opencode: 'env', pi: 'env', qwen: 'file', kimi: 'file', copilot: 'file', kilo: 'env', vibe: 'env' }
  )

  // Claude Code: only Stoke's servers, in one flag's list.
  const claudeOut = claudeMcpConfigs([BROWSER, DOCS], '/u/Stoke/mcp-browser.json', fileFor)
  check('claude: the browser file, then one generated file of Stoke-held servers', claudeOut, {
    configs: ['/u/Stoke/mcp-browser.json', fileFor(mcpFileName('claude', claudeShapeMcpFile([DOCS])))],
    files: [{ path: fileFor(mcpFileName('claude', claudeShapeMcpFile([DOCS]))), content: claudeShapeMcpFile([DOCS]) }]
  })
  check('claude: the browser unticked, no browser file', claudeMcpConfigs([], '/u/Stoke/mcp-browser.json', fileFor), { configs: [], files: [] })
  check('claude: nothing writable, only the browser file', claudeMcpConfigs([BROWSER, DOCS], '/u/Stoke/mcp-browser.json', null).configs, ['/u/Stoke/mcp-browser.json'])
  const pty = readFileSync(new URL('../src/main/pty.ts', import.meta.url), 'utf8')
  const mcpPushes = pty.split('\n').filter((l) => l.includes("'--mcp-config'"))
  ok(
    'pty.ts pushes --mcp-config once, only for an instrumented (local Claude) session, never ssh (gotcha 19)',
    mcpPushes.length === 1 && /\binstrumented\b/.test(mcpPushes[0]),
    mcpPushes.join(' | ')
  )

  // A file-taking agent with nowhere to write goes without, and says so.
  const noFile = plan('qwen', undefined, { mcp: ALL, mcpFileFor: null })
  check('qwen with no file store: no flag naming nothing', planOk(noFile).args, [])
  check('and every server is reported, not dropped silently', (noFile.ok ? noFile.plan.mcpSkipped ?? [] : []).map((s) => s.name), ['stoke', 'github', 'docs'])

  // A key in a URL: every agent with a route, and not one of them puts it in argv.
  for (const c of CODING_CLIS.filter((x) => CLI_CAPS[x.id].mcp !== 'none')) {
    keysOnlyInEnv(
      `${c.id} with a key in a server's URL`,
      plan(c.id, undefined, { mcp: [...ALL, KEYED], mcpFileFor: fileFor, piMcpExtensionPath: PI_MCP_PATH })
    )
  }
  const codexKeyed = plan('codex', undefined, { mcp: [...ALL, KEYED] })
  check(
    'codex: the keyed URL is skipped and said, the rest handed as before',
    [planOk(codexKeyed).args, (codexKeyed.ok ? codexKeyed.plan.mcpSkipped ?? [] : []).map((s) => s.name)],
    [planOk(codex).args, ['search']]
  )
  ok(
    'codex: and the reason names the URL and points at its own config.toml',
    /URL.*query string.*config\.toml/.test((codexKeyed.ok ? codexKeyed.plan.mcpSkipped ?? [] : [])[0]?.reason ?? ''),
    JSON.stringify(codexKeyed.ok ? codexKeyed.plan.mcpSkipped : null)
  )
  const qwenKeyed = planOk(plan('qwen', undefined, { mcp: [KEYED], mcpFileFor: fileFor }))
  check('qwen: the keyed URL is fine in its 0600 file, not argv', JSON.parse(qwenKeyed.files?.[0]?.content ?? '{}').mcpServers.search.httpUrl, KEYED.url)
}

console.log('\nMCP: names, secrets and collisions')
{
  for (const name of ['github', 'my-server_2', 'A1', 'x'.repeat(64)]) ok(`a safe server name: ${name.slice(0, 20)}`, isSafeServerName(name))
  for (const name of ['', 'a.b', 'a b', '-x', '_x', 'x;rm', 'x&y', 'x"y', 'x|y', 'x%PATH%', '__proto__', 'constructor', 'prototype', 'x'.repeat(65), 'ünï']) {
    ok(`refused: ${JSON.stringify(name.slice(0, 20))} — it becomes a TOML key and may pass through cmd.exe (gotcha 13)`, !isSafeServerName(name))
  }
  check('a Claude entry with an unsafe name is refused, not escaped', specFromClaudeEntry('a;b', { command: 'x' }).ok, false)
  check('the browser server’s name is Stoke’s', specFromClaudeEntry(STOKE_BROWSER_SERVER, { command: 'x' }).ok, false)
  check('SSE is refused, not passed as http (Qwen’s plain url IS sse)', specFromClaudeEntry('old', { type: 'sse', url: 'https://x/sse' }).ok, false)
  const oauth = specFromClaudeEntry('notion', { type: 'http', url: 'https://mcp.notion.com/mcp', oauth: { clientId: 'abc', clientSecret: 's' } })
  check(
    'an OAuth server is its URL alone — Claude’s sign-in is never copied (gotcha 36)',
    oauth.ok ? oauth.spec : null,
    { name: 'notion', transport: 'http', command: '', args: [], env: {}, url: 'https://mcp.notion.com/mcp', headers: {} }
  )
  check('${VAR} and ${VAR:-default} expand as the CLI expands them', expandEnvRefs('a ${X} ${Y:-d}', { X: '1' }), 'a 1 d')
  const unset = specFromClaudeEntry('docs', { type: 'http', url: 'https://x/mcp', headers: { K: '${NOPE}' } })
  check('an unset ${VAR} refuses the server rather than handing on the literal', unset.ok ? null : unset.reason, 'it needs ${NOPE}, which is not set')
  check('a line break in a value refuses the server', specFromClaudeEntry('x', { command: 'a', env: { K: 'v\nw' } }).ok, false)

  const refusedUrl = codexMcp([{ ...DOCS, url: 'https://x/100%25/mcp' }], [])
  check('codex: a % in a URL that reaches argv is refused (cmd.exe, gotcha 13)', [refusedUrl.args, refusedUrl.skipped.map((s) => s.name)], [[], ['docs']])
  ok('and for that reason, not the URL-key one', /cmd\.exe/.test(refusedUrl.skipped[0]?.reason ?? ''), refusedUrl.skipped[0]?.reason)

  // A URL that may carry a key never reaches Codex's argv (urlInArgvProblem).
  const http = (url: string, over: Partial<McpServerSpec> = {}): McpServerSpec => ({ ...KEYED, url, ...over })
  for (const [why, url] of [
    ['a query string (Tavily’s ?tavilyApiKey=)', 'https://mcp.tavily.example/mcp/?tavilyApiKey=tvly-abc'],
    ['a query with no & at all, which cmd.exe never flagged', 'https://mcp.exa.example/mcp?exaApiKey=k'],
    ['a user name and password', 'https://user:pass@mcp.example.com/mcp'],
    ['a key-like path segment', 'https://mcp.example.com/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5/mcp'],
    ['a capability UUID in the path', 'https://mcp.example.com/server/0f8fad5b-d9cb-469f-a165-70867728950e/mcp']
  ] as const) {
    ok(`urlInArgvProblem: ${why}`, urlInArgvProblem(http(url)) !== null)
    const out = codexMcp([http(url)], [])
    check(`codex: refused — ${why}`, [out.args, out.skipped.map((s) => s.name)], [[], ['search']])
  }
  for (const url of [
    'https://api.githubcopilot.com/mcp/',
    'https://mcp.deepwiki.com/mcp',
    'https://mcp.vercel.com',
    'https://observability.mcp.cloudflare.com/mcp',
    MCP.url
  ]) {
    ok(`urlInArgvProblem: a plain endpoint passes — ${url}`, urlInArgvProblem(http(url)) === null)
  }
  const fromEnv = specFromClaudeEntry('keyed', { type: 'http', url: 'https://mcp.example.com/k/${SHORT_KEY}/mcp' }, { SHORT_KEY: 'abc' })
  check('a URL built from ${VAR} is marked, whatever it expanded to', fromEnv.ok ? [fromEnv.spec.url, fromEnv.spec.urlFromEnv] : null, ['https://mcp.example.com/k/abc/mcp', true])
  check('and Codex is never handed it', fromEnv.ok ? codexMcp([fromEnv.spec], []).skipped.map((s) => s.name) : null, ['keyed'])
  const literal = specFromClaudeEntry('plain', { type: 'http', url: 'https://mcp.example.com/mcp' })
  check('a literal URL is not marked', literal.ok ? literal.spec.urlFromEnv : 'refused', undefined)
  check('a stdio server is never judged by URL', urlInArgvProblem(GITHUB), null)
  check(
    'the Settings summary carries the reason (never the URL) so Codex’s row can say it',
    [summarize(KEYED).detail, typeof summarize(KEYED).urlProblem, JSON.stringify(summarize(KEYED)).includes(URL_SECRET)],
    ['https://mcp.search.example', 'string', false]
  )
  const ownPath = codexMcp([{ ...GITHUB, env: { PATH: '/evil' } }], [])
  check('codex: a server may not set a variable Codex itself runs on', [ownPath.args, ownPath.skipped.map((s) => s.name)], [[], ['github']])
  const clash = codexMcp([GITHUB, { ...GITHUB, name: 'github2', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'other' } }], [])
  check('codex: two servers wanting one variable with different values — the later is skipped', clash.skipped.map((s) => s.name), ['github2'])
  const endpointVar = plan('codex', custom(), { mcp: [{ ...GITHUB, env: { STOKE_CUSTOM_API_KEY: 'x' } }] })
  check('codex: a server may not take a variable the endpoint set', (endpointVar.ok ? endpointVar.plan.mcpSkipped ?? [] : []).map((s) => s.name), ['github'])

  const toml = [
    'mcp_servers.dotted.command = "x"',
    '[mcp_servers.node_repl]',
    'command = "node"',
    '[mcp_servers."computer-use"]',
    '[mcp_servers.cua_repl.env]',
    '[mcp_servers]',
    'inline = { command = "y" }',
    '[profiles.github]',
    'github = 1'
  ].join('\n')
  check('codexConfiguredServers reads its own config.toml’s names', codexConfiguredServers(toml).sort(), ['computer-use', 'cua_repl', 'dotted', 'inline', 'node_repl'])
  const own = plan('codex', undefined, { mcp: [BROWSER, GITHUB], mcpOwn: ['github'] })
  check('codex: a name its own config.toml defines is skipped — `-c` would merge into the user’s entry', [planOk(own).args.some((a) => a.includes('github')), (own.ok ? own.plan.mcpSkipped ?? [] : []).map((s) => s.name)], [false, ['github']])
  const kimiOwn = plan('kimi', undefined, { mcp: [BROWSER, GITHUB], mcpFileFor: fileFor, mcpOwn: ['github'] })
  check('kimi: a name its own mcp.json defines is skipped too', (kimiOwn.ok ? kimiOwn.plan.mcpSkipped ?? [] : []).map((s) => s.name), ['github'])
  check('vibeConfiguredServers: the name of each [[mcp_servers]] block', vibeConfiguredServers('[[mcp_servers]]\nname = "fs"\ntransport = "stdio"\n[[mcp_servers]]\nname = \'web\'\n[tools]\nname = "not-a-server"\n'), ['fs', 'web'])
  check('jsonConfiguredServers: a Claude-shaped file’s names', jsonConfiguredServers('{"mcpServers":{"a":{},"b":{}}}'), ['a', 'b'])
  check('and junk is none', jsonConfiguredServers('{nope'), [])
  const jsonc = [
    '﻿{',
    '  // OpenCode’s own server, in an opencode.jsonc',
    '  "$schema": "https://opencode.ai/config.json", /* a block',
    '  comment */ "mcp": {',
    '    "github": { "type": "local", "command": ["x", "// not a comment", "/* nor this */"], },',
    '    "notes,}": { "type": "remote", "url": "https://n.example/mcp", },',
    '  },',
    '}'
  ].join('\n')
  check('JSONC (OpenCode, Kilo, Qwen): comments and trailing commas, never inside a string', jsonConfiguredServers(jsonc, 'mcp'), ['github', 'notes,}'])
  check('parseJsonc keeps a string that looks like a comment', (parseJsonc(jsonc) as { mcp: { github: { command: string[] } } }).mcp.github.command, ['x', '// not a comment', '/* nor this */'])
  check('and a key other than the one asked for is none', jsonConfiguredServers(jsonc, 'mcpServers'), [])
}

console.log('\nMCP: Claude Code’s own list, from a ~/.claude.json fixture')
{
  const claudeJson = JSON.parse(
    JSON.stringify({
      numStartups: 5,
      oauthAccount: { emailAddress: 'someone@example.com' },
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET } },
        docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': '${DOCS_KEY}' } },
        notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
        legacy: { type: 'sse', url: 'https://old.example.com/sse' },
        'turned-off': { command: 'uvx', args: ['off-server'] },
        'bad name': { command: 'x' },
        stoke: { command: 'x' }
      },
      projects: {
        '/work/app': {
          mcpServers: { 'local-db': { command: 'pg-mcp', args: ['--db', 'app'] }, notion: { type: 'http', url: 'https://notion.local/mcp' } },
          disabledMcpServers: ['turned-off'],
          enabledMcpjsonServers: ['repo-tool']
        },
        '/work/other': { mcpServers: { 'other-only': { command: 'x' } } }
      }
    })
  )
  const mcpJson = { mcpServers: { 'repo-tool': { command: 'repo-mcp' }, unapproved: { command: 'evil' } } }
  const app = claudeMcpServers(claudeJson, mcpJson, '/work/app', { env: { DOCS_KEY: HEADER_SECRET } })
  check('user scope, then the approved .mcp.json server, then local scope — minus disabledMcpServers', app.servers.map((s) => s.name), ['github', 'docs', 'notion', 'repo-tool', 'local-db'])
  ok('a server the folder turned off (/mcp disable) is not handed on', !app.servers.some((s) => s.name === 'turned-off'))
  ok('an unapproved .mcp.json server is never run — a cloned repo could name anything', !app.servers.some((s) => s.name === 'unapproved'))
  check('a local server replaces the user one of the same name', app.servers.find((s) => s.name === 'notion')?.url, 'https://notion.local/mcp')
  check('${DOCS_KEY} expanded from the environment', app.servers.find((s) => s.name === 'docs')?.headers, { 'X-Api-Key': HEADER_SECRET })
  check('refused, each with its reason', app.refused.map((r) => r.name), ['legacy', 'bad name', 'stoke'])
  const other = claudeMcpServers(claudeJson, null, '/work/other', { env: {} })
  check('another folder: its own local server, and turned-off is on there; docs refused without DOCS_KEY', other.servers.map((s) => s.name), ['github', 'notion', 'turned-off', 'other-only'])
  check('no ~/.claude.json at all is an empty list, not a throw', claudeMcpServers(null, null, '/x').servers, [])

  const launch = serversForLaunch({
    ticks: ['docs', 'stoke', 'github', 'mine', 'not-here'],
    browser: BROWSER,
    mirrored: app.servers,
    extra: { mine: { ...GITHUB, name: 'mine' }, github: { ...GITHUB, command: 'held-by-stoke' } }
  })
  check('one launch: browser first, then Claude’s order, then Stoke-held; a tick naming nothing here is absent', launch.map((s) => s.name), ['stoke', 'docs', 'mine', 'github'])
  check('a Stoke-held server replaces a mirrored one of the same name', launch.find((s) => s.name === 'github')?.command, 'held-by-stoke')
  check(
    'for Claude: only the browser and Stoke-held servers, never one whose name its own config uses',
    serversForLaunch({ ticks: ['stoke', 'github', 'mine'], browser: BROWSER, mirrored: app.servers, extra: { mine: { ...GITHUB, name: 'mine' }, github: GITHUB }, forClaude: { claudeOwn: ['github'] } }).map((s) => s.name),
    ['stoke', 'mine']
  )
  check('the browser unticked is not handed', serversForLaunch({ ticks: [], browser: BROWSER, mirrored: [], extra: {} }), [])
  check('the browser not up yet is simply absent', serversForLaunch({ ticks: ['stoke'], browser: null, mirrored: [], extra: {} }), [])

  const catalog = mcpCatalog(claudeJson, { codex: ['node_repl'] }, null, { DOCS_KEY: HEADER_SECRET })
  check('Settings’ list: user servers', catalog.user.map((s) => [s.name, s.transport, s.detail]), [
    ['github', 'stdio', 'npx'],
    ['docs', 'http', 'https://mcp.example.com'],
    ['notion', 'http', 'https://mcp.notion.com'],
    ['turned-off', 'stdio', 'uvx']
  ])
  check('local servers, each with its folders', catalog.local.map((s) => [s.name, s.folders]), [['local-db', ['/work/app']], ['other-only', ['/work/other']]])
  ok('no env value, argument or header ever reaches Settings', !MCP_SECRETS.some((v) => JSON.stringify(catalog).includes(v)) && !JSON.stringify(catalog).includes('@modelcontextprotocol'))

  // Project scope: each known folder's .mcp.json chain, as main read it.
  const withProjects = mcpCatalog(
    { ...claudeJson, projects: { ...claudeJson.projects, '/work/app': { ...claudeJson.projects['/work/app'], disabledMcpServers: ['turned-off', 'off-here'], disabledMcpjsonServers: ['rejected'] } } },
    {},
    null,
    { DOCS_KEY: HEADER_SECRET },
    {
      '/work/app': {
        mcpJson: { mcpServers: { 'repo-tool': { command: 'repo-mcp' }, unapproved: { command: 'evil' }, github: { command: 'dup' }, rejected: { command: 'r' }, 'off-here': { command: 'o' } } },
        approvals: { enableAll: false, enabled: ['off-here'], disabled: [] }
      },
      '/work/other': {
        mcpJson: { mcpServers: { 'repo-tool': { command: 'repo-mcp' }, keyed: { type: 'http', url: KEYED.url } } },
        approvals: { enableAll: true, enabled: [], disabled: [] }
      },
      '/work/none': { mcpJson: { mcpServers: { unapproved: { command: 'evil' } } }, approvals: NO_APPROVALS }
    }
  )
  check(
    'project servers Claude may run, each with its folders — approved by projects[key] in one, by enableAll in another',
    withProjects.project.map((s) => [s.name, s.folders]),
    [['repo-tool', ['/work/app', '/work/other']], ['keyed', ['/work/other']]]
  )
  check('never approved anywhere: listed apart, with where', withProjects.unapproved, [{ name: 'unapproved', folders: ['/work/app', '/work/none'] }])
  ok('refused at Claude’s prompt (disabledMcpjsonServers) or turned off in /mcp: not offered at all', !JSON.stringify(withProjects).includes('rejected') && !JSON.stringify(withProjects).includes('off-here'))
  ok('a name user scope already lists is not listed again', !withProjects.project.some((s) => s.name === 'github'))
  check('and a keyed URL carries only its reason to Settings', [withProjects.project[1]?.detail, typeof withProjects.project[1]?.urlProblem, JSON.stringify(withProjects).includes(URL_SECRET)], ['https://mcp.search.example', 'string', false])
}

console.log('\nMCP: what is stored — ticks and Stoke-held servers only')
{
  check('the default: no ticks stored, no servers held', DEFAULT_AGENT_MCP, { perAgent: {}, extra: {} })
  check('DEFAULT_SETTINGS names it', DEFAULT_SETTINGS.agents.mcp, { perAgent: {}, extra: {} })
  check('a settings file with no agents block hydrates it', hydrateSettings({}).agents.mcp, { perAgent: {}, extra: {} })
  check('an older agents block with no mcp key hydrates it', hydrateAgents({ chosen: ['codex'] }).mcp, { perAgent: {}, extra: {} })
  check('junk is the default', hydrateAgents({ mcp: 'junk' }).mcp, { perAgent: {}, extra: {} })
  check('every agent gets only Stoke’s browser until the user ticks another', mcpTicksFor(DEFAULT_AGENT_MCP, 'codex'), ['stoke'])
  const h = hydrateAgentMcp(
    {
      perAgent: { codex: ['github', 'bad name', 'github', 'stoke', 7], banana: ['x'], qwen: 'junk', kimi: [] },
      extra: {
        good: { transport: 'stdio', command: ' uvx ', args: ['x', 3], env: { TOKEN: '', 'bad-name': 'x', __proto__: 'y' }, url: 'ignored', headers: { A: 'b' } },
        web: { transport: 'http', url: 'https://w.example/mcp', headers: { 'X-Key': 'k', 'X.Dotted': 'never sealable' }, bearer: ' t ' },
        'bad.name': { transport: 'stdio', command: 'x' },
        stoke: { transport: 'stdio', command: 'x' },
        nocommand: { transport: 'stdio' },
        ftp: { transport: 'http', url: 'ftp://x' },
        constructor: { transport: 'stdio', command: 'x' }
      },
      junk: 1
    },
    (id: string): id is CodingCliId => CODING_CLIS.some((c) => c.id === id)
  )
  check('ticks: unknown agents, unsafe names and duplicates dropped; an explicit [] kept (not even the browser)', h.perAgent, { codex: ['github', 'stoke'], kimi: [] })
  check('Stoke-held servers rebuilt from named keys; an emptied secret kept for the vault to fill', h.extra, {
    good: { name: 'good', transport: 'stdio', command: 'uvx', args: ['x'], env: { TOKEN: '' }, url: '', headers: {} },
    web: { name: 'web', transport: 'http', command: '', args: [], env: {}, url: 'https://w.example/mcp', headers: { 'X-Key': 'k' }, bearer: 't' }
  })
  check('an unticked browser stays unticked', mcpTicksFor(withMcpTick(DEFAULT_AGENT_MCP, 'codex', 'stoke', false), 'codex'), [])
  check('ticking adds to the default rather than replacing it', mcpTicksFor(withMcpTick(DEFAULT_AGENT_MCP, 'codex', 'github', true), 'codex'), ['stoke', 'github'])
  check('and touches no other agent', withMcpTick(DEFAULT_AGENT_MCP, 'codex', 'github', true).perAgent.qwen, undefined)
  const round = hydrateSettings(JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents, mcp: h } }))).agents.mcp
  check('a hydrated block survives a second hydrate unchanged', round, h)
  check('a generated file name is the agent and a content hash', MCP_FILE_NAME.test(mcpFileName('qwen', 'x')) && mcpFileName('qwen', 'x') === mcpFileName('qwen', 'x') && mcpFileName('qwen', 'x') !== mcpFileName('qwen', 'y'), true)
}

console.log('\nMCP in main: a scratch HOME, its ~/.claude.json read, owner-only files written')
{
  // Fake every input (gotcha 74): a scratch home and userData, never the real ones.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-verify-mcp-')))
  try {
    const project = join(home, 'work', 'app')
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET } },
          docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${HTTP_BEARER}` } },
          'turned-off': { command: 'uvx', args: ['off'] }
        },
        projects: { [project]: { disabledMcpServers: ['turned-off'], mcpServers: { 'local-db': { command: 'pg-mcp' } } } }
      })
    )
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.docs]\nurl = "https://codex-own.example/mcp"\n')
    const reader = new ClaudeConfigReader({}, home)
    const ticks = { perAgent: { codex: ['stoke', 'github', 'docs', 'turned-off', 'local-db'] }, extra: {} }
    const r = await resolveLaunchMcp({ cliId: 'codex', cwd: project, mcp: ticks, browser: BROWSER, reader, env: {}, home })
    check('codex in the project: the browser, github, local-db; turned-off honoured from disabledMcpServers', r.servers.map((s) => s.name), ['stoke', 'github', 'docs', 'local-db'])
    check('and the names its own config.toml defines, to skip', r.own, ['docs'])
    const planned = plan('codex', undefined, { mcp: r.servers, mcpOwn: r.own })
    check('so docs is skipped, not merged into the user’s entry', (planned.ok ? planned.plan.mcpSkipped ?? [] : []).map((s) => s.name), ['docs'])
    keysOnlyInEnv('codex from a real read', planned)
    const def = await resolveLaunchMcp({ cliId: 'qwen', cwd: project, mcp: DEFAULT_AGENT_MCP, browser: BROWSER, reader, env: {}, home })
    check('an agent on the default ticks gets the browser alone', def.servers.map((s) => s.name), ['stoke'])
    const noneAgent = await resolveLaunchMcp({ cliId: 'claude', cwd: project, mcp: { perAgent: { claude: ['stoke', 'github'] }, extra: {} }, browser: BROWSER, reader, env: {}, home })
    check('Claude: a tick of one of its own servers hands it nothing extra — it loads its own', noneAgent.servers.map((s) => s.name), ['stoke'])

    mkdirSync(join(home, '.kimi'), { recursive: true })
    writeFileSync(join(home, '.kimi', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'kimi-own' } } }))
    check('kimi: its own mcp.json is kept beside Stoke’s, and its names skipped', await agentOwnMcp('kimi', {}, home), { own: ['github'], keep: [join(home, '.kimi', 'mcp.json')] })
    check('kimi with no mcp.json: nothing to keep', await agentOwnMcp('kimi', { KIMI_SHARE_DIR: join(home, 'nowhere') }, home), { own: [], keep: [] })
    mkdirSync(join(home, '.vibe'), { recursive: true })
    writeFileSync(join(home, '.vibe', 'config.toml'), '[[mcp_servers]]\nname = "github"\ntransport = "stdio"\ncommand = "x"\n')
    check('vibe: its own config.toml’s names', (await agentOwnMcp('vibe', {}, home)).own, ['github'])
    // Qwen's system settings live outside HOME; point them into the scratch too.
    const cat = await readMcpCatalog(reader, { QWEN_CODE_SYSTEM_SETTINGS_PATH: join(home, 'qwen-system', 'settings.json') }, home)
    check('Settings’ catalog from the same files: user servers and own names per agent', [cat.user.map((s) => s.name), cat.own], [['github', 'docs', 'turned-off'], { codex: ['docs'], kimi: ['github'], vibe: ['github'] }])
    ok('and no secret in it', !MCP_SECRETS.some((v) => JSON.stringify(cat).includes(v)))

    // The files: owner-only, and the sweep touches only its own names.
    const agentsDir = join(home, 'ud', 'agents')
    const store = new McpFileStore(agentsDir)
    mkdirSync(store.dir, { recursive: true })
    const bystander = join(store.dir, 'keep-me.txt')
    const stale = join(store.dir, 'qwen-0123456789abcdef.json')
    const legacy = join(agentsDir, 'mcp-httpurl.json')
    writeFileSync(bystander, 'mine')
    writeFileSync(stale, '{"old":"bearer"}')
    writeFileSync(legacy, '{"old":"bearer"}')
    const q = plan('qwen', undefined, { mcp: [BROWSER, ...TWO], mcpFileFor: store.fileFor })
    const files = q.ok ? q.plan.files ?? [] : []
    ok('the write succeeds', await store.write(files))
    const written = files[0]?.path ?? ''
    check('the plan names the file it wrote', planOk(q).args, ['--mcp-config', written])
    check('with exactly the plan’s content', readFileSync(written, 'utf8'), files[0]?.content)
    if (process.platform !== 'win32') {
      check('owner-only: the file is -rw-------', (statSync(written).mode & 0o777).toString(8), '600')
      check('and its folder drwx------', (statSync(store.dir).mode & 0o777).toString(8), '700')
    }
    ok('an earlier run’s generated file is swept', !existsSync(stale))
    ok('the old httpUrl file (a bearer) is swept', !existsSync(legacy))
    ok('a bystander in the same folder survives (gotcha 74)', existsSync(bystander))
    ok('writing the same set again reuses the file', (await store.write(files)) && existsSync(written))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  const headless = readFileSync(new URL('../src/main/agent.ts', import.meta.url), 'utf8')
  ok('agent.ts (headless runs) never reads the mirrored list (gotcha 15)', !/mcpLaunch|mcpServers\.ts|claudeMcpServers/.test(headless))
}

console.log('\nMCP: every agent’s own servers, its user config and the launch folder’s (ownMcpSources)')
{
  check('foldersUpTo: nearest first, to the stop inclusive', foldersUpTo('/a/b/c', '/a/b'), ['/a/b/c', '/a/b'])
  check('foldersUpTo: to the top with no stop', foldersUpTo('/a/b', null), ['/a/b', '/a', '/'])
  // Fake every input (gotcha 74): a scratch home with each agent's files, a repo and a subfolder in it.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-verify-mcpown-')))
  try {
    const repo = join(home, 'work', 'app')
    const sub = join(repo, 'pkg')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    const put = (path: string, text: string): void => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const env = { QWEN_CODE_SYSTEM_SETTINGS_PATH: join(home, 'qwen-system', 'settings.json') }
    // OpenCode: JSONC at user level, and a project file plus a .opencode dir in the repo.
    put(join(home, '.config', 'opencode', 'opencode.jsonc'), '{\n  // mine\n  "mcp": { "github": { "type": "local", "command": ["gh-mcp"] }, },\n}')
    put(join(repo, 'opencode.json'), JSON.stringify({ mcp: { 'repo-oc': { type: 'local', command: ['x'] } } }))
    put(join(sub, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { 'sub-oc': { type: 'local', command: ['x'] } } }))
    put(join(home, 'work', 'opencode.json'), JSON.stringify({ mcp: { 'above-repo': { type: 'local', command: ['x'] } } }))
    // Kilo: its own names, and the opencode.json it still reads per folder.
    put(join(home, '.config', 'kilo', 'kilo.json'), JSON.stringify({ mcp: { linear: { type: 'remote', url: 'https://l.example/mcp' } } }))
    put(join(repo, '.kilo', 'kilo.jsonc'), '{ "mcp": { "repo-kilo": { "type": "local", "command": ["x"] }, }, }')
    // Qwen: user settings, system settings, the cwd's .qwen/settings.json and .mcp.json.
    put(join(home, '.qwen', 'settings.json'), '{ /* qwen strips comments */ "mcpServers": { "docs": { "httpUrl": "https://d.example/mcp" } } }')
    put(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, JSON.stringify({ mcpServers: { 'org-tool': { command: 'x' } } }))
    put(join(sub, '.qwen', 'settings.json'), JSON.stringify({ mcpServers: { 'ws-qwen': { command: 'x' } } }))
    put(join(sub, '.mcp.json'), JSON.stringify({ mcpServers: { 'sub-mcpjson': { command: 'x' } } }))
    // Copilot: its mcp-config.json, and the workspace .github/mcp.json at the repo's top.
    put(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { playwright: { type: 'local', command: 'x' } } }))
    put(join(repo, '.github', 'mcp.json'), JSON.stringify({ mcpServers: { 'repo-copilot': { type: 'local', command: 'x' } } }))
    // Codex: a project .codex/config.toml at the repo's top.
    put(join(home, '.codex', 'config.toml'), '[mcp_servers.node_repl]\ncommand = "node"\n')
    put(join(repo, '.codex', 'config.toml'), '[mcp_servers.repo-codex]\ncommand = "x"\n')
    // Vibe: the NEAREST .vibe/config.toml only.
    put(join(home, '.vibe', 'config.toml'), '[[mcp_servers]]\nname = "fs"\n')
    put(join(repo, '.vibe', 'config.toml'), '[[mcp_servers]]\nname = "repo-vibe"\n')
    put(join(sub, '.vibe', 'config.toml'), '[[mcp_servers]]\nname = "sub-vibe"\n')

    const folder = { real: sub, gitRoot: repo }
    const own = async (id: CodingCliId, f: typeof folder | null = folder) => (await agentOwnMcp(id, env, home, f)).own.sort()
    check('opencode: user JSONC, the repo’s opencode.json, the subfolder’s .opencode — not a file above the repo', await own('opencode'), ['github', 'repo-oc', 'sub-oc'])
    check('kilo: its kilo.json and the repo’s .kilo/, plus the opencode.json it reads per folder', await own('kilo'), ['linear', 'repo-kilo', 'repo-oc'])
    check('qwen: user, system, and the cwd’s .qwen/settings.json and .mcp.json', await own('qwen'), ['docs', 'org-tool', 'sub-mcpjson', 'ws-qwen'])
    check('copilot: its mcp-config.json, the repo’s .github/mcp.json and the cwd’s .mcp.json', await own('copilot'), ['playwright', 'repo-copilot', 'sub-mcpjson'])
    check('codex: config.toml and the repo’s .codex/config.toml', await own('codex'), ['node_repl', 'repo-codex'])
    check('vibe: its config.toml and the nearest .vibe/config.toml only', await own('vibe'), ['fs', 'sub-vibe'])
    check('with no folder (Settings), only the user level', [await own('opencode', null), await own('qwen', null), await own('copilot', null)], [['github'], ['docs', 'org-tool'], ['playwright']])
    check('outside a repo OpenCode walks to the top', ownMcpSources('opencode', {}, '/h', { real: '/x/y', gitRoot: null }).filter((s) => s.path.endsWith('opencode.json') && !s.path.includes('.opencode')).map((s) => s.path).slice(-3), ['/x/y/opencode.json', '/x/opencode.json', '/opencode.json'])
    check('pi and claude read nothing here: Pi’s own mcp.json outranks, Claude loads its own', [ownMcpSources('pi', {}, '/h', folder), ownMcpSources('claude', {}, '/h', folder)], [[], []])

    // The launch: a tick of a name the folder's own config defines is skipped, never merged.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'repo-oc': { command: 'claude-side' }, github: { command: 'npx' }, other: { command: 'o' } } }))
    const ticks = { perAgent: { opencode: ['stoke', 'repo-oc', 'github', 'other'] }, extra: {} }
    const r = await resolveLaunchMcp({ cliId: 'opencode', cwd: sub, mcp: ticks, browser: BROWSER, reader: new ClaudeConfigReader({}, home), env, home })
    check('opencode in the subfolder: its own names come back with the launch', r.own.sort(), ['github', 'repo-oc', 'sub-oc'])
    const planned = plan('opencode', undefined, { mcp: r.servers, mcpOwn: r.own })
    check('so only the browser and `other` reach OPENCODE_CONFIG_CONTENT', Object.keys(JSON.parse(planOk(planned).env.OPENCODE_CONFIG_CONTENT ?? '{}').mcp ?? {}), ['stoke', 'other'])
    check('and the two it defines itself are said', (planned.ok ? planned.plan.mcpSkipped ?? [] : []).map((s) => s.name), ['repo-oc', 'github'])
    const cat = await readMcpCatalog(new ClaudeConfigReader({}, home), env, home)
    check('Settings greys each agent’s user-level names', cat.own, {
      codex: ['node_repl'],
      opencode: ['github'],
      kilo: ['linear'],
      qwen: ['docs', 'org-tool'],
      copilot: ['playwright'],
      vibe: ['fs']
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('\nMCP: where Claude Code files a folder — its canonical git root, and the .mcp.json chain (gotcha 129)')
{
  check(
    'the .mcp.json chain merges outermost first, the nearest file winning',
    mergeMcpJsons([
      { mcpServers: { a: { command: 'outer' }, b: { command: 'outer' } } },
      null,
      'junk',
      { mcpServers: { b: { command: 'inner' }, c: { command: 'inner' } } }
    ]),
    { mcpServers: { a: { command: 'outer' }, b: { command: 'inner' }, c: { command: 'inner' } } }
  )
  check('the chain is every folder from the top down, the top itself excluded', foldersDownTo('/a/b/c'), ['/a', '/a/b', '/a/b/c'])
  const trustJson = { projects: { '/r': { hasTrustDialogAccepted: true }, '/u': { hasTrustDialogAccepted: false } } }
  ok('a trusted folder, or one under a trusted folder, is trusted', isTrustedFolder(trustJson, ['/r/sub', '/r']))
  ok('an untrusted or unknown one is not', !isTrustedFolder(trustJson, ['/u', '/x']) && !isTrustedFolder(null, ['/r']))
  check(
    'inside a repo the trust walk stops at the repo’s own top (the CLI’s GS/WS)',
    trustKeys('/h/repo', '/h/repo/src/deep', '/h/repo', 'darwin'),
    ['/h/repo', '/h/repo', '/h/repo/src', '/h/repo/src/deep']
  )
  check('outside one it goes to the top', trustKeys('/h/loose', '/h/loose', null, 'darwin'), ['/h/loose', '/h', '/h/loose'])

  // Fake every input (gotcha 74): a scratch home holding a repo, a subfolder and a linked worktree.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-verify-mcpkey-')))
  try {
    const repo = join(home, 'work', 'app')
    const sub = join(repo, 'src', 'deep')
    const wt = join(repo, '.claude', 'worktrees', 'wt1')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(repo, '.git', 'worktrees', 'wt1'), { recursive: true })
    mkdirSync(wt, { recursive: true })
    // A linked worktree as `git worktree add` leaves it: .git a FILE, and git's back-pointers agree.
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt1')}\n`)
    writeFileSync(join(repo, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n')
    writeFileSync(join(repo, '.git', 'worktrees', 'wt1', 'gitdir'), `${join(wt, '.git')}\n`)
    const plain = join(home, 'plain', 'folder')
    mkdirSync(plain, { recursive: true })

    check('a repo’s top is its own key', (await claudeProjectKey(repo)).key, repo)
    check('a subfolder is filed under the repo’s top, not its own path', (await claudeProjectKey(sub)).key, repo)
    check('a linked worktree is filed under the MAIN worktree’s top', (await claudeProjectKey(wt)).key, repo)
    check('a folder in no repo is its own key', (await claudeProjectKey(plain)).key, plain)
    ok('a Windows key is written with forward slashes, as the CLI writes it', !(await claudeProjectKey(plain, 'win32')).key.includes('\\'))

    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['gh'] }, 'turned-off': { command: 'uvx' } },
        projects: { [repo]: { disabledMcpServers: ['turned-off'], mcpServers: { 'local-db': { command: 'pg-mcp' } } } }
      })
    )
    // `.mcp.json` above the repo and at its top: both read, the nearer one winning.
    writeFileSync(
      join(home, 'work', '.mcp.json'),
      JSON.stringify({ mcpServers: { 'outer-tool': { command: 'outer' }, shared: { command: 'from-outer' } } })
    )
    writeFileSync(
      join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'repo-tool': { command: 'repo-mcp' }, shared: { command: 'from-repo' } } })
    )
    // The repo approves its own .mcp.json servers, in a file it could commit.
    mkdirSync(join(sub, '.claude'), { recursive: true })
    writeFileSync(join(sub, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))

    const ticks = {
      perAgent: { codex: ['stoke', 'github', 'turned-off', 'local-db', 'repo-tool', 'outer-tool', 'shared', 'loose-tool'] },
      extra: {}
    }
    const at = async (cwd: string) =>
      (
        await resolveLaunchMcp({ cliId: 'codex', cwd, mcp: ticks, browser: BROWSER, reader: new ClaudeConfigReader({}, home), env: {}, home })
      ).servers.map((s) => [s.name, s.command])
    check(
      'a tab in a subfolder: the repo’s local server, turned-off stays off, and the repo’s own approval of its .mcp.json does not count while untrusted',
      await at(sub),
      [['stoke', ''], ['github', 'npx'], ['local-db', 'pg-mcp']]
    )
    check('a tab in a worktree: the same, from the main worktree’s entry', await at(wt), [['stoke', ''], ['github', 'npx'], ['local-db', 'pg-mcp']])

    // Trusted in Claude Code, the folder's committed approval counts, as the CLI's does.
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    cfg.projects[repo].hasTrustDialogAccepted = true
    writeFileSync(join(home, '.claude.json'), JSON.stringify(cfg))
    check(
      'trusted: every approved .mcp.json server along the chain, the nearer file’s entry winning',
      await at(sub),
      [['stoke', ''], ['github', 'npx'], ['outer-tool', 'outer'], ['shared', 'from-repo'], ['repo-tool', 'repo-mcp'], ['local-db', 'pg-mcp']]
    )
    // A trusted HOME trusts a loose folder under it, and never a repo cloned there.
    delete cfg.projects[repo].hasTrustDialogAccepted
    cfg.projects[home] = { hasTrustDialogAccepted: true }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(cfg))
    check(
      'a trusted home does not trust a repo under it: the repo’s own approval still does not count',
      await at(sub),
      [['stoke', ''], ['github', 'npx'], ['local-db', 'pg-mcp']]
    )
    writeFileSync(join(plain, '.mcp.json'), JSON.stringify({ mcpServers: { 'loose-tool': { command: 'loose' } } }))
    mkdirSync(join(plain, '.claude'), { recursive: true })
    writeFileSync(join(plain, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    check(
      'but it does trust a folder in no repo under it (where turned-off is on: no entry turns it off there)',
      await at(plain),
      [['stoke', ''], ['github', 'npx'], ['turned-off', 'uvx'], ['loose-tool', 'loose']]
    )
    // Untrusted, the user's own settings still approve by name.
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['repo-tool'] }))
    check(
      'untrusted, the user’s own settings still approve by name',
      await at(sub),
      [['stoke', ''], ['github', 'npx'], ['repo-tool', 'repo-mcp'], ['local-db', 'pg-mcp']]
    )

    // Settings' list reads the same chain for every folder ~/.claude.json knows, under the same gate.
    const catEnv = { QWEN_CODE_SYSTEM_SETTINGS_PATH: join(home, 'qwen-system', 'settings.json') }
    const catalogNow = () => readMcpCatalog(new ClaudeConfigReader({}, home), catEnv, home)
    const untrusted = await catalogNow()
    check('Settings lists a known folder’s approved .mcp.json server, with its folder', untrusted.project.map((s) => [s.name, s.folders]), [['repo-tool', [repo]]])
    check('and the ones Claude may not run there yet, apart', untrusted.unapproved, [
      { name: 'outer-tool', folders: [repo] },
      { name: 'shared', folders: [repo] }
    ])
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    check('the repo’s own approval does not count while it is untrusted', (await catalogNow()).project.map((s) => s.name), ['repo-tool'])
    cfg.projects[repo].hasTrustDialogAccepted = true
    writeFileSync(join(home, '.claude.json'), JSON.stringify(cfg))
    const trusted = await catalogNow()
    check('once trusted, every server of its chain', [trusted.project.map((s) => [s.name, s.folders]), trusted.unapproved], [
      [['outer-tool', [repo]], ['shared', [repo]], ['repo-tool', [repo]]],
      []
    ])
    check('and the catalog read no error', trusted.error, null)
    // A folder whose entry carries none of the MCP keys is still a known folder.
    const bare = join(home, 'bare')
    mkdirSync(bare, { recursive: true })
    writeFileSync(join(bare, '.mcp.json'), JSON.stringify({ mcpServers: { 'bare-tool': { command: 'bare' } } }))
    cfg.projects[bare] = { lastSessionId: 'x' }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(cfg))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['repo-tool', 'bare-tool'] }))
    check('a folder whose ~/.claude.json entry has no MCP key is still scanned', (await catalogNow()).project.find((s) => s.name === 'bare-tool')?.folders, [bare])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/*
 * A second Claude account (its own CLAUDE_CONFIG_DIR, so its own
 * ~/.claude.json) saw none of the Default account's user-scope MCP servers.
 * It is handed them as one generated owner-only --mcp-config file: never a
 * name it defines itself, an http server as its URL (and configured headers)
 * only, and never an OAuth token or `oauth` block (gotcha 36).
 */
console.log('\nMCP: a second Claude account gets the Default account’s user-scope servers (accountMcpMirror)')
{
  const OAUTH_SECRETS = ['OAUTH-CLIENT-SECRET-7', 'OAUTH-ACCESS-TOKEN-8', 'OAUTH-REFRESH-TOKEN-9', 'oauth-client-id-10']
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-verify-account-mcp-')))
  try {
    const project = join(home, 'work', 'app')
    mkdirSync(project, { recursive: true })
    const defaultJson = {
      // Where a token would be if someone pasted one here; Claude keeps them in its credentials.
      mcpOAuth: { 'notion|abc': { accessToken: OAUTH_SECRETS[1], refreshToken: OAUTH_SECRETS[2] } },
      mcpServers: {
        notion: { type: 'http', url: 'https://mcp.notion.com/mcp', oauth: { clientId: OAUTH_SECRETS[3], clientSecret: OAUTH_SECRETS[0] } },
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: STDIO_SECRET } },
        docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${HTTP_BEARER}` } },
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
        old: { type: 'sse', url: 'https://old.example/sse' },
        'off-here': { command: 'uvx', args: ['off'] },
        'repo-tool': { command: 'default-repo-tool' }
      },
      projects: { [project]: { disabledMcpServers: ['off-here'] } }
    }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(defaultJson))
    // The CLI's own credentials, holding the real OAuth tokens: never read by any of this.
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ mcpOAuth: { 'notion|abc': { accessToken: OAUTH_SECRETS[1] } } }))
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'repo-tool': { command: 'repo-own' } } }))
    const accountHome = join(home, 'accounts', 'claude-work')
    mkdirSync(accountHome, { recursive: true })
    const accountJsonPath = join(accountHome, '.claude.json')
    writeFileSync(
      accountJsonPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'work@example.com' },
        mcpServers: { linear: { type: 'http', url: 'https://account-own.example/mcp' } },
        projects: { [project]: { mcpServers: { 'acct-local': { command: 'acct' } } } }
      })
    )
    const defaultReader = new ClaudeConfigReader({}, home)
    const accountReader = new ClaudeConfigReader({ CLAUDE_CONFIG_DIR: accountHome }, home)

    const launch = await resolveAccountMirror({ cwd: project, defaultReader, accountReader, env: {} })
    check('read without error', launch.error, null)
    check(
      "in the project: notion, github and docs are handed on; linear is the account's own; repo-tool is the folder's; off-here Default turned off here",
      [launch.mirror.servers.map((s) => s.name), launch.mirror.own],
      [['notion', 'github', 'docs'], ['linear', 'repo-tool']]
    )
    check('the SSE server is not passed, and says why', launch.mirror.refused.map((r) => r.name), ['old'])
    ok("every name the account knows here is listed, so a Stoke-held one can't shadow it either", ['linear', 'acct-local', 'repo-tool'].every((n) => launch.mirror.accountNames.includes(n)))

    // A Stoke-held `linear` ticked for Claude: the account's own linear wins; the browser stays.
    const heldLinear: McpServerSpec = { ...DOCS, name: 'linear', url: 'https://stoke-held.example/mcp', headers: {} }
    const servers = claudeAccountServers([BROWSER, heldLinear], launch.mirror)
    check('the launch list: the browser, then Default’s servers; the Stoke-held twin of its own linear dropped', servers.map((s) => s.name), ['stoke', 'notion', 'github', 'docs'])
    check('a name already on the list is not added twice', claudeAccountServers([BROWSER, ...launch.mirror.servers], launch.mirror).length, 4)

    const store = new McpFileStore(join(home, 'ud', 'agents'))
    const out = claudeMcpConfigs(servers, '/u/Stoke/mcp-browser.json', store.fileFor)
    ok('one generated file beside the browser file', out.configs.length === 2 && out.files.length === 1 && out.configs[0] === '/u/Stoke/mcp-browser.json')
    ok('the file is written', await store.write(out.files))
    const written = out.files[0].path
    const text = readFileSync(written, 'utf8')
    const parsed = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> }
    check('it holds exactly Default’s servers (the browser has its own file)', Object.keys(parsed.mcpServers), ['notion', 'github', 'docs'])
    check('an OAuth http server goes as its URL alone', parsed.mcpServers.notion, { type: 'http', url: 'https://mcp.notion.com/mcp', headers: {} })
    ok('no OAuth token, client secret or oauth block is ever written', !OAUTH_SECRETS.some((v) => text.includes(v)) && !text.includes('oauth') && !text.includes('mcpOAuth'))
    check('a header the user configured goes with its server', parsed.mcpServers.docs.headers, { Authorization: `Bearer ${HTTP_BEARER}` })
    if (process.platform !== 'win32') {
      check('owner-only: the file is -rw-------', (statSync(written).mode & 0o777).toString(8), '600')
    }
    ok('neither ~/.claude.json was written', readFileSync(join(home, '.claude.json'), 'utf8') === JSON.stringify(defaultJson) && readFileSync(accountJsonPath, 'utf8').includes('account-own.example'))

    const row = await resolveAccountMirror({ cwd: null, defaultReader, accountReader, env: {} })
    const summary = accountMcpSummary(row.mirror, row.error)
    check(
      'the account row (user scope, no folder): what it gets, what it keeps, what cannot go',
      [summary.passed, summary.own, summary.refused.map((r) => r.name)],
      [['notion', 'github', 'docs', 'off-here', 'repo-tool'], ['linear'], ['old']]
    )
    check('and says so in words', accountMcpLines(summary).slice(0, 2), [
      'Also gets your Default account’s MCP servers: notion, github, docs, off-here and 1 more',
      'Keeps its own linear, which Default has too'
    ])
    ok('no value in the summary', !MCP_SECRETS.some((v) => JSON.stringify(summary).includes(v)) && !OAUTH_SECRETS.some((v) => JSON.stringify(summary).includes(v)))

    // Never signed in: no ~/.claude.json of its own yet. It defines nothing, so it gets everything.
    const fresh = new ClaudeConfigReader({ CLAUDE_CONFIG_DIR: join(home, 'accounts', 'claude-new') }, home)
    const freshRead = await resolveAccountMirror({ cwd: null, defaultReader, accountReader: fresh, env: {} })
    check('an account with no ~/.claude.json yet gets every passable one', [freshRead.error, freshRead.mirror.servers.map((s) => s.name)], [null, ['notion', 'github', 'docs', 'linear', 'off-here', 'repo-tool']])
    // Unreadable: nothing is handed on rather than risk shadowing its own.
    writeFileSync(accountJsonPath, '{"mcpServers": {"linear": ')
    const broken = await resolveAccountMirror({ cwd: project, defaultReader, accountReader: new ClaudeConfigReader({ CLAUDE_CONFIG_DIR: accountHome }, home), env: {} })
    check('an account file that will not parse hands on nothing, and says so', [broken.mirror.servers.length, typeof broken.error], [0, 'string'])
    check('pure: no Default file at all is nothing to hand on', accountMcpMirror({ defaultJson: null, accountJson: null }).servers, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  ok(
    'the launch hands the mirror only to a login account, through claudeAccountServers, before claudeMcpConfigs',
    /account\?\.kind === 'login'[\s\S]{0,400}claudeAccountServers\(servers, mirror\)[\s\S]{0,120}claudeMcpConfigs\(servers,/.test(main)
  )
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
