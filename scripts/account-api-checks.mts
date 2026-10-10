/** Named API routes, sealed persistence and production launch preparation. No vendor calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountEnv, accountProblem, accountsFromRenderer, hydrateAccounts, resolveLaunchAccount, type AgentAccount } from '../src/shared/accounts.ts'
import { accountApiProfileProblem, accountProvidersFor, defaultAccountApiProfile, hydrateAccountApiProfile } from '../src/shared/accountProviders.ts'
import { agentLaunchPlan } from '../src/shared/agents.ts'
import { usageRouteFor } from '../src/shared/usageSources.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { planAccountIdentity } from '../src/main/accountIdentity.ts'
import { LaunchPreflight } from '../src/main/launchPreflight.ts'
import { SecretStore } from '../src/main/secrets.ts'
import { agentChoicesFor, phoneChoicesForAccount, phoneLaunchVerdict } from '../src/shared/remotePhone.ts'
import { phoneChoicesFor, initialPicks, startFields } from '../src/shared/phoneUi.ts'

export async function runAccountApiChecks(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'stoke-account-api-'))
  const pass = (name: string) => console.log(`  PASS ${name}`)
  const keyA = ['owned', 'alpha', 'credential'].join('-')
  const keyB = ['owned', 'beta', 'credential'].join('-')
  const claude: AgentAccount = { id: 'claude-api', cli: 'claude', label: 'Personal API', kind: 'key', home: '', apiKey: keyA, apiProfile: { ...defaultAccountApiProfile('claude')!, model: 'claude-sonnet-test' } }
  const codex: AgentAccount = { id: 'codex-nano', cli: 'codex', label: 'Nano work', kind: 'key', home: '', apiKey: keyB, apiProfile: { ...defaultAccountApiProfile('codex', 'nanogpt')!, model: 'openai/test-model' } }
  try {
    assert.equal(hydrateAccountApiProfile('claude', { provider: 'openai' }), null)
    assert.equal(hydrateAccountApiProfile('codex', { provider: 'anthropic' }), null)
    assert.deepEqual(accountProvidersFor('grok'), [])
    assert.equal(accountApiProfileProblem('codex', { provider: 'custom', baseUrl: 'https://user:secret@example.test/v1', model: 'model' }), 'Enter an HTTP(S) API base URL without a key, query or fragment.')
    for (const baseUrl of ['file:///tmp/key', 'https://example.test/v1?key=bad', 'https://example.test/#key', 'https://example.test/' + 'a'.repeat(2048)]) assert(accountApiProfileProblem('codex', { provider: 'custom', baseUrl, model: 'model' }))
    assert(accountApiProfileProblem('codex', { ...codex.apiProfile, model: 'bad & command' }))
    assert(accountApiProfileProblem('codex', { ...codex.apiProfile, model: '' }))
    assert.equal(accountApiProfileProblem('codex', defaultAccountApiProfile('codex')), null)
    assert.equal(hydrateAccountApiProfile('codex', { ...codex.apiProfile, baseUrl: 'https://wrong.test' })?.baseUrl, 'https://nano-gpt.com/api/v1')
    pass('provider identity, URL credentials, shell arguments and required gateway models are validated')

    const accounts = hydrateAccounts({ [claude.id]: claude, [codex.id]: codex })
    assert.deepEqual(accounts, { [claude.id]: claude, [codex.id]: codex })
    const secondClaude = { ...claude, id: 'claude-second', label: 'Client API', apiKey: keyB }
    const secondCodex = { ...codex, id: 'codex-second', label: 'OpenAI work', apiKey: keyA, apiProfile: defaultAccountApiProfile('codex')! }
    const multiple = hydrateAccounts({ ...accounts, [secondClaude.id]: secondClaude, [secondCodex.id]: secondCodex })
    assert.equal(Object.values(multiple).filter(a => a.cli === 'claude').length, 2)
    assert.equal(Object.values(multiple).filter(a => a.cli === 'codex').length, 2)
    assert.equal(accountEnv(multiple[secondClaude.id]).ANTHROPIC_API_KEY, keyB)
    assert.equal(accountEnv(multiple[secondCodex.id]).STOKE_ACCOUNT_API_KEY, keyA)
    assert.equal(accountEnv(multiple[claude.id]).ANTHROPIC_API_KEY, keyA)
    assert.equal(accountEnv(multiple[codex.id]).STOKE_ACCOUNT_API_KEY, keyB)
    const changed = accountsFromRenderer(accounts, { [codex.id]: { apiProfile: { provider: 'custom', baseUrl: 'http://127.0.0.1:9876/v1', model: 'custom/model' }, home: '/forged', kind: 'login' } })
    assert.equal(changed[codex.id].home, '')
    assert.equal(changed[codex.id].kind, 'key')
    assert.equal(changed[codex.id].apiProfile?.provider, 'custom')
    assert.deepEqual(accountsFromRenderer(accounts, { [codex.id]: { apiProfile: { provider: 'anthropic' } } })[codex.id], codex)
    assert.equal(hydrateAccounts({ 'codex-missing': { ...codex, apiProfile: undefined } })['codex-missing'], undefined)
    assert.equal(accountProblem(codex, 'openrouter'), null)
    assert(accountProblem({ ...codex, apiKey: '' }))
    assert.deepEqual(resolveLaunchAccount({ cli: 'codex', requested: codex.id, accounts, defaults: {} }), { ok: true, accountId: codex.id, account: codex })
    pass('named API routes survive hydration and account selection without allowing a renderer to change ownership')

    const inherited = { ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_AUTH_TOKEN: 'old-gateway', ANTHROPIC_BASE_URL: 'https://old.test', CLAUDE_CODE_OAUTH_TOKEN: 'old-login' }
    const a = { ...inherited, ...accountEnv(claude) }
    assert.equal(a.ANTHROPIC_API_KEY, keyA)
    assert.equal(a.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
    assert.equal(a.ANTHROPIC_AUTH_TOKEN, '')
    assert.equal(a.CLAUDE_CODE_OAUTH_TOKEN, '')
    const gateway = { ...claude, apiProfile: { ...defaultAccountApiProfile('claude', 'nanogpt')!, model: 'anthropic/test-model' } }
    assert.equal(accountEnv(gateway).ANTHROPIC_API_KEY, '')
    assert.equal(accountEnv(gateway).ANTHROPIC_AUTH_TOKEN, keyA)
    assert.equal(accountEnv(gateway).ANTHROPIC_BASE_URL, 'https://nano-gpt.com/api/v1')
    const input = { id: 'codex' as const, endpoint: { mode: 'openrouter' as const, baseUrl: '', model: 'wrong/model', apiKey: 'wrong-key' }, openrouterKey: 'wrong-router-key', mcp: [], piExtensionPath: null, account: codex, access: 'yolo' as const, continueLast: true, resumeId: '01234567-89ab-4def-8123-456789abcdef' }
    const launch = agentLaunchPlan(input)
    assert(launch.ok)
    assert.equal(launch.plan.model, codex.apiProfile!.model)
    assert.equal(launch.plan.env.STOKE_ACCOUNT_API_KEY, keyB)
    assert(!JSON.stringify(launch.plan.args).includes(keyA) && !JSON.stringify(launch.plan.args).includes(keyB) && !JSON.stringify(launch.plan).includes('wrong-router-key'))
    assert(launch.plan.args.includes('model_providers.stoke_account.requires_openai_auth=false'))
    assert(launch.plan.args.includes('model_providers.stoke_account.wire_api="responses"'))
    assert(launch.plan.args.includes('--dangerously-bypass-approvals-and-sandbox'))
    assert.deepEqual(launch.plan.args.slice(-2), ['resume', input.resumeId])
    const firstParty = agentLaunchPlan({ ...input, account: { ...codex, apiProfile: defaultAccountApiProfile('codex')! } })
    assert(firstParty.ok && firstParty.plan.model === '' && !firstParty.plan.args.includes('-m'))
    const selectedFirstParty = agentLaunchPlan({ ...input, endpoint: { mode: 'default', model: 'gpt-api-test', baseUrl: '', apiKey: '' }, account: secondCodex })
    assert(selectedFirstParty.ok && selectedFirstParty.plan.model === 'gpt-api-test')
    assert(!agentLaunchPlan({ ...input, account: { ...codex, apiProfile: { ...codex.apiProfile!, model: '' } } }).ok)
    pass('account credentials replace global routes; Codex uses Responses, preserves access/resume and keeps keys out of argv')

    const settings = hydrateSettings({ accounts, providers: { claudeAuth: 'anthropic', anthropicApiKey: '' }, agents: { endpoints: { codex: input.endpoint } } })
    assert.equal(planAccountIdentity({ cli: 'codex', accountId: codex.id }, settings, {}, root).fallback.method, 'NanoGPT')
    assert.equal(planAccountIdentity({ cli: 'claude', accountId: claude.id }, settings, {}, root).native, null)
    assert.equal(usageRouteFor({ cli: 'codex', accountId: codex.id }, { accounts, claudeAuth: 'default', endpointModes: { codex: 'openrouter' } }), null)
    const preflight = new LaunchPreflight({ settings: () => settings, folder: async () => null, executable: async () => 'fixture-agent', canonical: async cwd => cwd, tools: async () => ({ servers: [] }) })
    for (const account of [claude, codex]) {
      const report = await preflight.check({ cli: account.cli, cwd: root, accountId: account.id })
      assert.equal(report.items.find(row => row.id === 'provider')?.state, 'configured')
      assert(!JSON.stringify(report).includes(keyA) && !JSON.stringify(report).includes(keyB))
    }
    pass('launch review and identity use the selected API profile without borrowing a login quota or exposing keys')

    const facts = { accounts, endpoints: { codex: input.endpoint }, defaultAccount: { claude: claude.id, codex: codex.id }, defaultModel: 'sonnet' }
    const choices = agentChoicesFor('claude', facts)
    const shown = phoneChoicesFor({ claude: choices }, 'claude')
    assert.equal(shown.models[0].id, claude.apiProfile!.model)
    assert.equal(shown.modelFixed, true)
    assert.equal(phoneChoicesForAccount(choices, 'default').modelFixed, false)
    const picks = initialPicks(shown, { model: 'sonnet' })
    const fields = startFields('claude', shown, picks)
    assert.equal(fields.model, undefined)
    assert(phoneLaunchVerdict(fields, choices, 'Claude Code').ok)
    assert(!phoneLaunchVerdict({ ...fields, model: 'sonnet' }, choices, 'Claude Code').ok)
    assert.equal(phoneChoicesFor({ codex: agentChoicesFor('codex', facts) }, 'codex').models[0].id, codex.apiProfile!.model)
    assert(!JSON.stringify(choices).includes(keyA) && !JSON.stringify(choices).includes(keyB))
    pass('phone model choices and start validation follow the selected API account and exclude its key')

    const backend = { isEncryptionAvailable: () => true, selectedBackend: () => null, encrypt: (plain: string) => Buffer.from(plain.split('').reverse().join('')), decrypt: (sealed: Buffer) => sealed.toString().split('').reverse().join('') }
    const store = new SecretStore(root, backend, 'darwin')
    store.save({ ...settings, accounts: multiple })
    const disk = readFileSync(join(root, 'settings.json'), 'utf8')
    const vault = readFileSync(join(root, 'secrets.json'), 'utf8')
    assert(!disk.includes(keyA) && !disk.includes(keyB) && !vault.includes(keyA) && !vault.includes(keyB))
    const beforeUnlock = hydrateSettings(JSON.parse(disk))
    assert.deepEqual(Object.keys(beforeUnlock.accounts), [claude.id, codex.id, secondClaude.id, secondCodex.id])
    assert.equal(beforeUnlock.accounts[codex.id].apiProfile?.provider, 'nanogpt')
    const restored = hydrateSettings(new SecretStore(root, backend, 'darwin').load())
    assert.equal(restored.accounts[claude.id].apiKey, keyA)
    assert.equal(restored.accounts[codex.id].apiKey, keyB)
    assert.equal(restored.accounts[secondClaude.id].apiKey, keyB)
    assert.equal(restored.accounts[secondCodex.id].apiKey, keyA)
    pass('multiple Claude/Codex API keys seal separately, survive a locked-vault settings read and restore to their own named profiles')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
