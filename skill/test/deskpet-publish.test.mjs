// Tests for skill/deskpet-publish (the bot-side v2 publisher) against a local fake ntfy.
// Run: node --test skill/test/
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "../../scripts/fake-ntfy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "deskpet-publish");
const require = createRequire(import.meta.url);
const m = require(SCRIPT);

// The shared protocol file: the Rust pet (desktop/src-tauri/src/v2.rs) tests against it too.
const PROTOCOL = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "protocol", "v2.json"), "utf8"));
const { code: FIXTURE_CODE, plaintext: FIXTURE_PLAINTEXT, envelope: FIXTURE_ENVELOPE } = PROTOCOL.fixture;

const fixedPairing = () => ({
  base: "https://ntfy.sh",
  topic: Buffer.from([...Array(16).keys()]),
  key: Buffer.from([...Array(32).keys()].map((i) => 0x80 + i)),
});
const newPairing = (base) => ({ base, topic: crypto.randomBytes(16), key: crypto.randomBytes(32) });

function run(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = execFile(SCRIPT, args, { env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env }, timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr, ms: Date.now() - t0 }),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

describe("crypto", () => {
  test("HChaCha20 matches the draft-irtf-cfrg-xchacha test vector (2.2.1)", () => {
    const key = Buffer.from([...Array(32).keys()]);
    const nonce = Buffer.from("000000090000004a0000000031415927", "hex");
    assert.equal(m.hchacha20(key, nonce).toString("hex"), "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc");
  });

  test("fixed vector: identical bytes to the Rust pet (cross-implementation)", () => {
    const p = fixedPairing();
    assert.equal(m.encodePairing(p), FIXTURE_CODE);
    assert.equal(m.topicName(p), "AAECAwQFBgcICQoLDA0ODw");
    const nonce = Buffer.from([...Array(24).keys()].map((i) => 0x40 + i));
    assert.equal(m.seal(p, FIXTURE_PLAINTEXT, nonce), FIXTURE_ENVELOPE);
    assert.equal(m.open(p, FIXTURE_ENVELOPE).toString(), FIXTURE_PLAINTEXT);
  });

  test("round trip, random nonce, tamper, wrong key, wrong topic", () => {
    const p = newPairing("https://ntfy.sh");
    const pt = JSON.stringify({ hello: "world" });
    const env = m.seal(p, pt);
    assert.equal(m.open(p, env).toString(), pt);
    assert.notEqual(m.seal(p, pt), env);
    const o = JSON.parse(env);
    const c = Buffer.from(o.c, "base64url");
    for (const i of [0, c.length >> 1, c.length - 1]) {
      const c2 = Buffer.from(c);
      c2[i] ^= 1;
      assert.throws(() => m.open(p, JSON.stringify({ ...o, c: c2.toString("base64url") })));
    }
    assert.throws(() => m.open({ ...p, key: crypto.randomBytes(32) }, env), "wrong key");
    assert.throws(() => m.open({ ...p, topic: crypto.randomBytes(16) }, env), "AAD binds the topic");
  });
});

describe("pairing string", () => {
  test("round trip: default and self-hosted mailbox", () => {
    const p = newPairing("https://ntfy.sh");
    const s = m.encodePairing(p);
    assert.match(s, /^dp2\.[A-Za-z0-9_-]{71}$/);
    assert.deepEqual(m.decodePairing(s), p);
    assert.deepEqual(m.decodePairing(`  ${s}.\n`), p);
    const q = newPairing("https://ntfy.example.com/sub");
    assert.deepEqual(m.decodePairing(m.encodePairing(q)), q);
    assert.equal(m.decodePairing(m.encodePairing(newPairing("http://127.0.0.1:9"))).base, "http://127.0.0.1:9");
  });

  test("rejects v1 codes, mangled and cut-off codes without echoing them", () => {
    const s = m.encodePairing(newPairing("https://ntfy.sh"));
    const flip = s.slice(0, 20) + (s[20] === "A" ? "B" : "A") + s.slice(21);
    for (const bad of ["K7Q-42M", flip, s.slice(0, 40), "dp2.%%%", "dp2."]) {
      assert.throws(
        () => m.decodePairing(bad),
        (e) => !e.message.includes(s.slice(4, 20)) && /pairing code|dp2/.test(e.message),
      );
    }
    assert.throws(() => m.decodePairing(m.encodePairing(newPairing("http://evil.example.com"))), /https/);
  });
});

