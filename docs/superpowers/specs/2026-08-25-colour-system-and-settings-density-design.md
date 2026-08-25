# Stoke: colour system, light mode, and settings density

Design, 2026-08-25.

Four complaints arrived together and turn out to share two causes:

1. SSH hosts "look weird all vertically stacked" once there is more than one.
2. Light mode and the themes generally "don't look that good".
3. Claude Code has its own theme — does Stoke need to change that too?
4. The settings sheet is dense, contrast is poor, terminal colours clash with the
   app chrome, and the built-in chrome (browser panel and window chrome) is weak.

The two causes are: **a flat palette with no principled steps**, and **prose that is
repeated once per item**. Everything below is measured. Numbers with no citation came
from `scratchpad/ladder.mts` and the audit scripts, which import the repo's own
`src/shared/color.ts` so nothing here can disagree with what the app itself measures.

## Decisions taken without confirmation

Four choices were put to the user and went unanswered. The recommended option was
taken in each case; each is cheap to reverse and is flagged here so it can be.

- **Dark ladder anchored at Stoke's own floor**, not Radix's `L* 17.7` step 1. A window
  that is mostly a terminal wants a page that does not glow beside the xterm canvas.
  (It turned out to reproduce Radix's gray ladder anyway — see below.)
- **The settings sheet stays one scroll.** Prose gets folded; no section navigation.
- **CLI theme: OSC 11 auto-follow, plus an allowlisted settings row.** Not the
  `--settings` route, for reasons below.
- **Four staged commits with screenshots between**, rather than one big branch.

## Part 1 — what is actually wrong

### 1.1 The light theme is structurally broken, not merely badly coloured

| Defect | Measured |
| --- | --- |
| Elevation ramp collapsed | `bg`/`surface`/`bgElevated` span **0.033** OKLCH L against the dark themes' 0.055–0.068. `bgElevated` is literally `#ffffff`, so there is no headroom. Adjacent contrast 1.05:1 and 1.04:1. |
| Direction inverted | `surface-hover` (L 0.9497) sits **below** `bg` (0.9674) while `surface` (0.9851) sits above it. A `.btn` is lighter-than-page at rest and darker-than-page hovered. |
| Secondary controls invisible | A `.btn`/`.select` fill is **1.04:1** against a sheet and 1.05:1 against the page. The entire boundary is a 1px `--border` at 1.34:1. |
| `--text-faint` fails AA | 3.99 on `bg`, **3.58** on `bg-sunken`, 4.20 on `surface`, 4.38 on `bg-elevated`. 20 usages. `themes.ts:27-29` claims ">= 4.5:1 on bg" — the promise holds only for the one ground it names. |
| Tinted washes fail | `--accent-soft` at 0.10 alpha over a near-white darkens by only 1.14:1, so accent-on-wash **drops** to 3.81 (`.pill[data-tone=accent]`), 4.43 (`.worklog-link`). The same construction on dark yields 5.23–8.73. |
| Semantic text fails on chrome | On `bg-sunken` (titlebar, sidebar, statusbar, worklog, activity): accent 4.35, warning 4.47, success 4.15. |

### 1.2 Borders fail in every theme, and the dark ones are literally invisible

`--border` measures 1.04–1.44:1 across all grounds; WCAG 1.4.11 wants 3:1 for a control
boundary. In APCA terms **Ember's `--border` and `--border-strong` are both `Lc 0.00`
against `bg`** — below the discernibility floor. `--border` is the sole visual boundary
of `.btn`, `.input`, `.select`, `.profile-chip`, `.activity-period` and `.worklog-item`,
across 39 + 17 = 56 usages.

### 1.3 The surface ramps are uneven in every theme

Sorted-by-lightness consecutive step ratios (max/min): Ember **3.5×**, Nocturne **6.3×**,
Moss **6.1×**, Daylight **5.6×**. In all three dark themes the `surfaceHover → border`
step is the smallest (0.012–0.020, contrast 1.04–1.07) while `border → borderStrong` is
the largest (0.070–0.076) — so a border is nearly indistinguishable from the hover state
beside it. This is the measurable form of "the themes look muddy".

### 1.4 The worst defect is on the default path and no suite can see it

A profile auto-activates from the active tab's cwd (`App.tsx:461-476`), and
`applyAppearance` (`lib/theme.ts:44-48`) overwrites `--accent` **with no appearance
check**. All eight profile accents are hand-tuned for dark grounds:

| | on Daylight `--bg` | on Daylight `--bg-sunken` |
| --- | --- | --- |
| Amber `#f7c948` | **1.43:1** | 1.28:1 |
| Work `#5fd08a` | 1.76 | — |
| Personal `#ff9552` | 1.98 | — |
| Study `#2a5f96`-ish | 2.52 | 2.27 |

Those tokens drive `:focus-visible { outline: 2px solid var(--accent) }` (`app.css:209`),
`.ring .ring-fill` (`:1351`), `.tab-indicator` (`:475`) and `.input:focus` (`:825`). At
1.43–2.66:1 **the keyboard focus indicator is effectively invisible** in light mode,
failing WCAG 2.4.11 and 1.4.11.

`verify:profiles:1032` asserts only `accentContrast`-on-`accent` — the ink on the fill.
Nothing in any suite asserts an accent against any background, so `npm run check` passes.
This is CLAUDE.md gotcha 31 again: a side effect inside a closure, invisible to a pure suite.

### 1.5 The light terminal palette inverts its own emphasis channel

All eight of Daylight's "bright" ANSI colours are **lighter** than their normals
(dL +0.073 to +0.099), so contrast **falls** in all eight: red 5.46→4.03, green
4.61→3.38, cyan 5.41→3.77. Five of eight land under 4.5:1. Bright is the terminal's
emphasis channel (SGR bold), so **emphasised text is the least legible text**.

Worse: terminal `white` `#dedee1` is **1.22:1** and `brightWhite` `#ffffff` is **1.10:1**
against the terminal background. Anything emitting `ESC[37m` or `ESC[97m` is invisible.
The dark themes put the same slots at 12.06:1 and 17.61:1.

### 1.6 Two claims that were refuted, recorded so nobody re-derives them

- **"Daylight's cool grey is fighting the orange accent."** False as a mechanism. Hue
  *distance* at negligible chroma is not hue *conflict*: Daylight's `bg` is Tailwind
  `zinc-100` exactly, and zinc-100 + orange-600 (114.7°), slate-50 + orange-600 (153.3°)
  and Radix slate-1 + tomato-9 (145.5°) are all ordinary shipped pairings at equal or
  greater separation. Warming the neutrals is an **identity** choice, not a contrast fix,
  and is justified below on that basis alone.
- **"Bright ANSI variants are darker on light backgrounds."** False as a general rule —
  39 of 48 chromatic pairs across eight well-regarded light schemes are lighter. But the
  consequence holds: bright is strictly lower-contrast in 25 of 48, and the only scheme
  where all twelve chromatic slots clear both `Lc 60` and 4.5:1 is **Xcode Light**, which
  is precisely the one whose brights are darker or identical, with every slot compressed
  into `L* 41–56`.

### 1.7 The SSH complaint is not about stacking

One host card is **280.95px** at Interface scale 1.0. Of that, **123.83px (44%) is prose
that is byte-identical on every host** and references nothing about the host it sits
under: a 312-character byobu paragraph (`HostsSettings.tsx:269-275`) and a worklog
`FieldHint` (`:294-304`). 591 characters / ~105 words, repeated per host.

Section height: **393px** at 1 host, **971px** at 3, **2993px** at 10. The sheet body
viewport is `innerHeight - 61` ≈ 879px at the default window. **At three hosts this one
section is taller than the entire settings panel**, and it is one of about twenty.

Widening does not fix it: card height at sheet widths 416/480/544/640/768px measures
280.95 / 263.91 / 263.91 / 246.86 / 246.86 — **an 85% wider sheet buys 12%**, because
193px of the card is fixed-height controls, gaps and padding that do not reflow.

Commit `2febab8` ("Fold the long settings explanations behind a disclosure") converted
the section-level hints in this exact file and **left the one hint that gets multiplied
by N**.

Two further defects: the three inputs are **placeholder-only**, so once filled they are
three unlabelled boxes; and `ProfilesSettings.tsx:288-295` carries a **byte-identical
copy** of the host card's inline style object (gotcha 22's exact hazard).

