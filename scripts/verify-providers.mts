/*
 * Provider env mapping is the contract between Settings and a spawned Claude
 * session. It used to be "whatever the shell exported"; a GUI launch sees none
 * of that, so the mapping has to be assertable without a window.
 *
 *   node scripts/verify-providers.mts
 */
import {
  DEFAULT_PROVIDERS,
  OPENROUTER_BASE_URL,
  applyProviderEnv,
  hydrateProviders,
  keyFormatHint,
  validateClaudeAuth,
  providersSummary,
  type ProviderSettings
} from '../src/shared/providers.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'

let failures = 0
function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`
  )
}

function check(name: string, got: unknown, want: unknown): void {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (!same) failures++
  console.log(
    `  ${same ? 'PASS' : 'FAIL'}  ${name}` +
      (same ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

console.log('\nhydrate')
check('junk becomes defaults', hydrateProviders(7), { ...DEFAULT_PROVIDERS })
check(
  'unknown mode falls back to default',
  hydrateProviders({ claudeAuth: 'banana' }).claudeAuth,
  'default'
)
check(
  'trailing slash stripped from custom URL',
  hydrateProviders({ customBaseUrl: 'http://127.0.0.1:8080/' }).customBaseUrl,
  'http://127.0.0.1:8080'
)
ok('keys are trimmed', hydrateProviders({ anthropicApiKey: '  sk-x  ' }).anthropicApiKey === 'sk-x')

console.log('\nvalidate')
ok('default always ok', validateClaudeAuth(DEFAULT_PROVIDERS).ok)
ok(
  'anthropic without key fails',
  !validateClaudeAuth({ ...DEFAULT_PROVIDERS, claudeAuth: 'anthropic' }).ok
)
ok(
  'anthropic with key ok',
  validateClaudeAuth({
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'anthropic',
    anthropicApiKey: 'sk-ant-x'
  }).ok
)
ok(
  'openrouter without key fails',
  !validateClaudeAuth({ ...DEFAULT_PROVIDERS, claudeAuth: 'openrouter' }).ok
)
ok(
  'custom needs http URL',
  !validateClaudeAuth({
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'custom',
    customBaseUrl: 'not-a-url',
    customAuthToken: 'x'
  }).ok
)
ok(
  'custom with http + token ok',
  validateClaudeAuth({
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'custom',
    customBaseUrl: 'http://127.0.0.1:9',
    customAuthToken: 'x'
  }).ok
)

console.log('\napply — openrouter')
{
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: 'sk-ant-stale',
    PATH: '/usr/bin'
  }
  const p: ProviderSettings = {
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'openrouter',
    openrouterApiKey: 'sk-or-v1-test',
    openrouterModelDiscovery: true,
    openaiApiKey: 'sk-openai',
    xaiApiKey: 'xai-test'
  }
  applyProviderEnv(env, p)
  check('base URL', env.ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL)
  check('auth token', env.ANTHROPIC_AUTH_TOKEN, 'sk-or-v1-test')
  ok('API key explicitly empty (not deleted)', env.ANTHROPIC_API_KEY === '')
  check('gateway discovery', env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1')
  check('openai key injected', env.OPENAI_API_KEY, 'sk-openai')
  check('xai key injected', env.XAI_API_KEY, 'xai-test')
  ok('PATH preserved', env.PATH === '/usr/bin')
}

console.log('\napply — anthropic clears gateway leftovers')
{
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    ANTHROPIC_AUTH_TOKEN: 'sk-or-stale',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1'
  }
  applyProviderEnv(env, {
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'anthropic',
    anthropicApiKey: 'sk-ant-new'
  })
  check('api key', env.ANTHROPIC_API_KEY, 'sk-ant-new')
  ok('base URL cleared', env.ANTHROPIC_BASE_URL === undefined)
  ok('auth token cleared', env.ANTHROPIC_AUTH_TOKEN === undefined)
  ok('discovery cleared', env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === undefined)
}

console.log('\napply — default leaves anthropic alone, still injects openai/xai')
{
  const env: Record<string, string> = { ANTHROPIC_API_KEY: 'from-shell' }
  applyProviderEnv(env, {
    ...DEFAULT_PROVIDERS,
    openaiApiKey: 'sk-o',
    xaiApiKey: 'xai'
  })
  check('anthropic untouched', env.ANTHROPIC_API_KEY, 'from-shell')
  check('openai set', env.OPENAI_API_KEY, 'sk-o')
  check('xai set', env.XAI_API_KEY, 'xai')
}

console.log('\nhints')
ok(
  'openrouter key in anthropic box warns',
  !!keyFormatHint('anthropic', 'sk-or-v1-abc')
)
ok(
  'openai-looking key in openrouter box warns',
  !!keyFormatHint('openrouter', 'sk-proj-abc')
)
ok('empty key has no hint', keyFormatHint('openai', '') === null)

console.log('\napply - custom gateway')
{
  const env = {
    ANTHROPIC_API_KEY: 'stale-console-key',
    ANTHROPIC_BASE_URL: 'https://leftover.example'
  }
  applyProviderEnv(env, {
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'custom',
    customBaseUrl: 'http://127.0.0.1:8787',
    customAuthToken: 'bridge-token'
  })
  check('base url is the gateway', env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787')
  check('token goes in as the auth token', env.ANTHROPIC_AUTH_TOKEN, 'bridge-token')
  /*
   * Blanked, NOT deleted, and this is the assertion the branch exists for. The
   * spawned process inherits the parent env, so deleting the var would leave a
   * shell-exported ANTHROPIC_API_KEY standing and Claude Code would prefer the
   * console key over the gateway the user just chose - billing the wrong
   * account, silently, with the UI still showing the gateway as selected.
   */
  check('a stale console key is blanked, not deleted', env.ANTHROPIC_API_KEY, '')
  ok('the key is still PRESENT as a var', 'ANTHROPIC_API_KEY' in env)
}

console.log('\nsummary never carries a secret')
{
  const secrets = {
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'openrouter' as const,
    anthropicApiKey: 'sk-ant-SECRETA',
    openrouterApiKey: 'sk-or-v1-SECRETB',
    openaiApiKey: 'sk-proj-SECRETC',
    xaiApiKey: 'xai-SECRETD',
    customAuthToken: 'bearer-SECRETE'
  }
  // providersSummary is drawn in the settings pane: its whole job is to say
  // which keys are saved without ever quoting one.
  const text = providersSummary(secrets)
  for (const secret of ['SECRETA', 'SECRETB', 'SECRETC', 'SECRETD', 'SECRETE']) {
    ok('summary omits ' + secret, !text.includes(secret), text)
  }
  ok('but it does name which keys are saved', text.includes('OpenRouter'), text)
  ok(
    'no keys reads as exactly that',
    providersSummary(DEFAULT_PROVIDERS).endsWith('No keys saved yet.')
  )
}

console.log('\na saved block survives a settings round trip')
{
  /*
   * hydrateSettings rebuilds from named keys rather than spreading its input,
   * so a field added to the Settings type and missed there is dropped on the
   * next read with no error anywhere - the trap that silently reset the theme
   * editor's saved seed. Assert the whole block, not merely that it exists.
   * Counterfactual measured: replacing the hydrate call with the default makes
   * this section fail and the suite exit 1.
   */
  const saved: ProviderSettings = {
    ...DEFAULT_PROVIDERS,
    claudeAuth: 'custom',
    customBaseUrl: 'http://127.0.0.1:8787',
    customAuthToken: 'bridge-token',
    anthropicApiKey: 'sk-ant-kept',
    openrouterApiKey: 'sk-or-v1-kept',
    openaiApiKey: 'sk-proj-kept',
    xaiApiKey: 'xai-kept'
  }
  check('every provider field round-trips', hydrateSettings({ providers: saved }).providers, saved)

  const older = hydrateSettings({})
  check('a settings file predating the panel hydrates to defaults', older.providers, {
    ...DEFAULT_PROVIDERS
  })
  ok(
    'and that default is inert - no ANTHROPIC_* var is touched',
    (() => {
      const env: Record<string, string> = { ANTHROPIC_API_KEY: 'from-shell' }
      applyProviderEnv(env, older.providers)
      return env.ANTHROPIC_API_KEY === 'from-shell' && !('ANTHROPIC_BASE_URL' in env)
    })()
  )
}

if (failures) {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall good')
