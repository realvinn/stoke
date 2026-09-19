/*
 * The coding CLIs Stoke knows about, and what it can honestly say about them.
 *
 * Stoke wraps the real `claude` binary in a PTY rather than reimplementing it,
 * and the same trick works for any CLI that draws a TUI. This module is the
 * list; `src/main/cli.ts` does the looking.
 *
 * Stoke can launch these, not merely find them — but only Claude Code gets the
 * whole app around it. Everything Stoke draws beside a session (the context
 * ring, resume, the worklog, the plan-limit chip) is fed by Claude Code's own
 * transcript format and its statusLine hook, and what each OTHER cli can
 * honestly feed is recorded in `CLI_CAPS` below rather than assumed. A tab that
 * cannot measure its context shows nothing there; it never shows Claude's.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27).
 */

export type CodingCliId =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'opencode'
  | 'pi'
  | 'gemini'
  | 'qwen'
  | 'kimi'
  | 'copilot'
  | 'cursor'
  | 'amp'
  | 'kilo'
  | 'aider'
  | 'crush'
  | 'droid'
  | 'cline'
  | 'auggie'
  | 'vibe'

/** The three platforms a recipe can name. */
export type InstallPlatform = 'darwin' | 'linux' | 'win32'

export interface CodingCli {
  id: CodingCliId
  /** What to call it in the UI. */
  label: string
  /** Who makes it, for the one-line description. */
  vendor: string
  /** One line for someone choosing between them in the agent picker. */
  blurb: string
  /**
   * Executable names to look for, in order of preference.
   *
   * Windows needs the variants spelled out: an npm-installed CLI is a `.cmd`
   * shim, not an `.exe`, and `spawnSpec` runs those through `cmd.exe` (gotcha
   * 13). A bare name would find neither. The name is NOT always the id.
   */
  bins: { posix: readonly string[]; win32: readonly string[] }
  /** Where to get it, shown when it is not installed. */
  home: string
  /**
   * The vendor's own install command, per platform — the exact text Stoke runs
   * in a terminal tab, so what the user reads before pressing Install is what
   * runs. POSIX entries run under bash, win32 ones under PowerShell. A missing
   * platform means Stoke offers the `home` link instead of running anything.
   *
   * Only first-party routes: each is the one the vendor's own README or docs
   * list first, checked on 2026-09-19. A community mirror is exactly the thing
   * a user cannot evaluate from a button.
   */
  install: Partial<Record<InstallPlatform, string>>
  /** What the install command needs already present, said before it runs. */
  installNeeds?: string
  /** A side effect of the install worth knowing before pressing the button. */
  installNote?: string
  /**
   * What `<bin> --version` must print for a file of that name to be this agent.
   * For names that unrelated programs also use: Homebrew's `grok` is a regex
   * tool and its `amp` a text editor. Absent means the filename is enough.
   */
  identify?: RegExp
  /**
   * Arguments that continue the most recent session in the working folder,
   * appended after any endpoint flags. Absent when the CLI has no such thing.
   */
  continueArgs?: readonly string[]
  /**
   * Which endpoint overrides Stoke can apply to this CLI AT LAUNCH — flags and
   * environment only, never a write to the CLI's own config file (the same
   * discipline gotcha 38 demands for `~/.claude.json`). `custom` names the wire
   * protocol a custom endpoint must speak, because that is the thing a user has
   * to know before pointing it anywhere.
   */
  endpoints: { openrouter: boolean; custom: string | null }
}

