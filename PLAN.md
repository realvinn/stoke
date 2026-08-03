# PLAN — Stoke

The single live plan. Five earlier plan documents (`PLAN-HARNESS.md`, `PLAN-HARNESS2.md`,
`PLAN-OVERNIGHT.md`, `PLAN-MULTI-MACHINE.md`, `PLAN-0.3.2.md`) were folded into this one on
2026-08-03 and deleted; git holds their full text, including the raw measurement tables that
are summarised here as conclusions.

## The goal, in the user's words

> Create a wrapper / skin for Claude Code. Make it look nice. Easy to navigate through
> projects. An app I just open and I'm immediately into Claude Code. Easily access bypass
> permissions. Easily see all the context windows and manage through all of it. Maybe a
> built-in browser for Claude to use, so it's all neat and easy in one app — sick of having
> to open this terminal, open that terminal. Make it work on Mac and Windows (Windows at
> home, Mac at work). Simplistic but with detail — bespoke, not plain black shadcn boxes.
> Accents of light orange, or a theme I can change whenever. Basic CSS theming, kinda like
> Discord.

That goal is met. Everything below is what is still open on top of it.

## Where things stand — 2026-08-03

**0.3.2**, tagged `10b4ad5`, installer built at `release/Stoke-0.3.2-x64-setup.exe` and
**verified against a real install on 2026-08-03** — typecheck, usage and all 16 security
checks pass, first run is clean, and the new window frame is correct packaged. See item 1.

The app ships: PTY-wrapped real `claude` CLI, project and session discovery, the live
context meter, usage bars, profiles, a docked Chromium exposed to Claude over MCP as 17
tools, themes, remote phone access over a Cloudflare tunnel with voice input, and
self-update.

## Current build — four workstreams, started 2026-08-03

The user's asks, kept verbatim because they are the spec:

> okay I need you to launch a fleet of agents and build me a proper way to copy and paste as
> well as for windows build a mic passthrough from website and app into claude code […] other
> things we need is a proper way to make themes and profiles and the sonnet subagent that
> watches and updates my notion/clickup (should be per profile because i only need this for
> work)

On what the mic passthrough actually means — this reframes the whole feature, so it is quoted
in full:

> because claude code has a built in /voice it does the transcriptions already I want to hold
> down a button on mobile and on desktop I can just hold space and it should essentially
> connect me to my claude code remotely and pass through my phone or laptop mic through into
> the claude code session that im in

**Stoke does not transcribe.** Claude Code's own `/voice` does. Stoke's job is to make the
laptop mic *or the phone mic* be the microphone the `claude` process hears. VB-Audio Cable is
the bridge: play the audio into `CABLE Input`, and `CABLE Output` presents it as a recording
device. Push-to-talk: hold a button on the phone, hold space on the desktop.

On the worklog agent:

> on every chat this sonnet is just an overlay like a list or something on the side and I can
> accept each or just press accept all

So it is a **review queue, not an auto-writer.** It proposes Notion/ClickUp items in a side
panel; nothing is written until the user accepts an item or presses Accept all.

On profiles:

> I should choose it manually or create a new profile and it will ask me to create a name and
> location like if I do G:/Code name Task it creates task or if I do G:/Code/Task name Task it
> just uses that file so theres not weird double nesting, but if I create a new profile and
> select a folder with existing sub folders with projects we should auto import all of them

So: manual creation with name + location; if the chosen folder's basename already equals the
name, use it rather than nesting a duplicate inside it; and if the chosen folder contains
subfolders that are projects, import them all.

### Build order

Derived from a 7-agent recon pass. Wave 0 is shared plumbing and blocks the rest.

- **Wave 0** — new IPC channels; move `src/main/mcp/color.ts` to `src/shared/color.ts` (the
  renderer cannot import from `src/main`); lift the WAV helpers out of `src/remote/voice.ts`
  into `src/shared/audio.ts` rather than forking them; own the application `Menu` explicitly;
  add `verify:profiles` to `npm run check`, which today is only typecheck + verify:context +
  build.
- **Wave 1** — (A) clipboard, (B) the profile store, (C) audio capture core.
- **Wave 2** — (D) theme editor, (E) profile editor, (F) the voice passthrough itself,
  (G) a headless `claude -p` runner in `src/main/agent.ts`.
- **Wave 3** — (H) the worklog proposal queue end to end.

### Live bugs the recon found, worth fixing regardless

