import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  accentHex,
  AVATAR_COLORS,
  AVATAR_DONE_MS,
  AVATAR_SHAPES,
  avatarCue,
  avatarGeometry,
  avatarStyle,
  BADGE,
  colorHex,
  FACE,
  FACE_FRAMES,
  FacePlayer,
  faceRound,
  FALLBACK_COLORS,
  IDLE_TIMING,
  luminance,
  parseAvatar,
  processStrip,
  type AvatarAnim,
  type FaceMode,
} from "../src/avatar.ts";
import { AvatarBank, drawAvatar } from "../src/avatar-bank.ts";
import { FakeCtx } from "./fake-canvas.ts";
import { decodePng } from "./png.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, "..", "public", "grokbot-art");

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic template strip: `frames` frames of a solid square with a 2x2 transparent "eye". */
function synthStrip(frames: number, fs = 12): { data: Uint8ClampedArray; width: number; height: number } {
  const width = fs * frames;
  const data = new Uint8ClampedArray(width * fs * 4);
  for (let f = 0; f < frames; f++)
    for (let y = 2; y < fs - 2; y++)
      for (let x = 2; x < fs - 2; x++) {
        const eye = x >= 5 && x <= 6 && y >= 5 && y <= 6;
        data[(y * width + f * fs + x) * 4 + 3] = eye ? 0 : 255;
      }
  return { data, width, height: fs };
}

describe("avatar names and colours", () => {
  it("parses valid avatars (case-insensitive) and rejects everything else", () => {
    assert.deepEqual(parseAvatar({ shape: "clover", color: "orange" }), { shape: "clover", color: "orange" });
    assert.deepEqual(parseAvatar({ shape: "Heart", color: "RED" }), { shape: "heart", color: "red" });
    for (const bad of [null, undefined, "blob", [], {}, { shape: "blob" }, { shape: "triangle", color: "red" }, { shape: "blob", color: "#000" }, { shape: 1, color: "red" }])
      assert.equal(parseAvatar(bad), null);
  });

  it("matches the relay allowlists (26 shapes, 11 colours)", () => {
    assert.equal(AVATAR_SHAPES.length, 26);
    assert.equal(AVATAR_COLORS.length, 11);
    assert.deepEqual(Object.keys(FALLBACK_COLORS).sort(), [...AVATAR_COLORS].sort());
  });

  it("uses the imported palette when present, our fallback otherwise", () => {
    assert.equal(colorHex("orange", { orange: "#ff6611" }), "#FF6611");
    assert.equal(colorHex("orange", null), FALLBACK_COLORS.orange);
    assert.equal(colorHex("orange", { orange: "not-a-colour" }), FALLBACK_COLORS.orange);
    assert.equal(colorHex("red", { orange: "#FF6611" }), FALLBACK_COLORS.red);
  });

  it("gives black avatars a light accent and outline so they show on dark desktops", () => {
    assert.equal(accentHex("black", { black: "#000000" }), "#F2F2F2");
    assert.equal(accentHex("red", { red: "#FF2244" }), "#FF2244");
    assert.ok(luminance("#000000") < 0.01 && luminance("#FFFFFF") > 0.99);
    assert.ok(avatarStyle("#000000").outline.r > 200, "light outline on black");
    assert.ok(avatarStyle("#FF9911").outline.r < 50, "dark outline on yellow");
  });
});

describe("processStrip", () => {
  it("tints the body, fills enclosed eyes, outlines the silhouette, pads every frame by 1px", () => {
    const s = synthStrip(3);
    const p = processStrip(s.data, s.width, s.height, "#FF6611");
    assert.equal(p.frames, 3);
    assert.equal(p.frameSize, 14);
    assert.equal(p.width, 42);
    assert.equal(p.height, 14);
    const at = (f: number, x: number, y: number) => {
      const i = (y * p.width + f * p.frameSize + x) * 4;
      return [...p.data.slice(i, i + 4)];
    };
    for (let f = 0; f < 3; f++) {
      assert.deepEqual(at(f, 4, 4), [255, 102, 17, 255], "body is the avatar colour");
      assert.deepEqual(at(f, 6, 6), [255, 255, 255, 255], "eye hole filled");
      assert.equal(at(f, 2, 6)[3] > 0, true, "outline just outside the shape");
      assert.equal(at(f, 0, 0)[3], 0, "far outside stays transparent");
    }
  });

  it("does not fill a notch that is open to the outside", () => {
    const fs = 12;
    const s = synthStrip(1, fs);
    // Cut a channel from the eye to the right edge.
    for (let x = 5; x < fs; x++) for (const y of [5, 6]) s.data[(y * s.width + x) * 4 + 3] = 0;
    const p = processStrip(s.data, s.width, s.height, "#1188FF");
    const i = (6 * p.width + 6) * 4; // padded coords of the old eye
    assert.notDeepEqual([...p.data.slice(i, i + 4)], [255, 255, 255, 255]);
  });
});

