# Hermes platform, slice 1 (this Mac) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hermes on this Mac talks to its owner in a "Hermes · this Mac" tab in Stoke (replies, cron
`deliver=stoke`, `hermes send --to stoke` and the approval, question, confirm and picker cards)
through a "Stoke" messaging-platform plugin the owner installs on Hermes's side, over a private
Unix socket, with Stoke running and reading nothing of Hermes's.

**Architecture:** A Python plugin (`integrations/hermes-platform/`, manifest `stoke-platform`,
platform `stoke`) registers with Hermes's platform registry and dials Stoke's Unix socket; the two
ends authenticate each other with Ed25519 keys pinned at a six-digit-code pairing. In Stoke an
electron-free `src/main/channels/` (listener, keys and peers, pairing, store, service) writes every
Hermes frame to disk before acknowledging it and pushes views to a new `channel` tab kind, under
pure, transport-neutral rules in `src/shared/channel.ts` (the wire) and `src/shared/channelView.ts`
(the conversation), which slices 2 and 3 reuse unchanged. Both languages assert one set of test
vectors.

**Tech Stack:** TypeScript, Electron main + preload + React renderer, `node:net` and `node:crypto`,
`node --experimental-strip-types` verify suites, plain CSS custom properties. Python 3.11–3.14 with
asyncio, `cryptography` and stdlib `unittest` for the plugin, against Hermes clones at pinned tags.

**Spec:** `docs/superpowers/specs/2026-10-28-hermes-platform-design.md`

## Global Constraints

