/**
 * Which of Claude Code's own settings Stoke is willing to draw, and what each
 * one may be set to.
 *
 * The CLI's settings schema has 156 top-level keys and lives only inside its
 * compiled binary — there is no published machine-readable copy — so this is a
 * hand-transcribed allowlist rather than a generated one, and it is deliberately
 * short. Every vocabulary below was read out of the 2.1.237 bundle's own zod
 * schema; see docs/superpowers/specs/2026-08-20-claude-code-settings-design.md
 * for the fragments.
 *
 * Pure, and free of `node:` imports on purpose: `src/shared/**` is compiled by
 * both tsconfigs and only the node one has Node's types, so a `node:` import
 * here fails the *web* half of typecheck while the main half stays green
 * (CLAUDE.md gotcha 27).
 */

/**
 * The value a control can hold. `undefined` is a real, distinct state — not a
 * synonym for false — and is the reason every control here is tri-state.
 *
 * `remoteControlAtStartup` is the case that proves it: absent does not mean
 * "off", it means "let the server-side rollout decide", which is exactly how
 * Remote Control came to be on without anyone choosing it.
 */
export type ClaudeSettingValue = boolean | string | number | undefined

export interface ClaudeSettingSpec {
  key: string
  /** Which heading the panel draws this under. See CLAUDE_SETTING_GROUPS. */
  group: ClaudeSettingGroup
  label: string
  /** One line, in the sheet's own voice. Says what the key does, not its type. */
  hint: string
  kind: 'boolean' | 'enum' | 'integer'
  /** For `enum`. Ordered as the picker should read. */
  options?: readonly string[]
  /** For `integer`. The CLI's own bound; below it the value is rejected. */
  min?: number
  /**
   * What the CLI does when the key is absent, stated for the reader rather
   * than used as a value. Written into the picker's "unset" row.
   */
  unsetMeans: string
  /**
   * True when an out-of-range value is silently dropped rather than rejected.
   * `.catch(void 0)` in the schema — the write appears to succeed and the
   * session ends up with no value at all, which is worse than an error.
   */
  silentlyDropsBadValues?: boolean
}

/**
 * Keys Stoke must never offer, and why, so a later addition has to argue with
 * this list rather than quietly join it.
 *
 * `statusLine` and `ultracode` are here for a reason particular to Stoke: it
 * passes `--settings`, which is `flagSettings`, and precedence runs
 * `userSettings < projectSettings < localSettings < flagSettings <
 * policySettings`. Stoke's own file therefore *outranks* whatever this panel
 * writes to ~/.claude/settings.json, so a control for either would be a switch
 * that visibly moves and changes nothing. Anything later added to Stoke's
 * session settings file has to be added here at the same time.
 */
export const NEVER_OFFERED: readonly string[] = [
  // Outranked by Stoke's own --settings file.
  'statusLine',
  'subagentStatusLine',
  'ultracode',
  // Each of these is a shell command the CLI executes.
  'apiKeyHelper',
  'proxyAuthHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'processWrapper',
  'policyHelpers',
  'fileSuggestion',
  // Trust and permission gates. A GUI that can write these can silently grant
  // trust or remove a confirmation the user has never seen.
  'permissions',
  'sandbox',
  'hasTrustDialogAccepted',
  'skipDangerousModePermissionPrompt',
  'forceLoginMethod'
]

/**
 * The headings the panel draws these under, in order.
 *
 * Fifteen tri-state rows in one flat column is a list you scan rather than
 * read: nothing tells you that the two Remote Control rows are about one
 * feature, or that `effortLevel` and `alwaysThinkingEnabled` both change how
 * the model spends a turn. The grouping is the only thing here that is Stoke's
 * opinion rather than the CLI's schema — the keys, their vocabularies and their
 * defaults are all transcribed.
 */
export const CLAUDE_SETTING_GROUPS = [
  'Appearance',
  'The model',
  'Workflows and Remote Control',
  'In the session',
  'Skills, servers and files'
] as const

export type ClaudeSettingGroup = (typeof CLAUDE_SETTING_GROUPS)[number]

