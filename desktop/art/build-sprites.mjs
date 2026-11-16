#!/usr/bin/env node
// Generates the Grok Bot pixel-art spritesheets from code. No dependencies: PNGs are
// encoded by hand with node:zlib. All art here is original and drawn procedurally.
//
// Output (desktop/public/sprites/):
//   grokbot_<state>.png         base layer, RGBA, horizontal strip of 32x32 frames
//   grokbot_<state>_accent.png  accent layer, white + alpha, same frame layout.
//                               The app tints it with the per-bot accent colour.
//   manifest.json               frame counts, fps, loop/playOnce
// Plus desktop/art/icon-1024.png (app icon source) and desktop/art/preview.png.
//
// Usage: node desktop/art/build-sprites.mjs   (or `npm run sprites` in desktop/)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "sprites");
const FW = 32;
const FH = 32;

// ---------- PNG encoding ----------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- palette ----------
const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const P = {
  outline: hex("#5b6478"), // outer silhouette, top/left side
  outlineLo: hex("#474f61"), // outer silhouette, bottom/right side
  rim: hex("#3a4152"), // 1px rim light along the top-left edge
  light: hex("#1c2029"), // lit top-left plane
  base: hex("#0f1115"), // shell
  dark: hex("#08090b"), // shaded bottom-right plane
  visor: hex("#040507"), // visor glass
  glint: hex("#2a303c"), // visor frame, internal seams, glint
  eyeOff: hex("#353b47"),
  fx: hex("#8d96a8"), // z's, wave ticks
  red: hex("#ff4d4d"),
  yellow: hex("#ffc83d"),
  smoke: hex("#aab1bf"), // smoke puffs, laptop lid
  hilite: hex("#d5dbe6"), // laptop lid highlight
  white: hex("#ffffff"),
};
const SHADOW = [0, 0, 0, 64];

// ---------- frame drawing ----------
class Frame {
  constructor() {
    this.base = Buffer.alloc(FW * FH * 4);
    this.accent = Buffer.alloc(FW * FH * 4);
    this.sil = new Uint8Array(FW * FH); // character silhouette (for the outer outline)
    this.ox = 0;
    this.oy = 0;
    this.offline = false;
  }
  idx(x, y) {
    x += this.ox;
    y += this.oy;
    if (x < 0 || y < 0 || x >= FW || y >= FH) return -1;
    return y * FW + x;
  }
  // Base pixel, alpha-blended. Opaque base pixels clear the accent underneath, so draw order
  // gives depth (accent drawn earlier is hidden by anything drawn later in front of it).
  px(x, y, c) {
    const j = this.idx(x, y);
    if (j < 0) return;
    const i = j * 4;
    let [r, g, b, a] = c;
    if (this.offline) {
      // dim + desaturate toward slate, and fade a little
      const l = (r + g + b) / 3;
      r = Math.round(l * 0.85 + 0x2c * 0.15);
      g = Math.round(l * 0.85 + 0x30 * 0.15);
      b = Math.round(l * 0.85 + 0x38 * 0.15);
      a = Math.round(a * 0.9);
    }
    const sa = a / 255;
    const da = this.base[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    const col = [r, g, b];
    for (let k = 0; k < 3; k++) {
      const v = oa === 0 ? 0 : (col[k] * sa + this.base[i + k] * da * (1 - sa)) / oa;
      this.base[i + k] = Math.round(v);
    }
    this.base[i + 3] = Math.round(oa * 255);
    if (c[3] >= 200) this.accent[i + 3] = 0;
  }
  // Accent pixel: white with alpha = intensity. Tinted at runtime.
  ax(x, y, alpha = 255) {
    const j = this.idx(x, y);
    if (j < 0 || this.offline) return;
    const i = j * 4;
    this.accent[i] = this.accent[i + 1] = this.accent[i + 2] = 255;
    this.accent[i + 3] = Math.max(this.accent[i + 3], alpha);
  }
  clearAccent(x, y) {
    const j = this.idx(x, y);
    if (j >= 0) this.accent[j * 4 + 3] = 0;
  }
  isSil(x, y) {
    const j = this.idx(x, y);
    return j >= 0 && this.sil[j] === 1;
  }
  markSil(x, y) {
    const j = this.idx(x, y);
    if (j >= 0) this.sil[j] = 1;
  }
  rect(x0, y0, x1, y1, c) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.px(x, y, c);
  }
  arect(x0, y0, x1, y1, alpha = 255) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.ax(x, y, alpha);
  }
  /** Outer 1px outline around the silhouette (4-neighbour, so corners come out rounded). */
  outline() {
    const { ox, oy } = this;
    this.ox = this.oy = 0;
    const s = (x, y) => x >= 0 && y >= 0 && x < FW && y < FH && this.sil[y * FW + x] === 1;
    const pts = [];
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++) {
        if (s(x, y)) continue;
        const l = s(x - 1, y), r = s(x + 1, y), u = s(x, y - 1), d = s(x, y + 1);
        if (!(l || r || u || d)) continue;
        // pixel sits right of / below the body -> shaded side
        const lo = (l || u) && !(r || d);
        pts.push([x, y, lo ? P.outlineLo : P.outline]);
      }
    for (const [x, y, c] of pts) this.px(x, y, c);
    this.ox = ox;
    this.oy = oy;
  }
}

