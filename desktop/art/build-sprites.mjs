#!/usr/bin/env node
// Generates the placeholder Grok Bot pixel-art spritesheets. No dependencies:
// PNGs are encoded by hand with node:zlib.
//
// Output (desktop/public/sprites/):
//   grokbot_<state>.png         base layer, RGBA, horizontal strip of 32x32 frames
//   grokbot_<state>_accent.png  accent layer, white + alpha, same frame layout.
//                               The app tints it with the per-bot accent colour.
//   manifest.json               frame counts, fps, loop/playOnce
// Plus desktop/art/icon-1024.png (app icon source) and desktop/art/preview.png.
//
// Usage: node desktop/art/build-sprites.mjs
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
const BODY = [0x14, 0x16, 0x1c, 255]; // near-black body
const OUTLINE = [0x4f, 0x56, 0x66, 255]; // 1px lighter outline: reads on dark desktops
const HILITE = [0x2c, 0x31, 0x3c, 255];
const VISOR = [0x06, 0x07, 0x0a, 255];
const LIMB = [0x3a, 0x40, 0x4d, 255];
const KEYS = [0x2c, 0x31, 0x3c, 255];
const KEYCAP = [0x5a, 0x62, 0x72, 255];
const WHITE = [0xff, 0xff, 0xff, 255];
const RED = [0xff, 0x4d, 0x4d, 255];
const FLAG = [0xff, 0xc8, 0x3d, 255];
const POLE = [0x9a, 0xa3, 0xb5, 255];
const ZZZ = [0xc4, 0xcc, 0xdb, 235];
const SHADOW = [0, 0, 0, 70];
const EYE_OFF = [0x3c, 0x41, 0x4c, 255];

// ---------- frame drawing ----------
class Frame {
  constructor() {
    this.base = Buffer.alloc(FW * FH * 4);
    this.accent = Buffer.alloc(FW * FH * 4);
    this.ox = 0;
    this.oy = 0;
    this.dim = 1;
  }
  idx(x, y) {
    x += this.ox;
    y += this.oy;
    if (x < 0 || y < 0 || x >= FW || y >= FH) return -1;
    return (y * FW + x) * 4;
  }
  // Opaque base pixels also clear the accent layer underneath, so draw order gives depth.
  px(x, y, c) {
    const i = this.idx(x, y);
    if (i < 0) return;
    const a = Math.round(c[3] * this.dim);
    const sa = a / 255;
    const da = this.base[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) {
      const v = oa === 0 ? 0 : (c[k] * sa + this.base[i + k] * da * (1 - sa)) / oa;
      this.base[i + k] = Math.round(v);
    }
    this.base[i + 3] = Math.round(oa * 255);
    if (a >= 200) this.accent[i + 3] = 0;
  }
  // Accent pixels: white with alpha = intensity. Tinted at runtime.
  ax(x, y, alpha = 255) {
    const i = this.idx(x, y);
    if (i < 0 || this.dim < 1) return;
    this.accent[i] = this.accent[i + 1] = this.accent[i + 2] = 255;
    this.accent[i + 3] = Math.max(this.accent[i + 3], alpha);
  }
  rect(x0, y0, x1, y1, c) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.px(x, y, c);
  }
  arect(x0, y0, x1, y1, alpha = 255) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.ax(x, y, alpha);
  }
  round(x0, y0, x1, y1, r, c) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (Math.min(x - x0, x1 - x) + Math.min(y - y0, y1 - y) < r) continue;
        this.px(x, y, c);
      }
  }
  glyph(x0, y0, rows, c) {
    rows.forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && this.px(x0 + x, y0 + y, c)));
  }
}

const SPARK = {
  1: ["#"],
  3: [".#.", "###", ".#."],
  5: ["..#..", "..#..", "#####", "..#..", "..#.."],
  x: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
};

function spark(f, cx, cy, size) {
  const g = SPARK[size];
  const n = g.length;
  const x0 = cx - (n >> 1);
  const y0 = cy - (n >> 1);
  g.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch !== "#") return;
      const center = x === n >> 1 && y === n >> 1;
      if (center) f.px(x0 + x, y0 + y, WHITE);
      else f.ax(x0 + x, y0 + y, 255);
    }),
  );
}

/**
 * Draw the bot. `jump` moves everything (feet included); `bob` moves only the upper body
 * (breathing squash); `dx` shakes horizontally.
 */
