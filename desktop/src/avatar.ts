// Grok Bot profile avatars on the desk pet. Pure logic only (no DOM): unit-tested with node:test
// in test/avatar.test.ts. The DOM side (image loading, canvases) is in avatar-bank.ts.
//
// Art: the face strips the Grok Bot app ships for its menu bar (bot-<shape>-face[@2x].png), copied
// at build time by scripts/import-grokbot-art.mjs into public/grokbot-art/ (gitignored). Each strip
// is N square frames of black template art with transparent eyes. We tint the shape with the bot's
// avatar colour (as the app does), fill the eye holes and add a 1px outline so it reads on any
// desktop. Everything is drawn nearest-neighbour at an integer scale.
//
// When the art is absent the pet falls back to the original robot, accented in the avatar colour.

import type { PetState } from "./relay.ts";

export const AVATAR_SHAPES = [
  "arch", "bean", "blob", "capsule", "cloud", "clover", "crystal", "cylinder", "dome", "egg", "flower", "gem", "heart",
  "hex", "house", "leaf", "pebble", "pumpkin", "shield", "sparkle", "square", "squircle", "star", "tablet", "teardrop",
  "wedge",
] as const;
export const AVATAR_COLORS = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];
export interface Avatar {
  shape: AvatarShape;
  color: AvatarColor;
}

/** The avatar from a relay event, or null if missing/invalid (the relay validates too). */
export function parseAvatar(v: unknown): Avatar | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const { shape, color } = v as Record<string, unknown>;
  if (typeof shape !== "string" || typeof color !== "string") return null;
  const s = shape.toLowerCase();
  const c = color.toLowerCase();
  if (!(AVATAR_SHAPES as readonly string[]).includes(s) || !(AVATAR_COLORS as readonly string[]).includes(c)) return null;
  return { shape: s as AvatarShape, color: c as AvatarColor };
}

/**
 * Our own approximations, used ONLY when the imported palette is missing (no Grok Bot app at
 * build time). The real values come from the app via grokbot-art/manifest.json.
 */
export const FALLBACK_COLORS: Record<AvatarColor, string> = {
  black: "#111111",
  brown: "#8B5A2B",
  red: "#E5383B",
  orange: "#F0883E",
  yellow: "#F5A623",
  green: "#2FBF71",
  cyan: "#14B8A6",
  blue: "#3B82F6",
  violet: "#8B5CF6",
  magenta: "#EC4899",
  gray: "#808080",
};