// rounded-rect mask, local coords; rb = radius of the bottom corners (defaults to r)
function rrMask(w, h, r, rb = r) {
  return (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const rr = y + 0.5 < h / 2 ? r : rb;
    const cx = Math.min(Math.max(x + 0.5, rr), w - rr);
    const cy = Math.min(Math.max(y + 0.5, rr), h - rr);
    return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= rr * rr + 0.3;
  };
}

/**
 * Draw one solid body part: shaded "dark metal" with a rim light on the top-left edge and a
 * darker bottom-right plane. Where the part's edge lies over an already drawn part, a dark
 * seam is drawn so overlapping parts stay readable.
 */
function part(f, x0, y0, w, h, r, opt = {}) {
  const m = rrMask(w, h, r, opt.rb ?? r);
  const { rim = true, flat = false } = opt;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!m(x, y)) continue;
      const gx = x0 + x, gy = y0 + y;
      const eT = !m(x, y - 1), eL = !m(x - 1, y), eB = !m(x, y + 1), eR = !m(x + 1, y);
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      let c;
      if ((eT || eL || eB || eR) && f.isSil(gx, gy)) c = P.glint; // seam over a part behind
      else if (flat) c = P.base;
      else if (rim && ((eT && u < 0.62) || (eL && v < 0.5) || (eT && eL))) c = P.rim;
      else if ((eB || eR) && u + v > 1.15) c = P.dark;
      else {
        const d = u * 0.8 + v;
        c = d < 0.62 ? P.light : d > 1.38 ? P.dark : P.base;
      }
      f.px(gx, gy, c);
      f.markSil(gx, gy);
    }
}

// ---------- glyphs / effects ----------
// "#" = fill, outline added automatically around it (4-neighbour).
function stamp(f, x0, y0, rows, fill, edge, accentAlpha = 0) {
  const on = (x, y) => y >= 0 && y < rows.length && x >= 0 && x < rows[y].length && rows[y][x] === "#";
  const h = rows.length, w = Math.max(...rows.map((r) => r.length));
  if (edge)
    for (let y = -1; y <= h; y++)
      for (let x = -1; x <= w; x++)
        if (!on(x, y) && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1))) f.px(x0 + x, y0 + y, edge);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (on(x, y)) {
        if (fill) f.px(x0 + x, y0 + y, fill);
        if (accentAlpha) f.ax(x0 + x, y0 + y, accentAlpha);
      }
}

const EDGE_FX = [...P.glint.slice(0, 3), 150]; // soft dark edge for accent effects (helps on light desktops)