### 1.8 The settings sheet's biggest section is not the one that was reported

Measured by rendering the real components with the real stylesheet:

| Section | 0 items | 3 items |
| --- | --- | --- |
| **WorklogSettings** | **775.30px** | **927.44px** |
| Profiles | 174.43px | 557.26px |
| Remote machines | 145.81px | 392.67px |
| Hidden projects | 81.20px (constant) | — |
| Scanned folders | 36px per root | — |

Only ~57px per profile of WorklogSettings is the check-row; the other ~757px is fixed,
including **341px of un-disclosed `.field-hint` prose**. Total sheet scroll is **6690px
in an 809px viewport** — 8.3 screens.

## Part 2 — the token ladder

### 2.1 Shape

Adopt Radix's twelve-step semantics, because the point of it is that **a component names
a step and never a value**, so no component needs a per-appearance rule:

| Step | Role |
| --- | --- |
| 1 | app background |
| 2 | subtle background |
| 3 | UI element background |
| 4 | hovered UI element background |
| 5 | active / selected UI element background |
| 6 | subtle borders and separators (non-interactive) |
| 7 | UI element border and focus rings |
| 8 | hovered / stronger interactive border |
| 9 | solid background — the brand colour, **byte-identical in both appearances** |
| 10 | hovered solid background |
| 11 | low-contrast text — guaranteed `Lc 60` on step 2 |
| 12 | high-contrast text — guaranteed `Lc 90` on step 2 |

