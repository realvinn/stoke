# Stoke as an authentication hub: design document

*Research date 2026-09-30. Written read-only against branch `windows-install` @ `05360e2` (v0.9.97). No files were changed, nothing was built, and no agent CLI was run. Every external claim has a URL in the Sources section. Anything marked **UNVERIFIED** is my inference or comes from a secondary source I could not check against a primary one.*

---

## 0. Summary

The goal is to turn Stoke into a **public, multi-tenant service** that syncs a user's Stoke setup and accounts across macOS, Windows, Linux and a phone, keeps chats, runs sessions on the user's other machines, and shares SSH access. This document recommends the following.

1. **Local-first, end-to-end encrypted, and zero-knowledge for content.** The server stores ciphertext, a signed device list and routing metadata. It cannot decrypt settings, secrets, chats or terminal traffic, and it cannot add a device on its own authority. Every desktop keeps working with the server down.
2. **Keep server login separate from encryption.** Users sign in to the service with GitHub OAuth or a passkey, with an emailed one-time code as a fallback. All of these run in the system browser (RFC 8252). The vault key never comes from anything the server sees. That removes the need for SRP or a password database. 1Password needs SRP only because its account password does both jobs.
3. **Devices are the keys.** Each device creates its own signing and key-agreement keypairs, stored in the OS keystore through Electron `safeStorage`. A new device joins only when an existing device approves it, by QR or by a short code run through a PAKE. A printed **Recovery Kit** holds a 128-bit secret that wraps the vault key; this is the same idea as 1Password's Secret Key and Tailscale's disablement secrets. Lose every device and the kit, and the data is gone. That is the honest price of a server that cannot read anything.
4. **Sync in tiers.**
   - Preferences sync by default.
   - Stoke-owned API keys sync only after the user opts in.
   - **Agent OAuth credentials never sync.** Anthropic's own policy forbids a third party to "collect, store, or intermediate Claude.ai credentials or session tokens". Separately, refresh-token rotation means two machines sharing one refresh chain sign each other out.
   - SSH uses **per-device keys** and distributes public keys. Private keys stay put by default.
   - Chats sync per project, opt-in only.
5. **Remote run goes through a Durable Object relay first**, carrying the existing phone API (`/api/*` plus the per-pty WebSocket frames) inside an authenticated E2E channel between device keys. A direct WebRTC path with DO signaling can come later as an optimization. The existing tunnel and Tailscale paths stay.
6. **Run it on Cloudflare, fully separate from the installer Worker.** Use a new Worker, one Durable Object per account (SQLite) for records, devices and fan-out, a relay DO per session, D1 for the global directory, R2 for chat blobs, Turnstile and the rate-limit binding for abuse, and Email Service for codes.
   - Estimated cost is **about $5/month at 100 users and about $30–60/month at 10,000 users** (section 14).
   - Money is not the constraint. Crypto correctness, support for lost keys, legal paperwork and abuse handling are.
7. **Phase 1 needs no server.** Move the secrets that are plaintext today into `safeStorage`, with an honest `basic_text` story on Linux. Add a passphrase-encrypted `.stoke-setup` export/import. Each later phase ships on its own.

---

## 1. What exists today (verified in the repo)

| Area | State today | Where |
|---|---|---|
| Settings persistence | One JSON file `userData/settings.json`, written by sync `writeFileSync` + `renameSync`, coalesced (gotcha 63). No encryption. The file is 15.6 KB with 40 top-level keys on this Mac, mode `0644`. It is shielded here only because `~/Library` is `0700`. On Linux, under a `0755` home directory, it would be readable by other local users. | `src/main/store.ts` (`persist`) |
| API keys | Plaintext in settings.json: `providers.anthropicApiKey`, `openrouterApiKey`, `customAuthToken`, plus `agents.endpoints[id].apiKey` for the other agents. The type comment says "Keys stay in settings.json on this machine." | `src/shared/providers.ts`, `src/shared/agents.ts`, `src/shared/types.ts` `Settings.providers` |
| Phone bearer | `remote.token`, a bearer that grants a **shell**, stored in plaintext in settings.json and carried in the QR link. | `types.ts` `Settings.remote.token` |
| `safeStorage` | Used nowhere in `src/` or `scripts/` (grep: zero hits). | — |
| Electron | 43.2.0, which bundles Node 24.17 on BoringSSL. `app.configureWebAuthn` exists, but its Touch ID credentials are "device-bound and are not synced via iCloud Keychain". | `node_modules/electron/electron.d.ts` |
| Fuses | `enableCookieEncryption: true` (one-way, gotcha 108) and `runAsNode: true` (the statusLine/hook shim needs it). `nodeCliInspect` and `nodeOptions` are not set, so they keep Electron's default of *enabled*. | `electron-builder.yml` |
| Phone access | A loopback HTTP+WS server reached through a Cloudflare Tunnel, Tailscale or the LAN. A bearer token is checked on every path. Routes: `GET /api/sessions,/api/host,/api/theme,/api/projects,/api/history,/api/transcript`, `POST /api/sessions,/api/transcribe`, `/ws/events`, and a per-pty WS carrying `attached/data/exit/input/submit/resize`. A reattach replays up to `MAX_HISTORY = 512 KB` of scrollback. | `src/main/remote/server.ts`, `src/main/pty.ts:181` |
| Cloudflare Access | `requireAccessHeader` only checks that `Cf-Access-Jwt-Assertion` or the email header is **present**. The JWT is never verified. This is a known deferred finding, and Cloudflare's docs say you "should validate the token with your public key". | `server.ts` `authorized()` |
| Installer Worker | `stoke-install` at `stoke.vinn.dev`. Static, deployed by hand, with no Cloudflare token in CI, because "whoever can deploy this Worker can run code as the user on every machine that runs the one-liner." | `wrangler.jsonc`, `worker/` |
| SSH | `SshHost { id, label, alias, command, worklog?, keyEnrollRefused?, keyEnrolled? }`. `alias` is a **`~/.ssh/config` Host alias on this machine**. The key-enrollment argv builders and IPC channel exist (`buildCopyIdArgs`, `buildPubkeyProbeArgs`, `CH.sshEnroll`), but **no main-process handler calls them yet**: commit 887b921 is "the contract". | `src/shared/types.ts`, `src/main/ssh.ts`, `src/shared/ipc.ts` |
| Browser logins | Cookies are encrypted with the "Stoke Safe Storage" OS key (gotcha 108). Imported logins are refused unless the store is encrypted (gotcha 107). | `browserImport/` |
| Claude credentials | macOS: login-Keychain item `Claude Code-credentials` (gotcha 36); `~/.claude/.credentials.json` is absent on this Mac. Stoke reads the token and **never refreshes it**, "because rotating the token would invalidate the copy the CLI is holding". | `src/main/usage.ts` |
| Other agent creds (structure only) | `~/.codex/auth.json` (4 KB, `0600`): `{auth_mode, OPENAI_API_KEY, tokens:{id_token, access_token, refresh_token, account_id}, last_refresh}`. `~/.local/share/opencode/auth.json` (`0600`): per-provider `{type, key}`. | local inspection |
| Chats on disk (this Mac) | `~/.claude/projects`: 45 project directories, 2,189 JSONL transcripts, **2.9 GB** in total. Median 721 KB, p90 2.6 MB, max 40 MB. `~/.codex/sessions`: 661 MB. | local inspection |

These facts drive the design:
- Secrets are plaintext at rest today, so Phase 1 is worth doing on its own.
- `SshHost.alias` depends on the local ssh config, so syncing hosts means syncing reachability data too.
- Transcripts are large, so chats must be opt-in, compressed and chunked.
- The phone API already exists, so remote run can reuse it as its payload protocol.

---

## 2. Goals and non-goals

