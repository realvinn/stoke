/*
 * Accounts: more than one sign-in per coding agent — "Claude" and a second
 * Claude account, two Codex logins, two Grok API keys — picked per launch.
 *
 * An account is one of two things, and only one:
 *
 *   login  A HOME for the agent: a folder the agent keeps its sign-in in,
 *          chosen per launch by the agent's own "config home" environment
 *          variable (`ACCOUNT_HOME_ENV`). Stoke makes the folder, the agent's
 *          own login command signs it in, and nothing of the credential ever
 *          passes through Stoke.
 *   key    An API key the agent reads from its environment
 *          (`ACCOUNT_KEY_ENV`), sealed at rest in secrets.json like every other
 *          key (shared/secrets.ts `accounts.*.apiKey`).
 *
 * The implicit Default account is today's behaviour exactly: no variable is
 * set, so the agent uses whatever it always used. It is never stored; its id,
 * `DEFAULT_ACCOUNT_ID`, is what a tab carries to say "on Default" explicitly,
 * so a tab that ran on Default does not move to a newly chosen default account
 * when it is restored.
 *
 * Every home variable below was read out of the vendor's own artefact — the
 * installed binary, or the published package streamed and never run — on
 * 2026-09-30 (the research is quoted beside each entry). An agent whose
 * sign-in does not follow its home (Cursor: fixed Keychain names) gets no
 * login accounts at all: a second "account" there would silently be the first.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27);
 * `scripts/verify-accounts.mts` runs it under strip-types, so shared imports
 * are relative with `.ts` (gotcha 78). The parts that touch a disk — the home,
 * its links, the Keychain service name — are `src/main/accounts.ts`.
 */
import { AGENT_SEEDS } from './agentColors.ts'
import { cliFor, isCodingCliId, type CodingCliId } from './codingClis.ts'
import type { StatusLineSnapshot } from './types.ts'

/** The account a launch uses when it names none and no default is chosen: no variable set. */
export const DEFAULT_ACCOUNT_ID = 'default'

export type AccountKind = 'login' | 'key'

export interface AgentAccount {
  /** `<cli>-<slug>`, e.g. `claude-work`. Also its colour key (`--agent-claude-work-ink`). */
  id: string
  cli: CodingCliId
  /** What the user calls it. For a Claude login, the signed-in email once read. */
  label: string
  kind: AccountKind
  /**
   * A login account's folder, realpath'd when it was made (gotcha 91): the
   * exact string handed to the agent, which for Claude Code is also what its
   * Keychain item is named after. '' for a key account.
   */
  home: string
  /** A key account's key; '' in settings.json once sealed (shared/secrets.ts). */
  apiKey: string
  /** One of `ACCOUNT_SWATCHES` by id; absent is the next free one (`accountSeed`). */
  swatch?: string
}

/* ------------------------------------------------------------ the tables */

/**
 * The variable that moves each agent's whole config home, and so its sign-in.
 *
 *   claude   CLAUDE_CONFIG_DIR — the credentials file is `<dir>/.credentials.json`,
 *            and the macOS Keychain item is named after a hash of the dir
 *            (`claudeKeychainService`, main/accounts.ts), read from 2.1.285.
 *   codex    CODEX_HOME — `auth.json` in it; the default store is the file
 *            (Codex 0.153.1).
 *   grok     GROK_HOME — "Grok stores data in ~/.grok (override with
 *            GROK_HOME)"; it REFUSES a symlinked home, which is why every
 *            home is realpath'd and is a real folder (grok 1.0.44).
 *   gemini   GEMINI_CLI_HOME — replaces the home; `.gemini` goes inside it.
 *            Its Keychain store is NOT per home, so `ACCOUNT_EXTRA_ENV` keeps
 *            it on the file store (@google/gemini-cli 0.62.0).
 *   qwen     QWEN_HOME — the `.qwen` folder itself (@qwen-code 0.24.7).
 *   kimi     KIMI_CODE_HOME — `credentials/` inside it (@moonshot-ai/kimi-code 2.1.1).
 *   copilot  COPILOT_HOME — "replaces the entire ~/.copilot path" (docs; the
 *            1.0.89 loader reads it). Its Keychain entries are per login.
 *   pi       PI_CODING_AGENT_DIR — `auth.json` in it (pi-coding-agent 0.99.1).
 *   cline    CLINE_DIR — `data/settings/providers.json` in it (@cline/core 0.0.86).
 *   vibe     VIBE_HOME — honoured (mistral_vibe 2.25.8), but its key lives in
 *            the OS keyring under one fixed service, so a second home is not a
 *            second sign-in: Vibe gets key accounts only (`LOGIN_ACCOUNTS`).
 *   droid    FACTORY_HOME_OVERRIDE — replaces the home, `.factory` appended
 *            (@factory/cli 0.229.0). Undocumented, and whether the encrypted
 *            `auth.v2.*` files follow it is unproven.
 */
