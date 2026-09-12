---
paths:
  - "src/shared/themes.ts"
  - "src/shared/ladder.ts"
  - "src/shared/themeGen.ts"
  - "src/shared/accent.ts"
  - "src/shared/profiles.ts"
  - "src/main/settingsSchema.ts"
  - "src/remote/main.ts"
  - "src/remote/style.css"
  - "src/renderer/src/lib/theme.ts"
  - "src/renderer/src/components/ThemeEditor.tsx"
  - "scripts/gen-themes.mts"
  - "scripts/verify-color.mts"
  - "scripts/verify-profiles.mts"
  - "scripts/verify-settings.mts"
  - "scripts/verify-theme-gen.mts"
  - "src/shared/meter.ts"
---

# Palette and accents

The generated palette (ladder, themeGen), accent ink vs fill, and contrast floors. Loaded when a
file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are permanent — code
comments cite them as "CLAUDE.md gotcha N".

## 43. The palette is generated now, so do not hand-edit a hex in `themes.ts`

**The palette is generated now, so do not hand-edit a hex in `themes.ts`.** Every value comes
from `src/shared/ladder.ts` — Radix's twelve steps, steps 1-8 an even ramp in OKLCH L and
steps 10-12 bisected against a contrast target. Editing a hex reintroduces exactly the class
of defect the ladder exists to prevent, and it will not be visible: the hand-picked palette
passed every suite in the repo while its borders measured **APCA Lc 0.00** against their own
page and its ramps were uneven by 3.5x to 6.3x.

Three things about it that are counter-intuitive enough to be worth stating.

**The light and dark step maps disagree on purpose.** In dark mode raised means lighter. In
light mode there is no headroom above white, so **interaction darkens** and elevation is
carried by border and shadow — the surface step alone measures Lc 0.00 there and cannot do
the job. That is Material 3's own conclusion (light containers run 98 -> 90, dark ones
6 -> 22) and it is what removes the inversion where Daylight's `surfaceHover` sat below `bg`
while `surface` sat above it.

**The text rungs are solved against step 4, not against the page.** Step 4 is the hardest
ground text lands on in either appearance — `surfaceHover` in dark, `bgSunken` in light.
Solving against the page is exactly how `--text-faint` came to promise 4.5:1 "on bg",
deliver 5.10 there, and measure 3.99 on a hovered row. And the targets are WCAG ratios, not
APCA: solving for Lc 60 alone lands light-mode muted text at 3.59:1, because APCA is content
and WCAG is not.

**A light terminal's bright slots must be DARKER.** `bright` is what SGR bold selects, so it
has to gain contrast, which on a light ground means moving away from white. Daylight had all
eight brights lighter than their normals, so bold text was the least legible text on screen.
The four greys are one monotonic ramp with `black` always darkest; inverting the pair as
Catppuccin Latte does was measured and rejected, because it moves the problem to `black` at
1.52:1 rather than fixing it.

`src/remote/style.css` carries a HAND COPY of Ember's fourteen tokens and no suite can see
it — the mobile bundle is built separately and shares no module with the renderer. It had
drifted to the pre-ladder values. Regenerate it whenever the themes move.

**The generator this entry and `themes.ts` both told you to use did not exist, and that is
now fixed rather than merely noted.** `themes.ts` opened by saying every hex was generated
from one hue plus one accent and directed the reader to "change its hue or its accent in
`scripts/`-adjacent generation and regenerate" — but `neutralTokens` and `terminalPalette`
were exported from `ladder.ts` with **zero callers** anywhere in `src/` or `scripts/`. The
values were produced once by something never committed, so the documented way to change a
theme could not be followed and the only available way was the hand-edit this entry forbids.
`src/shared/themeGen.ts` is that generator; `verify:theme-gen` asserts it reproduces all
twelve neutral tokens of all six built-ins **byte-identically**, which both proves the
original claim was true and pins the ladder so a future change cannot quietly move six
shipped themes. The hues it needs were recovered by sweep, not guessed: Ember 55, Nocturne
253.5, Moss 146, Daylight 55, Clay 50.5, Paper 74.5, all exact.

