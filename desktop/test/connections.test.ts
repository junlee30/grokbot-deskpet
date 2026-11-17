// v1 + v2 side by side: status merging, boot view, paste line, mailbox URL validation.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bootView, combineStatus, looksLikeDp2, pasteLineV2 } from "../src/connections.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "../src/net.ts";

describe("combineStatus", () => {
  it("nothing active: quiet", () => {
    assert.deepEqual(combineStatus(null, null), { status: "online", text: "" });
  });
  it("one connection: same wording as before (no tag)", () => {
    assert.deepEqual(combineStatus({ status: "online" }, null), { status: "online", text: "" });
    assert.deepEqual(combineStatus(null, { status: "connecting" }), { status: "connecting", text: "connecting…" });
    assert.deepEqual(combineStatus(null, { status: "offline", detail: "mailbox unreachable" }), {
      status: "offline",
      text: "offline · mailbox unreachable",
    });
    assert.deepEqual(combineStatus({ status: "offline" }, null), { status: "offline", text: "offline · retrying" });
  });
  it("both: pets stay live while either is online; the troubled one is named", () => {
    assert.deepEqual(combineStatus({ status: "offline", detail: "relay unreachable" }, { status: "online" }), {
      status: "online",
      text: "relay offline · relay unreachable",
    });
    assert.deepEqual(combineStatus({ status: "online" }, { status: "connecting" }), { status: "online", text: "mailbox connecting…" });
    const both = combineStatus({ status: "offline", detail: "a" }, { status: "offline", detail: "b" });
    assert.equal(both.status, "offline");
    assert.equal(both.text, "relay offline · a · mailbox offline · b");
    assert.equal(combineStatus({ status: "offline" }, { status: "connecting" }).status, "connecting");
  });
});

describe("bootView", () => {
  it("covers every combination", () => {
    assert.deepEqual(bootView({ v1: false, v1Pending: false, v2: false, v2Seen: false }), { view: "pair-start", code: null });
    // v2 code no bot used yet: show it again.
    assert.deepEqual(bootView({ v1: false, v1Pending: false, v2: true, v2Seen: false }), { view: "pair-code", code: "v2" });
    assert.deepEqual(bootView({ v1: false, v1Pending: false, v2: true, v2Seen: true }), { view: "pets", code: null });
    // Existing v1 user (Jun's case): pets, whatever v2 is doing.
    assert.deepEqual(bootView({ v1: true, v1Pending: false, v2: false, v2Seen: false }), { view: "pets", code: null });
    assert.deepEqual(bootView({ v1: true, v1Pending: false, v2: true, v2Seen: false }), { view: "pets", code: null });
    assert.deepEqual(bootView({ v1: true, v1Pending: true, v2: false, v2Seen: false }), { view: "pair-code", code: "v1" });
    assert.deepEqual(bootView({ v1: true, v1Pending: true, v2: true, v2Seen: true }), { view: "pets", code: null });
  });
});

describe("v2 paste line and code shape", () => {
  const code = "dp2.AgABAgMEBQYHCAkKCwwNDg-AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en5N--3c";
  it("paste line", () => {
    assert.equal(pasteLineV2(code), `Install the Desk Pet skill and pair with code ${code}`);
    assert.ok(looksLikeDp2(code));
    assert.ok(!looksLikeDp2("K7Q-42M"));
    assert.ok(!looksLikeDp2(`${code} rm -rf`));
  });
});

describe("validateMailboxUrl", () => {
  it("accepts https, paths and loopback http", () => {
    assert.deepEqual(validateMailboxUrl(DEFAULT_MAILBOX), { ok: true, url: "https://ntfy.sh" });
    assert.deepEqual(validateMailboxUrl(" https://ntfy.example.com/sub/ "), { ok: true, url: "https://ntfy.example.com/sub" });
    assert.deepEqual(validateMailboxUrl("http://127.0.0.1:8080"), { ok: true, url: "http://127.0.0.1:8080" });
  });
  it("rejects the rest", () => {
    for (const bad of ["http://ntfy.example.com", "https://u:p@ntfy.sh", "https://ntfy.sh/?x=1", "https://ntfy.sh/#a", "ftp://x", "nope"]) {
      assert.equal(validateMailboxUrl(bad).ok, false, bad);
    }
  });
});
