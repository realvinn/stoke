/*
 * Talking to Stoke: the typed shapes of the phone contract (the comment at the
 * top of src/main/remote/server.ts is the other half of this file), the fetch
 * wrapper that turns a 401 into the Connect screen, the live theme and the
 * host facts.
 */
import { deriveAccent } from '@shared/accent'
import { meterScale } from '@shared/meter'
import type { PhoneSessionStatus } from '@shared/remotePhone'

export interface ContextInfo {
  contextTokens: number
  contextLimit: number
  messageCount: number
  title: string | null
  ready: boolean
  permissionMode: string | null
}

/** One `/api/sessions` row — phone contract point 3. */
export interface SessionRow {
  ptyId: string
  sessionId: string
  cwd: string
  name: string
  host: string | null
  exited: boolean
  startedAt: number
  cols: number
  rows: number
  context: ContextInfo | null
  status: PhoneSessionStatus
  waitingFor: string | null
  lastActivityAt: number | null
  cli: string
  agentName: string
  project: string
  title: string | null
  endedAt: number | null
  exitCode: number | null
}

export interface HostInfo {
  machine: string
  platform: string
  stt: 'ready' | 'down' | 'off'
  agents: { id: string; name: string }[]
  defaults: { permissionMode: string; model: string; effort: string }
}

export interface ProjectRow {
  path: string
  name: string
  sessionCount: number
  lastActivityAt: number | null
  pinned: boolean
  exists: boolean
}

export interface HistoryRow {
  id: string
  projectPath: string
  title: string | null
  firstPrompt: string | null
  modified: number
  messageCount: number
  model: string | null
  contextTokens: number
  contextLimit: number | null
  gitBranch: string | null
  live: boolean
  ptyId: string | null
}

export interface TurnRow {
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  at: number | null
}

/** The key was refused: the Connect screen takes over. */
export class AuthError extends Error {
  constructor() {
    super('Not connected')
  }
}

let onAuthFailure: () => void = () => {}
export function setAuthFailureHandler(fn: () => void): void {
  onAuthFailure = fn
}

/** Set once any request has succeeded here: tells "never connected" from "key replaced". */
export const CONNECTED_KEY = 'stoke.connected'

export async function api<T>(path: string, init?: RequestInit & { key?: string }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init?.key) headers.authorization = `Bearer ${init.key}`
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    if (!init?.key) onAuthFailure()
    throw new AuthError()
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* not JSON: judged by the status below */
  }
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error
    const err = new Error(message || `Stoke answered ${res.status}.`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  try {
    localStorage.setItem(CONNECTED_KEY, '1')
  } catch {
    /* private mode */
  }
  return body as T
}

/* ---------------------------------------------------------------- theme */

interface RemoteTheme {
  appearance: 'dark' | 'light'
  colors: Record<string, string>
  terminal: Record<string, string>
  fontFamily: string
}

export let theme: RemoteTheme | null = null

/**
 * Paint the desktop's own theme: every colour token onto :root with the same
 * camelCase -> kebab rule the desktop uses, then the DERIVED tokens the
 * desktop derives too — the accent's ink/contrast (gotcha 44: accent text is
 * `--accent-ink`, never `--accent`) and the meter's three tiers — by the very
 * functions `applyAppearance` calls, so the phone cannot drift from the desk.
 */
export async function loadTheme(): Promise<RemoteTheme | null> {
  try {
    theme = await api<RemoteTheme>('/api/theme')
  } catch (err) {
    if (err instanceof AuthError) throw err
    return theme
  }
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value)
  }
  const accent = deriveAccent(theme.colors.accent, theme.appearance, theme.colors.bg)
  root.style.setProperty('--accent', accent.accent)
  root.style.setProperty('--accent-hover', accent.accentHover)
  root.style.setProperty('--accent-soft', accent.accentSoft)
  root.style.setProperty('--accent-contrast', accent.accentContrast)
  root.style.setProperty('--accent-ink', accent.accentInk)
  const meter = meterScale(theme.colors.bg, theme.colors.bgSunken, theme.appearance)
  root.style.setProperty('--meter-low', meter.low)
  root.style.setProperty('--meter-mid', meter.mid)
  root.style.setProperty('--meter-high', meter.high)
  if (theme.terminal.background) root.style.setProperty('--term-bg', theme.terminal.background)
  root.style.colorScheme = theme.appearance
  root.dataset.appearance = theme.appearance
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = theme.colors.bg
  return theme
}

/* ----------------------------------------------------------------- host */

export let host: HostInfo | null = null

const MACHINES_KEY = 'stoke.machines'

export async function loadHost(): Promise<HostInfo | null> {
  try {
    host = await api<HostInfo>('/api/host')
  } catch (err) {
    if (err instanceof AuthError) throw err
    return host
  }
  try {
    const seen = new Set<string>(JSON.parse(localStorage.getItem(MACHINES_KEY) ?? '[]'))
    seen.add(host.machine)
    localStorage.setItem(MACHINES_KEY, JSON.stringify([...seen].slice(-8)))
  } catch {
    /* private mode */
  }
  return host
}

/**
 * Name the machine only when this phone has seen more than one (PX-24). With
 * one desktop the name is noise; with two behind similar bookmarks it is the
 * difference between starting work on the right computer and the wrong one.
 */
export function showMachine(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(MACHINES_KEY) ?? '[]') as string[]).length > 1
  } catch {
    return false
  }
}

export function machineName(): string {
  return host?.machine ?? 'your computer'
}

export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}