export const ACCOUNT_HOME_ENV: Readonly<Partial<Record<CodingCliId, string>>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
  gemini: 'GEMINI_CLI_HOME',
  qwen: 'QWEN_HOME',
  kimi: 'KIMI_CODE_HOME',
  copilot: 'COPILOT_HOME',
  pi: 'PI_CODING_AGENT_DIR',
  cline: 'CLINE_DIR',
  vibe: 'VIBE_HOME',
  droid: 'FACTORY_HOME_OVERRIDE'
}

/** Whose sign-in lives inside the home above, so a second home is a second account. */
export const LOGIN_ACCOUNTS: ReadonlySet<CodingCliId> = new Set(
  (Object.keys(ACCOUNT_HOME_ENV) as CodingCliId[]).filter((id) => id !== 'vibe')
)

/**
 * Set beside the home on every launch of that agent's login account. Gemini's
 * encrypted store is one Keychain item for every home, so a login account on
 * it would sign the default account out; the file store is per home.
 */
export const ACCOUNT_EXTRA_ENV: Readonly<Partial<Record<CodingCliId, Readonly<Record<string, string>>>>> = {
  gemini: { GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' }
}

/**
 * The variable a key account's key travels in, and anything that must travel
 * with it. Checked against each vendor's artefact (research, 2026-09-30).
 *
 * Cursor persists a CURSOR_API_KEY into its credential store unless the store
 * is `memory` — without it a launch on a key account would overwrite the
 * user's own Cursor sign-in — so the two always travel together.
 *
 * Not Claude Code: its key is Settings › Providers, the Default account's
 * auth, and a second writer for it would be gotcha 57.
 */
export const ACCOUNT_KEY_ENV: Readonly<
  Partial<Record<CodingCliId, { key: string; with?: Readonly<Record<string, string>> }>>
> = {
  grok: { key: 'XAI_API_KEY' },
  cursor: { key: 'CURSOR_API_KEY', with: { AGENT_CLI_CREDENTIAL_STORE: 'memory' } },
  vibe: { key: 'MISTRAL_API_KEY' },
  amp: { key: 'AMP_API_KEY' },
  kilo: { key: 'KILO_API_KEY' },
  droid: { key: 'FACTORY_API_KEY' },
  copilot: { key: 'COPILOT_GITHUB_TOKEN' },
  auggie: { key: 'AUGMENT_API_TOKEN' },
  cline: { key: 'CLINE_API_KEY' }
}

/**
 * The agent's own sign-in command, where one exists and was read: `claude auth
 * login` (2.1.285's `auth login|status|logout`) and `codex login` (0.153.1).
 * Every other agent asks for its sign-in the first time it runs in an empty
 * home, so its sign-in tab runs the agent itself.
 */
export const ACCOUNT_LOGIN_ARGS: Readonly<Partial<Record<CodingCliId, readonly string[]>>> = {
  claude: ['auth', 'login'],
  codex: ['login']
}

export function loginArgsFor(cli: CodingCliId): string[] {
  return [...(ACCOUNT_LOGIN_ARGS[cli] ?? [])]
}

/** Which kinds of account an agent can hold at all. */
export function accountKindsFor(cli: CodingCliId): AccountKind[] {
  const out: AccountKind[] = []
  if (LOGIN_ACCOUNTS.has(cli)) out.push('login')
  if (ACCOUNT_KEY_ENV[cli]) out.push('key')
  return out
}

/* ------------------------------------------------------------ names, ids */

/** Short enough for a tab tag and a folder name; long enough for "work-2026". */
export const ACCOUNT_SLUG_MAX = 32
export const ACCOUNT_LABEL_MAX = 40

/**
 * The folder-and-id-safe form of a name: lowercase ASCII letters and digits,
 * one dash between runs, nothing else. '' when nothing is left — a name that
 * is all punctuation is refused, never turned into `claude-`.
 */
export function accountSlug(name: string): string {
  return name
    .normalize('NFKD')
    // The accents NFKD split off, so `Équipe` is `equipe`, not `e-quipe`.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ACCOUNT_SLUG_MAX)
    .replace(/-+$/g, '')
}

export function accountIdFor(cli: CodingCliId, slug: string): string {
  return `${cli}-${slug}`
}

const ACCOUNT_ID = /^[a-z]+-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A stored account id: `<a cli id>-<slug>`. Never `default`, which has no dash. */
export function isAccountId(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > ACCOUNT_SLUG_MAX + 12 || !ACCOUNT_ID.test(v)) return false
  return isCodingCliId(v.slice(0, v.indexOf('-')))
}