### Goals
- **G1.** One Stoke identity across macOS, Windows, Linux and a phone. A new machine comes up with the user's themes, profiles, defaults, agents, endpoints and hosts in under a minute.
- **G2.** Stoke-owned secrets (API keys, gateway tokens) sync end to end encrypted, only after the user opts in, and can be revoked per device.
- **G3.** An account inventory: each device reports which agent CLIs are installed and signed in, as status only.
- **G4.** Chats can be saved and read across devices, opt-in per project.
- **G5.** The user can see, attach to and start sessions on their other machines from a desktop or phone, through NAT, with no inbound ports.
- **G6.** SSH: a new device gets access to the user's servers by distributing its public key from an already-authorized device. Revoking a device removes its key everywhere.
- **G7.** A public multi-tenant service that a solo developer can run: no servers to patch, graceful degradation, and bounded cost and abuse.
- **G8.** Honest security: the server operator, a hacked server or stolen deploy credentials cannot read user content. Where that guarantee has limits (served phone JavaScript, metadata), the product says so.

### Non-goals
- **N1.** Syncing or brokering Claude.ai, ChatGPT/Codex, Gemini or other agent **OAuth** credentials. This is forbidden for Claude and self-defeating for all of them (section 7).
- **N2.** Server-side recovery of encrypted data. There is no "forgot password" for content.
- **N3.** A web vault that decrypts secrets in a browser tab. The phone gets remote run and notifications, not API keys, unless the user explicitly opts in (section 11).
- **N4.** Teams, organisations, shared vaults or sharing a *Claude session* with another person. Sharing a session would amount to making a Claude account "available to anyone else" (Anthropic Consumer Terms §2). SSH access sharing between users is deferred to a late phase.
- **N5.** Waking a machine or starting Stoke remotely. Remote run needs Stoke running on the target.
- **N6.** Replacing Claude Code's own Remote Control for Claude-subscription sessions (it exists and routes through Anthropic). Stoke's remote run covers everything else: API-key and gateway sessions, the other 17 agents, plain shells and the Stoke session list.
- **N7.** Moving the installer Worker, or changing its deploy-by-hand stance.

---

## 3. Prior art: what comparable products do

| Product | How it syncs | What Stoke takes from it |
|---|---|---|
| **1Password** | "All cryptographic keys are generated by the client". Two-Secret Key Derivation mixes the account password with a 128-bit Secret Key, so "data we store cannot be used in cracking attempts". SRP means the server never learns the password. The Emergency Kit holds the Secret Key, which "We have no record of … and can't recover". | A high-entropy secret the server never sees (the Recovery Kit). A printed kit. The principle that "we can best protect your secrets by not knowing them". |
| **Bitwarden** | The master key comes from PBKDF2 at 600,000 iterations (or Argon2id), stretched with HKDF, and wraps a random 512-bit user key. **Trusted devices**: the user key is encrypted to a device public key and stored server-side. **Login with device**: an approving client encrypts the user key to the requesting device's public key. Key rotation re-encrypts the vault. A passkey PRF unwraps the key. | Device-key wrapping and approval by an existing device (exactly Stoke's model). Rotation re-encrypts everything. PRF as a later add-on. |
| **Atuin** | E2E sync of shell history. The key lives in the data directory and must be copied to each new machine. It is moving to PASETO v4.local (XChaCha20-Poly1305) with **per-record random keys wrapped by the master key**, and record metadata is authenticated as implicit assertions. | Envelope encryption per record. Bind metadata into the AAD so the server cannot swap records. |
| **Obsidian Sync** | E2E by default: AES-256-GCM with a key from scrypt with salt. "If you forget or lose your encryption password, your data remains encrypted and unusable forever." The server still sees device, time and the encrypted path-to-content mapping. | Honest no-recovery messaging. A list of the metadata that remains visible. |
| **Standard Notes** | Argon2id (64 MiB, 5 iterations) produces a root key split into a master key and a server password. Random **items keys** encrypt the content, so a password change only re-wraps items keys. XChaCha20-Poly1305. | A key hierarchy that keeps rotation cheap. |
| **Tailscale Tailnet Lock** | Protects against a compromised control plane: new nodes need a signature from a trusted signing node, so "even if Tailscale were malicious … attackers can't send or receive traffic". Ten disablement secrets are generated, and losing all of them makes the tailnet unrecoverable. | **A signed device list the server cannot extend.** This is the core defense against a malicious server. |
| **Tailscale DERP** | Relays "blindly forward already-encrypted traffic". It is used only when a direct connection fails. | Relay first, direct later, and the relay never holds keys. |
| **sshx** | A browser-shared terminal with "End-to-end encryption with Argon2 and AES" through a relay mesh. | Proof that an E2E terminal relay is practical. |
| **Termius** | E2E vaults for hosts, keys and known_hosts. It **syncs SSH keys and passwords by default** (opt-out toggle). | Stoke should do the opposite: per-device keys by default. Termius shows the demand, and why default key sync weakens revocation. |
| **Zed** | Sign-in opens the system browser at `zed.dev/native_app_signin` with `native_app_port` and `native_app_public_key`, using the GitHub OAuth scope `read:user`. E2E for collaboration is an open feature request. | A loopback plus app-public-key handoff for desktop sign-in. |
| **Matrix MSC4108** | QR sign-in: new and existing device exchange short-lived handshake messages through a server rendezvous, with a check code to confirm the secure channel. | Phone pairing by QR through the Stoke hub. |
| **magic-wormhole** | SPAKE2 turns a short code into a strong key through an untrusted mailbox server. A malicious server gets one guess per code, and a failed guess is visible to the peers. | Pairing two desktops when neither has a camera. |
| **Claude Code Remote Control** | The local session makes "outbound HTTPS requests only". "All traffic travels through the Anthropic API over TLS". Pro/Max/Team/Enterprise only, no API keys, and not when `ANTHROPIC_BASE_URL` points elsewhere. | Leave Claude-subscription remote use to Anthropic. Stoke covers the rest. |

---

## 4. Threat model

### Assets
Stoke-owned secrets (API keys, gateway tokens), **shell access** to the user's machines (through remote run), SSH reach to servers, chat transcripts (code, pasted secrets, tool output), settings, and metadata (which devices, when, how much).

### Adversaries and what the design promises

| Adversary | Can | Cannot (by design) | Residual risk and mitigation |
|---|---|---|---|
| **A1. Malicious or hacked server** (operator, insider, full compromise of Worker/DO/D1/R2) | See ciphertext, sizes, timestamps, device count, IPs, relay pairings and traffic timing. Withhold, delay, roll back or delete data. Refuse service. | Decrypt anything: there are no keys server-side. Add a device, because the device list is signed by existing devices and every client verifies the chain. Forge a record: records are AEAD under the vault key and signed by their author device. Man-in-the-middle a relay: handshakes are authenticated by device keys pinned from the signed list. | **Rollback and fork:** clients pin the device-list head and record versions they have seen and alarm on regression. **Deletion:** local copies plus 30-day PITR (section 13). **Traffic analysis:** optional fixed-interval frame padding, following OpenSSH 9.5's keystroke-timing obfuscation. |
| **A2. Stolen or lost device** (unlocked, or with the OS login known) | Everything that device held: the vault key, synced secrets, its SSH private key, cached chats. Relaying as that device until it is revoked. | Anything after revocation: the server drops it, other devices refuse it, the vault key epoch rotates, and SSH hosts remove its key. | Revoke from any other device (section 6.5). The UI lists **which secrets that device held**, with links to rotate each one at its provider: rotation of the vault key cannot "unsee" data. Stoke-held secrets sit behind `safeStorage`, so a locked or powered-off disk is protected by the OS (FileVault/BitLocker plus Keychain/DPAPI). |
| **A3. Compromised deploy credentials** (Cloudflare account or API token) | Everything in A1, **plus serving malicious JavaScript to the phone PWA**. That JS can use the phone's non-extractable keys, and so can drive any session a phone is allowed to drive. | Touch the desktop app, which ships through GitHub Releases, is signed with the `Stoke` identity (gotcha 24) and verifies everything client-side. | This is the one hole in "the server can't hurt you". Mitigations: (a) the phone does **not** hold the vault key by default (N3); (b) phone remote run is **off per host** until granted on that host, and every phone attach shows a desktop banner and log entry; (c) PWA assets on their own origin and ideally a **separate Cloudflare account** with hardware-key 2FA, deployed by hand like the installer; (d) publish hashes of each PWA build, and adopt WAICT when browsers ship it (Cloudflare's proposal; Meta's Code Verify is the earlier precedent). |
| **A4. Account takeover** (GitHub account, email or passkey phished) | Sign in to the server: see ciphertext and metadata, delete data (soft-delete, 30 days), register a push subscription. | Decrypt, add a device, change sign-in methods (needs a device signature), or start remote run (the host verifies the device signature, not the server session). | Every new server login is pushed to all devices as an event. Adding or removing a login identity needs a signature from an existing device or the recovery key. |
| **A5. Same-user malware or a hijacked agent** (a prompt-injected Claude session is a shell running as the user) | Read anything the user's account can: `settings.json` today, and on Windows anything DPAPI protects ("other applications in the same user session are not prevented"). On macOS it may be able to run Stoke's own signed binary with `ELECTRON_RUN_AS_NODE` or `--inspect` and call `safeStorage` under Stoke's Keychain identity (**UNVERIFIED path**; see section 6.7). | Nothing a desktop can promise without asking for user presence at every unlock. | State it plainly: `safeStorage` protects against other users, backups, disk theft and casual file reads, **not against code running as you**. Disable the `nodeCliInspect` and `nodeOptions` fuses. `runAsNode` must stay on (gotcha 108). |
| **A6. Abuse of the public service** (spam signups, storage as a dumping ground, relay used as a free proxy, credential stuffing, email bombing) | Consume quota and bandwidth, trigger email sends, harm deliverability. | Reach other tenants' data (per-account DO isolation plus E2E). | Turnstile on web sign-up and code-request endpoints. GitHub or passkey as the primary sign-in (it costs the attacker something). Per-account quotas on storage, relay throughput and monthly relay GB. The rate-limit binding for coarse per-key throttling. Exact counters in the account DO. An abuse contact and a suspension switch (section 13). |
| **A7. Network attacker** | Observe TLS metadata. | Read or alter anything: TLS plus E2E. | — |

