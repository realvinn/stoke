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
 * Each seed is its vendor's own colour where one can be used (the table on
 * `AGENT_SEEDS` says where each came from), because the owner asked for
 * exactly that: "claude should default to claude[,] codex to codex colour like
 * a orangy for claude and a purplish for codex and whatever else".
 *
 * Three things the palette is kept clear of, and all three are asserted:
 *  - the context meter's green, orange and red (shared/meter.ts): an agent
 *    colour near them would read as context pressure;
 *  - `--danger`, the worklog dot and every error;
 *  - `--warning`, which pulses on a tab that is waiting for you.
 * Every seed's derived ink sits at least `AGENT_CLEAR_DISTANCE` from all five
 * on every built-in theme (`clearanceFloor`), with ONE deliberate exception:
 * Claude Code is orange because the owner chose it over the rule that used to
 * keep it pink, so it shares the meter's orange, and it is held to
 * `CLAUDE_CLEAR_DISTANCE` from `--danger` and `--warning` — no orange can do
 * better on any theme (see that constant). The five common agents'
 * seeds sit at least `AGENT_DISTINCT_DISTANCE` from each other, so do the
 * members of every brand family whose vendors share a colour
 * (`AGENT_BRAND_FAMILIES`), and no other agent's ink comes within 0.04 of a
 * common agent's on any theme. Eighteen agents cannot all be told apart by
 * colour; the tag and the tooltip carry the name, and the user can override
 * any seed.
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
import { contrastRatio, parseColor, perceptualDistance, toHex } from './color.ts'
import { meterScale } from './meter.ts'

/**
 * The colour each agent starts with: its vendor's own, nudged only as far as
 * the floors in the header need. Measured, not picked by eye — `verify:agents`
 * prints the number each one clears. Looked up on 2026-10-01; OKLCH is L C h.
 *
 *   agent     seed     OKLCH            based on
 *   claude    #de7b2e  0.68 0.15 54     Anthropic's accent orange #d97757 (brand guidelines;
 *                                      Claude Code's own TUI colour, rgb 215 119 87), moved
 *                                      from h39 to h54 — amber-leaning, not red-orange.
 *                                      #d97757 itself, derived for a light theme's tab
 *                                      strip, measured 0.021 from `--danger`: an error.
 *                                      h54 is the point furthest from both --danger and
 *                                      --warning (CLAUDE_CLEAR_DISTANCE).
 *   codex     #ba66e9  0.66 0.20 312    codex-rs/tui/styles.md: "Codex: Use ANSI magenta".
 *                                      A purple on the magenta side, as asked ("purplish").
 *   grok      #c8d2e0  0.86 0.02 257    xAI / Grok: a black-on-white mark, no colour at all.
 *                                      Silver, kept faintly cool so it is not Cursor's stone.
 *   opencode  #4bc8d5  0.77 0.11 205    opencode.ai is monochrome (#201d1d / #fdfcfc); its TUI
 *                                      theme's primary is peach #fab283 (the meter's orange,
 *                                      --danger and --warning all sit there) and its accent
 *                                      #9d7cd8 is Codex's purple, so it takes the same
 *                                      theme's cyan (#56b6c2), brightened.
 *   pi        #81a9d2  0.72 0.07 250    pi.dev's --accent "thread blue" #6a9fcc, lifted.
 *   gemini    #4796e4  0.66 0.14 251    gemini-cli theme.ts GradientColors[0], the Gemini blue.
 *   qwen      #5265f9  0.58 0.22 272    qwen.ai's brand blue #0a28f0 / #2e4aff, towards the
 *                                      mark's purple: an indigo between Gemini and Copilot.
 *   kimi      #1fc0ff  0.76 0.15 232    The Kimi brand book's #00A1FF, towards its #00F6FF, so
 *                                      it is not Gemini's blue.
 *   copilot   #8534f3  0.55 0.26 296    brand.github.com Copilot: "Copilot Purple" #8534F3.
 *   cursor    #c4bdb0  0.80 0.02 83     Cursor Orange #f54e00 is the meter's orange and, on a
 *                                      light theme, --danger; so its cream canvas #f7f7f4 and
 *                                      warm ink #26251e, as a warm stone.
 *   amp       #789f70  0.66 0.08 140    Amp's orange #f6833b is reserved too; ampcode.com's
 *                                      other colour is a sage (#7fb08a, h151), turned to h140
 *                                      and kept low in chroma, off the meter's green. Its
 *                                      dark theme-color's teal (#091c1e) was tried and came
 *                                      within 0.04 of OpenCode's cyan on a light theme.
 *   kilo      #d4f4bd  0.93 0.08 132    kilocode.ai --brand-primary oklch(95% .15 108), a lemon.
 *                                      On a light theme a lemon solves to an olive between
 *                                      --warning and the meter's green, so +24° and half the
 *                                      chroma: a pale lemon-lime.
 *   aider     #a8e0c3  0.86 0.07 162    Aider's logo #14b014 is the meter's own green (h143),
 *                                      so a pale mint, off its hue and chroma.
 *   crush     #ff60ff  0.75 0.26 328    charmtone Dolly #FF60FF, Charm's pink. Its Charple
 *                                      #6B50FF would be the fifth purple.
 *   droid     #af998f  0.70 0.03 46     Factory's orange #ef6f2e is reserved; its warm greys
 *                                      (#948781, #342f2d), as a taupe.
 *   cline     #e64ead  0.66 0.21 346    cline.bot's purple #9f58fa measured 0.049 from Codex
 *                                      and 0.080 from Copilot; its --brand-pink (245 57 105),
 *                                      turned from h12 (the meter's red) to h346.
 *   auggie    #74b597  0.72 0.08 164    augmentcode.com --primary #1aa049 is the meter's green
 *                                      (h149, C0.17). A vivid green anywhere from h125 to h175
 *                                      reads as the meter on a light theme, and a vivid jade
 *                                      past it came within 0.04 of OpenCode's cyan there; so
 *                                      a muted jade-green.
 *   vibe      #f0ebd9  0.94 0.02 94     Mistral's orange #fa520f and its yellow #ffd900 are
 *                                      reserved (yellow is --warning on a light theme); its
 *                                      cream #fffaeb, as an ivory.
 *
 * Three brands came out neutral — Cursor, Droid and Vibe — because their only
 * colour is the one the meter owns, and the greens (Aider, Auggie, Amp, Kilo)
 * came out muted because the meter owns vivid green. On a dark theme each set
 * is told apart by lightness (stone, taupe, ivory; mint, jade, sage, lime); on
 * a light one every ink is solved to the same 4.5:1, so within a set they read
 * as one colour there — never as one of the common five (asserted).
 */