/** The curated set, in the order the panel draws them. */
export const CLAUDE_SETTINGS: readonly ClaudeSettingSpec[] = [
  {
    key: 'theme',
    group: 'Appearance',
    label: 'Claude Code colour theme',
    hint: 'match Stoke follows this window automatically, including over SSH. The two -ansi themes are the only ones that use Stoke’s own 16 terminal colours.',
    kind: 'enum',
    /*
     * The CLI's own vocabulary, in its own order, read out of the 2.1.237
     * bundle: `N4s = ["dark","light","light-daltonized","dark-daltonized",
     * "light-ansi","dark-ansi"]` and `S0n = ["auto", ...N4s]`. A
     * `custom:<slug>` value naming a file in <config-dir>/themes/ is also
     * accepted and is deliberately not offered here — Stoke has no way to
     * enumerate what a user has put in that folder.
     *
     * `auto` is drawn as "Match Stoke" because that is what it does HERE, and
     * it is not a figure of speech. On `auto` the CLI queries the terminal's
     * background with OSC 11 and classifies the answer by relative luminance;
     * xterm.js 6.0.0 answers that query truthfully from the `theme.background`
     * Stoke already gives it. So the CLI follows this window with no plumbing
     * at all, and unlike anything Stoke could write per-session it works on an
     * SSH tab too, because OSC 11 is terminal I/O rather than a launch flag.
     *
     * The key lives in ~/.claude/settings.json, which the CLI's own /theme
     * picker also writes, so this control and that one cannot disagree.
     * `~/.claude.json` still has a legacy read path for it but nothing writes
     * there any more, and it is dead-ended by its own default of "dark".
     */
    options: [
      'auto',
      'dark',
      'light',
      'dark-daltonized',
      'light-daltonized',
      'dark-ansi',
      'light-ansi'
    ],
    unsetMeans: 'dark',
    // `theme: Fs([Hr(S0n), ...]).optional().catch(void 0)` — same shape as
    // effortLevel, so a value outside the list is dropped without a word.
    silentlyDropsBadValues: true
  },
  {
    key: 'remoteControlAtStartup',
    group: 'Workflows and Remote Control',
    label: 'Start Remote Control automatically',
    hint: 'off keeps sessions in this window. /remote-control and --rc still work when you ask for them.',
    kind: 'boolean',
    unsetMeans: 'Claude Code decides, and today it decides on'
  },
  {
    key: 'disableRemoteControl',
    group: 'Workflows and Remote Control',
    label: 'Disable Remote Control entirely',
    hint: 'kills claude.ai/code, --rc, auto-start and the /remote-control command itself.',
    kind: 'boolean',
    unsetMeans: 'available'
  },
  {
    key: 'disableWorkflows',
    group: 'Workflows and Remote Control',
    label: 'Disable Workflows',
    hint: 'turns off the Workflow tool that orchestrates subagents.',
    kind: 'boolean',
    unsetMeans: 'available'
  },
  {
    key: 'workflowKeywordTriggerEnabled',
    group: 'Workflows and Remote Control',
    label: 'The "ultracode" keyword trigger',
    hint: 'whether typing ultracode in a prompt opts that turn into the Workflow tool.',
    kind: 'boolean',
    unsetMeans: 'on'
  },
  {
    key: 'effortLevel',
    group: 'The model',
    label: 'Effort',
    hint: 'the reasoning effort a supported model starts at.',
    kind: 'enum',
    // Deliberately no "max": the schema is low|medium|high|xhigh and carries
    // .catch(void 0), so writing "max" leaves the session with no effort level
    // at all — silently — even though --effort max is valid everywhere else.
    options: ['low', 'medium', 'high', 'xhigh'],
    unsetMeans: "the model's own default",
    silentlyDropsBadValues: true
  },
  {
    key: 'alwaysThinkingEnabled',
    group: 'The model',
    label: 'Thinking',
    hint: 'off disables thinking. absent or on enables it for models that support it.',
    kind: 'boolean',
    unsetMeans: 'on'
  },
  {
    key: 'autoCompactEnabled',
    group: 'The model',
    label: 'Auto-compact',
    hint: 'compact the conversation automatically as the context window fills.',
    kind: 'boolean',
    unsetMeans: 'on'
  },
  {
    key: 'editorMode',
    group: 'In the session',
    label: 'Prompt key bindings',
    kind: 'enum',
    hint: 'how the prompt input behaves.',
    options: ['normal', 'vim'],
    unsetMeans: 'normal',
    silentlyDropsBadValues: true
  },
  {
    key: 'verbose',
    group: 'In the session',
    label: 'Verbose tool output',
    hint: 'show full tool output rather than truncated summaries.',
    kind: 'boolean',
    unsetMeans: 'off'
  },
  {
    key: 'autoUpdatesChannel',
    group: 'Skills, servers and files',
    label: 'CLI update channel',
    hint: 'which release stream claude updates itself from.',
    kind: 'enum',
    options: ['latest', 'stable', 'rc'],
    unsetMeans: 'latest'
  },
  {
    key: 'cleanupPeriodDays',
    group: 'Skills, servers and files',
    label: 'Keep transcripts for',
    hint: 'days before a chat transcript is cleaned up. Stoke reads these for the context meter.',
    kind: 'integer',
    min: 1,
    unsetMeans: '30 days'
  },
  {
    key: 'disableBundledSkills',
    group: 'Skills, servers and files',
    label: 'Disable bundled skills',
    hint: "removes the skills and workflows that ship with Claude Code. Plugins and .claude/skills are untouched.",
    kind: 'boolean',
    unsetMeans: 'available'
  },
  {
    key: 'enableAllProjectMcpServers',
    group: 'Skills, servers and files',
    label: 'Auto-approve project MCP servers',
    hint: 'approves every server in a project .mcp.json without asking. Consider what that runs.',
    kind: 'boolean',
    unsetMeans: 'each one is asked about'
  },
  {
    key: 'includeCoAuthoredBy',
    group: 'In the session',
    label: 'Co-authored-by on commits',
    hint: "adds Claude's attribution to commits and PRs.",
    kind: 'boolean',
    unsetMeans: 'on'
  }
]

