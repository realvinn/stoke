# PLAN — harness round 2

## Goal (user's words)

> I want to see if I can integrate maybe, like, bit warden or any extensions that I want to have
> into it. [...] can you also check how well it does read pages, especially, like, store pages [...]
> or even more visually pages, like Mystral AI, Claude, or, like, even, like, Raycast. [...] I want
> you to build the harness around it so that way you can actually read better.

Plus six further threads in the same message: extensions/password manager, page-reading quality
(possibly OCR via a local GLM vision model), skill/plugin/MCP discoverability, a project "blueprint"
that must not become a cage, dev-vs-prod logging into Sentry/PostHog, and ClickUp/Notion task sync.

## Test set (decoded from the voice message)

- `centrecom.com.au/graphics-card` — store. **Singular.** `/graphics-cards` is a real 404.
- `scorptec.com.au/product/graphics-cards` — store
- `mistral.ai`, `claude.com`, `raycast.com` — visually-heavy marketing

## Measured, before any change

| site | innerText | extracted | kept | outline entries | headings a reader sees |
|---|---|---|---|---|---|
| centrecom | 1254 | 308 | 24% | 1 | 4 |
| scorptec | 4912 | 4606 | 94% | 0 | 35 |
| mistral | 5696 | 3187 | 56% | **0** | 60 |
| claude.com | 2912 | **0** | 0% | 2 | 12 |
| raycast | 9753 | 9147 | 94% | 20 | 282 |

## Two root causes found and fixed

1. **`display: contents` pruned entire pages.** Such an element generates no box, so
   `getBoundingClientRect()` is 0x0 and `visible()` returned false. claude.com wraps its whole
   document in one (`.cds-root`), so `read({full:true})` returned **0 characters** for a page holding
   4,688. Fixed in `visible()`: `display: contents` defers to its children.
2. **Outline was tag-name only.** mistral.ai renders every section title as a plain `<div>`, so
   `browser_outline` said "(no headings found)" on a page with 60 headings. Added `visualHeadings()`
   — infers headings from computed font-size and weight against the page's own measured body size,
   ranks distinct sizes onto levels — used only when fewer than `HEADING_FLOOR` (4) real headings
   exist, so well-marked-up pages are untouched. `section()` now stops at the next peer heading by
   element identity rather than tag name.

3. **Reading a section of an inferred-heading page returned the heading and nothing else.** A real
   heading is followed by its content as a sibling; an inferred one is a leaf buried in a wrapper,
   with its content in another branch. `section()` now climbs to the nearest ancestor holding
   substantially more text than the heading and stopping short of another heading of the same rank.
   Mistral sections went from ~100 to ~350 characters each, 908 -> 2,023 across seven of them
   against a 3,200-character page.

4. **`section()` returned an empty body on every page, always.** Found by testing, not review. It
   cloned nodes into a detached `<div>`; every clone has `isConnected === false`, which is the first
   thing `visible()` rejects on, so `toMarkdown` filtered the whole section away. Wikipedia sections
   read 0 characters. It now collects the *live* elements between one heading and the next peer and
   passes them as `{ children: [...] }` — `toMarkdown` only ever reads `node.children`.
   Wikipedia section 0: **0 -> 11,098 chars**. Mistral sections: 100 -> 350 -> 258-1,867.

Then a fresh-context review of the diff found four more, all reproduced and fixed:

- **Real headings were duplicated by their own children.** `<h1><span>Title</span></h1>` produced two
  outline entries, and the span landed in the stop set so the h1's own section broke immediately.
  Now anything inside an `h1..h6` or `[role=heading]` is skipped.
- **Every bold phrase in prose became a heading.** Dropped `strong,b` from the candidate selector,
  skip anything inside `p,blockquote,dd`, and skip inline boxes surrounded by more text.
- **Two incompatible level scales were compared.** An h-tag number is semantic; an inferred rank is
  "how big relative to this page". A large pull-quote outranked a real `<h2>` and truncated it.
  Inferred levels now start below the deepest real level.
