---
paths:
  - "src/main/wallpaper.ts"
  - "src/renderer/index.html"
  - "src/renderer/src/components/ActivityPanel.tsx"
  - "src/renderer/src/components/BrowserPanel.tsx"
  - "src/renderer/src/components/CommandPalette.tsx"
  - "src/renderer/src/components/ContextMenu.tsx"
  - "src/renderer/src/components/ContextMeter.tsx"
  - "src/renderer/src/components/Campfire.tsx"
  - "src/renderer/src/components/Launcher.tsx"
  - "src/renderer/src/components/SettingsSheet.tsx"
  - "src/renderer/src/components/TabIndicator.tsx"
  - "src/renderer/src/components/TitleBar.tsx"
  - "src/renderer/src/components/WorklogPrompt.tsx"
  - "src/renderer/src/lib/theme.ts"
  - "src/renderer/src/styles/app.css"
  - "src/shared/ring.ts"
---

# CSS and layout traps

Layout and painting traps in the stylesheet and components, most of them found only by measuring
over CDP. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers
are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 11. `align-self: center` centres the *margin* box

**`align-self: center` centres the *margin* box.** Cancelling a container's padding for
one child needs the full padding negated, not half — half lands it a pixel off. Measured,
not reasoned.

## 14. A native `WebContentsView` paints above all renderer DOM

**A native `WebContentsView` paints above all renderer DOM.** Any panel that must remain
visible while the browser is open has to be a sibling column in `.body-row`, never an
overlay. `.app` is a fixed three-row grid (`titlebar / body / status`), so a new full-width
strip goes *inside* `.main-col` — adding a fourth row silently shifts the status bar into
the body's track.

Related, and it bit hard: **`.app` needs an explicit `grid-template-columns: minmax(0, 1fr)`.**
Left implicit the column is an `auto` track whose minimum is its content's min-content
width, so any row that resists shrinking makes the whole shell wider than the window rather
than clipping itself. That was already true at the 940px minimum with both side panels open;
a one-line prompt strip made the app grow 600px and clip the launcher. A nowrap flex row
needs `flex: 1 1 0%` **and** `min-width: 0` on the text for it to ellipsis rather than
push — and neither helps until the grid column can shrink. Found by measuring over CDP; no
amount of reading the CSS would have shown it.

## 22. A CSS token rename only fails loudly if the old name is gone

**A CSS token rename only fails loudly if the old name is gone.** The spacing migration renamed
`--sp-*` to `--space-*` on purpose: a missed `var(--sp-2)` names nothing, the declaration is
invalid at computed-value time, and the padding visibly collapses to 0. Renumbering in place
would have made `--sp-4` silently mean 4px where it used to mean 12px. Two consequences: the
migration is verified by `grep -rn -- '--sp-' src/` returning **zero**, and a sweep over the
stylesheet is not the whole job — 26 uses were inside `style={{ }}` objects in eight `.tsx`
files and rendered at 0 until they were found.

## 23. macOS traffic lights are device pixels; anything clearing them must be too

**macOS traffic lights are device pixels; anything clearing them must be too.** `padding-left`
in rem was only correct at Interface scale exactly 1.0 — at 0.8 the first tab sat under the
close button. Same class of bug as sizing an icon with a px attribute inside a rem-scaled
button: two units that do not move together, so it looks right at exactly one setting.

## 33. A DOM box and an SVG do not paint on the same grid, so two things that `getBoundingClientRect` agrees are concentric can be visibly apart

**A DOM box and an SVG do not paint on the same grid, so two things that `getBoundingClientRect`
agrees are concentric can be visibly apart.** The worklog watch dot was a 5px `<span>` centred
over the 14px context ring in one grid cell. Both centres read *identical* off
`getBoundingClientRect` — and the dot painted **0.707px up and to the right**, which on a 14px
indicator whose inner clear diameter is 7.6px is the whole tolerance.

`place-items: center` puts a 5px child in a 14px box at 4.5px — a half-pixel — and Blink
**snaps a painted background box to whole CSS pixels while leaving SVG geometry exactly where
the arithmetic put it**. So the dot rounds and the ring does not. Measured, not reasoned: the
painted centroids of both shapes were extracted from `Page.captureScreenshot` at scales 1, 2,
8 and 16 with the two shapes forced to pure green and pure magenta so the masks could not
bleed. The offset is **scale-invariant** — it is not antialiasing and Retina does not hide it,
it doubles it in device pixels — and its **direction flips with the container's own fractional
position**, which is why it read as "the dot is off centre" rather than as anything
reproducible.