describe("face animation (Grok Bot tray cadence)", () => {
  it("frame table covers the 29 strip frames", () => {
    const all = new Set<number>([FACE.rest, ...FACE.blinkClose, ...FACE.blinkOpen]);
    for (const g of Object.values(FACE.glance)) [...g.in, g.hold, ...g.out].forEach((n) => all.add(n));
    assert.equal(all.size, FACE_FRAMES);
    assert.deepEqual([...all].sort((a, b) => a - b), [...Array(FACE_FRAMES).keys()]);
  });

  it("idle rounds are a rest then a blink (sometimes double) or a glance, with the app's timings", () => {
    const r = rng(1);
    let blinks = 0;
    let glances = 0;
    for (let i = 0; i < 400; i++) {
      const s = faceRound("idle", r);
      assert.equal(s[0].slot, FACE.rest);
      if (s[1].slot === FACE.blinkClose[0]) {
        blinks++;
        assert.ok(s[0].holdMs >= IDLE_TIMING.restBeforeBlink.min && s[0].holdMs <= IDLE_TIMING.restBeforeBlink.max);
        assert.equal(s.find((x) => x.slot === FACE.blinkClosed)!.holdMs, IDLE_TIMING.closedMs);
      } else {
        glances++;
        assert.ok(s[0].holdMs >= IDLE_TIMING.restBeforeGlance.min && s[0].holdMs <= IDLE_TIMING.restBeforeGlance.max);
      }
      assert.equal(s.at(-1)!.slot, FACE.rest, "every round settles at rest");
    }
    assert.ok(blinks > 120 && glances > 120, `both kinds happen (${blinks}/${glances})`);
  });

  it("every mode yields valid slots and positive holds", () => {
    const modes: FaceMode[] = ["idle", "thinking", "working", "juggling", "needs_you", "error", "done", "sleeping", "offline"];
    const r = rng(7);
    for (const m of modes)
      for (let i = 0; i < 50; i++)
        for (const st of faceRound(m, r)) {
          assert.ok(Number.isInteger(st.slot) && st.slot >= 0 && st.slot < FACE_FRAMES, `${m} slot ${st.slot}`);
          assert.ok(st.holdMs > 0);
        }
    assert.equal(faceRound("sleeping", r)[0].slot, FACE.blinkClosed);
    assert.equal(faceRound("thinking", r)[3].slot, FACE.glance.up.hold);
  });

  it("FacePlayer blinks within the app's 2.8-5.5 s rest window and survives long gaps", () => {
    const fp = new FacePlayer(() => 0.1); // < 0.5: always blink, never double
    let t = 0;
    assert.equal(fp.frameAt("idle", t), FACE.rest);
    let firstClosed = -1;
    for (t = 0; t < 8000; t += 5) {
      if (fp.frameAt("idle", t) === FACE.blinkClosed) {
        firstClosed = t;
        break;
      }
    }
    assert.ok(firstClosed >= 2800 && firstClosed <= 5600, `first blink at ${firstClosed}`);
    // Hours later (window hidden): one bounded catch-up, then normal.
    const slot = fp.frameAt("idle", t + 5 * 3_600_000);
    assert.ok(slot >= 0 && slot < FACE_FRAMES);
    // Mode switch takes effect immediately.
    assert.equal(fp.frameAt("sleeping", t + 5 * 3_600_000 + 1), FACE.blinkClosed);
  });
});

