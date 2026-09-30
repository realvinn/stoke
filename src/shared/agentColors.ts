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
 * that is DERIVED per theme, into three tokens:
 *  - `--agent-<key>-ink`, `deriveAccent`'s ink — 4.5:1 and APCA Lc 60 on the
 *    page — for borders, 1px/2px rules and dots, which are graphics and need
 *    3:1 on whatever they sit on (WCAG 1.4.11);
 *  - `--agent-<key>-text`, the same colour held to 4.5:1 on every ground the
 *    tab tag's TEXT sits on (`AgentGrounds`), which is the ink itself wherever
 *    the ink already clears them — every dark theme — and solved darker where
 *    it does not. The ink alone measured 3.87:1 on the title bar of every light
 *    theme: it is solved against the page, and the tag sits on sunken chrome;
 *  - `--agent-<key>-fill`, its fill, for a swatch that shows the colour itself.
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
import { contrastRatio, parseColor, toHex } from './color.ts'

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

/** The three custom properties `applyAppearance` writes for one key. */
export function agentTokenNames(key: AgentColorKey): { ink: string; text: string; fill: string } {
  return { ink: `--agent-${key}-ink`, text: `--agent-${key}-text`, fill: `--agent-${key}-fill` }
}

/**
 * The grounds an agent's colour is painted on as TEXT: the page (the selected
 * tab), the title bar's sunken chrome (every other tab) and `--surface-hover`
 * (a hovered or lifted one). Theme colour keys, so `theme.colors` passes as is.
 */
export interface AgentGrounds {
  bg: string
  bgSunken: string
  surfaceHover: string
}

/** WCAG 1.4.3: what `--agent-<key>-text` clears on every one of `AgentGrounds`. */
export const AGENT_TEXT_WCAG = 4.5

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

/** One key's derived tokens for a theme — the exact values `applyAppearance` writes. */
export interface AgentTokens {
  key: AgentColorKey
  seed: string
  ink: string
  text: string
  fill: string
}

/**
 * The text colour: the ink when it already clears `AGENT_TEXT_WCAG` on every
 * ground, so the tag's text and its border stay one colour wherever they can;
 * otherwise the seed solved against the ground it reads worst on, which is the
 * same hue and chroma moved further from the page. Solving against the WORST
 * ground clears the rest too, because every ground here sits on the page's
 * side of the ink.
 *
 * `deriveAccent` judges against `--bg` on purpose (its own comment: the harder
 * ground would darken every light accent past what the page needs), so the ink
 * cannot simply be derived against the sunken chrome instead — the pane rule
 * and the dots would darken for no reason. Hence a second token.
 */
function textInk(seed: string, ink: string, appearance: Appearance, grounds: AgentGrounds): string {
  const fg = parseColor(ink)
  if (!fg) return ink
  let worst: string | null = null
  let worstRatio = Infinity
  for (const g of [grounds.bg, grounds.bgSunken, grounds.surfaceHover]) {
    const c = parseColor(g)
    if (!c) continue
    const r = contrastRatio(fg, c)
    if (r < worstRatio) [worst, worstRatio] = [g, r]
  }
  if (worst === null || worstRatio >= AGENT_TEXT_WCAG) return ink
  return deriveAccent(seed, appearance, worst).accentInk
}

/**
 * Every agent's tokens for one theme. Called by `applyAppearance` and by the
 * suites, so what is asserted is what is painted (the meterScale pattern).
 */
export function agentColorTokens(
  colors: AgentColors,
  appearance: Appearance,
  grounds: AgentGrounds,
  /**
   * More keys to derive, each from a seed of its own — an account
   * (`claude-work`, shared/accounts.ts), whose seed is one of
   * `ACCOUNT_SWATCHES`. Same derivation, same writer, no CSS added.
   */
  extra: readonly { key: AgentColorKey; seed: string }[] = []
): AgentTokens[] {
  const keyed = [...CODING_CLIS.map((c) => ({ key: c.id as AgentColorKey, seed: agentSeed(c.id, colors) })), ...extra]
  return keyed.map(({ key, seed }) => {
    const t = deriveAccent(seed, appearance, grounds.bg)
    return { key, seed, ink: t.accentInk, text: textInk(seed, t.accentInk, appearance, grounds), fill: t.accent }
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
