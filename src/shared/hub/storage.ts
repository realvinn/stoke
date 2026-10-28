/*
 * How much one account may keep on a hub, and the one rule that decides a
 * put against it. The owner, asked on 2026-10-28 whether each account should
 * get a storage cap: "yes storage cap on each account we don't really need
 * that much". Friends use the owner's hub, so one account must not be able to
 * fill the NUC's disk for everybody.
 *
 * WHAT IS COUNTED: the bytes of every item envelope an account keeps — the
 * canonical JSON the hub stores, ciphertext and all — at every epoch. Items
 * are the only per-account store a client can grow at will. The chain, its
 * wraps and the Recovery Kit's are capped by `HUB_LIMITS` (`chainEntries`,
 * `activeDevices`), and a revoke must never be refused for space: refusing
 * one would keep a stolen laptop in the vault. Pairs, sessions, nonces and
 * login counters are swept on a clock; presence and relays live in memory. The
 * hub keeps the count in SQLite beside the rows (hub/store.ts `item_usage`,
 * written by triggers in the same statement as the item), so it is exact,
 * survives a restart, and costs no scan.
 *
 * THE RULE (`storageVerdict`), decided for each put on its own:
 * - A put that does not grow the account is always taken. A full account can
 *   always free space, and one over its cap (the operator lowered it) can
 *   only shrink.
 * - So is a REPLACE that leaves its slot no larger than the largest tombstone a
 *   client can seal (`MAX_TOMBSTONE_CT_BYTES`). The hub cannot see that a put
 *   is a delete (`deleted` is inside the ciphertext), and a tombstone over a
 *   tiny value (`""`, `0`) is a few bytes LONGER than the value it replaces, so
 *   without this a full account could not delete one. What it costs is
 *   bounded: one small slot per item, and items are capped.
 * - Anything else must keep the account's CURRENT-epoch bytes within its
 *   budget: the cap, or, while items of an older epoch are still held, enough
 *   for a re-seal to put every one of them back (`storageBudget`). A revoke or
 *   a rotate opens a new epoch, the device that made it re-seals every item
 *   under the new key, and only then prunes the old epoch — and every client
 *   from beta.15 on prunes whatever the re-seal's puts answered
 *   (`putResealed` ignores a refusal). Judged against the cap alone, a revoke
 *   on an account past half its cap would have had part of its re-seal
 *   refused and then pruned: the vault would lose those items.
 *
 * The hard ceiling stays the item count (`HUB_LIMITS.itemsPerAccount`, every
 * epoch counted, × `MAX_ITEM_CIPHERTEXT_BYTES`): a member who deliberately
 * rotates again and again without ever pruning can grow up to it, as before.
 * The cap is what keeps every honest account small.
 *
 * Old clients (beta.15–beta.19) read a refusal with the new `full` code
 * through the branch every unknown per-put error takes: logged by path with
 * its `reason`, no retry within the pass, the pass still a success, so the
 * next attempt is the ordinary 5-minute interval or the next settings change
 * (`HubService.upload`, unchanged since beta.15). The fields this adds to
 * existing responses (`storage`) are ignored by them.
 *
 * Pure (gotcha 27): no `node:` import; the renderer formats sizes with it too.
 */
import { MAX_PATH_CHARS, itemPlaintextText } from './items.ts'

/** The hub's default cap per account: 25 MiB. The whole live hub held 4.4 MB on 2026-10-28. */
export const DEFAULT_STORAGE_CAP_BYTES = 25 * 1024 * 1024

/** What an account keeps and may keep, as the hub reports it (GET /v1/account, GET and POST /v1/items). */
export interface HubStorage {
  /** Bytes of every item envelope the account keeps, at every epoch. */
  used: number
  /** The account's cap in bytes: the hub's default, or the operator's own figure for this account. */
  cap: number
}

/** The account's item bytes split the way the rule reads them. */
export interface StorageUsage {
  /** Bytes under the account's current epoch. */
  currentBytes: number
  /** Bytes and items under every older epoch still held: a re-seal's source, until its prune. */
  olderBytes: number
  olderItems: number
}

