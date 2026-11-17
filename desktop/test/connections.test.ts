// The v2 private-mailbox connection: status line, boot view, paste line, mailbox URL
// validation, and dropping what older versions saved for v1.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bootView, looksLikeDp2, migrateSettings, OLD_V1_KEYS, pasteLineV2, statusLine } from "../src/connections.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "../src/net.ts";

describe("statusLine", () => {
  it("quiet when not paired or online", () => {
    assert.deepEqual(statusLine(null), { status: "online", text: "" });
    assert.deepEqual(statusLine({ status: "online" }), { status: "online", text: "" });
  });
  it("names connecting and offline", () => {
    assert.deepEqual(statusLine({ status: "connecting" }), { status: "connecting", text: "connecting…" });
    assert.deepEqual(statusLine({ status: "offline", detail: "mailbox unreachable" }), {
      status: "offline",
      text: "offline · mailbox unreachable",
    });
    assert.deepEqual(statusLine({ status: "offline" }), { status: "offline", text: "offline · retrying" });
  });
});

describe("bootView", () => {
  it("covers every combination", () => {
    assert.equal(bootView({ paired: false, seen: false }), "pair-start");
    assert.equal(bootView({ paired: false, seen: true }), "pair-start");
    // A code no bot used yet: show it again.
    assert.equal(bootView({ paired: true, seen: false }), "pair-code");
    assert.equal(bootView({ paired: true, seen: true }), "pets");
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

describe("old v1 state", () => {
  it("drops relayUrl and pairMode from saved settings, keeps the rest", () => {
    const saved = {
      relayUrl: "https://relay.example.com",
      pairMode: "v1",
      mailboxUrl: "https://ntfy.sh",
      petSize: "small",
      petOrder: ["jarvis"],
    };
    assert.deepEqual(migrateSettings(saved), { mailboxUrl: "https://ntfy.sh", petSize: "small", petOrder: ["jarvis"] });
    assert.equal(saved.relayUrl, "https://relay.example.com", "input not mutated");
    assert.deepEqual(migrateSettings({ relayUrl: "" }), {});
    assert.deepEqual(migrateSettings({ pairMode: "v2", petSize: "large" }), { petSize: "large" });
  });
  it("nothing to do on v2-only settings", () => {
    assert.equal(migrateSettings({ mailboxUrl: "https://ntfy.sh" }), null);
    assert.equal(migrateSettings({}), null);
  });
  it("clears the old v1 pairing keys but never the v2 ones", () => {
    assert.deepEqual([...OLD_V1_KEYS].sort(), ["deskpet.paired", "deskpet.pending", "deskpet.token"]);
    assert.ok(!OLD_V1_KEYS.includes("deskpet.settings"));
    assert.ok(!OLD_V1_KEYS.includes("deskpet.v2.seen"));
  });
});