Steps 1–8 are an **even ramp in OKLCH L**. That is the fix for §1.3: no two adjacent
steps can be closer than any other pair. Steps 11 and 12 are not chosen but **solved**,
by bisecting for the L that hits `Lc 60` / `Lc 90` against step 2.

### 2.2 Rungs (OKLCH L)

Derived, not copied. Dark is anchored at Ember's existing `bgSunken` (L 0.1564) with
span **0.34**; light is anchored at L 0.9910 with span **0.17**. Spans were swept and
chosen as the smallest that clear the border thresholds:

```
dark  1..8:  0.1564 0.2050 0.2536 0.3021 0.3507 0.3993 0.4479 0.4964
light 1..8:  0.9910 0.9667 0.9424 0.9181 0.8939 0.8696 0.8453 0.8210
```

Resulting neutrals at hue 55 (chroma 0.0022 → 0.0078 across steps 1–8):

```
dark   1 #0d0c0c  2 #181716  3 #242221  4 #302e2c  5 #3d3a38  6 #4a4744  7 #585451  8 #66615e
       11 #b6b2b0 (L 0.7666)   12 #eae4e0 (L 0.9216)
light  1 #fdfcfb  2 #f6f3f2  3 #eeebe9  4 #e6e3e1  5 #dfdbd9  6 #d7d3d0  7 #d0cbc8  8 #c9c3c0
       11 #837f7d (L 0.6008)   12 #3c3735 (L 0.3423)
```

**Validation of the anchor choice.** The derived dark ladder lands within a few units of
Radix's own gray scale (Radix dark 1 `#111110`, 2 `#191918`, 8 `#706f6c`) while starting
from Stoke's floor rather than Radix's. The decision in §"Decisions taken" cost nothing.

### 2.3 What the ladder fixes, measured

| | Ember today | Ladder (dark) | Daylight today | Ladder (light) |
| --- | --- | --- | --- | --- |
| Step evenness | 3.5× | **1.00×** | 5.6× | **1.00×** |
| `border` on page (APCA) | **Lc 0.00** | **Lc 15.0** | Lc 10.3 | **Lc 20.6** |
| `border-strong` on page | Lc 0.00 | Lc 20.3 | Lc 25.6 | Lc 24.9 |
| `border-subtle` on page | — | Lc 10.0 | — | Lc 16.1 |
| Surface ramp span | 0.203 | 0.340 | 0.181 | 0.170 |

