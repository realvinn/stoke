import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import type { TerminalConfig } from './config.ts'
import { findExecutable } from './platform.ts'

export async function checkConnection(connection: TerminalConfig['remotes'][string]): Promise<{ ok: boolean; message: string }> {
  let host: string, port: number
  if (connection.kind === 'opencode') {
    const url = new URL(connection.url)
    host = url.hostname.replace(/^\[|\]$/g, ''); port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  } else {
    const ssh = findExecutable(['ssh', 'ssh.exe'])
    if (!ssh) return { ok: false, message: 'Install an OpenSSH client before using SSH connections.' }
    try {
      const result = await promisify(execFile)(ssh, ['-G', connection.host], { timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true })
      const fields = new Map(result.stdout.split(/\r?\n/).map((line) => { const space = line.indexOf(' '); return [line.slice(0, space), line.slice(space + 1).trim()] }))
      if (['proxycommand', 'proxyjump'].some((key) => fields.has(key) && fields.get(key) !== 'none')) return { ok: false, message: 'This SSH host uses a proxy or jump host. Use Connect so SSH can follow that route; a direct TCP probe would test the wrong endpoint.' }
      host = fields.get('hostname') || connection.host; port = Number(fields.get('port')) || 22
    } catch { return { ok: false, message: 'SSH could not resolve this host configuration. Check the host/alias with ssh -G.' } }
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true; socket.destroy()
      resolve({ ok, message: ok ? 'TCP endpoint reachable. Authentication and application health are checked when you connect.' : 'Could not reach the configured TCP endpoint within 3 seconds. Check its address, port and network route.' })
    }
    socket.setTimeout(3000, () => finish(false))
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false))
  })
}
