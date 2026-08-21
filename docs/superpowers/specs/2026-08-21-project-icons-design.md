# Project icons: emoji search, and images of your own

**Status:** design, not yet implemented
**Date:** 2026-08-21

## What this changes

A folder in the sidebar can carry an icon. Today that icon is one of **twenty-four
hardcoded emoji** (`ProjectMetaPicker.tsx:18`), and the comment above the array explains
why it is a fixed palette rather than a field:

> A fixed palette rather than a text field: an arbitrary string would have to be validated
> as an emoji somehow, and every rule for that is wrong for somebody's script.

That reasoning has aged out on both halves. `Intl.Segmenter` plus `\p{Extended_Pictographic}`
now settles "is this one emoji grapheme" properly, and storage was never the obstacle:
`MAX_EMOJI_CHARS = 16` was sized for ZWJ sequences from the start, so 👩‍🚀 and 👨‍👩‍👧‍👦 already fit.

Two capabilities, one popover:

1. **Search the full emoji set.** Type `rocket`, get 🚀. Empty box shows today's twenty-four.
2. **Use an image of your own.** Choose a file, drag one onto the row, or paste one.

## Why this is a spec and not a chat design

Custom images are not a bigger palette. They change `ProjectMeta.emoji` from a capped string
into a value with a *referent*, which means:

- a new on-disk store, with a lifecycle and a way to not leak
- a shared type consumed by main, the renderer, and two verify suites
- a new IPC channel, and untrusted file input crossing it
- a real constraint: the renderer's CSP is `img-src 'self' data:`
  (`src/renderer/index.html:9`), so an arbitrary `file://` path is **blocked outright**

That is a subsystem. It was brainstormed as bounded and upgraded when the image requirement
arrived — the ratchet in the brainstorming skill, applied.

## 1. Data model

`ProjectMeta` gains one optional key beside the existing `emoji`:

```ts
export interface ProjectMeta {
  /** One emoji shown before the name. Absent means none. */
  emoji?: string
  /** A custom image, by id. Absent means none. Mutually exclusive with `emoji`. */
  icon?: string
  label?: string
  addedManually?: boolean
}
```

**`emoji` is left exactly as it is**, which is the whole reason for a second key rather than
a widened first one. Every settings.json in existence carries `emoji` strings;
`verify:folders` and `verify:settings` assert on them by value in a dozen places. Widening
`emoji` to also mean "an image id" would make `'🔥'` and `'a3f21c9e'` the same field with two
readings and no way to tell them apart except by guessing at the content — which is precisely
the "validate an arbitrary string somehow" trap the original comment refused, arriving by the
back door.

**Mutually exclusive, enforced in `tidy()`.** Setting one clears the other. A record holding
both is a record whose rendering depends on which branch of an `if` runs first.

`Project` (the resolved row) gains the id, not the image:

```ts
export interface Project {
  emoji: string | null
  /** Custom icon id, or null. Resolve with `projects.icon(id)`. */
  icon: string | null
  …
}
```

### Why the id and not the image

`listProjects` runs on every sidebar refresh and currently costs ~6ms against 57 projects.
Inlining image bytes would put every custom icon on that path and into every IPC payload —
a regression on the exact call this session just spent effort making cheap. The id is
resolved separately and cached (§4).

## 2. Storage

```
<userData>/project-icons/<id>.png
```

- **Re-encoded on import** to a 64×64 PNG via Electron's `nativeImage`:
  `nativeImage.createFromPath(p).resize({ width: 64, height: 64 }).toPNG()`.
  No new dependency, and the set of accepted formats becomes "whatever Electron can decode",
  which is a definition rather than a guess.
- **64×64**, derived rather than guessed. The icon button is `--chevron: 1.125rem`
  (`app.css:1120`) — 18 CSS px at Interface scale 1.0. Scale tops out at 1.6, giving 28.8 CSS
  px, and a 2× display makes that **57.6 device px**. 64 clears it with a little room and
  costs 2–8 KB. Anything larger is decoded and thrown away on every paint.
- **Content-addressed**: `id = sha256(pngBytes).slice(0, 16)`. Two folders pointing at the
  same picture share one file, and re-importing the same image twice is idempotent rather
  than a second copy.

### Copied in, not referenced

The alternative — store the absolute path — was rejected on evidence from this same codebase.
An icon referencing a file the user later moves, renames, or keeps on an external drive is
the failure this session spent hours on for project *folders*: eight of this machine's
projects live on a USB volume that macOS spins down after ten minutes, and a path-referenced
icon would be broken or slow exactly when that volume is out. Copying makes the icon a fact
about Stoke's own data rather than a bet on someone else's filesystem.

