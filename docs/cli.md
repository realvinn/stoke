# Stoke from a terminal

The `stoke` command controls the desktop app. `stoke .` opens your working folder, `stoke --cli codex` selects a coding agent, and `stoke --help` lists the available commands. The desktop app needs a graphical session; Stoke does not currently provide a headless Hub login or remote-host daemon for a plain SSH terminal.

## Sign in and connect your devices

Run `stoke login` to open the existing **Stoke sign-in and device sync** settings. Sign in there, then approve this computer from an existing device or use your Recovery Kit. On a first computer, create your vault and save its Recovery Kit. The command never takes your password or access keys on the command line.

Stoke sign-in connects your computers. Coding-agent sign-ins are separate: use the agent account manager, or `stoke account add codex work` / `stoke account add claude personal` to create a named agent account and open its sign-in tab. `stoke account list` and `stoke account env NAME` are available in the macOS and Windows command shims. They refer to coding-agent accounts, not your Stoke account.

## Open Stoke from a phone or another browser

On the computer running your sessions, run `stoke remote`. In **Phone access**, press **Open on phone**, choose how you reach the computer (same Wi-Fi, Tailscale or a configured tunnel), then scan the QR code or use **Copy link**. Keep Stoke running on that computer. The copied URL includes a phone access key; share it only with someone you intend to give session access to. A configured Cloudflare Access policy also requires its normal browser sign-in.

The phone link is separate from Stoke sign-in. To reach your other approved computers through that website, open **Devices** and enable session sharing on those computers. See [Other devices from the remote website](remote-devices.md).

For a VPS you use through SSH, add the VPS under Stoke's **SSH hosts** settings and open a session there. The desktop computer remains the website host; you do not need to install a graphical Stoke app on the VPS just to use its terminal remotely.

## Pick the beta installer

macOS, Linux and Git Bash:

```sh
curl -fsSL https://stoke.vinn.dev/install.sh | sh -s -- --beta
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://stoke.vinn.dev/install.ps1))) -Beta
```

For an automation using the ordinary PowerShell pipe, select the channel explicitly and remove it afterwards:

```powershell
$env:STOKE_CHANNEL='beta'
irm https://stoke.vinn.dev/install.ps1 | iex
Remove-Item Env:STOKE_CHANNEL
```

The stable installer remains the default. Beta selection checks the latest 100 published GitHub releases, picks the highest supported beta version, then verifies its ordinary platform manifest and SHA-512 before installing. If lookup fails, it stops instead of changing to stable. An exact `STOKE_VERSION` overrides beta selection. These flags select an installer release; `stoke --beta` is not a desktop launch option. To receive future betas through the app updater, enable beta releases under **Settings → Updates**.

Run installers in a terminal outside Stoke because a macOS or Windows replacement may close the installed app and its sessions. Selecting beta does not change your agent's release channel.
