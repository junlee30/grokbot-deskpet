import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CODE_RE, normalizeCode } from "../src/crypto.ts";
import { goodEvent, openStream, pairStart, postEvent, startRelay } from "./helpers.ts";

function pair(base: string, body: unknown) {
  return fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("pairing", () => {
  it("issues a human code and a long token", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      assert.match(p.code, CODE_RE);
      assert.ok(Buffer.from(p.token, "base64url").length >= 32);
      assert.equal(Date.parse(p.expires_at) - h.clock.t, 15 * 60_000);
    } finally {
      await h.close();
    }
  });

  it("exchanges the code for the same token exactly once", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      const r = await pair(h.base, { code: p.code, agent_id: "jarvis", agent_name: "Jarvis" });
      assert.equal(r.status, 200);
      const j = (await r.json()) as { token: string; relay_url: string };
      assert.equal(j.token, p.token);
      assert.equal(j.relay_url, h.base);
      assert.equal((await postEvent(h.base, j.token, goodEvent())).status, 202);
      const again = await pair(h.base, { code: p.code });
      assert.equal(again.status, 410);
    } finally {
      await h.close();
    }
  });

  it("normalises lowercase / dashless codes", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      const r = await pair(h.base, { code: p.code.replace("-", "").toLowerCase() });
      assert.equal(r.status, 200);
      assert.equal(normalizeCode(" k7q42m "), "K7Q-42M");
      assert.equal(normalizeCode("K0Q-42M"), null); // 0 is not in the alphabet
    } finally {
      await h.close();
    }
  });

  it("rejects wrong, malformed and expired codes", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      const wrong = p.code === "AAA-AAA" ? "BBB-BBB" : "AAA-AAA";
      assert.equal((await pair(h.base, { code: wrong })).status, 404);
      assert.equal((await pair(h.base, { code: "nope" })).status, 400);
      assert.equal((await pair(h.base, {})).status, 400);
      assert.equal((await pair(h.base, { code: p.code, extra: 1 })).status, 400);
      h.clock.advance(15 * 60_000 + 1);
      assert.equal((await pair(h.base, { code: p.code })).status, 410);
    } finally {
      await h.close();
    }
  });

  it("notifies the desktop stream when the bot pairs", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      const s = await openStream(h.base, p.token);
      await pair(h.base, { code: p.code, agent_id: "scout", agent_name: "Scout" });
      const ev = await s.waitFor((e) => e.event === "paired");
      assert.equal(ev.data.agent_name, "Scout");
      s.close();
    } finally {
      await h.close();
    }
  });

  it("rate-limits pairing attempts per client", async () => {
    const h = await startRelay({ pairRatePerMin: 10, pairRateBurst: 3 });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await pair(h.base, { code: "AAA-AAA" })).status, 404);
      assert.equal((await pair(h.base, { code: "AAA-AAA" })).status, 429);
    } finally {
      await h.close();
    }
  });
});

describe("token hashed at rest", () => {
  it("never keeps the raw token in the in-memory store", async () => {
    const h = await startRelay();
    try {
      const p = await pairStart(h.base);
      await postEvent(h.base, p.token, goodEvent({ message: "hello" }));
      let dump = JSON.stringify(h.relay.store.dump());
      assert.ok(!dump.includes(p.token), "raw token found in store before redemption");
      assert.ok(!dump.includes(p.code), "raw code found in store");
      assert.ok(!dump.includes("hello"), "message body persisted");
      await pair(h.base, { code: p.code });
      dump = JSON.stringify(h.relay.store.dump());
      assert.ok(!dump.includes(p.token), "raw token found in store after redemption");
      const live = h.relay.store.liveTokenHashes();
      assert.equal(live.length, 1);
      assert.match(live[0]!, /^[0-9a-f]{64}$/);
    } finally {
      await h.close();
    }
  });

  it("never writes the raw token, code or message to the SQLite file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deskpet-"));
    const file = join(dir, "relay.sqlite");
    const h = await startRelay({}, { dbPath: file });
    let token = "";
    let code = "";
    try {
      ({ token, code } = await pairStart(h.base));
      // pending pairing on disk: only the sealed token
      let bytes = readFileSync(file);
      assert.ok(!bytes.includes(Buffer.from(token)), "raw token in sqlite file (pending)");
      assert.equal((await pair(h.base, { code })).status, 200);
      assert.equal((await postEvent(h.base, token, goodEvent({ message: "private-hint-xyz" }))).status, 202);
      bytes = Buffer.concat([readFileSync(file), readFileSync(`${file}-wal`)]);
      for (const needle of [token, code, "private-hint-xyz"]) assert.ok(!bytes.includes(Buffer.from(needle)), "secret in sqlite file");
    } finally {
      await h.close();
    }
    const bytes = readFileSync(file);
    for (const needle of [token, code, "private-hint-xyz"]) assert.ok(!bytes.includes(Buffer.from(needle)), "secret in sqlite file");
    rmSync(dir, { recursive: true, force: true });
  });
});