### Lifecycle

An icon file is garbage once no `projectMeta` record names it. Sweep at boot, after settings
load, mirroring `sweepStaleSessionFiles`:

```
for each file in project-icons/:
  if its id is in no projectMeta[].icon  ->  remove it
```

Referencing is checked against the **whole** `projectMeta` map, hidden projects included, so
hiding a folder never deletes its icon. Content-addressing makes this a correct refcount for
free: the last record to stop naming an id is what frees it.

The sweep must be async and off the main thread. It reads one directory of small files, but
`userData` can sit on a network home directory, and gotcha 40 is the record of what a
synchronous filesystem call on the main thread costs when the disk is slow.

## 3. Import

Three routes, one funnel. Each produces an absolute path or a buffer, and all of them end in
the same `importIcon` in main.

| Route | Where | Notes |
|---|---|---|
| **Choose image…** | button in the popover | `dialog.showOpenDialog` with an image filter, same shape as `projectsAddRoot` (`index.ts:944`) |
| **Drag a file onto the row** | sidebar row + icon button | must not fight tab-strip drag reordering; drop target is `.project`, which is not a tab |
| **Paste** | popover focused | `Cmd/Ctrl+V`; reads an image off the clipboard via `clipboard.readImage()` |

Paste is worth one note. Stoke deliberately **refuses** OSC 52 clipboard *reads* from
terminals, because anything a terminal renders is untrusted and could exfiltrate whatever was
last copied (gotcha 29). This is not that: it is a keystroke the user pressed, into a focused
control, that puts an image *in* rather than reading text *out*. The two do not conflict, and
the distinction is worth keeping straight so nobody "fixes" one by breaking the other.

### Validation, in main, before anything is written

Untrusted input crossing IPC. In order:

1. **Size ceiling on the source** — reject over 16 MB before decoding. Reading an arbitrary
   file into memory to draw an 18px glyph is the thing to avoid, and `nativeImage` will
   happily try.
2. **Decode must succeed** — `nativeImage.createFromPath` returns an *empty* image rather
   than throwing for a file it cannot read. `img.isEmpty()` is the check, and skipping it
   writes a valid, blank PNG that renders as nothing and looks like a bug in the sidebar.
3. **Re-encode** — resize and `toPNG()`. Whatever the source was, what lands on disk is a
   PNG of known dimensions. No SVG is ever stored, so no SVG is ever rendered, so the
   script-in-SVG question never arises.
4. **Write temp+rename** — the same discipline `statusLine.ts` uses, so a reader never sees
   half a file.

Failures return a sentence, not a boolean: *"That file isn't an image Stoke can read."*

## 4. Getting the image to the renderer

```ts
projects: {
  icon(id: string): Promise<string | null>   // a data: URL, or null
}
```

Main reads the PNG and returns `data:image/png;base64,…`. The renderer caches by id, forever,
because a content-addressed id can never point at different bytes.

**This needs no CSP change and no custom protocol.** `img-src 'self' data:` already permits
it (`index.html:9`), and 2–8 KB is small enough that a data URL is not a compromise. A
`stoke-icon://` protocol was considered and rejected as more moving parts for no benefit at
this size — the reason to reach for one is large or streamed assets, and this is neither.

`id` is checked against `/^[a-f0-9]{16}$/` — the exact shape `sha256(...).slice(0, 16)`
produces — before being joined to a path, and anything else is treated as no icon. Exact
rather than a lenient range, so the rule that validates is the same rule that generates and
the two cannot drift. Stoke writes these ids itself, so this is belt and braces; but
`statusLine.ts` sanitises its session id for the same reason, and a settings.json edited by
hand or copied between machines is a real input.

## 5. Emoji search

- **Dataset**: `scripts/make-emoji-data.mjs` generates `src/renderer/src/lib/emojiData.ts`
  from `unicode-emoji-json` (a devDependency, ~838 KB unpacked, used only at generation
  time). Checked in, ~1,900 entries of glyph + name + group, roughly 60 KB raw / 20 KB
  gzipped. Same pattern as `npm run icon`: a generator, an artefact, no runtime dependency.
- **Lazy**: `await import()` on first open of the popover, so boot pays nothing. This session
  removed three static imports from the main process for exactly this reason and took
  `whenReady` from 336ms to ~50ms; adding a static 60 KB table to the renderer's first paint
  would be walking it back.