/**
 * The dynamic-workflow size guideline, which is not in the list above because
 * it does not live in the same file.
 *
 * It is dual-homed: a valid `settings.json` key *and* a `~/.claude.json` key,
 * and they are not equivalent. `/config` writes the global config, and any
 * value in settings.json **hides the /config row entirely** — so writing the
 * settings file would take the control away from the CLI. Stoke writes the
 * global config for that reason, and pays for it with a real lock protocol.
 */
export const WORKFLOW_SIZE_KEY = 'workflowSizeGuideline'
export const WORKFLOW_SIZES = ['small', 'medium', 'large', 'unrestricted'] as const
export type WorkflowSize = (typeof WORKFLOW_SIZES)[number]

/** Roughly how many agents each guideline aims at. `q0i` in the bundle. */
export const WORKFLOW_SIZE_AGENTS: Record<string, string> = {
  small: 'fewer than 5 agents',
  medium: 'fewer than 15 agents',
  large: 'fewer than 50 agents',
  unrestricted: 'no guideline at all'
}

/** Absent means medium — `LRf = "medium"` — so unset and medium behave alike. */
export const WORKFLOW_SIZE_DEFAULT: WorkflowSize = 'medium'

const SPEC_BY_KEY = new Map(CLAUDE_SETTINGS.map((s) => [s.key, s]))

export function specFor(key: string): ClaudeSettingSpec | null {
  return SPEC_BY_KEY.get(key) ?? null
}

/**
 * Whether a value may be written for a key, and why not when it may not.
 *
 * Validation lives here rather than in the panel because the main process must
 * refuse the same values: an IPC message is not a form, and `.catch(void 0)`
 * means the CLI will not refuse a bad one on anyone's behalf.
 */
export function validateSetting(key: string, value: ClaudeSettingValue): string | null {
  if (NEVER_OFFERED.includes(key)) return `${key} is not editable from Stoke.`
  const spec = specFor(key)
  if (!spec) return `${key} is not one of the settings Stoke manages.`
  // Unset is always allowed: it is how every control returns to the CLI's own
  // default, and the only way back once a key has been written.
  if (value === undefined) return null

  if (spec.kind === 'boolean') {
    return typeof value === 'boolean' ? null : `${key} takes true or false.`
  }
  if (spec.kind === 'enum') {
    if (typeof value !== 'string') return `${key} takes one of ${spec.options?.join(', ')}.`
    return spec.options?.includes(value)
      ? null
      : `${key} does not accept "${value}" — only ${spec.options?.join(', ')}.` +
          (spec.silentlyDropsBadValues ? ' Claude Code would drop it without saying so.' : '')
  }
  // integer
  if (typeof value !== 'number' || !Number.isInteger(value)) return `${key} takes a whole number.`
  const min = spec.min ?? 1
  return value >= min ? null : `${key} must be at least ${min}.`
}

export function validateWorkflowSize(value: string | undefined): string | null {
  if (value === undefined) return null
  return (WORKFLOW_SIZES as readonly string[]).includes(value)
    ? null
    : `Workflow size must be one of ${WORKFLOW_SIZES.join(', ')}.`
}
