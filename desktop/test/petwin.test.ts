// One window per bot: the pure helpers the webviews share (src/petwin.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StateEvent } from "../src/events.ts";
import { agentOfLabel, EventFeed, grokbotId, grokbotUrl, mainWindowVisible, petLabel, samePixels } from "../src/petwin.ts";

function ev(over: Partial<StateEvent> = {}): StateEvent {
  return {
    agent_id: "jarvis",
    agent_name: "Jarvis",
    session: "s-1",
    state: "working",
    event: "tool_start",
    ts: "2026-11-16T12:00:00Z",
    seq: 1,
    received_at: "2026-11-16T12:00:00Z",
    ...over,
  };
}

describe("pet window labels", () => {
  it("match the Rust side: pet-<agent_id>, and only valid ids", () => {
    assert.equal(petLabel("jarvis"), "pet-jarvis");
    assert.equal(agentOfLabel("pet-jarvis"), "jarvis");
    assert.equal(agentOfLabel(petLabel("a_b-9")!), "a_b-9");
    assert.equal(agentOfLabel("main"), null);
    assert.equal(agentOfLabel("pet-"), null);
    assert.equal(agentOfLabel("pet-Jarvis"), null);
    assert.equal(petLabel("a/b"), null);
    assert.equal(petLabel("x".repeat(65)), null);
  });
});

describe("EventFeed (a starting pet window gets its first events live and in the backlog)", () => {
  it("applies each event once", () => {
    const f = new EventFeed("jarvis");
    assert.equal(f.accept(ev()), true);
    assert.equal(f.accept(ev()), false, "the same event from the backlog");
    assert.equal(f.accept(ev({ seq: 2 })), true);
    assert.equal(f.accept(ev({ session: "s-2" })), true);
    assert.equal(f.accept(ev({ state: "done", event: "turn_end" })), true);
  });

  it("ignores other bots' events", () => {
    const f = new EventFeed("jarvis");
    assert.equal(f.accept(ev({ agent_id: "claude" })), false);
    assert.equal(f.accept(ev()), true);
  });

  it("events without seq still dedupe by session, ts, state and event", () => {
    const f = new EventFeed("jarvis");
    const e = ev({ seq: undefined });
    assert.equal(f.accept(e), true);
    assert.equal(f.accept({ ...e }), false);
    assert.equal(f.accept(ev({ seq: undefined, ts: "2026-11-16T12:00:01Z" })), true);
  });

  it("remembers a bounded number of events", () => {
    const f = new EventFeed("jarvis", 3);
    for (let i = 1; i <= 4; i++) assert.equal(f.accept(ev({ seq: i })), true);
    assert.equal(f.accept(ev({ seq: 1 })), true, "the oldest was forgotten");
    assert.equal(f.accept(ev({ seq: 4 })), false);
  });
});

describe("main window visibility (pets live in their own windows)", () => {
  it("hides once bots have their own windows and nothing else is open", () => {
    assert.equal(mainWindowVisible({ view: "pets", settingsOpen: false, pets: 2 }), false);
  });
  it("shows to wait for the first bot, to pair, and for settings", () => {
    assert.equal(mainWindowVisible({ view: "pets", settingsOpen: false, pets: 0 }), true, "waiting hint");
    assert.equal(mainWindowVisible({ view: "pair-start", settingsOpen: false, pets: 0 }), true);
    assert.equal(mainWindowVisible({ view: "pair-code", settingsOpen: false, pets: 3 }), true, "showing the code again");
    assert.equal(mainWindowVisible({ view: "pets", settingsOpen: true, pets: 3 }), true, "settings via ⚙ / menu");
  });
});

describe("samePixels (a resting pet leaves its window untouched)", () => {
  it("compares whole frames", () => {
    const a = new Uint32Array([0, 0xff00ff00, 7]);
    assert.equal(samePixels(a, new Uint32Array([0, 0xff00ff00, 7])), true);
    assert.equal(samePixels(a, new Uint32Array([0, 0xff00ff00, 8])), false);
    assert.equal(samePixels(a, new Uint32Array([0, 0xff00ff00])), false, "a different canvas size");
    assert.equal(samePixels(new Uint32Array(0), new Uint32Array(0)), true);
  });
});

describe("click opens Grok Bot on the bot's chat", () => {
  const ID = "2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
  const BAD: unknown[] = [
    "",
    "jarvis",
    ID.toUpperCase(),
    ID.replace(/-/g, ""),
    `{${ID}}`,
    ` ${ID}`,
    `${ID}\n`,
    `${ID}0`,
    ID.slice(1),
    ID.replace("2f06", "2g06"),
    `${ID}&x=1`,
    `${ID}#x`,
    "2f06d68c-1b2a-4c3d-8e9f_0a1b2c3d4e5f",
    "../../../../-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
    undefined,
    null,
    42,
    { id: ID },
    [ID],
  ];

  it("grokbotId: exactly a lowercase UUID (same rule as Rust v2::grokbot_id_ok)", () => {
    assert.equal(grokbotId(ID), ID);
    assert.equal(grokbotId("00000000-0000-0000-0000-000000000000"), "00000000-0000-0000-0000-000000000000");
    for (const b of BAD) assert.equal(grokbotId(b), null, JSON.stringify(b));
  });

  it("grokbotUrl: the bot's chat for a valid id, otherwise just Grok Bot", () => {
    // Same strings as Rust grokbot::chat_url (tested against capabilities/pets.json there).
    assert.equal(grokbotUrl(ID), `grokbot://app/v1/agent?id=${ID}`);
    assert.equal(grokbotUrl(null), "grokbot://");
    for (const b of BAD) assert.equal(grokbotUrl(b), "grokbot://", JSON.stringify(b));
  });

  it("only ever builds one of the two allowed URL shapes", () => {
    const allowed = /^grokbot:\/\/(app\/v1\/agent\?id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;
    for (const v of [ID, ...BAD]) assert.match(grokbotUrl(v), allowed);
    assert.equal(new URL(grokbotUrl(ID)).searchParams.get("id"), ID);
  });
});