export const CODING_CLIS: readonly CodingCli[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    blurb: 'Anthropic’s agent. The one Stoke is built around: context ring, resume, plan limits, worklog.',
    bins: { posix: ['claude'], win32: ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] },
    home: 'https://claude.com/claude-code',
    install: {
      darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
      linux: 'curl -fsSL https://claude.ai/install.sh | bash',
      win32: 'irm https://claude.ai/install.ps1 | iex'
    },
    // Claude's endpoints live in Settings › Providers (an Anthropic-compatible
    // gateway), and its resume is Stoke's own minted session id.
    endpoints: { openrouter: false, custom: null }
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    vendor: 'OpenAI',
    blurb: 'OpenAI’s agent. Sign in with ChatGPT, or point it at OpenRouter or any Responses-API endpoint.',
    bins: { posix: ['codex'], win32: ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] },
    home: 'https://github.com/openai/codex',
    install: {
      // CODEX_NON_INTERACTIVE: the script otherwise stops to ask on /dev/tty
      // whether to remove an npm, brew or bun copy it finds — checked in
      // install.sh, 2026-09-19. Set, it keeps the old copy and carries on.
      darwin: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
      linux: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
      win32: 'irm https://chatgpt.com/codex/install.ps1 | iex'
    },
    // `resume` is a subcommand and filters by the working folder unless `--all`.
    continueArgs: ['resume', '--last'],
    endpoints: { openrouter: true, custom: 'OpenAI Responses API' }
  },
  {
    id: 'grok',
    label: 'Grok Build',
    vendor: 'xAI',
    blurb: 'xAI’s official agent, the grok command. Sign in with X, or bring an OpenRouter key.',
    bins: { posix: ['grok'], win32: ['grok.exe', 'grok.cmd', 'grok.bat', 'grok'] },
    home: 'https://x.ai/cli',
    install: {
      darwin: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      linux: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      win32: 'irm https://x.ai/cli/install.ps1 | iex'
    },
    installNote: 'Also adds an agent command, the same program under a second name.',
    // `grok 1.0.34 (3736acbc8658)`. Homebrew's `grok` is a regex tool, and the
    // community grok-cli prints a bare version — neither takes Grok Build's
    // environment variables, so neither is this agent.
    identify: /^grok \d+\.\d+\.\d+ \(/m,
    continueArgs: ['--continue'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'Anomaly',
    blurb: 'Open-source agent for any provider — OpenRouter, a local model, or your own endpoint.',
    bins: { posix: ['opencode'], win32: ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode'] },
    home: 'https://opencode.ai',
    install: {
      darwin: 'curl -fsSL https://opencode.ai/install | bash',
      linux: 'curl -fsSL https://opencode.ai/install | bash',
      win32: 'npm install -g opencode-ai'
    },
    continueArgs: ['--continue'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  {
    id: 'pi',
    label: 'Pi',
    vendor: 'Earendil Works',
    blurb: 'A small, extensible agent that runs on almost any provider, OpenRouter included.',
    bins: { posix: ['pi'], win32: ['pi.cmd', 'pi.exe', 'pi.bat', 'pi'] },
    home: 'https://pi.dev',
    install: {
      darwin: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
      linux: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
      win32: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
    },
    installNeeds: 'Node.js 22.19 or newer',
    continueArgs: ['--continue'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  /*
   * The six below were read off each vendor's docs and the installed CLI's
   * --help on 2026-09-19, then fact-checked by a second pass against live
   * registries and a local probe server that logged every request's path and
   * auth header.
   */
  {
    id: 'gemini',
    label: 'Gemini CLI',
    vendor: 'Google',
    blurb: 'Google’s agent. Sign in with Google or a Gemini API key; it speaks only Google’s own API, so no OpenRouter.',
    bins: { posix: ['gemini'], win32: ['gemini.cmd', 'gemini.exe', 'gemini'] },
    home: 'https://github.com/google-gemini/gemini-cli',
    // npm is the docs' default; Homebrew's formula lagged fourteen releases.
    install: {
      darwin: 'npm install -g @google/gemini-cli',
      linux: 'npm install -g @google/gemini-cli',
      win32: 'npm install -g @google/gemini-cli'
    },
    installNeeds: 'Node.js 20 or newer',
    continueArgs: ['--resume', 'latest'],
    // GOOGLE_GEMINI_BASE_URL exists but speaks only the Gemini protocol
    // (`…:streamGenerateContent`, x-goog-api-key), which OpenRouter does not serve.
    endpoints: { openrouter: false, custom: null }
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    vendor: 'Alibaba',
    blurb: 'Alibaba’s open-source agent. Its free sign-in ended in April 2026, so bring a key — OpenRouter works.',
    bins: { posix: ['qwen'], win32: ['qwen.cmd', 'qwen.exe', 'qwen'] },
    home: 'https://github.com/QwenLM/qwen-code',
    // The standalone build carries its own Node, so this needs nothing first.
    install: {
      darwin: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
      linux: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
      win32: 'irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex'
    },
    continueArgs: ['--continue'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    vendor: 'Moonshot AI',
    blurb: 'Moonshot’s agent. Sign in with Kimi, or bring an OpenRouter key.',
    bins: { posix: ['kimi'], win32: ['kimi.exe', 'kimi.cmd', 'kimi'] },
    home: 'https://www.kimi.com/code',
    install: {
      darwin: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
      linux: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
      win32: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex'
    },
    installNote: 'On Windows it needs Git for Windows.',
    continueArgs: ['--continue'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  {
    id: 'copilot',
    label: 'Copilot CLI',
    vendor: 'GitHub',
    blurb: 'GitHub’s agent, on your Copilot plan — or on OpenRouter, with no GitHub sign-in at all.',
    bins: { posix: ['copilot'], win32: ['copilot.exe', 'copilot.cmd', 'copilot'] },
    home: 'https://github.com/github/copilot-cli',
    // GitHub lists four routes and ranks none; these two need nothing else
    // installed first. gh.io is GitHub's own short link to the script.
    install: {
      darwin: 'curl -fsSL https://gh.io/copilot-install | bash',
      linux: 'curl -fsSL https://gh.io/copilot-install | bash',
      win32: 'winget install GitHub.Copilot'
    },
    continueArgs: ['--continue'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    vendor: 'Anysphere',
    blurb: 'Cursor’s agent in the terminal, on your Cursor plan. Its models run through Cursor’s servers, so no OpenRouter.',
    // `cursor-agent`, never the other name it installs: `agent` is also what
    // Grok Build's installer writes into ~/.local/bin.
    bins: { posix: ['cursor-agent'], win32: ['cursor-agent.cmd', 'cursor-agent.exe', 'cursor-agent'] },
    home: 'https://cursor.com/cli',
    install: {
      darwin: 'curl https://cursor.com/install -fsS | bash',
      linux: 'curl https://cursor.com/install -fsS | bash',
      win32: 'irm "https://cursor.com/install?win32=true" | iex'
    },
    continueArgs: ['--continue'],
    endpoints: { openrouter: false, custom: null }
  },
  {
    id: 'amp',
    label: 'Amp',
    vendor: 'Amp',
    blurb: 'Amp’s agent, on your Amp account. Models follow its modes and your account’s settings, not a launch flag.',
    bins: { posix: ['amp'], win32: ['amp.exe', 'amp.cmd', 'amp'] },
    home: 'https://ampcode.com',
    // Windows is "through WSL" in Amp's own docs, so nothing is run there.
    install: {
      darwin: 'curl -fsSL https://ampcode.com/install.sh | bash',
      linux: 'curl -fsSL https://ampcode.com/install.sh | bash'
    },
    // `0.0.1789790452-gad4023`. Homebrew's `amp` is a text editor.
    identify: /^0\.0\.\d{9,}/m,
    continueArgs: ['threads', 'continue', '--last'],
    endpoints: { openrouter: false, custom: null }
  },
  /*
   * And seven more, fact-checked the same way. Kilo and Aider take an endpoint
   * per launch; the other five are launched as they are. Their own endpoint
   * routes were either a config write (Cline records the provider in
   * providers.json on every run, `-k` puts the key there in plaintext) or not
   * seen working in interactive mode, and a setting Stoke cannot honour is
   * worse than no setting.
   */
  {
    id: 'kilo',
    label: 'Kilo Code',
    vendor: 'Kilo',
    blurb: 'Open-source agent built on OpenCode. Any provider — OpenRouter, a local model, your own endpoint.',
    bins: { posix: ['kilo'], win32: ['kilo.cmd', 'kilo.exe', 'kilo'] },
    home: 'https://kilo.ai/cli',
    install: {
      darwin: 'npm install -g @kilocode/cli',
      linux: 'npm install -g @kilocode/cli',
      win32: 'npm install -g @kilocode/cli'
    },
    installNeeds: 'Node.js',
    continueArgs: ['--continue'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  {
    id: 'aider',
    label: 'Aider',
    vendor: 'Aider',
    blurb: 'The pair programmer that works in your git repo. A prompt rather than a full-screen app; any model, OpenRouter included.',
    bins: { posix: ['aider'], win32: ['aider.exe', 'aider.cmd', 'aider'] },
    home: 'https://aider.chat',
    install: {
      darwin: 'curl -LsSf https://aider.chat/install.sh | sh',
      linux: 'curl -LsSf https://aider.chat/install.sh | sh',
      win32: 'irm https://aider.chat/install.ps1 | iex'
    },
    // Aider keeps the chat in the folder; this reloads it.
    continueArgs: ['--restore-chat-history'],
    endpoints: { openrouter: true, custom: 'OpenAI Chat Completions' }
  },
  {
    id: 'crush',
    label: 'Crush',
    vendor: 'Charm',
    blurb: 'Charm’s glamorous terminal agent. Picks its models in its own settings, OpenRouter among them.',
    bins: { posix: ['crush'], win32: ['crush.exe', 'crush.cmd', 'crush'] },
    home: 'https://github.com/charmbracelet/crush',
    install: {
      darwin: 'npm install -g @charmland/crush',
      linux: 'npm install -g @charmland/crush',
      win32: 'winget install charmbracelet.crush'
    },
    installNeeds: 'Node.js (Windows uses winget)',
    endpoints: { openrouter: false, custom: null }
  },
  {
    id: 'droid',
    label: 'Droid',
    vendor: 'Factory',
    blurb: 'Factory’s agent, on your Factory account.',
    bins: { posix: ['droid'], win32: ['droid.exe', 'droid.cmd', 'droid'] },
    home: 'https://factory.ai',
    install: {
      darwin: 'curl -fsSL https://app.factory.ai/cli | sh',
      linux: 'curl -fsSL https://app.factory.ai/cli | sh',
      win32: 'npm install -g droid'
    },
    endpoints: { openrouter: false, custom: null }
  },
  {
    id: 'cline',
    label: 'Cline',
    vendor: 'Cline',
    blurb: 'The Cline agent from the editor, in the terminal. Sets up its provider in its own first run.',
    bins: { posix: ['cline'], win32: ['cline.cmd', 'cline.exe', 'cline'] },
    home: 'https://cline.bot/cli',
    install: {
      darwin: 'npm install -g cline',
      linux: 'npm install -g cline',
      win32: 'npm install -g cline'
    },
    installNeeds: 'Node.js 20 or newer',
    endpoints: { openrouter: false, custom: null }
  },
  {
    id: 'auggie',
    label: 'Auggie',
    vendor: 'Augment Code',
    blurb: 'Augment’s agent, with its codebase context engine, on your Augment account.',
    bins: { posix: ['auggie'], win32: ['auggie.cmd', 'auggie.exe', 'auggie'] },
    home: 'https://www.augmentcode.com/product/CLI',
    install: {
      darwin: 'npm install -g @augmentcode/auggie',
      linux: 'npm install -g @augmentcode/auggie',
      win32: 'npm install -g @augmentcode/auggie'
    },
    installNeeds: 'Node.js 20 or newer',
    continueArgs: ['-c'],
    endpoints: { openrouter: false, custom: null }
  },
  {
    id: 'vibe',
    label: 'Mistral Vibe',
    vendor: 'Mistral AI',
    blurb: 'Mistral’s open-source agent. Models and providers come from its own config.',
    bins: { posix: ['vibe'], win32: ['vibe.exe', 'vibe.cmd', 'vibe'] },
    home: 'https://mistral.ai/products/vibe',
    install: {
      darwin: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
      linux: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash'
    },
    continueArgs: ['-c'],
    endpoints: { openrouter: false, custom: null }
  }
]

/**
 * What Stoke may honestly draw beside a session, per CLI.
 *
 * This table is the honesty seam, and it exists because the failure it prevents
 * is silent. Every one of these surfaces reads a Claude Code artefact — the
 * statusLine payload, a `~/.claude/projects/**.jsonl` transcript, an Anthropic
 * OAuth endpoint, a Stoke-minted `--session-id`. Point a tab at another binary
 * and each of them keeps rendering, now describing a session that does not
 * exist: the ring fills from the wrong file, the plan chip states somebody
 * else's quota, and the relaunch pill offers to restart a Codex session with
 * `claude --resume`. None of those throw. A wrong number in a status bar is
 * worse than a blank one, so every capability starts at its floor and is raised
 * only when something real feeds it.
 *
 * Codex is the one with room to grow, and the growth is already mapped:
 * `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl` carries a STATED
 * `model_context_window` (which is what gotcha 2 requires — inferring a window
 * from observed usage reported 140-320% occupancy the first time it was tried),
 * a `total_token_usage` object, and `rate_limits` with `used_percent` and an
 * epoch-seconds `resets_at`. That is a ring and a plan chip from a file
 * watcher, with no wrapper and no hook. Until that watcher exists, `'none'`.
 */
export interface CliCaps {
  /** Where a context reading could come from, or `'none'` for no ring at all. */
  ring: 'statusline' | 'transcript' | 'none'
  /**
   * How a paused tab of this CLI comes back.
   *
   * `mintedId` names the exact session (Claude Code's `--session-id`, which Stoke
   * mints before launch). `continue` can only say "the most recent session in
   * this folder" — the CLI's own `continueArgs` — which is the same session
   * unless another one was started in that folder since, and the UI says so
   * rather than calling it a resume. `none` starts it fresh.
   */
  resume: 'mintedId' | 'continue' | 'none'
  /** Whether the worklog runner can review this session's work. */
  worklog: boolean
  /** Whose plan the usage chip would be describing. */
  usage: 'anthropic' | 'none'
  /** Which launcher pills mean anything. Claude's flags are Claude's. */
  launchFlags: { permissionMode: boolean; effort: boolean; model: boolean }
}

/**
 * The floor every non-Claude CLI starts from. Raising a field above it needs a
 * real source behind it, named where the raise is made.
 */
const FLOOR: CliCaps = {
  ring: 'none',
  resume: 'none',
  worklog: false,
  usage: 'none',
  launchFlags: { permissionMode: false, effort: false, model: false }
}

export const CLI_CAPS: Record<CodingCliId, CliCaps> = {
  claude: {
    ring: 'statusline',
    resume: 'mintedId',
    worklog: true,
    usage: 'anthropic',
    launchFlags: { permissionMode: true, effort: true, model: true }
  },
  /*
   * `continue` for the four below is each CLI's own flag, read from its --help
   * on 2026-09-19: `codex resume --last` (filtered to the cwd unless --all),
   * `grok --continue`, `opencode --continue`, `pi --continue`. None of them can
   * be handed a session id Stoke chose before launch the way Claude Code can,
   * so none is `mintedId`.
   */
  codex: { ...FLOOR, resume: 'continue' },
  grok: { ...FLOOR, resume: 'continue' },
  opencode: { ...FLOOR, resume: 'continue' },
  pi: { ...FLOOR, resume: 'continue' },
  // Each one's own continue flag, from its --help: `gemini --resume latest`,
  // `qwen --continue`, `kimi --continue`, `copilot --continue`,
  // `cursor-agent --continue`, `amp threads continue --last`.
  gemini: { ...FLOOR, resume: 'continue' },
  qwen: { ...FLOOR, resume: 'continue' },
  kimi: { ...FLOOR, resume: 'continue' },
  copilot: { ...FLOOR, resume: 'continue' },
  cursor: { ...FLOOR, resume: 'continue' },
  amp: { ...FLOOR, resume: 'continue' },
  // `kilo --continue`, `aider --restore-chat-history`, `auggie -c`, `vibe -c`.
  // Crush, Droid and Cline have resume flags whose meaning with no id was not
  // confirmed, so a paused tab of theirs starts fresh rather than guessing.
  kilo: { ...FLOOR, resume: 'continue' },
  aider: { ...FLOOR, resume: 'continue' },
  crush: FLOOR,
  droid: FLOOR,
  cline: FLOOR,
  auggie: { ...FLOOR, resume: 'continue' },
  vibe: { ...FLOOR, resume: 'continue' }
}

/**
 * The default, and the answer to every unparseable input.
 *
 * Claude Code rather than a null: every tab that existed before this field did
 * was a Claude tab, so a restored tab with no `cliId` IS one, and a tab with a
 * corrupted one is far better treated as the fully-instrumented case than
 * launched as some other binary on the strength of a bad string.
 */
export const DEFAULT_CLI: CodingCliId = 'claude'

export function isCodingCliId(v: unknown): v is CodingCliId {
  return typeof v === 'string' && CODING_CLIS.some((c) => c.id === v)
}

/**
 * Hydrate a stored or wire-borne cli id.
 *
 * Every field read back off disk needs one of these. `tabStore.ts` restores
 * tabs from a JSON file a user can edit and a previous version wrote, and
 * CLAUDE.md's clamp rule exists for exactly this: a field the hydrator does not
 * name comes back `undefined`, and an `undefined` cli id here would mean
 * `buildArgs` deciding what to spawn from a value nothing validated.
 */
export function cliIdOf(v: unknown): CodingCliId {
  return isCodingCliId(v) ? v : DEFAULT_CLI
}

export function cliFor(id: CodingCliId): CodingCli {
  return CODING_CLIS.find((c) => c.id === id) ?? CODING_CLIS[0]
}

export function capsFor(id: CodingCliId): CliCaps {
  return CLI_CAPS[id] ?? CLI_CAPS.claude
}

/**
 * The one question most of the main process actually wants to ask.
 *
 * Named rather than written out as `id === 'claude'` at each site, because the
 * sites are the gates around the statusLine wrapper, the transcript watcher,
 * the minted session id and the auth validation — and a missed one is not a
 * type error, it is a Codex session being handed `ANTHROPIC_API_KEY` and a
 * `--settings` file it will not understand.
 */
export function isClaudeCode(id: CodingCliId): boolean {
  return id === 'claude'
}

/** The names to look for on this platform. */
export function binNamesFor(cli: CodingCli, platform: string): readonly string[] {
  return platform === 'win32' ? cli.bins.win32 : cli.bins.posix
}

/** What a lookup found. */
export interface CodingCliStatus {
  id: CodingCliId
  /** The resolved path, or null when nothing was found. */
  path: string | null
  /**
   * A file with the agent's name that is some other program (its `--version`
   * did not match `identify`). Shown so "not installed" is not a mystery.
   */
  conflict?: string
}

/**
 * One detection pass. `probeFailed` travels with it because a miss means two
 * different things (gotcha 52): not installed, or Stoke could not read the
 * login shell's PATH — and a picker that cannot tell them apart offers to
 * reinstall a CLI the user already has.
 */
export interface CodingCliDetection {
  clis: CodingCliStatus[]
  probeFailed: boolean
}

/**
 * One line about a CLI, given what the lookup found.
 *
 * Pure so the wording is assertable, and separated from the component because
 * the interesting case is the one with no good answer: a failed login-shell
 * probe means "not found" is a statement about Stoke's PATH rather than about
 * the machine (gotcha 52), and saying "not installed" there sends someone to
 * reinstall something they already have. `probeFailed` is exactly that
 * distinction and must not be dropped.
 */
export function cliStatusLine(
  cli: CodingCli,
  status: CodingCliStatus | undefined,
  probeFailed: boolean
): string {
  if (status?.path) return status.path
  if (probeFailed) {
    return 'Not found — but Stoke could not read a login shell, so this may be a PATH problem rather than a missing install.'
  }
  return 'Not installed.'
}
