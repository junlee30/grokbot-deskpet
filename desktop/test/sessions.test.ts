// Unit tests for which of an agent's sessions decide what its pet shows: `npm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONCURRENT_MS, displayFor, effectiveState, eventOrder, latestSession, type Session } from "../src/sessions.ts";
import { stickyLabel } from "../src/presence.ts";
import type { PetState } from "../src/events.ts";

const STALE = 10 * 60_000;
const T0 = Date.parse("2026-11-16T12:00:00.000Z");
let arrivals = 0;
/** A session last heard from at T0 + atMs (the bot's ts = the same instant unless given). */
const S = (state: PetState, atMs: number, o: Partial<Session> = {}): Session => ({ state, at: T0 + atMs, ts: T0 + atMs, seq: 1, n: ++arrivals, ...o });

describe("sessions: the newest event is authoritative", () => {
  it("needs_you in session A, then done in session B, shows done", () => {
    const a = S("needs_you", 0);
    const b = S("done", 30_000);
    assert.equal(effectiveState([a, b], T0 + 31_000, STALE), "done");
    assert.equal(effectiveState([b, a], T0 + 31_000, STALE), "done", "map order doesn't matter");
    // ...and after done has played (the pet shows idle), the old "!" never comes back.
    for (const t of [60_000, 5 * 60_000, 20 * 60_000]) assert.notEqual(effectiveState([a, b], T0 + t, STALE), "needs_you");
  });

  it("an older error never outranks a newer done or working", () => {
    assert.equal(effectiveState([S("error", 0), S("done", 1_000)], T0 + 2_000, STALE), "done");
    assert.equal(effectiveState([S("error", 0), S("working", 1_000)], T0 + 2_000, STALE), "working");
    assert.equal(effectiveState([S("needs_you", 0), S("idle", 1_000)], T0 + 2_000, STALE), "idle");
  });

  it("a needs_you that is the newest event shows (over juggling too)", () => {
    assert.equal(effectiveState([S("done", 0), S("needs_you", 1_000)], T0 + 2_000, STALE), "needs_you");
    assert.equal(effectiveState([S("working", 0), S("working", 500), S("needs_you", 1_000)], T0 + 2_000, STALE), "needs_you");
  });

  it("orders by the bot's ts, then seq, not by arrival", () => {
    // Arrives last but was sent first: it doesn't win.
    const late = S("needs_you", 2_000, { ts: T0 });
    const b = S("done", 1_000, { ts: T0 + 1_000 });
    assert.equal(latestSession([b, late]), b);
    assert.equal(effectiveState([b, late], T0 + 3_000, STALE), "done");
    // Same ts: the higher seq wins.
    const x = S("needs_you", 0, { seq: 1_700_000_000_000_002 });
    const y = S("done", 0, { seq: 1_700_000_000_000_001 });
    assert.equal(latestSession([x, y]), x);
    assert.equal(effectiveState([x, y], T0 + 1_000, STALE), "needs_you");
  });

  it("eventOrder uses the bot's ts and seq, falling back to when we got it", () => {
    assert.deepEqual(eventOrder("2026-11-16T12:00:00.000Z", 7, 5), { ts: T0, seq: 7 });
    assert.deepEqual(eventOrder("not a date", undefined, 5), { ts: 5, seq: 0 });
    assert.deepEqual(eventOrder(undefined, -1, 5), { ts: 5, seq: 0 });
  });

  it("no sessions: idle", () => {
    assert.equal(effectiveState([], T0, STALE), "idle");
  });
});

describe("sessions: concurrent sessions juggle", () => {
  it("working in A and in B at the same time shows juggling", () => {
    const a = S("working", 0, { message: "Running tests" });
    const b = S("working", 20_000, { message: "Reading the build log" });
    const d = displayFor([a, b], T0 + 30_000, STALE);
    assert.equal(d.state, "juggling");
    assert.deepEqual(new Set(d.sessions), new Set([a, b]));
    assert.equal(stickyLabel(d.state, d.sessions, T0 + 30_000, STALE), "Reading the build log", "newest working message");
  });

  it("a session not heard from for over 2 minutes is not concurrent", () => {
    const a = S("working", 0);
    const b = S("working", CONCURRENT_MS + 1_000);
    assert.equal(effectiveState([a, b], T0 + CONCURRENT_MS + 2_000, STALE), "working");
  });

  it("done or idle sessions don't count; a newer done with one other runner shows done", () => {
    assert.equal(effectiveState([S("working", 0), S("done", 1_000)], T0 + 2_000, STALE), "done");
    assert.equal(effectiveState([S("working", 0), S("idle", 1_000)], T0 + 2_000, STALE), "idle");
    // Two others still running: juggling even though the newest event is a done.
    assert.equal(effectiveState([S("working", 0), S("thinking", 500), S("done", 1_000)], T0 + 2_000, STALE), "juggling");
  });

  it("an older needs_you doesn't join the juggle", () => {
    assert.equal(effectiveState([S("needs_you", 0), S("working", 1_000)], T0 + 2_000, STALE), "working");
  });
});

describe("sessions: stale states fade to idle after 10 minutes", () => {
  it("needs_you fades after 10 min", () => {
    const s = [S("needs_you", 0)];
    assert.equal(effectiveState(s, T0 + 9 * 60_000, STALE), "needs_you");
    assert.equal(effectiveState(s, T0 + STALE, STALE), "needs_you", "exactly 10 min: still shown");
    assert.equal(effectiveState(s, T0 + STALE + 1, STALE), "idle");
  });

  it("error, working, thinking and juggling fade the same way; done and idle stay", () => {
    for (const st of ["error", "working", "thinking", "juggling"] as const) {
      assert.equal(effectiveState([S(st, 0)], T0 + 60_000, STALE), st);
      assert.equal(effectiveState([S(st, 0)], T0 + 11 * 60_000, STALE), "idle", st);
    }
    assert.equal(effectiveState([S("done", 0)], T0 + 11 * 60_000, STALE), "done", "done goes idle once played (pets.ts)");
    assert.equal(effectiveState([S("idle", 0)], T0 + 11 * 60_000, STALE), "idle");
  });
});
