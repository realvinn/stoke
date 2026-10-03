# Searching and reading chats from your other computers

**Status:** v1 being built, 2026-10-03. **Owner's ask:** "search and use other chats from other computers — make
that a switch — confirm to enable it on that computer (email, a master password, or re-entering the password)".

**Owner's decisions (2026-10-03, do not re-ask):**

1. **Confirm by re-entering the hub password** on the computer being shared. No email, no master password.
2. **Offline computers are skipped and nothing is stored.** Only online computers are searched, live. No chat
   text is synced through the hub or copied onto another computer.
3. **"Use" means read it here now, and continue it on the computer that has it LATER** (v2). Never copy a
   chat here to resume it.

Research behind this (the chat index map, the hub map, the options weighed): workflow `wf_a8b56d71-292`.
The short of it: whole transcripts cannot ride hub items (128 KiB each, 5,000 per account; `~/.claude/projects`
is 3.2 GB on the owner's Mac). Nothing sends email. Copying a transcript across macOS/Windows breaks on the
cwd-slugged folder and the cwd inside every record. The relay is already end to end encrypted and the hub
cannot read it, so a live search over it needs no hub change.

## The rules

- **Only the computer being searched may consent to it**, on its own screen, with the hub password typed
  there. Neither the hub nor a synced item nor another computer can switch it on (spec 2026-10-01 §1:
  the hub grants nothing). Switching it OFF is instant and needs no password.
- **The switch and the grants are local** to that computer (`LOCAL_KEYS`), never synced.
- **Nothing a guest reads is stored by the guest** beyond what its window shows (no cache on disk).
- **Everything that leaves a computer is redacted**, whatever that computer's own redaction setting says
  (secrets in chat text are the main risk of this feature), and names folders by their last segment only,
  never a full path.
- A session grant (gotcha 142's Allow once / Always for a remote TAB) never allows chats, and a chats grant
  never allows a session. Separate scopes, separate stored grants.

## v1 scope

### 1. Redaction hardening (chat index) — prerequisite

In `src/main/chatIndex/` (parse/scan/store/sources, whatever holds `cleanText` and `mergeMeta`):
- `mergeMeta`'s titles and first prompts taken from a tool's own listing go through `cleanText` too.
- New patterns, each with a `verify:chat-sources` case and a mutation shown red:
  - credential URLs (`scheme://user:pass@host`);
  - `password=`/`password:`/`passwd`/`pwd=` values;
  - `api_key=`/`apikey`/`api-key:` values;
  - JWTs (`eyJ…​.eyJ…​.…`);
  - Stripe (`sk_live_`/`rk_live_`/`sk_test_`), Notion (`secret_`/`ntn_`), ClickUp (`pk_` + digits), Cloudflare API
    tokens where a recognisable shape exists.

  Keep the existing patterns; measure false positives on this Mac's real index (read-only copy).
- Turning redaction ON re-cleans text already stored (or the store refuses to serve un-cleaned rows until a
  rebuild). The remote routes below always ask for cleaned text.
- **Rule set 3** (`REDACTION_VERSION` 3, review of db1ae51): a keyed literal is taken whole to the next
  space (a URL query's value to its `&`/`;`/`#`, a connection string's to its `;`), a dotted value is code
  only when every segment has a name's shape, and `Authorization:` values, AWS secret access keys, ASIA
  ids, `glpat-`/`hf_`/`npm_`/`whsec_` tokens and keyed `client_secret`/`token` values join the list. Rows
  cleaned under 2 count as not cleaned, so a guest finds them only once a pass re-cleans them
  (`recleanStale`). No rule may backtrack: the suite times 64 KB worst cases.
- **Rule set 4** (`REDACTION_VERSION` 4, re-review of 62b4ae6): keyed values inside escaped JSON, keyed
  `secret`/`*_SECRET`/`SECRET_KEY`/`PRIVATE_KEY`, a dotted `password=` value unless its last segment names
  the credential, `--password`/`--token`/`--api-key X`, `mysql -pX`, `curl -u user:pass`, Slack webhooks,
  Azure `AccountKey=`/`SharedAccessKey=`, Telegram bot tokens and upper-case `AUTHORIZATION:`; a value
  holding a template, a `YOUR…` placeholder or a credential's own name is left. A re-clean redacts a
  token-shaped last word a size cap cut. Shaping for the wire turns a control into a space (never deletes
  it), and `sharedChats`' second belt judges the shaped text, the bytes that leave (gotcha 156).
- **Rule set 5** (`REDACTION_VERSION` 5, review of 166e84f): an invisible character inside a word (zero-width
  space, soft hyphen, word joiner, BOM; joiners and direction marks only between ASCII characters) is dropped
  before any pattern judges, in `cleanText` and in the wire's shaping; a key split after its prefix by a line
  break or space is taken whole (`split-key`); Telegram's Bot API URL, PGP private key blocks, the password
  flags of `sshpass`/`redis-cli`/`docker login`/`openssl`/the mongo tools/`mysql --password=`, `vault login`,
  `--passphrase`, keyed `pass`/`DB_PASS`/`passphrase`, `SECRET_KEY_BASE`/`secret_access_key`, Groq, Google
  `GOCSPX-`/`ya29.`, Vault `hvs.`, Slack `xapp-`/`xoxe`, Discord webhooks, Azure SAS `sig=`, Laravel
  `APP_KEY`, `Authorization: Bot`, a cookie header's session values, `.pgpass` lines and PHP `print_r` join
  the list. A re-clean also redacts the cut word of a title at the first prompt's cap, and a raw first
  prompt (Cline's title, Codex's listing) is cut back to a space before it is cleaned.
- **Rule set 6** (`REDACTION_VERSION` 6, review of 10b0840): `dropInvisible` takes Unicode's whole
  Default_Ignorable_Code_Point set (the joiners, marks, variation selectors, fillers and tags still only
  between two ASCII characters), and a first prompt drops them before it folds spaces; `split-key` takes
  any Unicode space, an indented line break and a quoted reply's `> ` after a prefix; Telegram's token
  after `bot` with no slash and with its colon as `%3A`; and Cline's own title, cut by Cline at 119
  characters inside a word, has its cut word redacted (`toolCutTitle`; a re-clean, every Cline title
  ending in `…`).
- **The patterns stop there.** Five rule sets still let 44 of 46 fresh secret shapes through, and no list
  of providers ends; what leaves is caught by shape instead, on the share path only (§3).

### 2. The password check (hub + client)

- **Hub route `POST /v1/auth/verify`.** Auth level `active`, a signed request like any other. Body
  `{ password }`, checked against the account's `pw_hash` (`verifyPassword`, constant time). It has its OWN
  throttle per device (e.g. 5 failures / 15 min, doubling, capped), never the sign-in throttle, so wrong
  tries here cannot lock sign-in. It mints no session and changes nothing. Answers:
  - `{ ok: true }`;
  - `401 { error: 'wrong-password' }`;
  - `429 { error: 'throttled', retryAfterMs }`.

  Add it to `protocol.ts`'s route table, `hub/app.ts`, and `verify:hub-server` (right, wrong, the throttle
  window, pending device refused, sign-in counter unchanged by wrong tries, no session row minted). Check
  whether `worker/hub-edge.ts` must allow the path.
- **Client.**
  - `HubService.verifyPassword(password)` returns `ok | wrong | throttled(retryAfterMs) | unreachable | not-signed-in`.
  - The guard is claimed before the first await (gotcha 20). The password is never logged, never stored, and
    cleared from the renderer state after use.
  - One IPC `hub:verifyPassword` (`src/shared/ipc.ts` first) and preload.
- **UI.** `ConfirmPasswordSheet` (title "Confirm it's you", a password field, "Turn on" / "Cancel"). Errors:
  "That password didn't match." / "Too many tries. Try again in N min." / "Can't reach your hub."

### 3. Sharing and the relay (host and guest)

- **Settings, local only:**
  - `hub.shareChats: boolean`, default false;
  - `hub.chatGrants: Record<deviceId, 'always'>`;
  - "Allow once" lives in memory.

  Hydrate and clamp them; `LOCAL_KEYS` includes them. They are effective only while the chat index is on,
  its "Leave out anything that looks like an API key" is on, and the device is in the vault
  (`chatsShareBlock`). Redaction off is a PAUSE (review of db1ae51): chats stored then are raw, a guest
  searches only cleaned rows (gotcha 156), and it was told "Nothing on <Computer> says …" for a chat that
  is there while the host's row said On. So: no `chats: true`, every chats relay and question ended, the
  tick refused while it is off (`CHATS_REDACTION_BLOCK`), and the view's `chatsBlocked: 'redaction-off'`
  for the row's "Paused: …" (`CHATS_PAUSED_SENTENCE`).
- **Presence:** the sealed `RemoteStatus` gains `chats: true` while sharing is effective (no hub change).
- **Attach:** a guest opens `{ kind: 'chats' }` only to a computer advertising it. It gets its own scope
  (`RelayScope`), which allows exactly:
  - `GET /api/chats/search?q=<≤200 chars>&limit=<≤50>`, returning up to 50 hits
    `{ source, nativeId, title, folder (last path segment), updatedMs, role, snippet, ranges }`, from the
    host's own `ChatStore` search, redacted;
  - `GET /api/chats/open?source=&id=`: the chat as the viewer needs it (`viewer.ts`'s `openChat`), redacted,
    at most 4 MiB, never through `/api/transcript` (unredacted).
- **On every request the host re-checks** `shareChats`, the chat index and its redaction, the guest's place
  in the chain (by id AND key, gotcha 140) and the grant — before the handler runs and again after its
  await, refusing (never silently dropping) what it read.
- **A hidden folder's chat takes no place in an answer:** the index leaves it out before its limit, and
  `sharedChats` asks for `CHAT_HITS_MAX` and cuts to the guest's limit only after its own filters (with the
  limit first, `limit=1` answering nothing where `limit=2` answered one said a hidden chat ranked first).
  Folder names and the tools' ids go through the secret patterns too; a chat whose id they would change is
  not sent.
- **A generic net on the way out** (shared/keyShaped.ts, review of 10b0840): after the patterns, every
  title, snippet, message and folder name loses any run of token characters (`[A-Za-z0-9_+=-]`, so path
  segments, URL parts, dotted names and base64 pieces are judged one by one) that is 20 or longer and
  random by its changes of class — a stretch of 16+ that is not a name's words and numbers — or holds 32+
  hex; a git commit's 40 hex and a UUID stay, a `name=` before a taken value stays, a piece glued by `/`
  to a taken run goes with it, and a run against a snippet's cut `…` is judged as a part (8+). It runs
  over the index's whole text before the cut to shape and again over the bytes sent, and never on the
  local index or viewer: it takes ids and hashes too (`toolu_` ids, SHA-256s), which a shared view
  accepts losing. Measured on a read-only copy of this Mac's index (220 chats, 8,309 messages): 4.7% of
  messages touched, 0.28% of the text, 0.8% of the snippets of 80 frequent-word searches, no code.
- **A search that looks like a key is refused** before the index is asked (`keyShapedQuery`, code
  `query-key-shaped`): a word of 8+ with letters and digits that changes between them three times, or
  mixes case like a random string, or 16+ hex, or any run the net would take. The cleaned rows still hold
  every key no pattern knows, and FTS answers a prefix of one. A 7-character git short id is searchable; a
  longer prefix of one is not. A hit whose query word is marked only inside a run the net takes is left
  out (`matchedOnlyInKeys`).
- **Refusal codes** (`ChatsRefusalCode`, shared/hub/remote.ts, documented there): `not-sharing`,
  `history-off`, `redaction-off`, `denied`, `no-answer`, `revoked`, `busy`, `not-a-device`, `not-in-vault`,
  `disconnected`, and per search `query-key-shaped` ("That search looks like a key or a code — search
  <Computer> with words instead."). The host sends the code with a fallback sentence for an older guest; the guest words the
  code itself (`chatsRefusalSentence`), and its results and peers carry it (`code`) for the renderer.
- **Grants:**
  - A guest with no grant raises a question on the host: Allow once / Always / Deny, the existing question
    machinery under a chats prompt.
  - The devices ticked when the switch is turned on are granted `always` at once.
  - Removing a device ends its grant (`chainChanged`).
  - Remove beside a device ends its live chats relays at once (`revokeChatGrant`), refused as `revoked`.
  - Turning the switch off closes every chats relay.
  - A password check that comes back after its sheet was cancelled, or after sign-out, records no consent
    (`HubService.cancelVerify`, called by `ConfirmPasswordSheet` whenever it goes without using its yes).
- **Serving:** only on the relay instance of the remote server, never the phone's (`RemoteServer` backs
  both; gotcha 111's per-call deps).
- **Guest side:**
  - `HubRemote.searchChats(q)` fans out to every online computer advertising chats. It keeps one chats
    relay per host open while the search box is in use, and closes it after idle.
  - It returns per-computer results or a state: `offline` / `not-sharing` / `waiting` (the host is
    asking) / `denied` / `error`.
  - `openRemoteChat(device, source, nativeId)`.
  - IPCs in `ipc.ts` first.

### 4. The renderer

- **Settings › Account & sync**, beside "Share sessions" as a separate tick:
  - The row reads "Let my other computers search this computer's chat history".
  - When off: "Off. Other computers can't see chats on this one."
  - It is disabled with the reason when chat history is off ("Turn on Chat history first."), its redaction
    is off ("Turn on “Leave out anything that looks like an API key” in Chat history first.") or the device
    is not signed in ("Sign in to Stoke Hub first.").
  - On while redaction is off: "Paused: turn on “Leave out anything that looks like an API key” in Chat
    history to share it." (`chatsBlocked === 'redaction-off'`).
  - Turning it on opens `ConfirmPasswordSheet`, then a list of the other active devices (name + fingerprint),
    ticked, then "Turn on".
  - When on: "On. <devices> can search and read, but not change, chats on this computer. Secrets are
    redacted; folders show by name." Each device has a Remove.
  - Turning it off is instant: "Stopped. Searches from other computers were closed."
  - A `data-setting` mark plus a `SETTING_ROWS` entry (gotcha 138).
- **Sidebar search "In conversations":** adds an "On <computer>" group per sharing computer, grouped by
  computer and never merged by score. **Only a computer that shares gets a group** (review of db1ae51:
  every other device in the vault used to get "isn't sharing chat history" on every search). Which ones
  share is what this window has seen them say (`chatSharersStep`): one seen saying `chats: true` keeps its
  group while offline, and loses it at once when seen online saying it stopped. With no sharer, nothing is
  asked of main at all. States:
  - "<Computer> is offline — not searched" (only one that was sharing when last seen)
  - "Waiting for <Computer> to allow…"
  - a refusal or failure, worded here by its code (`chatsRefusalSentence`) with this computer's name for it
  - "Nothing on <Computer> says “<query>”."

  "isn't sharing" is no longer a state the sidebar shows. Each answer keeps the query it answered: a group
  from an older query is drawn dimmed as pending ("searching…") and quotes its own query, and a computer
  starting or stopping sharing, or going offline or coming back while sharing, asks the search again.
- **Opening a remote hit** shows the read-only `ChatViewer` with a header "On <Computer> · <folder name>".
  There is no Resume button, and Copy works. A failed read says why in the viewer's own words ("<Computer>
  is offline — open it again when it's back."; a refusal by its code), offers "Try again", and reads again
  by itself once that computer's chats relay comes open after not being open since the read began (its
  owner allowed it: `remoteReadWatch`); a read that failed while the relay stayed open waits for "Try
  again", so it never loops. Clicking the same hit again reads it again.

### Later (not v1)

- "Ask <Computer>": a request strip on the other computer that opens its password sheet.
- "Continue on <Computer>" (U2): a one-shot resume scope on the host, its own question there, then the
  existing remote tab.
- An email notice after sharing is turned on.

### Never

- Copying a chat here to resume it.
- Syncing chat text through the hub.

## Verification

- Each suite named above holds its rule, and each rule is mutated back to red.
- Driven end to end with two sandbox Stokes and a local hub server (the `verify:hub-server` rig), with
  synthetic chats only, never the owner's (gotcha 133):
  - A's switch, after a wrong password, then the right one;
  - B searching A;
  - A offline;
  - A switched off mid-search;
  - a removed device;
  - a session grant that does not open chats;
  - a secret in A's chat that never reaches B.
- **The hub on the NUC needs the new route deployed** before the switch works against the owner's real hub.
  That is a manual step with the owner (their NUC password is never stored).
