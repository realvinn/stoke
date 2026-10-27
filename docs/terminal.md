# Stoke terminal preview

Stoke is a terminal shell around your installed coding agents. **F5** opens the
Stoke menu from inside an agent: searchable chats on the left, selected chat
details and shortcut hints on the right, plus Agents and Connections sections.
Press F5 or Escape again to return to the same running chat. Type a message,
pick an agent with `/agent`, choose a model with `/models`, and switch chats
without closing the agent processes. OpenCode stays OpenCode: its own interface,
login, providers, tools, permissions, MCP and slash commands run inside Stoke.
Stoke does not replace those agents with an API chat client.

Standalone CLI archives are published with beta releases for macOS, Windows
and Linux on x64 and ARM64. The website’s ordinary installers still install
the desktop app; Windows and Linux desktop launchers keep their graphical
behaviour. Use a standalone CLI archive for a headless machine.

## Run from this checkout

Use Node.js 22.18 or newer and install the repository dependencies first:

```sh
npm run terminal
npm run terminal -- --cli opencode .
```

`npm link` makes this checkout's terminal runner available as `stoke` on PATH.
The Node runner also works on a headless Linux host; it needs no Electron window.

`npm run pack:terminal` creates an independent npm tarball in `out/cli-release`.
That package contains the terminal bundle and depends only on the native PTY
package. It has no Electron dependency. Install the generated tarball with
`npm install -g /absolute/path/to/the-generated.tgz`. Installing the native PTY
dependency requires registry access. This does not publish anything.

New macOS desktop builds also include this terminal: the existing `stoke` shim
enters it directly with the bundled runtime. `stoke --desktop .` explicitly opens
the desktop app. The Windows and AppImage desktop launchers retain their desktop
behavior in this preview; use the standalone Node package for terminal use there.
Windows npm `.cmd` shims are resolved to their JavaScript entry points; other
batch launchers use Windows argument escaping.

`npm run dist:terminal` builds a portable archive for the current native target,
with a checksum-verified Node runtime and matching PTY binary. Supported build
targets are macOS, Windows and Linux, each on x64 and ARM64. Linux currently
targets glibc; musl and older 32-bit ARM are deferred. Agent vendors have their
own platform requirements. Local validation uses macOS ARM64; release CI builds and verifies all six
targets natively, including running each extracted CLI package.

Extract the archive and run its `stoke` or `stoke.cmd` directly, with no system
Node installation. `install.sh` installs a versioned copy under `~/.local/share`
and a launcher under `~/.local/bin`; `install.ps1` uses LocalAppData and the user
PATH. Run the installer from a newer extracted archive to switch versions.
These are offline installers; download a newer release archive to update.
Automatic CLI updates are not enabled. Uninstalling preserves configuration and chat metadata.

## Linux as root or over SSH

The standalone CLI runs as root without Electron or Chromium. A message saying
“running as root, so Chromium sandbox is off” comes from the **desktop** launcher:
it is a warning, not a startup refusal, but that app still needs a graphical session.
Adding `--cli claude` to the Linux desktop launcher selects an agent in the app;
it does not turn that launcher into the standalone terminal UI.

For beta 18 on Linux x64, run these in the root shell:

```sh
curl -fLO https://github.com/realvinn/stoke/releases/download/v1.0.0-beta.18/stoke-cli-1.0.0-beta.18-linux-x64.tar.gz
curl -fLO https://github.com/realvinn/stoke/releases/download/v1.0.0-beta.18/stoke-cli-1.0.0-beta.18-linux-x64.tar.gz.sha256
sha256sum -c stoke-cli-1.0.0-beta.18-linux-x64.tar.gz.sha256
tar -xzf stoke-cli-1.0.0-beta.18-linux-x64.tar.gz
./stoke-cli-1.0.0-beta.18-linux-x64/stoke
```

For `aarch64`/`arm64` (`uname -m`), replace `linux-x64` with `linux-arm64`.
The package includes its Node runtime; root uses its own Stoke configuration
and coding-agent sign-ins. `./install.sh` inside the extracted archive installs
it permanently; if a desktop `stoke` command already occupies `~/.local/bin`,
choose a separate `STOKE_BIN_DIR` rather than silently overwriting it.

