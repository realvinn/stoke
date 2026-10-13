# Sync saved agent accounts

This feature requires Stoke **1.0.0-beta.8 or later on both computers**. Beta.7 does not include it.

1. Sign in to the same Stoke account on both computers.
2. Create the encrypted vault on one computer if you have not already. Approve the other device, comparing the six-digit code on both screens, or join using your Recovery Kit.
3. Open Settings → Accounts → Stoke account → Manage account & sync.
4. Enable **Sync agent accounts across devices**. This is an account-wide opt-in and starts off.
5. Leave **Accounts on this computer** enabled on each participating device, then press **Sync now** on both.
6. Select the received profile under Settings → Accounts → Codex, or in the launcher. Existing sessions keep their original account.

Named agent profiles, their API keys and provider settings travel through a separate encrypted account tier. Compatible Codex `auth.json` file-cache sign-ins travel too. A receiving computer creates its own managed account home; it keeps its existing Default login and selected account. A source Default Codex file login appears as an additional profile named “Codex · computer name”. Duplicate nicknames stay separate. Stoke does not transfer source folder paths, CLI configuration, chat history or OS keychain blobs.

Codex keyring, auto and ephemeral credential stores are not exported as portable file logins. Other native agent logins, including Claude subscription logins, sync profile details and require sign-in on each computer. Compatible Codex file caches are documented as portable between trusted computers in [OpenAI's authentication guide](https://learn.chatgpt.com/docs/auth). Codex may refresh or expire credentials, and administrator authentication policies still apply. Stoke defers an imported credential update while that profile has a running CLI session; a newer local refresh is preserved.

Grok Bot's saved production gateway sessions sync, including five or more separate profiles. Each recipient seals them with its own OS key store. Enable the Grok Bot plugin separately, install its reviewed runtime if needed, then select a saved account in its panel. A nickname identifies each session; the gateway does not provide a verified email. See [Grok Bot setup](plugins.md#grok-bot-accounts).

**API keys, for the whole account** is the existing switch for general provider, endpoint, speech and MCP keys. **Sync agent accounts across devices** separately controls saved account credentials. A device can pause account uploads/imports without removing accounts already received. Turning account sync off retains existing copies. Removing a synced saved profile removes its selectable counterpart on other participating devices but retains native login files for existing sessions. Signing out or revoking a Stoke device cannot revoke credentials it already received; rotate those credentials at their provider if necessary.

The Hub stores opaque encrypted envelopes. Account logins and Grok routing credentials stay in the main process. The local mapping and deferred credentials are OS-encrypted in `hub-accounts-<vault-hash>.json`, separately bound to each Stoke vault.