/** The agent an account id belongs to, or null for anything that is not one. */
export function cliOfAccountId(id: string): CodingCliId | null {
  return isAccountId(id) ? (id.slice(0, id.indexOf('-')) as CodingCliId) : null
}

/** The slug half of an id: `work` for `claude-work`. */
export function slugOfAccountId(id: string): string {
  return id.slice(id.indexOf('-') + 1)
}

/** A label as stored: whitespace folded, trimmed, cut by code point. */
export function cleanAccountLabel(v: unknown): string {
  if (typeof v !== 'string') return ''
  return Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, ACCOUNT_LABEL_MAX).join('').trim()
}

/** What an unnamed account is called: its slug, capitalised. */
export function defaultAccountLabel(id: string): string {
  const slug = slugOfAccountId(id).replace(/-/g, ' ')
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}

/**
 * An absolute path, on either platform, with nothing in it a shell line or
 * a JSON line could trip on. The home becomes an environment variable and a
 * line of `index.json`; a control character in either is refused, never
 * escaped (gotcha 75's rule).
 */
export function isAccountHome(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096) return false
  if (/[\u0000-\u001f\u007f]/.test(v)) return false
  return v.startsWith('/') || /^[A-Za-z]:\\/.test(v) || /^\\\\[^\\?.]/.test(v)
}

/* ----------------------------------------------------------------- colour */

/**
 * The colours an account can wear. Each is one of the agent seeds, so each
 * already clears every floor `verify:agents` holds a seed to (the meter's
 * three tiers, --danger, --warning) — an account's tag is drawn by the same
 * writer, under its own key (`agentTokenNames('claude-work')`).
 */
export const ACCOUNT_SWATCHES: readonly { id: string; name: string; seed: string }[] = [
  { id: 'sky', name: 'Sky', seed: AGENT_SEEDS.gemini },
  { id: 'violet', name: 'Violet', seed: AGENT_SEEDS.opencode },
  { id: 'teal', name: 'Teal', seed: AGENT_SEEDS.grok },
  { id: 'periwinkle', name: 'Periwinkle', seed: AGENT_SEEDS.codex },
  { id: 'jade', name: 'Jade', seed: AGENT_SEEDS.aider },
  { id: 'azure', name: 'Azure', seed: AGENT_SEEDS.droid },
  { id: 'orchid', name: 'Orchid', seed: AGENT_SEEDS.amp },
  { id: 'pink', name: 'Pink', seed: AGENT_SEEDS.claude }
]

