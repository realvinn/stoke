/*
 * The hub on the Stoke side of the wire: this device's own `hub` settings
 * block, what it uploads from Settings, and how what arrives is folded back
 * into Settings.
 *
 * `hub` is T0 — machine-local, never synced, never exported (the client adds
 * `'hub'` to setupFile.ts LOCAL_KEYS and `hub.token` to SECRET_PATHS with
 * `portable: false` in the change that wires it). Its defaults and hydrate
 * live here so the client, the suite and any later reader agree on one shape.
 *
 * Pure (gotcha 27); imports only src/shared by relative `.ts` path (gotcha 78).
 * Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md §5.
 */
import type { Settings, SshHost } from '../types.ts'
import { applySecrets, collectSecrets, scrubSecrets, secretSpecFor } from '../secrets.ts'
import { PARTIAL_KEYS, portableSecrets, portableSettings } from '../setupFile.ts'
import { isId, isRecord, stableJson } from './codec.ts'
import type { HubGrant } from './relay.ts'
import { T1_KEYS } from './items.ts'

/* ------------------------------------------------ the local block */

export interface HubSettings {
  /** The hub's base URL as `hubUrlVerdict` normalised it; '' = no hub. */
  url: string
  /** The account signed in, for display only. */
  email: string
  /** The session bearer. SECRET (`hub.token`, not portable). '' = signed out. */
  token: string
  /** This device's id once its keys exist; '' before. */
  deviceId: string
  /** What the chain calls this device. '' = the OS host name. */
  deviceLabel: string
  /** This device's own switches (T2 also needs the account's `acct/pref/sync-keys`). */
  sync: { settings: boolean; hosts: boolean; keys: boolean }
  /**
   * "Let my other devices see and open my sessions" — this machine's own tick,
   * default OFF. Off, its presence status lists no session and every relay
   * asking for one is refused, whatever `grants` says. On, its sessions are
   * listed on the owner's other signed-in devices, and opening one still asks
   * here first unless that device holds a grant (src/shared/hub/remote.ts).
   * It replaced `remoteHost` (default on) before any build shipped it, under a
   * new name so a file that held the old default cannot hydrate as on.
   */
  shareSessions: boolean
  /** Requesting device id → its grant on THIS machine. Never synced. */
  grants: Record<string, HubGrant>
}

export const HUB_SETTINGS_DEFAULTS: HubSettings = {
  url: '',
  email: '',
  token: '',
  deviceId: '',
  deviceLabel: '',
  sync: { settings: true, hosts: true, keys: true },
  shareSessions: false,
  grants: {}
}

const str = (v: unknown, max = 512): string => (typeof v === 'string' ? v.slice(0, max) : '')
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)

/**
 * Repair a stored `hub` block. Rebuilt from named keys, so a field this
 * build does not know is dropped and a missing one takes its default (the
 * clamp rule CLAUDE.md states for `ui.ts`). The URL is kept as stored — the
 * panel re-judges it with `hubUrlVerdict` before any request — and a grant is
 * kept only for a well-formed device id with a known mode.
 */
export function hydrateHubSettings(raw: unknown): HubSettings {
  const r = isRecord(raw) ? raw : {}
  const sync = isRecord(r.sync) ? r.sync : {}
  const grants: Record<string, HubGrant> = {}
  if (isRecord(r.grants)) {
    for (const [id, g] of Object.entries(r.grants)) {
      if (!isId('device', id) || !isRecord(g) || (g.mode !== 'view' && g.mode !== 'full')) continue
      grants[id] = { mode: g.mode, label: str(g.label, 64), at: typeof g.at === 'number' && Number.isFinite(g.at) ? g.at : 0 }
    }
  }
  return {
    url: str(r.url, 2048).trim(),
    email: str(r.email, 254),
    token: str(r.token, 128),
    deviceId: isId('device', r.deviceId) ? (r.deviceId as string) : '',
    deviceLabel: str(r.deviceLabel, 64),
    sync: {
      settings: bool(sync.settings, HUB_SETTINGS_DEFAULTS.sync.settings),
      hosts: bool(sync.hosts, HUB_SETTINGS_DEFAULTS.sync.hosts),
      keys: bool(sync.keys, HUB_SETTINGS_DEFAULTS.sync.keys)
    },
    shareSessions: bool(r.shareSessions, HUB_SETTINGS_DEFAULTS.shareSessions),
    grants
  }
}