function drawBot(f, o = {}) {
  const { jump = 0, bob = 0, dx = 0, eyes = "open", arms = "down", phase = 0, dim = false, tipAccent = true } = o;
  f.dim = dim ? 0.55 : 1;

  // shadow stays on the ground, shrinks while airborne
  f.ox = dx;
  f.oy = 0;
  const shrink = Math.min(3, Math.floor(-jump / 2));
  f.rect(10 + shrink, 30, 21 - shrink, 30, SHADOW);
  f.rect(12 + shrink, 31, 19 - shrink, 31, [0, 0, 0, 35]);

  // feet
  f.oy = jump;
  f.rect(11, 28, 13, 29, LIMB);
  f.rect(18, 28, 20, 29, LIMB);

  // upper body
  f.oy = jump + bob;

  // arms (behind body)
  const armL = (pose) => {
    if (pose === "down") f.rect(8, 22, 9, 25, LIMB);
    else if (pose === "up") {
      f.rect(8, 21, 9, 22, LIMB);
      f.rect(4, 15, 5, 21, LIMB);
      f.px(6, 21, LIMB);
      f.px(7, 21, LIMB);
    } else if (pose === "typeA") f.rect(8, 24, 10, 25, LIMB);
    else if (pose === "typeB") f.rect(8, 25, 10, 26, LIMB);
  };
  const armR = (pose) => {
    if (pose === "down") f.rect(22, 22, 23, 25, LIMB);
    else if (pose === "up") {
      f.rect(22, 21, 23, 22, LIMB);
      f.rect(26, 15, 27, 21, LIMB);
      f.px(24, 21, LIMB);
      f.px(25, 21, LIMB);
    } else if (pose === "typeA") f.rect(21, 24, 23, 25, LIMB);
    else if (pose === "typeB") f.rect(21, 25, 23, 26, LIMB);
  };
  const [pl, pr] = Array.isArray(arms) ? arms : [arms, arms];
  if (pl !== "typeA" && pl !== "typeB") armL(pl);
  if (pr !== "typeA" && pr !== "typeB") armR(pr);

  // torso
  f.round(10, 21, 21, 27, 1, OUTLINE);
  f.rect(11, 22, 20, 26, BODY);
  f.arect(15, 24, 16, 24, phase % 2 ? 160 : 255); // chest light

  // antenna
  f.rect(15, 8, 16, 8, OUTLINE);
  f.round(14, 4, 17, 7, 1, OUTLINE);
  f.rect(15, 5, 16, 6, BODY);
  if (eyes === "red") f.rect(15, 5, 16, 6, RED);
  else if (tipAccent && !dim) f.arect(15, 5, 16, 6, 255);

  // head
  f.round(6, 9, 25, 21, 2, OUTLINE);
  f.round(7, 10, 24, 20, 1, BODY);
  f.rect(8, 10, 11, 10, HILITE);
  f.px(7, 11, HILITE);
  f.round(9, 12, 22, 19, 1, VISOR);

  // eyes
  const glow = (x0, y0, x1, y1, alpha) => {
    for (let y = y0 - 1; y <= y1 + 1; y++)
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
        if (x < 10 || x > 21 || y < 13 || y > 18) continue;
        f.ax(x, y, alpha);
      }
  };
  const eyePair = (y0, h) => {
    for (const x0 of [12, 18]) {
      glow(x0, y0, x0 + 1, y0 + h - 1, 70);
      f.arect(x0, y0, x0 + 1, y0 + h - 1, 255);
    }
  };
  if (eyes === "open") eyePair(14, 3);
  else if (eyes === "up") eyePair(13, 3);
  else if (eyes === "down") eyePair(15, 3);
  else if (eyes === "blink") eyePair(15, 1);
  else if (eyes === "closed") {
    f.arect(11, 16, 13, 16, 150);
    f.arect(18, 16, 20, 16, 150);
  } else if (eyes === "happy") {
    for (const [x, y] of [[11, 16], [12, 15], [13, 15], [14, 16], [17, 16], [18, 15], [19, 15], [20, 16]]) f.ax(x, y, 255);
    glow(12, 15, 13, 15, 60);
    glow(18, 15, 19, 15, 60);
  } else if (eyes === "red") {
    for (const x0 of [12, 18]) {
      for (let y = 13; y <= 17; y++)
        for (let x = x0 - 1; x <= x0 + 2; x++) if (x >= 10 && x <= 21) f.px(x, y, [255, 60, 60, 60]);
      f.rect(x0, 14, x0 + 1, 16, RED);
    }
  } else if (eyes === "off") {
    f.rect(12, 15, 13, 15, EYE_OFF);
    f.rect(18, 15, 19, 15, EYE_OFF);
  }

  // forward arms (typing) go in front of the torso, on a keyboard
  if (pl === "typeA" || pl === "typeB") {
    f.rect(8, 26, 23, 27, KEYS);
    for (let x = 9; x <= 22; x += 2) f.px(x, 26, KEYCAP);
    armL(pl);
    armR(pr);
  }
  f.ox = 0;
  f.oy = 0;
  f.dim = 1;
}

