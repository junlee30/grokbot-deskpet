// M2: optional per-bot Grok Bot avatar {shape, color} on events.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { VERSION } from "../src/server.ts";
import { migrate, SCHEMA_VERSION, Store } from "../src/store.ts";
import { AVATAR_COLORS, AVATAR_SHAPES, validateAvatar, validateEvent } from "../src/validate.ts";
import { goodEvent, newClock, openStream, pairStart, postEvent, startRelay } from "./helpers.ts";

describe("avatar validation", () => {
  it("knows all 26 shapes and the app's 11 colours", () => {
    assert.equal(AVATAR_SHAPES.length, 26);
    assert.equal(new Set(AVATAR_SHAPES).size, 26);
    assert.deepEqual(
      [...AVATAR_COLORS].sort(),
      ["black", "blue", "brown", "cyan", "gray", "green", "magenta", "orange", "red", "violet", "yellow"],
    );
    for (const s of ["blob", "clover", "heart", "pumpkin", "squircle", "wedge"]) assert.ok((AVATAR_SHAPES as readonly string[]).includes(s));
  });

  it("accepts every shape x colour", () => {
    for (const shape of AVATAR_SHAPES)
      for (const color of AVATAR_COLORS) {
        const r = validateAvatar({ shape, color });
        assert.deepEqual(r, { ok: true, value: { shape, color } });
      }
  });

  it("treats absent and null as not sent", () => {
    assert.deepEqual(validateAvatar(undefined), { ok: true, value: undefined });
    assert.deepEqual(validateAvatar(null), { ok: true, value: undefined });
    const e = validateEvent(goodEvent({ avatar: null }));
    assert.ok(e.ok && !("avatar" in e.value));
  });

  it("normalises case", () => {
    assert.deepEqual(validateAvatar({ shape: "Clover", color: "ORANGE" }), { ok: true, value: { shape: "clover", color: "orange" } });
  });

  const bad: Array<[string, unknown]> = [
    ["string", "blob"],
    ["array", ["blob", "black"]],
    ["number", 3],
    ["unknown shape", { shape: "triangle", color: "black" }],
    ["unknown colour", { shape: "blob", color: "teal" }],
    ["hex colour", { shape: "blob", color: "#ff6611" }],
    ["missing shape", { color: "black" }],
    ["missing colour", { shape: "blob" }],
    ["non-string shape", { shape: 1, color: "black" }],
    ["extra field", { shape: "blob", color: "black", url: "https://x" }],
    ["huge string", { shape: "b".repeat(10_000), color: "black" }],
    ["control chars", { shape: "blob\n", color: "black" }],
    ["prototype key", JSON.parse('{"shape":"blob","color":"black","__proto__":{"x":1}}')],
  ];
  for (const [name, v] of bad) {
    it(`rejects ${name}`, () => {
      assert.equal(validateAvatar(v).ok, false);
      assert.equal(validateEvent(goodEvent({ avatar: v })).ok, false);
    });
  }
});

