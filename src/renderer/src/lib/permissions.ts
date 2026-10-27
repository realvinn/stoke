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
  /*
   * Not "Ask". This sends no --permission-mode at all, so the session runs in
   * whatever `permissions.defaultMode` the user's own settings name — `auto` on
   * the machine the QA ran on, while this button said "Ask" and its hint said
   * "Claude asks before each tool use" (QA L11). The launcher shows the resolved
   * mode beside it; this label only has to stop claiming one.
   */
  {
    id: 'default',
    label: 'Default',
    hint: "Sends no flag: Claude Code's own default mode applies (your settings.json's permissions.defaultMode, else it asks)."
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
 * `--settings` at launch (see main/cli.ts) rather than as a flag. It runs at the
 * effort picked beside it; only a Claude Code older than
 * ULTRACODE_ANY_EFFORT_SINCE has its effort pinned (`ultracodePinsEffort`).
 */
export const ULTRACODE_HINT =
  'Standing dynamic-workflow orchestration, at whatever effort you pick. Needs workflows enabled.'

/** Model aliases the CLI accepts; the list lives in shared/launch.ts with its provenance. */
export { MODEL_OPTIONS } from '@shared/launch'