- **`bodyFontSize` measured containers, not prose.** It counted each element's whole subtree, so
  wrappers outweighed the paragraphs inside them. Now counts only an element's own text nodes.
- **`display: contents` let hidden content into `find()`/`snapshot()`**, which call `visible()`
  without walking ancestors. Now uses `Element.checkVisibility()`, which consults the chain.
- **`read({section})` bypassed `maxChars`.** Capped.

The review's performance concern ("seconds to tens of seconds") did not reproduce: outline on a
17,036-element Wikipedia page takes **39ms**, section 25ms, read 72ms.

Extractor `version` 2 -> 6 (the guard and `EXTRACT_VERSION` both key off it).

**Known limitation, accepted:** scorptec's outline is empty because its product names live in `<a>`
elements, and admitting links as heading candidates floods the outline on every site. A product grid
is not a heading hierarchy; `browser_read` returns the products and `browser_snapshot` gives refs.

## Measured, after

| site | extracted | outline entries |
|---|---|---|
| claude.com | **0 -> 1553** | 2 |
| mistral | 3187 -> 3435 | **0 -> 34** |
| scorptec | 4606 | 0 -> 4 |
| centrecom | 308 | 1 -> 4 |
| raycast | 9147 | 20 (unchanged, correctly) |

Regression set (`npm run verify:extract`) still passes all three pages. Typecheck clean.

## Hypotheses tested and killed

- **Lazy loading / scroll reveal is the problem.** It is not. Scrolling every page to the bottom in
  viewport steps and re-reading recovered 0% on four of five sites and 8% on mistral.
- **Centre Com is a harness failure.** It is not. `/graphics-cards` genuinely 404s; the harness
  correctly reported "Page not found". My test URL was wrong.

## Research verdicts

- **Bitwarden as an Electron extension: no.** Electron closed "Support for Manifest V3 Chrome
  Extensions" (#49984) as *not planned* in Feb 2026. `chrome.offscreen`, which Bitwarden's MV3
  build depends on for clipboard work, is not implemented. Popup UI needs the third-party
  `electron-chrome-extensions`, whose MV3 parity on Electron 43 is unverified. Nobody has publicly
  reported Bitwarden working this way. Loading a vault-decrypting extension into the app's own
  session also inherits every one of the app's privileges with none of Chrome's review pipeline.
### Vision models, measured rather than researched (2026-08-03)

Ollama **is** installed and running (0.32.5, port 11434). `glm-ocr:latest` (2.22 GB, 1.1B) and
`qwen3-vl:8b` (6.14 GB) are both present. Tested against a real 1264x735 capture of mistral.ai.

| model | time | output | verdict |
|---|---|---|---|
| `glm-ocr:latest` | 36.6s | 15,937 chars for a viewport holding ~200 | First pass accurate, then **looped** the same block indefinitely. This is upstream ollama issue #14117 ("token repeat limit reached") reproducing exactly. Document-tuned; UI screenshots are out of its distribution. |
| `qwen3-vl:8b` | 94.2s | 1,297 chars | Accurate transcription and a sensible layout description. |

**But vision found nothing the DOM did not already have.** Every string `qwen3-vl` reported —
"IN YOUR HANDS", "FRONTIER AI", "Introducing Robostral Navigate" — is present in `textContent`, and
"IN YOUR HANDS" is additionally an `aria-label`. It is absent only from `innerText`.

So the gap that looked like it needed OCR is a **DOM extraction gap**: the extractor ignores text
that is not in the render tree's inline flow. Fixing that is milliseconds and deterministic;
`qwen3-vl` costs 94 seconds and is probabilistic.

`qwen3-vl` was also confidently wrong on the one thing only vision could judge — it reported "no huge
empty areas" on a screenshot whose top-left half is a large white void.

The remaining honest case for vision is narrow and untested: the page has **1 `<canvas>` and 89
images**, and whether any image carries text found nowhere in the DOM is still unknown.

### Image-heavy pages reverse that conclusion (2026-08-03)