export type Palette = Partial<Record<string, string>>;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function colorHex(color: AvatarColor, palette: Palette | null): string {
  const p = palette?.[color];
  return p && HEX_RE.test(p) ? p.toUpperCase() : FALLBACK_COLORS[color];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = HEX_RE.test(hex) ? hex : "#000000";
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** WCAG relative luminance, 0..1. */
export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Accent for UI chrome (name dot, toast edge, fallback robot). A black avatar would vanish on
 * the dark robot and dark toasts, so it gets near-white, like the app's dark theme does.
 */
export function accentHex(color: AvatarColor, palette: Palette | null): string {
  return color === "black" ? "#F2F2F2" : colorHex(color, palette);
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Eye fill and outline for a body colour: dark bodies get a light outline, light ones a dark one. */
export function avatarStyle(hex: string): { body: [number, number, number]; eye: Rgba; outline: Rgba } {
  const dark = luminance(hex) < 0.18;
  return {
    body: hexToRgb(hex),
    eye: { r: 255, g: 255, b: 255, a: 255 },
    outline: dark ? { r: 236, g: 236, b: 240, a: 235 } : { r: 12, g: 12, b: 16, a: 150 },
  };
}

// ---------- strip processing ----------

/** Pixels at least this opaque are walls for the eye flood fill. */
const WALL = 128 / 255;

/**
 * Tint a template strip (N square frames, black + alpha) into an RGBA strip with frames padded by
 * 1px on every side: body = colour * alpha, eye holes (transparent pixels enclosed by the shape)
 * filled with the eye colour, and a 1px outline ring behind the silhouette.
 */
export function processStrip(
  src: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  hex: string,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number; frames: number; frameSize: number } {
  const fs = height;
  const frames = Math.floor(width / fs);
  const os = fs + 2;
  const outW = os * frames;
  const out = new Uint8ClampedArray(outW * os * 4);
  const st = avatarStyle(hex);
  const a = new Float32Array(os * os); // padded alpha of one frame, 0..1
  const outside = new Uint8Array(os * os);
  const stack: number[] = [];
  for (let f = 0; f < frames; f++) {
    a.fill(0);
    for (let y = 0; y < fs; y++)
      for (let x = 0; x < fs; x++) a[(y + 1) * os + x + 1] = src[(y * width + f * fs + x) * 4 + 3] / 255;
    // Flood the not-solid region from the padded border: whatever it doesn't reach is an eye.
    outside.fill(0);
    stack.length = 0;
    for (let i = 0; i < os; i++) stack.push(i, (os - 1) * os + i, i * os, i * os + os - 1);
    while (stack.length) {
      const p = stack.pop()!;
      if (outside[p] || a[p] >= WALL) continue;
      outside[p] = 1;
      const x = p % os;
      const y = (p - x) / os;
      if (x > 0) stack.push(p - 1);
      if (x < os - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - os);
      if (y < os - 1) stack.push(p + os);
    }
    for (let y = 0; y < os; y++) {
      for (let x = 0; x < os; x++) {
        const p = y * os + x;
        const o = (y * outW + f * os + x) * 4;
        let r: number, g: number, b: number, al: number;
        // Eye: a see-through pixel the flood didn't reach, or the anti-aliased rim touching one.
        const hole = (q: number) => !outside[q] && a[q] < WALL;
        const eye =
          !outside[p] &&
          (hole(p) || (x > 0 && hole(p - 1)) || (x < os - 1 && hole(p + 1)) || (y > 0 && hole(p - os)) || (y < os - 1 && hole(p + os)));
        if (eye) {
          // Inside: body over eye colour (anti-aliased eye edges blend), fully opaque.
          const k = a[p];
          r = st.body[0] * k + st.eye.r * (1 - k);
          g = st.body[1] * k + st.eye.g * (1 - k);
          b = st.body[2] * k + st.eye.b * (1 - k);
          al = 1;
        } else {
          // Outside: body over a 1px outline (dilated silhouette).
          let d = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < os && yy < os) d = Math.max(d, a[yy * os + xx]);
            }
          const ol = d >= 0.35 ? st.outline.a / 255 : 0;
          const k = a[p];
          al = k + ol * (1 - k);
          if (al <= 0) continue;
          r = (st.body[0] * k + st.outline.r * ol * (1 - k)) / al;
          g = (st.body[1] * k + st.outline.g * ol * (1 - k)) / al;
          b = (st.body[2] * k + st.outline.b * ol * (1 - k)) / al;
        }
        out[o] = Math.round(r);
        out[o + 1] = Math.round(g);
        out[o + 2] = Math.round(b);
        out[o + 3] = Math.round(al * 255);
      }
    }
  }
  return { data: out, width: outW, height: os, frames, frameSize: os };
}

// ---------- face frames (the app's tray face table) ----------
// Frame order inside every strip (29 frames):
//   0 rest | 1-4 blink closing (2 half, 4 closed) | 5-7 blink opening (7 overshoot)
//   8-14 glance left (3 in, hold, 3 out) | 15-21 glance right | 22-28 glance up
export const FACE = {
  rest: 0,
  blinkClose: [1, 2, 3, 4],
  blinkHalf: 2,
  blinkClosed: 4,
  blinkOpen: [5, 6, 7],
  overshoot: 7,
  glance: {
    left: { in: [8, 9, 10], hold: 11, out: [12, 13, 14] },
    right: { in: [15, 16, 17], hold: 18, out: [19, 20, 21] },
    up: { in: [22, 23, 24], hold: 25, out: [26, 27, 28] },
  },
} as const;
export const FACE_FRAMES = 29;

export interface FaceStep {
  slot: number;
  holdMs: number;
}

type Range = { min: number; max: number };
const pick = (rnd: () => number, r: Range) => Math.round(r.min + (r.max - r.min) * rnd());

/** The Grok Bot app's own idle cadence (values from its tray face scheduler). */
export const IDLE_TIMING = {
  blinkChance: 0.5, // otherwise a glance
  doubleBlinkChance: 0.14,
  restBeforeBlink: { min: 2800, max: 5500 },
  restBeforeGlance: { min: 1800, max: 3200 },
  glanceHold: { min: 500, max: 900 },
  closeMs: 18,
  closedMs: 35,
  openMs: 75,
  glanceStepMs: 45,
  settleMs: 50,
};