**Trust roots**, in order: the user's devices (keys in OS keystores), the Recovery Kit, the desktop binary's signature and update channel (GitHub account plus the `Stoke` certificate, which is out of scope here but compromising it compromises everything), and only then Cloudflare and the hub code, which must be *unable* to break confidentiality.

---

## 5. Identity: signing in to the service

The **server account** exists only for routing, quotas and storage ownership. It unlocks no data.

| Method | Verdict | Notes |
|---|---|---|
| **GitHub OAuth** | **Primary at launch.** The audience are developers. Zed does the same. | OAuth App with **PKCE S256**, the only method GitHub supports. Loopback redirect `http://127.0.0.1:<any port>/cb`, where GitHub accepts any port. Run it in the **system browser** (RFC 8252 §5 "MUST use an external user-agent"), never in an Electron `BrowserWindow`: embedded user-agents can "record every keystroke" (§8.12). Request no scope or `read:user`, since only the stable numeric user id is needed. Copy Zed's handoff: the app sends an ephemeral public key, and the hub page returns the session token encrypted to it through the loopback redirect, so the token never appears in plaintext in a URL. |
| **Passkeys (WebAuthn)** | **Primary for anyone without GitHub, and for the phone.** | The relying party is the hub web origin, and the ceremony runs in the system browser or the phone PWA (Safari). Do **not** rely on Electron's `app.configureWebAuthn`: its Touch ID credentials are device-bound, not synced, macOS-only and need an entitlement. `@simplewebauthn/server` runs on Workers. |
| **Email one-time code** | **Fallback and recovery of *server* access only.** | A code, not a magic link: security scanners (Outlook Safe Links, Defender, Mimecast) pre-fetch GETs and burn single-use links. If links are ever added, GET must only display and POST must consume. Needs Cloudflare Email Service on Workers Paid (3,000 per month included). |
| Password + SRP | **Not needed.** | SRP solves "the password is also the encryption secret". Here it is not. |
| Passkey PRF to unwrap the vault key | **Later (Phase 6).** | Browser and platform support is uneven. Windows Hello exposed hmac-secret only from a 2026 cumulative update. The PRF output would also have to cross from the browser into the app. It is a convenience, not a root of trust. |

Sessions: an opaque random token stored hashed in D1, 30-day sliding expiry, **bound to a device**. Every state-changing request is also signed with the device's Ed25519 key over `(method, path, body hash, timestamp, nonce)`. Revoking a device therefore kills its sessions even if a token leaks.

---

## 6. Cryptographic design

### 6.1 Primitives
Use only primitives available natively in **WebCrypto on every engine and in Node's `crypto`**. The same code then runs in Electron main, the renderer and the phone, with no third-party crypto dependency. That fits the repo's no-dependency habit.

| Purpose | Primitive |
|---|---|
| Signatures | Ed25519. WebCrypto in Firefox 129, Safari 17 and Chrome 137; also Node. |
| Key agreement | X25519 (WebCrypto secure curves; Node). |
| KDF | HKDF-SHA-256. |
| AEAD | AES-256-GCM with random 96-bit nonces for stored records. Counter nonces from per-direction keys for channels. |
| Passphrase KDF (Phase 1 export only, desktop only) | Node `crypto.scrypt` with N=2^17, r=8, p=1, OWASP's minimum. `crypto.argon2` came in Node 24.7. Electron 43's binary contains Node's Argon2 JS **and** an `ERR_CRYPTO_ARGON2_NOT_SUPPORTED` path, so whether it works under BoringSSL is **UNVERIFIED**. Ship scrypt and record the KDF in the header so Argon2id can be added later. |

Nothing here needs a slow KDF on the phone, because the Recovery Kit secret is high-entropy. Hand-assembling protocols from primitives is the riskiest part of the plan. The handshake (6.4 and 10.2) and the device-list verifier should get an **external review before public launch**.

### 6.2 Keys

```
Device d:   DSK_d  Ed25519 signing keypair        (private: safeStorage / non-extractable IndexedDB)
            DXK_d  X25519 key-agreement keypair   (same)
Account:    VK_e   256-bit vault key, epoch e     (random; never leaves devices unwrapped)
            RS     Recovery Secret, 128 bits      (printed in the Recovery Kit only)
Per record: CEK    256-bit content key            (random per record/blob; wrapped by VK_e)
```

- **VK wrapping per device:** `seal(DXK_d.pub, VK_e)` using an ephemeral X25519 key, HKDF with `info = "stoke/vk-wrap/v1" || accountId || e || deviceId || DXK_d.pub || eph.pub`, then AES-GCM. The server stores one wrapped copy per active device.
- **Recovery wrap:** `RK = HKDF(RS, salt = accountId, info = "stoke/recovery/v1")`. The server stores `AESGCM(RK, VK_e)` plus an Ed25519 **recovery signing key** derived from RS, which may sign device-list entries (used only on the recovery path). Because RS is 128 random bits, the stored wrap cannot be brute-forced. This is the 2SKD insight without the password.
- **Record encryption:** `AESGCM(CEK, plaintext, AAD = accountId|collection|recordId|version|epoch|authorDeviceId)`, then `AESGCM(VK_e, CEK)`, and the author device signs `H(header||ciphertext)`. The AAD binding stops the server from moving a ciphertext to another slot (Atuin authenticates metadata the same way). The signature lets devices reject records written by a revoked device after its revocation.

### 6.3 The signed device list (Tailnet-Lock style)
An append-only, hash-chained log stored in the account DO:

```
entry = { seq, prev: H(prev_entry), kind: "genesis"|"add"|"revoke"|"rotate"|"identity",
          device: { id, name(encrypted), platform, DSK.pub, DXK.pub, caps: ["vault","remote-run","phone"] },
          epoch, ts, signer: deviceId|"recovery", sig: Ed25519(signer, canonical(entry\sig)) }
```

- The first device signs the genesis entry. Every later entry must be signed by a device that is active at that point in the chain, or by the recovery key.
- Every client verifies the whole chain on sync, **pins the head** locally, and refuses a shorter or forked chain. This is rollback and fork detection. The server can freeze the list but cannot extend it.
- Device names are encrypted under VK, so the server sees platform types, not "Alex's work laptop".
- `caps` limit what a device may do. Phones are created without `vault` by default.

### 6.4 Pairing a new device

