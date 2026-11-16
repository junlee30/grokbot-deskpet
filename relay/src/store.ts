// In-memory relay state, with optional SQLite persistence of token *hashes* only.
//
// Nothing in here ever holds a raw token:
//   tokens:   HMAC(token) -> metadata
//   pairings: HMAC(code)  -> { token sealed under a code-derived key, HMAC(token), expiry }
//   states:   HMAC(token) -> agent -> session -> last-known state (message bodies are NOT kept)
import { digestEqual, type Sealed } from "./crypto.ts";
import type { StatusEvent } from "./validate.ts";

export interface TokenRecord {
  hash: string;
  created_at: number;
  last_seen_at: number;
}

export interface Pairing {
  sealed: Sealed | null; // null once redeemed
  token_hash: string;
  expires_at: number;
  used_at: number | null;
}

export type StoredState = Omit<StatusEvent, "message"> & { received_at: string };

interface SessionEntry {
  state: StoredState;
  updated_at: number;
}

export interface TokenPersistence {
  load(): Iterable<[string, TokenRecord]>;
  put(hash: string, rec: TokenRecord): void;
  delete(hash: string): void;
  close(): void;
}

export class Store {
  readonly tokens = new Map<string, TokenRecord>();
  readonly pairings = new Map<string, Pairing>();
  readonly states = new Map<string, Map<string, Map<string, SessionEntry>>>();
  private readonly now: () => number;
  private readonly persist: TokenPersistence | null;

  constructor(now: () => number, persist: TokenPersistence | null = null) {
    this.now = now;
    this.persist = persist;
    if (persist) for (const [h, r] of persist.load()) this.tokens.set(h, r);
  }

  addToken(hash: string): void {
    const t = this.now();
    const rec = { hash, created_at: t, last_seen_at: t };
    this.tokens.set(hash, rec);
    this.persist?.put(hash, rec);
  }

  /** Look up a token hash and confirm it with a constant-time compare. */
  findToken(hash: string): TokenRecord | null {
    // The map key is itself an HMAC, so lookup timing leaks nothing useful; the explicit
    // constant-time compare is belt and braces.
    const rec = this.tokens.get(hash);
    if (!rec || !digestEqual(rec.hash, hash)) return null;
    return rec;
  }

  touchToken(hash: string): void {
    const rec = this.tokens.get(hash);
    if (rec) rec.last_seen_at = this.now();
  }

  revokeToken(hash: string): void {
    this.tokens.delete(hash);
    this.states.delete(hash);
    for (const [k, p] of this.pairings) if (p.token_hash === hash) this.pairings.delete(k);
    this.persist?.delete(hash);
  }

  addPairing(codeHash: string, p: Pairing): void {
    this.pairings.set(codeHash, p);
  }

  putState(tokenHash: string, s: StoredState, maxAgents: number, maxSessions: number): void {
    const t = this.now();
    let agents = this.states.get(tokenHash);
    if (!agents) this.states.set(tokenHash, (agents = new Map()));
    let sessions = agents.get(s.agent_id);
    if (!sessions) {
      if (agents.size >= maxAgents) evictOldest(agents, (m) => newest(m));
      agents.set(s.agent_id, (sessions = new Map()));
    }
    sessions.delete(s.session); // keep insertion order == recency
    if (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    sessions.set(s.session, { state: s, updated_at: t });
  }

  /** Last-known (agent, session) states for a token, oldest first. */
  snapshot(tokenHash: string): StoredState[] {
    const out: SessionEntry[] = [];
    for (const sessions of this.states.get(tokenHash)?.values() ?? []) out.push(...sessions.values());
    return out.sort((a, b) => a.updated_at - b.updated_at).map((e) => e.state);
  }

  /** Expire pairing codes and drop agents silent for longer than stateTtlMs. */
  sweep(stateTtlMs: number): void {
    const t = this.now();
    for (const [k, p] of this.pairings) if (p.expires_at <= t) this.pairings.delete(k);
    for (const [tok, agents] of this.states) {
      for (const [agent, sessions] of agents) {
        for (const [sid, e] of sessions) if (t - e.updated_at > stateTtlMs) sessions.delete(sid);
        if (sessions.size === 0) agents.delete(agent);
      }
      if (agents.size === 0) this.states.delete(tok);
    }
  }

  /** Serialisable view of everything held (used by tests to prove no raw token is stored). */
  dump(): unknown {
    return {
      tokens: Object.fromEntries(this.tokens),
      pairings: Object.fromEntries(this.pairings),
      states: Object.fromEntries(
        [...this.states].map(([k, a]) => [k, Object.fromEntries([...a].map(([ak, s]) => [ak, Object.fromEntries(s)]))]),
      ),
    };
  }

  close(): void {
    this.persist?.close();
  }
}

function newest(m: Map<string, SessionEntry>): number {
  let n = 0;
  for (const e of m.values()) n = Math.max(n, e.updated_at);
  return n;
}

function evictOldest<V>(m: Map<string, V>, age: (v: V) => number): void {
  let key: string | null = null;
  let min = Infinity;
  for (const [k, v] of m) {
    const a = age(v);
    if (a < min) {
      min = a;
      key = k;
    }
  }
  if (key !== null) m.delete(key);
}

/** Optional SQLite persistence (DESKPET_DB). Stores token hashes + timestamps only. */
export async function openSqlite(path: string): Promise<TokenPersistence> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)",
  );
  const put = db.prepare(
    "INSERT INTO tokens (hash, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_seen_at = excluded.last_seen_at",
  );
  const del = db.prepare("DELETE FROM tokens WHERE hash = ?");
  return {
    load() {
      const rows = db.prepare("SELECT hash, created_at, last_seen_at FROM tokens").all() as Array<{
        hash: string;
        created_at: number;
        last_seen_at: number;
      }>;
      return rows.map((r) => [r.hash, { hash: r.hash, created_at: r.created_at, last_seen_at: r.last_seen_at }] as [string, TokenRecord]);
    },
    put(hash, rec) {
      put.run(hash, rec.created_at, rec.last_seen_at);
    },
    delete(hash) {
      del.run(hash);
    },
    close() {
      db.close();
    },
  };
}