function blink(t = IDLE_TIMING): FaceStep[] {
  const s: FaceStep[] = FACE.blinkClose.map((slot) => ({ slot, holdMs: slot === FACE.blinkClosed ? t.closedMs : t.closeMs }));
  for (const slot of FACE.blinkOpen) s.push({ slot, holdMs: t.openMs });
  s.push({ slot: FACE.rest, holdMs: t.settleMs });
  return s;
}

function glance(dir: "left" | "right" | "up", hold: number, t = IDLE_TIMING): FaceStep[] {
  const g = FACE.glance[dir];
  return [
    ...g.in.map((slot) => ({ slot, holdMs: t.glanceStepMs })),
    { slot: g.hold, holdMs: hold },
    ...g.out.map((slot) => ({ slot, holdMs: t.glanceStepMs })),
    { slot: FACE.rest, holdMs: t.settleMs },
  ];
}

export type FaceMode = "idle" | "thinking" | "working" | "juggling" | "needs_you" | "error" | "done" | "sleeping" | "offline";

/** One round of face animation for a mode. Loops forever by asking for the next round. */
export function faceRound(mode: FaceMode, rnd: () => number): FaceStep[] {
  const t = IDLE_TIMING;
  switch (mode) {
    case "idle": {
      if (rnd() < t.blinkChance) {
        const s: FaceStep[] = [{ slot: FACE.rest, holdMs: pick(rnd, t.restBeforeBlink) }, ...blink()];
        if (rnd() < t.doubleBlinkChance) s.push(...blink());
        return s;
      }
      const dirs = ["left", "right", "up"] as const;
      const dir = dirs[Math.min(2, Math.floor(rnd() * 3))];
      return [{ slot: FACE.rest, holdMs: pick(rnd, t.restBeforeGlance) }, ...glance(dir, pick(rnd, t.glanceHold))];
    }
    case "thinking": {
      // Looks up and ponders, now and then glancing aside.
      const s: FaceStep[] = glance("up", pick(rnd, { min: 1600, max: 2600 }));
      s[s.length - 1] = { slot: FACE.rest, holdMs: pick(rnd, { min: 250, max: 600 }) };
      if (rnd() < 0.35) s.push(...blink());
      return s;
    }
    case "working":
      // Reading: eyes sweep left and right.
      return [...glance("left", pick(rnd, { min: 350, max: 650 })), ...glance("right", pick(rnd, { min: 350, max: 650 }))];
    case "juggling":
      return [...glance("left", 160), ...glance("up", 160), ...glance("right", 160), ...glance("up", 160)];
    case "needs_you":
      // Looking at you, blinking expectantly.
      return [{ slot: FACE.rest, holdMs: pick(rnd, { min: 700, max: 1200 }) }, ...blink(), ...blink()];
    case "error":
      return [{ slot: FACE.blinkHalf, holdMs: 900 }, { slot: FACE.blinkClosed, holdMs: 120 }, { slot: FACE.blinkHalf, holdMs: 400 }];
    case "done":
      return [{ slot: FACE.overshoot, holdMs: 700 }, ...blink()];
    case "sleeping":
      return [{ slot: FACE.blinkClosed, holdMs: 60_000 }];
    case "offline":
      return [{ slot: FACE.blinkHalf, holdMs: 60_000 }];
  }
}

/** Plays face rounds against wall-clock time. A mode change restarts at the new mode's round. */
export class FacePlayer {
  private mode: FaceMode | null = null;
  private steps: FaceStep[] = [];
  private i = 0;
  private until = 0;
  private readonly rnd: () => number;
  constructor(rnd: () => number = Math.random) {
    this.rnd = rnd;
  }

  frameAt(mode: FaceMode, now: number): number {
    if (mode !== this.mode) {
      this.mode = mode;
      this.steps = [];
      this.i = 0;
      this.until = now;
    }
    // Catch up (a hidden window can skip many steps); bounded so a huge gap can't spin.
    for (let guard = 0; now >= this.until && guard < 512; guard++) {
      if (this.i >= this.steps.length - 1 || this.steps.length === 0) {
        this.steps = faceRound(mode, this.rnd);
        this.i = 0;
      } else this.i++;
      this.until += Math.max(1, this.steps[this.i].holdMs);
      if (now - this.until > 120_000) this.until = now; // long sleep: don't replay hours
    }
    return this.steps[this.i]?.slot ?? FACE.rest;
  }
}

