/**
 * What a launch will actually run with, and where each value came from.
 *
 * The launcher used to say "Ask · Default · Default effort" while the session it
 * started said `auto mode on` and `Opus 5 (1M context)`: Stoke's "default" means
 * "send no flag", and with no flag the CLI reads the user's own
 * `~/.claude/settings.json` (and the project's). The label described the flag,
 * not the session (QA L11). So every value on the launcher is resolved through
 * the same layers the CLI reads, and the chip says which layer won.
 *
 * Three layers, highest first:
 *   1. this launch   — a chip changed on this New tab only (QA L10)
 *   2. Stoke default — `settings.defaults`, the "Make default" target
 *   3. Claude Code   — the CLI's own settings files, when Stoke sends no flag
 * and below them the CLI's built-in behaviour, which Stoke cannot see and so
 * never names.
 *
 * Pure: main reads the files (`readLaunchDefaults`), the renderer draws the
 * result, and `verify:launcher` holds the precedence.
 */
import type { EffortLevel, PermissionMode } from './types'

/**
 * Model aliases the CLI accepts. An empty id sends no `--model`.
 *
 * The `[1m]` variants are in the CLI's own alias list, read out of the 2.1.278
 * binary rather than guessed: `["sonnet","opus","haiku","fable","best",
 * "sonnet[1m]","opus[1m]","fable[1m]","opusplan"]`, and its model picker writes
 * `opus[1m]` into settings.json itself. `haiku[1m]` is not in that list.
 */
export const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'opus[1m]', label: 'Opus 1M' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
  { id: 'fable[1m]', label: 'Fable 1M' }
]

/**
 * A readable name for any model value — an alias from the list above, or a full
 * id a user typed into settings.json (`claude-opus-5[1m]`).
 */
export function modelLabel(id: string): string {
  const known = MODEL_OPTIONS.find((m) => m.id === id)
  if (known) return known.label
  const oneM = /\[1m\]$/i.test(id)
  const base = id.replace(/\[1m\]$/i, '').replace(/^claude-/, '')
  const pretty = base
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
  return oneM ? `${pretty} 1M` : pretty
}

export const MODE_LABELS: Record<string, string> = {
  default: 'Ask',
  manual: 'Ask',
  plan: 'Plan',
  acceptEdits: 'Edits',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass'
}

