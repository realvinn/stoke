# Tabs that stay readable, stop corrupting sessions, and can be reached from the keyboard

**Status:** approved, not yet implemented
**Date:** 2026-08-19

Three changes, in descending order of harm done today.

## 1. A hidden tab shrinks its own session — the "shrunken Claude Code" bug

**Measured, in the running app:**

| Tab state | PTY size |
| --- | --- |
| Visible | 146 × 43 |
| Hidden (user switched away) | **11 × 5** |

`TerminalView` renders `<div className="term-pane" hidden={!active}>`. Hiding collapses the
host to 0×0, its `ResizeObserver` fires, and `applyFit` runs anyway:

```ts
const applyFit = (): void => {
  try {
    fit.fit()
    window.stoke.pty.resize(tab.ptyId, term.cols, term.rows)
  } catch { /* host detached mid-measure */ }
}
const ro = new ResizeObserver(() => applyFit())
```

`FitAddon` clamps to `MINIMUM_COLS = 2 / MINIMUM_ROWS = 1` rather than refusing, so a
measurement of nothing becomes a real, tiny size, and Stoke tells the CLI its terminal is now
11 columns wide. Claude Code reflows its whole TUI to fit. Switching back refits to 146 — but
everything already drawn at 11 columns stays wrapped that way. Captured after switching back,
in a 146-column terminal:

```
╭─ Claude Code ────╮
│  Welcome back!   │      <- a ~20-column box
│      ▐▛███▛█     │
```

The existing comment two effects down already says "A hidden pane cannot be measured, so refit
and focus when it is revealed" — the reveal side was handled and the hide side was not.

**Fix.** `applyFit` returns early when the host has no size. Nothing is measured and, crucially,
**no resize is sent**, so the CLI never learns a size that was never real. The existing
refit-on-reveal effect already restores the true size, so no new machinery is needed.

This is not a performance trade-off. It strictly *reduces* work: one fewer fit and one fewer
IPC resize per tab switch, and it removes a full TUI reflow at both ends.

**Guard on the host's own box, not on `active`.** A prop says what the app intends; the box says
what the browser did. The same early return then also covers a pane collapsed by anything else —
a zero-width window, a collapsed grid track, an unmounted-but-not-yet-torn-down pane.

## 2. Tabs shrink to anonymity instead of scrolling

**Measured at 20 tabs in a 1085px strip:**

| | |
| --- | --- |
| Narrowest tab | 40.9px |
| Label characters visible on the active tab | **0** |
| Labels clipped | 20 of 20 |
| Strip overflow | 13px — it barely scrolls at all |

The strip does not run out of room; the tabs give up their width first. `.tab` sets
`max-width: 15rem` and `min-width: 0`, and `flex-shrink` defaults to `1`, so every tab squeezes
to its icons long before `.tablist`'s `overflow-x: auto` engages. `scrollbar-width: none` then
hides the only clue that anything is off-screen. The result is a row of identical pause glyphs.

**Fix, three parts:**

- **`.tab` gets a `min-width`.** A tab's chrome is indicator (14px) + gap + close (18px) + gap +
  padding ≈ 64px, so roughly 10 characters of label needs about 136px. `8.5rem` (136px at Interface
  scale 1) is the value to implement. The implementer measures the real rendered character width
  first and adjusts only if that arithmetic proves wrong, recording what was measured either way. Below its min-width a tab stops shrinking and the list scrolls.
- **The active tab is scrolled into view** whenever the active tab changes, so switching by
  keyboard or by click never leaves you looking at a tab you did not select.
- **Edge fades** on `.tablist` (a `mask-image` that fades only the overflowing edge) say there
  is more without reintroducing a scrollbar the design deliberately hides.

Wheel-to-scroll is **assumed, not verified**. Chromium maps a vertical wheel onto horizontal
scrolling for an element that only scrolls horizontally, which would make it free — but that is
a claim about the engine I have not measured, and this project has been bitten repeatedly by
exactly that kind of reasoned-not-measured assertion. The implementer confirms it in the running
app and, if it does not hold, adds an explicit wheel handler rather than leaving the strip
scrollable only by drag.

## 3. Reaching a tab from the keyboard