/* ------------------------------------------------ what a device uploads */

/** T1 values of `s`: `portableSettings` split per T1 key, secrets emptied. */
export function t1ValuesFrom(s: Settings): Record<string, unknown> {
  const portable = portableSettings(s)
  const out: Record<string, unknown> = {}
  for (const k of T1_KEYS) out[k] = portable[k]
  return out
}

/** T2 values of `s`: the portable, non-empty secrets. */
export function t2ValuesFrom(s: Settings): Record<string, string> {
  return portableSecrets(collectSecrets(s))
}

/** A host as it may carry a sync id (the client adds `syncId?: string` to `SshHost`). */
export type SyncableHost = SshHost & { syncId?: string }

/** Where plain ssh would really go, from `ssh -G <alias>`, so a device without that alias can still connect. */
export interface SshReach {
  hostName: string
  user: string
  port: number
  proxyJump: string
}

/** A T3 item's value. The settings id and `keyEnrolled` stay on each device (a counter, and a fact about ITS key). */
export interface HostPayload {
  host: Omit<SshHost, 'id' | 'keyEnrolled'>
  reach?: SshReach
  /** T4 key ids this host uses. */
  keyRefs: string[]
}

export function hostPayloadFor(h: SyncableHost, extra: { reach?: SshReach; keyRefs?: string[] } = {}): HostPayload {
  const { id: _id, keyEnrolled: _mine, syncId: _sync, ...host } = h
  return { host, ...(extra.reach ? { reach: extra.reach } : {}), keyRefs: extra.keyRefs ?? [] }
}

/** The first free `host-N`, the same rule as HostsSettings' `newHostId`. */
export function freeHostId(hosts: readonly { id: string }[]): string {
  const taken = new Set(hosts.map((h) => h.id))
  for (let n = 1; ; n++) if (!taken.has(`host-${n}`)) return `host-${n}`
}

/* ------------------------------------------------ applying what arrives */

export interface SyncedIncoming {
  /** T1: key → value (the whole truth for that key). */
  settings?: Record<string, unknown>
  /** T3: host sync id → payload, or null for a tombstone. */
  hosts?: Record<string, HostPayload | null>
  /** T2: secret path → value, or null for a tombstone (clears the key). */
  secrets?: Record<string, string | null>
}

export interface SyncApplyResult {
  /** Settings with everything folded in. NOT hydrated: the caller runs `hydrateSettings`. */
  raw: Record<string, unknown>
  /** What arrived and was deliberately not applied, with why. */
  skipped: { key: string; why: string }[]
  /** Local hosts that took an incoming sync id because they are the same machine (same alias and command). */
  adopted: { id: string; syncId: string }[]
  /** Whole items not applied because they would change what runs here (`heldChangesFor`). */
  held: HeldChange[]
}

/* ------------------------------------------------ what runs code */

/**
 * An incoming item that would change what runs on this computer: an MCP
 * server's program, arguments or variables, an MCP server's URL, or what an
 * SSH host runs. Held whole — the local value stays — until the owner applies
 * it on THIS computer, as `bypassPermissions` is. Anyone who can seal an item
 * could otherwise make every device run a command at its next session: a
 * device before it was removed (removing it undoes nothing it wrote), or a
 * hub that got a device into a vault of its own.
 */
export interface HeldChange {
  /** The item path (`t1/settings/agents`, `t2/secret/…`, `t3/host/…`). */
  path: string
  /** One Apply per group: every MCP change is `agents`; a host is its own path. */
  group: string
  /** What it would run, spelled out. A variable is named, never its value (a secret). */
  lines: string[]
}

