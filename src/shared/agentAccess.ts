import { isCodingCliId, type CodingCliId } from './codingClis.ts'

/** Launch-scoped CLI permissions. These never grant OS administrator privileges. */
export type AgentAccessMode = 'default' | 'read-only' | 'workspace' | 'full-access' | 'accept-edits' | 'plan' | 'yolo' | 'auto'

export interface AgentAccessOption {
  id: AgentAccessMode
  label: string
  hint: string
  args: readonly string[]
  danger?: boolean
}

const DEFAULT: AgentAccessOption = { id: 'default', label: 'Agent default', hint: 'Use the agent’s own permission settings.', args: [] }

/* Confirmed in vendor CLI references on 2026-10-08. Keep global flags before
 * resume subcommands. Default adds nothing; deny rules and organization policy
 * remain the vendor's responsibility. Never infer a flag from another CLI.
 * Codex: learn.chatgpt.com/docs/developer-commands (also installed --help)
 * Cursor: prod.cursor.com/docs/cli/reference/parameters
 * Gemini: github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md
 * Copilot: docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot
 * Kimi: kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html
 * Aider: aider.chat/docs/config/options.html
 */
const OPTIONS: Partial<Record<CodingCliId, readonly AgentAccessOption[]>> = {
  // docs.x.ai/build/cli/reference; sandbox is independent of this flag.
  grok: [{ id: 'yolo', label: 'Always approve', hint: 'Approve tool calls automatically; deny rules, hooks and sandbox settings still apply.', args: ['--always-approve'], danger: true }],
  // docs.opencode.ai/docs/permissions and kilo.ai/docs/code-with-ai/platforms/cli-reference
  opencode: [{ id: 'yolo', label: 'Auto approve', hint: 'Approve permission requests automatically; explicit deny rules still apply.', args: ['--auto'], danger: true }],
  kilo: [{ id: 'yolo', label: 'Auto approve', hint: 'Approve permission requests automatically; explicit deny rules still apply.', args: ['--auto'], danger: true }],
  // qwenlm.github.io/qwen-code-docs/en/users/features/headless/
  qwen: [{ id: 'yolo', label: 'YOLO', hint: 'Approve all tools automatically; this does not enable a sandbox.', args: ['--approval-mode', 'yolo'], danger: true }],
  codex: [
    { id: 'read-only', label: 'Read only', hint: 'Read-only sandbox; approval on request.', args: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'] },
    { id: 'workspace', label: 'Workspace', hint: 'Write inside the workspace; approval on request.', args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] },
    { id: 'full-access', label: 'Full access', hint: 'Disable the sandbox; keep approval on request.', args: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request'], danger: true },
    { id: 'yolo', label: 'YOLO', hint: 'Disable sandboxing and approval prompts for this launch.', args: ['--dangerously-bypass-approvals-and-sandbox'], danger: true }
  ],
  cursor: [
    { id: 'plan', label: 'Plan', hint: 'Start the agent in plan mode.', args: ['--mode', 'plan'] },
    { id: 'workspace', label: 'Sandbox', hint: 'Enable Cursor’s command sandbox.', args: ['--sandbox', 'enabled'] },
    { id: 'full-access', label: 'Full access', hint: 'Disable the command sandbox; keep configured permissions.', args: ['--sandbox', 'disabled'], danger: true },
    { id: 'yolo', label: 'YOLO', hint: 'Disable the sandbox and allow commands unless explicitly denied.', args: ['--sandbox', 'disabled', '--force'], danger: true }
  ],
  gemini: [
    { id: 'accept-edits', label: 'Accept edits', hint: 'Approve file edits automatically; ask for other tools.', args: ['--approval-mode', 'auto_edit'] },
    { id: 'yolo', label: 'YOLO', hint: 'Automatically approve tool calls; existing sandbox settings still apply.', args: ['--approval-mode', 'yolo'], danger: true }
  ],
  copilot: [
    { id: 'yolo', label: 'YOLO', hint: 'Allow all tools, paths and URLs without permission prompts.', args: ['--allow-all'], danger: true }
  ],
  kimi: [
    { id: 'plan', label: 'Plan', hint: 'Prioritize read-only exploration and planning.', args: ['--plan'] },
    { id: 'yolo', label: 'Ask when needed', hint: 'Approve routine edits and commands; risky actions still ask.', args: ['--yolo'], danger: true },
    { id: 'auto', label: 'Never ask', hint: 'Run and decide automatically without interrupting you.', args: ['--auto'], danger: true }
  ],
  aider: [
    { id: 'yolo', label: 'Always yes', hint: 'Answer yes to every confirmation.', args: ['--yes-always'], danger: true }
  ]
}

export function agentAccessOptions(id: CodingCliId): readonly AgentAccessOption[] {
  return [DEFAULT, ...(OPTIONS[id] ?? [])]
}

export function agentAccessOption(id: CodingCliId, mode: unknown): AgentAccessOption | undefined {
  return agentAccessOptions(id).find((option) => option.id === mode)
}

export function hydrateAgentAccess(raw: unknown): Partial<Record<CodingCliId, AgentAccessMode>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Partial<Record<CodingCliId, AgentAccessMode>> = {}
  for (const [id, mode] of Object.entries(raw)) {
    if (!isCodingCliId(id) || mode === 'default') continue
    const option = agentAccessOption(id, mode)
    if (option) out[id] = option.id
  }
  return out
}
