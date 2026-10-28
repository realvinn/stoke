# Remote terminal keys

Open a session in Stoke's remote website and tap the keyboard button beside the message field. A compact quick row also appears while typing: **Esc, Tab, ↑, ↓, Enter and More**. The expanded panel opens only when you tap **More**; it does not grow automatically when the message field gains focus.

Swipe down over the terminal to see earlier output; swipe up to return toward
newer output. Full-screen agents that request mouse scrolling receive these
swipes as scroll events, without taking focus from the message field. Ordinary
terminal history (a shell, an agent that is not full screen, a view-only
session) scrolls under the same swipe. Swipe sideways to pan a desktop
layout wider than the phone. You can also open **More → Navigate** and use **Pg up / Pg dn**;
those send Page Up/Down keys, which the running program handles.

Tap **Shift**, then **←** to send Shift+Left to Codex or the remote program. Shift releases after that key. Double-tap Shift to lock it for several keys; tap a locked modifier once to release it. Ctrl and Alt work the same way. You can also hold a modifier with one finger while tapping a key with another.

Hold an arrow or Backspace to repeat. Releasing or changing a held modifier stops repetition; press the arrow again to use the new combination. Modifier state clears when the controls close, the page loses focus, or the connection drops. Keys are sent only to a connected session and are never queued for reconnect.

**More** opens a fixed-size panel with four groups. Only one group is shown at a time:

| Group | Keys |
| --- | --- |
| Navigate | All four arrows, Home, End, Page Up/Down |
| Shortcuts | Shift+Tab and Ctrl+C/R/L |
| F keys | F1–F12 |
| Edit | Backspace, Insert, Delete and Ctrl+D |

Shift, Ctrl and Alt stay above the selected group. Modifiers combine with function keys, so Shift → F2 sends Shift+F2. Ctrl+D requires a second deliberate tap because it can end a shell. Closing the panel clears its modifiers; switching groups keeps a selected modifier available. The panel adapts to landscape screens without adding a sideways key scroller.

Modifiers apply to the bar's arrows, navigation and function keys. Text typed into the message field stays ordinary text. Dedicated Shift+Tab and Ctrl shortcut buttons always send their labeled combination.

Common Byobu tmux defaults:

| Action | Keys on the bar |
| --- | --- |
| New window | F2 |
| Previous / next window | F3 / F4 |
| Split into panes above / below | Shift → F2 |
| Split into panes side by side | Ctrl → F2 |
| Move between panes | Shift → arrow |
| Detach and log out | F6 |
| Detach without logging out | Shift → F6 |

Byobu can customize these bindings. Its [default tmux key bindings](https://github.com/dustinkirkland/byobu/blob/master/usr/share/byobu/keybindings/f-keys.tmux) are the reference.

The remote website is served by the Stoke host. Install the version containing these controls on that host, then reload the remote page; its service worker picks up the changed asset build. Updating only the browser device does not replace an older host's website.

## Draft recovery

Unsent composer text is checkpointed in this browser after roughly ten changed
characters or 500 ms of idle time. Blur, hiding or leaving the page, and closing
the session view flush committed text too. IME candidates are checkpointed after
composition ends. A hard power loss can still lose edits since the last
checkpoint, and browser/OS disk writes are best-effort.

Reopening the same conversation restores its latest unsent draft. When a host
restart changes the terminal ID, conversation identity is used where available;
**Recovery** also lists saved drafts from older sessions for manual restoration.
A draft from another session requires confirmation. Other browser tabs keep
separate versions, and restoring over text you are editing backs that text up
first. Deleting or handing a message to the socket clears the active draft.
Socket handoff is not an application delivery acknowledgement: check the chat
before sending recovered text.

Offline messages explicitly queued during the current visit keep their existing
reconnect behavior. Their recovery copies are available manually after a reload;
recovered messages are never automatically re-queued or sent.

Recovery text stays in this browser's local storage, without cloud syncing or
encryption. Records expire after 14 days and are cleaned up when recovery is
used again. A browser clearing its data, private browsing, blocked storage or a
full quota can prevent recovery. A visible save error leaves editing available;
copy the text before closing that page. Prompts over 100,000 characters remain
editable but exceed the local recovery limit.

Desktop remote tabs also keep an offline text draft locally, using the same
10-character/500 ms checkpoint policy. Reconnecting never replays terminal keys.
Choose **Insert into agent** to place the saved text in the remote input without
pressing Enter; review it before submitting. A watch-only grant and older hosts
without text-only insertion cannot insert drafts.

Activity uses a pulsing warning-colour dot for active work and a solid dot for a
blocking question. Codex nonblocking follow-up questions keep pulsing. Remote
hosts transmit activity with their session status; older hosts leave it unknown.
SSH falls back to recognised visible agent footer controls because its native
registry lives on the other computer; unfamiliar or missing controls stay unknown.

The session list now checks that the host still answers even when its socket
claims to be open. Reads time out after 12 seconds, a stalled connection retries,
and waking after more than 10 seconds replaces a potentially stale list socket.
The list becomes live after its first session frame, rather than on the socket
handshake alone. See [remote availability](remote-resilience.md) for the boundary
between reconnecting to one host and moving the account's gateway to another.
