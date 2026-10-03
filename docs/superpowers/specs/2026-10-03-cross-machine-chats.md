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

  Hydrate and clamp them; `LOCAL_KEYS` includes them. They are effective only while the chat index is on
  and the device is in the vault.
- **Presence:** the sealed `RemoteStatus` gains `chats: true` while sharing is effective (no hub change).
- **Attach:** a guest opens `{ kind: 'chats' }` only to a computer advertising it. It gets its own scope
  (`RelayScope`), which allows exactly:
  - `GET /api/chats/search?q=<≤200 chars>&limit=<≤50>`, returning up to 50 hits
    `{ source, nativeId, title, folder (last path segment), updatedMs, role, snippet, ranges }`, from the
    host's own `ChatStore` search, redacted;
  - `GET /api/chats/open?source=&id=`: the chat as the viewer needs it (`viewer.ts`'s `openChat`), redacted,
    at most 4 MiB, never through `/api/transcript` (unredacted).
- **On every request the host re-checks** `shareChats`, the chat index, the guest's place in the chain (by id
  AND key, gotcha 140) and the grant.
- **Grants:**
  - A guest with no grant raises a question on the host: Allow once / Always / Deny, the existing question
    machinery under a chats prompt.
  - The devices ticked when the switch is turned on are granted `always` at once.
  - Removing a device ends its grant (`chainChanged`).
  - Turning the switch off closes every chats relay.
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
  - It is disabled with the reason when chat history is off ("Turn on Chat history first.") or the device
    is not signed in ("Sign in to Stoke Hub first.").
  - Turning it on opens `ConfirmPasswordSheet`, then a list of the other active devices (name + fingerprint),
    ticked, then "Turn on".
  - When on: "On. <devices> can search and read, but not change, chats on this computer. Secrets are
    redacted; folders show by name." Each device has a Remove.
  - Turning it off is instant: "Stopped. Searches from other computers were closed."
  - A `data-setting` mark plus a `SETTING_ROWS` entry (gotcha 138).
- **Sidebar search "In conversations":** adds an "On <computer>" group per online sharing computer,
  grouped by computer and never merged by score. States:
  - "<Computer> is offline — not searched"
  - "<Computer> isn't sharing chat history"
  - "Waiting for <Computer> to allow…"
- **Opening a remote hit** shows the read-only `ChatViewer` with a header "On <Computer> · <folder name>".
  There is no Resume button, and Copy works.

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
