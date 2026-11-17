// The frontend's protocol constants agree with protocol/v2.json (the publisher and the Rust
// side test against the same file).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AVATAR_COLORS, AVATAR_SHAPES } from "../src/avatar.ts";
import { isStateEvent, STATE_LIST } from "../src/events.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "protocol", "v2.json"), "utf8"));

describe("protocol/v2.json", () => {
  it("states, avatar shapes and colours match", () => {
    assert.deepEqual([...STATE_LIST], PROTOCOL.states);
    assert.deepEqual([...AVATAR_SHAPES], PROTOCOL.avatar_shapes);
    assert.deepEqual([...AVATAR_COLORS], PROTOCOL.avatar_colors);
  });
  it("every valid event passes the webview's shape check", () => {
    for (const e of PROTOCOL.valid) assert.ok(isStateEvent(e), JSON.stringify(e));
  });
});
