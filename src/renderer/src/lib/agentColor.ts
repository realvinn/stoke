import type { CSSProperties } from 'react'
import { agentTokenNames, type AgentColorKey } from '@shared/agentColors'

/**
 * Mark a surface as belonging to one agent: `data-agent` for the stylesheet to
 * select on, and `--agent-ink` / `--agent-text` / `--agent-fill` pointed at that
 * agent's tokens.
 *
 * The mapping is inline rather than one `[data-agent='codex']` rule per agent
 * in app.css, so a new key needs no stylesheet change — a new agent in the
 * table, or later an account (`claude-work`), is coloured as soon as
 * `applyAppearance` writes its tokens. Only `var()` references travel here; the
 * colours themselves are written once, on `:root`, by `applyAppearance`.
 *
 * Nothing shows until `:root[data-agent-paint]` is set (more than one agent in
 * view): every rule that reads these tokens is scoped under it.
 */
export function agentMark(key: AgentColorKey | null | undefined): { 'data-agent'?: string; style?: CSSProperties } {
  if (!key) return {}
  const t = agentTokenNames(key)
  return {
    'data-agent': key,
    style: {
      '--agent-ink': `var(${t.ink})`,
      '--agent-text': `var(${t.text})`,
      '--agent-fill': `var(${t.fill})`
    } as CSSProperties
  }
}

/**
 * The agent a pane is marked with: the tab's own, except on a tab that runs a
 * shell for Stoke — installing agents, or enrolling an SSH key — which belongs
 * to no agent.
 */
export function paneAgent(tab: { cliId: string; installing?: readonly string[]; enrollHostId?: string }): string | null {
  return tab.installing?.length || tab.enrollHostId ? null : tab.cliId
}