`Cmd+1..9` exists and reaches only the first nine tabs — which, given §2, is the range where
tabs are still individually clickable anyway.

**Previous / next tab.** macOS `⌘[` / `⌘]`; elsewhere `Ctrl+Shift+[` / `Ctrl+Shift+]`.

The asymmetry is not cosmetic. From xterm's own source (`Keyboard.ts:308-324`):

```js
if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
  } else if (ev.keyCode === 219) { result.key = C0.ESC }   // Ctrl+[  is Escape
  } else if (ev.keyCode === 221) { result.key = C0.GS }    // Ctrl+]  is ^]
}
```

Bare `Ctrl+[` **is** Escape, which Claude Code's prompt needs. The branch is guarded on
`!ev.shiftKey`, so `Ctrl+Shift+[` never reaches it — Shift is exactly what makes the chord safe.
That is the same shape as gotcha 32, where binding `Ctrl+Shift+-` would have silently eaten
readline's undo, and it lands the same way: the platform gate in `matchShortcut` already
*requires* Shift off macOS, so the safe chord is the one the existing rule already wanted.

On macOS the chord carries Cmd and no Ctrl, so that branch cannot apply at all.

**`⌥⌘←/→` was considered and rejected.** `matchShortcut` opens with
`if (!primary || e.altKey) return null` — a blanket refusal of Alt on both platforms, protecting
Option for the terminal (`macOptionIsMeta` sends ESC prefixes; Option-drag is the macOS
selection modifier). Taking those chords means unpicking a rule that cost real measurement.

**Tab switcher: `⇧⌘K` / `Ctrl+Shift+K`.** Free on both platforms — `Cmd+Shift+D` (dictation) and
`Cmd+Shift+X` (copy mode) are taken, `K` is not, and the existing `Cmd+K` project palette is a
different thing (projects on disk, not open tabs).

A new `TabSwitcher` component rather than an extension of `CommandPalette`: the palette ranks
`Project` records to *start* a session, the switcher lists open `Tab`s to *reach* one, and they
differ in what they show (live context, paused state, host) and what picking one does. They
should share the ranking function, not the component.

**Two traps for the implementation.** `⌘[` and `⌘]` must be matched on `event.code`
(`BracketLeft`/`BracketRight`), because `event.key` is layout-dependent and the repo already
matches on `code` for exactly this reason. And any new window-level listener must read live
state through a ref, not a dependency: gotcha 31 records a keydown handler in this same file
that captured `settings` while it was still `null` and bailed forever, passing every suite.

## Verification

`verify:shortcuts` is pure and already covers `matchShortcut`. Add:

- `⌘[` / `⌘]` match on macOS and produce prev/next.
- **Bare `Ctrl+[` does NOT match off macOS** — the assertion that protects Escape. Write this
  one first; it is the one that guards something rather than adding something, exactly as the
  zoom cases already do.
- `Ctrl+Shift+[` / `Ctrl+Shift+]` match off macOS.
- `⇧⌘K` / `Ctrl+Shift+K` match; `Cmd+K` still means the project palette.
- The Alt rule is unchanged: every new chord with Alt held matches nothing.

Add to `verify:tabs`: next/prev index arithmetic, including that it wraps at both ends and that
a single-tab list is a no-op.

**What no pure suite can reach**, and must be driven against the built app:

1. A hidden tab's PTY is **not** resized — the fix's whole point. Measure `term.cols` for a
   backgrounded tab and confirm it holds at its visible value rather than collapsing.
2. Twenty tabs: labels stay readable, the strip scrolls, and the active tab is in view.
3. The chords do not leak into the terminal — press `⌘[` in a live session and confirm no `^[`
   arrives, which is the failure this design exists to avoid.

## Out of scope, recorded

**The WebGL ceiling.** This renderer allows exactly 16 simultaneous contexts (measured:
requesting 40 produced 16 alive and 24 `webglcontextlost` events). `TerminalView` creates one
`WebglAddon` per terminal and disposes it permanently on loss, so the 17th session tab silently
demotes an older terminal to the DOM renderer for the rest of its life. Real, invisible, and
deliberately not addressed here.

**`MAX_STORED_TABS = 20`** means a restore silently drops the oldest tabs beyond twenty. Hit
during this investigation: 25 seeded, 20 restored.