- **Paste is not bracketed.** `TerminalView.tsx:109-114` does a raw `pty.write`, so every
  newline in a multi-line paste acts as Enter and fires a separate prompt; Windows CRLF can
  double-submit. `term.paste()` normalises newlines and brackets only when the CLI actually
  advertises DECSET 2004. **Fixed in wave 1-A.** The same bug exists independently in the
  phone UI's `submit()`.
- ~~**A derived profile never repaints the accent.**~~ **Fixed.** `App.tsx` resolved against the
  static `PROFILES` list while the sidebar derived its own, so a folder-derived profile coloured
  its chip and nothing else. The list is now derived once in `App` and passed down, which
  removes the only place the two could disagree rather than patching the symptom. Proven by unit
  test — `profileFor('Code')` returns null without the derived list — and the named path
  re-verified in the running app: All clears the accent, Personal `#ff9552`, Study `#ff6b6b`,
  Work `#5fd08a`. **`verify:profiles` is now part of `npm run check`**, which it was not.
- **A malformed persisted custom theme takes the renderer down at boot** — `applyTheme` throws
  and `store.ts` validates only `Array.isArray`.
- **`pty.ts:167` deletes the session before `onExit` fires**, so a session id is unavailable in
  the exit handler. Capture ids first — this blocks any exit-triggered work.
- Four hardcoded `#fff` remain in `app.css`, against the no-hardcoded-colour rule.

### Worklog execution — settled by probe, 2026-08-04

**A headless `claude -p` run does expose the claude.ai connector tools.** This was the load
-bearing unverified assumption under the whole worklog design, and it is now confirmed rather
than inferred: a one-shot run with `--allowedTools mcp__claude_ai_Notion__notion-search`
returned `AVAILABLE 25`, with `is_error: false` and `permission_denials: []`. So the execution
model stands — run the real CLI headless, no Agent SDK, no separate credit pool.

`--allowedTools` is the right lever for this. It let the probe reach exactly one read-only tool
instead of opening permissions, and the worklog runner should use the same narrow allowlist
rather than `bypassPermissions`, which PLAN already flags as a real blast radius for an
unattended agent against write-capable MCP servers.

**The probe also priced the feature, and the number is a design constraint.** That single
trivial prompt cost **$0.50**, because it defaulted to Opus and paid 44k tokens of cache
creation against a 104k cached context. A proposal run on every chat at that price is not
viable. So the runner must:

- pass `--model sonnet` explicitly — the user asked for a "sonnet subagent" and this is why it
  matters, not merely a preference;
- send the smallest possible prompt, since `readTranscript()` already yields structured turns
  and the run does not need the repo loaded;
- avoid re-sending context per proposal — batch a session's worth rather than firing per turn.

Left unchecked this is the kind of feature that quietly costs more than it saves.

### Worklog destinations — settled

- **Notion:** the `✅ Tasks` data source, `collection://368d3f2d-1f02-817c-b193-000b208e36bd`.
  Its schema already matches what the worklog skill writes, with no drift.
- **ClickUp:** *Vinh Tasks → Tasks*, list `901615258684`. The Team Space is deliberately not
  used: its only list is `IT Support Tasks`, a helpdesk queue whose statuses are
  pending/in progress/waiting/resolved, and filing engineering work there would pollute a
  support board.

### Voice: Stoke owns the Windows default recording device — settled

`/voice` reads the Windows **default** capture endpoint and cannot be pointed at a device.
Settled against the 2.1.220 binary, not inferred: the settings schema is a *closed* three-key
Zod object, extracted verbatim —

```
voice: { enabled?: boolean,
         mode?: "hold" | "tap",     // hold (default) = hold to talk; tap = tap to start, tap to stop+submit
         autoSubmit?: boolean }     // hold mode only
```

A byte scan for `inputDevice`, `audioInputDevice`, `captureDevice`, `deviceIndex`,
`enumerateDevices` and six other candidate names returned **zero hits**, and the recording
call site takes two callbacks and no options argument at all. The default keybinding is
`voice:pushToTalk` → `space`, context `Chat`. Re-check this on every CLI upgrade; it is proven
for 2.1.220 only.

So passthrough means owning that default, and the user has agreed Stoke should manage it.

**`tap` mode exists and the phone must use it.** Hold mode infers key-hold from terminal
auto-repeat, which a synthesised PTY write cannot faithfully reproduce from a phone. Set
`"mode": "tap"` before launching, or send `/voice tap` once, which persists it.

**Two facts about `/voice` that were not previously known and change the calculus:**

- **It is not local.** Audio is streamed to Anthropic over
  `wss://…/api/ws/speech_to_text/voice_stream` at 16 kHz mono linear16. Nothing is
  transcribed on the machine. Transcription itself costs no tokens.
