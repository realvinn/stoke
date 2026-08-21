import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where Claude Code keeps its own configuration.
 *
 * Two files, and they are not interchangeable. `~/.claude/settings.json` is the
 * hand-owned settings file — small, rewritten only on an explicit user action.
 * `~/.claude.json` is the *global config*: 155 KB here, rewritten constantly by
 * every live session, and guarded by a lock. Writing them needs different care,
 * so they get different modules; this one only says where they are.
 *
 * Environment and home come in as arguments, the shape `workspaceRoots.ts`
 * uses, so a suite can ask about another machine's layout without pretending to
 * be that machine. Nothing here imports `electron`, so it runs under
 * `node --experimental-strip-types` too.
 */

/**
 * The config *directory*, `kn()` in the bundle. Note the asymmetry it creates:
 * with `CLAUDE_CONFIG_DIR` unset the settings file is under `~/.claude/` while
 * the global config sits at `~/.claude.json`, one level up.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(claudeConfigDir(env, home), 'settings.json')
}

/**
 * The suffix the CLI appends to the global config's name, `Sct()`.
 *
 * Four-valued, not two. Only the production empty string is common, but a
 * developer pointed at a staging endpoint has a differently-named config and
 * writing the wrong one would be a silent no-op.
 */
function oauthSuffix(env: NodeJS.ProcessEnv): string {
  const url = env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  if (!url) return ''
  if (url.includes('localhost') || url.includes('127.0.0.1')) return '-local-oauth'
  if (url.includes('staging')) return '-staging-oauth'
  return '-custom-oauth'
}

/**
 * The global config, resolved exactly as `W9y()` does — including the
 * `.config.json` override, which **wins outright** when it exists. Verified
 * live: with both files present the CLI wrote `.config.json` and never touched
 * `.claude.json`, so a writer that assumed `~/.claude.json` would edit a file
 * nothing reads.
 */
export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  const override = join(claudeConfigDir(env, home), '.config.json')
  if (existsSync(override)) return override
  return join(env.CLAUDE_CONFIG_DIR || home, `.claude${oauthSuffix(env)}.json`)
}

/** The lock sits beside the config, and is a directory. See claudeGlobalConfig.ts. */
export function claudeGlobalConfigLockPath(env: NodeJS.ProcessEnv, home: string): string {
  return `${claudeGlobalConfigPath(env, home)}.lock`
}