The mistral.ai test was the friendly case. Tested against product photography on
`scorptec.com.au/product/graphics-cards`, where the alt text is only "GeForce RTX 5070" but the
image is a retail box covered in printed specifications.

Of eight terms the model read off the box, **six appear nowhere in the page's DOM**:

| term | in DOM? |
|---|---|
| DLSS, RAY TRACING, REFLEX, STUDIO, GDDR7, PRIME | **no — image only** |
| ASUS, NVIDIA | yes |

So on image-heavy pages vision does add real information. **But only with preprocessing.**

| input | result |
|---|---|
| raw 2144x2236 PNG **with alpha** | qwen3-vl invented an entire laptop spec sheet - "Model Number: HX-789", "Intel Core i5", "16GB DDR4", "Serial Number: SN-9A5B3F1K". Fluent, confident, wholly fabricated. |
| same image flattened onto white, resized to 982x1024 JPEG | read correctly in 76.3s: ASUS / PRIME GRAPHICS CARD / GEFORCE RTX 5070 / OC 12GB / DLSS 4 \| RAY TRACING \| REFLEX \| STUDIO / NVIDIA |

**Flatten transparency onto white and cap the long edge at ~1024px before any OCR call.** Skipping
that does not degrade the output, it replaces it with confabulation.

### Which model, measured on equal terms

The first comparison was unfair: preprocessing was introduced for `qwen3-vl` and never re-run for
`glm-ocr`. Corrected, all inputs flattened onto white and capped at 1024px:

| image kind | glm-ocr | qwen3-vl |
|---|---|---|
| product photo, preprocessed 982x1024 | **3.7s**, accurate, caught `GDDR7` | 76.3s, accurate, **omitted** `GDDR7` |
| product photo, raw 2144x2236 with alpha | meta-babble, byte-identical for two different images | fabricated a laptop spec sheet |
| UI screenshot, preprocessed 1024x595 | **loops** - 14,064 chars, misread "FRONTIER AI" as "FRONTIER A2" | 94.2s, accurate plus a correct layout description |
| describe a canvas / judge a layout | cannot - transcription only | the only option, and it was wrong about a large empty area |

Neither is simply better. **glm-ocr is ~20x faster and more complete on printed text over product
photography and document-like images, and unusable on UI screenshots, where it degenerates.
qwen3-vl is slow but robust across image kinds and is the only one that can answer a question rather
than transcribe.**

Route by intent, not by preference:

- content image (product shot, infographic, logo, photo of text) -> `glm-ocr`, fall back to
  `qwen3-vl` when the output repeats
- screenshot of a UI, or any question that is not "transcribe this" -> `qwen3-vl`
- always: flatten alpha onto white, cap the long edge at 1024px
- always: detect looping - if total length far exceeds the length of the unique lines, discard

**Methodology warning.** The novel-word metric scored the fabricated laptop sheet **90 new words** -
it read as the strongest result of the run. A metric that measures "text not in the DOM" rewards
hallucination perfectly. Only reading the output caught it. Any OCR feature needs its own output
inspected, not just counted.

### Instagram, logged out

Real content is served without login - `instagram.com/nasa/` gives 1,540 chars including the bio,
follower count and post titles; a tag page gives 6,512. But `article` count is 0, there are no
captions, and the substance is inside 29 thumbnail images. It is a genuine text-in-images case, and
the parts worth reading are behind the login wall.

- **OCR over page screenshots: narrow value only.** GLM-OCR is real (0.9B, MIT, `ollama run
  glm-ocr`), but doc-OCR models are trained on scanned documents, not UI. Everything OCR would infer
  about hierarchy, position and occlusion is already exact via `getComputedStyle` /
  `getBoundingClientRect` / `elementFromPoint`. Genuinely irreplaceable only for canvas/WebGL pixels
  and text baked into images. **Ollama is not installed on this machine** — port 11434 refuses, no
  process; the only local listener found was Steam on 8080.
