/*
 * The hub's configuration, from the environment and flags. Pure apart from
 * reading a secret file, so verify:hub-server can hold every rule.
 *
 * The edge secret never comes from a flag: argv is readable by every user on
 * the machine (`ps`). It comes from `HUB_EDGE_SECRET`, from the file
 * `HUB_EDGE_SECRET_FILE` names, or from systemd's credential directory
 * (`LoadCredential=hub-edge-secret:…`, which the shipped unit uses).
 *
 * The data directory must be named — `STATE_DIRECTORY` (systemd's
 * `StateDirectory=`), `STOKE_HUB_DATA` or `--data` — rather than defaulting to
 * the working directory, where a second database would be created silently by
 * whoever ran the command from the wrong folder.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HubConfig, Listen } from './app.ts'
import { DEFAULT_RATE } from './app.ts'

export const DEFAULT_EDGE_LISTEN = '127.0.0.1:8787'
export const DEFAULT_MOUNT = '/hub'
export const EDGE_SECRET_CREDENTIAL = 'hub-edge-secret'

/** `host:port`, `[v6]:port`, or `off`/`none`/'' for no listener. Throws with a sentence for anything else. */
export function parseListen(text: string | undefined, what: string): Listen | null {
  const t = (text ?? '').trim()
  if (t === '' || t === 'off' || t === 'none') return null
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]\s]+)):(\d{1,5})$/.exec(t)
  if (!m) throw new Error(`${what} must look like 127.0.0.1:8787 (or "off"), not ${JSON.stringify(t)}.`)
  const port = Number(m[3])
  if (port > 65535) throw new Error(`${what}: ${port} is not a port.`)
  return { host: m[1] ?? m[2], port }
}

/** '' (served at the root) or `/a/b` with no trailing slash. */
export function parseMount(text: string | undefined): string {
  const t = (text ?? DEFAULT_MOUNT).trim()
  if (t === '' || t === '/') return ''
  if (!/^(\/[A-Za-z0-9._~-]+)+\/?$/.test(t)) throw new Error(`STOKE_HUB_MOUNT must be a path like /hub, not ${JSON.stringify(t)}.`)
  return t.replace(/\/+$/, '')
}

export function readEdgeSecret(env: Record<string, string | undefined>, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  if (env.HUB_EDGE_SECRET && env.HUB_EDGE_SECRET.trim() !== '') return env.HUB_EDGE_SECRET.trim()
  const file = env.HUB_EDGE_SECRET_FILE?.trim() || (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, EDGE_SECRET_CREDENTIAL) : '')
  if (!file) return null
  try {
    const s = readFile(file).trim()
    return s === '' ? null : s
  } catch {
    if (env.HUB_EDGE_SECRET_FILE) throw new Error(`HUB_EDGE_SECRET_FILE names ${file}, which cannot be read.`)
    return null
  }
}

export function dataDirFrom(env: Record<string, string | undefined>, flag: string | undefined): string {
  const dir = flag || env.STOKE_HUB_DATA || env.STATE_DIRECTORY?.split(':')[0]
  if (!dir) throw new Error('Name the data directory: --data <dir> or STOKE_HUB_DATA (systemd sets STATE_DIRECTORY for you).')
  return dir
}

function positiveNumber(text: string | undefined, fallback: number, what: string): number {
  if (text === undefined || text.trim() === '') return fallback
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${what} must be a positive number.`)
  return n
}

export function configFrom(env: Record<string, string | undefined>, flags: Record<string, string | undefined>): HubConfig {
  return {
    dataDir: dataDirFrom(env, flags.data),
    mount: parseMount(flags.mount ?? env.STOKE_HUB_MOUNT),
    edge: parseListen(flags.listen ?? env.STOKE_HUB_LISTEN ?? DEFAULT_EDGE_LISTEN, 'STOKE_HUB_LISTEN'),
    lan: parseListen(flags.lan ?? env.STOKE_HUB_LAN, 'STOKE_HUB_LAN'),
    edgeSecret: readEdgeSecret(env),
    rate: {
      capacity: positiveNumber(env.STOKE_HUB_RATE_BURST, DEFAULT_RATE.capacity, 'STOKE_HUB_RATE_BURST'),
      refillPerSec: positiveNumber(env.STOKE_HUB_RATE_PER_SEC, DEFAULT_RATE.refillPerSec, 'STOKE_HUB_RATE_PER_SEC')
    }
  }
}