- **The owner's hard rule, verbatim:** "dont import any hermes i would have to select stoke as a messaging platform for hermes". No Stoke code (`src/`, `build/bin/`, `install/`) runs a `hermes` command (not even `--version`), reads or writes under `~/.hermes`, adds a `CODING_CLIS` row, a chat-index source or a terminal agent for Hermes, or has a button that installs the plugin or opens Hermes's setup. Stoke shows Hermes commands only as text with a Copy command button.
- **Hermes's only power:** add, edit and remove its own entries and cards in its own tab, show typing, and cause at most one OS notification per peer per 10 s. No frame opens, focuses or closes a tab, writes to a pty, reads a file, loads a remote URL, uses the docked browser or changes a setting; any other frame type is refused `unknown-type`.
- **Nothing listens on a network port:** the listener is `node:net` on a filesystem path, never a port, and off on `win32`; the plugin connects with `asyncio.open_unix_connection` only.
- **Socket path and modes:** `~/.stoke/channel/stoke.sock` when `app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')`, else `<userData>/channel/stoke.sock`; refused past 100 bytes; the folder passes `lstat` (a directory, not a link, owned by `process.getuid()`, `(mode & 0o077) === 0`, narrowed with `chmod 0o700` when ours and wider) and the socket is `chmod 0o600` after `listen`; only our own socket answering `ECONNREFUSED` is ever unlinked. The plugin's default is `~/.stoke/channel/stoke.sock`, overridden by `STOKE_SOCKET_PATH`.
- **Mutual authentication:** `hello {v:1, stoke, nonce, app}` → the plugin writes nothing unless `stoke === STOKE_PEER_KEY` → `auth {v:1, hermes, nonce, role, sig, agent, plugin}` → Stoke destroys the socket with no further byte unless `hermes` is in peers.json and `sig` verifies over `authText` → `ok {v:1, peer, sig}` over `okText`, which the plugin verifies; no inner frame before `ok`; handshake deadline 5 000 ms; labels `stoke-channel/v1/*`, never a `HUB_LABELS` value.
- **Message caps (`CHANNEL_LIMITS`, mirrored by `wire.LIMITS`):** line 524 288 bytes with its newline; text 65 536 UTF-8 bytes; composer 32 768 characters; approval command 16 384 bytes, reason 1 024; label 48 printable ASCII characters; media 10 485 760 bytes in parts of 196 608; 12 clarify choices; 4 approval actions; 50 options; 64 providers × 500 models; 16 peers; Python `MAX_MESSAGE_LENGTH` 16 000.
- **Rate limits and timers:** per connection, content frames burst 60 then 20/s and typing burst 10 then 2/s (`CHANNEL_RATES`); 3 malformed lines close a connection; 1 `live` + 4 `send` connections per peer; 1 pending pairing; 3 failed pairings per rolling hour; pairing TTL 300 000 ms; ack wait 10 000 ms both ways; typing shown 8 000 ms after the last `on: true` (`CHANNEL_TIMERS`). Every timer is a constructor option a suite sets (gotcha 174).
- **Approvals:** Stoke never answers a card by itself; Hermes's `approvals.timeout` (300 s by default) is the deny. An answer is claimed in main before its first `await`; only the oldest `open` approval card per `session` is answerable; an answer written but not acked within 10 s is `unknown` and never answerable again; one that could not be written goes back to `open`.
- **Persist, then acknowledge:** Stoke acks a Hermes frame only after `ChannelStore.append` has resolved; a frame id (and part) it already holds is acked again and applied once.
- **Python:** 3.11–3.14; parses on 3.11 (`from __future__ import annotations`, no PEP 695, no 3.12 f-string nesting); `asyncio.get_running_loop()` only; stdlib plus `cryptography` only. `wire.py`, `keys.py`, `transport.py`, `pairing.py` and `media.py` import nothing of Hermes's; `adapter.py`, `cards.py`, `standalone.py` and `wizard.py` import only the names below.
- **Hermes contract:** pass only the v0.21.5 tag's 26 `PlatformEntry` fields; add `display_tier="high"`, `allowlist_suppresses_pairing=True`, `config_connected_fn`, `dashboard_label`, `dashboard_description` and `docs_url` only when `dataclasses.fields(PlatformEntry)` names them; never `trusted_inbound`, `allow_all_env` or `shared_env_prefixes`; never override `send_exec_approval`; read every value with `get_scoped_secret`, never `os.getenv`; every send while Stoke is unreachable returns `SendResult(success=False, error="send_path_degraded", retryable=True)`.
- **Hermes imports allowed (same name at T, H and U):** `gateway.platforms.base` (`BasePlatformAdapter`, `SendResult`, `ExecApprovalPrompt`, `cache_image_from_bytes`, `cache_document_from_bytes`), `gateway.platforms.event` (`MessageEvent`, `MessageType`), `gateway.platforms._shared` (`get_scoped_secret`, `seed_extra_from_env`, `send_error`, `env_is_connected`), `gateway.platforms.helpers` (`cancel_task`, `MessageDeduplicator`), `gateway.config` (`Platform`, `PlatformConfig`), `gateway.platform_registry` (`PlatformEntry`), `tools.approval.resolve_gateway_approval`, `tools.clarify_gateway` (`resolve_gateway_clarify`, `mark_awaiting_text`), `tools.slash_confirm.resolve`, `hermes_cli.setup` (`prompt`, `prompt_yes_no`, `print_header`), `hermes_cli.config` (`get_env_value`, `save_env_value`, `remove_env_value`), `hermes_cli.cli_output` (`print_info`, `print_success`, `print_warning`, `print_error`).
- **Names:** manifest `stoke-platform`, version `0.1.0`, `kind: platform`, `requires_hermes: ">=0.21.5"`; platform `stoke`, label `Stoke`, emoji `🔥`; folder `integrations/hermes-platform/` with its own MIT `LICENSE`; env `STOKE_CHANNEL_KEY`, `STOKE_PEER_KEY`, `STOKE_ALLOWED_USERS`, `STOKE_HOME_CHANNEL`, `STOKE_HOME_CHANNEL_NAME`, `STOKE_SOCKET_PATH`, all under `optional_env`; Stoke's built-in plugin id `hermes`, name `Hermes`; tab kind `channel`; chat `main`; IPC `channel:*`; suite `verify:hermes-channel`.
- **Pinned Hermes for tests:** `v2026.9.24` (the v0.21.5 release) = `f97608f178d1ffeca59860195ab7da295f7c8e5f` on Python 3.12 (`~/.local/bin/python3.12` here; 3.11 in CI); `v0.22.5` = `bf0203a794a07aac3ff764972ab9087baa4e4f4e` on Python 3.14. Each in its own clone and virtualenv under the system temp folder; never `~/.hermes/hermes-agent` or its venv.
- **Hermetic Hermes runs:** `HOME` and `HERMES_HOME` in scratch, `HERMES_HOME` never `$HOME/.hermes` (at T and H that home claims the owner's launchd label `ai.hermes.gateway` and plist); `HERMES_GATEWAY_LOCK_DIR` and `XDG_STATE_HOME` in scratch; every inherited `HERMES_*`, `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, proxy and other `XDG_*` variable removed; `TZ=UTC`, `NO_COLOR=1`. Never `hermes gateway install|start|stop|restart|uninstall`, `gateway run --replace`, `hermes update`, `hermes pm …`, `plugins validate --install-deps`, `docker compose up`, or Yes to the wizard's restart offer.
- **Scanner hygiene in the plugin folder, tests and README included:** no `-----BEGIN … PRIVATE KEY-----`, no `sk-` followed by 20+ alphanumerics, no `socket.connect((`, no `0.0.0.0`, no `os.environ` outside `.py` code, no `authorized_keys`, `sudo`, `printenv`, `env |`, `cat` of a `.env`, `socat` or `nc -l`; every secret-shaped fixture built from pieces at run time (gotcha 157).
- **CLAUDE.md, as it applies:** relative `.ts` imports and no parameter properties in `src/main`; no `electron` import in `src/main/channels/`; IPC names in `src/shared/ipc.ts` first; colour only through CSS custom properties; no `node:` import in `src/shared` (27) and only relative `.ts` imports from suite-loaded modules (78); `channels/` loaded lazily, async fs only (40); claim before the first await (20, 51); the key read only after `secretsSettled()` and never minted over one that will not open (162); stopped in `before-quit`'s once-only block and in `win.on('closed')` (35, 170); a question is a strip in `.main-col` that stops plain keys, a notice is a `toast()` (14, 145, 154); every `tab.cwd` reader taught the kind (150); opened through `chatOpenPlan` (176); a settings row has a `data-setting` mark and a `SETTING_ROWS` entry with every control label as a keyword (138); suites end with the tally and `process.exitCode` last (50, 62), work in scratch with bystanders (74), and show each guard red by mutation (175); never force-kill Stoke; sandboxes take `--user-data-dir` and `--use-mock-keychain`.
- **Commits:** agents in this shared tree never commit. Each task ends with "Lead commits"; the message says why and names any bug fixed. Another agent's uncommitted Work-mode change touches `index.ts`, `preload`, `ipc.ts`, `api.ts`, `pluginPackages.ts`, `settingsIndex.ts`, `App.tsx`, `tabs.ts`, `PluginsSettings.tsx` and the stylesheets: search for names, never trust a line number.

## Review Focus

The five failure modes most likely to bite a real person that the feature tests would otherwise
miss. Each test lives in the task that owns the code.

1. **Stoke closed while cron delivers** (the 07:00 brief with Stoke quit, or its window closed,
   overnight). A person expects the brief in the Hermes tab when Stoke opens again (a redelivered
   reply carries Hermes's own "Recovered reply" line), and `hermes send` to say "Stoke is not open"
   rather than claim success. On the v0.21.5 release Hermes only logs a cron delivery it could not make; that
   is Hermes's limit and the spec says so. Tests: Task 5 `test_bounces_once_after_a_missed_send`,
   Task 7 `test_closed_stoke_send_is_send_path_degraded` and
   `test_reappearing_after_a_missed_send_bounces`, Task 15's closed-window runs at both tags.
2. **A second pairing** (setup run again for the same Hermes, or for a second profile). A person
   expects the same Hermes to keep one tab and its conversation, its old key to stop working, a
   second profile to get a second tab, and no pairing to start while another waits. Tests: Task 4
   `a replaces proof signed by the pinned old key moves that peer` and `a second pairing while one
   waits is busy`, Task 6 `after a replace the old key's auth is refused`, Task 5
   `test_replaces_proof_is_signed_by_the_old_key`, Task 8
   `test_asks_before_reconfiguring_and_sends_a_replaces_proof`.
3. **An oversize or malformed message** (a 200 KB tool output, a reply full of control characters
   or invalid UTF-8, a frame a newer plugin sends). A person expects long replies split, never cut
   silently; Stoke never crashes or corrupts the conversation; a refused card makes Hermes fall back
   to its plain-text prompt. Tests: Task 2 `test_split_text` and `test_line_cap`, Task 3 `a line over
   512 KiB is a strike and the next line still arrives` and `invalid UTF-8 is a strike`, Task 6
   `replay after a torn last line keeps every whole line` and `an unknown frame type is refused and
   stores nothing`, Task 7 `test_long_text_is_split_and_continuations_returned` and
   `test_refused_card_is_a_definite_failure`.
4. **A stale socket file after a crash** (Stoke killed, a kernel panic, power loss). A person
   expects the next launch to take the socket back with no message, never to delete a socket
   another program serves or a file it did not make, and Hermes to reconnect by itself with no
   restart. Tests: Task 3 `a stale socket of ours is replaced`, `a live listener is refused and keeps
   serving` and the bystander checks, Task 5 `test_closed_stoke_is_unavailable_fast` and
   `test_reconnects_in_place_when_nothing_was_missed`.
5. **A card answered twice, or after its timeout** (a double click, two windows, an answer after
   five minutes, two approvals pending in one session). A person expects exactly one answer to
   reach Hermes, a late one to say it expired and change nothing, and a tap never to approve a
   different command. Tests: Task 6 `two answers in one tick send one answer frame`, `an answer with
   no ack inside ackMs is unknown and stays unanswerable` and `two approvals of one session: only the
   oldest is answerable`, Task 9 `test_a_card_is_answered_once` and `test_resolver_zero_is_expired`,
   Task 15's double click over CDP.

---

## File Structure

| File | Responsibility |
|---|---|
| `integrations/hermes-platform/plugin.yaml` (create) | Hermes manifest: names, `requires_hermes`, `optional_env` |
| `integrations/hermes-platform/__init__.py` (create) | `register(ctx)`, importing the adapter only when called |
| `integrations/hermes-platform/LICENSE`, `README.md` (create) | MIT text; install, pair, what it can do (scanner-clean) |
| `integrations/hermes-platform/wire.py` (create) | The wire v1 in Python: caps, labels, signed texts, validators, line codec |
| `integrations/hermes-platform/keys.py` (create) | Ed25519 through `cryptography` |
| `integrations/hermes-platform/transport.py` (create) | `StokeConnection` (handshake, acks) and `StokeLink` (reconnect, degraded, bounce) |
| `integrations/hermes-platform/pairing.py` (create) | The pairing client |
| `integrations/hermes-platform/media.py` (create) | Media parts out, assembly in |
| `integrations/hermes-platform/cards.py` (create) | Card frames, the module-level `CardBook`, answer dispatch |
| `integrations/hermes-platform/adapter.py` (create) | `StokeAdapter`, `register`, the registry callables |
| `integrations/hermes-platform/standalone.py` (create) | `standalone_sender_fn` for `hermes send` and cron outside the gateway |
| `integrations/hermes-platform/wizard.py` (create) | `setup_fn`: pairing inside `hermes gateway setup` |
| `integrations/hermes-platform/tests/_load.py`, `fake_stoke.py` (create) | Load the plugin by path; an asyncio Unix server playing Stoke |
| `integrations/hermes-platform/tests/vectors/wire-v1.json` (create) | The vectors both languages assert |
| `integrations/hermes-platform/tests/test_*.py` (create) | Pure: wire, keys, transport, pairing, media. Contract: register, adapter, cards, wizard |
| `src/shared/channel.ts` (create) | The wire v1: caps, timers, labels, frame types, parsers, signed texts, path rule, key verdict, Hermes commands |
| `src/shared/channelView.ts` (create) | Conversation types and reducer, card answerability, views, IPC result types, tab binding, dot, notification text |
| `src/main/channels/socket.ts` (create) | The Unix listener: path checks, stale socket, modes, line framing, strikes, rates, handshake deadline |
| `src/main/channels/identity.ts` (create) | Stoke's sealed channel key and peers.json |
| `src/main/channels/pairing.ts` (create) | `PairDesk`: one pending pairing, TTL, attempts, commit and reveal, the Allow claim |
| `src/main/channels/store.ts` (create) | Per-peer append-only log, replay, compaction, eviction, media files |
| `src/main/channels/service.ts` (create) | `ChannelService`: handshake, routing, persist-then-ack, cards once, the view |
| `src/main/index.ts` (modify) | Lazy `channelsFor`, start and stop, IPC handlers, the media scheme host, built-in toggle |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/shared/api.ts` (modify) | `channel:*` names, the `channel` bridge and its types |
| `src/shared/pluginPackages.ts`, `src/main/plugins/packageManager.ts`, `PluginsSettings.tsx`, `SettingsSheet.tsx`, `settingsIndex.ts` (modify) | The `hermes` built-in (seeded installed and off, no Install or Remove control, its "Let Hermes message me here" switch), its panel slot (and the prop threaded to it) and its search row |
| `src/shared/tabWindows.ts`, `src/shared/types.ts`, `src/main/tabStore.ts`, `lib/restore.ts`, `lib/tabs.ts`, `src/shared/topBar.ts` (modify) | The `channel` tab kind and every reader of the kind |
| `TitleBar.tsx`, `StatusBar.tsx`, `TabIndicator.tsx`, `Launcher.tsx` (modify) | How a channel tab is drawn and started |
| `components/SafeMarkdown.tsx` (create), `GrokBotMessages.tsx` (modify) | Grok Bot's safe Markdown, shared |
| `components/ChannelWorkspace.tsx`, `ChannelCards.tsx`, `ChannelPairStrip.tsx`, `HermesPanel.tsx` (create) | The tab body, the cards, the strip, the Settings panel |
| `lib/useChannel.ts` (create), `App.tsx` (modify) | App's subscription; opening, closing, dots, notifications, mounts |
| `styles/channel.css` (create) | Channel styles, custom properties only |
| `scripts/verify-hermes-channel.mts` (create), `scripts/verify-restore.mts` (modify) | The suite; `tabOf` for the new kind |
| `scripts/hermes-plugin-test.mjs` (create) | Runs the plugin's pure tests, or the contract set in a pinned Hermes clone |
| `scripts/hermes-e2e.mjs` (create) | The end-to-end proof; not in `check` |
| `package.json`, `.github/workflows/ci.yml` (modify) | The suite in `check`; the plugin's CI jobs |
| `CLAUDE.md`, `ARCHITECTURE.md`, `docs/plugins.md` (modify) | Layout lines, suite list, file map, the user's Hermes section |

---

### Task 1: The wire contract v1 in TypeScript, and the shared vectors

**Files:**
- Create: `src/shared/channel.ts`, `integrations/hermes-platform/tests/vectors/wire-v1.json`, `scripts/verify-hermes-channel.mts`
- Modify: `package.json` (`"verify:hermes-channel": "node scripts/verify-hermes-channel.mts"`, and `npm run verify:hermes-channel` in `check` right after `npm run verify:mic-tunnel`); `CLAUDE.md` (suite list: `hermes-channel` after `mic-tunnel`); `ARCHITECTURE.md` (File map: a "Hermes channel" paragraph naming the spec, this file and the vectors)

**Interfaces:**
- Consumes: `labelled`, `canonicalJson`, `isRecord`, `b64uDecode` from `./hub/codec.ts`; `sasDigits` from `./hub/pairing.ts`.
- Produces (wire schema **v1**, field `v`):

```ts
export const CHANNEL_VERSION = 1
export const CHANNEL_MAIN_CHAT = 'main'
export const CHANNEL_LIMITS = { lineBytes: 524_288, textBytes: 65_536, composerChars: 32_768, commandBytes: 16_384,
  reasonBytes: 1_024, labelChars: 48, mediaPartBytes: 196_608, mediaBytes: 10_485_760, choices: 12, actions: 4,
  options: 50, providers: 64, models: 500, peers: 16, socketPathBytes: 100, strikes: 3, sendPerPeer: 4 } as const
export const CHANNEL_TIMERS = { handshakeMs: 5_000, ackMs: 10_000, typingTtlMs: 8_000, pairTtlMs: 300_000,
  attemptsWindowMs: 3_600_000, notifyGapMs: 10_000 } as const
export const CHANNEL_RATES = { content: { burst: 60, perSecond: 20 }, typing: { burst: 10, perSecond: 2 } } as const
export const CHANNEL_PAIR_ATTEMPTS = 3
export const CHANNEL_LABELS = { auth: 'stoke-channel/v1/auth', ok: 'stoke-channel/v1/ok', pairCommit: 'stoke-channel/v1/pair-commit',
  pairSas: 'stoke-channel/v1/pair-sas', pairOk: 'stoke-channel/v1/pair-ok', replace: 'stoke-channel/v1/replace' } as const
export type NackCode = 'invalid' | 'version' | 'unknown-type' | 'unknown-chat' | 'unknown-target' | 'too-large' | 'rate'
interface Base { v: 1; id: string; chat: string; at: number }      // id: /^[A-Za-z0-9_-]{8,64}$/, chat: /^[a-z0-9][a-z0-9-]{0,31}$/
export type HermesFrame = Base & (
  | { t: 'message'; text: string; kind: 'reply' | 'status'; replyTo?: string }
  | { t: 'edit'; target: string; text: string; final?: boolean } | { t: 'delete'; target: string }
  | { t: 'typing'; on: boolean } | MediaFields
  | { t: 'approval'; text: string; command: string; reason: string; session: string;
      actions: { label: string; choice: 'once' | 'session' | 'always' | 'deny'; style: '' | 'primary' | 'danger' }[] }
  | { t: 'clarify'; text: string; choices: string[]; other: boolean }
  | { t: 'confirm'; title: string; text: string; actions: { label: string; choice: 'once' | 'always' | 'cancel' }[] }
  | { t: 'choices'; title: string; options: { value: string; label: string; current: boolean }[] }
  | { t: 'models'; current: { model: string | null; provider: string | null };
      providers: { slug: string; name: string; current: boolean; models: string[] }[] }
  | { t: 'retire'; target: string; text?: string } | { t: 'status'; model?: string | null; provider?: string | null })
export type MediaFields = { t: 'media'; part: number; parts: number; mime: string; name: string; bytes: number; data: string; caption?: string }
export type StokeFrame = Base & ({ t: 'text'; text: string; replyTo?: string } | MediaFields | { t: 'answer'; card: string; choice: string; provider?: string })
export interface AckFrame { v: 1; t: 'ack'; id: string; part?: number; ok: boolean; code?: NackCode; result?: 'done' | 'expired' }
export interface HelloFrame { t: 'hello'; v: 1; stoke: string; nonce: string; app: string }
export interface AuthFrame { t: 'auth'; v: 1; hermes: string; nonce: string; role: 'live' | 'send'; sig: string; agent: string; plugin: string }
export interface OkFrame { t: 'ok'; v: 1; peer: string; sig: string }
export type PairRefusal = 'busy' | 'limit' | 'denied' | 'expired' | 'mismatch'   // no 'off': with the plugin off nothing listens
export interface PairCommitFrame { t: 'pair-commit'; v: 1; commit: string; label: string }
export interface PairNonceFrame { t: 'pair-nonce'; pair: string; nonce: string }
export interface PairRevealFrame { t: 'pair-reveal'; hermes: string; nonce: string; replaces?: { hermes: string; sig: string } }
export interface PairOkFrame { t: 'pair-ok'; peer: string; chat: 'main'; sig: string }
export interface PairRefusedFrame { t: 'pair-refused'; reason: PairRefusal }
export type ParsedFrame = { ok: true; frame: HermesFrame | AckFrame } | { ok: false; code: NackCode; ref: string | null }
export function parseHermesFrame(raw: unknown): ParsedFrame
export function parseHandshake(raw: unknown): AuthFrame | PairCommitFrame | PairRevealFrame | null
export function authText(f: { stoke: string; hermes: string; nonceS: string; nonceH: string; role: 'live' | 'send' }): string
export function okText(f: { stoke: string; hermes: string; nonceS: string; nonceH: string; peer: string }): string
export function pairCommitText(f: { hermes: string; nonce: string }): string
export function pairSasText(f: { pair: string; stoke: string; hermes: string; nonceS: string; nonceH: string }): string
export function pairOkText(f: { pair: string; stoke: string; hermes: string; peer: string; chat: string }): string
export function replaceText(f: { stoke: string; old: string; new: string }): string
export function isPeerId(v: unknown): v is string                     // /^[0-9a-f]{16}$/ (pair ids too)
export function utf8Bytes(text: string): number
export function channelSocketPathFor(f: { canonical: boolean; home: string; userData: string }): string
export function socketPathProblem(path: string): string | null
```

Keys are raw 32-byte Ed25519 public keys and nonces 32 random bytes, b64url without padding; `data`
is b64url too. Signed texts are `labelled(label, fields)` over ASCII strings only.

- [ ] **Step 1: Write the vectors' inputs and the failing suite**

`wire-v1.json` holds `version: 1`, `limits` (equal to `CHANNEL_LIMITS`), `labels`, the inputs, the
frame table and an empty `expect`. Keys and nonces are DERIVED, so no key-shaped literal sits in the
repo (gotcha 157): a seed is `sha256("stoke-channel/v1 test seed <name>")` for `stoke`, `hermes`,
`hermes-old`; a nonce is `b64url(sha256("stoke-channel/v1 test nonce <name>"))` for `stoke`,
`hermes`; `pair` is `"00112233445566ff"`, `peer` `"0123456789abcdef"`. The frame table is
`{ name, from: 'hermes' | 'stoke', frame, problem }`, at least these (every frame has `v: 1`,
`chat: "main"`, `at: 1761600000000` and an 11-character id unless the case says otherwise):

| name | from | frame | problem |
|---|---|---|---|
| `message` | hermes | `{t:'message', text:'Morning brief', kind:'reply'}` | `null` |
| `status line` | hermes | `{t:'message', text:'⚙️ terminal: ls', kind:'status'}` | `null` |
| `edit`, `delete`, `typing`, `retire`, `status` | hermes | one valid each | `null` |
| `approval` | hermes | 2 actions: `once`/`primary`, `deny`/`danger`, `session:"0123456789abcdef"` | `null` |
| `clarify`, `confirm`, `choices`, `models`, `media part` | hermes | one valid each (media `data` of 3 bytes) | `null` |
| `ack` | hermes | `{v:1, t:'ack', id:'s-000000001', ok:true}`, no `chat` or `at` | `null` |
| `text`, `answer`, `answer models` | stoke | one valid each (`provider` on the last) | `null` |
| `version 2` | hermes | `message` with `v: 2` | `version` |
| `unknown type` | hermes | `{t:'open-tab'}` | `unknown-type` |
| `short id` | hermes | `message` with `id:'short'` | `invalid` |
| `bad chat` | hermes | `message` with `chat:'Main!'` | `invalid` |
| `approval choice` | hermes | an action with `choice:'maybe'` | `invalid` |
| `five actions` | hermes | 5 approval actions | `invalid` |
| `thirteen choices` | hermes | `clarify` with 13 choices | `invalid` |
| `part past parts` | hermes | media `part: 2, parts: 2` | `invalid` |
| `text not a string` | hermes | `message` with `text: 5` | `invalid` |
| `not an object` | hermes | `[1, 2]` | `invalid` |

In `scripts/verify-hermes-channel.mts` (header comment saying what it holds; `import './suite-tmpdir.mts'`
first; the `check(name, got, want)` / `ok(name, cond, detail)` helpers and tally of verify-mic-tunnel):

```ts
const V = JSON.parse(readFileSync(new URL('../integrations/hermes-platform/tests/vectors/wire-v1.json', import.meta.url), 'utf8'))
section('wire v1')
check('the limits are the spec\'s numbers', CHANNEL_LIMITS, V.limits)
check('a line is 512 KiB with its newline', CHANNEL_LIMITS.lineBytes, 524288)
check('labels', CHANNEL_LABELS, V.labels)
const k = vectorKeys(V)   // deviceKeysFromSeeds(seed, sha256(seed)) per name; nonces as above
for (const name of ['authText', 'okText', 'pairCommit', 'sasText', 'pairOkText', 'replaceText'])
  ok(`${name} is pinned`, !!V.expect[name] && texts(k)[name] === V.expect[name], 'run with --print-vectors once')
ok('a signed text is the label, a newline, then sorted JSON', authText(k.auth).startsWith('stoke-channel/v1/auth\n{"hermes":"'))
ok('the ok signature verifies with node:crypto', verifyText(k.stoke.signPub, okText(k.ok), V.expect.okSig))
check('the six digits', sasDigits(sha256(pairSasText(k.sas))), V.expect.sas)
for (const c of V.frames.filter((f) => f.from === 'hermes')) {
  const r = parseHermesFrame(c.frame)
  check(`frame: ${c.name}`, r.ok ? null : r.code, c.problem)
}
ok('a key the validator does not name is dropped', !('extra' in (parseHermesFrame({ ...V.frames[0].frame, extra: 1 }) as { frame: object }).frame))
check('a message of 65 537 bytes is too-large', (parseHermesFrame({ ...V.frames[0].frame, text: 'x'.repeat(65537) }) as { code: string }).code, 'too-large')
check('a media part over 196 608 bytes is too-large', (parseHermesFrame(mediaOf(196609)) as { code: string }).code, 'too-large')
check('the installed app\'s path', channelSocketPathFor({ canonical: true, home: '/Users/a', userData: '/x' }), '/Users/a/.stoke/channel/stoke.sock')
check('a dev build\'s path', channelSocketPathFor({ canonical: false, home: '/Users/a', userData: '/x' }), '/x/channel/stoke.sock')
ok('101 bytes is refused with its length', socketPathProblem('/' + 'a'.repeat(100))?.includes('101 bytes') === true)
check('100 bytes is fine', socketPathProblem('/' + 'a'.repeat(99)), null)
```

- [ ] **Step 2: Run it to see it fail**

Run: `node scripts/verify-hermes-channel.mts`
Expected: FAIL, `ERR_MODULE_NOT_FOUND` for `src/shared/channel.ts`.

- [ ] **Step 3: Implement `src/shared/channel.ts`**

Exports as in Interfaces. Each parser rebuilds the frame from the keys it names and checks in this
order, which the Python side copies exactly: not an object → `invalid`; `v !== 1` → `version`;
an unknown `t` → `unknown-type`; then field by field, a wrong type or shape is `invalid` and a right
type over its cap is `too-large`; `ref` is the frame's `id` when that was a valid id. `data` is
checked by decoded length. `socketPathProblem` measures with `utf8Bytes` and words the refusal
`Stoke's channel socket path is <n> bytes; the limit is 100.`

- [ ] **Step 4: Pin the expected values**

Add a `--print-vectors` flag that prints the computed `expect` object (texts, `stokePub`,
`hermesPub`, `hermesOldPub`, `authSig`, `okSig`, `pairOkSig`, `replaceSig`, `pairCommit`, `sas`, and
`ownerId` = `'stoke-'` + the first 16 hex of SHA-256 over the raw Stoke public key). Run
`node scripts/verify-hermes-channel.mts --print-vectors`, check each text by eye (the label line,
keys sorted, no whitespace) and paste the object into `expect`.

- [ ] **Step 5: Run it to see it pass**

Run: `node scripts/verify-hermes-channel.mts`
Expected: `all pass`, exit 0. Then `npm run typecheck`: exit 0 (both projects compile the file).

- [ ] **Step 6: Lead commits** `src/shared/channel.ts`, the vectors, the suite, `package.json`, `CLAUDE.md`, `ARCHITECTURE.md`: "Hermes channel: the wire v1 and the vectors both languages assert".

---

### Task 2: The plugin's skeleton, wire and keys in Python

**Files:**
- Create: `integrations/hermes-platform/{plugin.yaml, __init__.py, LICENSE, README.md, wire.py, keys.py}`, `tests/_load.py`, `tests/test_wire.py`, `tests/test_keys.py`, `scripts/hermes-plugin-test.mjs`
- Modify: `.github/workflows/ci.yml` (job `hermes-plugin`); `CLAUDE.md` (Layout: an `integrations/` line: "integrations other programs install; `hermes-platform/` is Stoke's Hermes messaging-platform plugin (Python). Hermes installs it with `hermes plugins install`; Stoke never does. Its `tests/vectors` are shared with verify:hermes-channel"); `ARCHITECTURE.md`

**Interfaces:**
- Consumes: the vectors file (Task 1).
- Produces:

```python
# wire.py (pure)
VERSION = 1; MAIN_CHAT = "main"; HERMES_MAX_MESSAGE_LENGTH = 16000
LIMITS: dict[str, int]; TIMERS: dict[str, int]; LABELS: dict[str, str]     # == the TypeScript constants
HANDSHAKE_TIMEOUT_S = 5.0; ACK_TIMEOUT_S = 10.0
class FrameTooLarge(ValueError): ...
def canonical_json(value: object) -> str          # json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)
def labelled(label: str, fields: dict) -> str
def auth_text(*, stoke: str, hermes: str, nonce_s: str, nonce_h: str, role: str) -> str
def ok_text(*, stoke: str, hermes: str, nonce_s: str, nonce_h: str, peer: str) -> str
def pair_commit_text(*, hermes: str, nonce: str) -> str
def pair_sas_text(*, pair: str, stoke: str, hermes: str, nonce_s: str, nonce_h: str) -> str
def pair_ok_text(*, pair: str, stoke: str, hermes: str, peer: str, chat: str) -> str
def replace_text(*, stoke: str, old: str, new: str) -> str
def sas_digits(digest: bytes) -> str
def owner_id(stoke_pub: str) -> str               # "stoke-" + sha256(raw key).hexdigest()[:16]
def new_id() -> str                                # secrets.token_urlsafe(12)
def frame_problem(frame: object, sender: str) -> str | None   # sender "hermes" | "stoke"; TypeScript's order and codes
def encode_frame(frame: dict) -> bytes             # one line with "\n"; FrameTooLarge past LIMITS["lineBytes"]
def decode_line(line: bytes) -> dict | None        # None: not UTF-8, not JSON, not an object
def split_text(text: str, max_bytes: int) -> list[str]        # at line breaks, then whole code points
# keys.py (cryptography)
def b64u(data: bytes) -> str; def unb64u(text: str) -> bytes
def keypair_from_seed(seed: bytes) -> tuple[str, str]          # (private seed, public key), b64url
def generate_keypair() -> tuple[str, str]
def sign_text(priv: str, text: str) -> str
def verify_text(pub: str, text: str, sig: str) -> bool        # never raises
# tests/_load.py
def load_plugin(): ...         # the folder as a package by path (its name has a hyphen); __init__ must not import Hermes
def requires_hermes(test) -> None   # skip when `gateway` is not importable; raise instead when STOKE_HERMES_CONTRACT=1
VECTORS: dict
```

Inside every signed text the JSON field names are the TypeScript parameter names (`nonceS`,
`nonceH`, `stoke`, `hermes`, `role`, `peer`, `pair`, `chat`, `old`, `new`, `nonce`); only the Python
keyword names are snake_case. `plugin.yaml` is the spec §3.2 manifest; `__init__.py` defines
`register(ctx)` that imports `.adapter` inside the call (Task 7 fills the adapter). `LICENSE` is
the repo's MIT text.

- [ ] **Step 1: Write the failing tests and the runner**

```python
class WireVectors(unittest.TestCase):
    def test_limits_match_typescript(self):
        self.assertEqual(wire.LIMITS, V["limits"]); self.assertEqual(wire.LIMITS["lineBytes"], 524288)
    def test_signed_texts_are_byte_equal(self):
        self.assertEqual(wire.auth_text(**k.auth), V["expect"]["authText"])   # and ok, pair_commit, pair_sas, pair_ok, replace
    def test_sas(self):
        self.assertEqual(wire.sas_digits(hashlib.sha256(wire.pair_sas_text(**k.sas).encode()).digest()), V["expect"]["sas"])
    def test_owner_id(self):
        self.assertEqual(wire.owner_id(V["expect"]["stokePub"]), V["expect"]["ownerId"])
    def test_frame_table(self):
        for c in V["frames"]:
            with self.subTest(c["name"]):
                self.assertEqual(wire.frame_problem(c["frame"], c["from"]), c["problem"])
    def test_line_cap(self):
        with self.assertRaises(wire.FrameTooLarge): wire.encode_frame({"t": "message", "text": "x" * 524288})
    def test_decode_refuses(self):
        self.assertIsNone(wire.decode_line(b"\xff\n")); self.assertIsNone(wire.decode_line(b"[1, 2]\n"))
    def test_split_text(self):
        text = "a\n" * 40000 + "界" * 30000
        pieces = wire.split_text(text, 65536)
        self.assertEqual("".join(pieces), text)
        self.assertTrue(all(0 < len(p.encode()) <= 65536 for p in pieces))
class Keys(unittest.TestCase):
    def test_seed_gives_the_typescript_key(self):
        self.assertEqual(keys.keypair_from_seed(seed("stoke"))[1], V["expect"]["stokePub"])
    def test_signatures_equal_node(self):           # Ed25519 is deterministic
        self.assertEqual(keys.sign_text(keys.keypair_from_seed(seed("stoke"))[0], V["expect"]["okText"]), V["expect"]["okSig"])
    def test_verify_never_raises(self):
        self.assertFalse(keys.verify_text("not-a-key", "x", "y"))
```

`scripts/hermes-plugin-test.mjs [--python <bin>]` (default `python3`) refuses a Python under 3.11
or one without `cryptography`, naming the fix, then runs
`<python> -m unittest discover -s integrations/hermes-platform/tests -p 'test_*.py' -v` and exits
with its code. A local venv: `uv venv /tmp/vhpy && uv pip install --python /tmp/vhpy/bin/python cryptography==50.0.1`.

CI job `hermes-plugin` (gating, beside `verify`): `ubuntu-latest`, matrix `python: ['3.11', '3.14']`,
checkout, `actions/setup-python` at that version, the `verify` job's Node setup,
`pip install cryptography==50.0.1`, `node scripts/hermes-plugin-test.mjs --python python`.

- [ ] **Step 2: Run them to see them fail**

Run: `node scripts/hermes-plugin-test.mjs --python /tmp/vhpy/bin/python`
Expected: FAIL, the loader cannot find `wire.py`.

- [ ] **Step 3: Implement `wire.py` and `keys.py`**

`frame_problem` follows Task 1's order exactly. `keypair_from_seed` is
`Ed25519PrivateKey.from_private_bytes(seed)`; `verify_text` catches every exception and says False.

- [ ] **Step 4: Run them to see them pass**

Run: `node scripts/hermes-plugin-test.mjs --python /tmp/vhpy/bin/python` and again with
`--python ~/.local/bin/python3.12` (in a 3.12 venv with `cryptography`).
Expected: `OK` both times; the contract tests (none yet) absent.

- [ ] **Step 5: Lead commits** the folder, the runner, `ci.yml`, `CLAUDE.md`, `ARCHITECTURE.md`: "Hermes plugin: its wire and keys, held to the same vectors as Stoke's".

---

### Task 3: Stoke's listener

**Files:**
- Create: `src/main/channels/socket.ts`
- Modify: `scripts/verify-hermes-channel.mts` (section `socket`); `CLAUDE.md` (Layout, under `src/main/`: a `channels/` line: "the Hermes channel: socket.ts (the Unix listener), identity.ts, pairing.ts, store.ts, service.ts; no electron import, so verify:hermes-channel runs it"); `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `CHANNEL_LIMITS`, `CHANNEL_RATES`, `socketPathProblem` (Task 1).
- Produces:

```ts
export type ListenResult = { ok: true } | { ok: false; problem: string }
export interface ChannelConn {
  readonly id: number
  peerId: string | null
  role: 'live' | 'send' | 'pair' | null     // null until the service accepts an auth or a pair-commit
  write(frame: object): boolean             // false: over lineBytes, or closed; destroys past 2 × lineBytes buffered
  take(kind: 'content' | 'typing'): boolean // the rate bucket
  destroy(): void
}
export interface ChannelSocketDeps {
  path: string; uid: number; now: () => number; log: (line: string) => void
  handshakeMs: number; rates: typeof CHANNEL_RATES
  onOpen(conn: ChannelConn): void
  onLine(conn: ChannelConn, value: unknown): void      // one JSON.parse'd line
  onClose(conn: ChannelConn): void
}
export async function prepareChannelPath(path: string, uid: number): Promise<ListenResult>
export class ChannelSocket {
  constructor(deps: ChannelSocketDeps)
  listen(): Promise<ListenResult>       // prepareChannelPath, listen, chmod 0o600
  close(): Promise<void>                // server.close() (it unlinks the path), then destroy every connection
  dropAll(): void                       // synchronous
  connections(): readonly ChannelConn[]
}
```

- [ ] **Step 1: Write the failing tests**

Real sockets in `mkdtempSync('/tmp/vhch-')` (removed at exit): `SCRATCH_TMPDIR` is too long for a
socket path. First statement of the section: `requireScratch`-style refusal if the path is under
`~/.stoke`.

```ts
section('socket')
ok('a path over 100 bytes is refused with its length', ((await prepareChannelPath('/tmp/' + 'a'.repeat(96), uid)) as { problem?: string }).problem?.includes('101 bytes') === true)
check('the folder is made 0700', statSync(dirname(path)).mode & 0o777, 0o700)
check('a wider folder of ours is narrowed to 0700', ..., 0o700)
ok('a folder that is a symlink is refused, its target untouched', ...)
ok('a socket owned by another uid is refused', (await prepareChannelPath(path, uid + 1)).ok === false)   // fake every input (74)
check('the socket is 0600 after listen', lstatSync(path).mode & 0o777, 0o600)
ok('a stale socket of ours is replaced', ...)              // a child listener the suite starts and SIGKILLs, then listen()
ok('a live listener is refused and keeps serving', ...)    // the bystander still answers a connect afterwards
ok('a regular file at the path is refused and survives byte for byte', ...)
ok('close() removes the socket file', !existsSync(path))
ok('a line over 512 KiB is a strike and the next line still arrives', ...)
ok('invalid UTF-8 is a strike', ...)
ok('three strikes close the connection', ...)
ok('a connection that never authenticates is destroyed at handshakeMs', ...)   // handshakeMs: 150
check('the content bucket refuses the 61st frame in one tick', takes(61).filter(Boolean).length, 60)
ok('dropAll destroys every connection before it returns', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `node scripts/verify-hermes-channel.mts`
Expected: FAIL, `ERR_MODULE_NOT_FOUND` for `src/main/channels/socket.ts`.

- [ ] **Step 3: Implement `socket.ts`**

`prepareChannelPath` walks the rules in the Global Constraints with async `fs/promises`; for a
socket of ours it connects with a 500 ms deadline and unlinks only on `ECONNREFUSED`. A line is
decoded with `new TextDecoder('utf-8', { fatal: true })`; an over-long buffer without a newline is
discarded through the next newline. A connection still `role === null` at `handshakeMs` is
destroyed. Token buckets refill from `deps.now()`.

- [ ] **Step 4: Run them to see them pass, then show each guard red**

Run: `node scripts/verify-hermes-channel.mts`
Expected: `all pass`. Then mutate each guard out once in a scratch copy (the length cap, the
folder-mode check, the owner check, the live-socket check, the strike count, the deadline) and
record that each turns the suite red (gotcha 175).

- [ ] **Step 5: Lead commits** `socket.ts`, the suite, `CLAUDE.md`, `ARCHITECTURE.md`: "Hermes channel: Stoke's Unix listener, which never unlinks a socket it does not own".

---

### Task 4: Stoke's key, its paired Hermes, and the pairing desk

**Files:**
- Create: `src/main/channels/identity.ts`, `src/main/channels/pairing.ts`
- Modify: `src/shared/channel.ts` (`channelKeyVerdict`, `ChannelPairAsk`); the suite (sections `key`, `pairing`); `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `SecretBackend` and `writePrivateFile` (`src/main/secrets.ts`), `sealedText`/`unsealedValue`/`judgeProtection` (`src/shared/secrets.ts`), `DeviceKeys`, `generateDeviceKeys`, `sha256B64u`, `verifyText`, `randomB64u` (`src/main/hub/crypto.ts`), `PluginFile` (`src/main/plugins/files.ts`), Task 1's texts.
- Produces:

```ts
// src/shared/channel.ts
export function channelKeyVerdict(f: { settled: boolean; file: 'absent' | 'present'; opened: boolean }): 'wait' | 'keep' | 'mint' | 'stranded'
export interface ChannelPairAsk { pairId: string; code: string; label: string; replaces: { peerId: string; label: string; pairedAt: number } | null; expiresAt: number }
// identity.ts — <dir>/channel-key.json (HubFiles' shape: version, public halves clear, private halves sealed under slots
// 'channel.sign' / 'channel.box', `sealed: boolean`) and <dir>/peers.json ({ version: 1, peers }, PluginFile, 16 at most)
export interface ChannelPeerRecord { id: string; hermes: string; label: string; pairedAt: number; lastSeenAt: number | null; agent: string | null; plugin: string | null }
export class ChannelIdentity {
  constructor(dir: string, backend: SecretBackend, platform: string)
  loadKeys(settled: boolean): Promise<{ ok: true; keys: DeviceKeys } | { ok: false; verdict: 'wait' | 'stranded'; problem: string }>
  peers(): Promise<ChannelPeerRecord[]>
  peerByKey(hermes: string): Promise<ChannelPeerRecord | null>
  savePeer(rec: ChannelPeerRecord): Promise<void>       // adds, or replaces the record with that id
  removePeer(id: string): Promise<void>
}
// pairing.ts
export interface PairDeskDeps { now: () => number; ttlMs: number; windowMs: number; attempts: number;
  nonce: () => string; newPairId: () => string; emit: (ask: ChannelPairAsk | null) => void }   // crypto is crypto.ts's own; nonce and pair id injectable for the vectors
export class PairDesk {
  constructor(deps: PairDeskDeps)
  open(connId: number, f: PairCommitFrame): { ok: true; reply: PairNonceFrame } | { ok: false; reply: PairRefusedFrame }
  reveal(connId: number, f: PairRevealFrame, ctx: { stoke: string; pinned: (hermes: string) => ChannelPeerRecord | null }): { ok: true; ask: ChannelPairAsk } | { ok: false; reply: PairRefusedFrame }   // `pinned`: the service's in-memory peers
  answer(pairId: string, allow: boolean):
    | { kind: 'allow'; connId: number; hermes: string; label: string; replaces: string | null; pair: string }
    | { kind: 'deny'; connId: number } | { kind: 'gone' } | { kind: 'answered' }      // synchronous claim
  closed(connId: number): void          // the wizard went away: the ask is cleared
  tick(): void                          // expiry
}
```

- [ ] **Step 1: Write the failing tests**

`fakeBackend(tag)` copied from verify-hub-client, a `throwingBackend` whose `decrypt` throws, a
fake clock, and Task 1's vector keys and nonces fed through `deps`:

```ts
section('key')
ok('no key file mints one', ...)
check('a key file that opens is kept', (await reload()).keys.signPub, first.keys.signPub)
ok('a key file that will not open is stranded and byte-identical afterwards', r.ok === false && r.verdict === 'stranded' && same(bytesBefore, bytesAfter))
ok('before the secret store settles nothing is read or written', ...)
ok('peers.json holds public keys only', !readFileSync(peersFile, 'utf8').includes(keys.signPriv))
section('pairing')
check('the code is the vector', ask.code, V.expect.sas)
check('a reveal that does not match its commitment is refused', r.reply.reason, 'mismatch')
check('a second pairing while one waits is busy', (desk.open(2, commit) as { reply: PairRefusedFrame }).reply.reason, 'busy')
check('after three failures inside the hour the next pairing is limit', (desk.open(5, commit) as { reply: PairRefusedFrame }).reply.reason, 'limit')
ok('an hour later pairing is open again', ...)
check('Allow is taken once', [desk.answer(id, true).kind, desk.answer(id, true).kind], ['allow', 'answered'])
check('five minutes with no answer clears the strip', emitted.at(-1), null)
check('the wizard going away clears the strip', emittedAfterClose.at(-1), null)
ok('a replaces proof signed by the pinned old key moves that peer', ask.replaces?.peerId === oldPeer.id)
check('a replaces proof signed by any other key is refused', badReplace.reply.reason, 'mismatch')
```

- [ ] **Step 2: Run them to see them fail**

Run: `node scripts/verify-hermes-channel.mts`
Expected: FAIL, `ERR_MODULE_NOT_FOUND` for `identity.ts`.

- [ ] **Step 3: Implement `channelKeyVerdict`, `identity.ts` and `pairing.ts`**

`loadKeys` mints (with `generateDeviceKeys`) only on `ENOENT`; a parse failure or a seal that will
not open is `stranded` with the sentence "Stoke's channel key is stored but this run could not open
it. Hermes cannot connect until it opens." Failed pairings (Deny, expiry, a mismatch) are kept as
timestamps and counted over `windowMs`.

- [ ] **Step 4: Run them to see them pass, then show each guard red**

Run: `node scripts/verify-hermes-channel.mts`
Expected: `all pass`. Mutate out the no-mint-over-stranded rule, the busy rule, the attempt count,
the one-answer claim and the replace signature check, one at a time; each turns the suite red.

- [ ] **Step 5: Lead commits** both files, `channel.ts`, the suite, `ARCHITECTURE.md`: "Hermes channel: Stoke's own key, never minted over one that will not open, and pairing by matching codes".

---

### Task 5: The plugin's transport, pairing client and reconnect lifecycle

**Files:**
- Create: `integrations/hermes-platform/transport.py`, `pairing.py`, `tests/fake_stoke.py`, `tests/test_transport.py`, `tests/test_pairing.py`

**Interfaces:**
- Consumes: `wire`, `keys` (Task 2); the handshake and pairing frames of spec §4.2 and §4.4.
- Produces:

```python
# transport.py
class StokeUnavailable(Exception): ...   # str: "Stoke is not open"
class StokeRefused(Exception): ...       # Stoke does not know this Hermes
class StokeImpostor(Exception): ...      # not the Stoke this Hermes paired with
class StokeNack(Exception):
    code: str
DEFAULT_SOCKET = "~/.stoke/channel/stoke.sock"
BACKOFF = (1.0, 2.0, 4.0, 8.0, 16.0, 30.0); JITTER = 0.2
def socket_path(configured: str | None) -> str            # expanduser; ValueError past 100 bytes
class StokeConnection:
    peer: str; stoke_app: str
    @classmethod
    async def open(cls, path: str, *, hermes_priv: str, hermes_pub: str, stoke_pub: str, role: str,
                   agent: str, plugin: str, timeout: float = 5.0) -> "StokeConnection"
    async def send(self, frame: dict, *, timeout: float = 10.0) -> dict      # the ack; StokeNack, StokeUnavailable
    async def send_nowait(self, frame: dict) -> None                         # typing
    async def ack(self, frame_id: str, *, ok: bool = True, result: str | None = None, part: int | None = None) -> None
    def frames(self) -> AsyncIterator[dict]          # validated Stoke frames; ends when the connection does
    async def close(self) -> None
class StokeLink:
    missed: bool
    def __init__(self, opener: Callable[[], Awaitable[StokeConnection]], *, on_up: Callable[[StokeConnection], None],
                 on_down: Callable[[], None], on_bounce: Callable[[], Awaitable[None]], on_fatal: Callable[[Exception], Awaitable[None]],
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, rand: Callable[[], float] = random.random) -> None
    async def start(self) -> bool        # True connected or degraded; False only after on_fatal
    def note_missed(self) -> None        # a send was refused while down
    async def stop(self) -> None
# pairing.py
class PairResult(NamedTuple):
    peer: str; stoke_pub: str; chat: str; app: str
class PairDenied(Exception):
    reason: str                          # a PairRefusal
async def pair(path: str, *, hermes_priv: str, hermes_pub: str, label: str, replaces: tuple[str, str] | None,
               on_code: Callable[[str, str], None], timeout: float = 330.0) -> PairResult   # on_code(code, stoke_app)
```

`StokeLink` is pure so the adapter's lifecycle is testable without Hermes. Its loop: an
unavailable Stoke calls `on_down` and retries after
`BACKOFF[min(i, len(BACKOFF) - 1)] * (1 + JITTER * (2 * rand() - 1))` for the i-th failure in a
row; on success with `missed` set it closes that connection and awaits `on_bounce` once; without
it, `on_up`. `StokeRefused` and `StokeImpostor` go to `on_fatal` and the loop ends.

- [ ] **Step 1: Write the failing tests**

`tests/fake_stoke.py` is an asyncio Unix server under `tempfile.mkdtemp(dir="/tmp", prefix="vhpy-")`
speaking Stoke's side with `wire` and `keys`, with knobs: `stoke_key`, `known` peers, `sign_ok_with`,
`withhold_ack`, `nack`, `refuse_pair`, and records (`saw_auth`, `bytes_after_hello`, `lines`,
`last_commit`, `last_reveal`).

```python
def test_handshake_both_ways(self): conn = run(open_conn()); self.assertEqual(conn.peer, fake.peer_id); self.assertTrue(fake.saw_auth)
def test_impostor_hears_nothing(self):          # a listener holding another key
    with self.assertRaises(StokeImpostor): run(open_conn(fake=FakeStoke(stoke_key=OTHER)))
    self.assertEqual(fake.bytes_after_hello, b"")
def test_bad_ok_signature_is_an_impostor(self): ...
def test_unknown_peer_is_refused(self): ...                       # StokeRefused
def test_closed_stoke_is_unavailable_fast(self):                  # no file (ENOENT) and a refusing socket file (ECONNREFUSED)
    t = time.monotonic(); self.assertRaises(StokeUnavailable, ...); self.assertLess(time.monotonic() - t, 1.0)
def test_send_waits_for_the_ack(self): ...
def test_nack_raises_with_its_code(self): self.assertEqual(err.code, "unknown-target")
def test_no_ack_is_unavailable(self): ...                          # withhold_ack, timeout=0.2
def test_never_writes_an_oversize_line(self): ...                  # FrameTooLarge, fake.lines unchanged
def test_socket_path_cap(self): self.assertRaises(ValueError, socket_path, "/tmp/" + "a" * 96)
def test_starts_degraded_when_stoke_is_closed(self): self.assertTrue(run(link.start())); self.assertEqual(events, ["down"])
def test_reconnects_in_place_when_nothing_was_missed(self): ...    # events == ["down", "up"]
def test_bounces_once_after_a_missed_send(self): ...               # note_missed(); events == ["down", "bounce"]; the probe connection closed first
def test_backoff_and_jitter(self):                                 # rand fixed at 1.0, the top of the jitter
    for got, want in zip(sleeps[:7], [1.2, 2.4, 4.8, 9.6, 19.2, 36.0, 36.0], strict=True): self.assertAlmostEqual(got, want)
def test_refused_or_impostor_is_fatal_and_not_retried(self): ...
def test_code_matches_stoke(self): self.assertEqual(codes, [fake.code])
def test_allow_pins_the_hello_key(self): self.assertEqual(result.stoke_pub, fake.stoke_pub)
def test_pair_ok_signed_by_another_key_is_refused(self): ...       # StokeImpostor
def test_deny(self): self.assertEqual(err.reason, "denied")
def test_replaces_proof_is_signed_by_the_old_key(self):
    r = fake.last_reveal["replaces"]
    self.assertTrue(keys.verify_text(OLD_PUB, wire.replace_text(stoke=fake.stoke_pub, old=OLD_PUB, new=NEW_PUB), r["sig"]))
```

- [ ] **Step 2: Run them to see them fail**

Run: `node scripts/hermes-plugin-test.mjs --python /tmp/vhpy/bin/python`
Expected: FAIL, the loader cannot find `transport.py`.

- [ ] **Step 3: Implement `transport.py` and `pairing.py`**

Open with `asyncio.open_unix_connection(path, limit=LIMITS["lineBytes"] + 1)` under
`asyncio.wait_for`; `ENOENT`, `ECONNREFUSED`, a timeout and a closed stream are `StokeUnavailable`.
Check `hello.stoke` against the pinned key BEFORE writing anything. Acks resolve futures keyed by
`(id, part)`.

- [ ] **Step 4: Run them to see them pass, then show each guard red**

Run the same command. Expected: `OK`. Mutate out the pinned-key check before `auth`, the `ok`
signature check, the oversize refusal and the bounce flag; each turns a test red.

- [ ] **Step 5: Lead commits** the two modules and their tests: "Hermes plugin: mutual authentication, and a reconnect that lets Hermes's ledger redeliver".

---

### Task 6: The conversation: reducer, store and service

**Files:**
- Create: `src/shared/channelView.ts`, `src/main/channels/store.ts`, `src/main/channels/service.ts`
- Modify: the suite (sections `conversation`, `store`, `service`, `boundary`); `ARCHITECTURE.md`

**Interfaces:**
- Consumes: Tasks 1, 3, 4 (`ChannelSocket`, `ChannelIdentity`, `PairDesk`, the parsers and texts); `signText`/`verifyText`/`randomB64u`/`randomU8` (`hub/crypto.ts`); `imageKind` (`src/shared/imageUpload.ts`).
- Produces:

```ts
// src/shared/channelView.ts
export type CardState = 'open' | 'answering' | 'answered' | 'expired' | 'retired' | 'unknown'
type CardKind = 'approval' | 'clarify' | 'confirm' | 'choices' | 'models'
export type ChannelCard = { [K in CardKind]: Omit<Extract<HermesFrame, { t: K }>, 'v' | 'id' | 'chat' | 'at' | 't'> & { type: K } }[CardKind]
export type ChannelEntry =
  | { id: string; at: number; from: 'hermes'; kind: 'message'; text: string; status: boolean; final: boolean }
  | { id: string; at: number; from: 'you'; kind: 'message'; text: string; delivery: 'sending' | 'sent' | 'failed' }
  | { id: string; at: number; from: 'hermes' | 'you'; kind: 'media'; mime: string; name: string; bytes: number; image: boolean;
      file: string | null; caption: string; delivery?: 'sending' | 'sent' | 'failed' }   // file: the stoke-asset name; null once evicted
  | { id: string; at: number; from: 'hermes'; kind: 'card'; card: ChannelCard; state: CardState; answer: string | null; note: string | null }
export interface Conversation { entries: ChannelEntry[]; readUpTo: string | null; model: string | null; provider: string | null }
export const EMPTY_CONVERSATION: Conversation
export type StoreOp = { op: 'put'; entry: ChannelEntry } | { op: 'drop'; id: string } | { op: 'read'; upTo: string } | { op: 'status'; model: string | null; provider: string | null }
export function applyHermesFrame(conv: Conversation, frame: HermesFrame, at: number): { ops: StoreOp[]; nack: NackCode | null }
export function applyOps(conv: Conversation, ops: readonly StoreOp[]): Conversation
export function cardAnswerable(conv: Conversation, cardId: string): { ok: true } | { ok: false; why: 'gone' | 'answered' | 'not-oldest' }
export function unreadCount(conv: Conversation): number
export function openCardCount(conv: Conversation): number
export function channelMediaName(peerId: string, mediaId: string, ext: string): string      // `${peerId}-${mediaId}.${ext}`
export function parseChannelMediaName(name: string): { peerId: string; mediaId: string; ext: string } | null
export interface ChannelPeerView { id: string; label: string; connected: boolean; lastSeenAt: number | null; agent: string | null; plugin: string | null; typing: boolean; unread: number; openCards: number; model: string | null }
export interface ChannelView { state: 'off' | 'starting' | 'listening' | 'refused' | 'stranded'; problem: string | null; socketPath: string | null; peers: ChannelPeerView[] }
export const CHANNEL_OFF_VIEW: ChannelView
export interface ChannelEntriesPush { peerId: string; entries: ChannelEntry[]; removed: string[] }
export interface ChannelOutgoing { text: string; clientId: string }
export interface ChannelChoice { choice: string; provider?: string }
export type ChannelSendResult = { ok: true; entry: ChannelEntry } | { ok: false; reason: 'not-connected' | 'too-large' | 'gone' | 'failed'; message: string }
export type ChannelAnswerResult = { ok: true; state: 'answered' | 'expired' | 'unknown' } | { ok: false; why: 'gone' | 'answered' | 'not-oldest' | 'not-connected' | 'invalid' }
export type ChannelPairResult = { ok: true; peerId: string } | { ok: false; reason: 'gone' | 'answered' | 'off' }
// store.ts — <dir>/<peerId>/log.jsonl (one StoreOp per line, 0600) and <dir>/<peerId>/media/
export class ChannelStore {
  constructor(dir: string, opts?: { keepEntries?: number; keepMediaBytes?: number; compactBytes?: number })   // 2000, 200 MiB, 8 MiB
  load(peerId: string): Promise<Conversation>
  append(peerId: string, ops: readonly StoreOp[]): Promise<void>         // resolves once written; serialized per peer
  writeMedia(peerId: string, mediaId: string, ext: string, bytes: Uint8Array): Promise<string>
  mediaPath(name: string): string | null
  drop(peerId: string): Promise<void>
}
// service.ts
export interface ChannelServiceDeps { socketPath: string; dir: string; backend: SecretBackend; platform: string; uid: number; appVersion: string;
  settled: () => boolean; now: () => number; log: (line: string) => void; emitView: (v: ChannelView) => void;
  emitEntries: (p: ChannelEntriesPush) => void; emitPairing: (a: ChannelPairAsk | null) => void; timers?: Partial<typeof CHANNEL_TIMERS> }
export class ChannelService {
  constructor(deps: ChannelServiceDeps)
  start(): Promise<ChannelView>; stop(): Promise<void>; revoke(): void
  view(): ChannelView
  conversation(peerId: string): Promise<Conversation | null>
  send(peerId: string, msg: ChannelOutgoing): Promise<ChannelSendResult>
  sendFile(peerId: string, f: { bytes: Uint8Array; name: string; caption: string }): Promise<ChannelSendResult>
  answer(peerId: string, cardId: string, choice: ChannelChoice): Promise<ChannelAnswerResult>
  read(peerId: string, upTo: string): void
  forget(peerId: string): Promise<ChannelView>
  answerPairing(pairId: string, allow: boolean): Promise<ChannelPairResult>
  mediaFile(name: string): string | null
}
```

- [ ] **Step 1: Write the failing tests**

A fake Hermes in Node (`signText` with the vector keys) over the real socket, a store whose
`append` can be held on a gate, scratch folders with a bystander file:

```ts
section('conversation')
check('a message adds one entry; the same id again adds none', [one.entries.length, again.entries.length], [1, 1])
check('an edit of a card retires it', (retired.entries[0] as { state: string }).state, 'retired')
check('an edit of an unknown id is unknown-target', applyHermesFrame(EMPTY_CONVERSATION, editOf('nope-000001'), 1).nack, 'unknown-target')
check('a chat other than main is unknown-chat', applyHermesFrame(EMPTY_CONVERSATION, { ...msg, chat: 'other' }, 1).nack, 'unknown-chat')
check('two approvals of one session: only the oldest is answerable', cardAnswerable(two, 'a-0000000002'), { ok: false, why: 'not-oldest' })
check('once the oldest is answered, the next is', cardAnswerable(afterFirst, 'a-0000000002'), { ok: true })
section('store')
ok('replay after a torn last line keeps every whole line', ...)
ok('compaction past compactBytes keeps the same conversation', ...)
ok('eviction past keepEntries deletes the dropped media files', ...)
ok('a bystander file in another peer folder survives a drop', ...)
section('service')
ok('Hermes gets its ack only after the store write resolves', ...)           // no ack while the gate holds; ack once released
ok('an unknown frame type is refused and stores nothing', ...)               // ack { ok: false, code: 'unknown-type' }
ok('a frame before ok is never applied', ...)
check('two answers in one tick send one answer frame', hermesSaw.filter((f) => f.t === 'answer').length, 1)
check('an answer with no ack inside ackMs is unknown and stays unanswerable', [first.state, (await svc.answer(p, c, ch)).ok], ['unknown', false])
check('an answer that could not be written goes back to open', state, 'open')
check('an expired result marks the card expired', state, 'expired')
ok('a newer live connection replaces the older; send connections get no frames', ...)
ok('a fifth send connection for one peer is refused with no further byte', ...)
ok('after a replace the old key\'s auth is refused', ...)
ok('typing shows for typingTtlMs and then clears', ...)
ok('a five-part image is stored once, named by its peer and id', ...)
check('a media total past 10 MiB is too-large', ackCode, 'too-large')
check('send while Hermes is not connected sends nothing', (await svc.send(p, m)).ok, false)
ok('revoke() drops every connection before it returns', ...)
check('on win32 start() is off and listens on nothing', [(await winSvc.start()).state, existsSync(winPath)], ['off', false])
section('boundary')
ok('made-up types (open-tab, exec, notify, focus) are refused and change nothing', ...)
ok('the service touches nothing outside its folder and calls nothing but its three emits', ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `node scripts/verify-hermes-channel.mts`
Expected: FAIL, `ERR_MODULE_NOT_FOUND` for `src/shared/channelView.ts`.

- [ ] **Step 3: Implement the reducer, the store and the service**

The service writes `hello` on open, routes unauthenticated lines through `parseHandshake` to the
auth check or the `PairDesk`, and authenticated lines through `parseHermesFrame`,
`applyHermesFrame` and `store.append`, acking after the append. `answer` claims the card
(`answering`) synchronously before its first await. Pushes to `emitEntries` are coalesced to one per
peer per 100 ms. `start()` on `platform === 'win32'` returns the off view with "Hermes on Windows is
not supported yet." and opens nothing.

- [ ] **Step 4: Run them to see them pass, then show each guard red**

Run: `node scripts/verify-hermes-channel.mts`
Expected: `all pass`. Mutate out persist-then-ack (ack before append), the claim, the FIFO rule,
`unknown` after a missing ack, the id dedupe and the pre-`ok` refusal, one at a time; each turns it red.

- [ ] **Step 5: Lead commits** the three files, the suite, `ARCHITECTURE.md`: "Hermes channel: a conversation written before it is acknowledged, and cards answered once".

---

### Task 7: The plugin's adapter, registration and standalone send

**Files:**
- Create: `integrations/hermes-platform/adapter.py`, `standalone.py`, `tests/test_register.py`, `tests/test_adapter.py`
- Modify: `integrations/hermes-platform/__init__.py`; `scripts/hermes-plugin-test.mjs` (`--contract <ref>`); `.github/workflows/ci.yml` (job `hermes-contract`, non-gating)

**Interfaces:**
- Consumes: `wire`, `keys`, `transport` (Tasks 2, 5); the Hermes names in Global Constraints.
- Produces:

```python
PLATFORM = "stoke"; LABEL = "Stoke"; EMOJI = "🔥"; MAX_LEN = 16000
PLATFORM_HINT = ("You are talking to the owner in Stoke, a desktop app. Your replies render as Markdown (CommonMark with "
                 "tables); HTML is not rendered and only http(s) links work. To send a file or an image, put it on a line of "
                 "its own as MEDIA:<absolute path>.")
def register(ctx) -> None
def check_requirements() -> bool          # cryptography importable, sys.platform != "win32"; no I/O
def validate_config(config) -> bool       # STOKE_CHANNEL_KEY and STOKE_PEER_KEY present, Stoke open or not
def is_connected(config) -> bool          # env_is_connected("STOKE_CHANNEL_KEY", "STOKE_PEER_KEY")(config)
def env_enablement() -> dict | None       # None unpaired; else {"paired": True, "socket_path"?: str, "home_channel": {"chat_id": "main", "name": <name>}}
def config_connected(config) -> bool      # U only: bool(config.extra.get("paired"))
def parse_target(ref: str) -> tuple[str, str | None] | None      # "main" → ("main", None)
class StokeAdapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = MAX_LEN
    def __init__(self, config: PlatformConfig) -> None           # super().__init__(config=config, platform=Platform("stoke"))
    async def connect(self, *, is_reconnect: bool = False) -> bool
    async def disconnect(self) -> None
    async def send(self, chat_id: str, content: str, reply_to: str | None = None, metadata: dict | None = None) -> SendResult
    async def edit_message(self, chat_id: str, message_id: str, content: str, *, finalize: bool = False) -> SendResult
    async def delete_message(self, chat_id: str, message_id: str) -> bool
    async def send_typing(self, chat_id: str, metadata=None) -> None
    async def stop_typing(self, chat_id: str) -> None
    async def get_chat_info(self, chat_id: str) -> dict          # {"name": "Stoke", "type": "dm"}
    @property
    def send_path_degraded(self) -> bool
    def _send_retry_is_final(self, result: SendResult) -> bool   # True for send_path_degraded
async def standalone_send(pconfig, chat_id: str, message: str, *, thread_id: str | None = None,
                          media_files: list | None = None, force_document: bool = False) -> dict
```

`register` passes T fields only: `name`, `label`, `adapter_factory=StokeAdapter`, `check_fn`,
`validate_config`, `required_env=["STOKE_CHANNEL_KEY"]`,
`install_hint="Stoke needs macOS or Linux and the cryptography package, which Hermes includes."`,
`is_connected`, `env_enablement_fn`, `cron_deliver_env_var="STOKE_HOME_CHANNEL"`,
`standalone_sender_fn`, `parse_target_ref_fn`, `allowed_users_env="STOKE_ALLOWED_USERS"`,
`max_message_length=MAX_LEN`, `emoji`, `pii_safe=False`, `allow_update_command=False`,
`platform_hint` (`setup_fn` joins in Task 8). Detected extras: `display_tier="high"`,
`allowlist_suppresses_pairing=True`, `config_connected_fn=config_connected`,
`dashboard_label="Stoke"`, `dashboard_description="Talk to Hermes in the Stoke desktop app on this computer."`,
`docs_url="https://github.com/realvinn/stoke/blob/beta/docs/plugins.md"`.
The adapter maps `StokeLink`'s callbacks: up → `_mark_connected()`; down → `_mark_degraded()`;
bounce → `_set_fatal_error("stoke_reopened", "Stoke reopened; reconnecting to deliver what it missed", retryable=True)`
then `await self._notify_fatal_error()`; fatal, `retryable=False`, worded by cause:
`StokeRefused` → `("stoke_unpaired", "Stoke does not know this Hermes. Pair again: hermes gateway setup")`,
`StokeImpostor` → `("stoke_key_changed", "The Stoke on this computer is not the one this Hermes paired with. If Stoke's data was reset, pair again: hermes gateway setup")`.
A refusal `ack` maps to `SendResult(success=False, error="stoke_refused:<code>", retryable=False)`,
except `rate`: `retryable=True, retry_after=1.0`. Metadata `_interim_send` or `non_conversational`
makes a message `kind: "status"`. Inbound text goes through `build_source(chat_id="main",
chat_type="dm", user_id=wire.owner_id(<pinned key>))` and a `MessageDeduplicator` instance
attribute to `handle_message`, then is acked. `auth.agent` is `"Hermes Agent " +
importlib.metadata.version("hermes-agent")`, or `"Hermes Agent"` when that fails; display only.

- [ ] **Step 1: Write the failing contract tests and the contract mode**

Each test class calls `requires_hermes(self)` first; `__init__.py`'s import stays Hermes-free.

```python
class Register(unittest.TestCase):
    def test_registers_through_the_real_context(self):
        ctx = PluginContext(PluginManifest(name="stoke-platform", key="stoke-platform", source="user"),
                            PluginManager(scope_key=platform_registry.current_scope_key()))
        plugin.register(ctx); self.assertIsNotNone(platform_registry.get("stoke"))
    def test_passes_only_fields_this_hermes_has(self): self.assertLessEqual(set(passed), {f.name for f in dataclasses.fields(PlatformEntry)})
    def test_display_tier_only_where_it_exists(self): ...      # absent at T, "high" at U
    def test_never_trusted_inbound(self): self.assertFalse(getattr(entry, "trusted_inbound", False))
    def test_platform_resolves_after_register(self): Platform("stoke")
    # connected_with / enablement_with: test helpers that patch hermes_cli.gateway.get_env_value and get_scoped_secret to an env dict
    def test_is_connected_follows_the_pairing(self): self.assertEqual([connected_with({}), connected_with(PAIRED_ENV)], [False, True])
    def test_env_enablement(self): self.assertIsNone(enablement_with({})); self.assertEqual(enablement_with(PAIRED_ENV)["home_channel"], {"chat_id": "main", "name": "Stoke"})
    def test_validate_config_true_while_stoke_is_closed(self): ...
    def test_parse_target(self): self.assertEqual((parse_target("main"), parse_target("x")), (("main", None), None))
class Adapter(unittest.TestCase):          # fake_stoke from Task 5
    def test_send_returns_the_frame_id_after_the_ack(self): ...
    def test_long_text_is_split_and_continuations_returned(self): self.assertEqual(len(r.continuation_message_ids), pieces - 1)
    def test_closed_stoke_send_is_send_path_degraded(self):
        r = run(a.send("main", "hi")); self.assertEqual((r.success, r.error, r.retryable), (False, "send_path_degraded", True)); self.assertTrue(a._send_retry_is_final(r))
    def test_reappearing_after_a_missed_send_bounces(self): self.assertEqual(fatal_calls, [("stoke_reopened", True)])
    def test_refused_card_is_a_definite_failure(self): ...     # nack → success False, retryable False
    def test_rate_refusal_is_retryable_after_a_second(self): self.assertEqual((r.retryable, r.retry_after), (True, 1.0))
    def test_interim_metadata_is_a_status_line(self): self.assertEqual(fake.lines[-1]["kind"], "status")
    def test_inbound_text_reaches_handle_message(self): self.assertEqual((ev.source.user_id, ev.source.chat_id, ev.text), (wire.owner_id(STOKE_PUB), "main", "hello"))
    def test_a_replayed_inbound_id_is_dropped(self): self.assertEqual(len(handled), 1)
    def test_standalone_send_ok_and_closed(self): self.assertEqual([ok_result.get("success"), closed.get("error")], [True, "Stoke is not open"])
    def test_an_unpaired_stoke_is_fatal_not_retryable(self): ...
```

`--contract <ref>` in the runner: `<ref>` is `v2026.9.24`, `v0.22.5`, `latest` (the newest release
by `gh api repos/NousResearch/hermes-agent/releases/latest -q .tag_name`) or `main`. It clones
`https://github.com/NousResearch/hermes-agent` at that ref into `<os.tmpdir()>/stoke-hermes-<ref>`,
requires `git rev-parse HEAD` to equal the pinned SHA for the two pinned tags, makes a venv there
with the given `--python` and installs the clone (`uv pip install -e .`, else pip), builds the
hermetic environment of the Global Constraints, sets `STOKE_HERMES_CONTRACT=1` (so no contract test
may skip) and runs the discover. CI job `hermes-contract`: `continue-on-error: true`, matrix
`{ref: v2026.9.24, python: '3.11'}` and `{ref: v0.22.5, python: '3.14'}`, plus `latest` and `main`
on the workflow's `schedule`.

- [ ] **Step 2: Run them to see them fail**

Run (in the background; the first clone and install take minutes):
`node scripts/hermes-plugin-test.mjs --contract v2026.9.24 --python ~/.local/bin/python3.12`
Expected: FAIL, the plugin's `adapter` module does not exist yet.

- [ ] **Step 3: Implement `adapter.py`, `standalone.py` and the lazy `register` in `__init__.py`**

`standalone_send` opens its own `role: "send"` connection, never the live adapter's; while Stoke is
closed it returns `send_error("Stoke is not open")`.

- [ ] **Step 4: Run them to see them pass at both tags**

Run (background): `--contract v2026.9.24 --python ~/.local/bin/python3.12`, then
`--contract v0.22.5 --python python3.14`. Expected: `OK` at both, no skips; the pure run of Task 2
still `OK` with the contract tests skipped.

- [ ] **Step 5: Lead commits** the adapter, `standalone.py`, `__init__.py`, the tests, the runner, `ci.yml`: "Hermes plugin: the Stoke platform, registered with only the fields Hermes v0.21.5 has".

---

### Task 8: Pairing inside `hermes gateway setup`

**Files:**
- Create: `integrations/hermes-platform/wizard.py`, `tests/test_wizard.py`
- Modify: `integrations/hermes-platform/adapter.py` (`setup_fn=wizard.interactive_setup`)

**Interfaces:**
- Consumes: `pairing.pair`, `keys.generate_keypair`, `wire.owner_id`, `transport.socket_path`; `hermes_cli.setup` (`prompt`, `prompt_yes_no`, `print_header`), `hermes_cli.config` (`get_env_value`, `save_env_value`), `hermes_cli.cli_output`.
- Produces:

```python
ENV_KEYS = ("STOKE_CHANNEL_KEY", "STOKE_PEER_KEY", "STOKE_ALLOWED_USERS", "STOKE_HOME_CHANNEL", "STOKE_HOME_CHANNEL_NAME")
def interactive_setup() -> None    # synchronous; called by the wizard with no arguments
def run_sync(coro):                # asyncio.run, or in a worker thread when a loop is already running
```

The exact lines it prints: header `Stoke`; `Found Stoke <app> on this computer.`;
`Stoke now shows a request. Check it shows:`; the code, indented; `Waiting for Allow in Stoke...`;
`allowed.`; `Saved Stoke's settings for this Hermes in ~/.hermes/.env`; success `Stoke configured!`.
Refusals: closed → `Stoke is not open on this computer. Open it, tick Settings › Plugins › Hermes › Enabled, and run this again.`;
denied → `Stoke said no. Nothing was saved.`; expired → `Nobody answered in Stoke within five minutes. Nothing was saved.`;
busy → `Stoke is already pairing another Hermes. Answer that first.`;
limit → `Stoke refused: three pairings failed in the last hour. Try again later.`;
mismatch → `Stoke could not check this request, so nothing was saved. Run this again.`;
impostor → `That is not the Stoke this Hermes paired with. Nothing was saved.` When a key is already
saved it asks `Pair this Hermes with Stoke again?` (default No) and sends a `replaces` proof with
the old key. Before connecting it asks `Name this Hermes in Stoke` (default `Hermes`; printable
ASCII, at most 48, asked again otherwise) and sends it as `label`, so a second profile gets a tab
of its own name. It writes its own reconfigure question with `prompt_yes_no`, never the private
`declines_reconfigure`.

- [ ] **Step 1: Write the failing tests** (contract; prompts and env functions patched, `fake_stoke` answering)

```python
def test_saves_all_five_values_after_allow(self):
    self.assertEqual(saved, {"STOKE_CHANNEL_KEY": priv, "STOKE_PEER_KEY": fake.stoke_pub, "STOKE_ALLOWED_USERS": wire.owner_id(fake.stoke_pub),
                             "STOKE_HOME_CHANNEL": "main", "STOKE_HOME_CHANNEL_NAME": "Stoke"})
def test_saves_nothing_on_deny_or_expiry(self): self.assertEqual(saved, {})
def test_asks_before_reconfiguring_and_sends_a_replaces_proof(self): self.assertIn("replaces", fake.last_reveal)
def test_closed_stoke_says_so(self): self.assertIn("Stoke is not open on this computer.", printed)
def test_label_is_asked_and_sent(self): self.assertEqual(fake.last_commit["label"], "Work Hermes")
def test_takes_env_helpers_from_hermes_cli_config(self): self.assertNotIn("from hermes_cli.setup import save_env_value", source("wizard.py"))
def test_private_setup_import_still_exists(self): self.assertIn("title", inspect.signature(hermes_cli.setup.print_header).parameters)
```

- [ ] **Step 2: Run them to see them fail** — `node scripts/hermes-plugin-test.mjs --contract v2026.9.24 --python ~/.local/bin/python3.12` (background). Expected: FAIL, no `wizard` module.
- [ ] **Step 3: Implement `wizard.py`** with the signatures above; it writes nothing before `pair-ok`.
- [ ] **Step 4: Run them to see them pass** at both tags. Expected: `OK`.
- [ ] **Step 5: Lead commits** `wizard.py`, `adapter.py`, the test: "Hermes plugin: pairing in Hermes's own setup, saving nothing until Stoke says Allow".

---

### Task 9: The plugin's cards and pickers

**Files:**
- Create: `integrations/hermes-platform/cards.py`, `tests/test_cards.py`
- Modify: `integrations/hermes-platform/adapter.py`

**Interfaces:**
- Consumes: `wire` caps; the resolvers in Global Constraints.
- Produces:

```python
class Card(NamedTuple):
    kind: str                 # approval | clarify | confirm | choices | models
    session_key: str | None; ref: str | None    # clarify_id / confirm_id
    choices: tuple[str, ...]; created: float; on_selected: Callable | None
class Resolvers(NamedTuple):
    approval: Callable; clarify: Callable; awaiting_text: Callable; confirm: Callable
class CardBook:
    def __init__(self, *, cap: int = 64, ttl: float = 3600.0, now: Callable[[], float] = time.monotonic) -> None
    def add(self, card_id: str, card: Card) -> None
    def take(self, card_id: str) -> Card | None      # pops: a second answer finds nothing
    def card_for(self, ref: str) -> str | None       # a clarify_id or confirm_id → its card id, for retire_clarify_card
BOOK: CardBook                                        # module level: survives an adapter rebuild in one process
def approval_frame(prompt) -> dict      # ExecApprovalPrompt → `approval`; session = sha256(session_key).hexdigest()[:16]; text/command clipped with a mark
def clarify_frame(question: str, choices: list | None) -> dict
def confirm_frame(title: str, message: str) -> dict
def choices_frame(title: str, choices: list[dict]) -> dict
def models_frame(providers: list[dict], current_model: str | None, current_provider: str | None) -> dict
async def resolve(card: Card, answer: dict, *, resolvers: Resolvers) -> tuple[str, str | None]   # ("done" | "expired", follow-up text)
```

Adapter overrides: `_send_exec_approval_prompt(prompt) -> SendResult`,
`send_clarify(chat_id, question, choices, clarify_id, session_key, metadata=None)`,
`send_slash_confirm(chat_id, title, message, session_key, confirm_id, metadata=None)`,
`send_model_picker(chat_id, providers, current_model, current_provider, session_key, on_model_selected, metadata=None)`
(never raises: any failure is `SendResult(success=False)`),
`send_choice_picker(chat_id, title, choices, session_key, on_choice_selected, metadata=None)`,
`retire_clarify_card(clarify_id, notice)` (sends `retire`). Every card send returns the card's frame
id as `message_id`, so Hermes's own timeout edit of that id retires it in Stoke. An open question
(no choices) is a `clarify` with `choices: []` and `other: false`, answered by the next message. An
`answer` frame is acked with `result` from `resolve`, then the card is retired with the decision's
words, and a confirm's follow-up text is sent as a message. A picker sends `status` with the current
model as it opens, and again with the new one after `on_model_selected` succeeds.

- [ ] **Step 1: Write the failing tests** (pure with fake resolvers; contract for the wiring)

```python
def test_a_card_is_answered_once(self): self.assertEqual([book.take(i) is not None, book.take(i)], [True, None]); self.assertEqual(len(calls), 1)
def test_approval_choice_goes_to_the_resolver_with_its_session(self): self.assertEqual(calls, [("sess-1", "once")])
def test_resolver_zero_is_expired(self): self.assertEqual(run(resolve(card, answer, resolvers=zero))[0], "expired")
def test_clarify_index_maps_to_the_choice_text(self): self.assertEqual(calls, [("c1", "No")])
def test_other_marks_awaiting_text(self): self.assertEqual(awaiting, ["c1"])
def test_confirm_returns_its_follow_up(self): self.assertEqual(run(resolve(...)), ("done", "Started a new session."))
def test_model_answer_calls_on_selected(self): self.assertEqual(selected, [("main", "sonnet-x", "anthropic")])
def test_book_cap_and_ttl(self): ...
def test_approval_text_is_clipped_and_says_so(self): self.assertIn("characters not shown", frame["command"])
# contract
def test_overriding_the_prompt_turns_cards_on(self): ...           # the runner's own check names StokeAdapter as rendering buttons
def test_model_picker_never_raises(self): self.assertFalse(run(a.send_model_picker(..., Stoke closed)).success)
def test_real_resolvers_have_the_signatures_used(self): ...         # inspect.signature of the three resolvers
```

- [ ] **Step 2: Run them to see them fail** — pure: `node scripts/hermes-plugin-test.mjs --python /tmp/vhpy/bin/python`. Expected: FAIL, no `cards`.
- [ ] **Step 3: Implement `cards.py` and the overrides.**
- [ ] **Step 4: Run them to see them pass** — pure, then both contract tags (background). Mutate out `take`'s pop and the zero-is-expired mapping; each turns a test red.
- [ ] **Step 5: Lead commits** `cards.py`, `adapter.py`, the tests: "Hermes plugin: approval, question, confirm and picker cards, each answered once".

---

### Task 10: The plugin's media, both ways

**Files:**
- Create: `integrations/hermes-platform/media.py`, `tests/test_media.py`
- Modify: `integrations/hermes-platform/adapter.py` (`send_image_file`, `send_document`, inbound `media`)

**Interfaces:**
- Consumes: `wire` caps; `cache_image_from_bytes`, `cache_document_from_bytes`, `MessageType`.
- Produces:

```python
def kind_of(data: bytes) -> str | None        # png | jpg | gif | webp, by magic bytes
def media_frames(media_id: str, data: bytes, *, mime: str, name: str, caption: str | None, chat: str = "main") -> list[dict]
class MediaAssembler:
    def add(self, frame: dict) -> tuple[bytes, dict] | None    # (bytes, part-0 frame) once whole; ValueError on a bad part or total
```

`send_image_file` / `send_document` read the path (in `asyncio.to_thread`), refuse past 10 MiB
with a definite failure, and send the parts, returning the media id as `message_id`. An inbound image
is cached with `cache_image_from_bytes(data, ext="." + kind)` and sent as
`MessageEvent(message_type=MessageType.PHOTO, media_urls=[path], media_types=[mime], text=caption)`;
anything else as a DOCUMENT through `cache_document_from_bytes(data, name)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_parts_round_trip(self): self.assertEqual(assemble(media_frames("m-0000000001", data_5_parts, ...)), data_5_parts)
def test_a_wrong_total_is_refused(self): self.assertRaises(ValueError, ...)
def test_more_than_ten_mib_is_refused(self): self.assertRaises(ValueError, media_frames, "m-0000000001", b"x" * (10485760 + 1), mime="image/png", name="a.png", caption=None)
def test_part_out_of_range_is_refused(self): ...
def test_magic_bytes_decide_the_kind(self): self.assertEqual([kind_of(PNG), kind_of(b"%PDF-1.7")], ["png", None])
def test_send_image_file_sends_every_part(self): ...                     # contract
def test_an_inbound_image_reaches_hermes_as_media_urls(self): ...        # contract: PHOTO, the cached path
```

- [ ] **Step 2: Run them to see them fail** — `node scripts/hermes-plugin-test.mjs --python /tmp/vhpy/bin/python`. Expected: FAIL, no `media`.
- [ ] **Step 3: Implement `media.py` and the three adapter paths** with the signatures above.
- [ ] **Step 4: Run them to see them pass** — pure, then both contract tags (background). Expected: `OK`.
- [ ] **Step 5: Lead commits** `media.py`, `adapter.py`, the test: "Hermes plugin: images and files in parts small enough for any transport".

---

### Task 11: Main wiring, IPC, the built-in plugin and the media scheme

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/shared/api.ts`, `src/main/index.ts`, `src/shared/pluginPackages.ts`, `src/main/plugins/packageManager.ts` (seed `hermes` installed and off, as `work` is), `src/renderer/src/components/PluginsSettings.tsx` (the muted line for `hermes`; no Install disabled or Remove plugin for it; its switch label); the suite (section `wiring`, reading `packageManager.ts` and `PluginsSettings.tsx` too); `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `ChannelService` (Task 6), `channelSocketPathFor`, `CHANNEL_OFF_VIEW`; `inspectUploadFile`, `openUploadFile` (`src/main/sshUpload.ts`); `secretsSettled`, `safeStorageBackend`.
- Produces:

```ts
// src/shared/ipc.ts
channelView: 'channel:view', channelConversation: 'channel:conversation', channelSend: 'channel:send',
channelSendFile: 'channel:send-file', channelAnswer: 'channel:answer', channelRead: 'channel:read',
channelSaveFile: 'channel:save-file', channelForget: 'channel:forget', channelPairAnswer: 'channel:pair-answer',
channelChanged: 'channel:changed', channelEntries: 'channel:entries', channelPairing: 'channel:pairing',
// src/shared/api.ts, in StokeApi
channel: {
  view(): Promise<ChannelView>
  conversation(peerId: string): Promise<Conversation | null>
  send(peerId: string, msg: ChannelOutgoing): Promise<ChannelSendResult>
  sendFile(peerId: string, file: File | null, caption: string): Promise<ChannelSendResult>   // the preload reads File paths; null: main's open dialog
  answer(peerId: string, cardId: string, choice: ChannelChoice): Promise<ChannelAnswerResult>
  read(peerId: string, upTo: string): void
  saveFile(peerId: string, entryId: string): Promise<{ ok: boolean; message?: string }>
  forget(peerId: string): Promise<ChannelView>
  answerPairing(pairId: string, allow: boolean): Promise<ChannelPairResult>
  onChange(cb: (view: ChannelView) => void): () => void
  onEntries(cb: (push: ChannelEntriesPush) => void): () => void
  onPairing(cb: (ask: ChannelPairAsk | null) => void): () => void
}
// src/shared/pluginPackages.ts: a `hermes` entry in BUILTIN_PACKAGES (kind 'builtin', name 'Hermes', description
// 'Talk to Hermes Agent in a Stoke tab, the way you would in Telegram. Hermes can send you messages and questions here, and nothing else.')
// and a PLUGIN_CATALOG entry { category: 'Agents', source: 'https://github.com/realvinn/stoke' } found by id, never by index.
// PRE-INSTALLED AND OFF, the `work` precedent (src/main/plugins/packageManager.ts seeds `state.installed.work`): seed
// `state.installed.hermes = { package: <the hermes built-in, found by id>, enabled: false }` when absent, and keep the
// built-in's row free of "Install disabled" and "Remove plugin" (PluginsSettings already exempts `work` from Remove;
// exempt `hermes` from both). The owner's rule is that Stoke shows no Install button for Hermes, and Stoke's own
// generic "Install disabled" beside the word Hermes reads as exactly that. The row's on/off control is labelled
// "Let Hermes message me here", and it is the only switch.
// src/main/index.ts
let channels: ChannelService | null; let channelsLoading: Promise<ChannelService> | null
function channelsFor(): Promise<ChannelService>     // ??= await secretsSettled(); import('./channels/service.ts') and './secrets.ts'
function channelSocketPath(): string                // channelSocketPathFor({ canonical: app.isPackaged && !app.commandLine.hasSwitch('user-data-dir'), … })
```

Wiring in `index.ts`: start in `createWindow` after `secretsSettled()` when the window is still the
primary one, not quitting, not `win32`, and `pluginPackagesFor().enabled('hermes')`; `builtinToggle`
starts or stops it for `hermes`; `builtinRevoke` calls `channels?.revoke()`; `win.on('closed')` and
`before-quit`'s once-only block call `void channels?.stop()`; every handler starts with
`channelFrame(e)` (`appFrame`, else throws "Open Hermes in Stoke."); `channel:view` answers
`channels ? channels.view() : CHANNEL_OFF_VIEW` and never loads the module; `channel:send-file`
checks a path with `inspectUploadFile` and reads it with `openUploadFile` (≤ 10 MiB), or opens a
dialog for `null`; `channel:save-file` uses `dialog.showSaveDialog` and copies the stored file; the
`stoke-asset` handler routes host `channel` to `channels?.mediaFile(name)`; pushes go through
`send()`.

- [ ] **Step 1: Write the failing source-text checks** (gotcha 175: pin each holder)

```ts
section('wiring')
ok('every channel handler asks channelFrame first', channelHandlers(index).every((h) => /^\s*channelFrame\(e\)/.test(h.body)))
ok('channel:view never loads the service', /CH\.channelView[\s\S]{0,160}channels \? channels\.view\(\) : CHANNEL_OFF_VIEW/.test(index))
ok('builtinRevoke drops every socket for hermes', /id === 'hermes'\) channels\?\.revoke\(\)/.test(index))
check('the listener stops in the closed handler and in before-quit\'s once block', [stopsIn(closedBlock), stopsIn(onceBlock)], [true, true])
ok('the canonical path only for the installed app', /canonical: app\.isPackaged && !app\.commandLine\.hasSwitch\('user-data-dir'\)/.test(index))
ok('channels/ is never imported statically (gotcha 40)', !/^import[^\n]*\.\/channels\//m.test(index))
ok('the hermes built-in is found by id', !/BUILTIN_PACKAGES\[3\]/.test(packages))
// the owner's rule on the Stoke side: no Install (or Remove) control next to Hermes; it is seeded installed and off
ok('hermes is seeded installed and disabled, like work', /state\.installed\.hermes\s*=\s*\{[^}]*enabled:\s*false/.test(packageManager))
ok('the hermes row shows no Install disabled and no Remove plugin', /!entry\.installed[\s\S]{0,120}manifest\.id !== 'hermes'|manifest\.id !== 'hermes'[\s\S]{0,120}Install disabled/.test(pluginsSettings) && /manifest\.id !== 'work' && entry\.manifest\.id !== 'hermes'|!\['work', 'hermes'\]\.includes\(entry\.manifest\.id\)/.test(pluginsSettings))
ok('its switch says what it does', pluginsSettings.includes('Let Hermes message me here'))
ok('the phone server and the browser MCP server have no channel route or tool', [...remoteFiles, ...mcpFiles].every((f) => !/\/channels\/[a-z]+\.ts|CH\.channel[A-Z]/.test(read(f))))   // src/main/remote/**, src/main/mcp/**
// the hard rule: no path into ~/.hermes ('.hermes', "/.hermes/", `~/.hermes`) and no spawn of `hermes`; `rec.hermes` (a field) is fine
ok('no Stoke code runs or reads Hermes', srcFiles.every((f) => !/['"`/~]\.hermes(?=['"`/])|(spawn|execFile|execFileSync|spawnSync)\(\s*['"`][^'"`]*\bhermes['"`]/.test(withoutComments(read(f)))))   // every src/**/*.ts(x)
```

- [ ] **Step 2: Run them to see them fail** — `node scripts/verify-hermes-channel.mts`. Expected: the wiring checks FAIL.
- [ ] **Step 3: Implement** the names and wiring above.
- [ ] **Step 4: Run them to see them pass, and check the bundle**

Run: `node scripts/verify-hermes-channel.mts && npm run typecheck && npm run build`, then
`grep -nE '^const [A-Za-z_$]+ = require\("' out/main/index.js`.
Expected: `all pass`; the grep lists only node builtins, `electron`, `@lydell/node-pty` and `ws`.

- [ ] **Step 5: Lead commits** the seven files and the suite: "Hermes channel: wired into main behind the plugin switch, loaded only when it is on".

---

### Task 12: The `channel` tab kind

**Files:**
- Modify: `src/shared/tabWindows.ts` (`TabKind`, `Tab.channel`, `canMoveTab`), `src/shared/types.ts` (`StoredTab.kind`, `StoredTab.channel`), `src/main/tabStore.ts` (`tabOf`), `src/renderer/src/lib/restore.ts` (`restorableTabs`, `toStored`, `fromStored`), `src/renderer/src/lib/tabs.ts` (`restartPlan`, the kind unions of `closeAsksDetach` and `relaunchPlan`, `tabLabel`, `profileCwd`), `src/shared/topBar.ts` (`ShortcutTarget.kind`, `shortcutVerdict`, `folderChip`), `TitleBar.tsx` (agent mark `null`, rename allowed, no `UsageChip`), `StatusBar.tsx` (label and Connected / Not connected), `TabIndicator.tsx` (an icon of its own), `src/shared/channelView.ts`
- Modify: the suite (section `tab kind`), `scripts/verify-restore.mts`

**Interfaces:**
- Consumes: `ChannelPeerView` (Task 6), `ActivityView` (`src/shared/activityView.ts`).
- Produces:

```ts
export interface ChannelTabBinding { peerId: string; label: string; draft: string; sending?: boolean }   // channelView.ts
// Tab gains `channel?: ChannelTabBinding`; a channel tab keeps cliId = DEFAULT_CLI, never read for it (the kind guards every CLI reader)
// StoredTab: kind 'session' | 'new' | 'channel'; channel?: { peerId: string; label: string }   — stored with cwd '' and no draft, no screen
export function channelActivity(peer: Pick<ChannelPeerView, 'unread' | 'openCards'> | null): ActivityView
// open card → { dot: 'waiting', label: 'Hermes needs you' }; unread → { dot: 'done', label: 'New message from Hermes' }; else no dot
```

- [ ] **Step 1: Write the failing tests** (verify-grok-bot's poison-folder shape)

```ts
section('tab kind')
const tab: Tab = { id: 'owned-channel-tab', kind: 'channel', cliId: 'claude', ptyId: '', sessionId: '', cwd: '/owned/poison-folder',
  projectName: '', title: '', permissionMode: 'default', model: '', effort: 'default', ultracode: false, status: 'running', exitCode: null,
  hostId: null, selectedPath: null, expandedPath: null, channel: { peerId: '0123456789abcdef', label: 'Hermes · this Mac', draft: 'owned draft' } }
check('the label is the peer\'s', tabLabel(tab, null).text, 'Hermes · this Mac')
check('no folder, profile, chip, shortcut or restart', [openableFolder(tab), profileCwd(tab), folderChip(tab, chipOpts), shortcutVerdict({ on: 'any' }, { ...tab, utility: false, dot: null }).ok, restartPlan(tab, []).kind], [null, null, null, false, 'impossible'])
const stored = toStored([tab], tab.id, {}, () => { throw new Error('a channel tab has no screen') }, 0)
check('stored with its peer, no folder, no draft', [stored.tabs[0].kind, stored.tabs[0].cwd, stored.tabs[0].channel, JSON.stringify(stored).includes('owned draft')], ['channel', '', { peerId: '0123456789abcdef', label: 'Hermes · this Mac' }, false])
check('restored as a channel tab', fromStored(stored).tabs[0].kind, 'channel')
check('a sending tab stays in its window', canMoveTab({ ...tab, channel: { ...tab.channel!, sending: true } }), false)
check('the dot', [channelActivity({ unread: 2, openCards: 1 }).dot, channelActivity({ unread: 2, openCards: 0 }).dot, channelActivity(null).dot], ['waiting', 'done', null])
// verify-restore.mts
check('tabOf keeps a channel tab with a valid peer id', ...)
check('tabOf drops a channel tab with a bad peer id', ...)
check('an older reader drops it for want of a folder', olderTabOf(stored.tabs[0]), null)   // kind ≠ 'new' → 'session', cwd '' → dropped
```

- [ ] **Step 2: Run them to see them fail** — `node scripts/verify-hermes-channel.mts; npm run verify:restore`. Expected: FAIL (`channel` is not a kind yet).
- [ ] **Step 3: Implement** the kind at every site above, then grep `'grok-bot'` across `src/` and give each remaining site a `channel` decision (gotcha 150).
- [ ] **Step 4: Run them to see them pass** — the two suites, then `npm run verify:tabs && npm run verify:topbar && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Lead commits** the files and both suites: "Hermes channel: a tab kind with no folder, no terminal and no agent, restored by its peer".

---

### Task 13: The Hermes tab: workspace, cards, composer and notifications

**Files:**
- Create: `src/renderer/src/components/SafeMarkdown.tsx`, `ChannelWorkspace.tsx`, `ChannelCards.tsx`, `src/renderer/src/lib/useChannel.ts`, `src/renderer/src/styles/channel.css`
- Modify: `GrokBotMessages.tsx` (uses `SafeMarkdown`; its `grok-*` classes unchanged), `App.tsx`, `Launcher.tsx`, `src/shared/channelView.ts`; the suite (section `renderer rules`); `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `window.stoke.channel` (Task 11), `ChannelTabBinding`/`channelActivity` (Task 12), `chatOpenPlan`/`chatNewTab`, `pathTakesFocus`, `refuseOverlongPaste`.
- Produces:

```tsx
export function SafeMarkdown({ text, onOpenUrl }: { text: string; onOpenUrl: (url: string) => void }): React.JSX.Element   // GrokBotMessages' MessageText and linkUrl, moved
export function ChannelWorkspace({ binding, peer, onChange, onOpenUrl }: { binding: ChannelTabBinding; peer: ChannelPeerView | null;
  onChange: (patch: Partial<ChannelTabBinding>) => void; onOpenUrl: (url: string) => void }): React.JSX.Element
export function ChannelCardView({ entry, answerable, onAnswer }: { entry: Extract<ChannelEntry, { kind: 'card' }>;   // not `ChannelCard`: that is Task 6's type
  answerable: ReturnType<typeof cardAnswerable>; onAnswer: (choice: ChannelChoice) => Promise<void> }): React.JSX.Element
export function useChannel(enabled: boolean): { view: ChannelView | null; pairAsk: ChannelPairAsk | null }   // subscribes only while enabled
// channelView.ts
export function firstLine(text: string, max: number): string            // first non-empty line, Markdown marks removed, cut with …
export function notificationFor(entry: ChannelEntry, label: string): { title: string; body: string } | null
// App.tsx: hermesEnabled (as grokBotEnabled, for 'hermes'); openChannelTab(peerId: string, from?: string | null) through chatOpenPlan with
// the peer's existing tab as holder and a per-peer claim before the start; channel tabs closed when the plugin is off or their peer is
// forgotten; activityViews for channel tabs from channelActivity; notifications from onEntries; the lazy workspace mount
```

The workspace fetches its conversation once and applies `onEntries` for its peer; follows the
bottom like GrokBotWorkspace (80 px rule); draws Hermes's text, status lines (small, muted), media
(`<img src="stoke-asset://channel/<name>">` for images, a name, size and **Save…** for files),
cards, "Hermes is typing…" and the header (label, model chip sending `/model`, Connected / Not
connected). The composer: `maxLength={CHANNEL_LIMITS.composerChars}`, `refuseOverlongPaste`,
⌘/Ctrl+Enter sends, Enter is a newline, the draft in the binding, a **+** that calls
`sendFile(peerId, null, '')`, `Files`-only drops (gotcha 59), disabled with "Hermes is not
connected" when the peer is not. Card buttons claim before their await and go dead after one
press; Other… focuses the composer (the press is the person's act). Nothing that arrives moves
focus. While the tab is in front and the window focused, it sends `read(peerId, <newest id>)`.
Notifications: `settings.notifications` (`off` / `background` / `always`), `background` meaning
`!document.hasFocus() || !inFront`, at most one per peer per `CHANNEL_TIMERS.notifyGapMs`,
`tag: 'stoke-channel-' + peerId`, a click focusing the window and calling `openChannelTab`; App keeps
a `notifiedIds` set, so only an entry id it has not seen before can notify (an edit re-pushes the
same id). The Launcher gets one "Hermes · this Mac" row per paired peer (`channelPeers`,
`onStartChannel`).

- [ ] **Step 1: Write the failing tests**

```ts
section('renderer rules')
check('a reply notifies with its first line', notificationFor(hermesMsg('## Morning brief\n- 3 PRs'), 'Hermes · this Mac'), { title: 'Hermes · this Mac', body: 'Morning brief' })
check('at most 120 characters', firstLine('x'.repeat(300), 120).length, 120)
check('a card says Hermes needs you, never the command', notificationFor(approvalEntry('rm -rf /x'), 'L')?.body, 'Hermes needs you')
check('a status line and your own message do not notify', [notificationFor(statusEntry, 'L'), notificationFor(yourEntry, 'L')], [null, null])
ok('an entry id App has seen never notifies again (an edit pushes the same id)', /notifiedIds/.test(app) && /notifiedIds\.has\(/.test(app))
ok('Hermes text renders only through SafeMarkdown', channelComponents.every((s) => !s.includes('dangerouslySetInnerHTML')) && /SafeMarkdown/.test(workspace) && /SafeMarkdown/.test(cards))
ok('nothing that arrives calls focus()', !/onEntries[\s\S]{0,400}\.focus\(/.test(workspace))
ok('every card press claims before its await', /const mine = \{\}/.test(cards))
```

- [ ] **Step 2: Run them to see them fail** — `node scripts/verify-hermes-channel.mts`. Expected: FAIL (no `notificationFor`).
- [ ] **Step 3: Implement** the components, the hook and the App wiring above. Colours only through custom properties in `channel.css`; every styled `<button>` declares `border` and `background` (gotcha 47).
- [ ] **Step 4: Run them to see them pass** — the suite, `npm run verify:grok-bot` (the shared Markdown still holds), `npm run typecheck && npm run build`. Expected: all pass.
- [ ] **Step 5: Lead commits** the components, hook, styles, App, Launcher, the suite: "Hermes channel: the Hermes tab, pushed, with cards answered once and notifications that never take focus".

---

### Task 14: Settings › Plugins › Hermes, and the pairing strip

**Files:**
- Create: `src/renderer/src/components/HermesPanel.tsx`, `ChannelPairStrip.tsx`
- Modify: `PluginsSettings.tsx` (`{entry.enabled && entry.manifest.id === 'hermes' && <HermesPanel … />}`), `SettingsSheet.tsx` (threads `hermes?: { onOpen }` from App to PluginsSettings, as `workMode` is threaded), `App.tsx` (the strip in `.main-col` beside `HubJoinPrompt`, fed `pairAsk` from `useChannel`), `src/shared/settingsIndex.ts`, `src/shared/channel.ts`, `styles/channel.css`, `docs/plugins.md` (a "Hermes" section: what it is, the commands, pairing, what Hermes can do, the boundary); the suite

**Interfaces:**
- Consumes: `window.stoke.channel`, `window.stoke.clipboard.writeText`, `toast()`, `IconCopy`.
- Produces:

```ts
export const HERMES_PLUGIN_SOURCE = 'realvinn/stoke/integrations/hermes-platform'
export const HERMES_PLUGIN_REF: string        // 40 hex: a pushed commit that already holds integrations/hermes-platform
export const HERMES_PLUGIN_VERSION = '0.1.0'
export function hermesCommands(ref: string): { install: string; setup: string; streaming: string; update: string; restart: string }
export function pluginOutdated(reported: string | null, expected: string): boolean      // null → false
export function HermesPanel({ onOpen }: { onOpen: (peerId: string) => void }): React.JSX.Element      // data-setting="plugins.hermes"
export function ChannelPairStrip({ ask, onAllowed }: { ask: ChannelPairAsk; onAllowed: (peerId: string) => void }): React.JSX.Element
// SETTING_ROWS: { plugin: 'hermes', id: 'plugins.hermes', page: 'plugins', label: 'Let Hermes message me here',
//   keywords: ['hermes', 'hermes agent', 'nous research', 'messaging platform', 'pair hermes', 'gateway setup', 'copy command',
//   'open', 'forget', 'paired hermes', 'streaming'], fallback: 'plugins.manager' }
```

Panel copy, exactly: the spec §7 mockup's lines; "Waiting for a Hermes to pair." before any;
"Listening on this Mac." / the view's `problem`; per peer "Connected" or "Last seen <time>",
"<agent> · plugin <version>", **Open**, **Forget…** (confirm: "Forget Hermes · this Mac? Its
conversation here is deleted. Hermes keeps its own copy."); when `pluginOutdated`, "Update Stoke's
plugin in Hermes:" with `update` then `restart`; the boundary line of spec §6. Every command sits
in `<span className="mono">` with a **Copy command** button that calls only
`window.stoke.clipboard.writeText` and shows "Copied". The strip: `ssh-prompt` classes, `role="status"`
`aria-live="polite"`, "Hermes on this Mac wants to message you here." then "Code <code>. Allow only
if Hermes shows the same code right now." (paired again: "Hermes on this Mac paired again. Allow keeps
its conversation. Code <code>."), **Allow** and **Deny** claimed before their await, plain keys stopped
on its root (Enter and Space press the focused button), fed its `ask` by App and never calling
`channel.view()` itself (HubJoinPrompt's lesson), and on Allow a toast "Hermes can now message you
here" and `onAllowed(peerId)`. The panel, mounted only while the plugin is enabled, reads
`channel.view()` on mount and follows `onChange`.

- [ ] **Step 1: Lead names the pin**

Once Tasks 2–10 are committed and pushed (the install clones from GitHub), hand the implementer
`git log -1 --format=%H -- integrations/hermes-platform`. That is `HERMES_PLUGIN_REF`. If any later
change touches the folder, the pin moves the same way before a release.

- [ ] **Step 2: Write the failing tests**

```ts
section('panel')
check('the commands, exactly', hermesCommands('a'.repeat(40)), {
  install: `hermes plugins install realvinn/stoke/integrations/hermes-platform --ref ${'a'.repeat(40)}`,
  setup: 'hermes gateway setup', streaming: 'hermes config set streaming.enabled true',
  update: `hermes plugins install realvinn/stoke/integrations/hermes-platform --ref ${'a'.repeat(40)} --force`, restart: 'hermes gateway restart' })
ok('the pinned ref is a full commit hash, not a placeholder', /^[0-9a-f]{40}$/.test(HERMES_PLUGIN_REF) && !/^(.)\1{39}$/.test(HERMES_PLUGIN_REF))
check('pluginOutdated', [pluginOutdated('0.0.9', '0.1.0'), pluginOutdated('0.1.0', '0.1.0'), pluginOutdated(null, '0.1.0')], [true, false, false])
ok('the panel only copies: no pty, launch or spawn', !/pty\.|launch\(|spawn|installSteps|openExternal/.test(panel))
ok('the strip stops plain keys on its root', /onKeyDown=\{[\s\S]{0,200}stopPropagation/.test(strip))
ok('the strip never asks main for the view', !/channel\.view\(/.test(strip))
```

- [ ] **Step 3: Run them to see them fail** — `node scripts/verify-hermes-channel.mts`. Expected: FAIL (no `hermesCommands`).
- [ ] **Step 4: Implement** the panel, the strip, the row and the constants, with `HERMES_PLUGIN_REF` set to Step 1's hash.
- [ ] **Step 5: Run them to see them pass** — the suite, `npm run verify:settings-search` (both directions of the mark and the row) and `npm run verify:layers`. Expected: all pass. Then `git cat-file -e "$(grep -oE "HERMES_PLUGIN_REF = '[0-9a-f]{40}'" src/shared/channel.ts | grep -oE '[0-9a-f]{40}')":integrations/hermes-platform/plugin.yaml` exits 0: the pin holds the plugin.
- [ ] **Step 6: Lead commits** the panel, strip, SettingsSheet, PluginsSettings, App, settings row, `channel.ts`, styles, `docs/plugins.md`: "Hermes: Settings panel and pairing strip, with Hermes's commands as text to copy".

---

### Task 15: The whole thing, proven

**Files:**
- Create: `scripts/hermes-e2e.mjs`
- Modify: `ARCHITECTURE.md`, `CLAUDE.md` only if something is missing; record any new gotcha the runs teach (CLAUDE.md's "Recording a new gotcha", in a rule file whose `paths:` reaches the code)

**Interfaces:**
- Consumes: everything above.
- Produces: the evidence folder `/tmp/stoke-hermes-e2e-<date>/` (screenshots, the wizard's terminal text, Hermes's and Stoke's logs) and a short report.

- [ ] **Step 1: The gate, in scratch**

Run (background): `TMPDIR=$(mktemp -d /tmp/vhcheck-XXXX) npm run check`. Expected: exit 0, the
build included.

- [ ] **Step 2: The plugin's tests and Hermes's own checks**

Run: `node scripts/hermes-plugin-test.mjs --python /tmp/vhpy/bin/python` (pure), then (background)
`--contract v2026.9.24 --python ~/.local/bin/python3.12` and `--contract v0.22.5 --python python3.14`.
Expected: `OK`, no skips under `--contract`. Then from each clone's venv, with a scratch
`HERMES_HOME`: `python -m hermes_cli.main plugins validate integrations/hermes-platform --json` and
`python -m hermes_cli.main plugins doctor integrations/hermes-platform --ci` (read each `--help`
first). Expected: valid, the scan `safe`
(a `caution` finding is fixed, or named in the report with the line that trips it), doctor exit 0.

- [ ] **Step 3: The end-to-end run**, `scripts/hermes-e2e.mjs --ref <tag> --python <bin>`, at
`v0.22.5`, then at `v2026.9.24`

In a separate clone and venv (Task 7's), with the hermetic environment, and with
`STOKE_SOCKET_PATH=<scratch>/ud/channel/stoke.sock`:
1. Copy the plugin to `<HERMES_HOME>/plugins/stoke-platform/`; write a test `config.yaml`
   (`model.provider: custom` at the fake server, `approvals.mode: manual`, `approvals.timeout: 60`,
   `agent.clarify_timeout: 120`, `streaming.enabled: true`, `plugins.enabled: [stoke-platform]`,
   `telemetry.shared_metrics.enabled: false`, `updates.check: false`); a short fake `OPENAI_API_KEY`
   built from pieces, outside the plugin folder.
2. Start the clone's `tests.fakes.fake_llm_provider.FakeLLMServer` on 127.0.0.1, scripted for: a
   plain reply; a streamed reply (`chunk_chars=8`); `terminal` with `rm -r <scratch>/victim`; `clarify`
   with "Keep images newer than 30 days?" / Yes / No; a reply with a `MEDIA:<png>` line; a reply
   delayed 5 s.
3. Launch the BUILT Stoke: `--user-data-dir=<scratch>/ud --use-mock-keychain --remote-debugging-port=<port> --disable-backgrounding-occluded-windows`;
   over CDP confirm the Plugins page shows the `hermes` row with no Install or Remove button, and
   turn its "Let Hermes message me here" switch on with a trusted click (the real
   `window.stoke.plugins` toggle, never `install`).
4. Pair through the real menu: `python -m hermes_cli.main gateway setup` in a pty (node-pty, the
   screen read through `@xterm/headless`); move to "🔥 Stoke"; read Hermes's code; read the strip's
   code over CDP; require them equal; screenshot the strip; press Allow with a trusted
   `Input.dispatchMouseEvent`; require "Stoke configured!" and "(configured)"; answer **No** to the
   restart; save the terminal text.
5. Start `python -m hermes_cli.main gateway run` in the foreground (`start_new_session`); wait until
   the view says Connected.
6. Drive and screenshot: the plain reply; the stream editing in place; the approval card, **Deny**,
   and `<scratch>/victim` still there; a second run, **Allow once**, and it gone; a double click on
   a card (one answer reaches Hermes); the question card, **No**; `/model` and a pick; `/reasoning`;
   `/new` and its confirm card; the image inline; an image dropped in Stoke reaching the fake model's
   request; focus left in the composer while messages arrive; the activity dot and one notification;
   a docked-browser page loading `stoke-asset://channel/<that image's name>` gets nothing.
7. Stoke closed: send a message whose scripted reply is delayed 5 s and close the window before it
   comes; `hermes send --to stoke "while closed"` says "Stoke is not open"; a cron job with
   `deliver=stoke` falls due while the window is closed (made with the clone's own cron command;
   read its `--help` first). Quit Stoke properly and relaunch the same sandbox:
   the reply arrives with Hermes's "Recovered reply" line; the cron text arrives at `v0.22.5` and is in
   Hermes's `delivery_errors` at `v2026.9.24`; the tab and its conversation are restored.
8. Stop: SIGTERM the gateway's own process group and wait; quit Stoke properly (never force-kill);
   remove the scratch tree; confirm the owner's Hermes untouched without reading it: the mtimes of
   `~/.hermes` and its top-level entries (`stat` only, before and after) and the
   `ai.hermes.gateway` pid in `launchctl list` are unchanged.

Expected: every step's evidence saved; nothing in `~/.hermes` changed.

- [ ] **Step 4: Report** what ran at each tag, what failed and why, any `caution` finding, and
  every UNVERIFIED line of the spec §10 this proved or left.

- [ ] **Step 5: Lead commits** `scripts/hermes-e2e.mjs` and any docs: "Hermes: proven end to end against Hermes v0.21.5 and v0.22.5". If a fix in this task touched `integrations/hermes-platform/`, move `HERMES_PLUGIN_REF` to that commit (Task 14 Step 1's rule) and rerun Task 14 Step 5's checks.