describe("avatar geometry (pixel-crisp integer scale)", () => {
  for (const size of [32, 64, 96, 128, 160]) {
    it(`sprite box ${size}px`, () => {
      const g = avatarGeometry(size);
      assert.ok(Number.isInteger(g.cssPx) && g.cssPx >= 1);
      assert.equal(g.backing * g.cssPx, size, "backing x integer scale fills the box exactly");
      assert.ok(g.ax >= 0 && g.ax + g.art <= g.backing);
      assert.ok(g.ay - 5 >= 0, "room to hop 5px");
      assert.ok(g.ay + g.art + 1 <= g.backing, "room to sink 1px");
    });
  }
  it("large uses @2x at 2 CSS px, small @2x at 1 CSS px, tiny @1x", () => {
    assert.deepEqual([avatarGeometry(96).res, avatarGeometry(96).cssPx, avatarGeometry(96).backing], ["2x", 2, 48]);
    assert.deepEqual([avatarGeometry(64).res, avatarGeometry(64).cssPx], ["2x", 1]);
    assert.equal(avatarGeometry(32).res, "1x");
  });
});

describe("state cues", () => {
  const states: AvatarAnim[] = ["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping", "offline"];
  for (const size of [32, 64, 96]) {
    it(`all motion and overlays stay on-grid and inside the canvas (${size}px)`, () => {
      const g = avatarGeometry(size);
      for (const st of states)
        for (let t = 0; t < 6000; t += 37) {
          const c = avatarCue(st, t, g);
          assert.ok(Number.isInteger(c.dx) && Number.isInteger(c.dy), `${st}@${t}`);
          assert.ok(g.ax + c.dx >= 0 && g.ax + g.art + c.dx <= g.backing, `${st} x in canvas`);
          assert.ok(g.ay + c.dy >= 0 && g.ay + g.art + c.dy <= g.backing, `${st} y in canvas`);
          for (const o of c.overlays) {
            assert.ok(Number.isInteger(o.x) && Number.isInteger(o.y), `${st} overlay ${o.kind} on grid`);
            const w = o.kind === "badge" ? BADGE : o.kind === "dots" ? o.n * 4 : o.kind === "z" ? o.size : o.kind === "ball" ? 4 : o.r + 1;
            const x0 = o.kind === "spark" ? o.x - o.r : o.x - (o.kind === "ball" ? 1 : 0);
            assert.ok(x0 >= 0 && x0 + w <= g.backing, `${st} ${o.kind} x=${o.x} inside ${g.backing}`);
            assert.ok(o.y >= 0 && o.y < g.backing, `${st} ${o.kind} y=${o.y}`);
          }
        }
    });
  }

  it("each state reads differently", () => {
    const g = avatarGeometry(96);
    const kinds = (st: AvatarAnim, t = 100) => avatarCue(st, t, g).overlays.map((o) => (o.kind === "badge" ? `badge:${o.icon}` : o.kind));
    assert.deepEqual(kinds("idle"), []);
    assert.deepEqual(kinds("thinking"), ["dots"]);
    assert.deepEqual(kinds("working"), ["badge:spinner"]);
    assert.deepEqual(kinds("juggling"), ["ball", "ball", "ball"]);
    assert.deepEqual(kinds("needs_you"), ["badge:bang"]);
    assert.deepEqual(kinds("error"), ["badge:cross"]);
    assert.ok(kinds("done").includes("badge:check") && kinds("done").includes("spark"));
    assert.ok(kinds("sleeping", 1000).includes("z"));
    assert.equal(avatarCue("thinking", 0, g).face, "thinking");
    assert.equal(avatarCue("sleeping", 0, g).face, "sleeping");
    // error shakes, needs_you bounces, done hops once then settles.
    assert.ok(new Set(Array.from({ length: 6 }, (_, i) => avatarCue("error", i * 80, g).dx)).size > 1);
    assert.ok(Math.min(...Array.from({ length: 8 }, (_, i) => avatarCue("needs_you", i * 80, g).dy)) <= -3);
    assert.equal(avatarCue("done", AVATAR_DONE_MS - 1, g).dy, 0);
  });
});