describe("protocol/v2.json", () => {
  test("constants and version match", () => {
    assert.equal(m.VERSION, PROTOCOL.publisher_version, "bump protocol/v2.json publisher_version with VERSION");
    assert.deepEqual(m.STATES, PROTOCOL.states);
    assert.deepEqual(m.SHAPES, PROTOCOL.avatar_shapes);
    assert.deepEqual(m.COLORS, PROTOCOL.avatar_colors);
  });

  test("the publisher builds exactly the valid events", () => {
    for (const { $comment, ...want } of PROTOCOL.valid) {
      const got = m.buildEvent({
        agentId: want.agent_id,
        agentName: want.agent_name,
        session: want.session,
        state: want.state,
        event: want.event,
        message: want.message,
        avatar: want.avatar,
        grokbotId: want.grokbot_id,
        now: Date.parse(want.ts),
        seq: want.seq,
        dropped: want.dropped,
      });
      assert.deepEqual(got, want);
    }
  });

  test("the publisher refuses what it can't fix", () => {
    for (const c of PROTOCOL.invalid.filter((c) => c.publisher_rejects)) {
      const e = c.event;
      assert.throws(() => m.buildEvent({ agentId: e.agent_id, agentName: e.agent_id, session: e.session, state: e.state, event: e.event, now: 0, seq: 1 }), undefined, c.why);
    }
  });
});