const SPARKS = {
  1: ["#"],
  2: [".#.", "###", ".#."],
  3: ["..#..", "..#..", "##.##", "..#..", "..#.."],
  4: ["#...#", ".....", ".....", ".....", "#...#"],
};
/** Accent sparkle. size 1..3 grow, 4 = fading corner dots. White-hot centre in the base layer. */
function sparkle(f, cx, cy, size) {
  const g = SPARKS[size];
  const n = g.length;
  const x0 = cx - (n >> 1), y0 = cy - (n >> 1);
  if (size === 4) {
    stamp(f, x0, y0, g, null, null, 150);
    return;
  }
  stamp(f, x0, y0, g, null, size === 1 ? null : EDGE_FX, 255);
  if (size === 2) {
    f.clearAccent(cx, cy);
    f.px(cx, cy, P.white);
  }
}

/** Accent orb (juggling): 3x3 ball, soft corners, hot white highlight in the base layer. */
function orb(f, cx, cy) {
  stamp(f, cx - 1, cy - 1, ["###", "###", "###"], P.base, EDGE_FX, 255);
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    f.clearAccent(cx + x, cy + y);
    f.ax(cx + x, cy + y, 150);
  }
  f.clearAccent(cx - 1, cy - 1);
  f.px(cx - 1, cy - 1, P.white);
  f.clearAccent(cx - 1, cy - 1);
}

const Z_SMALL = ["###", "..#", ".#.", "###"];
const Z_BIG = ["####", "...#", "..#.", ".#..", "####"];

// ---------- the bot ----------
/**
 * Options:
 *  jump  - whole body y offset (negative = up; shadow stays on the ground)
 *  bob   - upper body (head + hands) y offset
 *  slump - extra head-only y offset (sleeping)
 *  dx    - horizontal shake
 *  eyes  - open|up|upRight|down|blink|closed|happy|x|off|none
 *  hands - [left, right] poses (see HAND)
 *  laptop- draw the laptop in front of the body
 *  tip   - antenna tip intensity 0..255 (accent), or "red"
 *  chest - chest light alpha
 *  squash- 1 = crouch (feet stay, everything else 1px down)
 */
const HAND = {
  // [x, y] top-left of a 2x2 mitt, in upper-body coordinates
  L: { down: [8, 22], hip: [8, 21], up: [1, 10], high: [3, 5], toss: [1, 7], type0: [9, 22, 3, 2], type1: [9, 24, 3, 2] },
  R: { down: [22, 22], hip: [22, 21], up: [29, 10], high: [27, 5], toss: [29, 7], type0: [20, 22, 3, 2], type1: [20, 24, 3, 2], wave0: [25, 5, 3, 3], wave1: [27, 7, 3, 3], chin: [27, 12] },
};
// visor band (head-local absolute coords)
const VX = 9, VY = 13, VW = 14, VH = 5;
const vmask = rrMask(VW, VH, 1.6);
const inVisor = (x, y) => vmask(x - VX, y - VY);
const EY = 14; // top row of open eyes

// The whole character sits 1px lower than its drawing coordinates, leaving headroom for hops.
const BASE_Y = 1;

