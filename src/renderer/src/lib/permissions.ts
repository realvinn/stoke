import type { EffortLevel, PermissionMode } from '@shared/types'

export interface ModeOption {
  id: PermissionMode
  label: string
  hint: string
  danger?: boolean
}

/**
 * The subset of `claude --permission-mode` worth a one-click control, in
 * increasing order of autonomy. `manual` and `dontAsk` are omitted from the
 * quick switcher but remain valid in the type.
 */
export const PERMISSION_MODES: ModeOption[] = [
  {
    id: 'default',
    label: 'Ask',
    hint: 'Claude asks before each tool use. The standard Claude Code behaviour.'
  },
  {
    id: 'plan',
    label: 'Plan',
    hint: 'Research and propose an approach without touching any files.'
  },
  {
    id: 'acceptEdits',
    label: 'Edits',
    hint: 'File edits apply automatically. Other tools still ask.'
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Claude decides when to ask, based on how risky the action is.'
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass',
    hint: 'Skips every permission check. Use only in directories you trust.',
    danger: true
  }
]

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask',
  plan: 'Plan',
  acceptEdits: 'Auto-edit',
  auto: 'Auto',
  bypassPermissions: 'Bypass'
}

export const EFFORT_LEVELS: { id: EffortLevel; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]

export function effortLabel(id: EffortLevel): string {
  return EFFORT_LEVELS.find((e) => e.id === id)?.label ?? id
}

/**
 * Ultracode is not a sixth effort level, however much it looks like one sitting
 * next to them. `--effort` accepts only low/medium/high/xhigh/max; ultracode is a
 * boolean the CLI reads out of its settings, which is why Stoke passes it through
 * `--settings` at launch (see main/cli.ts) rather than as a flag.
 */
export const ULTRACODE_EFFORT: EffortLevel = 'xhigh'

export const ULTRACODE_HINT =
  'Extra-high effort plus standing dynamic-workflow orchestration. Needs workflows enabled and a model that can run at extra-high effort.'

/**
 * What the session will really run at. Ultracode wins, but not because it beats
 * the effort flag — it loses to it, and loses by silently switching itself off
 * (see main/cli.ts). Stoke therefore launches an ultracode session pinned to
 * xhigh, and the picker reports that rather than showing a value the session is
 * not using.
 */
export function effectiveEffort(effort: EffortLevel, ultracode: boolean): EffortLevel {
  return ultracode ? ULTRACODE_EFFORT : effort
}

/** Model aliases the CLI accepts. An empty id means "whatever is configured". */
export const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' }
]