describe("event building and throttling", () => {
  const base = { agentId: "Jarvis", agentName: "Jarvis", state: "working", event: "tool_start", session: "s", now: Date.parse("2026-11-16T12:00:00Z"), seq: 5 };

  test("fields, cleaning and limits", () => {
    const e = m.buildEvent({ ...base, message: "  Running\n\ttests  ", avatar: "Star/Blue" });
    assert.deepEqual(e, {
      agent_id: "jarvis",
      agent_name: "Jarvis",
      session: "s",
      state: "working",
      event: "tool_start",
      message: "Running tests",
      ts: "2026-11-16T12:00:00.000Z",
      seq: 5,
      avatar: { shape: "star", color: "blue" },
      pv: m.VERSION,
    });
    assert.equal(m.buildEvent({ ...base, dropped: 7 }).dropped, 7);
    for (const d of [0, -1, 1.5, "3", undefined]) assert.ok(!("dropped" in m.buildEvent({ ...base, dropped: d })), String(d));
    const long = m.buildEvent({ ...base, message: "é".repeat(300), agentName: "n".repeat(100) });
    assert.equal([...long.message].length, 160);
    assert.equal(long.agent_name.length, 64);
    assert.throws(() => m.buildEvent({ ...base, state: "dancing" }));
    assert.throws(() => m.buildEvent({ ...base, agentId: "has space" }));
    assert.throws(() => m.buildEvent({ ...base, event: "a b" }));
    // The biggest possible event still fits ntfy's 4096-byte message limit once sealed.
    const big = m.buildEvent({ ...base, dropped: 1000000, grokbotId: "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f", agentId: "a".repeat(64), agentName: "💥".repeat(64), session: "😀".repeat(128), message: "😀".repeat(200), avatar: "squircle/magenta" });
    assert.ok(m.seal(newPairing("https://ntfy.sh"), JSON.stringify(big)).length < 4096);
  });

  test("avatar from JSON, shape/color, or nothing", () => {
    assert.deepEqual(m.parseAvatar('{"shape":"Blob","color":"black"}'), { shape: "blob", color: "black" });
    assert.deepEqual(m.parseAvatar("heart:red"), { shape: "heart", color: "red" });
    assert.equal(m.parseAvatar("blob/#000"), null);
    assert.equal(m.parseAvatar("https://x/y.png"), null);
    assert.equal(m.parseAvatar(""), null);
    assert.equal(m.parseAvatar("{broken"), null);
  });

  test("grokbot_id: a lowercase UUID or nothing", () => {
    const id = "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
    assert.equal(m.parseGrokbotId(id), id);
    assert.equal(m.parseGrokbotId(`  ${id.toUpperCase()}\n`), id, "trimmed and lowercased before the strict check");
    for (const bad of [
      "",
      "jarvis",
      id.replace(/-/g, ""),
      `{${id}}`,
      `urn:uuid:${id}`,
      `${id}0`,
      id.slice(1),
      id.replace("2f06", "2g06"),
      `${id}&x=1`,
      `${id}/../x`,
      "2f06d68c-1b2a-4c3d-8e9f_0a1b2c3d4e5f",
      undefined,
      null,
      42,
    ]) {
      assert.equal(m.parseGrokbotId(bad), null, String(bad));
    }
    assert.equal(m.buildEvent({ ...base, grokbotId: id }).grokbot_id, id);
    assert.ok(!("grokbot_id" in m.buildEvent({ ...base, grokbotId: "not-a-uuid" })), "a bad id is dropped, the event still goes");
    assert.ok(!("grokbot_id" in m.buildEvent(base)));
  });

  test("options: --session, --avatar, --grokbot-id (space or =), the rest is the message", () => {
    const id = "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
    assert.deepEqual(m.parseArgs(["jarvis", "Jarvis", "done", "turn_end", "All", "good", "--grokbot-id", id, "--avatar=blob/black", "--session", "s-1"]), {
      pos: ["jarvis", "Jarvis", "done", "turn_end", "All", "good"],
      opt: { "grokbot-id": id, avatar: "blob/black", session: "s-1" },
    });
    assert.deepEqual(m.parseArgs([`--grokbot-id=${id}`]).opt, { "grokbot-id": id });
    assert.deepEqual(m.parseArgs(["--unknown=x"]).pos, ["--unknown=x"], "unknown options stay in the message");
  });

  test("heartbeat throttle, duplicates, rate-limit backoff", () => {
    const now = 1_000_000_000;
    const st = { sessions: { k: { state: "working", event: "tool_start", message: "", at: now - 60_000 } } };
    assert.equal(m.skipReason(st, "k", { state: "working", event: "heartbeat" }, now), "heartbeat throttled");
    assert.equal(m.skipReason(st, "k", { state: "working", event: "heartbeat" }, now + 4 * 60_000), null);
    assert.equal(m.skipReason(st, "k", { state: "done", event: "heartbeat" }, now), null);
    st.sessions.k.at = now - 2000;
    assert.equal(m.skipReason(st, "k", { state: "working", event: "tool_start" }, now), "duplicate");
    assert.equal(m.skipReason(st, "k", { state: "working", event: "tool_start", message: "other" }, now), "same state, too soon");
    assert.equal(m.skipReason(st, "k", { state: "working", event: "tool_start", message: "other" }, now + 15_000), null);
    assert.equal(m.skipReason(st, "k", { state: "needs_you", event: "waiting" }, now), null, "a state change always goes");
    st.sessions.k.state = "needs_you";
    assert.equal(m.skipReason(st, "k", { state: "needs_you", event: "waiting", message: "another question" }, now), null, "only busy states are throttled");
    assert.equal(m.skipReason({ sessions: {}, backoffUntil: now + 1 }, "k", { state: "done", event: "turn_end" }, now), "mailbox rate limit, backing off");
  });
});

