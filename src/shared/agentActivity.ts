/** Portable activity telemetry. Unknown is distinct from an idle agent. */
export interface AgentActivity {
  status: 'busy' | 'waiting' | 'idle'
  at: number
}

/** SSH has no local registry. Inspect visible agent footer controls only. */
export function screenActivity(text: string): AgentActivity['status'] | null {
  const footer = text.trimEnd().split('\n').slice(-10).join('\n')
  const question = /(?:Do you want to (?:proceed|allow)|Would you like to (?:run|make)|Allow (?:this|once)|Enter to (?:confirm|submit|select))/i.test(footer)
  const choices = /(?:\b1[.)]\s*(?:Yes|Allow)|\b2[.)]\s*(?:No|Deny)|Esc to cancel)/i.test(footer)
  // A visible interrupt control means work continues, even with a follow-up panel.
  if (/(?:esc|escape)\s+to\s+(?:interrupt|stop)/i.test(footer)) return 'busy'
  if (question && choices) return 'waiting'
  return null
}
