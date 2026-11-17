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
  axisMap,
  CLOUD,
  colorHex,
  FACE,
  FACE_FRAMES,
  FacePlayer,
  faceRound,
  FALLBACK_COLORS,
  IDLE_TIMING,
  luminance,
  parseAvatar,
  overlayBox,
  processStrip,
  RING_HEAD,
  RING_TURN_MS,
  WORK_CYCLE_MS,
  warpPlan,
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

  it("matches the event allowlists (26 shapes, 11 colours)", () => {
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

describe("squash/stretch/lean warp (pixel-crisp)", () => {
  it("axisMap grows or shrinks an axis by whole source lines, in order, keeping both ends", () => {
    for (const n of [20, 38])
      for (const d of [-3, -2, -1, 0, 1, 2, 3]) {
        const m = axisMap(n, d);
        assert.equal(m.length, n + d, `n=${n} d=${d}`);
        assert.equal(m[0], 0);
        assert.equal(m[m.length - 1], n - 1);
        for (let i = 1; i < m.length; i++) assert.ok(m[i] - m[i - 1] >= 0 && m[i] - m[i - 1] <= 2);
      }
    assert.deepEqual(axisMap(5, 0), [0, 1, 2, 3, 4]);
  });

  it("no warp is a single 1:1 copy of the whole frame", () => {
    assert.deepEqual(warpPlan(38, 0, 0, 0), { width: 38, height: 38, left: 0, blocks: [{ sx: 0, sy: 0, w: 38, h: 38, dx: 0, dy: 0 }] });
  });

  it("every warped pixel is covered exactly once by an integer 1:1 block from the right source pixel", () => {
    for (const n of [20, 38])
      for (const [sx, sy, lean] of [[2, -3, 0], [-2, 3, 0], [1, -2, 0], [0, 0, 2], [0, 0, -2], [2, -3, 1], [-1, 2, -2]]) {
        const p = warpPlan(n, sx, sy, lean);
        assert.equal(p.width, n + sx);
        assert.equal(p.height, n + sy);
        assert.ok(p.blocks.length <= 24, `few draw calls (${p.blocks.length})`);
        const rows = axisMap(n, sy);
        const cols = axisMap(n, sx);
        const seen = new Map<string, number>();
        for (const b of p.blocks) {
          for (const v of [b.sx, b.sy, b.w, b.h, b.dx, b.dy]) assert.ok(Number.isInteger(v));
          assert.ok(b.sx >= 0 && b.sy >= 0 && b.sx + b.w <= n && b.sy + b.h <= n, "source inside the frame");
          for (let j = 0; j < b.h; j++)
            for (let i = 0; i < b.w; i++) {
              const key = `${b.dx + i},${b.dy + j}`;
              assert.ok(!seen.has(key), `pixel ${key} drawn twice`);
              seen.set(key, 1);
              assert.equal(rows[b.dy + j], b.sy + j, "row source");
            }
        }
        assert.equal(seen.size, p.width * p.height);
        // Without lean, the column mapping is exact too.
        if (lean === 0) for (const b of p.blocks) for (let i = 0; i < b.w; i++) assert.equal(cols[b.dx + i], b.sx + i);
        // Lean shears the top, never the bottom row.
        const bottom = p.blocks.filter((b) => b.dy + b.h === p.height);
        assert.equal(Math.min(...bottom.map((b) => b.dx)), 0);
        if (lean) assert.equal(Math.min(...p.blocks.filter((b) => b.dy === 0).map((b) => b.dx)), lean, "top row shifted by lean");
      }
  });
});

describe("state cues", () => {
  const states: AvatarAnim[] = ["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping", "offline"];
  for (const size of [32, 64, 96]) {
    it(`body, warp and overlays stay on-grid and inside the canvas (${size}px)`, () => {
      const g = avatarGeometry(size);
      for (const st of states)
        for (let t = 0; t < 6000; t += 17) {
          const c = avatarCue(st, t, g);
          for (const v of [c.dx, c.dy, c.sx, c.sy, c.lean]) assert.ok(Number.isInteger(v), `${st}@${t} integer motion`);
          const p = warpPlan(g.art, c.sx, c.sy, c.lean);
          const x = g.ax + c.dx + p.left;
          const y = g.ay + g.art + c.dy - p.height;
          for (const b of p.blocks) {
            assert.ok(x + b.dx >= 0 && x + b.dx + b.w <= g.backing, `${st}@${t} body x in canvas`);
            assert.ok(y + b.dy >= 0 && y + b.dy + b.h <= g.backing, `${st}@${t} body y in canvas (${y + b.dy})`);
          }
          for (const o of c.overlays) {
            const box = overlayBox(o);
            assert.ok(Number.isInteger(o.x) && Number.isInteger(o.y), `${st} ${o.kind} on grid`);
            assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= g.backing && box.y + box.h <= g.backing, `${st}@${t} ${o.kind} ${JSON.stringify(box)} inside ${g.backing}`);
          }
        }
    });
  }

  const g = avatarGeometry(96);
  const over = (st: AvatarAnim, from: number, to: number, every = 10) => Array.from({ length: Math.ceil((to - from) / every) }, (_, i) => avatarCue(st, from + i * every, g));

  it("working: a big squash-and-stretch hop with a ring spinning round the waist", () => {
    const cycle = over("working", 0, WORK_CYCLE_MS);
    assert.ok(Math.min(...cycle.map((c) => c.dy)) <= -5, "hops at least 5 art px (10 CSS px at large)");
    assert.ok(Math.min(...cycle.map((c) => c.sy)) <= -2, "squashes");
    assert.ok(Math.max(...cycle.map((c) => c.sy)) >= 2, "stretches");
    for (const c of cycle) {
      assert.equal(c.face, "working");
      assert.ok(!c.overlays.some((o) => o.kind === "badge"), "no tiny badge any more");
      const dots = c.overlays.filter((o) => o.kind === "dot");
      assert.ok(dots.length >= 30, "a whole ring");
      assert.ok(dots.some((o) => o.behind) && dots.some((o) => !o.behind), "orbits behind and in front of the body");
      const lit = dots.filter((o) => o.ink);
      assert.ok(lit.length >= 10 && lit.every((o) => o.w === 2), "a thick outlined comet");
      const xs = dots.map((o) => o.x);
      assert.ok(Math.max(...xs) - Math.min(...xs) >= g.art, "ring is wider than the body");
    }
    // The comet goes round: its centre moves through all four quadrants over one turn.
    const centre = (t: number) => {
      const lit = avatarCue("working", t, g).overlays.filter((o) => o.kind === "dot" && o.ink);
      const head = lit.find((o) => o.kind === "dot" && o.color === RING_HEAD)!;
      return [head.x - (g.ax + g.art / 2), head.y];
    };
    const xs = Array.from({ length: 8 }, (_, i) => Math.sign(centre((i * RING_TURN_MS) / 8)[0]));
    assert.ok(xs.includes(1) && xs.includes(-1), `comet head swings left and right: ${xs}`);
  });

  it("thinking: still, leaning, eyes up, a thought cloud whose dots fill in (nothing like working)", () => {
    const cs = over("thinking", 0, 4000, 50);
    for (const c of cs) {
      assert.equal(c.face, "thinking");
      assert.ok(c.dy >= -1 && c.dy <= 0 && c.sy === 0 && c.sx === 0, "no hop, no squash");
      assert.ok(c.lean >= 1, "leans back");
      const kinds = c.overlays.map((o) => o.kind);
      assert.deepEqual(kinds, ["puff", "puff", "cloud"]);
    }
    const lits = new Set(cs.map((c) => (c.overlays.find((o) => o.kind === "cloud") as { lit: number }).lit));
    assert.deepEqual([...lits].sort(), [0, 1, 2, 3]);
    const cloud = cs[0].overlays.find((o) => o.kind === "cloud")!;
    assert.ok(cloud.y + CLOUD.big.h <= g.ay + 2, "cloud floats above the head");
  });

  it("every state has its own look at a glance", () => {
    const sig = (st: AvatarAnim) => {
      const cs = over(st, 0, 1700, 20);
      const kinds = new Set(cs.flatMap((c) => c.overlays.map((o) => (o.kind === "badge" ? `badge:${o.icon}` : o.kind))));
      const hop = Math.min(...cs.map((c) => c.dy)) <= -3;
      const squash = cs.some((c) => c.sy !== 0);
      const shake = new Set(cs.map((c) => c.dx)).size > 1;
      const lean = cs.some((c) => c.lean !== 0);
      return `${[...kinds].sort().join(",")}|hop=${hop}|squash=${squash}|shake=${shake}|lean=${lean}`;
    };
    const all = (["idle", "thinking", "working", "juggling", "needs_you", "error", "done", "sleeping"] as AvatarAnim[]).map((s) => [s, sig(s)]);
    const uniq = new Set(all.map(([, v]) => v));
    assert.equal(uniq.size, all.length, JSON.stringify(all, null, 1));
    // Each overlay family belongs to one state.
    const owner = (k: string) => all.filter(([, v]) => v.split("|")[0].split(",").includes(k)).map(([s]) => s);
    assert.deepEqual(owner("cloud"), ["thinking"]);
    assert.deepEqual(owner("ball"), ["juggling"]);
    assert.deepEqual(owner("badge:bang"), ["needs_you"]);
    assert.deepEqual(owner("badge:cross"), ["error"]);
    assert.deepEqual(owner("badge:check"), ["done"]);
    assert.deepEqual(owner("z"), ["sleeping"]);
    assert.deepEqual(owner("dot").sort(), ["done", "working"]);
    assert.deepEqual(avatarCue("idle", 100, g).overlays, []);
  });

  it("juggling throws balls high over the head; needs_you hops and wiggles; error slumps and shudders", () => {
    const jug = over("juggling", 0, 1500, 25);
    assert.ok(jug.every((c) => c.overlays.filter((o) => o.kind === "ball").length === 3));
    assert.ok(jug.some((c) => c.overlays.some((o) => o.kind === "ball" && o.y < g.ay)), "balls go above the head");
    const ny = over("needs_you", 0, 1600, 20);
    assert.ok(Math.min(...ny.map((c) => c.dy)) <= -3);
    assert.ok(ny.some((c) => c.lean < 0) && ny.some((c) => c.lean > 0), "wiggles");
    assert.ok(ny.every((c) => c.overlays.some((o) => o.kind === "badge" && o.icon === "bang")), "the ! never disappears");
    assert.ok(ny.some((c) => c.overlays.some((o) => o.kind === "badge" && o.rays)), "and it pulses");
    const er = over("error", 0, 1800, 20);
    assert.ok(er.every((c) => c.sy < 0 && c.dy === 0), "deflated");
    assert.ok(new Set(er.map((c) => c.dx)).size > 1, "shudders");
  });

  it("done: crouch, leap with confetti, then settles calm before handing back to idle", () => {
    const early = over("done", 0, 900, 10);
    assert.ok(Math.min(...early.map((c) => c.dy)) <= -6, "a big leap");
    assert.ok(early.some((c) => c.sy < 0) && early.some((c) => c.sy > 0), "squash and stretch");
    assert.ok(early.some((c) => c.overlays.filter((o) => o.kind === "dot").length >= 10), "confetti burst");
    assert.ok(early.slice(15).every((c) => c.overlays.some((o) => o.kind === "badge" && o.icon === "check")));
    for (const c of over("done", 1500, AVATAR_DONE_MS, 10)) {
      assert.deepEqual([c.dx, c.dy, c.sx, c.sy, c.lean], [0, 0, 0, 0, 0], "at rest, so idle follows seamlessly");
      assert.ok(!c.overlays.some((o) => o.kind === "dot"), "confetti gone");
    }
    assert.ok(AVATAR_DONE_MS >= 1500 && AVATAR_DONE_MS <= 2500, "brief");
  });
});

describe("drawAvatar", () => {
  const g = avatarGeometry(96);
  const mk = (hex: string, frames = 29) => {
    const s = synthStrip(frames, 36);
    const p = processStrip(s.data, s.width, s.height, hex);
    return { p, strip: { canvas: { width: p.width, height: p.height, data: p.data }, frameSize: p.frameSize, frames: p.frames } };
  };
  const bbox = (ctx: FakeCtx, rgb: [number, number, number]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < ctx.height; y++)
      for (let x = 0; x < ctx.width; x++) {
        const [r, gg, b, a] = ctx.rgbaAt(x, y);
        if (a === 255 && r === rgb[0] && gg === rgb[1] && b === rgb[2]) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
    return { w: x1 - x0 + 1, h: y1 - y0 + 1, bottom: y1, cx: (x0 + x1) / 2 };
  };

  it("draws the tinted frame with integer 1:1 copies only, from the right strip frame", () => {
    const { p, strip } = mk("#FF2244");
    for (const st of ["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping"] as AvatarAnim[])
      for (const t of [0, 200, 330, 700]) {
        const ctx = new FakeCtx(g.backing, g.backing);
        const cue = avatarCue(st, t, g);
        drawAvatar(ctx as unknown as CanvasRenderingContext2D, strip as never, g, 3, cue);
        assert.equal(ctx.imageSmoothingEnabled, false);
        for (const c of ctx.calls) for (const a of c.args) assert.ok(Number.isInteger(a), `${st}: ${c.op}(${c.args}) not integer`);
        const imgs = ctx.calls.filter((c) => c.op === "drawImage");
        assert.ok(imgs.length >= 1);
        for (const { args } of imgs) {
          assert.ok(args[0] >= 3 * p.frameSize && args[0] + args[2] <= 4 * p.frameSize, "frame 3 of the strip");
          assert.equal(args[6], args[2], "1:1 copy (CSS does the integer upscale)");
          assert.equal(args[7], args[3]);
        }
        // The middle of the (moved, warped) body is the avatar colour.
        const bare = new FakeCtx(g.backing, g.backing);
        drawAvatar(bare as unknown as CanvasRenderingContext2D, strip as never, g, 3, { ...cue, overlays: [] });
        const plan = warpPlan(p.frameSize, cue.sx, cue.sy, cue.lean);
        const mx = g.ax + cue.dx + plan.left + Math.floor(plan.width / 2) + Math.round(cue.lean / 2);
        const my = g.ay + g.art + cue.dy - Math.floor(plan.height / 3);
        assert.deepEqual(bare.rgbaAt(mx, my), [255, 34, 68, 255], `${st}@${t}`);
      }
  });

  it("squash is wider and flatter, stretch taller and narrower; the feet stay on the ground", () => {
    const { strip } = mk("#FF2244");
    const draw = (sx: number, sy: number) => {
      const ctx = new FakeCtx(g.backing, g.backing);
      drawAvatar(ctx as unknown as CanvasRenderingContext2D, strip as never, g, 0, { face: "idle", dx: 0, dy: 0, sx, sy, lean: 0, overlays: [] });
      return bbox(ctx, [255, 34, 68]);
    };
    const rest = draw(0, 0);
    const sq = draw(2, -3);
    const st = draw(-2, 3);
    assert.deepEqual([sq.w - rest.w, sq.h - rest.h], [2, -3]);
    assert.deepEqual([st.w - rest.w, st.h - rest.h], [-2, 3]);
    assert.equal(sq.bottom, rest.bottom);
    assert.equal(st.bottom, rest.bottom);
    assert.ok(Math.abs(sq.cx - rest.cx) <= 0.5 && Math.abs(st.cx - rest.cx) <= 0.5, "stays centred");
  });

  it("the working ring is drawn behind and in front of the body; the thought cloud is white with dark dots", () => {
    const { strip } = mk("#FF2244");
    const cue = avatarCue("working", 300, g);
    const ctx = new FakeCtx(g.backing, g.backing);
    drawAvatar(ctx as unknown as CanvasRenderingContext2D, strip as never, g, 0, cue);
    const front = cue.overlays.find((o) => o.kind === "dot" && !o.behind && o.ink)!;
    assert.notDeepEqual(ctx.rgbaAt(front.x, front.y).slice(0, 3), [255, 34, 68], "front ring covers the body");
    const tc = avatarCue("thinking", 1000, g); // 2 dots lit
    const c2 = new FakeCtx(g.backing, g.backing);
    drawAvatar(c2 as unknown as CanvasRenderingContext2D, strip as never, g, 0, tc);
    const cl = tc.overlays.find((o) => o.kind === "cloud")!;
    assert.deepEqual(c2.rgbaAt(cl.x + 2, cl.y + 3), [255, 255, 255, 255], "cloud fill");
    const lit = (cl as { lit: number }).lit;
    const [x, y] = [cl.x + 1 + 3, cl.y + 1 + 3];
    assert.deepEqual(c2.rgbaAt(x + 1, y + 1).slice(0, 3), lit >= 1 ? [0x23, 0x26, 0x2f] : [0xc3, 0xc8, 0xd2]);
  });

  it("clamps an out-of-range face slot", () => {
    const { p } = mk("#000000", 2);
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
