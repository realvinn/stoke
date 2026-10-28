# Stoke as a messaging platform for Hermes

**Status:** approved 2026-10-28. Slice 1 (Hermes on this Mac) is planned in
[2026-10-28-hermes-platform-slice1-local.md](../plans/2026-10-28-hermes-platform-slice1-local.md);
slices 2 and 3 get plans of their own. The research behind this, its adversarial critique and the
two contract notes (Hermes's plugin contract at three versions, and Stoke's seams) were written in
the workflow's scratch folder on 2026-10-28 and are not kept in the repo. Once slice 1 lands, the
contract is the code: `src/shared/channel.ts`, the plugin's `wire.py` and the test vectors both
read. Where this prose and that code disagree, the prose is the bug.

**Versions this was checked against.** Hermes is cited at three points, because its main branch
moves fast (eight releases in the 29 days to 2026-10-23):

| Key | What | Commit | Python |
|---|---|---|---|
| **T** | the real v0.21.5 release, tag `v2026.9.24` | `f97608f178d1ffeca59860195ab7da295f7c8e5f` | `>=3.11,<3.14` |
| **H** | this Mac's install, main at 2026-10-04, between v0.21.5 and v0.21.6 | `0b088a78` | 3.14 |
| **U** | v0.22.5, tag `v0.22.5`, 2026-10-23 | `bf0203a794a07aac3ff764972ab9087baa4e4f4e` | `>=3.11,<3.15` |

Stoke: `c561409` (1.0.0-beta.20 plus the MIT licence). The NUC's Hermes version was not read;
slice 2 reads it first.

---

## Approved 2026-10-28

The owner approved the recommendation on 2026-10-28 with these answers. Do not re-ask them.

1. **The hard rule, in the owner's words:** "dont import any hermes i would have to select stoke as
   a messaging platform for hermes". It means:
   - **Stoke never installs, imports, runs, reads or changes anything of Hermes's.** No `hermes`
     command is run by Stoke, not even `--version`. Stoke never reads `~/.hermes`. There is no
     Hermes chat-history source, no Hermes terminal agent, and no Install or Open setup button.
   - **The person adds the plugin on the Hermes side**: `hermes plugins install …`, then
     `hermes gateway setup`, picking **Stoke**.
   - **Stoke may only show those commands, as text to copy.**
2. **Hermes only messages the owner in Stoke, for now.** It gets no other power. Each later power
   (open a link, start a Claude tab, see what tabs are doing) is its own switch, off by default,
   with its own design.
3. **The NUC's always-on Hermes is the day-to-day one.** Slice 2 (through the Stoke Hub) follows
   slice 1 directly; slice 1 is the proving ground on this Mac.
4. **Licence and catalog.** An MIT LICENSE is in the repo (7cd7aa0). A public catalog pull
   request to NousResearch/hermes-agent comes later, and needs the owner's go at that time.

**The critique's corrections are binding.** Each is folded into the section named:
- Target the v0.21.5 TAG's 26 `PlatformEntry` fields and feature-detect the rest:
  `display_tier`, `trusted_inbound`, `shared_env_prefixes` and every v0.22 field (§3.2). The
  first design's "v0.21.5" was H, not the release, and passed `display_tier` unconditionally, which
  fails to load on a real v0.21.5.
- Register `is_connected` and `env_enablement_fn` and a home channel, as IRC does (§3.2).
- Promise replies, cron `deliver=stoke`, `hermes send --to stoke` and the cards. Never "Hermes
  messages you on its own": `send_message` is not an agent tool (§1).
- Mutual authentication on the socket, with Stoke's key pinned at pairing (§4.2).
- Return `send_path_degraded` while Stoke is closed, so Hermes's delivery ledger redelivers (§3.4).
- Declare the key in `optional_env` (§3.2).
- State the boundary honestly: it keeps out the docked browser and the phone, not local agents,
  which can already run `hermes -z` (§6).
- Run the end-to-end test in a separate clone or container; one gateway per machine applies to
  the installed version (§8).
- Support Python 3.11 to 3.14 (§3.1).
- Smaller ones: the compatibility import layer went in v0.21.6, not v0.22.0 (§3.1); the approval
  card shows a command Hermes has already redacted (§5.5); a tap resolves the session's OLDEST
  approval (§5.5); slice 2's session handoff and disconnect do not exist on today's hub (§8).

---

## 1. What it is

**A Hermes messaging-platform plugin called "Stoke", and a Hermes tab in Stoke.** The plugin is a
small Python folder in this repo, `integrations/hermes-platform/`, that Hermes installs with its
own `hermes plugins install`. Once it is installed and enabled, `hermes gateway setup` lists
**🔥 Stoke** beside Telegram, Discord and Slack. Hermes then talks to you in a tab in Stoke, with
its messages, approval buttons, questions and model picker.

One plugin and one tab, over two transports, in this order:

1. **Slice 1: Hermes on this Mac ↔ Stoke on this Mac**, over a private Unix socket. No network
   port, paired once with a six-digit code. Useful on its own and needs no hub change.
2. **Slice 2: Hermes on the NUC ↔ your Stoke account**, through the Stoke Hub, end-to-end
   encrypted, so every signed-in computer and the account website show the same conversation.
3. **Slice 3: the phone.** Stoke's own phone UI gets a chat screen.