## Navigation

You do not need to exit Claude or any other agent to switch. Press F5 (Fn+F5
on Macs that reserve the function row for system controls). Type to search,
use Up/Down to select and Enter to open. Tab cycles Chats, Agents and Connections.
Ctrl+F selects chats, Ctrl+G agents, Ctrl+R connections, Ctrl+S Settings and Ctrl+N starts a chat
with the currently selected agent. Choosing an agent starts a separate native
session and preserves your running chats. Press `/` with an empty menu search
to open the command prompt. `/menu` also opens this navigation.

The workspace includes **Chats, Agents, Models, Connections, Settings and Help**.
Chat rows show their agent and whether the session is running; details wrap in
the right pane. Tab and Shift+Tab move between sections. Ctrl+U clears a search.
Ctrl+P opens a searchable command palette from the Stoke prompt or menu.
Inside an agent, open F5 first so the agent retains its own Ctrl+P binding.

In **Settings**, edit the default agent and selected agent's default model,
switch between Ember, Ocean and your terminal's own colors, choose whether to
start at the composer or menu, and reload the config file. Changes are saved
locally and preserve other settings. `NO_COLOR` disables color styling.
Settings also offers F6 or Ctrl+Backslash as an additional menu shortcut;
F5 remains available.

In **Connections**, choose **Add connection…** or press Ctrl+A. Enter a name,
choose `ssh` or `opencode` with Left/Right, and enter the host/SSH config alias or
HTTP(S) server URL. Tab moves between fields; Ctrl+S saves; Escape cancels.
Text fields support paste, Left/Right, Home/End, Backspace and Ctrl+U to clear.
Select an existing connection and press Ctrl+E to edit or Ctrl+D to remove its
saved entry. Removing an entry leaves its running session open. Enter connects.
Ctrl+T checks TCP reachability. It does not authenticate or verify application
health; SSH proxy and jump routes are reported as requiring an actual connection.

In **Models**, choose an existing shortcut or **Add a model…** to save a model
ID. Selection applies to the next chat; it does not change a running agent.

Type a message to start an interactive Claude Code, Codex or OpenCode chat.
For the other registered agents, `/new` opens their real interface, where you can
type the first message. Their startup prompt flags have not been adapted yet.

| Stoke command | Behavior |
| --- | --- |
| `/agent` or `/agent opencode` | List agents and PATH availability, or select an agent for the next chat |
| `/models` or `/models provider/model` | Show configured model shortcuts, or set the next chat's model |
| `/models default` | Let the agent choose its model |
| `/new` | Open a new native agent session |
| Left on an empty Stoke prompt | Show older Stoke terminal chats |
| `/chats` or `/search words` | List or filter chat titles, agents and folders |
| `/attach 2` | Return to a running chat, or resume a saved chat with a recorded native ID |
| `/resume NATIVE_ID` | Resume an exact agent session where the shared agent definition supports it |
| `/continue` | Open the selected agent's latest conversation in this folder |
| `/remote` or `/remote lab` | List configured connections, or connect to one |
| `/settings` | Open editable defaults, appearance and startup settings |
| `/connections` | Open the connection manager |
| `/config`, `/config reload` | Show the file path/example, or reload validated settings |
| `/stop 2` | Stop a running chat listed by `/chats` |
| `/commands` | Open the command palette |
| `/quit` or `/detach` | Exit the interface and leave agent sessions running |

Press **F5** inside an agent to open the menu, or **Ctrl+]** for the Stoke command
prompt. That chat keeps running.
Use `/chats` and `/attach NUMBER` to return to it. While the agent owns focus,
Left edits its input and `/models` belongs to the agent. Stoke's slash commands
are available at the Stoke prompt. Tab completes Stoke commands; Up/Down recall
commands. Bracketed paste remains text, including control characters in a paste.

Changing agents starts a separate conversation. It does not copy one agent's
context into another agent. A selected model applies to the next launch;
live model changes belong to the agent's own commands. Model shortcuts are
user-configured, not a claimed live catalog of vendor entitlements.

