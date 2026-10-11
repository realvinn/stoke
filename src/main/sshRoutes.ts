import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { sshDirectIp, isTailnetIp, type SshMergeGroup } from '../shared/sshRoutes.ts'
import type { SshHost } from '../shared/types.ts'
interface Config {
  hostname: string
  port: number
  proxy: boolean
  signature: string
}
function resolved(stdout: string): Config | null {
  const fields = new Map<string, string[]>()
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf(' ')
    if (at > 0) {
      const key = line.slice(0, at).toLowerCase()
      fields.set(key, [...(fields.get(key) ?? []), line.slice(at + 1).trim()])
    }
  }
  const hostname = fields.get('hostname')?.[0],
    port = Number(fields.get('port')?.[0])
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const keys = [...fields.keys()].filter((key) => key !== 'host' && key !== 'hostname').sort()
  return {
    hostname,
    port,
    proxy: ['proxyjump', 'proxycommand'].some(
      (key) => fields.has(key) && fields.get(key)?.some((value) => value !== 'none')
    ),
    signature: JSON.stringify(keys.map((key) => [key, fields.get(key) ?? []]))
  }
}
function output(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(
      exe,
      args,
      { encoding: 'utf8', timeout: 4000, maxBuffer: 256 * 1024, windowsHide: true, env, signal },
      (error, stdout) => resolve(error ? null : stdout)
    )
  )
}
function tcp(ip: string, port: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const socket = createConnection({ host: ip, port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolve(ok)
    }
    const abort = (): void => finish(false)
    socket.setTimeout(1200)
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    signal?.addEventListener('abort', abort, { once: true })
  })
}
/** A route probe never logs in, runs a remote command, or retries authentication. */
export async function prepareSshRoute(
  args: string[],
  executable: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string[]> {
  const at = args.findIndex((arg, index) => args[index - 1] === '-o' && arg.startsWith('Hostname='))
  if (at < 0) return args
  const ip = sshDirectIp(args[at].slice(9))
  if (!ip) throw new Error('The preferred SSH address must be a literal IP.')
  const without = [...args]
  without.splice(at - 1, 2)
  let destination = ''
  const valueOptions = new Set(['-o', '-e', '-p', '-i', '-F', '-l', '-J'])
  for (let index = 0; index < without.length; index++) {
    if (valueOptions.has(without[index])) {
      index++
      continue
    }
    if (without[index] === '--') {
      destination = without[index + 1] ?? ''
      break
    }
    if (!without[index].startsWith('-')) {
      destination = without[index]
      break
    }
  }
  if (!destination || /^-/.test(destination)) return without
  const text = await output(executable, ['-G', destination], env, signal),
    config = text ? resolved(text) : null
  if (signal?.aborted) throw new Error('The SSH route selection stopped.')
  // A configured jump host may reach an IP the local machine cannot probe.
  if (!config || config.proxy) return args
  return (await tcp(ip, config.port, signal)) ? args : without
}
/** Only known identical routes are offered; changing settings requires a UI choice. */
export async function sshMergeGroups(
  hosts: readonly SshHost[],
  executable: string,
  keygen: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  active = new Set<string>()
): Promise<SshMergeGroup[]> {
  const entries: { host: SshHost; config: Config; keys: Set<string>; options: string }[] = []
  const candidates = hosts
    .filter((host) => host.alias.trim() && !host.alias.trim().startsWith('-') && !active.has(host.id))
    .slice(0, 32)
  for (let offset = 0; offset < candidates.length; offset += 4) {
    signal.throwIfAborted()
    const results = await Promise.all(
      candidates.slice(offset, offset + 4).map(async (host) => {
        const text = await output(executable, ['-G', host.alias.trim()], env, signal),
          config = text ? resolved(text) : null
        if (!config) return null
        const name = config.port === 22 ? config.hostname : `[${config.hostname}]:${config.port}`
        const known = await output(keygen, ['-F', name], env, signal)
        const keys = new Set(
          (known ?? '')
            .split(/\r?\n/)
            .filter((line) => line && !line.startsWith('#') && !line.startsWith('@'))
            .map((line) => line.trim().split(/\s+/).slice(1, 3).join(' '))
            .filter((key) => /^ssh-|^ecdsa-/.test(key))
        )
        const options = JSON.stringify([
          host.command,
          host.persist ?? 'off',
          host.worklog === true,
          host.transcriptFind === true,
          host.noUploads === true,
          host.downloadFolder ?? '',
          host.preferredAddress ?? ''
        ])
        return { host, config, keys, options }
      })
    )
    for (const result of results) if (result) entries.push(result)
  }
  signal.throwIfAborted()
  const groups: (typeof entries)[] = []
  for (const entry of entries) {
    const group = groups.find((group) =>
      group.every(
        (other) =>
          other.config.signature === entry.config.signature &&
          other.options === entry.options &&
          (other.config.hostname.toLowerCase() === entry.config.hostname.toLowerCase() ||
            [...entry.keys].some((key) => other.keys.has(key)))
      )
    )
    if (group) group.push(entry)
    else groups.push([entry])
  }
  return groups
    .filter((group) => group.length > 1)
    .map((group) => ({
      fallbackAlias: (group.find(entry => isTailnetIp(entry.config.hostname)) ?? group.find(entry => !sshDirectIp(entry.config.hostname)) ?? group[0]).host.alias,
      members: group.map((entry) => ({
        id: entry.host.id,
        alias: entry.host.alias,
        snapshot: JSON.stringify(entry.host)
      })),
      preferredAddress:
        group.map((entry) => sshDirectIp(entry.config.hostname)).find((ip) => ip && !isTailnetIp(ip)) ?? null,
      reason: group.every(
        (entry) => entry.config.hostname.toLowerCase() === group[0].config.hostname.toLowerCase()
      )
        ? 'Same resolved endpoint and SSH identity'
        : 'Shared known host key and matching SSH identity'
    }))
}
