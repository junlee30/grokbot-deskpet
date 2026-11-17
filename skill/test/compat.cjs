// Smoke test for the oldest Node the publisher supports (12): no node:test, no ESM, only
// assert/http/child_process. CI runs it on Node 12 and on the current LTS.
//   node skill/test/compat.cjs
"use strict";

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "deskpet-publish");
const m = require(SCRIPT);

// Same fixture as deskpet-publish.test.mjs and desktop/src-tauri/src/v2.rs.
const FIXTURE_CODE = "dp2.AgABAgMEBQYHCAkKCwwNDg-AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en5N--3c";
const FIXTURE_PLAINTEXT = `{"agent_id":"jarvis","session":"s-1","state":"idle","event":"paired","ts":"2026-11-16T12:00:00Z","seq":1}`;
const FIXTURE_ENVELOPE =
  '{"v":2,"n":"QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZX","c":"ii4Skz6egAWSdlXp1MT8J0QuAUwpZu-JucmcYyx3N-pzESFfB0_sCVCnhGtUsTc-rXSIOI5e0hXAkLVtXxb1VDOFhqZO-cgW50g7q9Sc_5N6ZuQ6k0gNyD7nJC8mlsuobqlwTIhhMPd-d5gliJQwWJD_jkGt8-Yd8Q"}';

function run(args, env, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [SCRIPT].concat(args), { env: Object.assign({ PATH: process.env.PATH, HOME: os.tmpdir() }, env), timeout: 10000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code || 1 : 0, stdout, stderr }),
    );
    child.stdin.end(input === undefined ? "" : input);
  });
}

function rmrf(dir) {
  if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
  else fs.rmdirSync(dir, { recursive: true });
}

async function main() {
  // Crypto: the IETF HChaCha20 vector and the cross-implementation fixture.
  const key = Buffer.from(Array.from(Array(32).keys()));
  const n16 = Buffer.from("000000090000004a0000000031415927", "hex");
  assert.strictEqual(m.hchacha20(key, n16).toString("hex"), "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc");
  const fixed = {
    base: "https://ntfy.sh",
    topic: Buffer.from(Array.from(Array(16).keys())),
    key: Buffer.from(Array.from(Array(32).keys()).map((i) => 0x80 + i)),
  };
  assert.strictEqual(m.encodePairing(fixed), FIXTURE_CODE);
  const nonce = Buffer.from(Array.from(Array(24).keys()).map((i) => 0x40 + i));
  assert.strictEqual(m.seal(fixed, FIXTURE_PLAINTEXT, nonce), FIXTURE_ENVELOPE);
  assert.strictEqual(m.open(fixed, FIXTURE_ENVELOPE).toString(), FIXTURE_PLAINTEXT);

  // CLI end to end against a tiny in-process mailbox.
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      got.push({ url: req.url, body, auth: req.headers.authorization });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deskpet-compat-"));
  try {
    const p = { base, topic: crypto.randomBytes(16), key: crypto.randomBytes(32) };
    const env = { DESK_PET_HOME: home, DESK_PET_DEBUG: "1" };
    assert.strictEqual((await run(["--version"], env)).stdout.trim(), `deskpet-publish ${m.VERSION}`);
    assert.strictEqual((await run(["pair"], env, m.encodePairing(p))).code, 0);
    assert.strictEqual((await run(["init", "jarvis", "Jarvis", "--avatar", "blob/black"], env)).code, 0);
    assert.strictEqual((await run(["token"], env, "tk_compat")).code, 0);
    for (const extra of [{}, { DESK_PET_NO_CURL: "1" }]) {
      const r = await run(["--bot", "jarvis", extra.DESK_PET_NO_CURL ? "done" : "working", "step", "hello"], Object.assign({}, env, extra));
      assert.ok(/sent 200/.test(r.stderr), r.stderr);
    }
    assert.strictEqual(got.length, 2);
    for (const g of got) {
      assert.strictEqual(g.url, `/${m.topicName(p)}`);
      assert.strictEqual(g.auth, "Bearer tk_compat");
      const e = JSON.parse(m.open(p, g.body).toString());
      assert.strictEqual(e.agent_name, "Jarvis");
      assert.strictEqual(e.pv, m.VERSION);
      assert.deepStrictEqual(e.avatar, { shape: "blob", color: "black" });
    }
  } finally {
    server.close();
    rmrf(home);
  }
  process.stdout.write(`compat ok on node ${process.version}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