## Configuration

Create `~/.stoke/config.json` with `stoke config init`. This creates a private
file and refuses to overwrite an existing one. `--config FILE` or `STOKE_CONFIG`
selects a different file. Configuration is global; project files cannot silently
replace the executable Stoke launches.

```json
{
  "version": 1,
  "agent": "opencode",
  "ui": { "theme": "ember", "startup": "composer", "menuKey": "f5" },
  "agents": {
    "opencode": {
      "model": "",
      "models": [],
      "args": []
    },
    "claude": {
      "model": "",
      "models": [],
      "args": []
    }
  },
  "remotes": {
    "lab": { "kind": "ssh", "host": "my-ssh-config-alias" },
    "server": { "kind": "opencode", "url": "https://opencode.example.com" }
  }
}
```

An agent entry can also specify `executable` as an absolute path to its binary.
`args` are passed as separate arguments, without shell evaluation. Put native
provider and MCP configuration in that agent's own config file. Sign in inside
the agent using its supported flow; Stoke inherits the launching shell's normal
environment and uses vendor credential stores. This preview does not read or
migrate the desktop's encrypted vault or named accounts.

`/remote server` runs `opencode attach URL`, using the local OpenCode client.
OpenCode's `OPENCODE_SERVER_PASSWORD` environment variable works for authenticated
servers. `/remote lab` runs `ssh -t HOST stoke`; the remote host must already have
the terminal command on PATH. These are client connections, not a Stoke phone
server, tunnel or headless Hub login. They do not start a network listener.

## Persistence and current limits

Metadata lives under `~/.stoke/terminal/chats`, one private file per chat.
`STOKE_TERMINAL_HOME` overrides that directory. Vendor credentials and transcripts
stay in their original locations. A per-user background service owns the live
PTYs. Quitting or closing the interface leaves those agents running, and another
Stoke invocation can attach to them. One attached terminal owns keyboard input
at a time. The local service uses a private Unix socket or Windows named pipe
and an authentication token; it opens no TCP listener. It exits after 30 seconds
with no connected interfaces or running agents. Restarting the service or OS
ends its agent processes.

Use `stoke sessions [--json]`, `stoke attach ID`, and
`stoke server start|status|stop` from scripts or a normal shell. `server stop`
ends all service-owned agents; `/stop` ends one chat. `stoke doctor [--json]`
checks config validity, agent paths, runtime, native PTY operation and service
status without dumping credentials, environment variables or transcripts.
`stoke connect NAME --check [--json]` checks a saved connection's TCP endpoint.

Claude sessions started with `/new` or an initial message record an exact native
ID and can be resumed after restart. OpenCode, Codex and other agents' newly
created native IDs are not observed yet: their saved metadata is searchable, but
use `/continue` or `/resume NATIVE_ID` to reopen the vendor conversation. A live
chat owned by the service can be attached again without relaunching it.
Imported desktop chats and full transcript search are not implemented yet.

Still to build: a common Stoke transcript/composer UI across agent protocols,
native session discovery for the remaining agents, desktop history/account
integration, Hub/device login and Stoke phone sharing,
a published terminal installer. The current shell hands
focus to each vendor's native interface rather than normalizing its messages.

`npm run verify:terminal` checks real PTY routing with fake agents, config
validation, native argument plans, Unicode editing, paste, resize, live chat
switching, resume metadata, service authentication and detach/reattach. It makes
no provider requests. `verify:terminal-platform` checks executable arguments and
platform helpers; `verify:terminal-release` extracts the portable archive and
checks its bundled runtime, real PTY UI and installer. Native CI runs these on
all six targets. Actual vendor login and remote authentication remain separate.

The bare `/agent`, `/models`, and `/remote` commands open searchable pickers.
`/agent ID`, `/models ID`, and `/remote NAME` still accept direct selections.
Left on an empty Stoke prompt opens chat search; Tab on an empty prompt or `/`
opens the command picker. Multiline pastes keep their line breaks (shown as `↵`
in Stoke's one-row prompt), and failed launches leave the prompt available to edit.