Slice 1's inner messages (§4.3) and Stoke's tab are written so slices 2 and 3 need no change to
them. Only the transport under them changes.

**What Hermes can and cannot do through it.** The plugin is a platform, not a tool, and Hermes's
agent cannot message a platform on its own: `send_message` was removed as an agent tool on
2026-06-17 (#47856) and is absent at T, H and U, and Hermes's guide forbids a plugin from adding
one. So Stoke gets exactly these:
- **replies** in a conversation you started from the Stoke tab;
- **cron jobs** with `deliver=stoke`;
- **`hermes send --to stoke "…"`** from any shell;
- **the cards**: approval, question, confirm, the model picker and one-tap choices.

It does not get "Hermes, tell me on Stoke when X", asked from Telegram or another session.

**What Hermes gets in Stoke:** show and edit its own messages and cards in its own tab, show that
it is typing, and raise a notification. Nothing else (§6).

---

## 2. What you do (slice 1)

**In Stoke**
1. Settings › Plugins › **Hermes**. It is one of Stoke's built-in plugins, already there and off,
   the way Work is: it has no Install or Remove button, only its switch, **Let Hermes message me
   here**. (A generic "Install disabled" beside the word Hermes would read as the Install button the
   owner ruled out, so the row never shows one.) Turning it on installs nothing into Hermes, and
   the panel says so.
2. The panel shows two commands, each with a **Copy command** button. Stoke runs neither.

**In any terminal (Hermes's side)**
3. `hermes plugins install realvinn/stoke/integrations/hermes-platform --ref <sha>`. The `--ref`
   is a commit this build of Stoke names (§5.7). Hermes says the source is custom (not from its
   catalog), runs its own security scan, and asks "Enable 'stoke-platform' now? [y/N]". Answer
   **y**.
4. `hermes gateway setup`. Pick **🔥 Stoke**. Hermes prints a six-digit code, and Stoke shows a
   strip with a code: "Hermes on this Mac wants to message you here." Press **Allow** only if the
   two codes match.
5. Hermes saves its settings and prints "🔥 Stoke configured!". It offers to restart the gateway:
   answer **Yes**.
6. A **Hermes · this Mac** tab opens in Stoke (the Allow press opens it). Replies, cron jobs with
   `deliver=stoke` and `hermes send --to stoke "…"` land there.

**Optional:** replies stream in place only with Hermes's `streaming.enabled: true`, which is off by
default at T, H and U and which no plugin can turn on. The panel shows
`hermes config set streaming.enabled true` as a third command to copy.

**Re-running setup** for the same Hermes keeps its tab and conversation (§4.4). A second Hermes
profile pairs as a second tab.

---

## 3. The Hermes side: the plugin

### 3.1 Versions and imports

- **Hermes ≥ 0.21.5** (`requires_hermes: ">=0.21.5"`), tested at T and U on every change, and at
  the newest release on CI's weekly schedule.
- **Python 3.11 to 3.14.** T runs on 3.11 to 3.13 and H and U on 3.14, so the plugin parses on
  3.11 (no PEP 695 syntax, no 3.12 f-string nesting) and uses `asyncio.get_running_loop()` only.
  It needs nothing outside the standard library and `cryptography`, a core Hermes dependency in
  all three.
- **Import only names that exist under the same name at T, H and U.** The compatibility re-export
  layer for old paths was removed in v0.21.6 (#126164, merged 2026-09-28); a plugin importing an
  old path no longer loads. The safe set is listed in the plan's Global Constraints. Two of them
  are private at U (`tools.slash_confirm.resolve` and `hermes_cli.setup.print_header`): U's
  validator warns, it does not refuse, and a contract test pins each. Setup reads and writes `.env`
  through `hermes_cli.config`, which is public, not through IRC's re-exports in `hermes_cli.setup`,
  and asks its own "pair again?" question rather than import IRC's private `declines_reconfigure`.

### 3.2 The manifest and the registration

- **Manifest:** `name: stoke-platform`, `kind: platform`, `label: Stoke`, `version: 0.1.0`,
  `license: MIT`, `requires_hermes: ">=0.21.5"`, no `manifest_version`. Every Stoke variable is
  under `optional_env`, never `requires_env` (which makes the install prompt for it):
  `STOKE_CHANNEL_KEY` (Hermes's private key, `password: true`), `STOKE_PEER_KEY` (Stoke's public
  key, pinned at pairing), `STOKE_ALLOWED_USERS`, `STOKE_HOME_CHANNEL`, `STOKE_HOME_CHANNEL_NAME`
  and `STOKE_SOCKET_PATH`.
- **`register(ctx)`** calls `ctx.register_platform(...)` with **only the 26 `PlatformEntry` fields
  the T tag has.** An unknown keyword is a `TypeError` inside `register()`, and the plugin then
  silently fails to load. Newer fields are added only when `dataclasses.fields(PlatformEntry)` names
  them: `display_tier="high"` (H, U), `allowlist_suppresses_pairing=True`, `config_connected_fn`,
  `dashboard_label`, `dashboard_description` and `docs_url` (U). Never `trusted_inbound` ("never
  set it for a chat platform"), `allow_all_env` or `shared_env_prefixes`.
- **What it registers:** platform `stoke`, label `Stoke`, emoji 🔥; `check_fn` (passive:
  `cryptography` importable, not Windows); `validate_config` (true whenever paired, even while
  Stoke is closed, or the runner drops the platform); **`is_connected`** (the wizard's
  "configured" and the gateway's enable pass both use it; without it the platform is enabled and
  listed as configured before pairing); **`env_enablement_fn`** (seeds `extra` and the **home
  channel** from the pairing); `setup_fn` (pairing, §4.4); `cron_deliver_env_var="STOKE_HOME_CHANNEL"`;
  `standalone_sender_fn` (`hermes send` and cron outside the gateway); `parse_target_ref_fn`;
  `allowed_users_env="STOKE_ALLOWED_USERS"`; `required_env=["STOKE_CHANNEL_KEY"]`;
  `max_message_length=16000`; `pii_safe=False`; `allow_update_command=False` (so `/update` typed in
  Stoke cannot make Hermes update itself); a `platform_hint` saying how Stoke renders replies.
- **Secrets.** The key is declared twice, in `optional_env` with `password: true` and in
  `required_env`, which is what H and U read to strip it from the agent's child processes. At T
  nothing strips it (#125755 is not in T), so a command the agent runs inherits it there. Read every
  value with `get_scoped_secret`, never `os.getenv`: profile multiplexing is on by default since
  #112854, which is inside T. Whatever the version, any command the agent runs can read
  `$HERMES_HOME/.env`; it runs as the same user.

### 3.3 The adapter

- **Subclasses `BasePlatformAdapter`** and overrides only methods whose signatures are identical
  at T, H and U (28 are): `connect`, `disconnect`, `send`, `get_chat_info`, `edit_message`,
  `delete_message`, `send_typing`, `stop_typing`, `send_image_file`, `send_document`,
  `_send_exec_approval_prompt` (overriding it is what turns cards on), `send_clarify`,
  `send_slash_confirm`, plus `send_model_picker`, `send_choice_picker` and `retire_clarify_card`,
  which the runner looks up by name. **Never `send_exec_approval`**: its default changed after T.
- **`MAX_MESSAGE_LENGTH = 16000`** on the class and in the registry. A longer text is split at line
  breaks into pieces of at most 64 KiB of UTF-8, never refused.
- **Inbound.** Text typed in Stoke becomes a `MessageEvent` built through `build_source(chat_id=
  "main", chat_type="dm", user_id=<owner id>)`. The owner id is `stoke-` plus the first 16 hex of
  SHA-256 over Stoke's public key, and pairing writes the same value to `STOKE_ALLOWED_USERS`, so
  Hermes's own allowlist admits exactly the Stoke that proved that key. Text starting with `/` is a
  gateway command (`/model`, `/new`, `/approve`, …). Inbound ids go through a
  `MessageDeduplicator`, which the runner carries into a rebuilt adapter.
- **The model picker never raises.** Its call site catches nothing; on failure it returns
  `SendResult(success=False)` so Hermes falls back to its text listing.

### 3.4 While Stoke is closed

"Closed" means Stoke has quit, its window is closed (on macOS the app stays up), or its Hermes
plugin is off. In all three the socket is gone: `ENOENT` after a clean quit, `ECONNREFUSED` after a
crash.

- **Every send returns `SendResult(success=False, error="send_path_degraded", retryable=True)`.**
  Telegram and Discord return the same on a dead transport. Hermes's delivery ledger (on by
  default) treats that exact error as "only a reconnect may retry", and `_send_retry_is_final` is
  overridden to say so, which skips two pointless retries.
- **The adapter stays installed and degraded** (Telegram's pattern): `_mark_degraded()`, and its
  own reconnect loop, 1 s doubling to 30 s with ±20 % jitter. A gateway that starts with Stoke closed
  connects degraded, not failed, so cron keeps working.
- **When Stoke reappears after a send was refused,** the adapter reports a retryable fatal error
  once, so the runner builds a fresh adapter within about 10 s and sweeps the ledger
  (`_install_reconnected_adapter`, present at T, H and U). With nothing missed, it reconnects in
  place.
- **What that buys, per version:** a reply that failed is redelivered after Stoke reopens, prefixed
  by Hermes's own "♻️ Recovered reply … this may be a duplicate" line, which Stoke shows as it is.
  Cron text due while Stoke was closed is queued for that reconnect at H and U (#125363);
  **at T it is only logged under `delivery_errors`.** Attachments are never queued. `hermes send`
  while Stoke is closed fails at once with "Stoke is not open". All of this is UNVERIFIED end to end
  until the plan's last task runs it.
- **Stoke not knowing this Hermes** (forgotten in Stoke) or **Stoke's key not matching the pinned
  one** (Stoke's data was wiped, or something else holds the socket) is a non-retryable error that
  says to pair again with `hermes gateway setup`.

---

## 4. The wire

### 4.1 Framing (slice 1)

A Unix stream socket. Each frame is one UTF-8 JSON object on one line, ending `\n`, at most
**512 KiB** with the newline. Senders refuse to write a longer line; Stoke discards one through the
next newline and counts a strike. Three strikes (an oversize line, invalid UTF-8, a line that is
not a JSON object) close the connection. Every validator rebuilds a frame from the keys it names
and drops the rest.

### 4.2 The handshake: mutual authentication

Stoke and each Hermes hold an Ed25519 key. Stoke's private key is sealed on disk (§5.2); Hermes's
is `STOKE_CHANNEL_KEY` in its `.env`. Each pins the other's public key at pairing. Signed texts are
`label`, a newline, then canonical JSON (keys sorted, no whitespace, ASCII strings only), the hub's
`labelled` shape under labels of their own, `stoke-channel/v1/*`, never a hub label.

1. On accept, Stoke sends `hello {v:1, stoke, nonce, app}`: its public key, 32 random bytes and its
   version.
2. **The plugin refuses unless `stoke` equals its pinned `STOKE_PEER_KEY`, and then sends nothing
   at all.** A process holding the socket path while Stoke is closed learns nothing, not even
   Hermes's public key.
3. The plugin sends `auth {v:1, hermes, nonce, role, sig, agent, plugin}`, where `sig` signs
   `stoke-channel/v1/auth` over both keys, both nonces and the role. `role` is `live` (the
   gateway's adapter) or `send` (one `hermes send` or cron delivery outside the gateway).
4. **Stoke refuses unless `hermes` is a pinned peer and `sig` verifies, and then writes nothing
   more** and destroys the socket.
5. Stoke sends `ok {v:1, peer, sig}`, signed over `stoke-channel/v1/ok`. The plugin verifies it
   with the pinned key: only the holder of Stoke's private key can sign it.

Nothing else is read before step 5. A connection that has not authenticated within **5 s** is
destroyed with no further byte. One `live` connection per peer (a newer one replaces the older,
which is how a rebuilt adapter takes over) and up to four `send` connections, which get no frames
but acks.

### 4.3 Inner frames, version 1

These are what every transport carries; slice 2 seals the same frames into the hub. Each has
`v: 1`, a type `t`, an `id` (8 to 64 of `A-Za-z0-9_-`, unique per sender) and `chat`. Slice 1 has
one chat per paired Hermes, `"main"`; a frame for any other chat is refused. A frame whose `v` is
not 1 is refused with `version`, which is the handshake slice 2 or a later plugin can build on.

**Hermes → Stoke**

| `t` | Fields | Stoke does |
|---|---|---|
| `message` | `text` (≤ 64 KiB), `kind` `reply`\|`status`, `replyTo?`, `at` | adds a message; `status` (Hermes's mid-turn sends) draws as a small grey line |
| `edit` | `target`, `text`, `final?` | replaces that entry's text; an edit of a CARD retires it: shows the text, no buttons |
| `delete` | `target` | removes the entry |
| `typing` | `on` | "Hermes is typing…" until `on:false` or 8 s without a refresh; not stored, not acked |
| `media` | `part`, `parts`, `mime`, `name`, `bytes`, `data` (base64, ≤ 192 KiB raw per part), `caption?` on part 0 | joins the parts (≤ 10 MiB), checks the length, stores the file, adds an image or file entry; the entry's id is the frame `id`, shared by every part |
| `approval` | `text`, `command`, `reason`, `session`, `actions` (1 to 4 of `{label, choice: once\|session\|always\|deny, style}`) | an approval card |
| `clarify` | `text`, `choices` (0 to 12), `other` | a question card |
| `confirm` | `title`, `text`, `actions` (`once`\|`always`\|`cancel`) | a confirm card |
| `choices` | `title`, `options` (1 to 50 of `{value, label, current}`) | a one-tap list (`/reasoning`, `/fast`) |
| `models` | `current {model, provider}`, `providers` (≤ 64 of `{slug, name, current, models ≤ 500}`) | the model picker card |
| `retire` | `target`, `text?` | closes a card with Hermes's own notice |
| `status` | `model?`, `provider?` | the header's model chip |

**Stoke → Hermes**

| `t` | Fields | The plugin does |
|---|---|---|
| `text` | `text` (≤ 32 768 characters, the composer's cap), `replyTo?` | a `MessageEvent` to `handle_message` |
| `media` | as above | caches the file (`cache_image_from_bytes` / `cache_document_from_bytes`) and sends a `MessageEvent` with `media_urls` |
| `answer` | `card`, `choice`, `provider?` (the model picker's) | resolves the card (§5.5) |

**Both ways:** `ack {id, part?, ok, code?, result?}`. Stoke acks a Hermes frame only after it is
written to disk (**persist, then acknowledge**), so a crash mid-write leaves it unacknowledged and
the ledger redelivers it. Refusal codes: `invalid`, `version`, `unknown-type`, `unknown-chat`,
`unknown-target`, `too-large`, `rate`. The plugin maps a refusal to a non-retryable `SendResult`,
after which Hermes sends its plain-text fallback; `rate` is retryable after 1 s. An answer's ack
carries `result: done | expired`. A frame id Stoke already holds is acked again and applied once, so
a resend repeats nothing. Read receipts stay inside Stoke and never reach Hermes.

### 4.4 Pairing

Numeric comparison with a commitment, the shape of the hub's own pairing, so a process that is not
the wizard the person is watching cannot fix a matching code:

1. The wizard asks what to call this Hermes in Stoke ("Hermes" by default, so a second profile can
   be told apart), makes a fresh key and sends `pair-commit {v:1, commit, label}`, the commit being
   SHA-256 over `stoke-channel/v1/pair-commit` with its key and a nonce.
2. Stoke answers `pair-nonce {pair, nonce}`, or `pair-refused {reason}` (`busy`: one pairing at a
   time; `limit`: three failed pairings in the last hour).
3. The wizard reveals `pair-reveal {hermes, nonce, replaces?}`. Stoke checks the commitment; a
   reveal that does not match it is refused (`mismatch`) and counts as a failed pairing.
4. Both compute six digits from SHA-256 over `stoke-channel/v1/pair-sas` with both keys, both
   nonces and the pair id (`sasDigits`: the first four bytes, mod 10^6, shown `482 915`). Stoke
   shows its strip; the wizard prints its own code. Neither sends the code.
5. **Allow** in Stoke sends `pair-ok {peer, chat, sig}` signed by Stoke's key; the wizard checks it
   against the key in `hello` (pinned from then on; a substituted key shows a different code) and
   saves `STOKE_CHANNEL_KEY`, `STOKE_PEER_KEY`, `STOKE_ALLOWED_USERS`, `STOKE_HOME_CHANNEL=main` and
   `STOKE_HOME_CHANNEL_NAME=Stoke`. **Deny**, five minutes passing, or the wizard going away ends
   it with `pair-refused`, and Stoke's strip goes.

**Pairing again.** When the wizard finds an existing `STOKE_CHANNEL_KEY`, the reveal carries
`replaces {hermes: <old key>, sig}`, signed by the OLD key over `stoke-channel/v1/replace` with
Stoke's, the old and the new key. Stoke verifies it against its pinned peer, says "paired again;
Allow keeps its conversation", and on Allow moves that peer to the new key: same tab, same
conversation, and the old key refused from then on. Without a proof it is a new peer.

---

## 5. The Stoke side

### 5.1 The listener

- **A Unix socket, never a TCP port.** The installed app (`app.isPackaged` and no
  `--user-data-dir`, the predicate that already guards `setAsDefaultProtocolClient`) listens at
  `~/.stoke/channel/stoke.sock`; `~/.stoke` is already the folder every Stoke on the machine
  shares. A dev build or a sandbox listens at `<userData>/channel/stoke.sock`, so it never meets
  the installed app; the plugin reaches one only through its own `STOKE_SOCKET_PATH`.
- **Path length:** refused past 100 bytes, with a sentence. Python on this Mac refuses 104 bytes;
  Node takes 104 (measured).
- **Modes:** the folder is 0700 (checked with `lstat`: a directory, not a link, ours, no group or
  other bits, else refused), and the socket is `chmod 0600` after `listen`, because `listen` makes
  it 0755 (measured).
- **A stale socket after a crash** answers `ECONNREFUSED`. Stoke unlinks it only when it is a
  socket, its own, and refusing. A live listener at the path, a file, a link or anything not ours
  is left alone, and the panel says another program holds Stoke's channel socket.
- **It follows the window,** like the phone server: it starts once the Hermes plugin is enabled,
  the secret store has opened and a window exists, and stops when the plugin is turned off (every
  socket dropped at once), the window closes, or Stoke quits. With no window there is nobody to
  answer a card, and Hermes's own ledger holds the text instead.
- **Off on Windows** (Python's asyncio has no Unix socket there), with a sentence in the panel.

### 5.2 Keys and pairings

- **Stoke's key** is `<userData>/channel/channel-key.json`, the shape of `hub-device.json`: the
  public half in clear, the private half sealed with `safeStorage`, 0600. It is read only after
  the secret store has opened. **A file that exists but will not open is never minted over**:
  every Hermes pinned the old public key, so the channel stays off with a sentence until it opens.
  Only a missing file mints.
- **Paired Hermes** are `<userData>/channel/peers.json`: public keys, labels, when paired, last
  seen, and what each reported (Hermes's version, the plugin's). Never in settings.json, which
  reaches the renderer, the setup export and hub sync. A pairing is this computer's consent.

### 5.3 The conversation

- **One store per paired Hermes** under `<userData>/channel/<peer>/`: an append-only log replayed
  at load (a torn last line is ignored), compacted past 8 MiB, the newest 2,000 entries and
  200 MiB of files kept, the oldest dropped first.
- **Persist, then acknowledge** (§4.3), so a reconnect repeats nothing.
- **Your own messages** are stored too, as sending, sent or failed. Stoke has no outbox: while
  Hermes is not connected the composer says so and sends nothing.

### 5.4 The tab

- **A new tab kind, `channel`,** beside `grok-bot`, with a binding `{ peerId, label, draft }`. It
  is a hard-wired built-in, because plugin API v1 cannot add a tab kind. It has no folder, no
  terminal and no agent mark; every reader of `tab.cwd` and every kind switch learns it (gotcha
  150). It is stored for restore with `cwd: ''`, so an older Stoke drops it rather than resume a
  `claude` in nowhere.
- **One tab per paired Hermes:** "Hermes · this Mac", later "Hermes · protech-nuc". It opens only on
  your act: the Allow press, a notification click, the Launcher row, or the panel's Open. Opening
  goes through `chatOpenPlan`: an existing tab is gone to, never duplicated.
- **Pushed, not polled** (Grok Bot polls every 6 s), and **restored** after a restart from the store.
- **Messages** render through Grok Bot's safe Markdown, extracted to a shared component: no HTML,
  only http(s) links, opened on a click; a Markdown image is text. Replies stream in place.
- **Images and files from Hermes** are stored in Stoke's folder and shown through the existing
  `stoke-asset` scheme under a host of their own, which serves a bare file name only (the
  wallpaper's rule); no remote image is ever loaded. A file shows its name and size with
  **Save…**. An image or file you drop or attach reaches Hermes as `media_urls`.
- **Unread:** the tab's activity dot is `done` ("New message from Hermes") for an unread message
  and `waiting` ("Hermes needs you") while a card is open. Looking marks it read.
- **Header:** the label, the model chip (from the last `status` or picker; a click sends `/model`)
  and Connected / Not connected.

### 5.5 Cards

- **Approval:** Hermes's own text (the command already redacted by Hermes, the reason and its
  "doing nothing means it will NOT run" line), Hermes's own buttons, labelled "written by
  Hermes". A tap calls `resolve_gateway_approval(session_key, choice)`, as Telegram does.
- **A tap resolves the session's OLDEST pending approval**, whatever card it was on (the resolver
  takes no request id that `ExecApprovalPrompt` carries). So **only the oldest open approval card
  of a session can be answered**; a later one says to answer the earlier first.
- **Question:** Hermes's choices plus **Other…**; after Other, your next message is the answer.
  **Confirm:** Once / Always / Cancel. **Choices** and **models:** one tap.
- **Each card is answered once.** Main claims it before the first await. A written answer with no
  ack within 10 s is "Stoke could not confirm Hermes got this", never answerable again (a second
  tap could resolve the next approval). An answer to a card Hermes no longer has comes back
  `expired`.
- **Stoke never answers a card by itself.** Hermes's timeouts decide: `approvals.timeout` is 300 s
  by default, and doing nothing is a deny. When Hermes retires a card (its timeout edit, or a
  question's `retire_clarify_card`), Stoke shows Hermes's text with no buttons.
- **The 15-second card budget.** Hermes's runner waits 15 s for a card's send and then counts it as
  possibly delivered, sending no text fallback. Locally the ack takes milliseconds; slice 2 must
  answer locally too.

### 5.6 Notifications

- Renderer only, like every Stoke notification, so none without a window.
- **A new message:** titled with the tab's label, the body its first line (Markdown marks removed,
  at most 120 characters). **A card:** "Hermes needs you", never the command. Notification Center
  keeps what it is shown, which the owner accepted with this design.
- They follow Settings › Sessions' notification mode (off, background, always); at most one per
  Hermes every 10 s, a repeat replacing the last; a click focuses Stoke and opens the tab. An
  incoming message or card never moves focus.

### 5.7 Settings › Plugins › Hermes

- **The switch** is the built-in plugin's own Enabled checkbox; the plugin is off until you tick it,
  and nothing listens before then.
- **The commands, as text with Copy command buttons:** the install command with this build's
  `--ref`, `hermes gateway setup`, and the optional streaming line. The `--ref` is a reviewed
  constant naming a commit that already holds the plugin (a commit cannot name its own hash).
  Stoke cannot know whether the plugin is installed, so until a Hermes pairs the panel says
  "Waiting for a Hermes to pair".
- **Paired Hermes:** each with Connected or last seen, what it reported ("Hermes Agent 0.21.5 ·
  plugin 0.1.0"), **Open** and **Forget…** (its conversation here is deleted; Hermes keeps its
  own copy).
- **Updates:** a pin is sticky in Hermes, so when a paired plugin reports a version older than this
  build expects, the panel shows the update command (`… --ref <new> --force`, then
  `hermes gateway restart`) as text.
- **The boundary, in one line** (§6).

---

## 6. Security, stated honestly

**Off by default.** Nothing listens until the plugin is enabled, and slice 1 opens no TCP port at
all; slice 2 adds no listener (both ends dial out to the hub).

**What is kept out:**
- **Other users and web pages**: the socket is in a 0700 folder and is not on the network.
- **The docked browser and its pages**: every channel IPC handler is behind `appFrame`, which takes
  only an app window's main frame.
- **The phone and the browser MCP server**: neither has a route or a tool for the channel.
- **Claude tabs and other agents in Stoke**: nothing exposes the composer, so an injected page or
  agent cannot type to Hermes through Stoke.

**What is not kept out, and is not claimed:** any process running as you on this Mac. It can read
`~/.hermes/.env`, which holds Hermes's key, and impersonate Hermes to Stoke; it can bind the
socket path while Stoke is closed; and it can run `hermes -z` directly, where Hermes's approvals are
bypassed. Mutual authentication makes an impostor fail loudly (the plugin refuses a Stoke whose key
is not the pinned one), but it is not a boundary against your own processes, and the panel says
so: "Only you, typing in this tab, reach Hermes from Stoke: not the docked browser, not your phone.
Programs on this Mac running as you can reach Hermes directly."

**What Hermes can make Stoke do:** add, edit and remove its own entries and cards in its own tab,
show typing, and raise one notification at a time, under the caps and rate limits in §4 and the
plan's Global Constraints. It cannot open, focus or close a tab, type into a terminal, read a file,
load a remote URL, use the browser or change a setting. A frame of any other type is refused.

**Approvals:** Stoke never answers one by itself, and doing nothing is a deny.

**Hermes's own gate:** the plugin loads only after your **y** (or `plugins.enabled`), installs
pinned to an exact commit, and passes Hermes's own install scan (`dangerous` blocks it outright,
`caution` asks "Install anyway?"); the plan keeps the scan's patterns out of the folder.

---

## 7. Mockups

**Stoke's Hermes tab**

```
 ┌──────────────────────────────────────────────────────────┐
 │ claude · stoke  |  Hermes · this Mac (*)  |  +           │
 ├──────────────────────────────────────────────────────────┤
 │ Hermes · this Mac      [ model: sonnet-x ]   Connected   │
 │                                                          │
 │ Hermes  07:00                                            │
 │ Morning brief                                            │
 │  - 3 PRs wait on you in realvinn/stoke                   │
 │  - NUC disk is 81% full                                  │
 │                                                          │
 │                                          You  07:42      │
 │                  clean up old docker images on the NUC   │
 │                                                          │
 │ Hermes  07:42                                            │
 │  ⚙ terminal: docker image ls                             │
 │ ┌─ Hermes wants to run a command ──────────────────────┐ │
 │ │ docker image prune -a --filter "until=720h"          │ │
 │ │ Why it was flagged: deletes images                   │ │
 │ │ Doing nothing means it will NOT run.                 │ │
 │ │ [Allow once] [This session] [Always] [Deny]          │ │
 │ └─ written by Hermes ──────────────────────────────────┘ │
 │ ┌─ Hermes asks ────────────────────────────────────────┐ │
 │ │ Keep images newer than 30 days?                      │ │
 │ │ [ Yes ]   [ No ]   [ Other... ]                      │ │
 │ └──────────────────────────────────────────────────────┘ │
 │ Hermes is typing...                                      │
 ├──────────────────────────────────────────────────────────┤
 │ Message Hermes...                    [+]   Cmd+Enter     │
 └──────────────────────────────────────────────────────────┘
```

**Settings › Plugins › Hermes, and the pairing strip**

```
 ┌──────────────────────────────────────────────────────────┐
 │ ← All plugins   [x] Enabled   Export…   Remove           │
 ├──────────────────────────────────────────────────────────┤
 │ Hermes                                                   │
 │ Talk to Hermes here, the way you would in Telegram.      │
 │ It can send you messages and questions. Nothing else.    │
 │ Stoke runs and reads nothing of Hermes's: you add the    │
 │ plugin on the Hermes side.                               │
 │                                                          │
 │ Listening on this Mac.                                   │
 │                                                          │
 │ 1. Add Stoke's plugin to Hermes, in any terminal:        │
 │    hermes plugins install realvinn/stoke/integrations/   │
 │      hermes-platform --ref 4f2c…e91a   [Copy command]    │
 │    Hermes calls it a custom source and asks to enable    │
 │    it: answer y.                                         │
 │ 2. Run Hermes's setup and pick 🔥 Stoke:                 │
 │    hermes gateway setup                [Copy command]    │
 │ 3. Optional, to see replies as Hermes writes them:       │
 │    hermes config set streaming.enabled true  [Copy …]    │
 │                                                          │
 │ Paired                                                   │
 │  Hermes · this Mac   Connected                           │
 │  Hermes Agent 0.21.5 · plugin 0.1.0     [Open] [Forget…] │
 │                                                          │
 │ Only you, typing in this tab, reach Hermes from Stoke:   │
 │ not the docked browser, not your phone. Programs on this │
 │ Mac running as you can reach Hermes directly.            │
 └──────────────────────────────────────────────────────────┘

 (the strip, above the terminal, while a pairing waits)
 ┌──────────────────────────────────────────────────────────┐
 │ Hermes on this Mac wants to message you here.            │
 │ Code 482 915. Allow only if Hermes shows the same code   │
 │ right now.                              [Allow] [Deny]   │
 └──────────────────────────────────────────────────────────┘
```

**The Hermes setup step (slice 1).** The banner, the menu line format and the restart question
are Hermes's own; "Stoke Setup" is what the plugin's `setup_fn` prints. The menu order is
illustrative (Hermes draws a curses menu).

```
 $ hermes gateway setup

 Messaging Platforms
 Select a platform to configure:
     💬 Mattermost  (not configured)
     ...
     💬 Telegram  (not configured)
   > 🔥 Stoke  (not configured)
     Done

   ─── 🔥 Stoke Setup ───
   Name this Hermes in Stoke [Hermes]:
   Found Stoke 1.0.0-beta.22 on this computer.
   Stoke now shows a request. Check it shows:

         482 915

   Waiting for Allow in Stoke...  allowed.
   Saved Stoke's settings for this Hermes in ~/.hermes/.env
   🔥 Stoke configured!

 Select a platform to configure:
     🔥 Stoke  (configured)
   > Done

   Restart the gateway to pick up changes?
   > Yes
     No
```

**Slice 2's step on the NUC** (its plan finalises it): the plugin then also asks "Which Stoke
should Hermes talk to?", offering "My Stoke account (Hermes is on another computer)", asks for the
hub address and prints one line of public keys to paste into Stoke on any of your computers.

---

## 8. Slices

Sizes are rough. Re-sized against Grok Bot, which is polled with no streaming, cards, restore or
phone and is still 2.3k lines in its own files (critique K7).

**Slice 1: Hermes on this Mac (about 5k lines with tests).** The plugin (`integrations/
hermes-platform/`), Stoke's listener, keys, pairing, store and service (`src/main/channels/`), the
pure rules (`src/shared/channel.ts`, `src/shared/channelView.ts`), IPC, the `channel` tab kind,
its workspace and cards, the Settings panel and the pairing strip. Proven by:
- `verify:hermes-channel`: a fake Hermes in Node over a real Unix socket in a scratch folder, every
  refusal shown red by mutating it out (gotcha 175), every timer overridable (gotcha 174);
- the plugin's own tests: a pure set against the plugin's fake Stoke (gating in CI), and a
  contract set against real Hermes clones at T and U (non-gating in CI);
- `hermes plugins validate` on the folder from a scratch `HERMES_HOME`;
- **an end-to-end run in a separate Hermes clone** with its own virtualenv, a scratch `HOME` and a
  `HERMES_HOME` that is NOT `$HOME/.hermes` (at T and H that home claims the owner's launchd label
  and plist), the gateway lock folder in scratch, a fake OpenAI-compatible model on 127.0.0.1, and
  the built Stoke sandboxed (`--user-data-dir`, `--use-mock-keychain`), driven over CDP with
  screenshots. Never the owner's `~/.hermes`, never a gateway lifecycle verb, never
  `docker compose up` of Hermes's shipped file (it mounts `~/.hermes`).

**Slice 2: the NUC through the hub (XL).** Read the NUC's `hermes --version` first: a real v0.21.5
lacks the cron queue and the child-process secret strip. The critique found what today's hub lacks,
and slice 2's spec must design each:
- **a session for a device with no caps.** The only route that mints a session for another device
  is the phone's, for caps exactly `['remote-guest']`, and it works only because the desktop puts
  the token and both private keys into the link. A messages-only identity with public keys only
  has no way in;
- **a disconnect** that refuses that session (no route lets one device end another's);
- mailbox routes a `caps: []` device may use, counted like `item_usage` against the 25 MiB cap and
  refused per put (gotcha 168);
- an agent key per epoch, wrapped for the account website;
- request signing with nonces and chain checks with the anchor rule, in Python;
- a route list narrower than the phone's (no `/v1/relays`), plus a host-side cap check, since a
  host takes a relay from any active device today;
- **weigh a credential scoped to one mailbox, outside the device list,** so unpairing the NUC's
  Hermes is not a revoke needing the Recovery Kit (untested idea);
- the risk that the NUC also hosts the hub: a prompt-injected command run by its Hermes runs beside
  `hub.db`.

On the NUC the person runs the two Hermes commands in any terminal they open (a Stoke SSH tab they
type into counts); Stoke never types them. Hermes's card budget (§5.5) means the hub transport
answers locally and queues.

**Slice 3: the phone (M).** A chat screen in Stoke's phone UI and a content-free push ("Hermes needs
you", "New message"), reusing `src/shared/channel.ts` and `channelView.ts` unchanged.

**Slice 4: upstream, with the owner's go at the time.** A catalog entry
(`plugin-catalog/stoke-platform.yaml`: repo `realvinn/stoke`, `subdir integrations/hermes-platform`,
a 40-hex `sha`, `category: platform`, a disclosure that it talks only to the Stoke app on this
computer or your own Stoke Hub), after which the panel's command becomes
`hermes plugins install stoke-platform`; and an optional upstream PR so the wizard shows an
installed but disabled platform and uses `plugin_name` to offer enabling it.

---

## 9. ACP and OpenClaw: parked

- **`hermes acp` is not this.** It starts a separate Hermes per client with a toolset that leaves
  out messaging delivery, cron management and `clarify`. (It does share Hermes's memory, identity,
  skills and providers; the first design said otherwise.) The platform plugin is the always-on
  Hermes.
- **Hermes as a terminal agent in Stoke is ruled out** by the hard rule: it would have Stoke run
  `hermes` (and detect it with `--version`).
- **ACP as one chat view for many agents** is a different feature with its own costs; the tab's
  message list and approval card are built so an ACP tab could reuse them.
- **OpenClaw** has the same kind of channel plugin, but its plugin APIs are experimental, it is not
  installed here, and it needs Node `>=24.22.1 <25 || >=26.12.1`. Stoke's side stays agent-neutral
  (no message names an agent), so an OpenClaw channel plugin could use the same socket later.
  Whether its A2A channel can push to Stoke unasked is UNVERIFIED.

---

## 10. UNVERIFIED, and what would prove it

- **Every runtime behaviour on Hermes's side** until the plan's last task runs it: the degraded
  lifecycle and the bounce, redelivery after a reconnect, the cron queue at H and U, the wizard's
  menu drawing and whether a running gateway picks up a newly enabled platform without the restart
  it offers.
- **The install scan's verdict on the real plugin** (`safe`, `caution` or `dangerous`), proven by
  `hermes plugins validate` at T and U.
- **A scratch-home gateway beside the owner's launchd one** with the plan's hermetic environment;
  read from code only (U fixed the bare-label trap; T and H need `HERMES_HOME` outside
  `$HOME/.hermes`).
- **Linux** (the socket and modes were measured on macOS only) and the NUC's Hermes version.
- **Hermes Desktop's Channels page** listing Stoke through U's `dashboard_*` fields.
- **Not designed:** Windows (no Unix socket for Python's asyncio; a later slice would need loopback
  with the same handshake), and slice 2's mailbox format and retention.
