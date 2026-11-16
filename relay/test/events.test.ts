import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { goodEvent, pairStart, postEvent, startRelay, type Harness } from "./helpers.ts";

describe("auth", () => {
  let h: Harness;
  let token: string;
  before(async () => {
    h = await startRelay();
    token = (await pairStart(h.base)).token;
  });
  after(() => h.close());

  it("accepts a valid token", async () => {
    const r = await postEvent(h.base, token, goodEvent());
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { ok: true });
  });

  it("rejects a missing token", async () => {
    const r = await postEvent(h.base, null, goodEvent());
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
  });

  it("rejects a bad token", async () => {
    const r = await postEvent(h.base, "x".repeat(43), goodEvent());
    assert.equal(r.status, 401);
  });

  it("rejects a malformed Authorization header", async () => {
    const r = await postEvent(h.base, null, goodEvent(), { authorization: `Basic ${token}` });
    assert.equal(r.status, 401);
  });

  it("rejects a revoked token and unpair is immediate", async () => {
    const { token: t2 } = await pairStart(h.base);
    assert.equal((await postEvent(h.base, t2, goodEvent())).status, 202);
    const u = await fetch(`${h.base}/v1/unpair`, { method: "POST", headers: { authorization: `Bearer ${t2}` } });
    assert.equal(u.status, 200);
    assert.equal((await postEvent(h.base, t2, goodEvent())).status, 401);
    const s = await fetch(`${h.base}/v1/stream`, { headers: { authorization: `Bearer ${t2}` } });
    assert.equal(s.status, 401);
    await s.body?.cancel();
    // other tokens are unaffected
    assert.equal((await postEvent(h.base, token, goodEvent())).status, 202);
  });

  it("does not accept the token in the query string", async () => {
    const s = await fetch(`${h.base}/v1/stream?token=${token}`);
    assert.equal(s.status, 401);
    await s.body?.cancel();
  });
});

describe("schema", () => {
  let h: Harness;
  let token: string;
  before(async () => {
    h = await startRelay({ rateBurst: 1000 });
    token = (await pairStart(h.base)).token;
  });
  after(() => h.close());

  const bad: Array<[string, Record<string, unknown>]> = [
    ["bad state", goodEvent({ state: "dancing" })],
    ["missing agent_id", (({ agent_id: _a, ...r }) => r)(goodEvent())],
    ["missing session", (({ session: _s, ...r }) => r)(goodEvent())],
    ["missing state", (({ state: _s, ...r }) => r)(goodEvent())],
    ["missing event", (({ event: _e, ...r }) => r)(goodEvent())],
    ["missing ts", (({ ts: _t, ...r }) => r)(goodEvent())],
    ["unknown field", goodEvent({ prompt: "secret stuff" })],
    ["too-long message", goodEvent({ message: "m".repeat(161) })],
    ["uppercase agent_id", goodEvent({ agent_id: "Jarvis" })],
    ["too-long agent_id", goodEvent({ agent_id: "a".repeat(65) })],
    ["too-long agent_name", goodEvent({ agent_name: "a".repeat(65) })],
    ["too-long session", goodEvent({ session: "s".repeat(129) })],
    ["too-long event", goodEvent({ event: "e".repeat(65) })],
    ["bad ts", goodEvent({ ts: "yesterday" })],
    ["non-string message", goodEvent({ message: 5 })],
    ["control chars in message", goodEvent({ message: "a\nb" })],
    ["agent_id and bot disagree", goodEvent({ bot: "claude" })],
  ];
  for (const [name, body] of bad) {
    it(`400 on ${name}`, async () => {
      const r = await postEvent(h.base, token, body);
      assert.equal(r.status, 400);
      const j = (await r.json()) as { ok: boolean; error: string };
      assert.equal(j.ok, false);
      assert.ok(j.error.length > 0);
    });
  }

  it("400 on array / invalid JSON", async () => {
    assert.equal((await postEvent(h.base, token, [goodEvent()])).status, 400);
    assert.equal((await postEvent(h.base, token, "{nope")).status, 400);
  });

  it("accepts a 160-char message and every state", async () => {
    for (const state of ["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping"]) {
      const r = await postEvent(h.base, token, goodEvent({ state, message: "m".repeat(160) }));
      assert.equal(r.status, 202, state);
    }
  });

  it("accepts legacy alias bot and defaults agent_name", async () => {
    const { agent_id: _a, agent_name: _n, ...rest } = goodEvent();
    const r = await postEvent(h.base, token, { ...rest, bot: "scout" });
    assert.equal(r.status, 202);
    const snap = h.relay.store.snapshot([...h.relay.store.tokens.keys()][0]!);
    const scout = snap.find((s) => s.agent_id === "scout");
    assert.ok(scout);
    assert.equal(scout.agent_name, "scout");
  });

  it("415 on non-JSON content type", async () => {
    const r = await postEvent(h.base, token, JSON.stringify(goodEvent()), { "content-type": "text/plain" });
    assert.equal(r.status, 415);
  });

  it("404 / 405 on unknown routes and methods", async () => {
    assert.equal((await fetch(`${h.base}/nope`)).status, 404);
    assert.equal((await fetch(`${h.base}/v1/events`)).status, 405);
  });

  it("health", async () => {
    const r = await fetch(`${h.base}/health`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { ok: boolean }).ok, true);
  });
});

describe("limits", () => {
  it("413 when the declared body is over 4 KiB", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      const r = await postEvent(h.base, token, goodEvent({ message: "x".repeat(5000) }));
      assert.equal(r.status, 413);
    } finally {
      await h.close();
    }
  });

  it("413 while streaming a chunked body (no content-length)", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      const url = new URL(`${h.base}/v1/events`);
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "transfer-encoding": "chunked" },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          },
        );
        req.on("error", (e) => (e as NodeJS.ErrnoException).code === "ECONNRESET" || (e as NodeJS.ErrnoException).code === "EPIPE" ? undefined : reject(e));
        req.write("{" + '"pad":"' + "y".repeat(3000));
        setTimeout(() => {
          req.write("z".repeat(3000));
          setTimeout(() => req.end('"}'), 50);
        }, 50);
      });
      assert.equal(status, 413);
    } finally {
      await h.close();
    }
  });

  it("429 after the burst is spent (token bucket, fake clock)", async () => {
    const h = await startRelay({ ratePerMin: 60, rateBurst: 5 });
    try {
      const { token } = await pairStart(h.base);
      for (let i = 0; i < 5; i++) assert.equal((await postEvent(h.base, token, goodEvent())).status, 202);
      const r = await postEvent(h.base, token, goodEvent());
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get("retry-after")) >= 1);
      // a second token has its own bucket
      const { token: other } = await pairStart(h.base);
      assert.equal((await postEvent(h.base, other, goodEvent())).status, 202);
      // refill: 60/min == 1 per second
      h.clock.advance(1000);
      assert.equal((await postEvent(h.base, token, goodEvent())).status, 202);
      assert.equal((await postEvent(h.base, token, goodEvent())).status, 429);
    } finally {
      await h.close();
    }
  });
});
