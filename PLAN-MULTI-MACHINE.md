# PLAN — one hostname, several machines

Goal, in the user's words: keep it as `code.vinn.dev/u/0`, `/u/1`, "like Google".

## Why Google can do this and we cannot, yet

Google's `/u/0` picks an **account** inside one system. Every request already lands on
Google's servers; the path only says which identity to render.

Here `/u/0` and `/u/1` are **different physical computers**, each behind its own
Cloudflare Tunnel. A path cannot reach a different machine on its own — something has
to read the path and decide where to send the request. Cloudflare's tunnel ingress
rules do path matching, but they run *on* a connector, so they route within one
machine, not between them.

So the path approach needs a router in front. That is the whole design below.

## The architecture

```
phone ──► code.vinn.dev  ──► Cloudflare Access (one policy)
                          ──► Worker (the router)
                                 ├─ /u/0 ──► desktop.stoke.vinn.dev ──► tunnel `stoke`      ──► 127.0.0.1:7878
                                 ├─ /u/1 ──► mac.stoke.vinn.dev     ──► tunnel `stoke-mac`  ──► 127.0.0.1:7878
                                 └─ /    ──► a picker page listing the machines
```

Each machine keeps exactly what it has now: its own named tunnel, its own hostname, its
own token. Nothing about Stoke changes to make this work. The Worker is the only new
piece, and it is small.

## The problem that decides the design

Stoke's page asks for `/assets/index.js` and opens `/ws` — **absolute paths, no prefix**.
Serving it under `/u/0/` means the browser requests `/assets/index.js` with no `/u/0`
on it, and the router has no idea which machine that belongs to.

Two ways out.

**A. Sticky cookie (recommended).** `/u/0` sets `stoke_slot=0` and redirects to `/`.
Every later request — assets, API, the WebSocket — routes on that cookie. `/u/1`
switches. Requires no change to Stoke at all, and matches how it would actually be
used: one machine at a time, switch deliberately.

**B. Make Stoke prefix-aware.** Emit `<base href="/u/0/">` and build every URL
relative. Correct, allows two machines open in two tabs, and touches asset paths, the
WebSocket URL and the connect link. More work for a case (two machines at once) that
may never come up.

Start with A. Move to B only if two-at-once turns out to matter.

## Tokens

Each machine has its own `remote.token`. Two options:

**Keep tokens on the phone** — the picker links to `/u/0?k=<token0>`. Simple, no
secrets in Cloudflare, and the cookie already carries the key today.

**Put tokens in Worker secrets** — the Worker injects `Authorization: Bearer <token>`
per slot and the phone never sees a key at all. Nicer to use, and one fewer credential
in a browser. The cost is real and should be said plainly: Cloudflare then holds
credentials that grant a shell on your machines.

Prefer the first until the second is clearly worth it.

## Sharp edges

- **WebSockets.** Workers proxy them, but the upgrade must be passed through
  deliberately — return the upstream response with its `webSocket` intact rather than
  reading the body. Get this wrong and terminals silently never attach while every page
  still loads, which reads as "Stoke is broken".
- **Access headers.** Stoke's `requireAccessHeader` looks for `Cf-Access-*`. The Worker
  must forward them, or every request 401s.
- **The origin hostnames must not be openly reachable.** If `desktop.stoke.vinn.dev`
  answers the internet directly, the router is decoration. Put Access on them too, with
  a service token the Worker holds, or accept that Stoke's own token is the only gate.
- **One more layer to misread.** Every failure now has three candidates instead of one:
  the machine, the tunnel, the Worker. Worth a `/health` route on the Worker that says
  which slots it can reach.

## Phases

1. **Second machine on its own hostname first.** `mac.stoke.vinn.dev`, own tunnel, own
   token. Prove two Stokes coexist before adding a router. This alone is usable.
2. **`os.hostname()` in the remote header, connect link and QR caption.** Nothing
   currently identifies the machine, so two bookmarks look identical. Needed regardless
   of routing, and small.
3. **Worker with cookie routing**, plus a picker page at `/`.
4. **Prefix-awareness (option B)** only if two-at-once is wanted.

## The honest recommendation

Phase 1 and 2 give most of the value for a fraction of the work, and nothing about them
can break while you are away from a keyboard. The Worker is a genuinely nice piece of
polish and also a new thing between your phone and your shell that can fail on its own.

Build it when the bookmark sprawl actually irritates — not before.