- **It requires an OAuth Claude.ai login.** It fails on a raw API key, and on Bedrock, Vertex
  and Foundry, and is blocked under HIPAA org policy. Stoke must hide the mic affordance for
  those sessions rather than let it fail silently.

That matters because the user already runs faster-whisper large-v3-turbo on CUDA locally. The
existing transcribe path keeps audio on the machine and works on any auth mode; `/voice` does
neither. Neither is strictly better - but "use the built-in because it already transcribes" is
not the whole story, and the choice should be made knowing this.

`CLAUDE_CODE_VOICE_FORWARD_INTERIMS_TYPED` forwards interim transcripts as typed text, which is
the cheapest way to show live dictation in the Stoke or phone UI. Recording auto-stops after
15 s of silence or 2 minutes. `VOICE_STREAM_BASE_URL` overrides the endpoint.

**Build detect-and-warn first, hijack second and opt-in.** Detection is nearly free and helps
under every outcome; the hijack is a global machine setting Stoke does not own, and it carries
restore-on-crash bookkeeping.

**Detect-and-warn is built and the write path was dropped.** `src/main/audio/defaultDevice.ts`
reads the default capture endpoint through `powershell.exe -NoProfile` plus `Add-Type`,
compiling COM interop against `MMDeviceEnumerator` at runtime with nothing installed, and
`MicrophoneNotice` surfaces it in Settings — amber when the default looks like a virtual cable.

Stoke deliberately does **not** set the device. Under the settled design nothing needs it: the
desktop uses `/voice` against a correct default and the phone uses Stoke's own transcription, so
`setDefaultCapture` had no consumer, was never exercised, and would have been an untested write
to a global machine setting Stoke does not own. Deleted rather than kept as dead code.

Read via PowerShell rather than `navigator.mediaDevices`, which is the other way to learn the
default: `enumerateDevices()` hides labels until a `getUserMedia` grant, and prompting for the
microphone purely to warn about the microphone is a bad trade when the desktop captures no
audio and has no other reason to hold that permission.

Verified: 17 assertions on the matcher — 7 virtual devices flagged, 7 real microphones not,
3 against the live machine — plus the healthy state read out of the running Settings sheet, and
the warning styling confirmed to resolve (`--warning` `#e8b552`, amber against a muted hint).
Note that `window.stoke` cannot be monkey-patched from the page: contextBridge freezes it, so
stubbing the IPC call to force the warning branch silently does nothing.

**The open risk that could sink phone push-to-talk:** `space` is the push-to-talk binding, and
what it does with a *non-empty* prompt buffer is unresolved. Test that before building on it.

**This is already causing a live fault.** The default capture endpoint is currently
`CABLE Output (VB-Audio Virtual Cable)` on all three roles, which is a silent virtual cable,
so hold-space dictation records nothing today. VB-Audio Cable's installer claimed the default.
Verified from the registry: endpoint `{b018783f-485b-4b79-9e25-f352e02edf2d}` →
`FriendlyName = CABLE Output`. `~/.claude/settings.json` holds
`voice: { enabled: true, mode: "hold" }`, so the feature itself is on and working - it is
merely listening to the wrong device.

Consequences for the design:

- **The resting state is the user's real microphone**, so desktop hold-space works with no
  Stoke involvement at all. Stoke writes nothing and adds no key handling for it.
- **Phone mic is an armed mode, never a persistent state.** Arming flips the default to
  `CABLE Output`; disarming restores it. The two are mutually exclusive, and the alternative -
  holding the laptop mic open permanently to loop it into the cable - is a hot mic with no
  user gesture and is rejected.
- **No native module needed.** `powershell.exe -NoProfile` plus `Add-Type -Language CSharp`
  compiles COM interop against `MMDeviceEnumerator` and `IPolicyConfig::SetDefaultEndpoint`
  with nothing installed. This keeps the no-native-rebuild constraint intact.
- **Write the breadcrumb before the flip**, and restore on next launch if the app died while
  armed. Electron gets no hook on a hard kill, so that is the only crash-safe path.
- **macOS is out of scope for passthrough.** BlackHole is a driver install and the
  default-input flip needs entirely different APIs; non-Windows routes to the transcribe
  fallback that already exists.

### Decisions taken from the recon, so they are not re-litigated

- **Image paste already works and must not be broken.** Plain `Ctrl+V` falls through to xterm
  as `\x16`; Claude Code's own handler then reads the OS clipboard directly. No image bytes
  need to cross the PTY. Do not add a handler that swallows plain `Ctrl+V`.
