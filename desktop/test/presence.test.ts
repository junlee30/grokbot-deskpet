// Unit tests for what the pet bubble shows (toast vs persistent working label): `npm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bubbleView, carryMessage, LABEL_MAX, sameView, stickyLabel, STICKY_STATES, truncateLabel, type SessionInfo } from "../src/presence.ts";
import { LABEL_OVERLAP_PX, layoutPets, layoutToast } from "../src/layout.ts";

describe("truncateLabel", () => {
  it("keeps short text, collapses whitespace", () => {
    assert.equal(truncateLabel("Reading the build log"), "Reading the build log");
    assert.equal(truncateLabel("  Reading\n the \t build   log "), "Reading the build log");
  });

  it("cuts long text at a word boundary with an ellipsis, never over the limit", () => {
    const long = "Running the integration test suite against the staging database and collecting coverage";
    const out = truncateLabel(long);
    assert.ok(Array.from(out).length <= LABEL_MAX, out);
    assert.ok(out.endsWith("…"));
    assert.ok(long.startsWith(out.slice(0, -1)), "a prefix of the original");
    assert.ok(!/\s…$/.test(out), "no space before the ellipsis");
    assert.equal(truncateLabel("Reading the build log for the failing job", 20), "Reading the build…");
  });

  it("hard-cuts text without spaces and never splits an emoji", () => {
    assert.equal(truncateLabel("x".repeat(100), 10), "xxxxxxxxx…");
    const e = truncateLabel("🔧".repeat(30), 10);
    assert.equal(Array.from(e).length, 10);
    assert.ok(Array.from(e).slice(0, 9).every((c) => c === "🔧"));
  });
});

describe("stickyLabel", () => {
  const now = 1_000_000;
  const S = (state: SessionInfo["state"], ago: number, message?: string): SessionInfo => ({ state, at: now - ago, message });

  it("only working and juggling keep a label", () => {
    assert.deepEqual([...STICKY_STATES].sort(), ["juggling", "working"]);
    const sessions = [S("working", 10, "Reading the build log")];
    assert.equal(stickyLabel("working", sessions, now, 60_000), "Reading the build log");
    for (const st of ["idle", "thinking", "needs_you", "error", "done", "sleeping", "offline"]) assert.equal(stickyLabel(st, sessions, now, 60_000), null, st);
  });

  it("uses the newest session in the shown state that said something", () => {
    const sessions = [S("working", 50, "Old step"), S("working", 5, "Newest step"), S("working", 1), S("thinking", 0, "Pondering"), S("juggling", 3, "Three helpers")];
    assert.equal(stickyLabel("working", sessions, now, 60_000), "Newest step");
    assert.equal(stickyLabel("juggling", sessions, now, 60_000), "Three helpers");
  });

  it("ignores stale sessions and blank messages; null when nobody said anything", () => {
    assert.equal(stickyLabel("working", [S("working", 120_000, "Ancient")], now, 60_000), null);
    assert.equal(stickyLabel("working", [S("working", 1, "   ")], now, 60_000), null);
    assert.equal(stickyLabel("working", [S("working", 1)], now, 60_000), null);
  });
});

describe("carryMessage", () => {
  it("a new message wins; a heartbeat in the same state keeps the old one; a new state drops it", () => {
    const prev: SessionInfo = { state: "working", at: 0, message: "Reading the build log" };
    assert.equal(carryMessage(prev, "working", "Fixing the test"), "Fixing the test");
    assert.equal(carryMessage(prev, "working", undefined), "Reading the build log");
    assert.equal(carryMessage(prev, "working", ""), "Reading the build log");
    assert.equal(carryMessage(prev, "thinking", undefined), undefined);
    assert.equal(carryMessage(undefined, "working", undefined), undefined);
  });
});

describe("bubbleView", () => {
  const now = 50_000;
  it("a live toast wins over the label; the label returns when it expires", () => {
    const toast = { text: "Found 3 failing tests", until: now + 1000 };
    assert.deepEqual(bubbleView(toast, "Reading the build log", now), { mode: "toast", text: "Found 3 failing tests", full: "Found 3 failing tests" });
    assert.deepEqual(bubbleView(toast, "Reading the build log", now + 1000), { mode: "sticky", text: "Reading the build log", full: "Reading the build log" });
  });

  it("a toast saying the same as the label is shown as the label", () => {
    assert.equal(bubbleView({ text: "Reading  the build log", until: now + 5000 }, "Reading the build log", now).mode, "sticky");
  });

  it("truncates the label but keeps the full text for the tooltip", () => {
    const long = "Reading the very long build log of the nightly integration pipeline run";
    const v = bubbleView(null, long, now);
    assert.equal(v.mode, "sticky");
    if (v.mode === "sticky") {
      assert.equal(v.full, long);
      assert.ok(v.text.endsWith("…") && Array.from(v.text).length <= LABEL_MAX);
    }
  });

  it("hidden with neither; sameView compares what's on screen", () => {
    assert.deepEqual(bubbleView(null, null, now), { mode: "hidden" });
    assert.deepEqual(bubbleView({ text: "x", until: now - 1 }, null, now), { mode: "hidden" });
    assert.ok(sameView({ mode: "hidden" }, { mode: "hidden" }));
    assert.ok(!sameView({ mode: "hidden" }, { mode: "sticky", text: "a", full: "a" }));
    assert.ok(!sameView({ mode: "toast", text: "a", full: "a" }, { mode: "sticky", text: "a", full: "a" }));
    assert.ok(sameView({ mode: "sticky", text: "a", full: "a" }, { mode: "sticky", text: "a", full: "a" }));
  });
});

describe("working label placement", () => {
  it("the (max 2-line) label sits above the sprite (the hop reaches the frame top) and inside the window", () => {
    for (let n = 1; n <= 8; n++)
      for (const s of layoutPets(n, 360, 200)) {
        const b = layoutToast(s, 400, 34, 360, 200, LABEL_OVERLAP_PX);
        assert.ok(b.top + b.height <= s.spriteTop, `n=${n}: label bottom ${b.top + b.height} > sprite top ${s.spriteTop}`);
        assert.ok(b.top >= 0 && b.left >= s.x0 && b.left + b.width <= s.x1);
      }
  });
});
