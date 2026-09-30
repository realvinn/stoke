/*
 * The hub's one SQLite file (`<data>/hub.db`, WAL), and every read and write
 * the server makes to it.
 *
 * What is in it (spec §3.5): accounts with scrypt hashes, invite and session
 * HASHES (never the invite or the token), the signed device chain, vault keys
 * WRAPPED to device keys and to the Recovery Kit, item envelopes (ciphertext
 * under opaque ids), pairing state, login-failure counters and request
 * nonces. Nothing in it opens anything: there is no key material a hub could
 * use, which `verify:hub-server` proves by grepping this file for a planted
 * plaintext canary.
 *
 * Every content row is keyed by `account_id`, and every query below takes one,
 * so no route can reach another account's rows by naming an id.
 *
 * `synchronous = FULL`, not NORMAL: in WAL mode NORMAL may roll back the last
 * commits after a power cut, and a chain append the hub acknowledged and then
 * lost is indistinguishable, on every device that pinned it, from a hub rolling
 * the device list back on purpose (spec §4.3's alarm). One fsync per write is
 * nothing at a household's request rate.
 *
 * Relays are NOT here: they are pairs of live sockets, meaningless after a
 * restart, so the relay broker holds them in memory (hub/sockets.ts).
 *
 * `node:sqlite` binds a JS number as REAL (gotcha 125). Every column compared
 * here is an ordinary INTEGER-affinity column, which converts on write and
 * compares numerically, so nothing needs a cast; no virtual table is used.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ThrottleState } from '../src/shared/hub/auth.ts'

export const DB_FILE = 'hub.db'
const SCHEMA_VERSION = '1'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  item_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invites (
  hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  kind TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  sign_pub TEXT NOT NULL,
  box_pub TEXT NOT NULL,
  label TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_device ON sessions(account_id, device_id);
CREATE TABLE IF NOT EXISTS chain (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  PRIMARY KEY (account_id, seq)
);
CREATE TABLE IF NOT EXISTS wraps (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  wrap_json TEXT NOT NULL,
  PRIMARY KEY (account_id, epoch, device_id)
);
CREATE TABLE IF NOT EXISTS recovery (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  wrap_json TEXT NOT NULL,
  PRIMARY KEY (account_id, epoch)
);
CREATE TABLE IF NOT EXISTS items (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS items_seq ON items(account_id, seq);
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_sign TEXT NOT NULL DEFAULT '',
  device_label TEXT NOT NULL,
  device_platform TEXT NOT NULL,
  state TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  approver_json TEXT,
  nonce_e TEXT,
  reveal_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS pairs_account ON pairs(account_id, state);
CREATE TABLE IF NOT EXISTS login_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL,
  lockouts INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS nonces_seen ON nonces(seen_at);
`

export type Role = 'owner' | 'member'

export interface AccountRow {
  id: string
  email: string
  pw_hash: string
  role: Role
  created_at: number
  status: string
  item_seq: number
}

export interface InviteRow {
  hash: string
  role: Role
  kind: string
  created_by: string | null
  created_at: number
  expires_at: number
  used_by: string | null
  used_at: number | null
}

export interface SessionRow {
  token_hash: string
  account_id: string
  device_id: string
  sign_pub: string
  box_pub: string
  label: string
  platform: string
  created_at: number
  seen_at: number
  expires_at: number
}

export interface PairRow {
  id: string
  account_id: string
  device_id: string
  /**
   * The signing key of the session that opened the pair. A pending device is
   * its id AND this key (gotcha 140): anyone with the password may sign in
   * under a not-yet-listed id, and by id alone could read, refuse or expire
   * the real device's pair and run up its refusal count.
   */
  device_sign: string
  device_label: string
  device_platform: string
  state: string
  commit_hash: string
  approver_json: string | null
  nonce_e: string | null
  reveal_json: string | null
  created_at: number
  expires_at: number
  ended_at: number | null
}

export interface ItemRow {
  id: string
  version: number
  epoch: number
  envelope_json: string
  seq: number
}

export class HubStore {
  readonly dir: string
  readonly file: string
  private readonly db: DatabaseSync
  private readonly stmts = new Map<string, StatementSync>()
  private inTx = false

  static open(dir: string): HubStore {
    return new HubStore(dir)
  }