export const EFFORT_LABELS: Record<string, string> = {
  default: 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** Ultracode pins the session to this effort (see main/cli.ts buildArgs). */
export const ULTRACODE_EFFORT: EffortLevel = 'xhigh'

/**
 * The three values the CLI would use with no flag, read out of its settings
 * files. Null means no file sets it, which leaves the CLI's built-in default —
 * a value Stoke does not know and must not invent.
 */
export interface ClaudeLaunchDefaults {
  permissionMode: string | null
  model: string | null
  /** The top-level `effortLevel`. A per-model entry below beats it for that model. */
  effort: string | null
  /**
   * `modelSettings.<model id>.effortLevel`, merged across the files. The CLI's
   * own /effort writes here, per model version, and it OUTRANKS the top-level
   * key: on the machine the QA ran on, `effortLevel: "high"` sat beside
   * `modelSettings["claude-opus-5"].effortLevel: "medium"` and the session
   * banner said "with medium effort". Reading only the top-level key made the
   * chip say High — the exact disagreement QA L11 was about. Measured, then
   * confirmed in the CLI's own settings schema.
   */
  modelEffort: Record<string, string>
  /** Which file each value came from, for the chip's tooltip. */
  from: { permissionMode: string | null; model: string | null; effort: string | null; modelEffort: string | null }
}

export const NO_CLAUDE_DEFAULTS: ClaudeLaunchDefaults = {
  permissionMode: null,
  model: null,
  effort: null,
  modelEffort: {},
  from: { permissionMode: null, model: null, effort: null, modelEffort: null }
}

/** `opus[1m]` -> `opus`; `claude-opus-5[1m]` -> `opus` with id `claude-opus-5`. */
function familyOf(model: string): { family: string; id: string | null } {
  const base = model.replace(/\[1m\]$/i, '').trim().toLowerCase()
  if (base.startsWith('claude-')) return { family: base.split('-')[1] ?? base, id: base }
  return { family: base, id: null }
}

/**
 * The per-model effort that applies to `model`, if Stoke can tell.
 *
 *  - no per-model entries at all: nothing to apply (`value: null, known: true`),
 *    so the top-level key decides;
 *  - a full model id: its own entry, or none;
 *  - an alias (`opus`, `opus[1m]`): the entries of that family. One entry — or
 *    several that agree — is taken as the answer; entries that disagree mean
 *    it depends on which version the alias resolves to, which only the CLI
 *    knows, so `known: false` and the chip names no level;
 *  - no model at all (the account default) with entries present: unknown.
 */
export function effortForModel(
  model: string | null,
  table: Record<string, string>
): { value: string | null; known: boolean; key: string | null } {
  const keys = Object.keys(table)
  if (!keys.length) return { value: null, known: true, key: null }
  if (!model) return { value: null, known: false, key: null }
  const { family, id } = familyOf(model)
  if (id) {
    const hit = keys.find((k) => familyOf(k).id === id)
    return hit ? { value: table[hit], known: true, key: hit } : { value: null, known: true, key: null }
  }
  const same = keys.filter((k) => familyOf(k).family === family)
  if (!same.length) return { value: null, known: true, key: null }
  const values = [...new Set(same.map((k) => table[k]))]
  return values.length === 1
    ? { value: values[0], known: true, key: same.join(', ') }
    : { value: null, known: false, key: same.join(', ') }
}

/** One parsed settings file, lowest precedence first when passed as a list. */
export interface SettingsLayer {
  /** Shown in a tooltip, e.g. `~/.claude/settings.json`. */
  name: string
  values: Record<string, unknown> | null
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Fold the CLI's settings files into what it would launch with.
 *
 * `layers` runs lowest precedence first (user, then project, then local), so a
 * later layer overrides an earlier one key by key — the CLI's own merge. The
 * permission mode lives at `permissions.defaultMode`; `model` and
 * `effortLevel` are top-level. `ANTHROPIC_MODEL` — inherited, or from a file's
 * `env` block — beats every file's `model`, as it does in the CLI.
 *
 * An effort outside the CLI's list is ignored rather than shown: the CLI drops
 * it silently (gotcha 39 — `effortLevel: max` in settings.json is dropped), so
 * showing it would name a value the session does not run at.
 */
export function resolveClaudeDefaults(
  layers: SettingsLayer[],
  env: { ANTHROPIC_MODEL?: string } = {}
): ClaudeLaunchDefaults {
  const out: ClaudeLaunchDefaults = {
    permissionMode: null,
    model: null,
    effort: null,
    modelEffort: {},
    from: { permissionMode: null, model: null, effort: null, modelEffort: null }
  }
  let settingsEnvModel: string | null = null
  let settingsEnvFrom: string | null = null
  for (const layer of layers) {
    const v = layer.values
    if (!v) continue
    const perms = v.permissions
    if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
      const mode = (perms as Record<string, unknown>).defaultMode
      if (typeof mode === 'string' && mode in MODE_LABELS) {
        out.permissionMode = mode
        out.from.permissionMode = layer.name
      }
    }
    if (typeof v.model === 'string' && v.model.trim()) {
      out.model = v.model.trim()
      out.from.model = layer.name
    }
    if (typeof v.effortLevel === 'string' && EFFORTS.has(v.effortLevel) && v.effortLevel !== 'max') {
      out.effort = v.effortLevel
      out.from.effort = layer.name
    }
    const envBlock = v.env
    if (envBlock && typeof envBlock === 'object' && !Array.isArray(envBlock)) {
      const m = (envBlock as Record<string, unknown>).ANTHROPIC_MODEL
      if (typeof m === 'string' && m.trim()) {
        settingsEnvModel = m.trim()
        settingsEnvFrom = `${layer.name} (env.ANTHROPIC_MODEL)`
      }
    }
    const per = v.modelSettings
    if (per && typeof per === 'object' && !Array.isArray(per)) {
      for (const [id, entry] of Object.entries(per as Record<string, unknown>)) {
        const level = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).effortLevel : undefined
        if (typeof level === 'string' && EFFORTS.has(level) && level !== 'max') {
          out.modelEffort[id] = level
          out.from.modelEffort = layer.name
        }
      }
    }
  }
  /*
   * `ANTHROPIC_MODEL` outranks `model` in every file. The CLI copies a settings
   * file's `env` block into its own environment at startup, so one set there
   * counts as well, and — being applied over what it inherited — beats the
   * variable Stoke's own environment carries. The chip ignored the `env` block,
   * and named the file's `model` for a session that ran another.
   */
  const envModel = settingsEnvModel ?? env.ANTHROPIC_MODEL?.trim()
  if (envModel) {
    out.model = envModel
    out.from.model = settingsEnvModel ? settingsEnvFrom : 'ANTHROPIC_MODEL'
  }
  return out
}

