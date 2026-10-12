# Public signup readiness — 12 October 2026

Recommendation: retain invite-only signup for beta.7. Prepare a limited public rollout after the controls below pass. Allow roughly one to two weeks for implementation and a real-device soak; this is a planning estimate, not a committed launch date.

## What the code already provides

- `hub/app.ts` requires a minted, single-use invite before starting expensive signup hashing. The invite's role is assigned by the server; a bootstrap invite creates the first owner, ordinary invites create members.
- `hub/limits.ts` groups IPv6 clients by /64, limits request rates, bounds concurrent password hashing and queues, and prevents parallel guesses from bypassing per-email throttling. Previously paired devices have reserved password-verification capacity.
- `src/shared/hub/protocol.ts` limits active devices to 32 and stored items to 5,000 per account. Relays have per-account limits and bounded transport queues.
- Device pairing, revocation, encrypted vault recovery kits, operator password resets, backup and restore are implemented and covered by existing checks.
- The public health endpoint answered HTTP 200 on 12 October 2026. One successful request does not establish uptime, capacity or recovery readiness.

## What must precede an invite-free rollout

1. Verify email ownership before activating an account. Use short-lived, single-use verification tokens; provide resend limits and generic responses that do not reveal whether an address exists.
2. Provide self-service password reset with the same token and abuse controls. Explain that resetting a login password does not recover an encrypted vault: another paired device or the recovery kit is still required. The current reset command requires an operator.
3. Protect signup against mass account creation. Validate a bot challenge on the server, apply dedicated signup limits, bound unverified registrations and expiry cleanup, and enforce a total account/storage budget. Existing per-account limits alone cannot bound the number of accounts a stranger creates.
4. Add an operator-controlled signup mode and daily admission cap. Default to invites, grant public signups member permissions only, and keep an immediate rollback switch that affects creation without disabling existing accounts.
5. Rehearse backup restore and rollback, alert on verification delivery failures, hashing saturation, registration spikes and relay queue closures. Load-test registration floods while established users sign in and stream.
6. Soak the next beta on real macOS, Windows and Linux devices, including phone background/resume and weak networks. Start with a small daily admission cap, then widen it after seven days of acceptable error rates and resource use.

No registration policy was changed by the beta.7 work. There is currently no configuration switch that safely makes the invite optional; deleting the invite check alone would bypass the admission control rather than implement public signup.

## Remote performance evidence for beta.7

The existing phone server negotiates WebSocket compression and coalesces unchanged session/status updates. Hub terminal connections are encrypted; the Hub pauses a sender when the destination queue is high and closes a relay above its hard cap. Reconnects use a current terminal snapshot, including terminal modes and Unicode widths.

Beta.7 adds a 16ms lossless terminal-output batch with a 64Ki-character waiting limit and a 256-chunk limit. Size, status and exit frames flush earlier output first. A newly attached viewer receives preceding output through its snapshot once. Phone and desktop encrypted transport queues are capped at 4 MiB; a stalled viewer reconnects without blocking the local agent or other viewers. No extra terminal-output work is queued when there are no viewers.

The production phone WebSocket and virtual relay handlers are exercised against owned fixtures: 128 ANSI/Unicode chunks arrive in exact order with at least 90% fewer data frames and under 250ms local delivery time; snapshot attachment, final-output-before-exit, and slow-viewer isolation also pass. The encrypted channel is tested with a saturated sending desktop. These checks measure frame overhead and correctness locally, not internet latency or mobile battery use. Direct-IP preference applies to SSH routes; shared Stoke sessions continue through the authenticated Hub relay.