`Lc 15` is APCA's discernibility floor for dividers and rings. `Lc 20.6` matches
Primer's `--borderColor-default` at Lc 20.5 exactly.

### 2.4 Aliasing, so `app.css` does not change all at once

The twelve steps are written to `:root` as `--step-1 … --step-12` per scale. The existing
eighteen token names become **aliases**, and the alias map is the only thing that differs
between appearances — one ~12-line block, rather than a per-appearance rule in every rule
that uses a colour.

| Token | Dark | Light | Note |
| --- | --- | --- | --- |
| `--bg-sunken` | 1 | 3 | chrome: titlebar, sidebar, statusbar |
| `--bg` | 2 | 2 | the page |
| `--bg-elevated` | 3 | 1 | floating: sheet, palette, context menu |
| `--surface` | 3 | 1 | control at rest |
| `--surface-hover` | 4 | 3 | |
| `--surface-active` | 5 | 4 | **new** — today this is an inline `color-mix` |
| `--border-subtle` | 6 | 6 | **new** — separators |
| `--border` | 7 | 7 | control boundary |
| `--border-strong` | 8 | 8 | |
| `--text-faint` | 10 | 10 | of the *neutral* scale |
| `--text-muted` | 11 | 11 | `Lc 60` guaranteed |
| `--text` | 12 | 12 | `Lc 90` guaranteed |

**The light column deliberately breaks "lighter means raised."** In light mode there is
no headroom above white, so the rule becomes: **interaction darkens; elevation is carried
by border and shadow.** This is Material 3's model (light containers go 98 → 90, *darker*,
while dark containers go 6 → 22, lighter) and it is what removes the §1.1 inversion.
It has to be stated, because it is the one place the two appearances genuinely disagree.

### 2.5 Chroma budget

Neutral chroma stays at or under **0.016**. Calibration at L* 96, hue 55: `C 0.002`
reads as neutral, `C 0.010` as perceptibly warm, `C 0.020` as cream, `C 0.030` as peach.
Ember's own `bg` is already `C 0.0064` and reads as neutral, so the ladder's 0.0022 →
0.0078 profile keeps the warmth Ember has without entering the cream band the existing
`themes.ts:170-174` comment was right to avoid. **Daylight inherits that warmth** — an
identity change, made on identity grounds (§1.6), not contrast grounds.

### 2.6 Accent derivation, and the fix for §1.4

Profiles stop storing four hand-authored hexes and store an **accent hue plus optional
chroma**. The four `--accent-*` properties are derived at apply time from the active
theme's appearance. With `away = -1` in light and `+1` in dark:

```
solid       = the user's colour verbatim              (step 9, identical in both modes)
hover       = L + away*0.035                          (step 10)
active      = L + away*0.070
text        = the L, searching away from the page, where |Lc| = 60
textStrong  = the same at |Lc| = 75
soft        = pageL + away*0.035 at C 0.040 (light) / 0.045 (dark)
softHover   = pageL + away*0.060 at C 0.055 / 0.060
border      = the L where |Lc| = 25
focusRing   = the L where |Lc| = 35
```

Every chroma is clamped by bisection against the sRGB gamut — authoring out of gamut is
not a near miss but a different colour: `oklch(0.62 0.30 55)` paints back as hue **29.3°**,
a 26° error no contrast calculation would predict.

`accentContrast` is picked as whichever of near-white or near-ink has the higher `|Lc|`
on the solid, **and then validated to clear Lc 60** — there is a ~7 L* dead band (roughly
L* 66–78 by hue) where neither does. If a user's accent lands in it, the **solid** is
nudged out rather than the label accepted as illegible. `contrast-color()` cannot help:
it returns only black or white and has the same blind spot.

`--accent-soft` is the one existing token that already works in both appearances, and it
works because it is **alpha**, not because it was tuned: `rgba(255,149,82,0.14)` is
+9.58 L* over Ember and −3.09 L* over Daylight. An alpha token self-corrects its
direction against whatever it sits on. Alpha variants are therefore added for neutral
steps 3–8 and the accent's soft/border steps.

### 2.7 Light-mode elevation, shadows and scrim