  private constructor(dir: string) {
    this.dir = dir
    this.file = join(dir, DB_FILE)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* a mounted volume may refuse; the file modes below still apply */
    }
    this.db = new DatabaseSync(this.file, { timeout: 5000 })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    // A database made before pairs recorded their creator's key: add the column. Its old rows
    // carry '' — no key matches — and are open at most ten minutes anyway.
    const pairColumns = (this.db.prepare('PRAGMA table_info(pairs)').all() as { name: string }[]).map((c) => c.name)
    if (!pairColumns.includes('device_sign')) this.db.exec("ALTER TABLE pairs ADD COLUMN device_sign TEXT NOT NULL DEFAULT ''")
    this.q('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('schema', SCHEMA_VERSION)
    this.lockDown()
  }

  /** 0600 on the database and whichever of its WAL and shared-memory files exist now. */
  lockDown(): void {
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try {
        if (existsSync(f)) chmodSync(f, 0o600)
      } catch {
        /* best effort: the umask the CLI sets already made them 0600 */
      }
    }
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  /**
   * `fn` inside one IMMEDIATE transaction, committed if it returns and rolled
   * back if it throws. Synchronous on purpose: nothing can interleave between
   * the reads and the writes inside it, which is what makes a chain append or
   * a compare-and-swap put atomic without a lock (gotcha 20's claim, for free).
   */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.inTx = true
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err
    } finally {
      this.inTx = false
    }
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* closing is what matters */
    }
    this.db.close()
  }

  /** A consistent copy while serving (spec §7.2). Fails if `path` exists. */
  vacuumInto(path: string): void {
    this.db.prepare('VACUUM INTO ?').run(path)
  }

  /* ------------------------------------------------------ accounts */

  accountCount(): number {
    return Number((this.q('SELECT count(*) AS n FROM accounts').get() as { n: number }).n)
  }

  accountByEmail(email: string): AccountRow | null {
    return (this.q('SELECT * FROM accounts WHERE email = ?').get(email) as AccountRow | undefined) ?? null
  }

  accountById(id: string): AccountRow | null {
    return (this.q('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined) ?? null
  }

  insertAccount(a: { id: string; email: string; pwHash: string; role: Role; now: number }): void {
    this.q('INSERT INTO accounts(id, email, pw_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(a.id, a.email, a.pwHash, a.role, a.now)
  }

  setPasswordHash(accountId: string, pwHash: string): void {
    this.q('UPDATE accounts SET pw_hash = ? WHERE id = ?').run(pwHash, accountId)
  }

  /** The account's next change-feed position, taken inside the caller's transaction. */
  nextItemSeq(accountId: string): number {
    const row = this.q('UPDATE accounts SET item_seq = item_seq + 1 WHERE id = ? RETURNING item_seq').get(accountId) as { item_seq: number } | undefined
    if (!row) throw new Error('no such account')
    return Number(row.item_seq)
  }

  /* ------------------------------------------------------- invites */

  insertInvite(i: { hash: string; role: Role; kind: string; createdBy: string | null; now: number; expiresAt: number }): void {
    this.q('INSERT INTO invites(hash, role, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      i.hash,
      i.role,
      i.kind,
      i.createdBy,
      i.now,
      i.expiresAt
    )
  }

  /**
   * Take an unused, unexpired invite for `accountId`, synchronously — the
   * claim a signup makes BEFORE it awaits scrypt, so two signups racing on one
   * invite cannot both get past the hash (gotcha 20).
   */
  claimInvite(hash: string, accountId: string, now: number): InviteRow | null {
    const row = this.q('SELECT * FROM invites WHERE hash = ?').get(hash) as InviteRow | undefined
    if (!row || row.used_by !== null || row.expires_at <= now) return null
    const r = this.q('UPDATE invites SET used_by = ?, used_at = ? WHERE hash = ? AND used_by IS NULL').run(accountId, now, hash)
    return Number(r.changes) === 1 ? row : null
  }

  releaseInvite(hash: string, accountId: string): void {
    this.q('UPDATE invites SET used_by = NULL, used_at = NULL WHERE hash = ? AND used_by = ?').run(hash, accountId)
  }

  /** Every unused bootstrap invite is revoked when a fresh one is printed (spec §3.1). */
  revokeUnusedBootstrapInvites(): number {
    return Number(this.q("DELETE FROM invites WHERE kind = 'bootstrap' AND used_by IS NULL").run().changes)
  }

  /* ------------------------------------------------------ sessions */

  insertSession(s: SessionRow): void {
    this.q(
      'INSERT INTO sessions(token_hash, account_id, device_id, sign_pub, box_pub, label, platform, created_at, seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(s.token_hash, s.account_id, s.device_id, s.sign_pub, s.box_pub, s.label, s.platform, s.created_at, s.seen_at, s.expires_at)
  }

  session(tokenHash: string): SessionRow | null {
    return (this.q('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as SessionRow | undefined) ?? null
  }

  touchSession(tokenHash: string, now: number, expiresAt: number): void {
    this.q('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, expiresAt, tokenHash)
  }

  deleteSession(tokenHash: string): void {
    this.q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
  }

  deleteDeviceSessions(accountId: string, deviceId: string): number {
    return Number(this.q('DELETE FROM sessions WHERE account_id = ? AND device_id = ?').run(accountId, deviceId).changes)
  }

  deleteAccountSessions(accountId: string): number {
    return Number(this.q('DELETE FROM sessions WHERE account_id = ?').run(accountId).changes)
  }

  /* -------------------------------------------------------- nonces */

  /** True the first time `nonce` is seen from `deviceId`; false for a replay. */
  rememberNonce(deviceId: string, nonce: string, now: number): boolean {
    return Number(this.q('INSERT OR IGNORE INTO nonces(device_id, nonce, seen_at) VALUES (?, ?, ?)').run(deviceId, nonce, now).changes) === 1
  }

  /* ------------------------------------------------------ throttle */

  throttle(key: string): ThrottleState | null {
    const r = this.q('SELECT failures, first_at, locked_until, lockouts, last_at FROM login_failures WHERE key = ?').get(key) as
      | { failures: number; first_at: number; locked_until: number; lockouts: number; last_at: number }
      | undefined
    return r ? { failures: r.failures, firstAt: r.first_at, lockedUntil: r.locked_until, lockouts: r.lockouts, lastAt: r.last_at } : null
  }

  saveThrottle(key: string, s: ThrottleState): void {
    this.q(
      'INSERT INTO login_failures(key, failures, first_at, locked_until, lockouts, last_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, first_at = excluded.first_at, locked_until = excluded.locked_until, lockouts = excluded.lockouts, last_at = excluded.last_at'
    ).run(key, s.failures, s.firstAt, s.lockedUntil, s.lockouts, s.lastAt)
  }

  clearThrottle(key: string): void {
    this.q('DELETE FROM login_failures WHERE key = ?').run(key)
  }

  /* --------------------------------------------------------- chain */

  chainRows(accountId: string): { seq: number; entry_json: string; link_hash: string }[] {
    return this.q('SELECT seq, entry_json, link_hash FROM chain WHERE account_id = ? ORDER BY seq').all(accountId) as {
      seq: number
      entry_json: string
      link_hash: string
    }[]
  }

  insertChainRow(accountId: string, seq: number, entryJson: string, linkHash: string): void {
    this.q('INSERT INTO chain(account_id, seq, entry_json, link_hash) VALUES (?, ?, ?, ?)').run(accountId, seq, entryJson, linkHash)
  }

  accountsWithChains(): string[] {
    return (this.q('SELECT DISTINCT account_id FROM chain').all() as { account_id: string }[]).map((r) => r.account_id)
  }

  /* --------------------------------------------------------- wraps */

  /**
   * Store a device's wrap for an epoch, once. False when one is there already:
   * a wrap is never replaced (hub/app.ts `chainAppend` says why), and the
   * caller checks first, so a false here is a race it treats as a conflict.
   */
  insertWrap(accountId: string, epoch: number, deviceId: string, wrapJson: string): boolean {
    return (
      Number(
        this.q('INSERT INTO wraps(account_id, epoch, device_id, wrap_json) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, epoch, device_id) DO NOTHING').run(
          accountId,
          epoch,
          deviceId,
          wrapJson
        ).changes
      ) === 1
    )
  }

  wrap(accountId: string, epoch: number, deviceId: string): string | null {
    const r = this.q('SELECT wrap_json FROM wraps WHERE account_id = ? AND epoch = ? AND device_id = ?').get(accountId, epoch, deviceId) as
      | { wrap_json: string }
      | undefined
    return r?.wrap_json ?? null
  }

  /** The Recovery Kit's wrap for an epoch, once; false when there is one already (never replaced). */
  insertRecovery(accountId: string, epoch: number, wrapJson: string): boolean {
    return Number(this.q('INSERT INTO recovery(account_id, epoch, wrap_json) VALUES (?, ?, ?) ON CONFLICT(account_id, epoch) DO NOTHING').run(accountId, epoch, wrapJson).changes) === 1
  }

  recovery(accountId: string, epoch: number): string | null {
    const r = this.q('SELECT wrap_json FROM recovery WHERE account_id = ? AND epoch = ?').get(accountId, epoch) as { wrap_json: string } | undefined
    return r?.wrap_json ?? null
  }

  /* --------------------------------------------------------- items */

  item(accountId: string, id: string): ItemRow | null {
    return (this.q('SELECT id, version, epoch, envelope_json, seq FROM items WHERE account_id = ? AND id = ?').get(accountId, id) as ItemRow | undefined) ?? null
  }

  putItem(accountId: string, row: ItemRow): void {
    this.q(
      'INSERT INTO items(account_id, id, version, epoch, envelope_json, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET version = excluded.version, epoch = excluded.epoch, envelope_json = excluded.envelope_json, seq = excluded.seq'
    ).run(accountId, row.id, row.version, row.epoch, row.envelope_json, row.seq)
  }

  itemsSince(accountId: string, since: number, limit: number): ItemRow[] {
    return this.q('SELECT id, version, epoch, envelope_json, seq FROM items WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(
      accountId,
      since,
      limit
    ) as unknown as ItemRow[]
  }

  itemCount(accountId: string): number {
    return Number((this.q('SELECT count(*) AS n FROM items WHERE account_id = ?').get(accountId) as { n: number }).n)
  }

  pruneItems(accountId: string, epochBelow: number): number {
    return Number(this.q('DELETE FROM items WHERE account_id = ? AND epoch < ?').run(accountId, epochBelow).changes)
  }

  /* --------------------------------------------------------- pairs */

  insertPair(p: PairRow): void {
    this.q(
      'INSERT INTO pairs(id, account_id, device_id, device_sign, device_label, device_platform, state, commit_hash, approver_json, nonce_e, reveal_json, created_at, expires_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      p.id,
      p.account_id,
      p.device_id,
      p.device_sign,
      p.device_label,
      p.device_platform,
      p.state,
      p.commit_hash,
      p.approver_json,
      p.nonce_e,
      p.reveal_json,
      p.created_at,
      p.expires_at,
      p.ended_at
    )
  }

  pair(accountId: string, id: string): PairRow | null {
    return (this.q('SELECT * FROM pairs WHERE account_id = ? AND id = ?').get(accountId, id) as PairRow | undefined) ?? null
  }

  updatePair(p: PairRow): void {
    this.q('UPDATE pairs SET state = ?, approver_json = ?, nonce_e = ?, reveal_json = ?, ended_at = ? WHERE id = ? AND account_id = ?').run(
      p.state,
      p.approver_json,
      p.nonce_e,
      p.reveal_json,
      p.ended_at,
      p.id,
      p.account_id
    )
  }

  openPairs(accountId: string): PairRow[] {
    return this.q("SELECT * FROM pairs WHERE account_id = ? AND state IN ('waiting', 'nonce', 'revealed') ORDER BY created_at").all(accountId) as unknown as PairRow[]
  }

  /** The open pairs one device opened: its id AND the key its session signed in with. */
  openPairsFor(accountId: string, deviceId: string, sign: string): PairRow[] {
    return this.q("SELECT * FROM pairs WHERE account_id = ? AND device_id = ? AND device_sign = ? AND state IN ('waiting', 'nonce', 'revealed')").all(
      accountId,
      deviceId,
      sign
    ) as unknown as PairRow[]
  }

  /** Refusals counted per id AND key, so a squatter on an id cannot lock the real device out of pairing. */
  refusedPairsSince(accountId: string, deviceId: string, sign: string, since: number): number {
    return Number(
      (
        this.q("SELECT count(*) AS n FROM pairs WHERE account_id = ? AND device_id = ? AND device_sign = ? AND state = 'refused' AND ended_at >= ?").get(
          accountId,
          deviceId,
          sign,
          since
        ) as { n: number }
      ).n
    )
  }

  /* --------------------------------------------------------- sweep */

  /** Forget what has aged out. Returns how many rows each kind lost, for the log. */
  sweep(f: { now: number; nonceBefore: number; throttleBefore: number; pairsEndedBefore: number }): Record<string, number> {
    return this.tx(() => ({
      nonces: Number(this.q('DELETE FROM nonces WHERE seen_at < ?').run(f.nonceBefore).changes),
      sessions: Number(this.q('DELETE FROM sessions WHERE expires_at <= ?').run(f.now).changes),
      throttles: Number(this.q('DELETE FROM login_failures WHERE last_at < ? AND locked_until <= ?').run(f.throttleBefore, f.now).changes),
      invites: Number(this.q('DELETE FROM invites WHERE used_by IS NULL AND expires_at <= ?').run(f.now).changes),
      pairsExpired: Number(
        this.q("UPDATE pairs SET state = 'expired', ended_at = ? WHERE state IN ('waiting', 'nonce', 'revealed') AND expires_at <= ?").run(f.now, f.now).changes
      ),
      pairsDeleted: Number(this.q('DELETE FROM pairs WHERE ended_at IS NOT NULL AND ended_at < ?').run(f.pairsEndedBefore).changes)
    }))
  }
}