**"The themes all look the same" was a measurable fact, not taste, and the cause is one
constant.** `NEUTRAL_CHROMA`'s page step is C 0.0022 — its own comment calls C 0.002
"imperceptible" — so the neutral hue had almost nothing to act on: every dark built-in's page
measures C 0.003-0.005 across a 200-degree hue spread, and **Ember and Clay ship a
byte-identical `bg` and `text`** (`#181716` / `#e3ddd9`) while nominally being a warm grey and
a terracotta. Picking different hues could never have separated them. `ladder.ts` now takes a
`tint` multiplier over both chroma profiles, defaulting to 1 so every pre-existing theme
regenerates unchanged, and the ceiling is 2.5 because that is measured: sweeping every hue in
both appearances, the worst `border` sits at Lc 15.0-15.1 throughout and falls under the floor
at **tint 2.85**. There is almost no headroom to spend because `RAMP`'s span was chosen as the
smallest that clears Lc 15 in the first place.

Two smaller things found while building it. The semantic colours are solved to **|Lc| 64 on
dark and 72 on light**, not `semantic()`'s own default of 60 — measured off all twenty-four
shipped values, and using the default reproduces none of them. And **`borderSubtle` is not
held to the Lc 15 border floor**: it ships at Lc 10.2-10.5 on every dark theme, `RAMP`'s
comment only ever claims the floor for steps 7 and 8, and a contrast check that included it
failed all four dark built-ins — a wrong floor rather than four wrong themes.

**`Theme` gained a `seed`, and `validateTheme` is a whitelist, which is a trap worth naming.**
It rebuilds a fresh object from named keys rather than spreading its input — right for
something parsing a hand-editable file, and exactly why the editor's saved seed was silently
dropped on the next read, putting the sliders back in the wrong place with no error anywhere.
Adding a field to `Theme` means adding it there in the same change. Found by driving the built
app and reading the value back out of `window.stoke.settings.get()`; no suite saw it until one
was written for it.

**Two seed fields were added after the ladder shipped, and both exist because a hue on
its own could not tell one dark theme from another.** `pageChroma` puts a FLOOR under the
first four steps' chroma (`chromaAt(i) = max(NEUTRAL_CHROMA[i] * tint, pageChroma)`), which
is the difference between Lagoon reading as teal and reading as a grey with a teal accent —
`tint` scales a profile whose page step is C 0.0022, so multiplying it can only ever move a
number that small. `black: true` starts the ladder at L 0.1 rather than RAMP's own first
rung, for a page that is nearly black. `validateSeed` clamps both (`PAGE_CHROMA_MAX` 0.045
dark / 0.015 light) and refuses `black` on a light theme, where it means nothing.

Two measurements sit behind those numbers, and neither is guessable. **L 0 is unusable:**
APCA soft-clamps black, so a ladder that starts at exactly 0 measures its own `borderSubtle`
at Lc 0.00 against its own page — precisely the defect the ladder exists to prevent.
`BLACK_FROM = 0.1` was picked by sweeping, not chosen. And **more chroma, or a lower start,
pushes the step-6 and step-7 borders under the Lc 15 floor**, so `neutralLadder` now solves
those two rungs against the page (`solveLc`) instead of reading them off RAMP, with step 8
kept above step 7 by construction. That is what lets `verify:theme-gen` sweep 1512 seeds —
every hue against both appearances, tint to its 2.5 ceiling, pageChroma to its own — and
have none of them breach a floor. Fixing a failing sweep by lowering the ceilings would have
been the wrong repair twice over: the ceilings are what make the themes distinguishable.