- **Border first, shadow second, lightness third.** The surface step alone measures
  `Lc 0.00` in light mode (Stoke `#f4f4f5 → #ffffff`; Primer `#ffffff → #f6f8fa`), so a
  1px border at `Lc ~20` does the actual work.
- **Shadows tinted with the theme's own ink, never `#000`**: 3–5% for resting-small,
  10–12% for resting-medium, 24–33% for floating, and every floating shadow starts with a
  `0 0 0 1px` ring layer — that ring is where the visible edge comes from. Vertical offset
  stays 2× the horizontal across the whole set so the light source is consistent.
- **The light scrim becomes a light tinted grey**, not translucent black. Primer uses
  `#c8d1da66`, composing to L* 94.3 over white; a 40% black scrim takes the page to
  L* 68.3, which reads as a different app rather than a dimmed one. Stoke's light `--scrim`
  is `rgb(0 0 0 / 0.28)` today.

### 2.8 Semantic colours in light mode

Warning gets its own rule: **the accessible light-mode warning *text* colour is a brown,
not a yellow.** Yellow's sRGB chroma cusp is at L* 90.8 but the highest L* clearing
`Lc 60` on near-white is 63.20, which is an olive. Primer uses `#9a6700`. The yellow
itself appears only as a soft background tint at L* ~97, C ~0.066, with a matching border
— and never carries meaning without an icon or label beside it.

Each soft tint is re-checked against **the tint**, not against white: Primer's pairs land
at 4.52–4.57:1 / `Lc 64.9–68.3` on their own tint.

`--info` is **deleted**. It is defined in all four themes and referenced nowhere
(`grep -rn 'var(--info)' src/` → 0). Nocturne's `info` equals its `accent` and Moss's
`success` equals its `accent`, so a success chip and an accent chip are the same colour
in Moss — resolved by the semantic scales.

### 2.9 Terminal palettes

- **Light:** compress all twelve chromatic ANSI slots into **L* 41–58** on a background at
  L* 97–100, and make each bright **identical to or 8–14 L\* darker than** its normal. That
  is Xcode Light's shape and it is the only one of eight schemes where every chromatic slot
  clears both `Lc 60` and 4.5:1. Per-hue chroma budget, not one global saturation: at L* 50
  sRGB allows C ~0.20 for red/magenta/violet but only ~0.09–0.13 for yellow/teal/cyan.
- **Invert the achromatic slots explicitly**, which is the inversion that actually matters:
  `black` → light grey (L* 80–87), `brightBlack` → mid grey (L* 67–77), `white` → the ink
  (L* 27–49), `brightWhite` → the darkest ink. Three of the eight schemes measured do
  exactly this and they are the ones that look right.
- **Dark:** raise nothing structurally; the dark ANSI sets already measure well.

## Part 3 — the Claude Code CLI's own theme

### 3.1 Where it lives

`theme` is a real zod key in **`~/.claude/settings.json`**, not `~/.claude.json`:

```
theme: Fs([Hr(S0n), H().startsWith("custom:")…]).optional().catch(void 0)
S0n = ["auto", "dark","light","light-daltonized","dark-daltonized","light-ansi","dark-ansi"]
```

`.catch(void 0)` means an out-of-vocabulary value is **silently dropped**, exactly like
`effortLevel` in gotcha 39. `custom:<slug>` additionally resolves to
`<config-dir>/themes/<slug>.json`. Measured: driving the real onboarding picker to
"Light mode" wrote `{"theme":"light"}` to `settings.json` and nothing to `.claude.json`.

The `~/.claude.json` path still exists but is dead-ended by its own default — `lpe()` sets
`theme:"dark"` and the resolver only accepts a global-config value that *differs* from
that default. **Anything Stoke ever writes for theme belongs in `~/.claude/settings.json`**,
which needs only temp+rename, not gotcha 38's lock protocol.

### 3.2 Why not the `--settings` route

It works — measured both directions: `--settings {"theme":"auto"}` beat
`settings.json {"theme":"light"}`, and the reverse pairing beat `auto`. It is rejected
anyway, for three reasons:

1. It **outranks the user's own `/theme` forever** (flagSettings sits above
   user/project/local; only managed policy beats it).