function drawBot(f, o = {}) {
  const {
    jump = 0, bob = 0, slump = 0, dx = 0, eyes = "open", hands = ["down", "down"],
    laptop = false, tip = 255, chest = 255, squash = 0, keyFlash = -1, shadow = true,
  } = o;
  const G = BASE_Y;

  // ground shadow (not part of the silhouette), shrinks while airborne
  f.ox = dx;
  f.oy = G;
  const s = Math.min(3, Math.max(0, Math.round(-jump / 1.5)));
  if (shadow) {
    f.rect(9 + s, 29, 22 - s, 29, SHADOW);
    f.rect(11 + s, 30, 20 - s, 30, [0, 0, 0, 34]);
  }

  // feet
  f.oy = jump + G;
  part(f, 10, 27, 4, 2, 1, { rim: false });
  part(f, 18, 27, 4, 2, 1, { rim: false });

  // body
  f.oy = jump + squash + G;
  part(f, 11, 19, 10, 8, 2.2);
  f.arect(15, 23, 16, 23, chest);
  if (chest) { f.ax(14, 23, chest * 0.3); f.ax(17, 23, chest * 0.3); }

  const up = jump + squash + bob + G;
  // thin arms for raised hands (drawn behind the head, so they emerge from the shoulders)
  f.oy = up;
  const handBox = (side, pose) => (Array.isArray(pose) ? pose : HAND[side][pose]);
  for (const [side, pose, sx] of [["L", hands[0], 10], ["R", hands[1], 21]]) {
    if (!pose) continue;
    const [hx, hy, hw = 2, hh = 2] = handBox(side, pose);
    const cx = hx + (hw - 1) / 2, cy = hy + (hh - 1) / 2;
    if (cy > 19) continue; // hands near the body need no arm
    const sy = 21;
    const n = Math.max(Math.abs(cx - sx), Math.abs(cy - sy));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(sx + ((cx - sx) * k) / n), y = Math.round(sy + ((cy - sy) * k) / n);
      if (f.isSil(x, y)) continue;
      f.px(x, y, P.light);
      f.markSil(x, y);
    }
  }
  // antenna (behind the head)
  f.oy = up + slump;
  part(f, 15, 6, 2, 5, 0, { flat: true });
  part(f, 14, 3, 4, 4, 2, { rim: false });
  if (tip === "red") f.rect(15, 4, 16, 5, P.red);
  else if (tip > 0) {
    f.arect(14, 4, 17, 5, Math.round(tip * 0.45));
    f.arect(15, 3, 16, 6, Math.round(tip * 0.45));
    f.arect(15, 4, 16, 5, tip);
  }

  // head
  part(f, 5, 13, 3, 5, 1, { rim: false }); // ear caps
  part(f, 24, 13, 3, 5, 1, { rim: false });
  part(f, 7, 9, 18, 12, 6, { rb: 3.2 });
  // visor band with a 1px frame (lit lower lip, glint top-left)
  for (let y = VY - 1; y <= VY + VH; y++)
    for (let x = VX - 1; x <= VX + VW; x++) {
      if (inVisor(x, y)) f.px(x, y, P.visor);
      else if (inVisor(x, y + 1) || inVisor(x, y - 1) || inVisor(x + 1, y) || inVisor(x - 1, y))
        f.px(x, y, y >= VY + VH ? P.rim : P.glint);
    }
  f.px(VX + 1, VY, P.glint);
  f.px(VX + 2, VY, P.glint);
  f.px(VX, VY + 1, P.glint);

  // eyes
  const eye = (x0, y0, w, h, glow = 80) => {
    for (let y = y0 - 1; y <= y0 + h; y++)
      for (let x = x0 - 1; x <= x0 + w; x++) {
        const corner = (x === x0 - 1 || x === x0 + w) && (y === y0 - 1 || y === y0 + h);
        if (!inVisor(x, y) || corner) continue;
        f.ax(x, y, glow);
      }
    f.arect(x0, y0, x0 + w - 1, y0 + h - 1, 255);
    if (h >= 3) {
      // tiny hot highlight (base layer, stays white for every accent colour)
      f.clearAccent(x0, y0);
      f.px(x0, y0, P.white);
    }
  };
  if (eyes === "open") { eye(12, EY, 2, 3); eye(18, EY, 2, 3); }
  else if (eyes === "up") { eye(12, EY - 1, 2, 3); eye(18, EY - 1, 2, 3); }
  else if (eyes === "upRight") { eye(13, EY - 1, 2, 3); eye(19, EY - 1, 2, 3); }
  else if (eyes === "down") { eye(12, EY + 1, 2, 3); eye(18, EY + 1, 2, 3); }
  else if (eyes === "blink") { eye(11, EY + 2, 4, 1, 40); eye(17, EY + 2, 4, 1, 40); }
  else if (eyes === "closed") {
    for (const x0 of [11, 17]) {
      f.ax(x0, EY + 1, 140);
      f.arect(x0 + 1, EY + 2, x0 + 2, EY + 2, 170);
      f.ax(x0 + 3, EY + 1, 140);
    }
  } else if (eyes === "happy") {
    for (const x0 of [11, 17]) {
      for (let x = x0; x <= x0 + 3; x++) for (let y = EY; y <= EY + 3; y++) if (inVisor(x, y)) f.ax(x, y, 45);
      f.ax(x0, EY + 2, 255);
      f.arect(x0 + 1, EY + 1, x0 + 2, EY + 1, 255);
      f.ax(x0 + 3, EY + 2, 255);
    }
  } else if (eyes === "x") {
    for (const x0 of [11, 17]) {
      for (let y = VY; y < VY + VH; y++) for (let x = x0 - 1; x <= x0 + 4; x++) if (inVisor(x, y)) f.px(x, y, [255, 77, 77, 40]);
      for (const [x, y] of [[0, 0], [3, 0], [1, 1], [2, 1], [1, 2], [2, 2], [0, 3], [3, 3]]) f.px(x0 + x, VY + y, P.red);
    }
  } else if (eyes === "off") {
    f.rect(12, EY + 2, 13, EY + 2, P.eyeOff);
    f.rect(18, EY + 2, 19, EY + 2, P.eyeOff);
  }

  // laptop (in front of the body, we see the silver back of the lid)
  if (laptop) {
    f.oy = jump + G;
    const lm = rrMask(12, 6, 1);
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 12; x++) {
        if (!lm(x, y)) continue;
        const c = y === 0 || x === 0 ? P.hilite : y === 5 || x === 11 ? P.outline : P.smoke;
        f.px(10 + x, 20 + y, c);
        f.markSil(10 + x, 20 + y);
      }
    // glowing logo on the lid
    f.arect(15, 22, 16, 23, 255);
    f.ax(14, 22, 90); f.ax(17, 23, 90);
    // keyboard deck edge
    for (let x = 7; x <= 24; x++) {
      f.px(x, 26, x === 7 ? P.smoke : P.outline);
      f.markSil(x, 26);
    }
    if (keyFlash >= 0) f.arect(keyFlash, 26, keyFlash, 26, 255);
  }

  // hands (in front)
  f.oy = up;
  const [hl, hr] = hands;
  for (const [side, pose] of [["L", hl], ["R", hr]]) {
    if (!pose) continue;
    const [hx, hy, hw = 2, hh = 2] = handBox(side, pose);
    part(f, hx, hy, hw, hh, 0);
  }

  f.ox = dx;
  f.oy = 0;
  f.outline();
  f.ox = 0;
  f.oy = 0;
}