- **The context menu is renderer-drawn, not a native Electron `Menu`** — a native menu cannot
  be themed, and all colour goes through CSS custom properties.
- **The worklog agent runs headless `claude -p`, not the Agent SDK.** The SDK bills against a
  separate credit pool; the project is committed to wrapping the real CLI. Model the spawn on
  `src/main/updates.ts`, not on `pty.ts`, which only yields scrollback.
- **The worklog gate keys off the session's project group, not the active sidebar chip.** The
  chip is a view filter and a Work session can run while the user browses Personal. This keeps
  "a profile is a view filter, never access control" intact.
- **Never write Claude's own config files** to deliver hooks; pass `--settings` the way
  `--mcp-config` is already injected in `cli.ts`.
- **Never use `getUserMedia` with `chromeMediaSource: 'desktop'` for audio on Windows** — it
  kills the renderer outright, and the upstream issue is closed as not planned.

## Open work, in the order it is worth doing

### 1. Verify 0.3.2 against a real install — DONE, 2026-08-03

Run against the installed build at `%LOCALAPPDATA%\Programs\Stoke` with `%APPDATA%\Stoke`
renamed aside and afterwards restored. All three items closed.

**The suites, against the installed 0.3.2:**

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean, both tsconfigs |
| `npm run verify:usage` | all pass, including the live account call |
| `npm run verify:security … --access` | **16 passed, 0 failed** |

**First run: there is no first-run setup flow, and that is the finding.** The app launches
straight into the working UI. None of the four predicted failure modes occurred, because
nothing is set up eagerly:

- A clean launch creates `%APPDATA%\Stoke` holding Electron's own files plus `.updaterId`
  and `mcp-browser.json`. **`settings.json` is not written at all** until something changes
  a setting — it appeared, at 904 bytes, only once Settings was opened. So "settings written
  before the directory exists" cannot arise.
- **The remote token is generated zero times, not twice.** Remote access is off on a clean
  profile and no token exists until "Turn on" or "New key" is pressed.
- **The tunnel prompts for nothing.** It sits stopped and offers Run named tunnel, Quick
  tunnel, and a "One-time setup commands" affordance. Nothing a first-timer is forced to
  answer.
- **The profile row is not empty.** It rendered All / Personal / Study / Work. Profiles come
  from projects discovered through `~/.claude.json`, which lives outside `%APPDATA%\Stoke`
  and so survived the reset. Vibe is absent only because no `gitea-vibe` project has ever
  been opened by the CLI — correct behaviour for folder-derived profiles, not a defect.
- The CLI auto-detected at `~/.local/bin/claude.exe`, 2.1.220. Version read "0.3.2. Up to
  date." The renderer console stayed clean throughout.

**The gap this did not close:** a machine with no Claude history at all. `~/.claude` was left
in place, so the sidebar and the profile row were populated from it. On a genuinely new
machine both would be empty, and "Scanned folders: None yet" means the sidebar would have
nothing in it. Testing that needs `~/.claude` moved aside as well, which is far more
invasive. **That path remains untested.**

**Title bar and window frame: correct in the packaged build.** Verified with `PrintWindow`,
which makes the window render its own pixels — a renderer-side CDP screenshot cannot see the
non-client area at all, and `CopyFromScreen` captures whatever window is on top instead.

- Native minimize / maximize / close render, drawn by Windows.
- The overlay and the app's title bar are both `#0e0c0b` (`--bg-sunken`), so there is no
  seam. Overlay glyphs are `#a89c92`, matching `--text-muted` exactly.
- `.titlebar` computes `padding-right: 143px` from `env(titlebar-area-width)`, and the
  rightmost app element ends at 1337 = 1480 − 143. Exact fit, no overlap, nothing clipped.
- The drag region spans the whole bar with every control marked `no-drag`.
- The usage numbers render in the title bar at the installed window's real width.

**Still not exercised on a real phone.** The shortcut row added in `44e0df4` was measured in
a browser harness at 390px, not on a device. Unconfirmed: whether the overflow fade reads as
"scroll me", whether the first-frame measure fires after layout on iOS Safari, whether
`overscroll-behavior-x: contain` actually suppresses the iOS back-swipe, and whether the
8px-taller row still clears the soft keyboard and home indicator.

**Minor, seen in passing:** stale scratch projects linger in the sidebar marked `missing` in
red. Cosmetic, pre-existing, unfixed.