2. It leaves the session **visibly inconsistent**: several CLI render helpers call
   `resolveSetting("theme")` directly in their render body rather than reading the React
   theme context, so a mid-session `/theme` would leave those painting the pinned value.
3. It does **nothing for SSH tabs** — `pty.ts:215-218` builds an SSH tab's argv from
   `buildSshArgs`, and `--settings` is pushed only inside `buildArgs` (`cli.ts:273`),
   which that branch never reaches.

If it is ever added anyway, `theme` must go onto `NEVER_OFFERED` in the same change, per
gotcha 39.

### 3.3 The OSC 11 route, which is already free

With the resolved theme at `auto`, the CLI sends `ESC]11;?BEL` followed by `ESC[c` as a
flush sentinel and classifies the reply by `0.2126r + 0.7152g + 0.0722b > 0.5`.
**xterm.js 6.0.0 — the version Stoke ships — already answers that truthfully from the
`theme.background` Stoke sets in `terminalTheme()`.** All four Stoke backgrounds classify
correctly under the CLI's own rule.

So on `auto`, the CLI already follows Stoke, on **local and SSH tabs alike**, with no
plumbing at all. Measured end to end: answering white flipped the live palette to light,
black kept it dark.

Two additions make it complete:

- **Live switching.** The CLI enables DEC private mode 2031 on every raw-mode enter and
  re-queries OSC 11 on any `CSI ?997;{1,2}n`. **xterm.js knows nothing about 2031** — the
  strings `2031` and `997` do not appear in its bundle — so Stoke synthesises the report
  itself, writing `\x1b[?997;1n` (dark) or `\x1b[?997;2n` (light) into each PTY when the
  appearance changes. Gate it on a PTY having emitted `\x1b[?2031h` and not since
  `\x1b[?2031l`, or a byobu tab sitting at a bare shell gets the bytes typed at its prompt.
- **A settings row.** Add a `theme` enum to `CLAUDE_SETTINGS` in
  `src/shared/claudeConfig.ts` — options as `S0n` above, `silentlyDropsBadValues: true`,
  `unsetMeans: 'dark'`, and `auto` labelled **"Match Stoke"**. It writes through the
  existing `claudeSettings.ts` allowlist to the same file the CLI's own picker writes, so
  the two can never fight.

`COLORFGBG` is added to the PTY env (`0;15` for a light theme, `15;0` otherwise) as a
local-tab backstop — it is exactly what the CLI checks when OSC 11 goes unanswered. It
will not reach an SSH session without `SendEnv`/`AcceptEnv`.

### 3.4 The honest limit on "terminal colours clash with the app chrome"

**Only `dark-ansi` and `light-ansi` consume Stoke's sixteen ANSI slots.** The other four
CLI themes hardcode truecolor `rgb(...)` for all 72 palette keys and cannot be influenced
by anything Stoke does. That includes background fills — `composerSidebarBackground
rgb(38,38,38)` and `userMessageBackground rgb(55,55,55)` on dark, `rgb(245,245,245)` /
`rgb(240,240,240)` on light — drawn as neutral greys over Stoke's tinted backgrounds.
Ember and Daylight are close; **Moss and Nocturne will show a visible cast.**

So the settings row's hint says so plainly: picking `dark-ansi`/`light-ansi` is the only
way to make the CLI use Stoke's palette, and it costs the CLI's syntax highlighting
(`gsw()` returns `"ansi"` for any theme name containing `ansi`, versus `"Monokai
Extended"` / `"GitHub"`). That is a trade the user should make, not Stoke.

## Part 4 — SSH hosts and settings density

### 4.1 Hosts: extract the prose, then collapse the rows

**Step one, ~15 lines, no CSS.** Move the byobu paragraph and the worklog `FieldHint` out
of `hosts.map` and state them **once**, beside the section-level `FieldHint`, worded for
the set rather than the instance, with the long half behind the existing
`<FieldHint more={…}>`. `unknownAlias` stays inside the map — it is the one hint that is
genuinely per-host. Measured effect: card **280.95 → 146.15px**, ten hosts
**2993.25 → 1645.25px**.