- **Search**: `emojiSearch(query)` in its own module, pure. Name and group, prefix matches
  first, capped at 60 results.
- **Empty query** shows today's twenty-four, now framed as favourites.

**One stated limitation.** Search matches the Unicode *name*, so `rocket` → 🚀 and `cat` → 🐱
work, but `happy` → 😀 does not, because "happy" is not in that emoji's name. Full CLDR
keywords would fix it and cost a 50 MB dependency to generate from. Ship without; add a small
synonym map only if it proves annoying in use.

## 6. UI

One popover, unchanged in position and dismissal behaviour:

```
┌─ Icon and name for stoke ──────────────┐
│ 🔍 rocket                              │
├────────────────────────────────────────┤
│  🚀   🛸   👨‍🚀  👩‍🚀                      │
│  (empty box → the 24 favourites)       │
├────────────────────────────────────────┤
│  [ Choose image… ]   or drop one here  │
├────────────────────────────────────────┤
│  Display name: [ stoke            ]    │
│  [No icon]                    [Hide]   │
└────────────────────────────────────────┘
```

- The trigger button renders a glyph, an `<img>`, or `IconFolder`, in that order of
  preference.
- **No icon** clears both `emoji` and `icon`.
- Keyboard: type to filter, arrows to move, Enter to pick, Escape to close. The popover
  already stops every key (`ProjectMetaPicker.tsx:216-222`) so the name field below cannot
  steal a space — that stays.
- The `<img>` is `aria-hidden` with the accessible name coming from the button, exactly as
  the glyph span does today.
- All sizing in existing `--space-*` tokens; no hardcoded colour. Standing repo rule.

## 7. Failure modes, and what each looks like

| Situation | Behaviour |
|---|---|
| Source file unreadable or not an image | Sentence in the popover; nothing written |
| Source over 16 MB | Refused before decoding, with the limit named |
| Icon file missing at render (hand-deleted, or a settings.json copied between machines) | `projects.icon` returns null; falls back to `IconFolder`. Never a broken-image glyph |
| Settings names an id with no file | Same fallback. The record is left alone, not silently rewritten |
| Two folders, one image | One file on disk. Removing one folder's icon does not disturb the other |
| Disk full on import | Import fails with the error; no partial file, because temp+rename |

## 8. Verification

A new `scripts/verify-icons.mts`, in the `check` chain.

Pure rules, testable with no Electron:

- `tidy()` keeps `emoji` **or** `icon`, never both; setting one clears the other
- an `icon` that is not exactly sixteen lowercase hex characters is dropped by `tidy()` and by `hydrateSettings`
- a record holding only `icon` survives a hydrate round trip
- **existing `emoji` records are byte-identical after the change** — the regression that
  matters most, since `verify:folders` and `verify:settings` already pin those values
- the orphan sweep removes an unreferenced id and keeps a referenced one, including one
  referenced only by a *hidden* project
- `emojiSearch('rocket')` puts 🚀 first; empty query returns the twenty-four; case-insensitive
- every dataset entry is a single grapheme by `Intl.Segmenter` and fits `MAX_EMOJI_CHARS`

Needing a real Electron (extend `verify:selection`'s harness pattern, or a small runner):

- a real PNG, JPEG and a text-file-renamed-to-`.png` through `importIcon`: two succeed at
  64×64, the third is refused with `isEmpty()` and writes nothing
- the same image imported twice yields one file and one id

## 9. Out of scope

- **The phone UI.** It renders no icon today and `/api/projects` does not carry one. Adding
  images to a remote payload is a separate decision about bandwidth and about serving user
  images over a tunnel.
- **The tab strip, launcher and command palette.** The icon is drawn in exactly one place
  today, and this keeps it that way.
- **Animated icons.** The re-encode flattens to a still PNG. A sidebar of moving pictures is
  a different feature and probably a worse one.
- **Per-theme icons.** One image, both appearances.

## 10. Implementation order

1. `ProjectMeta.icon` + `tidy()` mutual exclusion + hydrate, and `verify:icons` covering the
   pure rules. **The existing-`emoji`-unchanged assertion goes in first**, before any
   behaviour moves, because it is the one that protects something rather than adding
   something.
2. Storage, `importIcon`, the orphan sweep, the `projects.icon` channel (declared in
   `src/shared/ipc.ts` first, per the repo rule).
3. The file-picker route and rendering. This is the vertical slice that makes the feature
   real; stop here and it is already shippable.
4. Emoji dataset, generator, `emojiSearch`, the search box.
5. Drag-and-drop, then paste.
