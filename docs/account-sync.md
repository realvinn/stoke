# Sync saved agent accounts

This feature requires Stoke **1.0.0-beta.8 or later on both computers**. Beta.7 does not include it.

The bottom of the sidebar has one compact **Stoke account** entry showing your email, or **Sign in to Stoke**. Its menu separates Stoke device sync from the current agent session. **Agent accounts** opens the directory of saved agent logins and API profiles; **Devices & sync** opens your Stoke setup. Grok Bot appears in the directory only while its plugin is enabled. When the sidebar is hidden, use Settings → Accounts. Account choices marked **New sessions** do not change an already running session.

1. Sign in to the same Stoke account on both computers.
2. Create the encrypted vault on one computer if you have not already. Approve the other device, comparing the six-digit code on both screens, or join using your Recovery Kit.
3. Open the Stoke account menu → Devices & sync, or Settings → Accounts → Stoke account.
4. Enable **Sync agent accounts across devices**. This is an account-wide opt-in and starts off.
5. Leave **Accounts on this computer** enabled on each participating device, then press **Sync now** on both.
6. Select the received profile under Settings → Accounts → Codex, or in the launcher. Existing sessions keep their original account.

Named agent profiles, their API keys and provider settings travel through a separate encrypted account tier. Compatible Codex `auth.json` file-cache sign-ins travel too. A receiving computer creates its own managed account home; it keeps its existing Default login and selected account. A source Default Codex file login appears as an additional profile named “Codex · computer name”. Duplicate nicknames stay separate. Stoke does not transfer source folder paths, CLI configuration, chat history or OS keychain blobs.

Codex keyring, auto and ephemeral credential stores are not exported as portable file logins. Other native agent logins, including Claude subscription logins, sync profile details and require sign-in on each computer. Compatible Codex file caches are documented as portable between trusted computers in [OpenAI's authentication guide](https://learn.chatgpt.com/docs/auth). Codex may refresh or expire credentials, and administrator authentication policies still apply. Stoke defers an imported credential update while that profile has a running CLI session; a newer local refresh is preserved.

Grok Bot's saved production gateway sessions sync, including five or more separate profiles. Each recipient seals them with its own OS key store. Enable the Grok Bot plugin separately, install its reviewed runtime if needed, then select a saved account in its panel. A nickname identifies each session; the gateway does not provide a verified email. See [Grok Bot setup](plugins.md#grok-bot-accounts).

**API keys, for the whole account** is the existing switch for general provider, endpoint, speech and MCP keys. **Sync agent accounts across devices** separately controls saved account credentials. A device can pause account uploads/imports without removing accounts already received. Turning account sync off retains existing copies. Removing a synced saved profile removes its selectable counterpart on other participating devices but retains native login files for existing sessions. Signing out or revoking a Stoke device cannot revoke credentials it already received; rotate those credentials at their provider if necessary.

The Hub stores opaque encrypted envelopes. Account logins and Grok routing credentials stay in the main process. The local mapping and deferred credentials are OS-encrypted in `hub-accounts-<vault-hash>.json`, separately bound to each Stoke vault.

## When the hub is full

Each account on a Stoke Hub may keep a set amount of synced data: 25 MB unless the hub's owner chose otherwise (`STOKE_HUB_STORAGE_CAP`, or `stoke-hub storage <email> --cap 100M` for one account; see `hub/README.md`). **What syncs** in Devices & sync shows it as `Storage: 1.2 MB of 25 MB`. When a change would go past it, the hub refuses that change only, and everything else still syncs. The panel then says **hub full** and how many changes are waiting. They stay on this computer and go up at the next sync after there is room. To make room, remove something you sync (an SSH host, an SSH key, an API key, a saved account), or ask the hub's owner for more. Deleting always works, even on a full account. Stoke before beta.20 does not show the figure; it logs the refusal and tries again at its next sync.

## Keep a connection log

If a remote tab to one of your other computers keeps dropping or reconnecting, turn on **Keep a connection log** under Settings → Accounts → Stoke → **Other machines**. It is off by default, it is this computer's own setting and is never synced, and it takes effect at once. While on, it records when this computer's connections to your other computers open, drop and reconnect, from both sides (opening a tab there, and serving one from here), plus when this computer sleeps, wakes or locks its screen. A line holds only times, counts, byte totals, close codes, short reason tags, a relay's random id, and the first five characters of a device id. It never records what you type or see in a session, session titles, folder or computer names, your email, the hub's address, keys or passwords. The file is `connections.log` in Stoke's settings folder (on a Mac, `~/Library/Application Support/stoke/`; a full file moves to `connections.log.1`, so at most about 2 MB are kept). Once it exists, **Show log file** opens its folder and **Copy log** puts both files on the clipboard. A drop can only be explained from both ends, so turn it on on the other computer too and send both logs. Turning it off stops the writing at once and keeps the file; delete it yourself if you like. This needs beta.20 or later on the computer keeping the log.