// ---------- animations ----------
const STATES = {
  idle: {
    frames: 4,
    fps: 4,
    loop: true,
    draw: (f, i) =>
      drawBot(f, {
        bob: [0, 0, 1, 1][i],
        eyes: i === 2 ? "blink" : "open",
        chest: [255, 200, 150, 200][i],
        tip: [255, 220, 190, 220][i],
      }),
  },
  thinking: {
    frames: 6,
    fps: 5,
    loop: true,
    draw: (f, i) => {
      drawBot(f, { eyes: "upRight", hands: ["down", "chin"], bob: i >= 3 ? 1 : 0, tip: i % 2 ? 255 : 180 });
      // ellipsis appearing one dot at a time, then pulsing out
      const dots = [[21, 3], [25, 3], [29, 3]];
      const shown = [0, 1, 2, 3, 3, 3][i];
      const alpha = i === 5 ? 120 : 255;
      for (let d = 0; d < shown; d++) {
        const [x, y] = dots[d];
        const big = d === shown - 1 && i < 4;
        stamp(f, x, big ? y - 1 : y, ["##", "##"], null, null, big ? 255 : alpha);
      }
    },
  },
  working: {
    frames: 8,
    fps: 10,
    loop: true,
    draw: (f, i) => {
      const a = i % 2 === 0;
      drawBot(f, {
        eyes: "down",
        laptop: true,
        hands: a ? ["type0", "type1"] : ["type1", "type0"],
        slump: i % 4 === 3 ? 1 : 0,
        keyFlash: a ? 20 + ((i >> 1) % 3) : 9 + ((i >> 1) % 3),
      });
    },
  },
  juggling: {
    frames: 10,
    fps: 12,
    loop: true,
    draw: (f, i) => {
      // three orbs on an ellipse; each loop advances 240 deg so the strip loops seamlessly.
      // Lower half of the ellipse passes behind the head; upper arc flies over it.
      const TAU = Math.PI * 2;
      const orbs = [0, 1, 2].map((k) => {
        const t = (((-Math.PI / 2 + TAU / 30 + (k * TAU) / 3 + (i / 10) * (2 * TAU) / 3) % TAU) + TAU) % TAU;
        return { t, x: Math.round(15.5 + 11.5 * Math.cos(t)), y: Math.round(9 + 6 * Math.sin(t)), front: Math.sin(t) < 0.35 };
      });
      for (const d of orbs.filter((d) => !d.front)) orb(f, d.x, d.y);
      // orbs fly up from the left hand, over the head, down into the right hand and are
      // passed back behind the head. Left hand pops up as it tosses, right hand dips as it catches.
      const near = (a, b) => orbs.some((d) => d.t >= a && d.t <= b);
      const left = near(Math.PI - 0.2, Math.PI + 0.9) ? [3, 6] : [3, 10];
      const right = near(-0.1, 0.7) ? [27, 11] : [27, 8];
      drawBot(f, { eyes: "up", hands: [left, right], tip: 255 });
      for (const d of orbs.filter((d) => d.front)) orb(f, d.x, d.y);
    },
  },
  needs_you: {
    frames: 6,
    fps: 8,
    loop: true,
    draw: (f, i) => {
      const jump = [0, -2, -3, -3, -2, 0][i];
      drawBot(f, {
        jump,
        squash: i === 0 ? 1 : 0,
        eyes: "open",
        hands: ["down", i % 2 ? "wave1" : "wave0"],
      });
      // little motion ticks beside the waving hand
      f.oy = jump + BASE_Y;
      const tick = [...P.fx.slice(0, 3), 220];
      if (i % 2) { f.px(25, 5, tick); f.px(26, 4, tick); }
      else { f.px(29, 6, tick); f.px(29, 7, tick); }
      f.oy = 0;
      // yellow "!" sign, top-left, bobbing opposite to the hop
      const sy = [2, 2, 1, 1, 2, 2][i];
      stamp(f, 2, sy, [".###.", "#####", "#####", "#####", "#####", "#####", "#####", ".###."], P.yellow, P.outline);
      f.rect(4, sy + 1, 4, sy + 4, P.base);
      f.px(4, sy + 6, P.base);
    },
  },
  done: {
    frames: 8,
    fps: 10,
    loop: false,
    then: "idle",
    draw: (f, i) => {
      const jump = [0, -2, -3, -3, -2, 0, 0, 0][i];
      const air = i >= 1 && i <= 4;
      drawBot(f, {
        jump,
        squash: i === 0 || i === 5 ? 1 : 0,
        eyes: i === 7 ? "open" : "happy",
        hands: air ? ["high", "high"] : ["down", "down"],
      });
      // sparkle bursts: [x, y, size] per frame
      const fx = [
        [],
        [[5, 6, 1], [26, 4, 1]],
        [[5, 6, 2], [26, 4, 2], [3, 16, 1]],
        [[5, 6, 3], [26, 4, 3], [3, 16, 2], [28, 18, 1]],
        [[5, 6, 4], [26, 4, 4], [3, 16, 3], [28, 18, 2]],
        [[3, 16, 4], [28, 18, 3]],
        [[28, 18, 4]],
        [],
      ][i];
      for (const [x, y, sz] of fx) sparkle(f, x, y, sz);
    },
  },
  error: {
    frames: 6,
    fps: 10,
    loop: true,
    draw: (f, i) => {
      // smoke puffs (base layer, grey) rising from the top-right of the head
      const puffs = [
        [[23, 8, 0]],
        [[24, 6, 1]],
        [[25, 4, 1], [23, 8, 0]],
        [[26, 2, 2], [24, 6, 1]],
        [[25, 4, 1]],
        [[26, 2, 2]],
      ][i];
      drawBot(f, {
        dx: [0, -1, 1, -1, 1, 0][i],
        eyes: i === 4 ? "off" : "x",
        tip: i % 2 ? "red" : 0,
        chest: 0,
        hands: ["down", "down"],
      });
      for (const [x, y, s] of puffs) {
        const g = s === 0 ? ["##", "##"] : s === 1 ? [".##.", "####", "####", ".##."] : [".##.", "#..#", "#..#", ".##."];
        const a = s === 2 ? 150 : 230;
        stamp(f, x, y, g, [...P.smoke.slice(0, 3), a], s === 2 ? null : [...P.outline.slice(0, 3), 200]);
      }
    },
  },
  sleeping: {
    frames: 4,
    fps: 2,
    loop: true,
    draw: (f, i) => {
      drawBot(f, {
        slump: 1,
        bob: [0, 0, 1, 1][i],
        eyes: "closed",
        tip: 60,
        chest: [90, 60, 40, 60][i],
        hands: ["down", "down"],
      });
      // two z's rising and fading, staggered by two frames (mid grey reads on light and dark)
      const path = [
        [22, 7, Z_SMALL, 255],
        [24, 4, Z_SMALL, 230],
        [26, 0, Z_BIG, 200],
        [28, -2, Z_BIG, 0],
      ];
      for (const k of [i, (i + 2) % 4]) {
        const [x, y, g, a] = path[k];
        if (!a) continue;
        stamp(f, x, y, g, [...P.fx.slice(0, 3), a], null);
      }
    },
  },
  offline: {
    frames: 1,
    fps: 1,
    loop: true,
    draw: (f) => {
      f.offline = true;
      drawBot(f, { slump: 1, eyes: "off", tip: 0, chest: 0 });
    },
  },
};