function isSwatchId(v: unknown): v is string {
  return typeof v === 'string' && ACCOUNT_SWATCHES.some((s) => s.id === v)
}

/**
 * The swatch a new account of `cli` gets: the first that is neither the
 * agent's own colour nor worn by another of its accounts, so two accounts of
 * one agent and the agent itself are three different colours while they can be.
 */
export function nextSwatch(cli: CodingCliId, taken: readonly (string | undefined)[], agentSeed: string): string {
  const used = new Set(taken.filter(Boolean))
  const free = ACCOUNT_SWATCHES.filter((s) => s.seed.toLowerCase() !== agentSeed.toLowerCase())
  return (free.find((s) => !used.has(s.id)) ?? free[0] ?? ACCOUNT_SWATCHES[0]).id
}

/** The colour an account is drawn in. */
export function accountSeed(account: Pick<AgentAccount, 'swatch'>): string {
  return (ACCOUNT_SWATCHES.find((s) => s.id === account.swatch) ?? ACCOUNT_SWATCHES[0]).seed
}

/* ---------------------------------------------------------------- hydrate */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * One stored account, rebuilt from named keys (the clamp rule: a field this
 * does not name does not survive), or null for one that cannot be used.
 *
 * A login account needs a usable home and an agent whose sign-in follows it;
 * a key account needs an agent with a key variable. The key itself may be ''
 * — settings.json holds '' once it is sealed, and an early read before the
 * vault is open must not drop the account (it would then be persisted
 * without it). A launch on an empty key is refused with a sentence instead.
 */
export function hydrateAccount(id: string, raw: unknown): AgentAccount | null {
  if (!isRecord(raw)) return null
  const cli = cliOfAccountId(id)
  if (!cli) return null
  if (raw.cli !== undefined && raw.cli !== cli) return null
  const kind: AccountKind = raw.kind === 'key' ? 'key' : 'login'
  if (kind === 'login' && (!LOGIN_ACCOUNTS.has(cli) || !isAccountHome(raw.home))) return null
  if (kind === 'key' && !ACCOUNT_KEY_ENV[cli]) return null
  return {
    id,
    cli,
    label: cleanAccountLabel(raw.label) || defaultAccountLabel(id),
    kind,
    home: kind === 'login' ? (raw.home as string) : '',
    apiKey: kind === 'key' && typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    ...(isSwatchId(raw.swatch) ? { swatch: raw.swatch } : {})
  }
}