Ruled out by the same measurement, so nobody re-derives them: grid auto-placement (`.sr-only`
is `position: absolute`, so no implicit second row exists), the ring's `rotate(-90deg)`
(rotating a circle about its own centre is identity — the offset is identical with the
transform removed), the stroke geometry, and the cascade.

An even-sized dot fixes it at Interface scale 1.0 and **only** there: at 1.1 the rem sizes stop
landing on integers and the two boxes round apart again. The durable fix is to stop having two
boxes — the dot is a `<circle cx="8" cy="8">` inside the ring's own `<svg>` (`ContextMeter.tsx`,
`WATCH_R`), which is concentric *by construction* at every scale, dpr and sub-pixel offset.
Verified: 0.0000px at every offset tried, against 0.707px for the span at all of them.

The general rule: **anything that must line up with SVG must be drawn in that SVG.** Overlaying
a DOM box on vector art in a shared grid cell is correct in layout and wrong on screen.

## 47. A button with no declared box keeps Chromium's `buttonface` fill

**A button with no declared box keeps Chromium's `buttonface` fill.** The global reset in
`app.css` sets only `font` and `color` on `button`, so the settings menu's ten nav rows
rendered as chunky grey UA buttons until they declared `border: none; background: transparent`
— the same three properties `.segmented button` declares a thousand lines above, for the same
reason. Only a screenshot showed it; every measurement of the modal was already correct.

Two more from the same session, both found by driving the built app rather than reading the
CSS. **`@keyframes pop` carries `translate: -50%`**, and a keyframe that sets `translate`
decides where the element STARTS relative to wherever its own rule leaves it — so that `-50%`
is only correct for a user whose resting translate is also `-50%`. Measured two frames after
the click, a `margin: auto` dialog was at `x: -220` for a box that settles at `x: 260`, so it
flew in from 480px off the left. Centred dialogs use `modal-in`. And **a fixed-position dialog
with a specified width needs `min-height: 0` on its scrolling grid track**, or a tall section
makes the dialog taller than the viewport and the pane never scrolls — gotcha 14's `.app`
column problem, one axis over.

**This entry used to say the `-50%` was "right for the context menu it was written for". That
was backwards, and it hid a bug in three of the keyframe's four users.** `pop` had four:
`.palette`, `.context-menu`, `.voice-strip` and `.copy-strip`. Only `.palette` centres itself
(`left: 50%; translate: -50% 0`), so only `.palette` was sliding straight down; the other
three rest at `translate: none` and were therefore swooping in sideways across half their own
width on every appearance — 88px for the 11rem context menu, which is why its outline read as
smeared rather than as mispositioned. Measured in both states rather than reasoned about:
while the animation runs all four report `-50% -8px`, and once settled `.palette` reports
`-50%` and the other three report `none`. `pop` is now `translate: 0 -0.5rem` and the palette
has its own `palette-in`, which is the same split — and the same cause — as `modal-in` above.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - It now also zeroes padding: `button { padding: 0 }` at `src/renderer/src/styles/app.css:44-46`, against Chromium's UA `1px 6px`. It still declares no `border` or `background`, so the `buttonface` trap stands.
> - `.copy-strip` no longer exists anywhere in `src/` (copy mode was removed). `pop`'s current users are `.voice-strip` (app.css:1722), `.context-menu` (:2541) and `.popover` (:3751). `.palette` uses `palette-in` (:2615).
> - `pop` now carries `translate: 0 -0.5rem` (`src/renderer/src/styles/app.css:3591-3596`), as the entry's own last paragraph says. The present-tense `-50%` sentence is left over from before the fix. The `modal-in` comment (app.css:3616-3617) still repeats the retracted claim that `-50%` is 'right for the context menu it was written for'.

## 54. Translucency compounds, so a wallpaper behind three stacked surfaces is a wallpaper nobody can see

**Translucency compounds, so a wallpaper behind three stacked surfaces is a wallpaper
nobody can see.** Every container in the shell already had a background — `.app`, the body
row, `.main-col`, `.term-pane`, `.term-host` — and dropping each one to 85% alpha does not
give 85%, it gives 0.15^5 of the image through. The first attempt rendered as "the picture
is not there at all", which sends you looking at the protocol handler rather than at the
cascade. The rule the fix encodes: containers go FULLY transparent, and exactly one surface
per spot carries `--panel-alpha`. The terminal needs a sixth thing — xterm's own canvas is
opaque unless `allowTransparency` is set AND the theme's background is an rgba with alpha
below 1 (`terminalTheme(theme, accent, alpha)`), so the card behind it can show through.

**A custom scheme has to be privileged before `whenReady` and handled inside it**, and the
two calls look interchangeable. `protocol.registerSchemesAsPrivileged` must run at module
scope — after the app is ready it is silently too late — while `protocol.handle` only works
once the app *is* ready. Splitting them is not tidiness; joining them breaks one or the
other with no error.