// ---------- compose helpers (preview / icon) ----------
function tintOver(dst, accent, rgb) {
  for (let i = 0; i < dst.length; i += 4) {
    const sa = accent[i + 3] / 255;
    if (!sa) continue;
    const da = dst[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) dst[i + k] = Math.round((rgb[k] * sa + dst[i + k] * da * (1 - sa)) / oa);
    dst[i + 3] = Math.round(oa * 255);
  }
}

// nearest-neighbour blit with alpha-over onto an RGBA destination
function blit(dst, dw, src, sw, sh, dx, dy, scale) {
  for (let y = 0; y < sh * scale; y++)
    for (let x = 0; x < sw * scale; x++) {
      const si = (Math.floor(y / scale) * sw + Math.floor(x / scale)) * 4;
      const di = ((dy + y) * dw + dx + x) * 4;
      const sa = src[si + 3] / 255;
      if (!sa) continue;
      const da = dst[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) dst[di + k] = Math.round((src[si + k] * sa + dst[di + k] * da * (1 - sa)) / oa);
      dst[di + 3] = Math.round(oa * 255);
    }
}

function fill(dst, dw, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * dw + x) * 4;
      dst[i] = rgb[0];
      dst[i + 1] = rgb[1];
      dst[i + 2] = rgb[2];
      dst[i + 3] = 255;
    }
}

