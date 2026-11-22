// needs_you tracking, setup notes and the render loop's schedule: `npm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Attention, petNotice, receivedAt } from "../src/presence.ts";
import { FRAME_MS, frameDelay, MAX_SLEEP_MS, nextChangeAt } from "../src/petwin.ts";
import { FacePlayer } from "../src/avatar.ts";

describe("Attention", () => {
  it("a fresh needs_you notifies once and counts until the pet moves on", () => {
    const a = new Attention();
    assert.equal(a.step("working"), null);
    a.arm("Need your OK");
    assert.deepEqual(a.step("needs_you"), { needs: true, notify: true, message: "Need your OK" });
    assert.equal(a.step("needs_you"), null, "nothing new while still waiting");
    assert.deepEqual(a.step("working"), { needs: false, notify: false });
    assert.equal(a.step("working"), null);
  });
  it("catch-up needs_you counts but doesn't notify", () => {
    const a = new Attention();
    assert.deepEqual(a.step("needs_you"), { needs: true, notify: false });
  });
  it("a second fresh question while waiting notifies again; no message is fine", () => {
    const a = new Attention();
    a.arm();
    assert.deepEqual(a.step("needs_you"), { needs: true, notify: true });
    a.arm("Another question");
    assert.deepEqual(a.step("needs_you"), { needs: true, notify: true, message: "Another question" });
  });
  it("an armed needs_you that never shows (a higher state wins) is forgotten", () => {
    const a = new Attention();
    a.arm("hidden");
    assert.equal(a.step("error"), null);
    assert.deepEqual(a.step("needs_you"), { needs: true, notify: false });
  });
});

describe("petNotice", () => {
  it("dropped posts first, then the out-of-date note once", () => {
    assert.deepEqual(petNotice({ dropped: 1 }, false), { kind: "dropped", text: "Missed 1 update (mailbox limit reached)" });
    assert.equal(petNotice({ dropped: 12, pv_outdated: true }, false)?.text, "Missed 12 updates (mailbox limit reached)");
    assert.equal(petNotice({ pv_outdated: true }, false)?.kind, "outdated");
    assert.equal(petNotice({ pv_outdated: true }, true), null, "only once");
    assert.equal(petNotice({ pv_outdated: false }, false), null);
    for (const d of [0, -3, 1.5, NaN]) assert.equal(petNotice({ dropped: d }, true), null, String(d));
  });
});

describe("receivedAt", () => {
  it("fresh within 10 s, never in the future", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    assert.deepEqual(receivedAt({ received_at: "2026-11-17T11:59:55Z" }, now), { at: now - 5000, fresh: true });
    assert.equal(receivedAt({ received_at: "2026-11-17T11:59:00Z" }, now).fresh, false);
    assert.deepEqual(receivedAt({ received_at: "2026-11-17T12:05:00Z" }, now), { at: now, fresh: true });
    assert.deepEqual(receivedAt({ received_at: "junk" }, now), { at: now, fresh: true });
  });
});

describe("render loop schedule", () => {
  const now = 1_000_000;
  it("robot sprites step at their fps", () => {
    assert.equal(nextChangeAt({ art: "robot", state: "idle", now, animStart: now - 100, robotFps: 4 }), now + 150);
    assert.equal(nextChangeAt({ art: "robot", state: "working", now, animStart: now, robotFps: 10 }), now + 100);
  });
  it("resting avatars wait for the face or the next breath / z step", () => {
    assert.equal(nextChangeAt({ art: "avatar", state: "idle", now, animStart: now - 1000, faceUntil: now + 3000 }), now + 200);
    assert.equal(nextChangeAt({ art: "avatar", state: "idle", now, animStart: now - 1300, faceUntil: now + 40 }), now + 40, "a blink is due");
    assert.equal(nextChangeAt({ art: "avatar", state: "sleeping", now, animStart: now - 1550, faceUntil: now + 60_000 }), now + 50);
    assert.equal(nextChangeAt({ art: "avatar", state: "offline", now, animStart: now, faceUntil: now + 60_000 }), now + 60_000);
  });
  it("busy avatars draw every tick; a toast's end wakes the loop", () => {
    assert.equal(nextChangeAt({ art: "avatar", state: "working", now, animStart: now, faceUntil: now + 5000 }), now);
    assert.equal(nextChangeAt({ art: "avatar", state: "offline", now, animStart: now, faceUntil: now + 60_000, toastUntil: now + 700 }), now + 700);
  });
  it("a pet held still (Settings → Motion off) waits for its toast and nothing else", () => {
    assert.equal(nextChangeAt({ art: "avatar", state: "sleeping", now, animStart: now - 1550, faceUntil: now + 40, still: true }), Infinity);
    assert.equal(nextChangeAt({ art: "robot", state: "idle", now, animStart: now, robotFps: 4, still: true, toastUntil: now + 700 }), now + 700);
    assert.equal(frameDelay(Infinity, now), MAX_SLEEP_MS);
  });
  it("frameDelay stays between one tick and a second", () => {
    assert.equal(frameDelay(now, now), FRAME_MS);
    assert.equal(frameDelay(now + 200, now), 200);
    assert.equal(frameDelay(now + 60_000, now), MAX_SLEEP_MS);
  });
  it("FacePlayer reports its next change", () => {
    const f = new FacePlayer(() => 0);
    f.frameAt("sleeping", now);
    assert.equal(f.nextChangeAt, now + 60_000);
  });
});
