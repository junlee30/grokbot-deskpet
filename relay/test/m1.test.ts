import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import { parseLastEventId } from "../src/server.ts";
import { migrate, SCHEMA_VERSION, Store } from "../src/store.ts";
import { goodEvent, newClock, openStream, pairStart, postEvent, startRelay } from "./helpers.ts";

function pair(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "deskpet-m1-"));
}

const PEPPER = Buffer.from("test-pepper-0123456789-abcdefghijklmnop");

describe("persistence (SQLite)", () => {
  it("a token paired before a restart still authenticates and gets catch-up state after it", async () => {
    const dir = tmp();
    const dbPath = join(dir, "deskpet.sqlite");
    const clock = newClock();
    try {
      const a = await startRelay({ pepper: PEPPER }, { dbPath, clock });
      const p = await pairStart(a.base);
      assert.equal((await pair(a.base, { code: p.code, agent_id: "jarvis" })).status, 200);
      assert.equal((await postEvent(a.base, p.token, goodEvent({ agent_id: "jarvis", state: "working" }))).status, 202);
      assert.equal(
        (await postEvent(a.base, p.token, goodEvent({ agent_id: "scout", agent_name: "Scout", state: "needs_you", message: "hi" }))).status,
        202,
      );
      const epoch = a.relay.store.epoch;
      const seqBefore = a.relay.store.currentSeq();
      await a.close();

      const b = await startRelay({ pepper: PEPPER }, { dbPath, clock });
      try {
        assert.equal(b.relay.store.epoch, epoch, "epoch survives restart");
        const s = await openStream(b.base, p.token);
        assert.equal(s.status, 200);
        const j = await s.waitFor((e) => e.event === "state" && e.data.agent_id === "jarvis");
        const sc = await s.waitFor((e) => e.event === "state" && e.data.agent_id === "scout");
        const ready = await s.waitFor((e) => e.event === "ready");
        assert.equal(j.data.state, "working");
        assert.equal(sc.data.state, "needs_you");
        assert.equal(sc.data.message, undefined, "messages are never stored");
        assert.equal(ready.data.paired, true);
        s.close();
        assert.equal((await postEvent(b.base, p.token, goodEvent())).status, 202);
        assert.ok(b.relay.store.currentSeq() > seqBefore, "event ids keep increasing across restarts");
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a different pepper invalidates old tokens (fail closed)", async () => {
    const dir = tmp();
    const dbPath = join(dir, "deskpet.sqlite");
    try {
      const a = await startRelay({ pepper: PEPPER }, { dbPath });
      const p = await pairStart(a.base);
      await a.close();
      const b = await startRelay({ pepper: Buffer.from("another-pepper-0123456789-abcdefghijk") }, { dbPath });
      try {
        assert.equal((await postEvent(b.base, p.token, goodEvent())).status, 401);
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrations are idempotent and upgrade an M0 database", () => {
    const dir = tmp();
    const file = join(dir, "old.sqlite");
    try {
      const old = new DatabaseSync(file);
      old.exec("CREATE TABLE tokens (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)");
      old.prepare("INSERT INTO tokens VALUES (?, ?, ?)").run("a".repeat(64), 1, 1);
      old.close();
      for (let i = 0; i < 3; i++) {
        const s = Store.open(file);
        assert.equal(migrate(s.db), SCHEMA_VERSION);
        const v = (s.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        assert.equal(v, SCHEMA_VERSION);
        const rec = s.findToken("a".repeat(64));
        assert.ok(rec, "M0 token survives migration");
        assert.equal(rec.paired_at, 1);
        assert.equal(rec.revoked_at, null);
        s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleanup drops expired pairings, 24h-stale states and abandoned unpaired tokens", async () => {
    const h = await startRelay();
    try {
      const done = await pairStart(h.base);
      assert.equal((await pair(h.base, { code: done.code })).status, 200);
      const abandoned = await pairStart(h.base);
      await postEvent(h.base, done.token, goodEvent());
      assert.equal(h.relay.store.dump().pairings!.length, 2);
      h.clock.advance(16 * 60_000);
      h.relay.sweep();
      assert.equal(h.relay.store.dump().pairings!.length, 0, "expired pairings removed");
      h.clock.advance(60 * 60_000);
      h.relay.sweep();
      assert.equal((await postEvent(h.base, abandoned.token, goodEvent())).status, 401, "never-redeemed token retired");
      assert.equal((await postEvent(h.base, done.token, goodEvent())).status, 202, "paired token kept");
      h.clock.advance(25 * 3_600_000);
      h.relay.sweep();
      assert.equal(h.relay.store.dump().states!.length, 0, "stale state removed");
      assert.equal((await postEvent(h.base, done.token, goodEvent())).status, 202, "token still valid after its states expired");
    } finally {
      await h.close();
    }
  });

  it("revoked tokens are kept as revoked rows", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      await fetch(`${h.base}/v1/unpair`, { method: "POST", headers: { authorization: `Bearer ${p.token}` } });
      const rows = h.relay.store.dump().tokens as Array<{ revoked_at: number | null }>;
      assert.equal(rows.length, 1);
      assert.equal(typeof rows[0]!.revoked_at, "number");
      assert.equal(h.relay.store.liveTokenHashes().length, 0);
    } finally {
      await h.close();
    }
  });
});

describe("SSE ids, retry and Last-Event-ID", () => {
  it("sends retry: 3000, ids on state events and a ready marker", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      await postEvent(h.base, token, goodEvent());
      const s = await openStream(h.base, token);
      const ev = await s.waitFor((e) => e.event === "state");
      await s.waitFor((e) => e.event === "ready");
      assert.equal(s.retry, 3000);
      assert.match(ev.id!, new RegExp(`^${h.relay.store.epoch}-\\d+$`));
      s.close();
    } finally {
      await h.close();
    }
  });

  it("with a known Last-Event-ID resends only what changed; unknown ids get the full state", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      await postEvent(h.base, token, goodEvent({ agent_id: "jarvis", state: "working" }));
      await postEvent(h.base, token, goodEvent({ agent_id: "claude", state: "thinking" }));
      const s1 = await openStream(h.base, token);
      await s1.waitFor((e) => e.event === "ready");
      const lastId = s1.events.filter((e) => e.id).at(-1)!.id!;
      s1.close();
      await postEvent(h.base, token, goodEvent({ agent_id: "claude", state: "done" }));

      const s2 = await openStream(h.base, token, { "last-event-id": lastId });
      const r2 = await s2.waitFor((e) => e.event === "ready");
      const st2 = s2.events.filter((e) => e.event === "state");
      assert.equal(r2.data.resumed, true);
      assert.deepEqual(
        st2.map((e) => [e.data.agent_id, e.data.state]),
        [["claude", "done"]],
      );
      s2.close();

      for (const bogus of ["nope", "ffffffffffff-1", `${h.relay.store.epoch}-999999`]) {
        const s3 = await openStream(h.base, token, { "last-event-id": bogus });
        const r3 = await s3.waitFor((e) => e.event === "ready");
        assert.equal(r3.data.resumed, false, bogus);
        assert.equal(s3.events.filter((e) => e.event === "state").length, 2, bogus);
        s3.close();
      }
    } finally {
      await h.close();
    }
  });

  it("parseLastEventId", () => {
    assert.equal(parseLastEventId(undefined, "abc", 10), 0);
    assert.equal(parseLastEventId("abc-5", "abc", 10), 5);
    assert.equal(parseLastEventId("abc-11", "abc", 10), 0);
    assert.equal(parseLastEventId("abd-5", "abc", 10), 0);
    assert.equal(parseLastEventId("abc-5; drop table", "abc", 10), 0);
  });

  it("graceful close ends open streams and closes the database", async () => {
    const dir = tmp();
    const dbPath = join(dir, "deskpet.sqlite");
    try {
      const h = await startRelay({ pepper: PEPPER }, { dbPath });
      const { token } = await pairStart(h.base);
      const s = await openStream(h.base, token);
      await s.waitFor((e) => e.event === "ready");
      await h.close();
      await s.waitFor((e) => e.event === "__closed__");
      assert.equal(h.relay.store.db.isOpen, false);
      const again = Store.open(dbPath);
      assert.equal(again.liveTokenHashes().length, 1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("health", () => {
  it("returns 503 when the database is broken", async () => {
    const h = await startRelay();
    try {
      h.relay.store.db.close();
      const r = await fetch(`${h.base}/health`);
      assert.equal(r.status, 503);
      const j = (await r.json()) as { ok: boolean; db: string };
      assert.equal(j.ok, false);
      assert.equal(j.db, "error");
      assert.equal((await fetch(`${h.base}/livez`)).status, 200);
    } finally {
      await h.close();
    }
  });
});

describe("pairing limits", () => {
  it("global failure lock: N failed codes from many IPs -> 429 for everyone, then recovers", async () => {
    const h = await startRelay({ trustProxy: true, pairRateBurst: 100, pairGlobalFailMax: 5, pairGlobalWindowMs: 60_000, pairGlobalLockMs: 30_000 });
    try {
      const good = await pairStart(h.base);
      for (let i = 0; i < 5; i++) {
        const r = await pair(h.base, { code: "AAA-AAA" }, { "fly-client-ip": `203.0.113.${i + 1}` });
        assert.equal(r.status, 404);
      }
      const blocked = await pair(h.base, { code: good.code }, { "fly-client-ip": "198.51.100.7" });
      assert.equal(blocked.status, 429, "a fresh IP with a valid code is locked out too");
      assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
      h.clock.advance(30_001);
      assert.equal((await pair(h.base, { code: good.code }, { "fly-client-ip": "198.51.100.7" })).status, 200);
    } finally {
      await h.close();
    }
  });

  it("failures outside the window don't add up", async () => {
    const h = await startRelay({ pairRateBurst: 100, pairGlobalFailMax: 3, pairGlobalWindowMs: 10_000 });
    try {
      for (let i = 0; i < 6; i++) {
        assert.equal((await pair(h.base, { code: "AAA-AAA" })).status, 404);
        h.clock.advance(6_000);
      }
    } finally {
      await h.close();
    }
  });

  it("per-IP limit uses Fly-Client-IP only when DESKPET_TRUST_PROXY=1", async () => {
    const trusted = await startRelay({ trustProxy: true, pairRateBurst: 2, pairGlobalFailMax: 1000 });
    try {
      for (const ip of ["192.0.2.1", "192.0.2.1"]) assert.equal((await pair(trusted.base, { code: "AAA-AAA" }, { "fly-client-ip": ip })).status, 404);
      assert.equal((await pair(trusted.base, { code: "AAA-AAA" }, { "fly-client-ip": "192.0.2.1" })).status, 429);
      assert.equal((await pair(trusted.base, { code: "AAA-AAA" }, { "fly-client-ip": "192.0.2.2" })).status, 404, "other IP has its own bucket");
    } finally {
      await trusted.close();
    }
    const direct = await startRelay({ trustProxy: false, pairRateBurst: 2, pairGlobalFailMax: 1000 });
    try {
      for (const ip of ["192.0.2.1", "192.0.2.2"]) assert.equal((await pair(direct.base, { code: "AAA-AAA" }, { "fly-client-ip": ip })).status, 404);
      assert.equal(
        (await pair(direct.base, { code: "AAA-AAA" }, { "fly-client-ip": "192.0.2.3" })).status,
        429,
        "spoofed header ignored without trust",
      );
    } finally {
      await direct.close();
    }
  });

  it("global cap on new pairings", async () => {
    const h = await startRelay({ trustProxy: true, pairStartGlobalPerMin: 3 });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${h.base}/v1/pair/start`, { method: "POST", headers: { "fly-client-ip": `203.0.113.${i}` } });
        assert.equal(r.status, 201);
        await r.body?.cancel();
      }
      const r = await fetch(`${h.base}/v1/pair/start`, { method: "POST", headers: { "fly-client-ip": "203.0.113.99" } });
      assert.equal(r.status, 429);
      await r.body?.cancel();
    } finally {
      await h.close();
    }
  });

  it("returns DESKPET_PUBLIC_URL as relay_url", async () => {
    const h = await startRelay({ publicUrl: "https://grokbot-deskpet-relay.fly.dev" });
    try {
      const p = await pairStart(h.base);
      const r = await pair(h.base, { code: p.code });
      assert.equal(((await r.json()) as { relay_url: string }).relay_url, "https://grokbot-deskpet-relay.fly.dev");
    } finally {
      await h.close();
    }
  });
});

describe("CORS", () => {
  it("is off by default: no Access-Control-* headers at all", async () => {
    const h = await startRelay();
    try {
      for (const origin of ["http://localhost:1420", "tauri://localhost", "https://evil.example"]) {
        const pre = await fetch(`${h.base}/v1/pair/start`, { method: "OPTIONS", headers: { origin } });
        assert.notEqual(pre.status, 204);
        const get = await fetch(`${h.base}/health`, { headers: { origin } });
        for (const r of [pre, get]) {
          await r.body?.cancel();
          for (const k of r.headers.keys()) assert.ok(!k.startsWith("access-control-"), `${k} for ${origin}`);
        }
      }
    } finally {
      await h.close();
    }
  });
});

describe("structured logs", () => {
  it("one JSON line per request, never tokens, codes, messages or query strings", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      await pair(h.base, { code: p.code, agent_id: "jarvis" });
      await postEvent(h.base, p.token, goodEvent({ message: "very-private-message" }));
      await postEvent(h.base, p.token.slice(0, -2) + "xx", goodEvent());
      const s = await openStream(h.base, p.token);
      await s.waitFor((e) => e.event === "ready");
      s.close();
      await (await fetch(`${h.base}/v1/stream/${p.token}`)).body?.cancel();
      await (await fetch(`${h.base}/v1/stream?token=${p.token}&code=${p.code}`)).body?.cancel();
      await new Promise((r) => setTimeout(r, 50));

      const reqs = h.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === "request");
      assert.ok(reqs.length >= 7, `expected request logs, got ${reqs.length}`);
      for (const l of reqs) {
        assert.deepEqual(Object.keys(l).sort(), ["ip", "level", "method", "ms", "msg", "path", "status", "ts"]);
        assert.match(l.ip, /^[0-9a-f]{12}$/);
        assert.ok(!l.path.includes("?"));
      }
      assert.ok(reqs.some((l) => l.path === "(unmatched)"));
      const all = h.logs.join("\n");
      for (const needle of [p.token, p.code, p.code.replace("-", ""), "very-private-message", "127.0.0.1"]) {
        assert.ok(!all.includes(needle), "secret leaked into logs");
      }
      assert.ok(!/authorization|bearer/i.test(all));
    } finally {
      await h.close();
    }
  });
});

describe("config", () => {
  it("production refuses to start without a strong DESKPET_PEPPER and never echoes it", () => {
    const short = "short-secret-value-123";
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", DESKPET_PEPPER: short },
      { DESKPET_ENV: "production", DESKPET_PEPPER: "" },
    ]) {
      assert.throws(
        () => loadConfig(env as NodeJS.ProcessEnv),
        (e: unknown) => e instanceof ConfigError && /DESKPET_PEPPER/.test(e.message) && !e.message.includes(short),
      );
    }
  });

  it("production defaults: /data db, CORS off, 15s heartbeats", () => {
    const c = loadConfig({ NODE_ENV: "production", DESKPET_PEPPER: "p".repeat(48) });
    assert.equal(c.production, true);
    assert.equal(c.dbPath, "/data/deskpet.sqlite");
    assert.deepEqual(c.corsOrigins, []);
    assert.equal(c.pingMs, 15_000);
    assert.equal(c.pepperSource, "env");
    assert.equal(c.trustProxy, false);
  });

  it("CORS origins only from DESKPET_CORS_ORIGINS, validated", () => {
    const c = loadConfig({ DESKPET_DB: ":memory:", DESKPET_CORS_ORIGINS: "http://localhost:1420, http://127.0.0.1:1420/" });
    assert.deepEqual(c.corsOrigins, ["http://localhost:1420", "http://127.0.0.1:1420"]);
    assert.throws(() => loadConfig({ DESKPET_DB: ":memory:", DESKPET_CORS_ORIGINS: "*" }), ConfigError);
  });

  it("dev without a pepper keeps one in a 0600 data/dev-pepper next to the database", () => {
    const dir = tmp();
    try {
      const env = { DESKPET_DB: join(dir, "data", "deskpet.sqlite") };
      const a = loadConfig(env);
      const b = loadConfig(env);
      assert.equal(a.pepperSource, "dev-file");
      assert.ok(a.pepper.equals(b.pepper), "same pepper after restart");
      assert.equal(statSync(join(dir, "data", "dev-pepper")).mode & 0o777, 0o600);
      assert.equal(loadConfig({ DESKPET_DB: ":memory:" }).pepperSource, "ephemeral");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
