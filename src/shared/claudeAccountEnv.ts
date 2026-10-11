/** Credentials/provider selectors that can outrank a named Claude account.
 * https://code.claude.com/docs/en/authentication#authentication-precedence
 * Default keeps its inherited environment; named accounts own their auth.
 */
export const CLAUDE_ACCOUNT_AUTH_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR'
]

/** Apply only to a named Claude login/API launch, including auth login/status.
 * Unset conflicting credentials rather than blanking login auth. On Windows,
 * remove every spelling before assigning, so node-pty cannot inherit an older
 * case-insensitive duplicate (the same issue as PATH, gotcha 99).
 */
export function applyClaudeAccountEnv<T extends Record<string, string | undefined>>(
  env: T,
  selected: Record<string, string>,
  platform: string
): T {
  const cleared = new Set([...CLAUDE_ACCOUNT_AUTH_ENV, ...Object.keys(selected)])
  for (const name of Object.keys(env)) {
    if (cleared.has(platform === 'win32' ? name.toUpperCase() : name)) delete env[name]
  }
  return Object.assign(env, selected)
}
