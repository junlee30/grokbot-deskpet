// Relay state in SQLite (node:sqlite, synchronous). A file in dev/prod, ":memory:" in tests.
//
// Nothing in here ever holds a raw token, a raw pairing code or a message body:
//   tokens:   HMAC(token) + created/paired/last-seen/revoked timestamps
//   pairings: HMAC(code)  -> token sealed under a code-derived key (deleted on redemption), expiry
//   states:   HMAC(token), agent, session -> last-known state JSON (message stripped) + event seq
//   meta:     schema version, stream epoch, event sequence counter
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestEqual, type Sealed } from "./crypto.ts";
import type { StatusEvent } from "./validate.ts";

export interface TokenRecord {
  hash: string;
  created_at: number;
  paired_at: number | null;
  last_seen_at: number;
  revoked_at: number | null;
}

export interface Pairing {
  sealed: Sealed | null; // null once redeemed
  token_hash: string;
  expires_at: number;
  used_at: number | null;
}

export type StoredState = Omit<StatusEvent, "message"> & { received_at: string };

export interface SeqState {
  seq: number;
  state: StoredState;
}

/** Ordered, idempotent migrations. Each runs once; PRAGMA user_version records progress. */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  // 1: M0 had only `tokens (hash, created_at, last_seen_at)`; IF NOT EXISTS keeps that table.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  },
  // 2: M1 columns and tables.
  (db) => {
    const cols = new Set((db.prepare("PRAGMA table_info(tokens)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("revoked_at")) db.exec("ALTER TABLE tokens ADD COLUMN revoked_at INTEGER");
    // Tokens from M0 had been redeemed already (or were dead): treat them as paired.
    if (!cols.has("paired_at")) db.exec("ALTER TABLE tokens ADD COLUMN paired_at INTEGER; UPDATE tokens SET paired_at = created_at");
    db.exec(`
      CREATE TABLE IF NOT EXISTS pairings (
        code_hash TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        sealed TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pairings_expires ON pairings (expires_at);
      CREATE INDEX IF NOT EXISTS pairings_token ON pairings (token_hash);
      CREATE TABLE IF NOT EXISTS states (
        token_hash TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (token_hash, agent_id, session)
      );
      CREATE INDEX IF NOT EXISTS states_updated ON states (updated_at);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Revoked token rows are kept this long (so a revoked token keeps getting 401), then purged. */
const REVOKED_RETENTION_MS = 7 * 24 * 3_600_000;

export function migrate(db: DatabaseSync): number {
  const cur = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      MIGRATIONS[v]!(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return MIGRATIONS.length;
}

function prepareQueries(db: DatabaseSync) {
  return {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    insToken: db.prepare("INSERT INTO tokens (hash, created_at, last_seen_at, paired_at, revoked_at) VALUES (?, ?, ?, NULL, NULL)"),
    getToken: db.prepare("SELECT hash, created_at, paired_at, last_seen_at, revoked_at FROM tokens WHERE hash = ?"),
    touch: db.prepare("UPDATE tokens SET last_seen_at = ? WHERE hash = ?"),
    markPaired: db.prepare("UPDATE tokens SET paired_at = ? WHERE hash = ? AND paired_at IS NULL"),
    revoke: db.prepare("UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL"),
    delStatesTok: db.prepare("DELETE FROM states WHERE token_hash = ?"),
    delPairTok: db.prepare("DELETE FROM pairings WHERE token_hash = ?"),
    insPair: db.prepare("INSERT INTO pairings (code_hash, token_hash, sealed, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)"),
    getPair: db.prepare("SELECT token_hash, sealed, expires_at, used_at FROM pairings WHERE code_hash = ?"),
    usePair: db.prepare("UPDATE pairings SET sealed = NULL, used_at = ? WHERE code_hash = ? AND used_at IS NULL"),
    delPair: db.prepare("DELETE FROM pairings WHERE code_hash = ?"),
    agentCount: db.prepare("SELECT COUNT(DISTINCT agent_id) AS n FROM states WHERE token_hash = ?"),
    hasAgent: db.prepare("SELECT 1 AS x FROM states WHERE token_hash = ? AND agent_id = ? LIMIT 1"),
    oldestAgent: db.prepare(
      "SELECT agent_id FROM states WHERE token_hash = ? GROUP BY agent_id ORDER BY MAX(updated_at) ASC, MAX(seq) ASC LIMIT 1",
    ),
    delAgent: db.prepare("DELETE FROM states WHERE token_hash = ? AND agent_id = ?"),
    sessionCount: db.prepare("SELECT COUNT(*) AS n FROM states WHERE token_hash = ? AND agent_id = ?"),
    hasSession: db.prepare("SELECT 1 AS x FROM states WHERE token_hash = ? AND agent_id = ? AND session = ?"),
    oldestSession: db.prepare(
      "SELECT session FROM states WHERE token_hash = ? AND agent_id = ? ORDER BY updated_at ASC, seq ASC LIMIT 1",
    ),
    delSession: db.prepare("DELETE FROM states WHERE token_hash = ? AND agent_id = ? AND session = ?"),
    upState: db.prepare(
      `INSERT INTO states (token_hash, agent_id, session, state_json, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_hash, agent_id, session) DO UPDATE SET
         state_json = excluded.state_json, updated_at = excluded.updated_at, seq = excluded.seq`,
    ),
    snapshot: db.prepare("SELECT seq, state_json FROM states WHERE token_hash = ? AND seq > ? ORDER BY seq ASC"),
    sweepPairs: db.prepare("DELETE FROM pairings WHERE expires_at <= ?"),
    sweepStates: db.prepare("DELETE FROM states WHERE updated_at < ?"),
    // Tokens whose pairing was never redeemed and whose code is long gone.
    sweepUnpaired: db.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE paired_at IS NULL AND revoked_at IS NULL AND created_at < ? AND hash NOT IN (SELECT token_hash FROM pairings)",
    ),
    purgeRevoked: db.prepare("DELETE FROM tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?"),
    ping: db.prepare("SELECT 1 AS ok"),
  };
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  /** Random per database: SSE ids from another database (or a wiped one) are recognisably stale. */
  readonly epoch: string;
  private seq: number;
  private readonly now: () => number;
  private readonly q: ReturnType<typeof prepareQueries>;

  static open(path: string, now: () => number = Date.now): Store {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    if (path !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    }
    db.exec("PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;");
    migrate(db);
    return new Store(db, path, now);
  }

  private constructor(db: DatabaseSync, path: string, now: () => number) {
    this.db = db;
    this.path = path;
    this.now = now;
    this.q = prepareQueries(db);
    const { getMeta, setMeta } = this.q;
    let epoch = (getMeta.get("epoch") as { value: string } | undefined)?.value;
    if (!epoch) {
      epoch = randomBytes(6).toString("hex");
      setMeta.run("epoch", epoch);
    }
    this.epoch = epoch;
    const metaSeq = Number((getMeta.get("seq") as { value: string } | undefined)?.value ?? 0);
    const maxRow = (db.prepare("SELECT MAX(seq) AS m FROM states").get() as { m: number | null }).m ?? 0;
    this.seq = Math.max(metaSeq, maxRow);
  }

  addToken(hash: string): void {
    const t = this.now();
    this.q.insToken.run(hash, t, t);
  }

  /** Live (not revoked) token by hash, confirmed with a constant-time compare. */
  findToken(hash: string): TokenRecord | null {
    const rec = this.q.getToken.get(hash) as TokenRecord | undefined;
    if (!rec || rec.revoked_at !== null || !digestEqual(rec.hash, hash)) return null;
    return { ...rec };
  }

  touchToken(hash: string): void {
    this.q.touch.run(this.now(), hash);
  }

  markPaired(hash: string): void {
    this.q.markPaired.run(this.now(), hash);
  }

  revokeToken(hash: string): void {
    this.tx(() => {
      this.q.revoke.run(this.now(), hash);
      this.q.delStatesTok.run(hash);
      this.q.delPairTok.run(hash);
    });
  }

  addPairing(codeHash: string, p: Pairing): void {
    this.q.insPair.run(codeHash, p.token_hash, p.sealed ? JSON.stringify(p.sealed) : null, p.expires_at);
  }

  getPairing(codeHash: string): Pairing | null {
    const r = this.q.getPair.get(codeHash) as
      | { token_hash: string; sealed: string | null; expires_at: number; used_at: number | null }
      | undefined;
    if (!r) return null;
    return { token_hash: r.token_hash, sealed: r.sealed ? (JSON.parse(r.sealed) as Sealed) : null, expires_at: r.expires_at, used_at: r.used_at };
  }

  /** Atomically mark a pairing used and drop its ciphertext. False if it was already used. */
  redeemPairing(codeHash: string): boolean {
    return Number(this.q.usePair.run(this.now(), codeHash).changes) === 1;
  }

  deletePairing(codeHash: string): void {
    this.q.delPair.run(codeHash);
  }

  /** Store the last-known state for (token, agent, session). Returns its event sequence number. */
  putState(tokenHash: string, s: StoredState, maxAgents: number, maxSessions: number): number {
    const t = this.now();
    return this.tx(() => {
      if (!this.q.hasAgent.get(tokenHash, s.agent_id)) {
        const n = (this.q.agentCount.get(tokenHash) as { n: number }).n;
        if (n >= maxAgents) {
          const old = this.q.oldestAgent.get(tokenHash) as { agent_id: string } | undefined;
          if (old) this.q.delAgent.run(tokenHash, old.agent_id);
        }
      } else if (!this.q.hasSession.get(tokenHash, s.agent_id, s.session)) {
        const n = (this.q.sessionCount.get(tokenHash, s.agent_id) as { n: number }).n;
        if (n >= maxSessions) {
          const old = this.q.oldestSession.get(tokenHash, s.agent_id) as { session: string } | undefined;
          if (old) this.q.delSession.run(tokenHash, s.agent_id, old.session);
        }
      }
      const seq = ++this.seq;
      this.q.upState.run(tokenHash, s.agent_id, s.session, JSON.stringify(s), t, seq);
      this.q.setMeta.run("seq", String(seq));
      return seq;
    });
  }

  /** Last-known (agent, session) states for a token with seq > afterSeq, oldest first. */
  snapshot(tokenHash: string, afterSeq = 0): SeqState[] {
    return (this.q.snapshot.all(tokenHash, afterSeq) as Array<{ seq: number; state_json: string }>).map((r) => ({
      seq: r.seq,
      state: JSON.parse(r.state_json) as StoredState,
    }));
  }

  /** Highest event sequence number handed out so far. */
  currentSeq(): number {
    return this.seq;
  }

  /** Expire pairing codes, drop states silent for longer than stateTtlMs, retire dead tokens. */
  sweep(stateTtlMs: number, unpairedGraceMs = 60 * 60_000): { pairings: number; states: number; tokens: number } {
    const t = this.now();
    return this.tx(() => {
      const pairings = Number(this.q.sweepPairs.run(t).changes);
      const states = Number(this.q.sweepStates.run(t - stateTtlMs).changes);
      const retired = Number(this.q.sweepUnpaired.run(t, t - unpairedGraceMs).changes);
      const purged = Number(this.q.purgeRevoked.run(t - REVOKED_RETENTION_MS).changes);
      return { pairings, states, tokens: retired + purged };
    });
  }

  /** Cheap liveness check for /health. */
  ping(): boolean {
    try {
      return (this.q.ping.get() as { ok: number }).ok === 1;
    } catch {
      return false;
    }
  }

  /** Token hashes of live tokens (tests and diagnostics). */
  liveTokenHashes(): string[] {
    return (this.db.prepare("SELECT hash FROM tokens WHERE revoked_at IS NULL ORDER BY created_at").all() as Array<{ hash: string }>).map(
      (r) => r.hash,
    );
  }

  /** Every row of every table (used by tests to prove no raw token/code/message is stored). */
  dump(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const t of ["tokens", "pairings", "states", "meta"]) out[t] = this.db.prepare(`SELECT * FROM ${t}`).all();
    return out;
  }

  close(): void {
    if (!this.db.isOpen) return;
    try {
      if (this.path !== ":memory:") this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      this.db.close();
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
