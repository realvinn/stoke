# Remote terminal keys

Open a session in Stoke's remote website and tap the keyboard button beside the message field. The bar also appears while typing. Its main controls contain Escape, Tab, all four arrows and Enter.

Tap **Shift**, then **←** to send Shift+Left to Codex or the remote program. Shift releases after that key. Double-tap Shift to lock it for several keys; tap a locked modifier once to release it. Ctrl and Alt work the same way. You can also hold a modifier with one finger while tapping a key with another.

Hold an arrow or Backspace to repeat. Releasing or changing a held modifier stops repetition; press the arrow again to use the new combination. Modifier state clears when the controls close, the page loses focus, or the connection drops. Keys are sent only to a connected session and are never queued for reconnect.

Tap **F1–F12** to show the function keys. Modifiers combine with them, so Shift → F2 sends Shift+F2. **More** contains Home, End, Page Up/Down, Insert, Delete, Backspace, Shift+Tab, Ctrl+C/R/L and Ctrl+D. Ctrl+D needs a second deliberate tap because it can end a shell. Combinations this bar does not encode ask you to release the modifier. On short landscape screens, opening F1–F12 or More replaces the navigation row until you close that group.

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