// ---------- animations ----------
const STATES = {
  idle: {
    frames: 4,
    fps: 3,
    loop: true,
    draw: (f, i) => drawBot(f, { bob: [0, 0, 1, 1][i], eyes: i === 3 ? "blink" : "open", phase: i }),
  },
  thinking: {
    frames: 6,
    fps: 8,
    loop: true,
    draw: (f, i) => {
      drawBot(f, { eyes: "up", bob: i >= 3 ? 1 : 0, phase: i });
      f.px(24, 7, [0x9a, 0xa3, 0xb5, 200]);
      spark(f, 27, 4, [1, 3, 5, "x", 3, 1][i]);
    },
  },
  working: {
    frames: 8,
    fps: 10,
    loop: true,
    draw: (f, i) => {
      const a = i % 2 === 0;
      drawBot(f, { eyes: "down", arms: a ? ["typeA", "typeB"] : ["typeB", "typeA"], phase: i });
      f.ax(9 + ((i * 5) % 14), 26, 255); // key flash
    },
  },
  juggling: {
    frames: 10,
    fps: 12,
    loop: true,
    draw: (f, i) => {
      const dots = [0, Math.PI].map((off) => {
        const a = (i / 10) * Math.PI * 2 + off;
        return { x: Math.round(15.5 + 12 * Math.cos(a)), y: Math.round(6 + 3 * Math.sin(a)), front: Math.sin(a) >= 0 };
      });
      const dot = (d) => {
        f.arect(d.x, d.y, d.x + 1, d.y + 1, 255);
        f.px(d.x, d.y, WHITE);
      };
      dots.filter((d) => !d.front).forEach(dot);
      drawBot(f, { eyes: "up", arms: i < 5 ? ["up", "down"] : ["down", "up"], phase: i });
      dots.filter((d) => d.front).forEach(dot);
    },
  },
  needs_you: {
    frames: 6,
    fps: 8,
    loop: true,
    draw: (f, i) => {
      const jump = [0, -1, -3, -4, -3, -1][i];
      drawBot(f, { jump, eyes: "open", arms: ["down", "up"], phase: i });
      f.oy = jump;
      f.rect(28, 4, 28, 16, POLE);
      f.rect(29, 4, 31, 6, FLAG);
      if (i % 2 === 0) f.rect(29, 7, 30, 7, FLAG);
      else f.rect(30, 7, 31, 7, FLAG);
      f.oy = 0;
    },
  },
  done: {
    frames: 8,
    fps: 10,
    loop: false,
    then: "idle",
    draw: (f, i) => {
      const jump = [0, -2, -4, -4, -2, 0, 0, 0][i];
      drawBot(f, { jump, eyes: "happy", arms: i >= 1 && i <= 4 ? "up" : "down", phase: i });
      const s = [null, null, 1, 3, 5, "x", 3, 1][i];
      if (s) {
        spark(f, 3, 7, s);
        spark(f, 28, 6, s === 1 ? 3 : s === 3 ? 1 : s);
      }
      if (i >= 4 && i <= 6) spark(f, 4, 18, i === 5 ? 3 : 1);
    },
  },
  error: {
    frames: 6,
    fps: 12,
    loop: true,
    draw: (f, i) => {
      drawBot(f, { dx: [0, -1, 1, -1, 1, 0][i], eyes: "red", phase: i });
    },
  },
  sleeping: {
    frames: 4,
    fps: 2,
    loop: true,
    draw: (f, i) => {
      drawBot(f, { bob: [0, 0, 1, 1][i], eyes: "closed", tipAccent: false, phase: 1 });
      const small = ["###", "..#", ".#.", "###"];
      const big = ["####", "...#", "..#.", ".#..", "####"];
      const zs = [
        [[24, 7, small]],
        [[25, 5, small], [27, 0, big]],
        [[26, 3, small]],
        [[24, 7, small], [27, 0, big]],
      ][i];
      for (const [x, y, g] of zs) f.glyph(x, y, g, ZZZ);
    },
  },
  offline: {
    frames: 1,
    fps: 1,
    loop: true,
    draw: (f) => drawBot(f, { eyes: "off", dim: true, tipAccent: false }),
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

function blit(dst, dw, src, sw, sh, dx, dy, scale, bg) {
  for (let y = 0; y < sh * scale; y++)
    for (let x = 0; x < sw * scale; x++) {
      const si = (Math.floor(y / scale) * sw + Math.floor(x / scale)) * 4;
      const di = ((dy + y) * dw + dx + x) * 4;
      const a = src[si + 3] / 255;
      for (let k = 0; k < 3; k++) dst[di + k] = Math.round(src[si + k] * a + (bg ? bg[k] : dst[di + k]) * (1 - a));
      dst[di + 3] = bg ? 255 : Math.max(dst[di + 3], src[si + 3]);
    }
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
const firstFrames = {};
for (const [name, def] of Object.entries(STATES)) {
  const w = FW * def.frames;
  const base = Buffer.alloc(w * FH * 4);
  const acc = Buffer.alloc(w * FH * 4);
  for (let i = 0; i < def.frames; i++) {
    const f = new Frame();
    def.draw(f, i);
    for (let y = 0; y < FH; y++) {
      f.base.copy(base, (y * w + i * FW) * 4, y * FW * 4, (y + 1) * FW * 4);
      f.accent.copy(acc, (y * w + i * FW) * 4, y * FW * 4, (y + 1) * FW * 4);
    }
    if (i === Math.min(def.frames - 1, name === "done" ? 3 : name === "thinking" ? 2 : 1)) firstFrames[name] = f;
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

// preview: every state, three accents, on a light and a dark background
const names = Object.keys(STATES);
const accents = [
  [0x2d, 0xd4, 0xbf],
  [0xf9, 0x73, 0x16],
  [0xa7, 0x8b, 0xfa],
];
const S = 4;
const cell = FW * S;
const pw = names.length * cell;
const ph = cell * 6;
const prev = Buffer.alloc(pw * ph * 4);
const bgs = [
  [0xee, 0xef, 0xf2],
  [0x1f, 0x22, 0x2a],
];
let row = 0;
for (const bg of bgs)
  for (const acc of accents) {
    names.forEach((n, col) => {
      const f = firstFrames[n];
      const px = Buffer.from(f.base);
      if (n !== "offline") tintOver(px, f.accent, acc);
      blit(prev, pw, px, FW, FH, col * cell, row * cell, S, bg);
    });
    row++;
  }
writeFileSync(join(HERE, "preview.png"), encodePng(pw, ph, prev));

// icon source: idle bot, teal accent, on a rounded dark-slate tile, 1024px
{
  const f = new Frame();
  drawBot(f, { eyes: "open" });
  const px = Buffer.from(f.base);
  tintOver(px, f.accent, [0x2d, 0xd4, 0xbf]);
  const N = 1024;
  const icon = Buffer.alloc(N * N * 4);
  const R = 200;
  const pad = 64;
  for (let y = pad; y < N - pad; y++)
    for (let x = pad; x < N - pad; x++) {
      const cx = Math.min(Math.max(x, pad + R), N - pad - R);
      const cy = Math.min(Math.max(y, pad + R), N - pad - R);
      if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
      const t = (y - pad) / (N - 2 * pad);
      const i = (y * N + x) * 4;
      icon[i] = Math.round(0x3a - 0x10 * t);
      icon[i + 1] = Math.round(0x40 - 0x10 * t);
      icon[i + 2] = Math.round(0x4f - 0x10 * t);
      icon[i + 3] = 255;
    }
  blit(icon, N, px, FW, FH, (N - FW * 26) / 2, (N - FH * 26) / 2 + 8, 26, null);
  writeFileSync(join(HERE, "icon-1024.png"), encodePng(N, N, icon));
}

console.log(`wrote ${names.length} states to ${OUT}`);
