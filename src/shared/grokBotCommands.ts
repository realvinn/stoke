import type { GrokBotOperation } from './grokBot.ts'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /^-/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Choose a valid bot, group, skill or request ID.')
  return value
}
function field(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`Enter text up to ${maximum} characters.`)
  return value
}
function name(value: unknown): string {
  const result = field(value, 100).trim()
  if (!result || /[\r\n\t]/.test(result)) throw new Error('Enter a name up to 100 characters.')
  return result
}
function members(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) throw new Error('Choose between 1 and 6 member bots.')
  return [...new Set(value.map(id))]
}
/** Closed command list. User text is argv data, never a shell or arbitrary CLI command. */
export function grokBotCommand(raw: GrokBotOperation): { argv: string[]; gateway: boolean; markdown?: string } {
  if (!record(raw)) throw new Error('Choose a Grok Bot action.')
  if (raw.targetKind !== undefined && !['bot', 'group'].includes(raw.targetKind)) throw new Error('Choose a bot or group.')
  const category = raw.targetKind === 'group' ? 'groups' : 'bots'
  let argv: string[]
  switch (raw.kind) {
    case 'list': argv = ['bots', 'list']; break
    case 'desktop': argv = []; break
    case 'thread': {
      const limit = raw.limit ?? 40
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Read between 1 and 200 recent messages.')
      argv = ['thread', '--no-history', `--limit=${limit}`, '--', id(raw.target)]; break
    }
    case 'send': {
      const message = field(raw.message, 32 * 1024)
      if (!message.trim()) throw new Error('Enter a message.')
      argv = ['send', '--no-history', '--', id(raw.target), message]; break
    }
    case 'get': case 'delete': argv = [category, raw.kind, '--', id(raw.target)]; break
    case 'create': case 'update': {
      argv = [category, raw.kind]
      if (raw.kind === 'create' || raw.name !== undefined) argv.push(`--name=${name(raw.name)}`)
      if (raw.description !== undefined) argv.push(`--description=${field(raw.description, 16 * 1024)}`)
      if (raw.title !== undefined) argv.push(`--title=${field(raw.title, 256)}`)
      for (const key of ['notify', 'hidden'] as const) if (raw[key] !== undefined) {
        if (raw.kind !== 'update' || typeof raw[key] !== 'boolean') throw new Error('Choose a valid profile setting.')
        argv.push(`--${key}=${raw[key] ? 'on' : 'off'}`)
      }
      if (raw.kind === 'create' && category === 'groups') for (const member of members(raw.members)) argv.push(`--member=${member}`)
      if (raw.kind === 'update') {
        if (argv.length === 2) throw new Error('Choose a profile field to update.')
        argv.push('--', id(raw.target))
      }
      break
    }
    case 'members-set': argv = ['groups', 'set', ...members(raw.members).map(member => `--member=${member}`), '--', id(raw.target)]; break
    case 'skills': argv = ['skills', 'list']; break
    case 'skill-remove': argv = ['skills', 'remove', '--', id(raw.target)]; break
    case 'skill-add': {
      const markdown = field(raw.markdown, 100000)
      if (!markdown.trim()) throw new Error('Enter the SKILL.md contents.')
      return { argv: ['skills', 'add'], gateway: true, markdown }
    }
    case 'approvals': return { argv: ['approvals', 'list', '--', id(raw.target)], gateway: false }
    case 'approval-respond': {
      if (!['accept', 'decline'].includes(raw.decision!)) throw new Error('Choose Allow once or Deny.')
      return { argv: ['approvals', 'respond', `--target=${id(raw.target)}`, `--entry-id=${id(raw.entryId)}`, `--request-id=${id(raw.requestId)}`, `--decision=${raw.decision}`], gateway: false }
    }
    default: throw new Error('Choose a supported Grok Bot action.')
  }
  return { argv, gateway: true }
}