**Desktop joining (usually no camera):**
1. The new desktop signs in to the service, creates `DSK/DXK`, and asks "approve on another device".
2. The existing device displays a short code, for example `4-ember-kindling-orbit`: about 30 bits, single use, 10-minute expiry.
3. The user types it on the new device. The two run a **PAKE** (CPace or SPAKE2; magic-wormhole's model) through the account DO rendezvous. A malicious server gets **one guess**, and a failed guess shows up as an error on both peers.
4. Over the PAKE key, the new device sends its public keys. The existing device shows the new device's name, platform and a fingerprint rendered as words or emoji. The user confirms. The existing device then signs an `add` entry and uploads `seal(DXK_new.pub, VK_e)`.

**Phone joining:** described in section 11 (a QR carrying a 128-bit secret, so no PAKE is needed).

**Recovery path (no device left):** enter the Recovery Kit secret, unwrap VK, and the recovery key signs an `add` for the new device. Then prompt the user to rotate (6.5), in case the kit itself leaked.

### 6.5 Revocation and key rotation
Revoking a device from any other device (or the recovery key) runs these steps:
1. Sign a `revoke` entry. The server immediately rejects that device's sessions and signed requests (defense in depth).
2. **Rotate the epoch:** create `VK_{e+1}`, seal it to each remaining device, and re-wrap the recovery copy.
3. **Re-encrypt the small tiers** (settings, secrets, hosts: kilobytes) eagerly under new CEKs.
4. **Chat blobs:** re-wrap their CEKs under `VK_{e+1}`, which is cheap. Blob contents the revoked device already downloaded are compromised whatever happens next, so this step only stops *future* reads. New appends use new keys.
5. **Show the blast radius:** "This device held: Anthropic API key, OpenRouter key, SSH access to 3 hosts". Link to each provider's key page, and offer "remove this device's SSH key from all hosts" (section 8).
6. Push a notification to all devices.

Claim-before-await (gotcha 20) applies: two devices revoking at once must not both rotate. The DO serialises chain appends, and the loser rebases on the new head.

### 6.6 Recovery Kit
- Generated when the first device creates the account. The user must save it (download a PDF or print) and type back four of its characters before continuing.
- Contents: account id, sign-in hint (for example "GitHub"), RS as 26 base32 characters in groups, a QR code of the same, the date, and the sentence **"Stoke cannot recover your data without this. We do not have a copy."** This mirrors 1Password's and Obsidian's wording.
- Regenerating it (after a suspected leak) requires an existing device. It rotates the recovery wrap and the recovery signing key, and signs an `identity` entry.

### 6.7 Local key storage per platform (Electron `safeStorage`)

| Platform | Backend | What it really protects |
|---|---|---|
| macOS | Keychain item for the app, "prevents other applications from loading them without user override". Access follows the code signature: the stable `Stoke` identity (gotcha 24) is what keeps updates prompt-free. | Other apps, other users, and backups or copies of the file. Weak spot (**UNVERIFIED**): the `nodeCliInspect` and `nodeOptions` fuses are on by default and `runAsNode` must stay on. Same-user code might therefore run Stoke's own signed binary and reach the key without a prompt. Test this, and flip `nodeCliInspect: false` and `nodeOptions: false` in `electronFuses`, asserted in `assert-cookie-fuse.mjs` like the others. |
| Windows | DPAPI, tied to the user's logon credential. | Other users and offline disk theft. **Not** other processes in the same session: Electron's docs say so. |
| Linux | `gnome_libsecret`, `kwallet`, `kwallet5` or `kwallet6`, chosen by desktop environment. Falls back to **`basic_text`**, meaning "unprotected … encrypted via hardcoded plaintext password". Tiling window managers such as i3, sway and Hyprland commonly land on `basic_text` unless `--password-store=gnome-libsecret` is passed (**UNVERIFIED** for each WM). | With `basic_text`: nothing beyond obfuscation. Detect it with `safeStorage.getSelectedStorageBackend() === 'basic_text'`, which is only valid after `ready`. |

**The `basic_text` answer:**
1. If a Secret Service is reachable on D-Bus, relaunch once with `app.commandLine.appendSwitch('password-store','gnome-libsecret')`. Test the effect on the already-encrypted cookie store before shipping (gotcha 108 territory): **UNVERIFIED** whether Chromium's v10 (basic) cookies stay readable after switching to v11 (keyring).
2. Otherwise offer a choice: (a) a **Stoke unlock passphrase** at launch, which derives a key with scrypt and keeps it in memory only, or (b) "store obfuscated only". A persistent warning chip says which one is in use.
3. Phase 2+ sync refuses to hold `vault` capability on a `basic_text` device unless the user picked (a).

Also write every secret-bearing file with mode `0600`, and move `remote.token` into the secret store.

---

## 7. Agent OAuth credentials: why they are never synced

**Terms.**
- Anthropic, Claude Code "Authentication and credential use": OAuth is "designed to support ordinary use of Claude Code and other native Anthropic applications". Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." The same page confirms that an end user signing in to the **unmodified** `claude` binary is fine, which is what Stoke does.
- Consumer Terms §2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else … You also may not make your Account available to anyone else."
- A Stoke hub storing Claude OAuth tokens, even encrypted, is "store … or intermediate". **Not offered, not even opt-in.**
- OpenAI Terms of Use: "You may not share your account credentials or make your account available to anyone else" (quoted from a search snippet; the page returned 403 to the fetcher). OpenAI's Codex docs document **copying `~/.codex/auth.json`** to a headless machine, and say to "Treat ~/.codex/auth.json like a password". So a user copying their own file once is sanctioned. A third-party service holding it is not described anywhere.
- OpenAI reportedly launched "Sign in with ChatGPT" for third-party tools in 2026 (**UNVERIFIED**, secondary sources only). If true, that partner program is the sanctioned route, not token sync.

**Mechanics (refresh-token rotation).**
- RFC 9700 §4.14.2: for rotation, "the authorization server issues a new refresh token with every access token refresh", invalidating the old one. When a stale token is presented, the server can treat it as theft and revoke the grant.
- Public clients such as CLIs "MUST be sender-constrained or use refresh token rotation" (§2.2.2).
- In practice: Claude Code issue #43392 (parallel processes race one refresh token and the losers get `invalid_grant` and wipe credentials), #88583 (a losing refresh clobbers the winner's rotated Keychain credential), #24317 (concurrent sessions forced to re-login). Codex users see `refresh_token_reused`: "Your refresh token has already been used…" (openclaw #26322).
- Two machines holding a synced copy of one refresh chain are this race **by construction**: whichever refreshes first silently signs the other out, and syncing the new token back races the next refresh. This is the same reason Stoke already refuses to refresh the Claude token itself (gotcha 36).

**What Stoke does instead.**
- **Account inventory, synced as status only:** per device, which CLIs are installed and signed in, plus a label (plan, account email). E2E encrypted; no tokens. It shows as "Claude: signed in (Max) on MacBook · not signed in on linux-box".
- **"Sign in here" button:** opens a Stoke pty running the CLI's own flow (`claude` `/login`; `codex login` or its device-code variant). That is Anthropic's and OpenAI's own flow, on each device.
- **Stoke-owned API keys** (Anthropic Console, OpenRouter, custom gateways) are the user's own keys, billed to them. They are explicitly allowed ("configuring an API key in a development environment, secrets manager …") and are the Tier 2 opt-in (section 8).
- Stoke never writes `~/.claude.json` except through `claudeGlobalConfig.ts` (gotcha 38), and never touches `claudeAiOauth`.

---

## 8. What syncs, by tier

Every tier is encrypted under VK. The tier decides **defaults and prompts**, not whether encryption applies.

| Tier | Default | Contents (from `Settings` and the disk) |
|---|---|---|
| **T0: never leaves the device** | — | `remote.*` (port, **token**, reach, hostname, binds, Access flag, tunnelName, sttUrl), `projectRoots`, `defaultCwd`, `startOnLaunch`, `pinnedProjects`, `hiddenProjects`, `projectMeta` (all keyed by absolute path; see note), `claudePath`, `sidebarWidth`, `uiScale` (display-dependent), `wallpaper.path`, `browser.lastUrl`, `browser.width`, `browser.currentProfile`, `browser.importOffer`, `activeProfile`, `welcomeSeenVersion`, `confirmBypass`, `tabs.json`, browser partitions and cookies (tied to that device's Stoke Safe Storage key, gotchas 107/108), statusLine files, **agent CLI credentials**, **SSH private keys**. |
| **T1: preferences** | On once sync is enabled | `themeId`, `themeIdLight`, `followSystemTheme`, `customThemes`, `wallpaper.{blur,dim,opacity}`, `fontFamily`, `fontSize` (per-device override allowed), `terminal`, `zoomTarget`, `fullScreenReveal`, `showBrand`, `defaults.{model,effort,ultracode}`, `profiles` (group names and accents), `worklogGroups`, `worklogAuto`, `worklogBoards`, `hideStatusLine`, `sshKeyEnroll`, `notifications`, `cliRelaunch`, `betaUpdates`/`cliAutoUpdate`/`selfUpdateAuto` (per-device override), `browser.homepage`, `browser.bookmarks`, `browser.profiles` labels only, `agents.chosen`, `agents.endpoints[*].{mode,model,baseUrl}`, `providers.{claudeAuth,customBaseUrl,openrouterModelDiscovery}` (per-device override: one machine may use OAuth, another a key). **`defaults.permissionMode`** syncs, but a synced `bypassPermissions` never takes effect until confirmed locally. |
| **T2: Stoke-owned secrets** | Off. Per-secret opt-in, with a "synced to N devices" badge. | `providers.anthropicApiKey`, `openrouterApiKey`, `customAuthToken`, `agents.endpoints[*].apiKey`. Never to a phone unless the phone was given `vault` capability. |
| **T3: account inventory** | On | Per-device agent sign-in status and labels (section 7). |
| **T4: SSH** | Host definitions on. Keys per device. | Section 9. |
| **T5: chats** | Off. Per project. | Section 10. |

**Paths across machines.** `projectMeta` and pins are keyed by realpath (gotcha 91), which means nothing on another OS. Phase 5 can add a portable key, the git remote URL plus the path within the repo, and map it to each device's local checkout. Until then these stay T0. (See open questions.)

**Conflict resolution.** Each T1 field is its own record: last-writer-wins by `(hybrid logical clock, deviceId)`, with all versions kept for 30 days. `customThemes` and `profiles` are sets keyed by id. After a merge the client runs `hydrateSettings` and the clamps, so a synced record from a newer build can never inject an unknown shape. Per the CLAUDE.md conventions, new fields need defaults and clamp lines in the same change.

---

## 9. SSH: per-device keys, public-key distribution

**Why per device.** Revocation must be surgical: a stolen laptop's key comes off every host without touching the others. Syncing one private key everywhere (Termius's default) makes every device's compromise every device's compromise, and turns revocation into "rotate the key on all hosts from scratch".

**Design:**
1. **Host definitions sync (T4):** `label`, `command`, `worklog`, and an E2E copy of **the reachability fields `alias` depends on** (`HostName`, `User`, `Port`, `ProxyJump`, `IdentitiesOnly`), captured from `~/.ssh/config` when the host is added.
   - On a device where the alias is missing, Stoke passes those as `-o` options or writes a `Host stoke-<id>` block into an included file `~/.ssh/config.d/stoke`. It never edits the user's main config.
   - It **also syncs `known_hosts` entries** for these hosts: host public keys, integrity-protected by E2E. A new device then does no trust-on-first-use.
2. **Per-device key:** on first SSH use each device creates an Ed25519 key `~/.ssh/stoke_<deviceId>` with mode `0600`. The public key goes into the signed device list; its comment is `stoke:<deviceId>`.
3. **"Authorize this device on my hosts":** from an already-authorized device, for each host, Stoke appends the new public key over its *existing* key-based access. It uses `buildEnrollFallbackArgs`'s refuse-never-escape rule (gotcha 75/29 flags: `-e none`, `ControlPath=none`) and then proves it works with `buildPubkeyProbeArgs` (`BatchMode=yes`) **run from the new device**. This finishes the enrollment contract that exists today without a handler. The password-based first enrollment (`ssh-copy-id`) stays as it is.
4. **Revoke:** from any authorized device, remove the lines tagged `stoke:<revokedId>` from each host's `authorized_keys` with an atomic rewrite, and report hosts that could not be reached.
5. **Opt-in private-key sync:** allowed per key, off by default. The warning says it defeats per-device revocation. Such keys are T2 secrets.
6. **Later (Phase 6): SSH certificates.** A "signing device" (Tailnet-Lock style) holds a user CA and issues short-lived certificates (`ssh-keygen -s … -V +16h`). Hosts trust `TrustedUserCAKeys`, and revocation is a KRL or simply expiry. This needs root on each host, so it is a power-user option.
7. **Sharing access with *other* people (Phase 6):** add another Stoke user's device public keys, verified by fingerprint comparison, with `restrict,pty` and an expiry that Stoke sweeps. This never shares an agent session (N4).

---

## 10. Chats (opt-in per project)

- **Scope:** Claude transcripts under `~/.claude/projects/<slug>/*.jsonl` first. Codex `~/.codex/sessions` and other agents only once each format is understood.
- **Size reality:** 2.9 GB of Claude transcripts on this heavy-use Mac. Compress before encrypting (zstd or gzip; roughly 5–10× on JSONL, **UNVERIFIED** ratio) and pad sizes to power-of-two buckets, which limits size-based inference on attacker-influenced content.
- **Upload:** append-only chunks, using the same cursor logic as `advanceCursor` (gotcha 103). Each chunk is an R2 object named by an opaque id, with its own CEK wrapped by VK. The account DO holds the chunk index as an encrypted record.
- **Use on another device:**
  - A read-only mirror: list, search and read.
  - **"Continue here"** copies the JSONL into the local project directory for the mapped folder, then starts `claude --resume`, with `resumeOrMint` deciding between `--resume` and `--session-id` against the disk (gotcha 81). Resuming the same chat on two machines forks it, and the UI says so.
  - Resuming a real session touches its transcript (the CLAUDE.md standing trap), so the mirror must be read-only until "Continue here" is pressed.
- **Deletion:** removing a project from sync deletes its R2 prefix server-side, and the index record is tombstoned.

---

## 11. Phone: PWA plus Web Push

- **Delivery:** the existing `src/remote` bundle, extended, served from its **own origin** (for example `m.stoke.vinn.dev`), separate from the API origin. Install to the Home Screen.
  - iOS Web Push needs iOS/iPadOS 16.4+ **and** a Home Screen install, with the permission request made "in response to direct user interaction". No Apple Developer account is needed.
  - Home Screen web apps "have their own counter of days of use", so WebKit's 7-day storage cap resets with use.
  - Apple reversed the iOS 17.4 EU removal of Home Screen web apps.
- **Pairing must happen inside the installed PWA.** On iOS, Home Screen apps have storage separate from Safari (WebKit bug 181849), so a pairing link opened in Safari would store keys where the PWA cannot see them.
  - The PWA offers an in-app camera QR scanner, a bundled JS decoder (camera access in standalone mode is **UNVERIFIED**), and a typed-code fallback that uses the same PAKE as desktops.
  - The desktop QR encodes `{rendezvousId, desktop ephemeral X25519 pub, 128-bit secret, check code}`, following MSC4108.
- **Phone keys:** WebCrypto Ed25519 and X25519 keys, **non-extractable**, in IndexedDB. The device-list entry carries `caps: ["remote-run","phone"]` and **no `vault`**. The phone therefore never holds API keys (N3), which shrinks A3.
- **Web Push content is E2E encrypted.** RFC 8291 protects the payload from the *push service* (Apple, Google, Mozilla), but the hub performs that encryption and so would see plaintext.
  - Instead, the **originating desktop** encrypts the notification body ("Claude finished in stoke/…") to the phone's X25519 key. The hub wraps that ciphertext in the RFC 8291 envelope with VAPID.
  - The service worker decrypts it with the IndexedDB key and shows it. iOS requires a visible notification for every push, so "undecryptable" falls back to a generic "Stoke: session update".
- **Attaching from the phone:** through the relay (section 12). The existing tunnel and tailnet paths keep working, and the tailnet path needs no hub at all.

---

## 12. Remote run

### 12.1 The question: can a public relay carry terminal traffic end to end encrypted?
Yes. Tailscale's DERP forwards WireGuard ciphertext it cannot decrypt, and sshx runs a browser terminal E2E through a relay mesh. The condition is that the **key exchange is authenticated by keys the relay cannot substitute**. For WebRTC, RFC 8827 §9.1 warns that "the signaling server can potentially mount a man-in-the-middle attack unless implementations have some mechanism for independently verifying keys". The same holds for any relay. Stoke has that mechanism: the signed device list.

### 12.2 Channel
1. Both ends open WebSockets to a **relay DO** named `relay:<accountId>:<sessionNonce>`. Using a DO per session keeps the account DO cool; the soft limit is about 1,000 requests per second per object.
2. Handshake, SIGMA-style, all from WebCrypto:
   - each side sends `eph_X25519.pub` together with `Ed25519_sign(DSK, "stoke/relay/v1"|room|role|eph_a|eph_b)`;
   - each side verifies the peer's DSK against the **pinned** device list;
   - `k_ab, k_ba = HKDF(X25519(eph, eph'), transcript hash)`.
3. Transport: AES-256-GCM with a 64-bit per-direction counter nonce, and a rekey every 2^20 frames. This gives forward secrecy per session.
4. **Payload:** the existing phone protocol, unchanged: HTTP-style request and response frames for `/api/sessions`, `/api/projects`, `/api/history`, `/api/transcript`, `POST /api/sessions`, and WS frames `attached/data/exit/input/submit/resize`. The phone UI and a desktop "Other machines" panel reuse the phone client. The host keeps gotchas 84–87 (`submitFrames`, `decideResize`, separate `\r` writes) exactly as today.
5. **What the relay sees:** the pair of device ids, start and end times, frame sizes and frame timing. Keystroke timing is a known leak, and OpenSSH 9.5 added `ObscureKeystrokeTiming` (fixed 20 ms interval plus chaff) for the same reason. Offer "obscure typing" that pads input frames to a 20 ms cadence.

### 12.3 Authorization lives on the host, not the server
- **Per host, off by default:** "Allow my other devices to run sessions here", with modes `off | view-only | full`.
- **Per device grant, pinned locally on the host:** the allowlist of device ids and public keys lives in the host's own T0 state, so neither the server nor a synced record can grant access.
- **Phones need a separate, explicit grant.**
- **Visible:** a title-bar indicator and a log entry for every attach. One click disconnects all remote viewers.
- The host checks that the requester is active in the verified device list **and** in its local allowlist on every connect.
- Anything that starts a process (`POST /api/sessions`) applies the same resume and mint rules (gotchas 81 and 92) and a per-host rate limit.

### 12.4 Relay versus a direct tunnel

| | DO relay (Phase 4) | Direct WebRTC with DO signaling (Phase 6) | Existing tunnel / Tailscale |
|---|---|---|---|
| NAT traversal | Always works (outbound WS) | ICE, then **Cloudflare Realtime TURN** at $0.05 per GB outbound when direct fails | The user sets up cloudflared or Tailscale |
| E2E | App-layer channel, 12.2 | DTLS, **plus** fingerprints signed by DSK inside the signaling (RFC 8827's mitigation) | TLS to your own machine, plus the bearer token |
| Latency | One extra hop through a nearby CF colo | Lowest when direct | Direct or tunnel |
| Complexity | Low: one DO class | High: `RTCPeerConnection` lives in a renderer (main needs IPC or a native lib); ICE edge cases | Already shipped |
| Cost | DO requests (WS messages billed 20:1); idle hibernation-eligible time not billed | Signaling negligible; TURN per GB | $0 |

Recommendation: ship the relay, keep the tunnel and tailnet, and add WebRTC "upgrade to direct" the way Tailscale falls back from direct to DERP, only if latency complaints justify it. For Claude-subscription sessions, also mention Claude Code's own Remote Control (Anthropic-routed, outbound only). Stoke's relay exists for everything Remote Control does not cover (N6).

### 12.5 Also fix now, independently
Verify the `Cf-Access-Jwt-Assertion` signature: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, match `kid` in `public_certs`, check `aud` and `iss`. This needs two new settings (team domain, AUD tag). Presence-checking is, in Cloudflare's own words, not validation.

---

## 13. Server architecture (Cloudflare), separate from the installer

```
                    ┌──────────────── Cloudflare account B (hub) ────────────────┐
 desktop / phone ──►│ Worker  stoke-hub  (api.stoke.vinn.dev)                    │
   HTTPS + WS       │   /auth/*  GitHub OAuth (PKCE, loopback), WebAuthn, email  │
                    │   /v1/*    device-signed REST: records, devices, blobs     │
                    │   /ws      → Account DO (hibernatable)                     │
                    │   /relay   → Relay DO                                      │
                    │   bindings: D1 directory · DO Account · DO Relay · R2 blobs│
                    │             RateLimit · Turnstile secret · Email · Queue*  │
                    ├────────────────────────────────────────────────────────────┤
                    │ Static PWA  (m.stoke.vinn.dev)  — deployed by hand         │
                    └────────────────────────────────────────────────────────────┘
 Cloudflare account A (existing): stoke-install — untouched, still static, still by hand
```

**Components:**
- **D1 `hub-directory`:** global lookups only. Tables: `accounts(id, created, status, quota_tier)`, `identities(provider, subject_hash → account)`, `webauthn_credentials`, `sessions(token_hash, account, device, expires)`, `email_codes(hash, expires, attempts)`, `abuse_flags`, `deletion_requests`. Tiny. Limits: 10 GB per database on Paid, single-threaded (about 1,000 queries per second at 1 ms each). D1 Time Travel restores to any point in the last 30 days on Paid and is always on.
- **DO `Account`** (one per account, SQLite): device-list chain, encrypted records with versions, per-device VK wraps, recovery wrap, push subscriptions, and the chat chunk index. It holds the **hibernatable WebSockets** of online devices: "Billable Duration (GB-s) charges do not accrue during hibernation". It serialises chain appends, which is the claim-before-await rule at the server. Exact per-account counters for quotas and sign-in throttles live here. Limits: 10 GB per object. PITR through `getBookmarkForTime` and `onNextSessionRestoreBookmark` covers 30 days.
- **DO `Relay`:** a room per remote-run session with two hibernatable sockets, forwarding frames verbatim. Throughput caps apply (for example 1 MB/s and N GB per month per account on the free tier). Received WebSocket messages can be up to 32 MiB.
- **R2 `hub-blobs`:** chat chunks and optional wallpaper images under `acct/<opaque>/…`. Lifecycle rules handle purge. Egress is free.
- **Web Push:** VAPID keys are Worker secrets. The DO sends RFC 8291-encrypted pushes by `fetch` to the subscription endpoint.
- **Abuse controls:**
  - Turnstile (free, up to 20 widgets) on the web sign-up and email-code pages.
  - The **Rate Limiting binding**: periods of 10 or 60 seconds, per location, "eventually consistent … not … an accurate accounting system". Key it on account or device id, not IP ("many users may share a single IP"). Exact limits live in the DO.
- **Email:** Cloudflare Email Service, which needs Workers Paid: 3,000 per month included, then $0.35 per 1,000.
- **Queues (optional):** account-deletion fan-out and email retries. Free plan: 10,000 operations per day. Paid: 1M per month, then $0.40 per million. DO alarms can do the same at small scale.

**Separation from the installer:**
- Different Worker and different hostnames.
- Ideally a **different Cloudflare account**, so an API token or session for one cannot deploy the other.
- Hardware-key 2FA on both. No Cloudflare token in CI, keeping the repo's current stance.
- The PWA origin gets the same by-hand deploy and published build hashes as the installer.
- **Crypto code shared** between the desktop, the PWA and any Worker-side verification lives in `src/shared` (pure, no `node:` imports, gotcha 27), so `verify:*` suites can exercise the device-list verifier and record format under strip-types (gotcha 78).

### Data retention, deletion and export
- **Server data:** login identity (GitHub id, or a hashed and encrypted email), device ids, platforms and public keys, ciphertext and its sizes, timestamps, push endpoints, IP addresses in logs.
- **Export:** "Export everything" on any unlocked device writes the Phase 1 `.stoke-setup` format (plaintext is only available client-side). A server-side export of the account's metadata and ciphertext bundle meets GDPR Art. 20 (portability), which the privacy policy should name.
- **Deletion:**
  - Account delete = immediate logical delete (sign-in blocked, data unreadable through the API, all devices notified).
  - A **30-day grace** period for regret. Then a purge: DO `deleteAll()` (atomic), the R2 prefix, D1 rows.
  - The policy states that **point-in-time backups persist up to 30 days** after purge (D1 Time Travel, DO PITR).
  - Device-level delete removes that device's wraps and sessions.
  - Inactive accounts: warn at 21 months, delete at 24 (a proposal).
- **Response times:** GDPR applies to a non-EU controller "offering … goods or services … to data subjects in the Union" (Art. 3(2)). Subject-access requests must be answered "within one month" (Art. 12(3)). Breaches go to the authority "not later than 72 hours" unless "unlikely to result in a risk" (Art. 33). Being unable to decrypt helps that risk assessment. Australia: the Privacy Act's small-business exemption covers turnover at or below A$3M unless an exception applies (for example trading in personal information). The Notifiable Data Breaches scheme applies to covered entities. Recommend following it voluntarily. Proposed reforms to the exemption were not checked (**UNVERIFIED**).
- **Privacy policy must list:**
  - the data categories above;
  - processors: Cloudflare, GitHub (sign-in), the email sender, and Apple, Google and Mozilla push services;
  - the purposes;
  - retention (including 30-day backups);
  - that content is E2E encrypted and **unrecoverable**;
  - that **agent credentials are never collected**;
  - rights and how to exercise them;
  - a contact, plus a `security.txt`.
- **Terms of service must:** forbid using sync or remote run to share agent accounts (mirroring Anthropic §2 and OpenAI), set per-tier quotas, reserve suspension, and state no warranty of recoverability.
- **Abuse handling:**
  - The service has **no public content surface** (no share links, no public pages), so it has little value for distributing illegal material.
  - Quotas bound storage and relay use.
  - `abuse@` and a documented response: suspend the account, preserve metadata on lawful request, and say publicly that content cannot be produced because it is not held in readable form.
  - An operator kill-switch per account and a global "relay disabled" flag.

---

## 14. Costs

**Cited unit prices:**

| Service | Price |
|---|---|
| Workers Paid | $5/month minimum. Includes 10M requests (+$0.30 per million) and 30M CPU-ms (+$0.02 per million). |
| Durable Objects | 1M requests included (+$0.15 per million). 400,000 GB-s included (+$12.50 per million). WS inbound billed 20:1. SQLite storage 5 GB included (+$0.20 per GB-month). 50M rows written included. Duration counts only while running or "idle in memory but unable to hibernate", at 128 MB flat. |
| D1 | 5 GB included (+$0.75 per GB-month). |
| R2 | $0.015 per GB-month. Class A $4.50 per million. Class B $0.36 per million. Free tier: 10 GB, 1M Class A, 10M Class B. Egress free. |
| Email | 3,000 per month included, then $0.35 per 1,000. |
| Turnstile | Free. |
| TURN | $0.05 per GB. |

**100 users** (~60 weekly active, 2 desktops each, 30 phones, 20 chat opt-ins averaging 0.3 GB):
- Worker requests ≈ 0.9M/month, DO requests ≈ 0.5M, DO storage 0.1 GB, R2 about 6 GB, email under 3,000. **Everything fits inside the included quotas.**
- **Total ≈ $5/month** (the Workers Paid minimum; the domain is already owned). A Free-plan launch is possible without email codes, but Paid gives the CPU headroom WebAuthn and push encryption need.

**10,000 users**, assuming 3,000 DAU, 1,000 using remote run 1 hour a day at an average of 5 frames per second, 2,000 syncing chats at 0.3 GB compressed each, and 1 email code per user per month:

| Item | Estimate |
|---|---|
| Workers requests: 3k DAU × 300/day ≈ 27M/month | 17M over → **$5.10** |
| Workers CPU ≈ 54M ms | **$0.50** |
| DO requests: sync 9M + relay 1,000 × 18k frames/h × 30 h ÷ 20 = 27M | 35M over → **$5.25** |
| DO duration: relay and account DOs hibernation-eligible between messages; at ~1–10 ms per frame (**UNVERIFIED**, measure) ≈ 70k–700k GB-s | **$0–4** |
| DO SQLite storage: 10k × ~1 MB = 10 GB | **$1** |
| R2: 600 GB | **$9**; Class A 1.8M → **$3.60** |
| D1 | included |
| Email: 10k codes | **$2.45** |
| **Total** | **≈ $32–36/month**. Budget **$60** for headroom. If chat opt-ins average 1 GB: +$21. If WebRTC TURN carries 30% of relay traffic: about +$20. |

What costs real money is **time**: an external review of the crypto protocol (quotes vary, **UNVERIFIED**), a one-time legal review of the ToS and privacy policy (**UNVERIFIED** cost), and ongoing support.

---

## 15. Operations for a solo developer (honest)

**Can be done alone:**
- No servers or OS patching.
- Per-account isolation comes free from the DO model.
- 30-day PITR on both D1 and DO.
- The cost is trivial.
- An outage is a non-event for sync, because every desktop is local-first. Remote run over the relay stops, but tunnel and tailnet keep working.

**Hard alone, so the design reduces it:**
- **Crypto correctness.** Keep the protocol small (sections 6 and 12), put all of it in `src/shared` with verify suites, add a hand-written test-vector file, and get one external review before any public sign-up. No custom primitives.
- **Lost-key support.** A no-recovery design produces sad tickets. The mitigation is UX: a forced Recovery Kit confirmation, a monthly "you have N devices; is your kit safe?" nudge, and a warning when the account has only one device.
- **Legal and privacy.** Write the ToS, privacy policy and DPA references once. Keep a DSAR runbook (a one-month clock) and a breach runbook (72 hours; notify users from all devices).
- **Abuse.** Turnstile, GitHub or passkey sign-up, hard quotas and a kill switch. Aim to spend under an hour a week. If it grows past that, close open sign-up (a waitlist) rather than build moderation.
- **Key and secret rotation runbooks:** VAPID keys (this re-subscribes every phone), the GitHub OAuth client secret, the session-token pepper, the Turnstile secret.
- **Monitoring:** Workers observability (already the pattern in `wrangler.jsonc`), an external uptime check on `/healthz`, an email alert on error-rate spikes. No 24/7 on-call; the architecture assumes none.
- **Scope discipline:** no teams, no web vault, no session sharing between people. Each would multiply support and threat surface.

---

## 16. Phased plan (each phase ships alone)

### Phase 1: no server. Secrets at rest, and portable setups.
1. **`secrets.ts` in main, plus a pure format module in `src/shared`:**
   - Move `providers.{anthropicApiKey, openrouterApiKey, customAuthToken}`, `agents.endpoints[*].apiKey` and **`remote.token`** into a `secrets.json` of `{v, backend, items: {path: base64(ciphertext)}}`, mode `0600`.
   - `settings.json` keeps empty strings. `hydrateSettings` stays a pure function, and main overlays the decrypted values.
   - Migrate once on boot: read plaintext, write encrypted, scrub `settings.json` and `settings.json.tmp`.
   - Tell the user that older backups still hold plaintext keys, and link to rotation pages.
   - Gate on `isEncryptionAvailable()`. If it is unavailable, keep today's behaviour and show a warning; never lock the user out.
   - On Linux, handle `basic_text` as in section 6.7.
   - Downgrade note: an older build will see empty keys.
2. **Fuses:** add `nodeCliInspect: false` and `nodeOptions: false`, asserted in `assert-cookie-fuse.mjs`. First check nothing in `statusLine.ts` or the shim relies on either.
3. **Passphrase-encrypted export/import:**
   - The `.stoke-setup` file is a JSON header `{format:"stoke-setup", v:1, kdf:{alg:"scrypt", N:131072, r:8, p:1, salt}, aead:"AES-256-GCM", nonce}` followed by ciphertext of `{tiers T1 (+T2 if ticked) (+T4 host defs & known_hosts)}`.
   - Import shows a diff preview, then merges field by field through the hydrate and clamp path.
   - This format is later the "Export everything" and offline-migration path.
4. **Also:** verify the Access JWT (section 12.5).
5. **Verify suites:**
   - `verify:secrets`: round trip, wrong passphrase, tampered byte, unknown KDF, `basic_text` branch through an injected backend.
   - Migration test on a **synthetic userData** (gotcha 74: fake every input), including a bystander file that must survive.
   - Add both to the `check` chain (gotcha 62).

**Exit criteria:** no secret in plaintext on disk on macOS or Windows, and an export from Mac imports on Windows.

### Phase 2: account, devices, E2E sync of T1–T3 (desktops only)
- The hub Worker, D1, the Account DO, GitHub OAuth plus a passkey page, and email codes.
- Device keys, the signed device list, desktop pairing by code and PAKE, the Recovery Kit, revocation with epoch rotation.
- Sync of T1, opt-in T2 and T3 (inventory).
- The "Sign in here" pty for agent CLIs.
- Privacy policy, ToS, deletion and export.

**Exit:** two desktops on different OSes converge. Revocation rotates and alerts. The server's database dump shows no plaintext; test this by grepping a D1 export for a planted secret.

### Phase 3: SSH
- Finish the enrollment handler that exists today as a contract only.
- Host-definition and `known_hosts` sync, per-device keys, "authorize on all hosts", and removal on revoke.

**Exit:** a new device reaches every host without a password prompt, and a revoked device is refused (checked with the `BatchMode` probe).

### Phase 4: phone PWA plus Web Push plus remote run over the relay
- The PWA on its own origin, in-PWA pairing, E2E push, the Relay DO, the SIGMA channel, host-local grants and the attach indicator.
- The desktop gains an "Other machines" panel.

**Exit:** from an iPhone Home Screen app on cellular, list sessions on a Mac and a Windows box and type into one. The relay's logs hold only sizes and timings.

### Phase 5: chats (opt-in per project)
- R2 chunks, the index, read-only mirror, search, "Continue here", and project mapping by git remote.

**Exit:** a synced chat is readable on a second machine and resumable there as a fork. Deleting the project from sync purges R2.

### Phase 6 (optional, demand-driven)
- WebRTC direct upgrade with DSK-signed fingerprints.
- SSH certificates from a signing device.
- Sharing SSH access with other Stoke users.
- Passkey PRF unlock.
- An external audit before any "teams" work.

---

## Sources
- 1Password Security Design white paper — https://1passwordstatic.com/files/security/1password-white-paper.pdf
- 1Password Secret Key — https://support.1password.com/secret-key-security/
- Bitwarden security white paper — https://bitwarden.com/help/bitwarden-security-white-paper/
- Atuin new encryption — https://blog.atuin.sh/new-encryption/ ; Atuin AGENTS.md (per-record CEKs, PASETO v4) — https://github.com/atuinsh/atuin/blob/main/AGENTS.md ; Atuin sync docs — https://docs.atuin.sh/cli/reference/sync/
- Obsidian Sync security — https://obsidian.md/help/Obsidian+Sync/Security+and+privacy
- Standard Notes encryption — https://standardnotes.com/help/security/encryption
- Tailscale Tailnet Lock — https://tailscale.com/kb/1226/tailnet-lock ; DERP — https://tailscale.com/kb/1232/derp-servers
- sshx — https://github.com/ekzhang/sshx
- Termius key sync — https://docs.termius.com/keychain/sync-of-keys-and-passwords
- Zed authentication — https://zed.dev/docs/authentication ; E2E request — https://github.com/zed-industries/zed/discussions/16437
- Matrix MSC4108 — https://github.com/matrix-org/matrix-spec-proposals/pull/4108
- magic-wormhole — https://magic-wormhole.readthedocs.io/en/latest/welcome.html
- Claude Code Remote Control — https://code.claude.com/docs/en/remote-control
- RFC 8252 — https://www.rfc-editor.org/rfc/rfc8252.html ; GitHub OAuth apps — https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Passkey PRF status — https://www.corbado.com/blog/passkeys-prf-webauthn ; https://chromestatus.com/feature/5138422207348736
- Electron configureWebAuthn PR — https://github.com/electron/electron/pull/51255
- SimpleWebAuthn — https://github.com/MasterKale/SimpleWebAuthn
- Magic links vs scanners — https://github.com/nextauthjs/next-auth/issues/1840 ; https://forum.ghost.org/t/magic-links-don-t-work-when-outlook-safe-links-are-enabled/18033
- OWASP Password Storage — https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Electron safeStorage — https://www.electronjs.org/docs/latest/api/safe-storage ; fuses — https://www.electronjs.org/docs/latest/tutorial/fuses ; Electron 43 — https://www.electronjs.org/blog/electron-43-0 ; BoringSSL — https://github.com/electron/electron/issues/20204
- Node 24.7 (argon2) — https://nodejs.org/en/blog/release/v24.7.0
- WebCrypto Ed25519 — https://chromestatus.com/feature/4913922408710144 ; https://blogs.igalia.com/jfernandez/2025/02/28/can-i-use-secure-curves-in-the-web-platform/
- Cloudflare: DO pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/ ; DO limits — https://developers.cloudflare.com/durable-objects/platform/limits/ ; DO WebSockets — https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ; DO SQLite/PITR — https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ; Workers pricing — https://developers.cloudflare.com/workers/platform/pricing/ ; R2 — https://developers.cloudflare.com/r2/pricing/ ; D1 limits — https://developers.cloudflare.com/d1/platform/limits/ ; D1 Time Travel — https://developers.cloudflare.com/d1/reference/time-travel/ ; Rate limit binding — https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ ; Turnstile — https://developers.cloudflare.com/turnstile/plans/ ; Email Service — https://developers.cloudflare.com/email-service/platform/pricing/ ; Realtime TURN — https://developers.cloudflare.com/realtime/turn/ ; Access JWT — https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- WAICT — https://blog.cloudflare.com/improving-the-trustworthiness-of-javascript-on-the-web/ ; Code Verify — https://engineering.fb.com/2022/03/10/security/code-verify/
- Anthropic Consumer Terms — https://www.anthropic.com/legal/consumer-terms ; Claude Code legal — https://code.claude.com/docs/en/legal-and-compliance
- OpenAI Terms of Use — https://openai.com/policies/row-terms-of-use/ ; Codex auth — https://learn.chatgpt.com/docs/auth ; Sign in with ChatGPT (secondary) — https://thenewstack.io/sign-in-with-chatgpt/
- RFC 9700 — https://www.rfc-editor.org/rfc/rfc9700.html
- Claude Code refresh races — https://github.com/anthropics/claude-code/issues/43392 ; https://github.com/anthropics/claude-code/issues/88583 ; https://github.com/anthropics/claude-code/issues/24317 ; Codex `refresh_token_reused` — https://github.com/openclaw/openclaw/issues/26322
- WebKit Web Push — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ ; storage cap — https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ; separate storage — https://bugs.webkit.org/show_bug.cgi?id=181849 ; EU reversal — https://techcrunch.com/2024/03/01/apple-reverses-decision-about-blocking-web-apps-on-iphones-in-the-eu/
- RFC 8291 — https://www.rfc-editor.org/rfc/rfc8291.html ; RFC 8827 — https://www.rfc-editor.org/rfc/rfc8827.html
- OpenSSH 9.5 — https://www.openssh.org/txt/release-9.5 ; ssh-keygen certificates — https://man.openbsd.org/ssh-keygen#CERTIFICATES
- GDPR Art. 3 — https://gdpr-info.eu/art-3-gdpr/ ; Art. 12 — https://gdpr-info.eu/art-12-gdpr/ ; Art. 33 — https://gdpr-info.eu/art-33-gdpr/
- OAIC small business — https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business ; NDB — https://www.oaic.gov.au/privacy/notifiable-data-breaches/about-the-notifiable-data-breaches-scheme