- **Skill/plugin discovery: use a hook, not a 24/7 agent.** `UserPromptSubmit` hooks return
  `hookSpecificOutput.additionalContext`, which injects text beside the prompt. That fires inside the
  existing session at zero idle cost. A background Sonnet would bill against the separate Agent-SDK
  credit pool.

## Remote UI: voice, new chat, profiles (2026-08-03)

**"How do I start a new chat" — it already exists.** `src/remote/main.ts:93` renders a `+ New`
button on the session list; it opens a project picker and `POST /api/sessions` with only a `cwd`
starts a fresh PTY (`resume` requires *both* `sessionId` and `resume: true`). Confirmed present in
the bundle the installed app is serving (`out/remote/assets/*.js` contains "+ New" / "New session").
The user had never seen it because every request was 401ing on the missing `?k=` key.

There is no "temporary chat" concept - Claude Code writes a transcript for every session. The
closest honest equivalent is a dedicated scratch directory.

**Voice: the whole backend is already running.** `lena-stt-server` is live on this machine at
`127.0.0.1:17890` - faster-whisper `large-v3-turbo` on CUDA, `{"ok": true, ..., "tts": true}`.
Verified end to end: a SAPI-generated WAV posted to `POST /transcribe` came back
`"Add a voice button to the stoke remote interface and wire it to whisper"` in **0.96s**.

Design:
- record on the phone, convert to 16-bit PCM mono WAV **in the browser** via
  `AudioContext.decodeAudioData` - avoids an ffmpeg dependency and sidesteps the iOS/Android
  container split (Safari records mp4/aac, Chrome webm/opus; `decodeAudioData` handles both)
- `POST /api/transcribe` on Stoke's remote server, which forwards to the STT server
- **proxy through Stoke rather than exposing the STT server**: it has no auth at all (its security
  boundary is Tailscale), while Stoke already gates on Cloudflare Access + key
- drop the text into the existing textarea rather than sending it, so it can be edited first

**Profiles: the data already exists.** Every project carries `group` - the parent folder basename
(`src/shared/types.ts:60-76`). The four roots map exactly onto the profiles wanted:

| folder | repos | identity (per `G:/Code/CLAUDE.md`) |
|---|---|---|
| `personal` | 9 | realvinn / contact@vinn.dev |
| `school` | 4 | rmitvinh / s4166357@student.rmit.edu.au |
| `gitea-company` | 8 | Vinh / contact@vinn.dev |
| `gitea-vibe` | 1 | Vinh / contact@vinn.dev |

`Sidebar.tsx:52-59` deliberately demotes `group` ("Recency is the useful axis"). A profile is
therefore a filter over `group` plus per-profile defaults (model, permission mode, default cwd) -
surfacing a concept that already exists, not inventing one.

## Status

- [x] Read HANDOFF.md
- [x] Check what is running locally
- [x] Measure page reads against the five test sites
- [x] Research fleet (extensions / harness SOTA / OCR / ecosystem / logging)
- [x] Fix `display: contents` and the outline; verify
- [ ] `browser_wait_for` — still the highest-value missing primitive
- [ ] Decide on the remaining six threads with the user

## Gotchas (new this session)

- **`await app.whenReady()` at top level in an Electron ESM script never settles.** The app quits
  with exit 0 having printed nothing. Use `app.whenReady().then(main)`. Verified on 43.2.0.
- **Destroying each window between iterations quits the app** via the default `window-all-closed`
  handler, silently, mid-loop, with exit 0. Add `app.on('window-all-closed', () => {})`.
- **`app.exit()` does not flush a piped stdout.** Write results to a file and read them back.
- **Nested backticks inside a template literal** terminate it early — a `SyntaxError` before any
  code runs. Build injected scripts from an array of lines.
- **Do not patch JS files with Python heredocs.** `\n` in the patch text became a literal newline
  inside a string literal twice and cost two runs.
- Carried forward: installed Stoke holds a single-instance lock (use `--user-data-dir`);
  PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM that silently breaks `settings.json`.
