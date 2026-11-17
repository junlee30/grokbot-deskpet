// The v2 private-mailbox connection: status line, boot view, paste line, mailbox URL
// validation, and dropping what older versions saved for v1.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootView, looksLikeDp2, pasteLineV2, headerStatus, SKILL_URL, SKILL_VERSION } from "../src/connections.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "../src/net.ts";

describe("headerStatus", () => {
  it("not paired, whatever the connection says", () => {
    assert.deepEqual(headerStatus({ paired: false, conn: { status: "online" }, host: "ntfy.sh" }), { tone: "none", text: "Not paired" });
  });
  it("connecting (also before the first status), connected, offline", () => {
    assert.deepEqual(headerStatus({ paired: true, conn: null, host: "ntfy.sh" }), { tone: "connecting", text: "Connecting… · ntfy.sh" });
    assert.deepEqual(headerStatus({ paired: true, conn: { status: "connecting" }, host: "" }), { tone: "connecting", text: "Connecting…" });
    assert.deepEqual(headerStatus({ paired: true, conn: { status: "online" }, host: "ntfy.sh" }), { tone: "online", text: "Connected · ntfy.sh" });
    assert.deepEqual(headerStatus({ paired: true, conn: { status: "offline", detail: "mailbox unreachable" }, host: "ntfy.sh" }), {
      tone: "offline",
      text: "Offline · mailbox unreachable",
    });
    assert.deepEqual(headerStatus({ paired: true, conn: { status: "offline" }, host: "ntfy.sh" }), { tone: "offline", text: "Offline · retrying" });
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
    assert.equal(pasteLineV2(code), `Install the Desk Pet skill from ${SKILL_URL} and pair with code ${code}`);
    assert.ok(pasteLineV2(code).endsWith(code), "the code ends the line (a sentence dot after it is tolerated)");
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

describe("skill link", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  it("points at SKILL.md for the current publisher, on the tag the skill downloads from", () => {
    const protocol = JSON.parse(fs.readFileSync(path.join(root, "protocol", "v2.json"), "utf8"));
    assert.equal(SKILL_VERSION, protocol.publisher_version, "bump SKILL_VERSION with publisher_version");
    assert.equal(SKILL_URL, `https://raw.githubusercontent.com/junlee30/grokbot-deskpet/skill-v${SKILL_VERSION}/skill/SKILL.md`);
    const skill = fs.readFileSync(path.join(root, "skill", "SKILL.md"), "utf8");
    assert.ok(skill.includes(`DP_VERSION=${SKILL_VERSION}`), "SKILL.md installs the same version");
    assert.ok(skill.includes(SKILL_URL.replace(`skill-v${SKILL_VERSION}`, "skill-v$DP_VERSION").replace("SKILL.md", "deskpet-publish")), "same repo and tag");
  });
});
