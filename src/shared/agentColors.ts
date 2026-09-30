/*
 * Each coding agent's colour: the seed it starts from, the user's override,
 * and the two tokens `applyAppearance` derives from them.
 *
 * A colour identifies the AGENT on every surface that shows one — its tab's
 * tag, a rule along the top of its terminal, the status bar's model or agent
 * item, the launcher's agent menu, the plan-limit chip (Claude Code's) and its
 * row in Settings — so a glance at a pane says whose model it is on and whose
 * usage it is spending.
 *
 * Seeds live here, never in a component or in themes.ts (gotcha 43): they are
 * data, and `verify:color` / `verify:agents` hold every one of them to the
 * floors below. Like a profile accent (gotcha 44), a seed is a brand colour
 * that is DERIVED per theme: `--agent-<key>-ink` is `deriveAccent`'s ink —
 * 4.5:1 and APCA Lc 60 on the page, for text, borders and 1px/2px rules — and
 * `--agent-<key>-fill` is its fill, for a swatch that shows the colour itself.
 *
 * Three things the palette is kept clear of, and all three are asserted:
 *  - the context meter's green, orange and red (shared/meter.ts): an agent
 *    colour near them would read as context pressure. That is why Claude Code
 *    is not its brand terracotta — orange and red belong to the meter;
 *  - `--danger`, the worklog dot and every error;
 *  - `--warning`, which pulses on a tab that is waiting for you.
 * Every seed's derived ink sits at least `AGENT_CLEAR_DISTANCE` from all four
 * on every built-in theme, and the five common agents' seeds sit at least
 * `AGENT_DISTINCT_DISTANCE` from each other. Eighteen agents cannot all be told
 * apart by colour; the tag and the tooltip carry the name, and the user can
 * override any seed.
 *
 * Keyed by a string rather than by `CodingCliId` alone so an account can extend
 * it: a second Claude account would file its colour under `claude-work` and get
 * `--agent-claude-work-ink` from the same writer, with no CSS added — surfaces
 * map `--agent-ink` to their key's token inline (lib/agentColor.ts), not
 * through one rule per agent.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27); the
 * suites load it under strip-types, so shared imports are relative with `.ts`
 * (gotcha 78).
 */
import { deriveAccent, type Appearance } from './accent.ts'
import { CODING_CLIS, isCodingCliId, type CodingCliId } from './codingClis.ts'
import { parseColor, toHex } from './color.ts'

/**
 * The colour each agent starts with. Measured, not picked by eye: see the
 * header for the floors, and `verify:agents` for the numbers each one clears.
 *
 * The five common agents (Claude Code, Codex, Gemini, Grok, OpenCode) are
 * spread round the half of the wheel the meter leaves free — pink, periwinkle,
 * sky, teal and violet. The rest reuse those families at another lightness or
 * chroma, or are near-neutral where the vendor's own mark is monochrome.
 */
export const AGENT_SEEDS: Readonly<Record<CodingCliId, string>> = {
  claude: '#eb77b6',
  codex: '#829eff',
  grok: '#47d6cf',
  opencode: '#b781ec',
  pi: '#a1c1e4',
  gemini: '#48bff5',
  qwen: '#886bee',
  kimi: '#cbcbfe',
  copilot: '#bda8fc',
  cursor: '#c1ccd7',
  amp: '#c765ce',
  kilo: '#87f2f8',
  aider: '#75c2b3',
  crush: '#df4b9d',
  droid: '#2d88e2',
  cline: '#95d4f6',
  auggie: '#31a5a5',
  vibe: '#e2baeb'
}

/** The agents most people have, held to the stricter distinctness floor. */
export const COMMON_AGENTS: readonly CodingCliId[] = ['claude', 'codex', 'grok', 'opencode', 'gemini']

/**
 * Two common agents' seeds must be at least this far apart in OKLab. The
 * nearest two of the shipped profile swatches (Moss and Teal) measure 0.083,
 * the smallest gap this repo already ships as "two different colours".
 */
export const AGENT_DISTINCT_DISTANCE = 0.083

/**
 * How far every agent's derived ink stays from the meter's three tiers,
 * `--danger` and `--warning`, on every built-in theme. The meter's own
 * "visibly a different tier" bar (verify:color's METER_TIER_DISTANCE).
 */
export const AGENT_CLEAR_DISTANCE = 0.08

/** A colour key: an agent id today, `<id>-<account>` once accounts have colours. */
export type AgentColorKey = string

/** The two custom properties `applyAppearance` writes for one key. */
export function agentTokenNames(key: AgentColorKey): { ink: string; fill: string } {
  return { ink: `--agent-${key}-ink`, fill: `--agent-${key}-fill` }
}

/** The user's overrides: only known ids, only opaque colours, stored as `#rrggbb`. */
export type AgentColors = Partial<Record<CodingCliId, string>>

/**
 * Repair stored overrides. A value that does not parse, is translucent, or
 * names an agent this build does not know is dropped; one equal to the seed is
 * dropped too, so "reset" and "never touched" are the same stored state and a
 * later change of seed reaches everyone who never picked a colour.
 */
export function hydrateAgentColors(raw: unknown): AgentColors {
  const out: AgentColors = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!isCodingCliId(id) || typeof v !== 'string') continue
    const c = parseColor(v)
    if (!c || c.a < 1) continue
    const hex = toHex(c).toLowerCase()
    if (hex !== AGENT_SEEDS[id]) out[id] = hex
  }
  return out
}

/** The colour an agent is drawn in: the user's, else the seed. */
export function agentSeed(id: CodingCliId, colors: AgentColors): string {
  return colors[id] ?? AGENT_SEEDS[id]
}

/** One key's derived pair for a theme — the exact values `applyAppearance` writes. */
export interface AgentTokens {
  key: AgentColorKey
  seed: string
  ink: string
  fill: string
}

/**
 * Every agent's tokens for one theme. Called by `applyAppearance` and by the
 * suites, so what is asserted is what is painted (the meterScale pattern).
 */
export function agentColorTokens(colors: AgentColors, appearance: Appearance, pageBg: string): AgentTokens[] {
  return CODING_CLIS.map((c) => {
    const seed = agentSeed(c.id, colors)
    const t = deriveAccent(seed, appearance, pageBg)
    return { key: c.id, seed, ink: t.accentInk, fill: t.accent }
  })
}

/**
 * Whether agent colour is painted at all: only when more than one agent is in
 * view — offered by the launcher, open in a tab, or the one Start starts. A
 * Claude-Code-only user sees exactly what they saw before this existed, and a
 * Codex tab restored beside Claude tabs is coloured even after Codex was
 * unticked, because two agents are on screen.
 */
export function paintAgentColors(
  primary: CodingCliId,
  visible: readonly CodingCliId[],
  open: readonly CodingCliId[]
): boolean {
  return new Set<CodingCliId>([primary, ...visible, ...open]).size > 1
}
