# Native Stoke plugins

Plugin API v1 adds Settings → Plugins. Work and Grok Bot are native integrations; other packages can add text panels with Node.js actions or supported appearance overrides. Packages install disabled. Enabling is explicit, scripts run only on an action, and disabling removes the panel and stops its owned operations. This is separate from an agent's skills, MCP servers and CLI plugins.

The public directory is https://stoke.vinn.dev/marketplace, with a developer guide at /marketplace/sdk. “Open in Stoke” opens a native package review through a strictly validated stoke: link; it never installs or enables code automatically. Catalog packages are compiled from src/shared/pluginPackages.ts. Local creation writes an editable .stoke-plugin.json example to a selected folder. Import applies an edited package; Export produces a shareable copy. Public entries are curated through source review. There is no public upload endpoint.

Local command plugins run with the user's permissions. The declarations `local-code`, `project-context`, and `appearance` describe intent, not an OS sandbox. Scripts receive API version, plugin ID, data directory and optional chosen project through stdin. Stoke strips agent credentials and Node startup injection from the child environment. Output is bounded, commands have a 60-second deadline, and scripts must keep their children in the foreground. Native panels escape text; extensions cannot inject executable HTML or arbitrary CSS. Appearance overrides disappear when disabled. Removing a package preserves its saved data.

## Grok Bot accounts

Grok Bot is distinct from Grok Build's `grok` coding CLI. The native plugin uses the unofficial https://github.com/ScriptedAlchemy/grok-bot-cli, pinned to npm version 0.12.4 and reviewed source 43499fa27f36807f6ac93b56365b3cae5200bc1e. The installer verifies the npm archive SHA-512 and both runtime modules' SHA-256, extracts only reviewed runtime files plus the MIT license, and never runs npm hooks or gbot-install.

1. Install Grok Bot in Settings → Plugins, then enable it and open Details.
2. Install the reviewed CLI from its panel.
3. Sign in to the Grok Bot desktop app, choose an account nickname in Stoke, and press Read desktop sessions. Select the saved session and Import as new account. Repeat for all five accounts. Multiple descriptor slots require an explicit choice.
4. Select a Stoke account and List bots and groups to verify it. Select a bot or group and read its thread or send a message.

An existing desktop login is imported as a separate encrypted snapshot. Stoke never modifies the desktop app's auth. The nickname and gateway host identify the saved session; the gateway descriptor does not provide a verified email. Every command carries the selected gateway URL, token and routing headers explicitly and forces gateway mode, so a change in the desktop app's current login cannot change the active Stoke account.

Saved credentials are not considered verified until an operation succeeds. An authentication refusal marks the account for reconnecting. To reconnect, sign in again in the desktop app, read sessions, select the correct slot and explicitly replace the chosen Stoke account. A send without a confirmed message ID is marked unknown; Stoke does not retry it. Read the thread before resending.

The advanced form accepts a session gateway tuple and routing headers. xAI dashboard API keys do not authenticate Grok Bot. Production gateway destinations are limited to the domains accepted by the pinned CLI. Loopback development requires explicit opt-in. All credential storage requires OS protection: macOS Keychain, Windows DPAPI, or a Linux Secret Service. These plugin accounts are local to the device; they are not currently synced through Stoke Hub.

## SSH routes and Other machines

Settings → SSH hosts offers Find duplicate SSH routes. It compares resolved SSH configuration, preserves different users, ports, keys, proxy/jump settings and host behavior, and requires shared known host keys when endpoints differ. Active-session hosts are excluded. Merging is explicit and keeps the first host's stable ID, chooses a verified Tailscale/DNS alias for fallback when available, and retains alternative alias metadata. A literal direct IP is preferred over a Tailscale address when available.

Preferred direct IP can also be set per host. It changes SSH's Hostname option while retaining the alias's configuration identity. A bounded TCP probe selects the direct IP; if unreachable, Stoke uses the alias. It does not retry authentication failures or accept host keys automatically. Configured proxies/jump hosts retain control of reachability, so the local TCP probe is skipped for those routes. Interactive tabs, transfers, file browsing, managed-session requests and transcript reads use this selection.

“Show under Other machines” explicitly links a saved SSH host to a signed-in Stoke device. The sidebar groups those SSH routes with that device's shared sessions and orders direct IP routes first. Device identity, never a similar label, supplies the association. SSH opens a separate terminal to the machine; existing shared Stoke sessions continue to use their authenticated encrypted Hub relay.

## Account manager direction

The account architecture should distinguish Stoke identity, native agent/subscription logins, and shared API connections. An agent is a client; Anthropic, OpenAI, OpenRouter and custom gateways are providers. The next account improvement is a shared connection registry with compatible per-agent bindings, rather than copies of the same key in several agent profiles. That registry is still pending. Current named API profiles and key-copy flows remain per-agent.

Primary comparisons: [Zed API access](https://zed.dev/docs/ai/use-api-access), [OpenCode v2 provider accounts](https://dev.opencode.ai/v2/docs/cli/providers/), [Claude Code authentication](https://code.claude.com/docs/en/authentication), [Codex authentication](https://learn.chatgpt.com/docs/auth), and [Grok Build](https://docs.x.ai/build/overview). OpenCode v2 documentation is a design reference, not a promise that Stoke's currently detected OpenCode version implements those commands.