describe("CLI against a fake ntfy", () => {
  let fake;
  let home;
  let pairing;
  let code;
  const env = () => ({ DESK_PET_HOME: home, DESK_PET_DEBUG: "1" });
  const messages = () => [...fake.topics.values()].flat();

  before(async () => {
    fake = await startFakeNtfy({ keepaliveMs: 60_000 });
    home = fs.mkdtempSync(path.join(os.tmpdir(), "deskpet-pub-"));
    pairing = newPairing(fake.url);
    code = m.encodePairing(pairing);
  });
  after(async () => {
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("not paired: fails open quietly", async () => {
    const r = await run(["jarvis", "Jarvis", "working", "tool_start"], { env: env() });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /not paired/);
    const s = await run(["status"], { env: env() });
    assert.equal(s.stdout.trim(), "not paired");
  });

  test("pair: bad code is rejected without echo", async () => {
    const r = await run(["pair"], { env: env(), input: code.slice(0, 30) });
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes(code.slice(4, 30)));
    assert.ok(!fs.existsSync(path.join(home, "pairing")));
  });

  test("pair from stdin (inside a sentence), 0600 file, no secrets printed", async () => {
    const r = await run(["pair"], { env: env(), input: `Install the Desk Pet skill and pair with code ${code}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), `Paired with Desk Pet (mailbox 127.0.0.1:${fake.port}).`);
    const st = fs.statSync(path.join(home, "pairing"));
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(home, "pairing"), "utf8").trim(), code);
    const s = await run(["status"], { env: env() });
    assert.equal(s.code, 0);
    assert.ok(!s.stdout.includes(code.slice(4)) && !s.stdout.includes(m.topicName(pairing)));
  });

  test("publish: the mailbox gets only ciphertext; it decrypts to the event", async () => {
    const r = await run(["Jarvis", "Jarvis", "working", "tool_start", "Running", "tests", "--avatar", "blob/black"], {
      env: { ...env(), DESK_PET_SESSION: "chat-1" },
    });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /sent 200/);
    for (const out of [r.stdout, r.stderr]) {
      assert.ok(!out.includes(m.topicName(pairing)) && !out.includes(code.slice(4)), "no secrets in output");
    }
    const msgs = fake.topics.get(m.topicName(pairing));
    assert.equal(msgs.length, 1);
    assert.ok(!msgs[0].message.includes("Running"), "ciphertext only");
    const e = JSON.parse(m.open(pairing, msgs[0].message).toString());
    assert.equal(e.agent_id, "jarvis");
    assert.equal(e.session, "chat-1");
    assert.equal(e.message, "Running tests");
    assert.deepEqual(e.avatar, { shape: "blob", color: "black" });
    assert.ok(!("grokbot_id" in e), "no --grokbot-id, no field");
    assert.ok(Math.abs(Date.parse(e.ts) - Date.now()) < 10_000);
    const req = fake.requests.findLast((q) => q.method === "POST");
    assert.equal(req.headers["x-firebase"], "no");
    assert.equal(req.headers["user-agent"], "deskpet-publish/2");
  });

  test("seq strictly increases per session; duplicates and early heartbeats are skipped", async () => {
    const before = messages().length;
    const e2 = { ...env(), DESK_PET_SESSION: "chat-2", DESK_PET_AVATAR: '{"shape":"heart","color":"red"}' };
    for (const st of ["thinking", "working", "done"]) {
      const r = await run(["scout", "Scout", st, "step"], { env: e2 });
      assert.match(r.stderr, /sent/);
    }
    const dup = await run(["scout", "Scout", "done", "step"], { env: e2 });
    assert.match(dup.stderr, /skipped: duplicate/);
    const hb1 = await run(["scout", "Scout", "done", "heartbeat"], { env: e2 });
    assert.match(hb1.stderr, /skipped: heartbeat throttled/);
    const got = messages().slice(before).map((x) => JSON.parse(m.open(pairing, x.message).toString()));
    assert.deepEqual(got.map((e) => e.state), ["thinking", "working", "done"]);
    assert.ok(got[0].seq < got[1].seq && got[1].seq < got[2].seq);
    assert.deepEqual(got[0].avatar, { shape: "heart", color: "red" });
  });

  test("publish: --grokbot-id and DESK_PET_GROKBOT_ID reach the event; the option wins; junk is dropped", async () => {
    const id = "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
    const other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const before = messages().length;
    const cases = [
      { args: ["--grokbot-id", id], env: {}, want: id },
      { args: [], env: { DESK_PET_GROKBOT_ID: other.toUpperCase() }, want: other },
      { args: [`--grokbot-id=${id}`], env: { DESK_PET_GROKBOT_ID: other }, want: id },
      { args: [], env: { DESK_PET_GROKBOT_ID: "javascript:alert(1)" }, want: undefined },
    ];
    for (const [i, c] of cases.entries()) {
      const r = await run(["gid", "Gid", "working", `step${i}`, ...c.args], { env: { ...env(), DESK_PET_SESSION: `chat-gid-${i}`, ...c.env } });
      assert.match(r.stderr, /sent 200/);
    }
    const got = messages().slice(before).map((x) => JSON.parse(m.open(pairing, x.message).toString()));
    assert.deepEqual(got.map((e) => e.grokbot_id), cases.map((c) => c.want));
  });

  test("node https/http fallback when curl is unavailable", async () => {
    const r = await run(["jarvis", "Jarvis", "idle", "nocurl"], { env: { ...env(), DESK_PET_NO_CURL: "1" } });
    assert.match(r.stderr, /sent 200/);
    const last = messages().at(-1);
    assert.equal(JSON.parse(m.open(pairing, last.message).toString()).event, "nocurl");
  });

  test("429 from the mailbox: back off, no further requests", async () => {
    fake.setMode("429");
    const r = await run(["jarvis", "Jarvis", "error", "error"], { env: env() });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /failed: mailbox answered 429/);
    fake.setMode("ok");
    const n = fake.requests.length;
    const r2 = await run(["jarvis", "Jarvis", "done", "turn_end"], { env: env() });
    assert.match(r2.stderr, /backing off/);
    assert.equal(fake.requests.length, n, "no request while backing off");
    const st = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    assert.ok(st.backoffUntil > Date.now());
    assert.equal(st.dropped, 2, "the 429'd post and the one skipped while backing off");
    assert.equal(fs.statSync(path.join(home, "state.json")).mode & 0o777, 0o600);

    // Backoff over: the next post that goes through tells the pet how many were dropped.
    fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ ...st, backoffUntil: Date.now() - 1 }));
    const r3 = await run(["jarvis", "Jarvis", "idle", "after_backoff"], { env: env() });
    assert.match(r3.stderr, /sent 200/);
    const e = JSON.parse(m.open(pairing, messages().at(-1).message).toString());
    assert.equal(e.dropped, 2);
    assert.ok(!("dropped" in JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"))), "reset once reported");
  });

  test("unreachable mailbox: exit 0 within the timeout", async () => {
    const h2 = fs.mkdtempSync(path.join(os.tmpdir(), "deskpet-pub-"));
    const dead = await startFakeNtfy();
    const url = dead.url;
    await dead.close();
    const p = await run(["pair"], { env: { DESK_PET_HOME: h2 }, input: m.encodePairing(newPairing(url)) });
    assert.equal(p.code, 0);
    const r = await run(["jarvis", "Jarvis", "working", "tool_start"], { env: { DESK_PET_HOME: h2, DESK_PET_DEBUG: "1" } });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /failed: mailbox unreachable/);
    assert.ok(r.ms < 4500, `took ${r.ms} ms`);
    fs.rmSync(h2, { recursive: true, force: true });
  });

  test("--version, and every event carries pv", async () => {
    const v = await run(["--version"]);
    assert.equal(v.stdout.trim(), `deskpet-publish ${m.VERSION}`);
    assert.match(m.VERSION, /^\d+\.\d+\.\d+$/);
    const r = await run(["pv", "Pv", "idle", "pvcheck"], { env: env() });
    assert.match(r.stderr, /sent 200/);
    const e = JSON.parse(m.open(pairing, messages().at(-1).message).toString());
    assert.equal(e.pv, m.VERSION);
    assert.ok(!("dropped" in e));
  });

  test("init from a Grok Bot profile, then --bot posts carry its name, avatar and id", async () => {
    const id = "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
    const dir = path.join(home, "agents", id);
    fs.mkdirSync(dir, { recursive: true });
    const profile = path.join(dir, "profile.json");
    fs.writeFileSync(profile, JSON.stringify({ name: "Jarvis", avatarShape: "Blob", avatarColor: "black", avatarPngBase64: "x" }));
    const r = await run(["init", "jarvis", "--profile", profile], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Set up jarvis \("Jarvis", avatar blob\/black, Grok Bot id 2f06d68c/);
    assert.equal(fs.statSync(path.join(home, "bots", "jarvis.json")).mode & 0o777, 0o600);

    const p1 = await run(["--bot", "jarvis", "working", "tool_start", "Running", "tests"], { env: { ...env(), DESK_PET_SESSION: "bot-1" } });
    assert.match(p1.stderr, /sent 200/);
    let e = JSON.parse(m.open(pairing, messages().at(-1).message).toString());
    assert.deepEqual([e.agent_id, e.agent_name, e.message, e.grokbot_id], ["jarvis", "Jarvis", "Running tests", id]);
    assert.deepEqual(e.avatar, { shape: "blob", color: "black" });

    // The user changes the avatar and name in Grok Bot: the next post picks them up.
    fs.writeFileSync(profile, JSON.stringify({ name: "J.A.R.V.I.S.", avatarShape: "heart", avatarColor: "red" }));
    const p2 = await run(["done", "turn_end"], { env: { ...env(), DESK_PET_BOT: "jarvis", DESK_PET_SESSION: "bot-1" } });
    assert.match(p2.stderr, /sent 200/);
    e = JSON.parse(m.open(pairing, messages().at(-1).message).toString());
    assert.equal(e.agent_name, "J.A.R.V.I.S.");
    assert.deepEqual(e.avatar, { shape: "heart", color: "red" });

    const list = await run(["bots"], { env: env() });
    assert.match(list.stdout, /^jarvis\tJ\.A\.R\.V\.I\.S\.\theart\/red\t2f06d68c/);
  });

  test("init with an explicit name and options; unknown --bot fails open", async () => {
    const r = await run(["init", "Scout", "Scout", "the", "Scout", "--avatar", "star/cyan"], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Set up scout \("Scout the Scout", avatar star\/cyan, no Grok Bot id\)/);
    const bad = await run(["init", "Bad Id!"], { env: env() });
    assert.equal(bad.code, 1);
    const missing = await run(["init", "x", "--profile", path.join(home, "nope.json")], { env: env() });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /can't read the profile/);
    const n = fake.requests.length;
    const u = await run(["--bot", "ghost", "working", "tool_start"], { env: env() });
    assert.equal(u.code, 0);
    assert.match(u.stderr, /no bot "ghost" set up here/);
    assert.equal(fake.requests.length, n);
  });

  test("access token: sent as a Bearer header, never printed", async () => {
    const tok = "tk_abcdefghijklmnopqrstuvwxyz012";
    const t = await run(["token"], { env: env(), input: `${tok}\n` });
    assert.equal(t.code, 0);
    assert.ok(!t.stdout.includes(tok));
    assert.equal(fs.statSync(path.join(home, "ntfy-token")).mode & 0o777, 0o600);
    assert.match((await run(["status"], { env: env() })).stdout, /access token set/);
    for (const extra of [{}, { DESK_PET_NO_CURL: "1" }]) {
      const r = await run(["tok", "Tok", "idle", `tok${Object.keys(extra).length}`], { env: { ...env(), ...extra } });
      assert.match(r.stderr, /sent 200/);
      assert.ok(!r.stderr.includes(tok));
      assert.equal(fake.requests.findLast((q) => q.method === "POST").headers.authorization, `Bearer ${tok}`);
    }
    assert.equal((await run(["token"], { env: env(), input: "bad token!" })).code, 1);
    assert.equal((await run(["token", "--clear"], { env: env() })).code, 0);
    await run(["tok", "Tok", "done", "tok-cleared"], { env: env() });
    assert.equal(fake.requests.findLast((q) => q.method === "POST").headers.authorization, undefined);
  });

  test("unpair removes the pairing", async () => {
    const r = await run(["unpair"], { env: env() });
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(path.join(home, "pairing")));
    const s = await run(["jarvis", "Jarvis", "idle", "x"], { env: env() });
    assert.match(s.stderr, /not paired/);
  });
});