### 2. `browser_wait_for` — the highest-value missing primitive

Without it the agent polls. It is the one item that appeared on both harness plans and was
never built. Confirmed absent from `src/main/mcp/server.ts`, which defines `browser_open`,
`read`, `outline`, `find`, `snapshot`, `click`, `type`, `select`, `scroll`, `history`,
`changes`, `inspect`, `screenshot`, `design`, `stack`, `security`, `perf` — 17 tools, none
of them a wait.

### 3. The rest of the harness gaps

`browser_tabs`, `browser_dialog`, a batch `browser_fill_form`, a schema-based
`browser_extract`, and incremental snapshots. All not started.

### 4. `browser_responsive`

Resize through breakpoints and report horizontal overflow, clipped text, overlapping boxes,
and touch targets under 24x24. Not started. Note the research conclusion below: breakpoints
declared in CSS diverge from breakpoints that change anything, so this must diff computed
styles across real viewport resizes rather than parse `@media` text.

### 5. Paint metrics need a visible page

LCP, FCP and CLS do not exist while the agent's view is hidden, because Chromium does not
paint a hidden `WebContentsView`. They are currently reported as unavailable, which is
honest but useless. Making the view briefly visible during a measurement would fix it.
Reporting the zeros as "LCP 0ms, good" was the single most misleading thing the tool ever
did — do not regress to that.

### 6. Multi-terminal — design settled, unbuilt

`App.tsx:564` is the only place a `TerminalView` is rendered. This is a structural change
to how terminals are owned and rendered, which is why it has been deferred through three
releases.

The design is settled and should not be re-litigated:

- Hovering near a terminal's edge reveals a FAB that **slides out of the edge**, visually
  part of the edge rather than floating over it.
- Pressing `+` offers: new chat in this folder, new temp chat, or a different folder/chat.
- **Each terminal gets its own browser view**, not one shared browser.
- Two monitors is the motivating case.

### 7a. Tailscale — DONE 2026-08-03, and it retires the Worker router

Stoke can now bind the tailnet address **alongside** loopback, so a phone on the tailnet
reaches the machine directly from anywhere while the Cloudflare tunnel keeps working.

Why alongside and not instead: **cloudflared runs on this machine and dials `127.0.0.1`**
(`tunnel.ts:92`), so binding only the tailnet address would leave the tunnel with nothing to
reach. `bindLan` stays all-or-nothing via `0.0.0.0`, which already covers loopback and the
tailnet — binding it next to `127.0.0.1` would collide on the port.

Detection matches the address range, not the interface name: Tailscale hands every node an
address in `100.64.0.0/10`, and the interface is variously `Tailscale`, `tailscale0` and a
`utun` device. On this machine that correctly picks `100.83.239.24` while ignoring the
ZeroTier (`10.144.99.183`) and NordLynx (`10.5.0.2`) interfaces.

**Access policy is now per-listener, which resolves a conflict the single flag could not.**
Cloudflare requests carry `Cf-Access-*`; tailnet requests can never carry them. So
`requireAccessHeader` is enforced **only on the loopback listener**, read from
`req.socket.localAddress` so it reflects which listener accepted the connection and cannot be
forged by a header. Each path gets the check that fits it and neither weakens the other.

**The cookie's `Secure` flag is keyed off the same thing**, and this was a live trap: a tailnet
connection is plain `http://100.x.y.z:port`, so keying `Secure` off `bindLan` — as the code did
— would have sent `Secure` to a phone on the tailnet, the browser would have silently dropped
the cookie, and every request after the first would have 401'd with nothing to explain why.

Verified against a running build, 7 assertions: loopback without Access headers 401s, loopback
with them 200s, the tailnet path 200s on the token alone, a wrong token and a missing token
both 401 on the tailnet, and `Secure` is present on loopback and absent on the tailnet.
`Get-NetTCPConnection` confirmed exactly two listeners, `127.0.0.1` and `100.83.239.24`, with
no `0.0.0.0`.

**Consequence for the plan: phases 3 and 4 below are dropped.** Tailscale MagicDNS gives every
machine a stable name for free, so the Cloudflare Worker routing `/u/0` and `/u/1`, the sticky
cookie, the picker page and the prefix-awareness work are all unnecessary. It also retires the
trap that design was built around — one named tunnel and one hostname per machine — for any
machine reached over the tailnet rather than a tunnel.

`code.vinn.dev` is still worth keeping for devices that cannot join the tailnet, and for
networks that block WireGuard where Tailscale's DERP fallback does not get through.

### 7. More than one machine

