# Account remote availability

The phone menu offers **Account → Pair phone to account**. Its QR opens the
account website at the Hub origin's `/remote/`, independent of the computer
that created the QR. Bookmark that page after pairing. The phone connects
through the Hub directly to the selected online computer's encrypted relay.
Turning off the issuing laptop does not interrupt a work-PC session.

If the selected computer goes offline, the phone returns to the online computer
list. Choose a running session on another computer and approve control there.
The old draft remains saved under its original computer and session. Terminal
keys and drafts are never replayed into another computer. A live PTY cannot move
between computers; continuing the same conversation elsewhere also requires
the conversation, project files, installed agent and credentials there.

**This computer** in the phone menu retains the existing LAN/tunnel link. That
link depends on its issuing desktop remaining online.

## Pairing and revocation

The QR approves a distinct browser identity with `remote-guest` capability only.
It contains that browser's signing and box keys, session token and signed-chain
anchor in the URL fragment. The page removes the fragment before making requests
and stores the identity locally in that browser. Treat the pairing QR/link as a
credential: anyone with it can act as that phone, subject to host permissions.
Remove the phone under **Accounts → Devices & sync** to revoke it. Clearing
browser storage requires pairing again.

The phone receives a signed, recipient-encrypted **derived discovery key**, never
the vault key or synced credentials. Any updated online desktop can supply the
next discovery key after a vault rotation. The browser verifies the signed device
chain against its pinned anchor, the key's active author and epoch, and the target
computer's signed relay handshake. Terminal traffic uses the existing encrypted
relay and host control permissions. Browser sockets use path-bound, single-use
10-second tickets issued over signed requests; long-lived tokens stay out of
WebSocket URLs. Revocation invalidates tickets and live relay access.

## Rollout

Deploy the updated Hub server and `stoke-hub-edge` Worker, then use updated Stoke
desktops. `npm run deploy:hub-edge` builds the account website before deploying
the `/remote*` route and assets, alongside the existing `/hub/*` route. The
installer Worker remains separate. No database migration is needed. Older Hub
servers are detected before pairing adds a browser identity. At least one
updated online desktop is needed to publish discovery keys after rotation.

The account Hub remains necessary for discovery and relay availability. The
website removes dependence on an individual desktop; it does not make a Hub
outage or a powered-off session host available.

## Verification

`verify:account-remote` uses a synthetic Hub, laptop, work PC and third PC. It
compares browser and Node cryptography, denies vault access, shuts down the QR
issuer during terminal control, shuts down the target, opens a different session
without replaying input, revokes the phone, and checks discovery after key
rotation. It also drives the production phone page in Chromium through the real
edge asset handler while the original two computers are off.

`verify:remote-recovery` covers unresponsive sockets, phone sleep, stale frames,
attachment readiness and cleanup for the existing computer-specific client.
