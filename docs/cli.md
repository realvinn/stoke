# Stoke from a terminal

The [terminal unifier preview](terminal.md) runs inside your terminal with `/agent`, `/models`, `/chats`, `/config` and `/remote`. From this checkout, run `npm run terminal`; `npm run pack:terminal` builds an independent Node package without Electron. New macOS builds make `stoke` enter that shell and accept `stoke --desktop …` for graphical commands. Published installers still install the released desktop builds; their launchers keep the behavior described below. Windows/AppImage desktop launchers have not switched to the terminal preview.

In published builds, `stoke .` opens your working folder in the desktop app, `stoke --cli codex` selects a coding agent, and `stoke --help` lists commands. The desktop app needs a graphical session. The terminal preview supports native agent logins, OpenCode server attachment and SSH connections; it does not yet provide headless Stoke Hub login or a phone-sharing daemon. In new macOS builds, prefix the desktop commands below with `stoke --desktop` (for example `stoke --desktop login` and `stoke --desktop remote`). `/remote` inside the terminal is a client connection, separate from desktop Phone access.

## Sign in and connect your devices

The `stoke login` and `stoke remote` shortcuts below arrive in the next desktop beta. In beta.13, open the same settings from Stoke's sidebar and Settings.

Run `stoke login` to open the existing **Stoke sign-in and device sync** settings. Sign in there, then approve this computer from an existing device or use your Recovery Kit. On a first computer, create your vault and save its Recovery Kit. The command never takes your password or access keys on the command line.

Stoke sign-in connects your computers. Coding-agent sign-ins are separate: use the agent account manager, or `stoke account add codex work` / `stoke account add claude personal` to create a named agent account and open its sign-in tab. `stoke account list` and `stoke account env NAME` are available in the macOS and Windows command shims. They refer to coding-agent accounts, not your Stoke account.

## Open Stoke from a phone or another browser

On the computer running your sessions, run `stoke remote`. In **Phone access**, press **Open on phone**, choose how you reach the computer (same Wi-Fi, Tailscale or a configured tunnel), then scan the QR code or use **Copy link**. Keep Stoke running on that computer. The copied URL includes a phone access key; share it only with someone you intend to give session access to. A configured Cloudflare Access policy also requires its normal browser sign-in.

The phone link is separate from Stoke sign-in. To reach your other approved computers through that website, open **Devices** and enable session sharing on those computers. See [Other devices from the remote website](remote-devices.md).

For a VPS you use through SSH, add the VPS under Stoke's **SSH hosts** settings and open a session there. The desktop computer remains the website host; you do not need to install a graphical Stoke app on the VPS just to use its terminal remotely.

## Pick the beta installer

macOS, Linux and Git Bash:

```sh
curl -fsSL https://stoke.vinn.dev/install-beta.sh | sh
```

Windows PowerShell:

```powershell
irm https://stoke.vinn.dev/install-beta.ps1 | iex
```

These URLs reuse the ordinary installers with beta selected. For existing automation, `install.sh --beta`, `install.ps1 -Beta` and `STOKE_CHANNEL=beta` remain supported.

The ordinary installer URLs still select stable. Beta selection checks the latest 100 published GitHub releases, picks the highest supported beta version, then verifies its ordinary platform manifest and SHA-512 before installing. If lookup fails, it stops instead of changing to stable. An exact `STOKE_VERSION` overrides beta selection. The beta URLs select an installer release; `stoke --beta` is not a desktop launch option. To receive future betas through the app updater, enable beta releases under **Settings → Updates**.

Run installers in a terminal outside Stoke because a macOS or Windows replacement may close the installed app and its sessions. Selecting beta does not change your agent's release channel.