describe("drawAvatar", () => {
  it("draws the tinted frame at the cue offset with integer coordinates only", () => {
    const g = avatarGeometry(96);
    const s = synthStrip(29, 36);
    const p = processStrip(s.data, s.width, s.height, "#FF2244");
    const strip = { canvas: { width: p.width, height: p.height, data: p.data }, frameSize: p.frameSize, frames: p.frames };
    for (const st of ["idle", "working", "juggling", "needs_you", "done", "error", "sleeping"] as AvatarAnim[]) {
      const ctx = new FakeCtx(g.backing, g.backing);
      const cue = avatarCue(st, 200, g);
      drawAvatar(ctx as unknown as CanvasRenderingContext2D, strip as never, g, 3, cue);
      assert.equal(ctx.imageSmoothingEnabled, false);
      for (const c of ctx.calls) for (const a of c.args) assert.ok(Number.isInteger(a), `${st}: ${c.op}(${c.args}) not integer`);
      const img = ctx.calls.find((c) => c.op === "drawImage")!.args;
      assert.deepEqual(img.slice(0, 4), [3 * p.frameSize, 0, p.frameSize, p.frameSize], "frame 3 of the strip");
      assert.equal(img[6], img[2], "1:1 copy, scaling is done by CSS at an integer factor");
      // Body pixel in the avatar colour, at the moved position.
      const [r, gg, b, a] = ctx.rgbaAt(img[4] + 6, img[5] + 30);
      assert.deepEqual([r, gg, b, a], [255, 34, 68, 255], st);
    }
  });

  it("clamps an out-of-range face slot", () => {
    const g = avatarGeometry(96);
    const s = synthStrip(2, 36);
    const p = processStrip(s.data, s.width, s.height, "#000000");
    const ctx = new FakeCtx(g.backing, g.backing);
    drawAvatar(ctx as unknown as CanvasRenderingContext2D, { canvas: { width: p.width, height: p.height, data: p.data }, frameSize: p.frameSize, frames: 2 } as never, g, 25, avatarCue("idle", 0, g));
    assert.equal(ctx.calls.find((c) => c.op === "drawImage")!.args[0], p.frameSize);
  });
});

describe("fallback when the Grok Bot art is absent", () => {
  it("AvatarBank without a manifest reports nothing and never throws", async () => {
    const bank = new AvatarBank();
    await bank.load("http://127.0.0.1:9/nope/"); // nothing listens on port 9
    assert.equal(bank.manifest, null);
    assert.equal(bank.palette, null);
    assert.equal(bank.has("blob"), false);
    assert.equal(bank.strip("blob", "2x", "#000000"), null, "null = draw the robot");
  });

  it("AvatarBank refuses manifest entries that aren't face strips", () => {
    const bank = new AvatarBank();
    bank.manifest = { version: 1, appVersion: null, palette: null, shapes: { blob: { "2x": { file: "../../etc/passwd", frameSize: 36, frames: 29 } } } };
    assert.equal(bank.has("blob"), true);
    assert.equal(bank.strip("blob", "2x", "#000000"), null);
  });
});

// Runs only where scripts/import-grokbot-art.mjs has copied the app's art (never in git).
describe("imported Grok Bot art (local only)", { skip: !existsSync(join(ART, "manifest.json")) && "art not imported" }, () => {
  it("every shape has 29-frame strips whose eyes are found and filled", () => {
    const m = JSON.parse(readFileSync(join(ART, "manifest.json"), "utf8"));
    assert.equal(Object.keys(m.shapes).length, 26);
    let eyes1x = 0;
    for (const shape of AVATAR_SHAPES) {
      for (const res of ["2x", "1x"] as const) {
        const info = m.shapes[shape][res];
        assert.equal(info.frames, 29, `${shape} ${res}`);
        const png = decodePng(readFileSync(join(ART, info.file)));
        const p = processStrip(png.data, png.width, png.height, "#FF6611");
        // Rest frame: some pixels became pure eye-white.
        let white = 0;
        for (let y = 0; y < p.frameSize; y++)
          for (let x = 0; x < p.frameSize; x++) {
            const i = (y * p.width + x) * 4;
            if (p.data[i] === 255 && p.data[i + 1] === 255 && p.data[i + 2] === 255 && p.data[i + 3] === 255) white++;
          }
        // @1x eyes are tiny and some are open to the edge (left see-through, as in the app).
        if (res === "2x") assert.ok(white >= 6, `${shape} ${res}: eyes filled (${white}px)`);
        else eyes1x += white > 0 ? 1 : 0;
      }
    }
    assert.ok(eyes1x >= 13, `@1x eyes found for ${eyes1x}/26 shapes`);
  });

  it("palette came from the app's avatar colour list and covers every colour", () => {
    const m = JSON.parse(readFileSync(join(ART, "manifest.json"), "utf8"));
    assert.equal(m.palette.source, "avatar-color-list");
    for (const c of AVATAR_COLORS) assert.match(m.palette.colors[c], /^#[0-9A-F]{6}$/);
  });
});
