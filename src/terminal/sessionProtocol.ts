import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { terminalHome } from './config.ts'

export const SESSION_PROTOCOL = 1
export const MAX_SESSION_FRAME = 16 * 1024 * 1024
export interface ServerInfo { protocol: number; pid: number; endpoint: string; token: string; features?: string[] }
export const serverInfoPath = (home = terminalHome()): string => join(home, 'server.json')
export const socketPrefix = (home: string): string => process.platform === 'win32'
  ? `\\\\.\\pipe\\stoke-${homeKey(home)}-` : `/tmp/stoke-${process.getuid?.() ?? 0}-${homeKey(home)}-`
export function readServerInfo(home = terminalHome()): ServerInfo | null {
  try {
    const info = JSON.parse(readFileSync(serverInfoPath(home), 'utf8')) as ServerInfo
    if (info.protocol !== SESSION_PROTOCOL || !Number.isSafeInteger(info.pid) || !/^[a-f0-9]{64}$/.test(info.token)) return null
    const expected = socketPrefix(home)
    if (typeof info.endpoint !== 'string' || !info.endpoint.startsWith(expected)) return null
    return info
  } catch { return null }
}
export const homeKey = (home: string): string => createHash('sha256').update(home).digest('hex').slice(0, 20)
export function sameToken(left: unknown, right: string): boolean {
  return typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