> A verifier caught an arithmetic slip here: the first estimate said ~1550px for ten
> hosts. 10 × 134.80 = 1348, and 2993.25 − 1348 = **1645.25**. Recorded because the
> optimistic figure was 6% out.

**Step two: collapsed `<details>` summary rows.** The card becomes
`<details className="host-item">`; the summary carries `{label || alias || 'New machine'}`,
a truncated `<span className="mono">{alias} — {command || 'login shell'}</span>` and a
worklog dot; the controls move into the body. `open={host.alias === ''}` so a just-added
host is not silently collapsed. The remove button moves **into the body** — left in the
summary it toggles the disclosure unless it calls `preventDefault`.

Measured: **206 / 282 / 548px** at 1 / 3 / 10 hosts (−47% / −71% / −82%), one open row
+172px. Native `<details>` keeps keyboard operation, screen-reader announcement and
Cmd+F-inside-closed — the argument `FieldHint.tsx:17-21` already makes, and the reason not
to reach for `useState`.

**Step three: give the inputs visible labels.** Three placeholder-only boxes become three
unlabelled boxes the moment they are filled.

Rejected: a compact grid (measured 225/289/513px, but its three columns come out ~102px
at the current 416px sheet — about 10 monospace characters, so `tmux new -A -s stoke` and
`deploy@10.0.0.4` both clip); and master-detail (no room in 416px; the editor ends up
*taller* than today's card, and it needs a new overlay component since `.sheet` is the
only overlay shape in the app).

### 4.2 Lift the shared card into a real class

`app.css:1803` already names "the settings sheet, profiles and hosts lists" as one family.
The byte-identical inline style object in `HostsSettings.tsx` and
`ProfilesSettings.tsx:288-295` becomes `.settings-item`, so the collapsing added for hosts
is available to profiles when they grow (ten profiles measures 1258px today). That also
removes two inline style objects — gotcha 22's exact hazard.

### 4.3 WorklogSettings is the real density problem

775px empty, 927px at three profiles, including **341px of always-open `.field-hint`
prose**. Fold it behind the disclosure the app already ships (`.cc-details` /
`.cc-summary`, whose own comment records that `.sheet-body` is one flat column so anything
long has to fold itself away).

## Part 5 — chrome

### 5.1 The docked browser panel

Two full chrome rows ≈ 190 CSS px before any page content, in a panel that is often
narrow. The controls are grouped arbitrarily: zoom in/out sit on the **tab** row while
find / open-externally / close sit on the **address** row. Collapse to one row and
regroup: navigation left, address centre, page actions right; move zoom and devtools
behind an overflow.

Separately, the browser `WebContentsView` is **entirely unthemed** — `browser.ts:198`
`setBackgroundColor('#00000000')` is the file's only colour reference, and
`nativeTheme.themeSource` is never set, so a loaded page's `prefers-color-scheme` follows
the OS and can disagree with Stoke. Setting `nativeTheme.themeSource = theme.appearance`
beside the existing `titleBarOverlay` repaint (`index.ts:1248`) makes the seam follow the
app for every site that honours the query.

### 5.2 Window chrome

Re-judged once the ladder lands, since most of what reads as "unpolished" is the flat
palette: the sidebar and main column are 232 vs 244 in light mode — a 5% separation
carrying the app's primary structural boundary.

Also fix `index.ts:1161`, which hardcodes Ember's `bg` and `text` for the QR code — the
last hardcoded colour in the main process.

## Part 6 — a Claude-aligned theme pair

Added as **a choice, not a default**. Ember stays the identity. Anthropic's official
palette: Dark `#141413`, Light `#faf9f5`, Mid Gray `#b0aea5`, Light Gray `#e8e6dc`,
accent Orange `#d97757`, Blue `#6a9bcc`, Green `#788c5d`.

Note the tension worth naming: `#faf9f5` is a **warm** off-white — precisely the band
`themes.ts:170-174` deliberately avoided. At C ≈ 0.006 it sits below the cream threshold
(measured named creams start at seashell C 0.0143), so the existing comment's goal
survives; §1.6 already establishes that the avoidance was aimed at the wrong target.

## Part 7 — verification