/**
 * The largest ciphertext a tombstone can have: the plaintext of a delete with
 * the longest path the grammar allows, every character of it at JSON's
 * longest escape (`\u0001`, six bytes), the latest edit time a clock can
 * write, and a `by` (a re-seal of someone else's delete), plus GCM's tag.
 */
export const MAX_TOMBSTONE_CT_BYTES =
  new TextEncoder().encode(
    itemPlaintextText({ path: '\u0001'.repeat(MAX_PATH_CHARS), editedAt: Number.MAX_SAFE_INTEGER, deleted: true, value: null, by: 'd' + '0'.repeat(16) })
  ).length + 16

/**
 * How much bigger an envelope a re-seal writes can be than the one it moves:
 * `"by":"d…",` in the plaintext (23 bytes, so up to 33 more base64url
 * characters) and one more digit of epoch. 64 leaves room; verify:hub seals
 * the worst case and holds it under this.
 */
export const RESEAL_SLACK_BYTES = 64

/** Current-epoch bytes the account may reach: the cap, or room to re-seal what older epochs still hold. */
export function storageBudget(cap: number, u: StorageUsage): number {
  return u.olderItems > 0 ? Math.max(cap, u.olderBytes + u.olderItems * RESEAL_SLACK_BYTES) : cap
}

/**
 * Whether the hub takes one put for space (the shape, author, epoch and
 * compare-and-swap are `putVerdict`'s, decided first). `oldBytes` is the
 * envelope the put replaces, null for a new id; `newBytes` the envelope it
 * stores; `newCtBytes` its ciphertext's length in bytes.
 */
export function storageVerdict(f: { cap: number; usage: StorageUsage; oldBytes: number | null; newBytes: number; newCtBytes: number }): 'ok' | 'full' {
  const grows = f.newBytes - (f.oldBytes ?? 0)
  if (grows <= 0) return 'ok'
  if (f.oldBytes !== null && f.newCtBytes <= MAX_TOMBSTONE_CT_BYTES) return 'ok'
  return f.usage.currentBytes + grows <= storageBudget(f.cap, f.usage) ? 'ok' : 'full'
}

/** A `storage` field from the hub, or null for anything else (an old hub sends none). */
export function parseHubStorage(v: unknown): HubStorage | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const { used, cap } = v as Record<string, unknown>
  const size = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  return size(used) && size(cap) ? { used, cap } : null
}

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/**
 * A size for a person: "512 bytes", "1.2 MB", "25 MB". Binary units under the
 * familiar names (a 25 MiB cap reads "25 MB"), the convention the operator's
 * `--cap 25M` and `STOKE_HUB_STORAGE_CAP` use too. Under 10 of a unit it shows
 * one decimal ("1.0 MB"), from 10 a whole number.
 *
 * Rounded first, then carried: 1,048,575 bytes is 1023.999 KB, which rounds
 * to 1024 and so reads "1.0 MB", never "1024 KB" (as it did).
 */
export function formatBytes(n: number): string {
  const bytes = Number.isFinite(n) ? Math.round(n) : 0
  if (bytes < 1024) return `${Math.max(0, bytes)} bytes`
  let v = bytes / 1024
  let unit = 0
  while (v >= 1024 && unit < UNITS.length - 1) {
    v /= 1024
    unit++
  }
  // 9.95 and up would print "10.0" with one decimal: it is a whole 10.
  let shown = v < 9.95 ? Math.round(v * 10) / 10 : Math.round(v)
  if (shown >= 1024 && unit < UNITS.length - 1) {
    unit++
    shown = 1
  }
  return `${shown < 10 ? shown.toFixed(1) : String(shown)} ${UNITS[unit]}`
}

/**
 * An operator's size: whole bytes, or a number with K, M, G or T (with or
 * without B or iB, any case), all binary: `25M`, `25MB` and `25MiB` are each
 * 26,214,400 bytes. Null for anything else, a negative or a fraction of a byte.
 */
export function parseByteSize(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(?:([kmgt])(?:i?b)?|b)?$/i.exec(text.trim())
  if (!m) return null
  const power = m[2] ? 'kmgt'.indexOf(m[2].toLowerCase()) + 1 : 0
  const bytes = Number(m[1]) * 1024 ** power
  return Number.isSafeInteger(Math.floor(bytes)) && (power > 0 || Number.isInteger(bytes)) ? Math.floor(bytes) : null
}
