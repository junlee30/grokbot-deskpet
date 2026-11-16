import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { goodEvent, openStream, pairStart, postEvent, startRelay } from "./helpers.ts";

describe("SSE stream", () => {
  it("sends catch-up state on connect, without message bodies", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      await postEvent(h.base, token, goodEvent({ agent_id: "jarvis", state: "working", message: "secret-ish" }));
      await postEvent(h.base, token, goodEvent({ agent_id: "claude", agent_name: "Claude", state: "thinking" }));
      const s = await openStream(h.base, token);
      assert.equal(s.status, 200);
      const j = await s.waitFor((e) => e.event === "state" && e.data.agent_id === "jarvis");
      const c = await s.waitFor((e) => e.event === "state" && e.data.agent_id === "claude");
      assert.equal(j.data.state, "working");
      assert.equal(j.data.message, undefined);
      assert.equal(c.data.agent_name, "Claude");
      s.close();
    } finally {
      await h.close();
    }
  });

  it("delivers a live event within 2s, scoped to its token", async () => {
    const h = await startRelay();
    try {
      const a = await pairStart(h.base);
      const b = await pairStart(h.base);
      const sa = await openStream(h.base, a.token);
      const sb = await openStream(h.base, b.token);
      const t0 = Date.now();
      await postEvent(h.base, a.token, goodEvent({ agent_id: "scout", state: "needs_you", message: "Need a decision" }));
      const ev = await sa.waitFor((e) => e.event === "state" && e.data.agent_id === "scout", 2000);
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(ev.data.state, "needs_you");
      assert.equal(ev.data.message, "Need a decision");
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!sb.events.some((e) => e.event === "state"), "event leaked to another token");
      sa.close();
      sb.close();
    } finally {
      await h.close();
    }
  });

  it("caps subscribers at 3 per token", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      const streams = [];
      for (let i = 0; i < 3; i++) {
        const s = await openStream(h.base, token);
        assert.equal(s.status, 200);
        streams.push(s);
      }
      const fourth = await openStream(h.base, token);
      assert.equal(fourth.status, 429);
      streams[0]!.close();
      // after one disconnects, a new subscriber fits again
      let ok = false;
      for (let i = 0; i < 20 && !ok; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (h.relay.subscriberCount() < 3) ok = true;
      }
      assert.ok(ok, "subscriber slot was not released");
      const again = await openStream(h.base, token);
      assert.equal(again.status, 200);
      again.close();
      streams.slice(1).forEach((s) => s.close());
    } finally {
      await h.close();
    }
  });

  it("sends ping events", async () => {
    const h = await startRelay({ pingMs: 50 });
    try {
      const { token } = await pairStart(h.base);
      const s = await openStream(h.base, token);
      const p = await s.waitFor((e) => e.event === "ping", 1000);
      assert.ok(typeof p.data.ts === "string");
      s.close();
    } finally {
      await h.close();
    }
  });

  it("closes streams on unpair", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      const s = await openStream(h.base, token);
      await fetch(`${h.base}/v1/unpair`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      await s.waitFor((e) => e.event === "revoked");
      await s.waitFor((e) => e.event === "__closed__");
    } finally {
      await h.close();
    }
  });

  it("drops last-known state after 24h of silence", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      await postEvent(h.base, token, goodEvent());
      const key = [...h.relay.store.tokens.keys()][0]!;
      h.clock.advance(23 * 3_600_000);
      h.relay.store.sweep(h.relay.config.stateTtlMs);
      assert.equal(h.relay.store.snapshot(key).length, 1);
      h.clock.advance(2 * 3_600_000);
      h.relay.store.sweep(h.relay.config.stateTtlMs);
      assert.equal(h.relay.store.snapshot(key).length, 0);
    } finally {
      await h.close();
    }
  });

  it("allows CORS from the desktop dev origin only", async () => {
    const h = await startRelay();
    try {
      const ok = await fetch(`${h.base}/v1/pair/start`, { method: "OPTIONS", headers: { origin: "http://localhost:1420" } });
      assert.equal(ok.status, 204);
      assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:1420");
      const bad = await fetch(`${h.base}/v1/pair/start`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
      assert.equal(bad.headers.get("access-control-allow-origin"), null);
    } finally {
      await h.close();
    }
  });
});