**`scripts/gen-themes.mts` is how a theme literal is produced now.** It reads the seed off
the theme itself for anything already shipped, so gotcha 43's "regenerate" instruction is a
command you can actually run: `node scripts/gen-themes.mts lantern`, or `--all`. A candidate
that is not in `themes.ts` yet lives in that file's own `NEW_SEEDS` array until it is pasted
in, after which it is read from `BUILT_IN_THEMES` like the rest.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The phone now paints the desktop's live theme. `src/main/remote/server.ts:490` serves `GET /api/theme`, and `loadTheme()` in `src/remote/main.ts:125-141` writes every token onto `:root`. `src/remote/style.css:6-11` now calls its fourteen lines a first-frame fallback only ('drift here costs one frame'). The fourteen values do still match Ember.
> - `BUILT_IN_THEMES` now has twelve themes (`src/shared/themes.ts:846-859`: the original six plus Lantern, Graphite, Lagoon, Rose, Ink and Mist). `scripts/verify-theme-gen.mts:50,71` checks every one against its own `seed`, but only for the twelve neutrals, the accent, and the terminal background and foreground (:74-84). A hand-edited semantic or ANSI hex still passes.
> - The floor covers steps 1-5. `chromaAt` applies it for `i < 5` (`src/shared/ladder.ts:289`), and the `PAGE_CHROMA_MAX` doc comment (`ladder.ts:157`) says 'steps 1-5'.
> - Step 6 (`borderSubtle`) is solved to `BORDER_SUBTLE_LC` = 9.5, not 15. Only step 7 uses `BORDER_LC` = 15 (`src/shared/ladder.ts:210-212, 307-315`). Both rungs are still read off RAMP and only moved outward when they fall short, so the historical seeds come out unchanged.
> - `NEW_SEEDS` in `scripts/gen-themes.mts:22-29` still lists all six themes that have since been pasted into `BUILT_IN_THEMES` (lantern, graphite, lagoon, rose, ink, mist), and line 81 concatenates the two lists. So `node scripts/gen-themes.mts lantern` (the entry's own example) prints the LANTERN literal twice, and `--all` prints those six twice. After a seed edit in `themes.ts`, the second copy comes from the stale `NEW_SEEDS` seed.
> - The sweep steps hue by 15 degrees, not every hue (`scripts/verify-theme-gen.mts:148`). That gives 24 hues x 7 tints x 3 page chromas x black on/off for dark = 1512. A breach at a hue between grid points would not be caught, and a hue-specific 8-bit rounding breach is exactly the failure this entry describes.

## 44. `--accent` is a fill and `--accent-ink` is a foreground, and they cannot be one token

**`--accent` is a fill and `--accent-ink` is a foreground, and they cannot be one token.**
A profile auto-activates from the active tab's cwd and `applyAppearance` used to write its
four hand-authored hexes onto `:root` with no appearance check. Every profile accent is
tuned for a dark ground, so on the light theme they measured **1.43:1 to 2.52:1** against
the page — while driving `:focus-visible`'s outline, the context ring's stroke, the tab
indicator and `.input:focus`. The keyboard focus indicator was effectively invisible in
light mode, on the default path, and `verify:profiles` asserted only `accentContrast`
against `accent` so `npm run check` passed throughout. Gotcha 31 again.

Deriving the FILL instead would have been the obvious fix and is wrong: it silently
restyles three of the eight shipped swatches in dark mode, which is a product decision
rather than a repair. So `--accent` keeps the brand colour and `--accent-ink` is solved for
both 4.5:1 and APCA Lc 60 against the page. `src/shared/accent.ts` does it; the 23
foreground, stroke, outline and 1px-border sites in `app.css` use the ink.

Two traps inside that derivation. **Thresholds must be tested on the ROUNDED colour** —
`fitToSrgb` returns fractional components but an 8-bit hex is what ships, and testing the
unrounded value converged every light-theme ink to 4.49:1 against a 4.5 requirement. And
there is a **~7 L\* dead band** (roughly L\* 66-78 by hue) where neither near-white nor
near-ink reaches Lc 60 on a fill, so a filled button has no legible label at any ink; three
shipped swatches sit in it. The fill is nudged out rather than the label accepted, by less
than the 0.04 perceptual distance this repo already calls "the same colour".

## 65. `--accent-contrast` is chosen for the solid fill and painted on the hover fill too

**`--accent-contrast` is chosen for the solid fill and painted on the hover fill too.**
`.btn[data-variant='primary']` sets `color` once and swaps only `background`/`border-color` on
`:hover`, and `accentHover` moved OKLCH L a fixed step AWAY from the page — which is TOWARDS
the ink whenever the ink is the far one, i.e. usually. 28 of the 108 theme × accent
combinations measured under Lc 60 on hover, Clay's own shipped accent among them (63.3 solid,
57.7 hover). `verify:color` asserted the ink against `--accent` and never mentioned
`accentHover`, so `npm run check` was green throughout: gotcha 44's lesson one property along.
Fixed by measuring (`hoverFor`) rather than by shrinking `HOVER_STEP`, which would have dulled
all 108 to repair 28 — and the suite now asserts the hover is still visibly DIFFERENT from the
fill, because clearing a contrast floor by not moving would satisfy the first assertion by
deleting the affordance.

While extending `contrastReport` to the semantics, the same trap as `borderSubtle`: checking at
`SEMANTIC_LC` exactly fired on **six of the twelve built-in themes**, because `semantic()`
solves in OKLCH and rounds to 8-bit, landing at Lc 63.7-64.1 against a 64 target. A wrong floor
rather than six wrong themes. The invariant to assert is the one that catches it — a GENERATED
theme reports nothing — and `verify:theme-gen` now does, for all twelve.