/** A launch's choices, as Stoke will send them. Empty/`default` sends no flag. */
export interface LaunchChoice {
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  ultracode: boolean
}

/** What one New tab changed for its own launch only. */
export type LaunchOverride = Partial<LaunchChoice>

/** Where a resolved value came from. */
export type LaunchSource = 'launch' | 'stoke' | 'claude' | 'cli'

export interface ResolvedValue<T> {
  /** What Stoke passes to the CLI — the choice itself. */
  choice: T
  /** What the session will run with, as far as Stoke can know. Null: the CLI's own default. */
  effective: string | null
  /** The chip's text. */
  label: string
  source: LaunchSource
  /** True when this launch differs from the Stoke default (the "changed" dot). */
  changed: boolean
}

export interface ResolvedLaunch {
  permissionMode: ResolvedValue<PermissionMode>
  model: ResolvedValue<string>
  effort: ResolvedValue<EffortLevel> & {
    /** What the settings files give THIS launch's model with no flag; null when unset or unknowable. */
    settingsValue: string | null
    /** Where that came from, e.g. `~/.claude/settings.json (modelSettings.claude-opus-5)`. */
    settingsFrom: string | null
  }
  ultracode: { choice: boolean; source: LaunchSource; changed: boolean }
  /** The full choice to hand to startSession. */
  choice: LaunchChoice
}

/**
 * Resolve every launch value through the three layers.
 *
 * `source` is `launch` when this tab overrides the default, `stoke` when the
 * Stoke default sends a flag, `claude` when no flag is sent and a CLI settings
 * file decides, `cli` when nothing does. Ultracode forces effort to xhigh and
 * the effort chip says so rather than showing a value the session does not
 * use.
 */
