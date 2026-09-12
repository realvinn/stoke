---
paths:
  - "src/renderer/src/lib/shortcuts.ts"
  - "scripts/verify-shortcuts.mts"
  - "src/renderer/src/App.tsx"
  - "src/renderer/src/components/TitleBar.tsx"
  - "src/renderer/src/components/TerminalView.tsx"
---

# Keyboard chords

Which chords Stoke may take from the terminal, and how a chord that steps must read state. Loaded
when a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are permanent —
code comments cite them as "CLAUDE.md gotcha N".

## 32. Zoom is the second exception to the Shift rule, and the only one where Shift is actively harmful

**Zoom is the second exception to the Shift rule, and the only one where Shift is actively
harmful.** Off macOS every letter chord demands Shift because bare Ctrl+K/W/T are readline
bindings Claude Code's prompt uses. Zoom inverts it: xterm turns Ctrl+`_` — which *is*
Ctrl+Shift+`-` on a US layout — into `C0.US` (`Keyboard.ts:361-364`,
`if (ev.key === '_') result.key = C0.US`), and that is readline's undo. Binding the Shift
variant would have eaten it silently. Bare Ctrl+`-` and Ctrl+`=` match neither of xterm's
two Ctrl branches, so the terminal does nothing with them at all — which is what makes them
free to take, and why every other app already uses exactly those.

Zoom-in accepts Shift and zoom-out refuses it. That asymmetry is not sloppiness: `+` IS
Shift+`=` on most layouts, so someone pressing "Cmd and plus" is holding Shift whether they
think so or not, while `-` needs no Shift to type. `verify:shortcuts` pins the refusal
first, because it is the assertion that protects something rather than adding something.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - Digit 2 is a second case. Ctrl+Shift+2 is Ctrl+`@`, which xterm sends as NUL from the same branch as `_` (Keyboard.ts:361-367). The digit chords already refuse Shift (shortcuts.ts:36), so the behaviour is right. But shortcuts.ts:22-24 says Shift is only unnecessary there, and nothing records the ^@ reason.

## 56. A shortcut is only safe if xterm ignores it, and Ctrl+Tab is not

**A shortcut is only safe if xterm ignores it, and Ctrl+Tab is not.** Every chord in
`shortcuts.ts` survives because xterm's `evaluateKeyboardEvent` declines it: Meta on macOS,
and `ctrlKey && !shiftKey` off it, which is why the letter chords all demand Shift there
(gotcha 32 covers the two zoom exceptions). Tab is different — xterm's branch for it reads
`shiftKey` and nothing else, so **Ctrl+Tab sends C0.HT to the pty**, from xterm's own listener
on the textarea, which runs at target phase *before* a window-level handler. Calling
`preventDefault` afterwards cannot unsend it. Next/previous tab is `⇧⌘]` / `Ctrl+Shift+]`
instead: the bracket keys sit in the same `ctrlKey && !shiftKey` branch as the letters
(keyCode 219/221 give ESC and GS), so the Shift takes them out of it exactly as it does for
Ctrl+K, and `verify:shortcuts` asserts the bare forms still reach the terminal.

**A chord that STEPS from the current value must read pending state.** `cycleTab` computed
its step from `activeTabId` as captured by the last render, so two presses inside one frame —
a held key — both started from the same tab. Measured over CDP: two events in one tick moved
the selection one place; with `setActiveTabId(cur => …)` they move two. Gotcha 51's shape one
layer down. Every other case in that switch sets an absolute value and is unaffected.

Related, and the reason `chordLabel` exists: the title bar hand-wrote "Ctrl/Cmd+T" on every
tooltip, which is right on macOS and **wrong on Windows and Linux**, where the letter chords
need Shift. A slash between two platforms' modifiers cannot express a per-platform Shift, so
the label is derived from the same table the matcher uses.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - This does not happen for a bound chord. `TerminalView`'s `attachCustomKeyEventHandler` returns false on any `matchShortcut` match (TerminalView.tsx:380-391, there since 226a114). xterm runs that handler at the top of `_keyDown` (CoreBrowserTerminal.ts:1025), before `evaluateKeyboardEvent` (:1043). `_keyPress` also drops Ctrl/Meta chords (:1165-1168). So a bound Ctrl+Tab would be withheld from the pty, not leaked. What any binding really costs is that key in the CLI, as verify-shortcuts.mts:6-9 says; its :200-206 repeats this entry's wrong claim.
> - `zoom` also steps from the current value. App.tsx:1765-1781 calls `zoomStep(settingsRef.current…, action.direction)`, and `settingsRef` only changes on render after the `window.stoke.settings.set` round trip (App.tsx:446-449, :463-464). So two presses before that render step from the same value, which is the bug this entry fixed for `cycleTab`.
> - The tab-number chords are bare Ctrl off macOS (shortcuts.ts:35-36). xterm's `ctrlKey && !shiftKey` branch sends Ctrl+3..7 as ESC/FS/GS/RS/US and Ctrl+8 as DEL (Keyboard.ts:308-317). So six of them take a key away from the pty on Windows and Linux. Ctrl+7 is ^_, the same readline undo that gotcha 32 protects.