function composite(f, rgb) {
  const px = Buffer.from(f.base);
  tintOver(px, f.accent, rgb);
  return px;
}

// ---------- build ----------
mkdirSync(OUT, { recursive: true });
const manifest = {
  version: 1,
  frameWidth: FW,
  frameHeight: FH,
  scale: 3,
  accent: {
    mode: "layer",
    note: "Each state has a <file> base strip and an <accent> strip (white + alpha). The app tints the accent strip with the bot's colour and draws it over the base.",
  },
  states: {},
};
const frames = {};
for (const [name, def] of Object.entries(STATES)) {
  const w = FW * def.frames;
  const base = Buffer.alloc(w * FH * 4);
  const acc = Buffer.alloc(w * FH * 4);
  frames[name] = [];
  for (let i = 0; i < def.frames; i++) {
    const f = new Frame();
    def.draw(f, i);
    frames[name].push(f);
    for (let y = 0; y < FH; y++) {
      f.base.copy(base, (y * w + i * FW) * 4, y * FW * 4, (y + 1) * FW * 4);
      f.accent.copy(acc, (y * w + i * FW) * 4, y * FW * 4, (y + 1) * FW * 4);
    }
  }
  writeFileSync(join(OUT, `grokbot_${name}.png`), encodePng(w, FH, base));
  writeFileSync(join(OUT, `grokbot_${name}_accent.png`), encodePng(w, FH, acc));
  manifest.states[name] = {
    file: `grokbot_${name}.png`,
    accent: `grokbot_${name}_accent.png`,
    frames: def.frames,
    fps: def.fps,
    loop: def.loop,
    playOnce: !def.loop,
    ...(def.then ? { then: def.then } : {}),
  };
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// preview: every frame of every state (one row per state), 4x, in four blocks:
//   teal on light | teal on dark
//   orange on light | violet on dark
const names = Object.keys(STATES);
const S = 4;
const cell = FW * S;
const cols = Math.max(...names.map((n) => STATES[n].frames));
const gap = 16;
const bw = cols * cell + 2 * gap;
const bh = names.length * cell + 2 * gap;
const LIGHT = [0xee, 0xf0, 0xf3];
const DARK = [0x1b, 0x1e, 0x25];
const blocks = [
  [0, 0, LIGHT, [0x2d, 0xd4, 0xbf]],
  [1, 0, DARK, [0x2d, 0xd4, 0xbf]],
  [0, 1, LIGHT, [0xf0, 0x88, 0x3e]],
  [1, 1, DARK, [0xa7, 0x8b, 0xfa]],
];
const pw = bw * 2;
const ph = bh * 2;
const prev = Buffer.alloc(pw * ph * 4);
for (const [bx, by, bg, acc] of blocks) {
  fill(prev, pw, bx * bw, by * bh, bw, bh, bg);
  names.forEach((n, row) =>
    frames[n].forEach((f, col) => blit(prev, pw, composite(f, acc), FW, FH, bx * bw + gap + col * cell, by * bh + gap + row * cell, S)),
  );
}
writeFileSync(join(HERE, "preview.png"), encodePng(pw, ph, prev));

// icon source: idle bot, teal accent, on a rounded dark-slate tile, 1024px
{
  const f = new Frame();
  drawBot(f, { shadow: false }); // idle pose, no ground shadow on the tile
  const px = composite(f, [0x2d, 0xd4, 0xbf]);
  let x0 = FW, y0 = FH, x1 = -1, y1 = -1;
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++)
      if (px[(y * FW + x) * 4 + 3] > 80) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  const N = 1024;
  const pad = 72;
  const R = 190;
  const icon = Buffer.alloc(N * N * 4);
  for (let y = pad; y < N - pad; y++)
    for (let x = pad; x < N - pad; x++) {
      const cx = Math.min(Math.max(x + 0.5, pad + R), N - pad - R);
      const cy = Math.min(Math.max(y + 0.5, pad + R), N - pad - R);
      const dd = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      if (dd > R + 0.5) continue;
      const t = (y - pad) / (N - 2 * pad);
      const i = (y * N + x) * 4;
      icon[i] = Math.round(0x34 - 0x12 * t);
      icon[i + 1] = Math.round(0x3a - 0x12 * t);
      icon[i + 2] = Math.round(0x4a - 0x12 * t);
      icon[i + 3] = Math.round(255 * Math.min(1, R + 0.5 - dd)); // anti-aliased tile edge only
    }
  const bwid = x1 - x0 + 1, bhei = y1 - y0 + 1;
  const sc = Math.floor(((N - 2 * pad) * 0.78) / Math.max(bwid, bhei));
  const crop = Buffer.alloc(bwid * bhei * 4);
  for (let y = 0; y < bhei; y++) px.copy(crop, y * bwid * 4, ((y0 + y) * FW + x0) * 4, ((y0 + y) * FW + x1 + 1) * 4);
  blit(icon, N, crop, bwid, bhei, Math.round((N - bwid * sc) / 2), Math.round((N - bhei * sc) / 2), sc);
  writeFileSync(join(HERE, "icon-1024.png"), encodePng(N, N, icon));
}

console.log(`wrote ${names.length} states to ${OUT}`);