describe("avatar over HTTP + SSE", () => {
  it("version is 0.3.0", () => assert.equal(VERSION, "0.3.0"));

  it("rejects a bad avatar with 400 and a clear error, stores nothing", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      const r = await postEvent(h.base, token, goodEvent({ avatar: { shape: "triangle", color: "black" } }));
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /avatar\.shape must be one of/);
      assert.equal(h.relay.store.dump().states!.length, 0);
      assert.equal(h.relay.store.dump().avatars!.length, 0);
    } finally {
      await h.close();
    }
  });

  it("events without avatar still work exactly as before (backwards compatible)", async () => {
    const h = await startRelay();
    try {
      const { token } = await pairStart(h.base);
      const s = await openStream(h.base, token);
      assert.equal((await postEvent(h.base, token, goodEvent())).status, 202);
      const ev = await s.waitFor((e) => e.event === "state");
      assert.equal("avatar" in ev.data, false);
      s.close();
    } finally {
      await h.close();
    }
  });

  it("stores the latest avatar per bot and attaches it to every state (live and catch-up)", async () => {
    const h = await startRelay({ rateBurst: 1000 });
    try {
      const { token } = await pairStart(h.base);
      const live = await openStream(h.base, token);
      // Session 1 sends an avatar; session 2 doesn't but still gets it.
      await postEvent(h.base, token, goodEvent({ agent_id: "claude", session: "c1", avatar: { shape: "clover", color: "orange" } }));
      await postEvent(h.base, token, goodEvent({ agent_id: "claude", session: "c2", state: "thinking" }));
      await postEvent(h.base, token, goodEvent({ agent_id: "jarvis", session: "j1" }));
      const c2 = await live.waitFor((e) => e.event === "state" && e.data.session === "c2");
      assert.deepEqual(c2.data.avatar, { shape: "clover", color: "orange" });
      const j1 = await live.waitFor((e) => e.event === "state" && e.data.session === "j1");
      assert.equal(j1.data.avatar, undefined, "avatar is per bot, not per token");

      // Change of avatar: the newest wins, and catch-up shows it for older sessions too.
      await postEvent(h.base, token, goodEvent({ agent_id: "claude", session: "c2", avatar: { shape: "heart", color: "red" } }));
      live.close();
      const s = await openStream(h.base, token);
      await s.waitFor((e) => e.event === "ready");
      const claude = s.events.filter((e) => e.event === "state" && e.data.agent_id === "claude");
      assert.equal(claude.length, 2);
      for (const e of claude) assert.deepEqual(e.data.avatar, { shape: "heart", color: "red" });
      const rows = h.relay.store.dump().avatars as Array<{ agent_id: string; shape: string; color: string }>;
      assert.deepEqual(
        rows.map((r) => [r.agent_id, r.shape, r.color]),
        [["claude", "heart", "red"]],
      );
      // The avatar is not duplicated into state rows.
      for (const r of h.relay.store.dump().states as Array<{ state_json: string }>) assert.ok(!r.state_json.includes("avatar"));
      s.close();
    } finally {
      await h.close();
    }
  });

  it("forgets avatars on unpair and when the bot's states are swept", async () => {
    const clock = newClock();
    const h = await startRelay({}, { clock });
    try {
      const a = await pairStart(h.base);
      const b = await pairStart(h.base);
      await postEvent(h.base, a.token, goodEvent({ avatar: { shape: "blob", color: "black" } }));
      await postEvent(h.base, b.token, goodEvent({ avatar: { shape: "heart", color: "red" } }));
      assert.equal(h.relay.store.dump().avatars!.length, 2);
      await fetch(`${h.base}/v1/unpair`, { method: "POST", headers: { authorization: `Bearer ${a.token}` } });
      assert.equal(h.relay.store.dump().avatars!.length, 1);
      clock.advance(25 * 3_600_000);
      h.relay.store.sweep(24 * 3_600_000);
      assert.equal(h.relay.store.dump().avatars!.length, 0);
    } finally {
      await h.close();
    }
  });

  it("evicting the oldest bot (agent cap) drops its avatar", async () => {
    const clock = newClock();
    const h = await startRelay({ maxAgentsPerToken: 2, rateBurst: 1000 }, { clock });
    try {
      const { token } = await pairStart(h.base);
      await postEvent(h.base, token, goodEvent({ agent_id: "a", avatar: { shape: "blob", color: "black" } }));
      clock.advance(10);
      await postEvent(h.base, token, goodEvent({ agent_id: "b", avatar: { shape: "star", color: "yellow" } }));
      clock.advance(10);
      await postEvent(h.base, token, goodEvent({ agent_id: "c" }));
      const ids = (h.relay.store.dump().avatars as Array<{ agent_id: string }>).map((r) => r.agent_id);
      assert.deepEqual(ids, ["b"]);
    } finally {
      await h.close();
    }
  });
});

describe("avatar persistence", () => {
  it("migration 3 upgrades an M1 database, and avatars survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deskpet-m2-"));
    const file = join(dir, "d.sqlite");
    try {
      // An M1-shaped database (user_version 2).
      const m1 = new DatabaseSync(file);
      m1.exec("PRAGMA user_version = 0");
      m1.close();
      {
        const s = Store.open(file);
        s.db.exec("DROP TABLE avatars; PRAGMA user_version = 2");
        s.close();
      }
      const s = Store.open(file);
      assert.equal(migrate(s.db), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 3);
      assert.equal(s.dump().avatars!.length, 0);
      s.putState("t".repeat(64), { ...(goodEvent() as object), received_at: "x", avatar: { shape: "egg", color: "cyan" } } as never, 8, 8);
      s.close();
      const again = Store.open(file);
      const snap = again.snapshot("t".repeat(64));
      assert.deepEqual(snap[0]!.state.avatar, { shape: "egg", color: "cyan" });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
