# Resume Codex after a usage reset

Available in Stoke **1.0.0-beta.10** under **Settings → Agents → Codex → Resume after a usage reset**.

Enable the watcher, choose how often to check (five minutes by default), and set the message to send (`Continue` by default). After sending, Stoke waits five hours before checking that tab again; this delay is editable too.

At a scheduled check, Stoke reads the local Codex terminal's current screen. If it shows Codex's usage-limit error and its reset date/time, Stoke waits until that time has passed before submitting your message. Dates use the computer's local timezone, as Codex does; explicit ISO timezone offsets are also supported. An unreadable or missing reset time never triggers a message.

The next check stops monitoring that tab if Codex is still working, has finished normally, or no longer shows a usage-limit error. If Codex hits a new limit, the same wait-and-resume cycle can run again. A closed tab is removed. Typing while the watcher is waiting on a detected limit, or after it has resumed a turn, cancels that tab's watcher; it also refuses a composer containing a draft message. Turn the setting off and back on to rearm stopped tabs.

Keep Stoke open. This is a local timer independent of the Codex model's budget; it uses no OpenRouter key or paid model calls. It checks existing local Codex agent tabs only, including background tabs. It excludes private chats, SSH sessions, sign-in tabs and installers. Closing Stoke ends its watchers; reopened sessions receive new checks when resumed. Sleep delays checks until the computer wakes.

This resumes a conversation in place after its stated reset. It does not change the account, buy credits, bypass a limit, or decide whether a task is complete.