**`fetch('stoke-asset://…')` fails from the renderer and that is not evidence of anything.**
CSP's `connect-src` governs fetch and does not know the scheme, so the request is refused
before it reaches main — while `<img>` loads it fine, because that is `img-src`, which
`index.html` names the scheme in. Probe a custom scheme with `new Image()` and its
`onload`/`naturalWidth`, never with fetch, or you will conclude a working handler is broken.

## 60. `justify-content: center` and `overflow: auto` on the same box are only compatible while the content fits

**`justify-content: center` and `overflow: auto` on the same box are only compatible while
the content fits.** Centring distributes free space by moving the content, and when the
space is *negative* it still does: the overflow goes in both directions and the half above
the centre line sits at an offset `scrollTop: 0` cannot reach.

Measured on `.launcher` at a 320px pane with "Launch options" expanded: the card's top was
**273.1px above the visible area at scrollTop 0**, and `scrollHeight` reported **617px
against 914px of real content** — the browser does not even account for the clipped part, so
`maxScrollTop` could never reach it. With `margin: auto` on the child instead: top offset
+24px (the padding), **0px clipped**, the full 914px measured, all of it scrollable.

`margin: auto` centres identically while there is free space and collapses to zero when
there is not. Same family as gotcha 11: these properties centre by *consuming space*, so
they behave differently once the space is negative. The symptom is always "the top of this
is cut off and I cannot scroll to it", and it only appears once something inside grows —
which is why expanding a disclosure is the classic trigger.

## 72. The global reduced-motion block silently deletes anything whose visible state lives only in its keyframes

**`app.css`'s global `prefers-reduced-motion` block makes most animations behave and makes a
particular kind of element vanish, and the difference is invisible in the stylesheet.** The block
is `animation-duration: 1ms !important; animation-iteration-count: 1 !important` on `*`, which is
the right blunt instrument: an animation still runs, for one millisecond, and the element is then
painted from its own base rule. So the question every new animation has to answer is **what does
this element look like with its animation deleted** — and there are two ways to get that wrong.

**A keyframe pair whose endpoints are both "mid-motion" leaves a frozen wrong frame.** Writing
`from { scale: 0.9 } to { scale: 1.1 }` for a flicker means the resting style is the good one and
the 1ms run ends back at it — fine. Writing the *static* look into `50%` and the extremes into
`0%`/`100%` reads identically in the stylesheet and leaves a permanently squashed shape.

**Worse, and the one that actually bit: an element that rests at `opacity: 0` disappears
entirely.** The first-run campfire's five sparks are `<circle>`s whose whole existence is a
`0% { opacity: 0 } … 100% { opacity: 0 }` rise, because a spark is *only* a moving thing. With
motion reduced they were still in the DOM, still laid out, still measured as present by any
probe that asks `querySelector`, and painted nothing — so the check that would catch it is not
"is it there" but a screenshot. They are `display: none` under reduced motion now, which is the
honest statement: a spark with no motion is not a dimmer spark, it is not a spark.

The general rule: **the reduced-motion answer for a decorative element is either a deliberate
still state or removal, never whatever the keyframes happen to leave behind.** `.campfire`'s own
`@media (prefers-reduced-motion: reduce)` block does both — the card keeps `fade` so it does not
appear with no transition at all, and the sparks go.

Verified in the running app rather than reasoned about, because none of it is visible to `npm run
check`: Electron takes `--force-prefers-reduced-motion`, which gets a real
`matchMedia('(prefers-reduced-motion: reduce)').matches === true` at boot. Measured under it:
`matches` true, `.campfire-body` and `.campfire-core` both at `animationDuration 0.001s`,
`.campfire-spark` at `display: none`, and a screenshot showing a still, correct fire rather than
a frame of a moving one.

> **Corrected 2026-09-12, by measuring it.** This paragraph used to call the flag "the only way",
> on the grounds that "CDP's `Emulation.setEmulatedMedia` arrives after the splash has already
> decided what to paint". That is false, and it is a diagnosis the tool disproves in one call: a
> media query is live, and nothing here decides anything once. Driven against the built app with
> the splash already mounted and animating, `Emulation.setEmulatedMedia` with
> `prefers-reduced-motion: reduce` moved it from `{matches: false, spark: "inline", bodyDur:
> "1.7s"}` to `{matches: true, spark: "none", bodyDur: "0.001s"}` inside 250 ms. Both tools work
> on a mounted element; prefer the flag anyway, for the two honest reasons — it is the state a
> user with the OS setting actually boots into, and it needs no race against a splash that is
> only up for `WELCOME_DISMISS_MS`.