Phase 2 is done — `ae212dc` puts `os.hostname()` in the remote header, the connect link and
the QR caption, so two bookmarks are no longer indistinguishable.

Remaining:

1. **A second machine on its own hostname.** `mac.stoke.vinn.dev`, its own tunnel, its own
   token. Prove two Stokes coexist before adding any router. This alone is usable, and it
   needs a Mac.
2. **A Cloudflare Worker routing `/u/0`, `/u/1`** by sticky cookie, plus a picker page at
   `/`. Design is written up below. The standing recommendation is to build it when the
   bookmark sprawl actually irritates, not before.

The Worker design, kept because it is the non-obvious part: Stoke's page asks for
`/assets/index.js` and opens `/ws` as **absolute paths with no prefix**, so serving it under
`/u/0/` means the browser requests assets the router cannot attribute to a machine. The
cheap way out is a sticky cookie — `/u/0` sets `stoke_slot=0` and redirects to `/`, and
every later request routes on the cookie. That requires no change to Stoke at all and
matches how it would really be used: one machine at a time, switched deliberately. Making
Stoke prefix-aware with `<base href="/u/0/">` is the correct-but-larger option and only
pays off if two machines open in two tabs turns out to matter.

Sharp edges if it is ever built: the WebSocket upgrade must be passed through by returning
the upstream response with its `webSocket` intact rather than reading the body — get it
wrong and terminals silently never attach while every page still loads; the Worker must
forward `Cf-Access-*` headers or every request 401s; the origin hostnames must not be
openly reachable or the router is decoration; and every failure then has three candidates
instead of one, so give the Worker a `/health` route that says which slots it can reach.

**Servers are a different problem.** Stoke is Electron and needs a display. For a headless
box, plain `claude` over SSH in tmux is the right tool. Do not bend the app into a daemon.

### 8. Threads raised and never decided

From the harness round-2 voice message. Each needs a decision from the user before it is
worth building:

- **OCR for text baked into images.** Researched and measured in depth; conclusions below.
  No OCR code exists in `src` — nothing references Ollama or port 11434.
- **Skill / plugin / MCP discoverability.** The verdict was a `UserPromptSubmit` hook
  returning `hookSpecificOutput.additionalContext`, not a background agent — it fires inside
  the existing session at zero idle cost, whereas a background Sonnet bills against the
  separate Agent-SDK credit pool. Not built.
- **A project "blueprint" that must not become a cage.** Never specified further.
- **Dev-vs-prod logging into Sentry / PostHog.** Not started.
- **ClickUp / Notion task sync.** Not started.
- **A git tree showing features.** Recorded as a wish twice; still a wish.

### 9. Known defects, deliberately not fixed

- **`RemoteSettings.tsx:50` polls remote status every 4 seconds** and re-renders the whole
  component. A poll landing inside the async `patchSettings` round trip rewrites a
  controlled input with a stale value and parks the caret. Still live. It is pre-existing
  and shared by the `hostname` field, not specific to the speech-server box. It is a real
  typing hazard and wants a local-draft pattern, but fixing it properly touches every field
  in the sheet.
- **There is no in-app way to disable voice.** `voiceSupported()`
  (`src/remote/voice.ts:22-29`) gates the microphone button on browser capability alone, so
  an empty `sttUrl` fails at press time with a 503 from `/api/transcribe` rather than hiding
  the button. Making empty genuinely mean "voice off" is a small follow-up.
- **`sttUrl` is inert until the remote server restarts.** `CH.settingsSet` never calls
  `remote.start`; only token regeneration does. Every neighbouring remote field behaves the
  same way, so this matches its neighbours rather than inventing a restart. The field hint
  says so.
- **scorptec's outline is empty**, because its product names live in `<a>` elements and
  admitting links as heading candidates floods the outline on every site. Accepted: a
  product grid is not a heading hierarchy, and `browser_read` returns the products.

### 10. macOS

**No Mac code path has ever run.** The mac-specific paths are the `hiddenInset` title bar
and traffic-light padding, the login-shell PATH probe in `cli.ts`, and the Cmd-based
shortcuts. They are written but unexercised. See `.claude/commands/mac-release.md`. This
needs a Mac, not a plan.

## Settled decisions — do not re-ask