CLAUDE.md gotcha 31 is the governing rule: everything in Part 1 is a side effect inside a
function whose return value is correct, so a pure suite cannot see it. Both halves are
therefore required.

### 7.1 Measured suites

`verify:color` gains assertions for what it has never checked:

1. every text token against **every background token it actually renders on**, ≥ 4.5:1;
2. every ANSI colour against `terminal.background` (today only against the composited
   *selection*), ≥ 4.5:1 with an explicit exemption list for `black`;
3. `--border` / `--border-strong` against every ground, at the APCA floors in §2.3;
4. `--accent` against `--bg` / `--bg-sunken` / `--surface`: ≥ 3:1 as a focus ring, ≥ 4.5:1
   where it is text;
5. **the ladder itself** — every step's measured OKLCH L within 0.5 of its rung, neutral
   chroma ≤ 0.016, step 11 ≥ `Lc 60` and step 12 ≥ `Lc 90` on step 2, every derived accent
   role hitting its target Lc, and no solid fill landing inside the dead band.

`verify:profiles` gains **accent-against-background for all eight swatches in both
appearances** — it already imports `BUILT_IN_THEMES` and uses it only for an unasserted
printout. This is the assertion that would have caught §1.4.

A new suite covers `validateTheme`, currently the least-tested load-bearing colour code in
the repo: its `pick()` silently fills any new token into every stored custom theme, which
is exactly what this redesign relies on and which nothing asserts.

### 7.2 Before any OKLCH work

`src/shared/color.ts`'s `parseColor` returns **null** for `oklch()`, `oklab()` and
`color(display-p3 …)`, and Chromium 150 keeps computed colours in `oklch()` serialisation.
Authoring tokens in OKLCH without fixing this would make every contrast reading in the
design-audit path — including `browser_design` and `verify:color` — silently return null
while still "working". **`parseColor` is taught the three functional forms first.**

Tokens are authored in OKLCH but **resolved to sRGB hex at generation time**, so nothing
at runtime depends on the browser's colour parsing. Any runtime blend uses
`color-mix(in oklch, …)`, never `in srgb`: mixing `#ca6800` with white 50/50 gives hue
55.1 in oklch and 68.3 in srgb, a 13° shift — enough to make a hover state look like a
different colour.

Electron 43.2.0 is Chromium 150.0.7871.129 and supports `oklch()`, `color-mix(in oklch)`,
relative colour syntax, `light-dark()`, `contrast-color()` and Display-P3 — verified by
`CSS.supports` in a real window.

### 7.3 Screenshots

Per CLAUDE.md, the terminal is a WebGL canvas and the CSS reads correct while laying out
wrong, so each stage is driven over CDP against the built app and read from screenshots
and `getBoundingClientRect`, not from the diff. Host-section heights are re-measured at
1, 3 and 10 hosts; §1.7's assertion about folded prose is checked against `innerText`
length rather than height, because a closed `<details>` still reports a non-zero
`getBoundingClientRect` height in Chromium.

## Part 8 — sequence

| Stage | Contents | Gate |
| --- | --- | --- |
| 1 | Correctness that does not need the ladder: the profile-accent leak, `text-faint`, terminal whites/brights, `parseColor` for OKLCH, and Part 3's CLI theme work — **plus the verify assertions that should have caught each one**. | `npm run check` |
| 2 | The generator, the ladder, all four themes repainted, **the border fixes** (§1.2 needs the ladder to fix properly), the Claude-aligned pair, light-mode shadows/scrim. | check + screenshots of every theme |
| 3 | SSH hosts, `.settings-item`, WorklogSettings folding. | check + host heights at 1/3/10 |
| 4 | Browser panel chrome, window chrome, `nativeTheme.themeSource`, the QR colours. | check + screenshots |

Stage 1 is deliberately first and separately committable: it is all measured bugs, it
changes no visual identity, and it installs the tests that make stage 2 safe.

The CLI theme work (Part 3) rides along in stage 1 for the settings row and the
`CSI ?997` nudge, since neither depends on the palette.

## Open questions

None blocking. The four decisions in the preamble were taken on recommendation and are
individually reversible; the dark-floor one has since been shown to cost nothing (§2.2).