export const AGENT_SEEDS: Readonly<Record<CodingCliId, string>> = {
  claude: '#de7b2e',
  codex: '#ba66e9',
  grok: '#c8d2e0',
  opencode: '#4bc8d5',
  pi: '#81a9d2',
  gemini: '#4796e4',
  qwen: '#5265f9',
  kimi: '#1fc0ff',
  copilot: '#8534f3',
  cursor: '#c4bdb0',
  amp: '#789f70',
  kilo: '#d4f4bd',
  aider: '#a8e0c3',
  crush: '#ff60ff',
  droid: '#af998f',
  cline: '#e64ead',
  auggie: '#74b597',
  vibe: '#f0ebd9'
}

/**
 * The seeds this table held before it took the vendors' colours (agents
 * format 2). Only `hydrateAgentColors` reads it: a stored override equal to
 * one of these, in a file written before format 3, is a default that was
 * never chosen — the Settings field has never stored a value equal to its
 * seed — so it is dropped once and the agent takes its new colour.
 */
export const PREVIOUS_AGENT_SEEDS: Readonly<Record<CodingCliId, string>> = {
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

/** The agents format whose seeds are `AGENT_SEEDS` (agents.ts `AGENTS_FORMAT`). */
export const BRAND_SEEDS_FORMAT = 3

/**
 * Agents whose vendors' own colours collide, and so were pulled apart by hand
 * in the table above. Each family is held to `AGENT_DISTINCT_DISTANCE`, the
 * common five's floor, seed against seed.
 */
export const AGENT_BRAND_FAMILIES: Readonly<Record<string, readonly CodingCliId[]>> = {
  /** Anthropic, Cursor, Factory, Mistral, Amp, and OpenCode's TUI peach. */
  orange: ['claude', 'cursor', 'droid', 'vibe', 'amp', 'opencode'],
  /** Codex's magenta, Copilot, Cline's site, Qwen's mark, Charm's Charple. */
  purple: ['codex', 'copilot', 'cline', 'qwen', 'crush'],
  /** Gemini, Kimi, Pi, and qwen.ai's own blue. */
  blue: ['gemini', 'kimi', 'pi', 'qwen'],
  /** Aider and Augment, both on the meter's green. */
  green: ['aider', 'auggie']
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

/**
 * Claude Code's floor against `--danger` and `--warning`, per appearance.
 *
 * Not a preference: close to the most any orange can get. `--danger` is a red
 * (h ~30) and `--warning` a gold (h ~82), 50° apart, and an orange sits between
 * them by definition. On a dark theme both are pastels at OKLCH L ~0.80 and the
 * ink is lifted to Lc 60, into their lightness; on a light theme the tag's text
 * is solved to 4.5:1 on the title bar, which lands every orange at L ~0.52 —
 * where `--danger` (a brick) and `--warning` (an ochre) are solved too, and
 * sRGB holds no more than C ~0.13. Swept on 2026-10-01 over hues 50-66, chroma
 * 0.13-0.21 and lightness 0.64-0.80, the best seed measured 0.070 from both on
 * the dark themes and 0.056 on the light ones, and no seed reached 0.08 on
 * either. The seed is that best one (h54), and these floors keep it there —
 * both well over the 0.04 this repo calls "the same colour" (gotcha 44). The
 * meter's red and green still get the full `AGENT_CLEAR_DISTANCE` everywhere.
 */
export const CLAUDE_CLEAR_DISTANCE: Readonly<Record<Appearance, number>> = { dark: 0.065, light: 0.05 }

/** What an agent's colour is kept clear of, by name, on one theme. */
export type ReservedName = 'meter-low' | 'meter-mid' | 'meter-high' | 'danger' | 'warning'

/**
 * The five reserved colours of one theme, exactly as `applyAppearance` paints
 * them: the meter's tiers solved per theme by `meterScale`, and the theme's own
 * `--danger` and `--warning`.
 */
export function reservedColors(theme: {
  appearance: Appearance
  colors: AgentGrounds & { danger: string; warning: string }
}): { name: ReservedName; colour: string }[] {
  const m = meterScale(theme.colors.bg, theme.colors.bgSunken, theme.appearance)
  return [
    { name: 'meter-low', colour: m.low },
    { name: 'meter-mid', colour: m.mid },
    { name: 'meter-high', colour: m.high },
    { name: 'danger', colour: theme.colors.danger },
    { name: 'warning', colour: theme.colors.warning }
  ]
}

/**
 * How far an agent's ink and text must stay from one reserved colour, or null
 * for no floor at all.
 *
 * Everyone is held to `AGENT_CLEAR_DISTANCE` everywhere, except Claude Code:
 * the owner asked for Claude orange, and orange is the meter's middle tier, so
 * that one pairing has no floor; and no orange can clear `--danger` and
 * `--warning` by the full distance, so those two take `CLAUDE_CLEAR_DISTANCE`.
 * Only the AGENT is excepted, never its colour: a Codex the user paints orange
 * is still told it reads as the meter (the colour picker's note).
 */
export function clearanceFloor(key: AgentColorKey, reserved: ReservedName, appearance: Appearance): number | null {
  if (key === 'claude') {
    if (reserved === 'meter-mid') return null
    if (reserved === 'danger' || reserved === 'warning') return CLAUDE_CLEAR_DISTANCE[appearance]
  }
  return AGENT_CLEAR_DISTANCE
}

/**
 * The reserved colours one seed comes too close to on one theme: each one
 * whose distance from the derived ink or text is under `floor`. What the
 * colour picker warns about, and what the suites hold every seed to.
 */
export function reservedNear(
  seed: string,
  theme: { appearance: Appearance; colors: AgentGrounds & { danger: string; warning: string } },
  floor: (reserved: ReservedName) => number | null = () => AGENT_CLEAR_DISTANCE
): { name: ReservedName; distance: number }[] {
  const tokens = agentTokensFor('probe', seed, theme.appearance, theme.colors)
  const ink = parseColor(tokens.ink)
  const text = parseColor(tokens.text)
  const out: { name: ReservedName; distance: number }[] = []
  for (const r of reservedColors(theme)) {
    const at = floor(r.name)
    const c = parseColor(r.colour)
    if (at === null || !c || !ink || !text) continue
    const distance = Math.min(perceptualDistance(ink, c), perceptualDistance(text, c))
    if (distance < at) out.push({ name: r.name, distance })
  }
  return out
}

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
 *
 * `from` is the agents format the block was written in (agents.ts). Below
 * `BRAND_SEEDS_FORMAT` a value equal to that agent's PREVIOUS seed goes the
 * same way — it can only be a default carried in by hand or by an import,
 * since no build ever stored its own seed — so a Claude that was never
 * recoloured turns orange rather than staying pink. Once the block says the
 * new format, the old pink is an ordinary colour: picked on purpose, it stays.
 */
export function hydrateAgentColors(raw: unknown, from: number = BRAND_SEEDS_FORMAT): AgentColors {
  const out: AgentColors = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!isCodingCliId(id) || typeof v !== 'string') continue
    const c = parseColor(v)
    if (!c || c.a < 1) continue
    const hex = toHex(c).toLowerCase()
    if (hex === AGENT_SEEDS[id]) continue
    if (from < BRAND_SEEDS_FORMAT && hex === PREVIOUS_AGENT_SEEDS[id]) continue
    out[id] = hex
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
  return keyed.map(({ key, seed }) => agentTokensFor(key, seed, appearance, grounds))
}

/**
 * One key's tokens from one seed — what `agentColorTokens` does per agent, for
 * a colour that is not stored yet (the picker's preview of the ink Stoke will
 * paint, and `reservedNear`).
 */
export function agentTokensFor(
  key: AgentColorKey,
  seed: string,
  appearance: Appearance,
  grounds: AgentGrounds
): AgentTokens {
  const t = deriveAccent(seed, appearance, grounds.bg)
  return { key, seed, ink: t.accentInk, text: textInk(seed, t.accentInk, appearance, grounds), fill: t.accent }
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