| Decision | Choice | Why |
| --- | --- | --- |
| Shell | Electron 43 | `WebContentsView` gives a real embedded browser; mature Win+Mac packaging |
| Build | electron-vite 5 + Vite 7 | electron-vite peers cap at vite ^7, so vite 8 is deliberately NOT used |
| Styling | Hand-written CSS custom properties | No shadcn, no Tailwind — bespoke was the explicit ask |
| PTY | `@lydell/node-pty` | N-API prebuilds for all six targets; no native rebuild step |
| Approach | Wrap the *real* `claude` CLI in a PTY | A custom SDK chat UI would lose skills, MCP, plugins, hooks and the TUI |

- **A profile is a view filter, never access control.** Every profile can reach every file
  and every project. The point is that sitting in a lecture the user does not see chat
  history from unrelated work. From any profile it must stay possible to open Claude's
  history or a directory and add a previous chat, or start a new one anywhere. Profiles
  filter on `group`, the parent folder basename that already exists on every project
  (`src/shared/types.ts`): `personal` → Personal (orange), `school` → Study (red + blue),
  `gitea-company` → Work (green), `gitea-vibe` → Vibe (violet).
- **One named tunnel and one hostname per machine. Never share either, never copy
  `settings.json` between machines.** It carries the token, the hostname and the tunnel
  name — every field that must differ. Copying it, or just accepting the defaults twice,
  registers both machines as connectors on *one* tunnel; Cloudflare then load-balances and
  the phone reaches a random machine per request. It fails as "my sessions vanished", never
  as an error.
- **Bitwarden as an Electron extension: no.** Electron closed MV3 support as *not planned*
  in Feb 2026, and `chrome.offscreen` — which Bitwarden's MV3 build needs for clipboard
  work — is not implemented. Loading a vault-decrypting extension into the app's own session
  would also inherit every one of the app's privileges with none of Chrome's review
  pipeline.
- **There is no "temporary chat".** Claude Code writes a transcript for every session. The
  closest honest equivalent is a dedicated scratch directory.
- **Claude Code's native Remote Control was rejected. Do not re-propose it.**
- **Ship small.** This project's bugs do not announce themselves — they produce plausible
  wrong output. Stacking a structural change on top of unverified ones means a regression
  could have come from either.

## Research conclusions that still bind

Kept because re-deriving any of these costs hours.

**Browser harness**

- **CDP is available unconditionally.** The old comment in `browser.ts` claiming only one
  debugger client may attach was wrong. Chromium supports multiple CDP clients per target,
  so `webContents.debugger` and DevTools coexist — probed both ways against a real page on
  Electron 43. No mutex is needed.
- **`DOMSnapshot.captureSnapshot` is the workhorse for design work.** One round trip returns
  computed styles for every node against a whitelist you must supply, plus layout rects,
  paint order and blended backgrounds. Requesting all properties instead of a whitelist
  balloons the payload — a 20-property whitelist on a Wikipedia article already returns
  2.3 MB across 12,949 nodes in 204ms. Everything per-node
  (`CSS.getMatchedStylesForNode`, `DOM.getBoxModel`) is reserved for elements the bulk pass
  flagged. **A 2.3 MB snapshot must never be serialised toward the model** — analysis runs
  in the main process and only the digest reaches Claude.
- **Compress before the model sees it.** chrome-devtools-mcp turns a 29.8 MB trace into
  under 4 KB of checklist text. That ratio, not the raw data, is the product.
- **Report design as flat annotated lines, not nested JSON.** `token: value (n uses, x%)`
  reads like a design-system README at a fraction of the tokens.
- **Text beats screenshots for grounding**, with the caveat that screenshots earn their
  place where the DOM has nothing to offer — canvas, WebGL, maps.
- **WCAG 2 contrast and APCA Lc disagree, sometimes sharply.** Report both rather than
  picking one.
- **Breakpoints declared in CSS diverge from breakpoints that change anything.** Verify by
  diffing computed styles across real viewport resizes.
- **Passive vs active is a hard line.** Reading headers, cookies, certs, console, DOM and
  bodies the page already fetched is in scope. Probing `/.env`, fuzzing, or requesting
  anything the page did not itself request is not, and stays out unless the user explicitly
  targets their own host.
- **Do not emit dead security advice.** `X-XSS-Protection`, `Expect-CT` and `Feature-Policy`
  are dead; `X-Frame-Options` is a legacy fallback to CSP `frame-ancestors`, not a positive
  on its own. Wappalyzer went closed-source in Aug 2023 and the community forks are frozen
  at that baseline, so runtime global checks are cheaper and more current. Lighthouse dropped
  its known-vulnerabilities audit in v10; RetireJS is the maintained open option. Mozilla's
  Python http-observatory was archived Nov 2024; the successor is
  `@mdn/mdn-http-observatory`, and Google's `csp_evaluator` grades CSP properly.