// ---------- geometry ----------

export interface AvatarGeometry {
  /** Canvas backing size (square), in art pixels. */
  backing: number;
  /** CSS px per art pixel (integer). backing * cssPx === spriteSize. */
  cssPx: number;
  /** Which strip resolution to draw. */
  res: "2x" | "1x";
  /** Processed frame size (strip frame + 1px outline each side). */
  art: number;
  /** Top-left of the art at rest. */
  ax: number;
  ay: number;
}

/**
 * Pick strip resolution and integer scale for a sprite box (spriteSize = 32 * layout scale, see
 * layout.ts). Large (96): @2x at 2 CSS px. Small (64): @2x at 1 CSS px. Tiny (32): @1x.
 */
export function avatarGeometry(spriteSize: number, frame2x = 36, frame1x = 18): AvatarGeometry {
  const pad = 2;
  for (const [res, fs] of [["2x", frame2x], ["1x", frame1x]] as const) {
    const art = fs + pad;
    for (let cssPx = Math.floor(spriteSize / art); cssPx >= 1; cssPx--) {
      if (spriteSize % cssPx !== 0) continue;
      const backing = spriteSize / cssPx;
      // Room for a 4px hop above and badges around the art.
      if (backing < art + 6) continue;
      const ax = Math.floor((backing - art) / 2);
      const ay = backing - art - 1;
      return { backing, cssPx, res, art, ax, ay };
    }
  }
  const art = frame1x + pad;
  return { backing: spriteSize, cssPx: 1, res: "1x", art, ax: Math.floor((spriteSize - art) / 2), ay: Math.max(0, spriteSize - art - 1) };
}

// ---------- state cues ----------

export type AvatarAnim = PetState | "offline";

export type Overlay =
  | { kind: "badge"; icon: "bang" | "cross" | "check" | "spinner"; x: number; y: number; bg: string; fg: string; phase: number }
  | { kind: "dots"; x: number; y: number; n: number }
  | { kind: "z"; x: number; y: number; size: 4 | 5; alpha: number }
  | { kind: "ball"; x: number; y: number; color: string; behind: boolean }
  | { kind: "spark"; x: number; y: number; r: number; color: string };

export interface Cue {
  face: FaceMode;
  dx: number;
  dy: number;
  overlays: Overlay[];
}

/** How long the one-shot "done" celebration lasts on an avatar. */
export const AVATAR_DONE_MS = 1400;
export const BADGE = 11;

const BADGE_COLORS = {
  bang: { bg: "#FFB020", fg: "#1A1300" },
  cross: { bg: "#E5484D", fg: "#FFFFFF" },
  check: { bg: "#30A46C", fg: "#FFFFFF" },
  spinner: { bg: "#2F6FEB", fg: "#FFFFFF" },
};
export const JUGGLE_COLORS = ["#FF5EA8", "#FFD23F", "#3FD7FF"];

/**
 * Motion and overlays for a state, `t` ms after the state began. Coordinates are canvas pixels
 * (geometry `g`); every value is an integer so the art stays on the pixel grid.
 */
