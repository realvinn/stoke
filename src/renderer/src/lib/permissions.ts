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

/** Model aliases the CLI accepts. An empty id means "whatever is configured". */
export const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' }
]