export function resolveLaunch(input: {
  override: LaunchOverride | undefined
  stoke: LaunchChoice
  claude: ClaudeLaunchDefaults
}): ResolvedLaunch {
  const o = input.override ?? {}
  const s = input.stoke
  const c = input.claude
  const choice: LaunchChoice = {
    permissionMode: o.permissionMode ?? s.permissionMode,
    model: o.model ?? s.model,
    effort: o.effort ?? s.effort,
    ultracode: o.ultracode ?? s.ultracode
  }
  const srcOf = (key: keyof LaunchChoice, sendsFlag: boolean, claudeValue: string | null): LaunchSource =>
    o[key] !== undefined && o[key] !== s[key]
      ? 'launch'
      : sendsFlag
        ? 'stoke'
        : claudeValue !== null
          ? 'claude'
          : 'cli'

  // Mode: `default` sends no flag, so the CLI's defaultMode applies.
  const modeFlag = choice.permissionMode !== 'default'
  const modeEffective = modeFlag ? choice.permissionMode : c.permissionMode
  const modeSource = srcOf('permissionMode', modeFlag, c.permissionMode)
  const modeLabel = modeEffective ? (MODE_LABELS[modeEffective] ?? modeEffective) : 'Ask'

  const modelFlag = choice.model !== ''
  const modelEffective = modelFlag ? choice.model : c.model
  const modelSource = srcOf('model', modelFlag, c.model)
  const modelText = modelEffective ? modelLabel(modelEffective) : 'Default model'

  const effortFlag = choice.ultracode || choice.effort !== 'default'
  // With no flag, a per-model entry for the model this launch runs beats the
  // top-level key; an entry Stoke cannot pin to a version leaves it unnamed.
  const perModel = effortForModel(modelEffective, c.modelEffort)
  const settingsEffort = perModel.value ?? (perModel.known ? c.effort : null)
  const effortEffective = choice.ultracode
    ? ULTRACODE_EFFORT
    : choice.effort !== 'default'
      ? choice.effort
      : settingsEffort
  const effortSource = choice.ultracode
    ? srcOf('ultracode', true, null)
    : srcOf('effort', effortFlag, settingsEffort)
  const effortText = effortEffective ? `${EFFORT_LABELS[effortEffective] ?? effortEffective} effort` : 'Default effort'

  return {
    permissionMode: {
      choice: choice.permissionMode,
      effective: modeEffective,
      label: modeLabel,
      source: modeSource,
      changed: choice.permissionMode !== s.permissionMode
    },
    model: {
      choice: choice.model,
      effective: modelEffective,
      label: modelText,
      source: modelSource,
      changed: choice.model !== s.model
    },
    effort: {
      choice: choice.effort,
      effective: effortEffective,
      label: effortText,
      source: effortSource,
      changed: choice.effort !== s.effort,
      settingsValue: settingsEffort,
      settingsFrom: perModel.value
        ? `${c.from.modelEffort ?? 'settings'} (modelSettings.${perModel.key})`
        : !perModel.known
          ? `${c.from.modelEffort ?? 'settings'}: modelSettings sets effort per model version (${perModel.key ?? 'unknown model'}), and which version this model resolves to is the CLI's call`
          : c.from.effort
    },
    ultracode: {
      choice: choice.ultracode,
      source: o.ultracode !== undefined && o.ultracode !== s.ultracode ? 'launch' : 'stoke',
      changed: choice.ultracode !== s.ultracode
    },
    choice
  }
}

/**
 * Drop the keys that equal the Stoke default, so a tab whose chips were moved
 * away and back reads as unchanged and "Make default" has nothing to write.
 */
export function pruneOverride(o: LaunchOverride, stoke: LaunchChoice): LaunchOverride | undefined {
  const out: LaunchOverride = {}
  let any = false
  for (const k of Object.keys(o) as (keyof LaunchChoice)[]) {
    if (o[k] === undefined || o[k] === stoke[k]) continue
    ;(out as Record<string, unknown>)[k] = o[k]
    any = true
  }
  return any ? out : undefined
}

/**
 * The permission mode a RUNNING session is in, for the status bar's pill, or
 * null when Stoke cannot know yet (show nothing: a blank is not a claim).
 *
 *   reported      the latest `permission-mode` record in its transcript, or
 *                 null while none has been seen. The session's own word, so
 *                 it wins — including `default`, which is what Shift+Tab to
 *                 Ask writes.
 *   launched      what Stoke passed; `default` means no flag was sent.
 *   claudeDefault the folder's `permissions.defaultMode` from Claude Code's
 *                 settings files: a mode, null when no file sets one, or
 *                 undefined while that answer has not arrived.
 *
 * The pill substituted the settings default whenever the TAB said `default`,
 * which cannot tell "launched with no flag, nothing reported yet" from "the
 * transcript reported default": a session switched to Ask read "Auto" (review
 * of QA L11). The settings default applies only to the first.
 */
export function sessionMode(input: {
  reported: string | null
  launched: PermissionMode
  claudeDefault: string | null | undefined
}): string | null {
  if (input.reported) return input.reported
  if (input.launched !== 'default') return input.launched
  if (input.claudeDefault === undefined) return null
  return input.claudeDefault ?? 'default'
}

/** Plain words for a source, for the chip tooltip. */
export function sourceText(source: LaunchSource, file: string | null): string {
  switch (source) {
    case 'launch':
      return 'Changed for this launch only'
    case 'stoke':
      return "Stoke's default, sent as a flag"
    case 'claude':
      return `No flag sent: Claude Code reads this from ${file ?? 'its settings'}`
    case 'cli':
      return "No flag sent, and no settings file sets it: Claude Code's built-in default"
  }
}