**Vision / OCR, if it is ever built**

- **On text-first pages, vision finds nothing the DOM does not already have.** Every string
  `qwen3-vl` reported off mistral.ai was present in `textContent` — absent only from
  `innerText`. That gap is a DOM extraction gap, fixable in milliseconds and
  deterministically, not an OCR problem.
- **On image-heavy pages it does add real information.** Six of eight terms read off a
  retail box on scorptec (DLSS, RAY TRACING, REFLEX, STUDIO, GDDR7, PRIME) appear nowhere in
  the DOM.
- **Always flatten transparency onto white and cap the long edge at ~1024px before any OCR
  call.** Skipping it does not degrade the output, it replaces it with confabulation: a raw
  2144x2236 PNG with alpha made `qwen3-vl` invent an entire laptop spec sheet, fluent and
  wholly fabricated.
- **Route by intent.** Content images (product shots, infographics, photos of text) go to
  `glm-ocr` — roughly 20x faster and more complete on printed text. UI screenshots, or any
  question that is not "transcribe this", go to `qwen3-vl` — `glm-ocr` degenerates into an
  infinite loop on them (upstream ollama issue #14117). Always detect looping: if total
  length far exceeds the length of the unique lines, discard.
- **Neither can judge a layout.** `qwen3-vl` was confidently wrong about a large white void
  it was asked to assess.
- **Methodology warning.** A "novel words not in the DOM" metric scored the fabricated
  laptop sheet as the strongest result of the run. Any OCR feature needs its output
  inspected, not counted.

## Standing traps

Repeated because they keep costing time.

- **Verify by running.** Every bug in this project has produced plausible wrong output
  rather than an error. A passing typecheck has caught none of them.
- **Do not force-kill Stoke.** It orphans the CLI children and the restarted app cannot
  reattach. At least three separate confusions have come from this.
- Installed Stoke holds a single-instance lock; dev runs need `--user-data-dir`.
- **Inherited Claude env vars silently break transcripts.** `pty.ts` strips
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_PID`; auth vars are deliberately preserved.
- **The context window cannot be derived from the model id.** Observed usage is the
  authority — over 200k proves the extended tier.
- PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM that silently breaks
  `settings.json`. Write JSON with Node, or use `[System.IO.File]::WriteAllText` with
  `UTF8Encoding($false)`.
- PowerShell reports a `NativeCommandError` for `git push` even on success, because git
  writes progress to stderr. Read the output, not the exit status.
- Electron ESM: `app.whenReady().then(main)`, never top-level await. Add
  `app.on('window-all-closed', () => {})` or a script that destroys windows in a loop quits
  the app mid-run, silently, with exit 0. `app.exit()` does not flush a piped stdout — write
  results to a file and read them back.
- Nested backticks inside a template literal terminate it early, a `SyntaxError` before any
  code runs. Build injected scripts from an array of lines.
- xterm's WebGL renderer draws into a canvas, so `.xterm-rows` is empty in the DOM. Verify
  terminal output from a screenshot, never `textContent`.
- The docked browser is its own CDP target. Test scripts attaching by `type === 'page'` must
  filter on the URL or they drive the wrong page.
- The `WebContentsView` paints **above** the renderer's DOM, so it must be detached while the
  command palette or settings sheet is open.
- A `WebContentsView` outside the window's view tree gets a 0x0 viewport and never lays out.
  Mount views immediately and merely hide them.
- Reset per-page logs on `did-start-navigation` filtered to main-frame cross-document.
  `did-navigate` fires after the main document response; `did-start-loading` fires *again*
  after load, because a client-side router prefetch counts as loading — on tailwindcss.com
  the second event arrived with 53 completed requests already recorded and took all of them.
- electron-builder: an explicit `arch:` list in the config overrides the CLI flag.
- The usage endpoint is undocumented. Report unavailable rather than guess.

## Shipped

| Version | What it added |
| --- | --- |
| 0.1.0 | The app: PTY sessions, project/session discovery, context meter, docked browser, theming |
| 0.2.0 | Browser MCP server, design/perf/stack/security tools, extractor fixes |
| 0.3.0 | Remote phone access, voice input, usage bars, profiles, self-update |
| 0.3.1 | Folder-derived profiles, `/voice` answered on the phone, usage-endpoint backoff |
| 0.3.2 | Draggable window with native Windows buttons, limits in the title bar, `sttUrl` in Settings, the phone shortcut row |

Full detail is in git history; each commit message explains why and names the bug it fixed.