/** An argv as a person would type it: plain words bare, anything else quoted. */
export function argvText(command: string, args: readonly string[]): string {
  return [command, ...args].map((a) => (a !== '' && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')
}

/** A URL without its query or fragment, where hosted MCP servers take their key. */
export function urlText(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}${u.search ? ' (with a query)' : ''}`
  } catch {
    return url.split(/[?#]/)[0]
  }
}

interface ServerShape {
  transport: string
  command: string
  args: string[]
  url: string
  env: string[]
}

function serverShape(v: unknown): ServerShape | null {
  if (!isRecord(v)) return null
  return {
    // As `hydrateServerSpec` reads it: anything but http is a program to run.
    transport: v.transport === 'http' ? 'http' : 'stdio',
    command: typeof v.command === 'string' ? v.command.trim() : '',
    args: Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : [],
    url: typeof v.url === 'string' ? v.url.trim() : '',
    env: isRecord(v.env) ? Object.keys(v.env).sort() : []
  }
}

function extraOf(agents: unknown): Record<string, unknown> {
  if (!isRecord(agents) || !isRecord(agents.mcp) || !isRecord(agents.mcp.extra)) return {}
  return agents.mcp.extra
}

/** What an incoming `agents` block would change about the MCP servers Stoke starts. */
function mcpLines(mine: Record<string, unknown>, theirs: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const [name, raw] of Object.entries(theirs)) {
    const t = serverShape(raw)
    if (!t) continue
    const m = serverShape(mine[name])
    const same = m !== null && m.transport === t.transport
    if (t.transport === 'stdio') {
      const vars = t.env.length ? ` (variables: ${t.env.join(', ')})` : ''
      if (!same || m.command !== t.command || stableJson(m.args) !== stableJson(t.args)) {
        lines.push(`${m ? 'Changes' : 'Adds'} MCP server “${name}” to run: ${argvText(t.command, t.args)}${vars}`)
      } else {
        const added = t.env.filter((n) => !m.env.includes(n))
        if (added.length) lines.push(`Gives MCP server “${name}” new variables: ${added.join(', ')}`)
      }
    } else if (t.transport === 'http' && (!same || m.url !== t.url)) {
      lines.push(`${m ? 'Points' : 'Adds'} MCP server “${name}” at ${urlText(t.url)}`)
    }
  }
  return lines
}

const MCP_SECRET = /^agents\.mcp\.extra\.([^.]+)\.(env|headers|bearer)(?:\.(.+))?$/

/**
 * The incoming items that would change what runs here, judged against
 * `current` (spec §5.3). Removing a server or a host's command runs nothing,
 * and is never held; neither is a value that is already this computer's.
 */
export function heldChangesFor(current: Settings, incoming: SyncedIncoming): HeldChange[] {
  const held: HeldChange[] = []
  const mine = extraOf(current.agents)
  let after = mine
  const agents = incoming.settings?.agents
  if (agents !== undefined) {
    const theirs = extraOf(agents)
    const lines = mcpLines(mine, theirs)
    if (lines.length) held.push({ path: 't1/settings/agents', group: 'agents', lines })
    else after = theirs
  }
  const localSecrets = collectSecrets(current)
  for (const [path, value] of Object.entries(incoming.secrets ?? {})) {
    const m = MCP_SECRET.exec(path)
    if (!m || value === null || value === localSecrets[path]) continue
    const server = serverShape(after[m[1]])
    if (!server) {
      held.push({ path: `t2/secret/${path}`, group: 'agents', lines: [`A ${m[2] === 'env' ? `variable (${m[3]})` : m[2] === 'headers' ? `header (${m[3]})` : 'token'} for MCP server “${m[1]}”, which is not on this computer yet`] })
    } else if (server.transport === 'stdio' && m[2] === 'env') {
      held.push({ path: `t2/secret/${path}`, group: 'agents', lines: [`Sets variable ${m[3]} of MCP server “${m[1]}” to a new value (${argvText(server.command, server.args)})`] })
    }
  }
  const hosts = current.hosts as SyncableHost[]
  for (const [syncId, payload] of Object.entries(incoming.hosts ?? {})) {
    if (!isId('host', syncId) || !isRecord(payload) || !isRecord(payload.host) || typeof payload.host.alias !== 'string') continue
    const cmd = typeof payload.host.command === 'string' ? payload.host.command.trim() : ''
    if (!cmd) continue
    const alias = payload.host.alias.trim()
    const local =
      hosts.find((h) => h.syncId === syncId) ??
      hosts.find((h) => !h.syncId && h.alias.trim() === alias && (h.command ?? '').trim() === cmd)
    if (local && (local.command ?? '').trim() === cmd) continue
    const label = typeof payload.host.label === 'string' && payload.host.label.trim() ? payload.host.label.trim() : alias
    held.push({ path: `t3/host/${syncId}`, group: `t3/host/${syncId}`, lines: [`${local ? 'Changes' : 'Adds'} SSH host “${label}” (${alias}) to run: ${cmd}`] })
  }
  return held
}

/** What synced here runs something, for the revoke report: a removed device could have set any of it. */
export function runsCode(s: Settings): string[] {
  const out: string[] = []
  for (const [name, raw] of Object.entries(extraOf(s.agents))) {
    const t = serverShape(raw)
    if (t?.transport === 'stdio' && t.command) out.push(`MCP server “${name}” (${argvText(t.command, t.args)})`)
    else if (t?.transport === 'http' && t.url) out.push(`MCP server “${name}” (${urlText(t.url)})`)
  }
  for (const h of s.hosts as SyncableHost[]) {
    if (isId('host', h.syncId) && (h.command ?? '').trim()) out.push(`SSH host “${h.label || h.alias}” (${h.command.trim()})`)
  }
  return out
}

function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/**
 * Fold synced items into the current settings.
 *
 * - T1 REPLACES the local value of its key — a synced key is the whole truth
 *   for that key, unlike the one-shot `.stoke-setup` import, whose union by
 *   id would mean a deletion never propagates. Two guards shared with
 *   `mergeSetup`: a synced `bypassPermissions` default is never applied
 *   unasked, and a PARTIAL block (`wallpaper`, `browser`) replaces only its
 *   portable sub-keys.
 * - T3 hosts match by SYNC id, never by settings id: `SshHost.id` is a
 *   per-machine counter, so two machines' `host-1` are usually two different
 *   servers (measured 2026-10-01: the shipped import, which matches by that
 *   id, replaced a Windows profile's `host-1` "NUC" with a Mac's `host-1`
 *   "VPS" and previewed it as "updates VPS"). A local host with no sync id
 *   whose alias and command equal an incoming one's ADOPTS that sync id (the
 *   same machine, known on both before either synced); anything else new is
 *   appended with a free local id. `keyEnrolled` stays the device's own.
 * - Every local secret is overlaid back after T1, so a scrubbed incoming
 *   `providers`/`agents`/`voice` block never erases a key; then T2 overlays,
 *   portable paths only, a tombstone emptying the key.
 * - An item that would change what runs here (`heldChangesFor`) is not
 *   applied at all, and is returned in `held`, unless `allowHeld` — the owner
 *   pressed Apply on this computer.
 */
export function applySyncedSettings(current: Settings, incoming: SyncedIncoming, opts: { allowHeld?: boolean } = {}): SyncApplyResult {
  const next = cloneJson(current) as unknown as Record<string, unknown>
  const skipped: SyncApplyResult['skipped'] = []
  const adopted: SyncApplyResult['adopted'] = []
  const held = opts.allowHeld ? [] : heldChangesFor(current, incoming)
  const isHeld = (path: string): boolean => held.some((h) => h.path === path)

  for (const [key, value] of Object.entries(incoming.settings ?? {})) {
    if (isHeld(`t1/settings/${key}`)) continue
    if (!T1_KEYS.includes(key)) {
      skipped.push({ key, why: 'not a synced setting in this version of Stoke' })
      continue
    }
    if (key in PARTIAL_KEYS) {
      if (!isRecord(value)) continue
      const subs = PARTIAL_KEYS[key as keyof typeof PARTIAL_KEYS] as readonly string[]
      const merged: Record<string, unknown> = { ...(current[key as keyof Settings] as unknown as Record<string, unknown>) }
      for (const sub of subs) if (Object.prototype.hasOwnProperty.call(value, sub)) merged[sub] = cloneJson(value[sub])
      next[key] = merged
      continue
    }
    if (key === 'defaults' && isRecord(value)) {
      const d = cloneJson(value)
      if (d.permissionMode === 'bypassPermissions' && current.defaults.permissionMode !== 'bypassPermissions') {
        d.permissionMode = current.defaults.permissionMode
        skipped.push({
          key: 'defaults.permissionMode',
          why: 'Another device starts sessions with permissions bypassed. Choose that here, in Settings › Sessions, if you want it on this machine too.'
        })
      }
      next.defaults = d
      continue
    }
    next[key] = cloneJson(value)
  }

  if (incoming.hosts) {
    const hosts: SyncableHost[] = cloneJson(current.hosts as SyncableHost[])
    for (const [syncId, payload] of Object.entries(incoming.hosts)) {
      if (!isId('host', syncId) || isHeld(`t3/host/${syncId}`)) continue
      let at = hosts.findIndex((h) => h.syncId === syncId)
      if (payload === null) {
        if (at >= 0) hosts.splice(at, 1)
        continue
      }
      if (!isRecord(payload) || !isRecord(payload.host) || typeof payload.host.alias !== 'string') continue
      if (at < 0) {
        at = hosts.findIndex(
          (h) => !h.syncId && h.alias.trim() === payload.host.alias.trim() && (h.command ?? '') === (payload.host.command ?? '')
        )
        if (at >= 0) adopted.push({ id: hosts[at].id, syncId })
      }
      if (at >= 0) {
        const mine = hosts[at]
        hosts[at] = { ...cloneJson(payload.host), id: mine.id, syncId, keyEnrolled: mine.keyEnrolled === true }
      } else {
        hosts.push({ ...cloneJson(payload.host), id: freeHostId(hosts), syncId, keyEnrolled: false })
      }
    }
    next.hosts = hosts
  }

  let raw = applySecrets(scrubSecrets(next), collectSecrets(current))
  const t2: Record<string, string> = {}
  for (const [path, value] of Object.entries(incoming.secrets ?? {})) {
    if (isHeld(`t2/secret/${path}`)) continue
    if (secretSpecFor(path)?.portable !== true) {
      skipped.push({ key: path, why: 'not a key that syncs' })
      continue
    }
    t2[path] = typeof value === 'string' ? value : ''
  }
  raw = applySecrets(raw, t2)
  return { raw, skipped, adopted, held }
}

/* ------------------------------------------------ T4: SSH key files */

/** Names in `~/.ssh` a received key must never take. */
const RESERVED_SSH_NAMES = new Set(['config', 'known_hosts', 'known_hosts2', 'authorized_keys', 'authorized_keys2', 'environment', 'rc'])

/** Whether `name` may be a private-key file name in `~/.ssh`. */
export function isSafeSshKeyName(name: unknown): name is string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) return false
  if (name.startsWith('.') || name.endsWith('.pub') || name.includes('..')) return false
  return !RESERVED_SSH_NAMES.has(name.toLowerCase()) && !name.toLowerCase().startsWith('config')
}

/** What `sshKeyTarget` asks about each candidate name. */
export type SshNameProbe = (name: string) => 'free' | 'same' | 'different'

/**
 * The file a received private key is written to. The wanted name when free;
 * the same name, written again as nothing, when an IDENTICAL key is already
 * there; otherwise `<name>-stoke-2`, `-3`, … up to 99. Never overwrites a
 * different key; null when the name is unsafe or every candidate is taken.
 * The `.pub` goes beside whatever name this picks.
 */
export function sshKeyTarget(wanted: string, probe: SshNameProbe): { name: string; action: 'write' | 'reuse' } | null {
  if (!isSafeSshKeyName(wanted)) return null
  for (let n = 1; n <= 99; n++) {
    const name = n === 1 ? wanted : `${wanted}-stoke-${n}`
    if (!isSafeSshKeyName(name)) return null
    const seen = probe(name)
    if (seen === 'free') return { name, action: 'write' }
    if (seen === 'same') return { name, action: 'reuse' }
  }
  return null
}

/** A T4 item's value. The file's bytes travel as they are, passphrase and all. */
export interface SshKeyPayload {
  /** The file name it had on the uploading device (`id_ed25519_work`). */
  name: string
  /** OpenSSH private key text, exactly as read. */
  privateKey: string
  publicKey: string
  comment: string
  /** `ssh-keygen -lf` style, for the list. */
  fingerprint: string
  /** Whether the private key is itself passphrase-protected. */
  passphrase: boolean
  /**
   * The device that shared it. The envelope's author is whoever sealed it
   * LAST, and a revoke re-seals everything as the revoking device.
   */
  sharedBy?: string
}

export function sshKeyPayloadProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'not an object'
  if (!isSafeSshKeyName(v.name)) return 'unsafe file name'
  if (typeof v.privateKey !== 'string' || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v.privateKey)) return 'not a private key'
  if (v.privateKey.length > 16 * 1024) return 'private key too large'
  if (typeof v.publicKey !== 'string' || /[\r\n]./.test(v.publicKey.trim())) return 'bad public key'
  if (typeof v.comment !== 'string' || typeof v.fingerprint !== 'string' || typeof v.passphrase !== 'boolean') return 'bad fields'
  if (v.sharedBy !== undefined && !isId('device', v.sharedBy)) return 'bad sharing device'
  return null
}