export function avatarCue(state: AvatarAnim, t: number, g: AvatarGeometry): Cue {
  const step = (fps: number, n: number) => Math.floor((t * fps) / 1000) % n;
  const top = g.ay;
  const right = g.ax + g.art;
  // Badge sits on the art's top-right corner, inside the canvas.
  const bx = Math.min(g.backing - BADGE, right - BADGE + 3);
  const badge = (icon: keyof typeof BADGE_COLORS, dy = 0): Overlay => ({
    kind: "badge",
    icon,
    x: bx,
    y: Math.max(0, top - 2 + dy),
    ...BADGE_COLORS[icon],
    phase: step(10, 8),
  });
  switch (state) {
    case "idle": {
      // Slow breathing: 1px up for half of every 2.4s.
      return { face: "idle", dx: 0, dy: t % 2400 < 1200 ? 0 : -1, overlays: [] };
    }
    case "sleeping": {
      const k = t % 2400;
      const rise = Math.floor(k / 300); // 0..7
      const zx = Math.min(g.backing - 6, right - 4);
      return {
        face: "sleeping",
        dx: 0,
        dy: t % 3200 < 1600 ? 0 : 1,
        overlays: [
          { kind: "z", x: zx, y: Math.max(0, top + 4 - rise), size: 4, alpha: rise < 6 ? 1 : 0.5 },
          ...(rise >= 3 ? [{ kind: "z" as const, x: Math.min(g.backing - 6, zx + 1), y: Math.max(0, top - rise + 1), size: 5 as const, alpha: rise < 7 ? 1 : 0.5 }] : []),
        ],
      };
    }
    case "thinking":
      return {
        face: "thinking",
        dx: 0,
        dy: -1,
        overlays: [{ kind: "dots", x: Math.min(g.backing - 13, right - 9), y: Math.max(0, top - 2), n: 1 + step(3, 3) }],
      };
    case "working":
      return { face: "working", dx: 0, dy: [0, -1, -2, -1][step(8, 4)], overlays: [badge("spinner")] };
    case "juggling": {
      const cx = g.ax + g.art / 2;
      const cy = g.ay + g.art / 2;
      const rx = Math.min(g.art / 2 + 2, g.backing / 2 - 2);
      const ry = Math.max(3, Math.round(g.art / 4));
      const overlays: Overlay[] = JUGGLE_COLORS.map((color, i) => {
        const ang = (t / 900) * Math.PI * 2 + (i * Math.PI * 2) / 3;
        return {
          kind: "ball" as const,
          x: Math.round(cx + Math.cos(ang) * rx) - 1,
          y: Math.round(cy - ry - 2 + Math.sin(ang) * ry) - 1,
          color,
          behind: Math.sin(ang) < 0,
        };
      });
      return { face: "juggling", dx: 0, dy: [0, -1][step(6, 2)], overlays };
    }
    case "needs_you": {
      // Bounce twice, pause; the badge blinks.
      const k = t % 1400;
      const hop = k < 640 ? [0, -2, -4, -2, 0, -2, -3, -1][Math.floor(k / 80)] : 0;
      return { face: "needs_you", dx: 0, dy: hop, overlays: t % 800 < 560 ? [badge("bang", hop)] : [] };
    }
    case "error": {
      const k = t % 1600;
      const dx = k < 480 ? [-1, 1, -1, 1, -1, 1][Math.floor(k / 80)] : 0;
      return { face: "error", dx, dy: 0, overlays: [badge("cross")] };
    }
    case "done": {
      const hop = t < 480 ? [0, -2, -4, -5, -4, -2][Math.floor(t / 80)] : 0;
      const sparks: Overlay[] = [];
      if (t < 1000) {
        const r = 1 + Math.floor(t / 250); // 1..4
        const cx = g.ax + Math.floor(g.art / 2);
        const cy = g.ay + Math.floor(g.art / 2) + hop;
        const d = Math.round(g.art * 0.36) + r;
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          sparks.push({ kind: "spark", x: clampInt(cx + sx * d, 2, g.backing - 3), y: clampInt(cy + sy * d, 2, g.backing - 3), r: t < 750 ? 2 : 1, color: "#FFE066" });
        }
      }
      return { face: "done", dx: 0, dy: hop, overlays: [...sparks, badge("check", hop)] };
    }
    case "offline":
      return { face: "offline", dx: 0, dy: 0, overlays: [] };
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** 7x7 badge icons ('#' = foreground). */
export const ICONS: Record<"bang" | "cross" | "check", string[]> = {
  bang: ["...#...", "...#...", "...#...", "...#...", ".......", "...#...", "......."],
  cross: [".......", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "......."],
  check: [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
};

/** 8 spinner dot positions on a radius-3 ring inside the 7x7 icon box; dot `phase` is brightest. */
export const SPINNER_DOTS: Array<[number, number]> = [
  [3, 0], [5, 1], [6, 3], [5, 5], [3, 6], [1, 5], [0, 3], [1, 1],
];

/** 4x4 and 5x5 "z" glyphs. */
export const Z_GLYPH: Record<4 | 5, string[]> = {
  4: ["####", "..#.", ".#..", "####"],
  5: ["#####", "...#.", "..#..", ".#...", "#####"],
};
