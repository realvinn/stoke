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
  httpUrlMcpConfig,
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
  CLAUDE_PLUGIN_SKILLS,
  CLAUDE_SHARED_PLUGIN,
  claudeProjection,
  pluginSkillName,
  SHARED_SKILLS_DIR,
  SKILL_DIRS,
  skillReport
} from '../src/shared/skills.ts'
import {
  AGENT_CLEAR_DISTANCE,
  AGENT_DISTINCT_DISTANCE,
  AGENT_SEEDS,
  agentColorTokens,
  agentSeed,
  agentTokenNames,
  COMMON_AGENTS,
  hydrateAgentColors,
  paintAgentColors
} from '../src/shared/agentColors.ts'
import { parseColor, perceptualDistance } from '../src/shared/color.ts'
import { meterScale } from '../src/shared/meter.ts'
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
    mcp: null,
    piExtensionPath: '/Users/u/Library/Application Support/Stoke/agents/pi-provider.ts',
    ...over
  })
const planOk = (r: ReturnType<typeof plan>) => (r.ok ? r.plan : { args: ['<refused>'], env: {} as Record<string, string> })

/** No secret may appear in argv: `ps` shows every argument of every process. */
function keysOnlyInEnv(name: string, r: ReturnType<typeof plan>): void {
  const p = planOk(r)
  const argv = p.args.join('\u0000')
  ok(`${name}: no key in argv`, ![KEY, CUSTOM_KEY, MCP.token].some((k) => argv.includes(k)), JSON.stringify(p.args))
}

console.log('\nwhat is stored')
check('nothing stored is never asked', hydrateAgents(undefined), {
  chosen: null,
  endpoints: {},
  defaultCli: 'claude',
  shareSkillsToClaude: true,
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
   * Against what each theme actually paints: the meter's three tiers (solved per
   * theme by meterScale, exactly as applyAppearance writes them), --danger and
   * --warning. An agent's ink this close to one would read as context
   * pressure, an error, or "waiting for you".
   */
  for (const c of CODING_CLIS) {
    for (const part of ['ink', 'text'] as const) {
      let worst = Infinity
      let where = ''
      for (const t of BUILT_IN_THEMES) {
        const ink = agentColorTokens({}, t.appearance, t.colors).find((x) => x.key === c.id)![part]
        const m = meterScale(t.colors.bg, t.colors.bgSunken, t.appearance)
        for (const [name, colour] of [
          ['meter-low', m.low],
          ['meter-mid', m.mid],
          ['meter-high', m.high],
          ['danger', t.colors.danger],
          ['warning', t.colors.warning]
        ] as const) {
          const d = dist(ink, colour)
          if (d < worst) [worst, where] = [d, `${t.id} ${name}`]
        }
      }
      ok(
        `${c.id}: its ${part} stays clear of the meter, danger and warning (nearest ${where} ${worst.toFixed(3)})`,
        worst >= AGENT_CLEAR_DISTANCE,
        `under ${AGENT_CLEAR_DISTANCE}`
      )
    }
  }
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
  const m = plan('codex', undefined, { mcp: MCP })
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
  const c = planOk(plan('opencode', custom(), { mcp: MCP }))
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
  const files = { claude: '/u/Stoke/mcp-browser.json', httpUrl: '/u/Stoke/agents/mcp-httpurl.json' }
  check(
    'copilot: Stoke’s own MCP file, by path, so the token is not in argv',
    planOk(plan('copilot', undefined, { mcpFiles: files })).args,
    ['--additional-mcp-config', '@/u/Stoke/mcp-browser.json']
  )
  check(
    'qwen: the httpUrl-shaped file — a plain url is SSE there and never connects',
    planOk(plan('qwen', undefined, { mcpFiles: files })).args,
    ['--mcp-config', '/u/Stoke/agents/mcp-httpurl.json']
  )
  check(
    'the httpUrl file carries the bearer as a header',
    JSON.parse(httpUrlMcpConfig(MCP)).mcpServers.stoke,
    { httpUrl: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } }
  )
  ok('gemini refuses OpenRouter rather than silently using its own sign-in', !plan('gemini', or()).ok)
  ok('and so do cursor and amp', !plan('cursor', or()).ok && !plan('amp', custom()).ok)
}

console.log('\nkilo reads OpenCode’s inline config under its own name; aider takes LiteLLM prefixes')
{
  const k = planOk(plan('kilo', custom(), { mcp: MCP }))
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
    planOk(plan('codex', own('gpt-6.1-sol'), { mcp: MCP, continueLast: true })).args,
    [
      '-m', 'gpt-6.1-sol',
      '-c', `mcp_servers.stoke.url="${MCP.url}"`,
      '-c', `mcp_servers.stoke.bearer_token_env_var="${ENV_MCP_TOKEN}"`,
      'resume', '--last'
    ]
  )
  keysOnlyInEnv('codex default model with MCP', plan('codex', own('gpt-6.1-sol'), { mcp: MCP }))
  check(
    'qwen: the model beside its MCP file, the token still only in that file',
    planOk(plan('qwen', own('qwen3-coder-plus'), { mcpFiles: { claude: null, httpUrl: '/u/Stoke/agents/mcp-httpurl.json' } })).args,
    ['-m', 'qwen3-coder-plus', '--mcp-config', '/u/Stoke/agents/mcp-httpurl.json']
  )
  check(
    'opencode: a default model beside its inline MCP config, whose token stays in env',
    Object.keys(planOk(plan('opencode', own('anthropic/claude-sonnet-5'), { mcp: MCP })).env),
    ['OPENCODE_CONFIG_CONTENT']
  )
  keysOnlyInEnv('opencode default model with MCP', plan('opencode', own('anthropic/claude-sonnet-5'), { mcp: MCP }))
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
  check('this build writes format 2', AGENTS_FORMAT, 2)

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
  check('and the block now says format 2, so the upgrade runs once', up.format, AGENTS_FORMAT)
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
    [hydrateAgents({ ...before, format: 3 }).endpoints, hydrateAgents({ ...before, format: 3 }).format],
    [{ codex: leftover }, AGENTS_FORMAT]
  )
  check('a junk format is 1, and upgraded', hydrateAgents({ ...before, format: '2' }).endpoints, {})
  check('no agents block at all is this build’s format', [hydrateAgents(undefined).format, hydrateAgents('junk').format], [2, 2])
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

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
