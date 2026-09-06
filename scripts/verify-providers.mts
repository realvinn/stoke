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
  type ProviderSettings
} from '../src/shared/providers.ts'

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

if (failures) {
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall good')
