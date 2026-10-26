# Other devices from the remote website

The account website opens directly to your online computers and their shared running sessions. Pick a session to open its terminal; Back returns to the computer list. On a computer-specific website, open **Devices** in the home toolbar: its first card is the computer serving that website, and the other cards are your online computers.

Choose **Account → Pair phone to account** in the phone menu for a link independent of any desktop. With the updated Hub and account website deployed, the phone joins as its own remote-only device and connects directly to any online computer. The computer that created the QR can then shut down. See [account remote availability](remote-resilience.md) for rollout and revocation.

The target computers must be signed into your Stoke Hub account, approved in the same vault, have Stoke open and **Let my other devices see and open my sessions** enabled under **Accounts → Devices & sync**. They do not need their own public Phone access URL. The **This computer** link still serves the website through one desktop and requires that desktop to remain online.

Opening a session uses the existing encrypted device relay. The target computer keeps its normal approval prompt and saved permissions. On the account website the prompt names the paired phone, which holds its own restricted browser identity and no vault key. On a computer-specific website the prompt names its serving computer, whose Hub credentials stay on that computer. A view-only permission lets you watch; a full permission enables typing and terminal controls.

The terminal names the target device throughout. It supports the [function keys and modifiers](remote-keyboard.md), ordinary typing, paced message submission and interruption. Fit to phone is available when the target grants control and supports remote resizing. This view opens running sessions; file transfer, starting or resuming sessions and past chat history remain on the device's own website or desktop app.

Remote drafts belong to both a device and a session. A disconnected or view-only connection keeps unsent text in the composer and never queues it for a later connection. **Try again** reconnects after a refusal or a lost relay. Leaving the page closes only that browser's relay; the target session and any desktop connection keep running.

If a device is missing, check that Stoke is running there, it is approved in the account vault and connected to the Hub, and the browser has an account connection. A computer-specific website additionally needs its serving computer online. A card saying sharing is off needs the sharing switch enabled on that target. Removing a device or signing out takes away its relay access.