/** Every stored account, keyed by id. Junk, unknown agents and unsafe ids are dropped. */
export function hydrateAccounts(raw: unknown): Record<string, AgentAccount> {
  const out: Record<string, AgentAccount> = {}
  if (!isRecord(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue
    const a = hydrateAccount(id, v)
    if (a) out[id] = a
  }
  return out
}

/**
 * `agents.defaultAccount`: per agent, the account a launch that names none
 * uses. Only an id of THAT agent's shape survives; whether the account still
 * exists is `resolveLaunchAccount`'s question, since it lives in another block.
 */
export function hydrateDefaultAccounts(raw: unknown): Partial<Record<CodingCliId, string>> {
  const out: Partial<Record<CodingCliId, string>> = {}
  if (!isRecord(raw)) return out
  for (const [cli, id] of Object.entries(raw)) {
    if (!isCodingCliId(cli) || !isAccountId(id)) continue
    if (cliOfAccountId(id) === cli) out[cli] = id
  }
  return out
}

/**
 * What a settings patch from the renderer may change about accounts: a label,
 * a swatch, a key — on accounts that already exist. Never an add, a removal,
 * a kind, an agent or a HOME: a home becomes an environment variable that
 * points an agent at a folder, and only main makes one (`accounts:create`).
 */
export function accountsFromRenderer(
  current: Record<string, AgentAccount>,
  patch: unknown
): Record<string, AgentAccount> {
  if (!isRecord(patch)) return current
  const out: Record<string, AgentAccount> = {}
  for (const [id, mine] of Object.entries(current)) {
    const theirs = patch[id]
    if (!isRecord(theirs)) {
      out[id] = mine
      continue
    }
    const label = cleanAccountLabel(theirs.label)
    out[id] = {
      ...mine,
      label: label || mine.label,
      apiKey: mine.kind === 'key' && typeof theirs.apiKey === 'string' ? theirs.apiKey.trim() : mine.apiKey,
      ...(isSwatchId(theirs.swatch) ? { swatch: theirs.swatch } : mine.swatch ? { swatch: mine.swatch } : {})
    }
  }
  return out
}

/** An agent's accounts, in the order they were made. */
export function accountsOf(cli: CodingCliId, accounts: Record<string, AgentAccount>): AgentAccount[] {
  return Object.values(accounts).filter((a) => a.cli === cli)
}

/* -------------------------------------------------------------- launching */

export type AccountResolution =
  | { ok: true; accountId: string; account: AgentAccount | null }
  | { ok: false; message: string }

/**
 * The account one launch runs on.
 *
 * `requested` absent is "whatever this agent's default account is" — the
 * launcher's Start, `stoke .`, the phone — which falls back to Default when
 * that account has since been removed, so a stale default never stops Start.
 * `requested` named is a tab asking for ITS account back (relaunch, restore,
 * Start again): that one is refused rather than silently swapped, because a
 * conversation resumed on another account is spending someone else's plan.
 */
export function resolveLaunchAccount(input: {
  cli: CodingCliId
  requested?: string | null
  accounts: Record<string, AgentAccount>
  defaults: Partial<Record<CodingCliId, string>>
}): AccountResolution {
  const { cli, accounts } = input
  const requested = input.requested ?? null
  if (requested === null || requested === '') {
    const id = input.defaults[cli]
    const a = id ? accounts[id] : undefined
    return a && a.cli === cli ? { ok: true, accountId: a.id, account: a } : { ok: true, accountId: DEFAULT_ACCOUNT_ID, account: null }
  }
  if (requested === DEFAULT_ACCOUNT_ID) return { ok: true, accountId: DEFAULT_ACCOUNT_ID, account: null }
  const a = isAccountId(requested) ? accounts[requested] : undefined
  if (!a) {
    return { ok: false, message: 'That account is no longer in Settings › Agents. Start the session on another account.' }
  }
  if (a.cli !== cli) {
    return { ok: false, message: `${a.label} is a ${cliFor(a.cli).label} account; it cannot start ${cliFor(cli).label}.` }
  }
  return { ok: true, accountId: a.id, account: a }
}

/**
 * Why this account cannot be launched right now, or null. `endpointMode` is
 * the agent's endpoint (Settings › Agents): a key account supplies the key an
 * endpoint would, so the two together would send one vendor's key to another.
 */
export function accountProblem(account: AgentAccount, endpointMode: 'default' | 'openrouter' | 'custom' = 'default'): string | null {
  const cli = cliFor(account.cli)
  if (account.kind === 'login') {
    if (!ACCOUNT_HOME_ENV[account.cli] || !LOGIN_ACCOUNTS.has(account.cli)) {
      return `${cli.label} keeps one sign-in for the whole machine, so Stoke cannot start it on ${account.label}.`
    }
    if (!isAccountHome(account.home)) return `${account.label} has no folder. Remove it and add it again in Settings › Agents.`
    return null
  }
  if (!ACCOUNT_KEY_ENV[account.cli]) return `${cli.label} takes no API key from Stoke.`
  if (!account.apiKey) return `${account.label} has no key yet. Add it in Settings › Agents › ${cli.label}.`
  if (endpointMode !== 'default') {
    return `${cli.label} is set to use ${endpointMode === 'openrouter' ? 'OpenRouter' : 'a custom endpoint'}, which brings its own key. Set it back to its own sign-in to use ${account.label}.`
  }
  return null
}

/**
 * The environment one launch on this account adds, merged over the inherited
 * one last. For a login account the home (plus `ACCOUNT_EXTRA_ENV`); for a key
 * account the key (plus what must travel with it). Keys only ever travel
 * here, never in argv.
 */
export function accountEnv(account: AgentAccount): Record<string, string> {
  if (account.kind === 'login') {
    const name = ACCOUNT_HOME_ENV[account.cli]
    if (!name || !account.home) return {}
    return { [name]: account.home, ...(ACCOUNT_EXTRA_ENV[account.cli] ?? {}) }
  }
  const spec = ACCOUNT_KEY_ENV[account.cli]
  if (!spec || !account.apiKey) return {}
  return { ...(spec.with ?? {}), [spec.key]: account.apiKey }
}

/* ------------------------------------------------------------------ usage */

/**
 * A statusLine reading as the plan-limit chip may see it.
 *
 * The rate limits in a payload are the ACCOUNT's, and the chip, `keepUsage`
 * and `lastStatusLine` all assume there is one account (gotcha 45's merge).
 * Until usage is keyed per account, a session on any other account keeps its
 * per-session fields — context window, version, prompt id — and hands the
 * chip no rate limits, so `keepUsage` holds the Default account's figures
 * rather than mixing two accounts' numbers into one.
 */
export function usageShareOf(snap: StatusLineSnapshot, accountId: string | null | undefined): StatusLineSnapshot {
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return snap
  if (snap.fiveHour === null && snap.sevenDay === null) return snap
  return { ...snap, fiveHour: null, sevenDay: null }
}

/* ---------------------------------------------------------- the index file */

/** Where the index lives, relative to the accounts folder. */
export const ACCOUNT_INDEX_NAME = 'index.json'

/**
 * Every variable an account can set in a shell: what `stoke account env
 * default` unsets to put a shell back on each agent's own sign-in.
 */
export function accountEnvNames(): string[] {
  const names = new Set<string>(Object.values(ACCOUNT_HOME_ENV))
  for (const extra of Object.values(ACCOUNT_EXTRA_ENV)) for (const k of Object.keys(extra ?? {})) names.add(k)
  return [...names]
}

/**
 * `~/.stoke/accounts/index.json`: what the `stoke` command reads to answer
 * `stoke account list` and `stoke account env NAME` with no app running.
 *
 * Valid JSON, and deliberately LINE-shaped: one account per line, its keys
 * always in this order, the free-text label last. The POSIX shim has no JSON
 * parser, so it reads a line with one anchored pattern — `id`, `name`, `cli`
 * and `env` hold only `[a-z0-9_-]`/`[A-Z_]`, so nothing before `home` can
 * contain a quote, and a label that does cannot reach back into `home`. A
 * home that JSON would have to escape (a backslash, a quote) is written as
 * JSON requires and the POSIX shim refuses that line rather than unescaping
 * it; the Windows shim parses real JSON. No key is ever written here.
 */
export function accountIndexText(accounts: readonly AgentAccount[]): string {
  const lines = accounts.map((a) => {
    const login = a.kind === 'login'
    const env = login ? (ACCOUNT_HOME_ENV[a.cli] ?? '') : ''
    // `NAME=value` pairs, space-separated; names and values are fixed table
    // text of [A-Za-z0-9_], so the shim can print them as they are.
    const extra = login
      ? Object.entries(ACCOUNT_EXTRA_ENV[a.cli] ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : ''
    const fields: [string, string][] = [
      ['id', a.id],
      ['name', slugOfAccountId(a.id)],
      ['cli', a.cli],
      ['env', env],
      ['extra', extra],
      ['home', login ? a.home : ''],
      ['label', a.label]
    ]
    return `    {${fields.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`
  })
  return [
    '{',
    '  "version": 1,',
    '  "note": "Written by Stoke. The stoke command reads it for `stoke account list` and `stoke account env NAME`. Change accounts in Settings, Agents.",',
    '  "unset": ' + JSON.stringify(accountEnvNames()) + ',',
    '  "accounts": [',
    lines.join(',\n'),
    '  ]',
    '}',
    ''
  ]
    .filter((l, i, all) => !(l === '' && i !== all.length - 1))
    .join('\n')
}
