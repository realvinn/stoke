import type { SshHost } from './types.ts'
/** Literal addresses only: no options, userinfo, ports or DNS names. */
export function sshDirectIp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const text = value.trim().replace(/^\[([a-f0-9:]+)\]$/i, '$1')
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text))
    return text.split('.').every((part) => Number(part) <= 255) ? text : null
  if (!/^[a-f0-9:]+$/i.test(text) || (text.match(/:/g)?.length ?? 0) < 2) return null
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1)
  } catch {
    return null
  }
}
export function isTailnetIp(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  return (
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || ip.toLowerCase().startsWith('fd7a:115c:a1e0:')
  )
}
export interface SshMergeGroup {
  members: { id: string; alias: string; snapshot: string }[]
  fallbackAlias?: string | null
  preferredAddress: string | null
  reason: string
}
export function applySshMerge(hosts: readonly SshHost[], group: SshMergeGroup): SshHost[] {
  if (group.members.length < 2) throw new Error('Choose duplicate SSH routes.')
  const members = group.members.map((member) => hosts.find((host) => host.id === member.id))
  if (members.some((host, index) => !host || JSON.stringify(host) !== group.members[index].snapshot))
    throw new Error('These hosts changed. Find duplicate routes again.')
  const first = members[0]!,
    removed = new Set(group.members.slice(1).map((member) => member.id))
  const fallback = group.fallbackAlias ?? first.alias
  if (!members.some(host => host!.alias === fallback)) throw new Error('Choose one of the verified SSH aliases as fallback.')
  const aliases = [
    ...new Set(members.flatMap((host) => [host!.alias, ...(host!.mergedAliases ?? [])]))
  ].filter((alias) => alias !== fallback)
  return hosts
    .filter((host) => !removed.has(host.id))
    .map((host) =>
      host.id === first.id
        ? {
            ...host,
            alias: fallback,
            mergedAliases: aliases,
            ...(group.preferredAddress ? { preferredAddress: group.preferredAddress } : {})
          }
        : host
    )
}

/** One paired machine owns its explicitly linked routes, direct IP first. */
export function linkedSshRoutes(hosts: readonly SshHost[], device: string): SshHost[] {
  const priority = (host: SshHost): number => {
    const ip = sshDirectIp(host.preferredAddress) ?? sshDirectIp(host.alias.split('@').at(-1))
    return ip ? (isTailnetIp(ip) ? 2 : 0) : 1
  }
  return hosts.filter((host) => host.remoteDeviceId === device).sort((a, b) => priority(a) - priority(b))
}
