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

import type { PetState } from "./events.ts";

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

/** The avatar from a state event, or null if missing/invalid (the Rust side validates too). */
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

// ---------- squash / stretch / lean (pixel-crisp warp) ----------

/**
 * Destination -> source index map for one axis of n pixels grown (delta > 0: duplicate) or shrunk
 * (delta < 0: drop) by |delta| lines spread evenly over the middle (lo..hi) of the axis. Every
 * destination pixel is a real source pixel, so the result stays on the pixel grid.
 */
export function axisMap(n: number, delta: number, lo = 0.15, hi = 0.85): number[] {
  const k = Math.min(Math.abs(Math.trunc(delta)), Math.floor(n * (hi - lo)));
  const picks = new Set<number>();
  for (let i = 0; i < k; i++) picks.add(Math.floor(n * lo + ((i + 0.5) * (hi - lo) * n) / k));
  const out: number[] = [];
  for (let s = 0; s < n; s++) {
    if (delta < 0 && picks.has(s)) continue;
    out.push(s);
    if (delta > 0 && picks.has(s)) out.push(s);
  }
  return out;
}

/** One 1:1 copy: source rect inside the frame -> destination offset from the warped box's top-left. */
export interface WarpBlock {
  sx: number;
  sy: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
}

export interface WarpPlan {
  width: number;
  height: number;
  /** x of the warped box relative to the unwarped frame's left edge (keeps it centred). */
  left: number;
  blocks: WarpBlock[];
}

/**
 * Squash/stretch and lean a square frame of size n without resampling: rows/columns are dropped
 * or duplicated (axisMap) and rows are sheared sideways (lean px at the top, 0 at the bottom).
 * The result is a handful of 1:1 drawImage blocks: nearest-neighbour, integer, crisp.
 * sx/sy: extra columns/rows (negative = fewer). lean: top-row offset in px (+ = right).
 */
export function warpPlan(n: number, sx: number, sy: number, lean: number): WarpPlan {
  const rows = axisMap(n, sy);
  const cols = axisMap(n, sx);
  const H = rows.length;
  const off = (j: number) => (H <= 1 ? 0 : Math.round((lean * (H - 1 - j)) / (H - 1)));
  // Column runs: consecutive destination columns whose source columns are consecutive.
  const colRuns: Array<{ d: number; s: number; w: number }> = [];
  cols.forEach((s, d) => {
    const last = colRuns[colRuns.length - 1];
    if (last && last.s + last.w === s && last.d + last.w === d) last.w++;
    else colRuns.push({ d, s, w: 1 });
  });
  const blocks: WarpBlock[] = [];
  let j = 0;
  while (j < H) {
    let h = 1;
    while (j + h < H && rows[j + h] === rows[j] + h && off(j + h) === off(j)) h++;
    for (const c of colRuns) blocks.push({ sx: c.s, sy: rows[j], w: c.w, h, dx: c.d + off(j), dy: j });
    j += h;
  }
  return { width: cols.length, height: H, left: Math.floor((cols.length - n) / 2) === 0 ? 0 : -Math.floor((cols.length - n) / 2), blocks };
}

// ---------- state cues ----------

export type AvatarAnim = PetState | "offline";

export type BadgeIcon = "bang" | "cross" | "check";

export type Overlay =
  /** Round status badge; `rays` adds a pulse of 4 short lines around it. */
  | { kind: "badge"; icon: BadgeIcon; x: number; y: number; bg: string; fg: string; rays: boolean }
  /** Thought cloud with three dots, `lit` of them dark (0..3). Box size: CLOUD. */
  | { kind: "cloud"; x: number; y: number; big: boolean; lit: number }
  /** Little thought-trail circle: (2r)x(2r) white inside a 1px ink ring; x,y = ring top-left. */
  | { kind: "puff"; x: number; y: number; r: 1 | 2 }
  /** A w x h block (working ring segments, confetti). ink: 1px dark outline for light desktops. */
  | { kind: "dot"; x: number; y: number; w: number; h: number; color: string; alpha: number; ink: boolean; behind: boolean }
  | { kind: "z"; x: number; y: number; size: 4 | 5; alpha: number }
  | { kind: "ball"; x: number; y: number; color: string; behind: boolean };

export interface Cue {
  face: FaceMode;
  /** Whole-body offset. */
  dx: number;
  dy: number;
  /** Squash/stretch: extra columns / rows (sy < 0 = squashed flatter, sy > 0 = stretched taller). */
  sx: number;
  sy: number;
  /** Tilt: top row shifted this many px (+ = right), bottom row fixed. */
  lean: number;
  overlays: Overlay[];
}

/**
 * Reduced motion (prefers-reduced-motion): the body holds still (no hop, squash, stretch, lean
 * or shake); the face and every overlay stay, so the state still reads from the cloud, ring,
 * balls, badges and z's.
 */
export function calmCue(c: Cue): Cue {
  return { ...c, dx: 0, dy: 0, sx: 0, sy: 0, lean: 0 };
}

/** How long the one-shot "done" celebration lasts on an avatar; then the pet settles to idle. */
export const AVATAR_DONE_MS = 1800;
export const BADGE = 11;
export const CLOUD = { big: { w: 19, h: 10 }, small: { w: 13, h: 7 } } as const;

const BADGE_COLORS: Record<BadgeIcon, { bg: string; fg: string }> = {
  bang: { bg: "#FFB020", fg: "#1A1300" },
  cross: { bg: "#E5484D", fg: "#FFFFFF" },
  check: { bg: "#30A46C", fg: "#FFFFFF" },
};
export const JUGGLE_COLORS = ["#FF5EA8", "#FFD23F", "#3FD7FF"];
/** Working ring: bright head, cyan tail, faint track. */
export const RING_HEAD = "#E8FCFF";
export const RING_TAIL = "#22D3EE";
export const RING_SAMPLES = 72;
/** Fraction of the ring the bright comet covers, and one revolution's duration. */
export const RING_ARC = 0.4;
export const RING_TURN_MS = 800;
export const CONFETTI_COLORS = ["#FF5EA8", "#FFD23F", "#3FD7FF", "#7CFF6B", "#B48CFF", "#FFFFFF"];

/** Pixel extent of an overlay (for bounds checks); rays are clipped by the canvas when drawn. */
export function overlayBox(o: Overlay): { x: number; y: number; w: number; h: number } {
  switch (o.kind) {
    case "badge":
      return { x: o.x - 1, y: o.y - 1, w: BADGE + 2, h: BADGE + 2 };
    case "cloud": {
      const c = o.big ? CLOUD.big : CLOUD.small;
      return { x: o.x, y: o.y, w: c.w, h: c.h };
    }
    case "puff":
      return { x: o.x, y: o.y, w: 2 * o.r + 2, h: 2 * o.r + 2 };
    case "dot":
      return o.ink ? { x: o.x - 1, y: o.y - 1, w: o.w + 2, h: o.h + 2 } : { x: o.x, y: o.y, w: o.w, h: o.h };
    case "z":
      return { x: o.x, y: o.y, w: o.size + 1, h: o.size + 1 };
    case "ball":
      return { x: o.x - 1, y: o.y - 1, w: 5, h: 5 };
  }
}

interface Pose {
  dy: number;
  sx: number;
  sy: number;
}

/**
 * The working hop, one entry per 60 ms: anticipation squash, stretched launch, hang, stretched
 * fall, landing squash, then a short rest. dy is a fraction of the jump height; sy in squash units.
 */
const WORK_HOP: Array<[number, number]> = [
  [0, -1], [0, -0.67], [-0.3, 1], [-0.7, 0.67], [-0.9, 0.33], [-1, 0], [-1, 0], [-0.85, 0], [-0.55, 0.33],
  [-0.2, 0.67], [0, -1], [0, -0.33], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0],
];
export const WORK_STEP_MS = 60;
export const WORK_CYCLE_MS = WORK_HOP.length * WORK_STEP_MS;

function pose(dyFrac: number, sqFrac: number, jump: number, squash: number): Pose {
  const sy = Math.round(sqFrac * squash);
  return { dy: Math.round(dyFrac * jump), sy, sx: -Math.round((sy * 2) / 3) };
}

/**
 * Motion and overlays for a state, `t` ms after the state began. Coordinates are canvas pixels
 * (geometry `g`); every value is an integer so the art stays on the pixel grid.
 */
export function avatarCue(state: AvatarAnim, t: number, g: AvatarGeometry): Cue {
  const step = (fps: number, n: number) => Math.floor((t * fps) / 1000) % n;
  const big = g.art >= 30;
  const top = g.ay;
  const right = g.ax + g.art;
  const squash = big ? 3 : 2;
  const cue = (face: FaceMode, p: Partial<Omit<Cue, "face">> = {}): Cue => ({
    face,
    dx: p.dx ?? 0,
    dy: p.dy ?? 0,
    sx: p.sx ?? 0,
    sy: p.sy ?? 0,
    lean: p.lean ?? 0,
    overlays: p.overlays ?? [],
  });
  // Badge sits on the art's top-right corner, inside the canvas.
  const bx = Math.min(g.backing - BADGE - 1, right - BADGE + 3);
  const badge = (icon: BadgeIcon, dy = 0, rays = false): Overlay => ({
    kind: "badge",
    icon,
    x: bx,
    y: Math.max(1, top - 2 + dy),
    ...BADGE_COLORS[icon],
    rays,
  });
  switch (state) {
    case "idle":
      // Slow breathing: 1px up for half of every 2.4s.
      return cue("idle", { dy: t % 2400 < 1200 ? 0 : -1 });
    case "sleeping": {
      const k = t % 2400;
      const rise = Math.floor(k / 300); // 0..7
      const zx = Math.min(g.backing - 6, right - 4);
      return cue("sleeping", {
        dy: t % 3200 < 1600 ? 0 : 1,
        overlays: [
          { kind: "z", x: zx, y: Math.max(0, top + 4 - rise), size: 4, alpha: rise < 6 ? 1 : 0.5 },
          ...(rise >= 3 ? [{ kind: "z" as const, x: Math.min(g.backing - 6, zx + 1), y: Math.max(0, top - rise + 1), size: 5 as const, alpha: rise < 7 ? 1 : 0.5 }] : []),
        ],
      });
    }
    case "thinking": {
      // Still and pensive: leans back toward a thought cloud, eyes up, dots filling in.
      const c = big ? CLOUD.big : CLOUD.small;
      const cx = g.backing - c.w;
      const cy = 0;
      // Trail of two little circles down the right edge, from the shoulder up to the cloud.
      const pr = big ? 2 : 1;
      const puffBig: Overlay = { kind: "puff", x: g.backing - 2 * pr - 2, y: cy + c.h + 1, r: pr };
      const puffSmall: Overlay = { kind: "puff", x: g.backing - 5, y: cy + c.h + 2 * pr + 4, r: 1 };
      return cue("thinking", {
        dy: t % 3000 < 1500 ? -1 : 0,
        lean: big ? (t % 3000 < 1500 ? 2 : 1) : 1,
        overlays: [puffSmall, puffBig, { kind: "cloud", x: cx, y: cy, big, lit: step(2.5, 4) }],
      });
    }
    case "working": {
      // Busy: a squash-and-stretch hop with a ring spinning around the waist.
      const jump = Math.max(2, Math.min(Math.round(g.art * 0.19), g.ay - squash));
      const hop = WORK_HOP[Math.floor(t / WORK_STEP_MS) % WORK_HOP.length];
      const p = pose(hop[0], hop[1], jump, squash);
      return cue("working", { ...p, overlays: workRing(g, t, p, big) });
    }
    case "juggling": {
      // Several things at once: three balls in a high shower arc over the head, body swaying.
      const dx = [0, -1, 0, 1][Math.floor(t / 250) % 4];
      return cue("juggling", { dx, dy: [0, -1][step(4, 2)], overlays: juggleBalls(g, t) });
    }
    case "needs_you": {
      // Two hops with landing squash, then an impatient wiggle; the badge pulses.
      const k = t % 1600;
      let p: Pose = { dy: 0, sx: 0, sy: 0 };
      let lean = 0;
      if (k < 640) {
        const i = Math.floor(k / 80);
        const dy = [0, -2, -4, -2, 0, -2, -3, -1][i];
        const sy = [0, 1, 0, 1, -squash, 1, 0, -1][i];
        p = { dy, sy, sx: -Math.round((sy * 2) / 3) };
      } else if (k < 1120) lean = (Math.floor((k - 640) / 120) % 2 ? 1 : -1) * (big ? 2 : 1);
      return cue("needs_you", { ...p, lean, overlays: [badge("bang", p.dy, t % 600 < 300)] });
    }
    case "error": {
      // Deflated (squashed flat), shudders now and then; red cross badge.
      const k = t % 1800;
      const a = big ? 2 : 1;
      const dx = k < 480 ? [-a, a, -a, a, -1, 1][Math.floor(k / 80)] : 0;
      return cue("error", { dx, sy: -(squash - 1), sx: 1, lean: 0, overlays: [badge("cross")] });
    }
    case "done":
      return doneCue(g, t, squash, badge);
    case "offline":
      return cue("offline");
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * The spinning working ring: a tilted ellipse round the waist (an orbit), a faint 1px track plus a
 * thick outlined comet arc chasing round it. Front half in front of the body, back half behind.
 */
function workRing(g: AvatarGeometry, t: number, p: Pose, big: boolean): Overlay[] {
  const size = big ? 2 : 1;
  const cx = g.ax + g.art / 2;
  const bottom = g.ay + g.art + p.dy;
  const cy = bottom - Math.round((g.art + p.sy) * 0.42);
  const rx = Math.min(g.art / 2 + 5, g.backing / 2 - size);
  const ry = Math.max(2, Math.round(g.art / 7));
  const tilt = -0.18; // y shift per x: the orbit is tipped, right side up
  const TAU = Math.PI * 2;
  const head = ((t / RING_TURN_MS) * TAU) % TAU;
  const seen = new Set<string>();
  const track: Overlay[] = [];
  const front: Overlay[] = [];
  for (let i = 0; i < RING_SAMPLES; i++) {
    const ang = (i / RING_SAMPLES) * TAU;
    const lag = (head - ang + TAU) % TAU;
    const lit = lag < RING_ARC * TAU;
    const s = lit ? size : 1;
    const ox = Math.cos(ang) * rx;
    const x = clampInt(cx + ox - s / 2, 1, g.backing - s - 1);
    const y = clampInt(cy + Math.sin(ang) * ry + ox * tilt - s / 2, 1, g.backing - s - 1);
    const key = `${x},${y},${s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dot: Overlay = {
      kind: "dot",
      x,
      y,
      w: s,
      h: s,
      color: lag < 0.07 * TAU ? RING_HEAD : RING_TAIL,
      alpha: lit ? Math.max(0.55, 1 - lag / (RING_ARC * TAU) / 2) : 0.45,
      ink: lit,
      behind: Math.sin(ang) < 0,
    };
    (lit ? front : track).push(dot);
  }
  // Track first so the comet (and its outline) always sits on top of it.
  return [...track, ...front];
}

/** Shower juggle: up from the right hand, over the head, caught left, passed back low behind. */
function juggleBalls(g: AvatarGeometry, t: number): Overlay[] {
  const P = 1500;
  const L = g.ax + 2;
  const R = g.ax + g.art - 5;
  const hy = g.ay + Math.round(g.art * 0.62);
  const peak = 1;
  return JUGGLE_COLORS.map((color, i) => {
    const u = (((t + (i * P) / 3) % P) + P) % P / P;
    if (u < 0.72) {
      const s = u / 0.72;
      return { kind: "ball" as const, x: Math.round(R + (L - R) * s), y: Math.round(hy - (hy - peak) * 4 * s * (1 - s)), color, behind: false };
    }
    const s = (u - 0.72) / 0.28;
    return { kind: "ball" as const, x: Math.round(L + (R - L) * s), y: hy + 2, color, behind: true };
  });
}

/** Done: crouch, big stretched leap with a confetti burst, landing squash, a little hop, settle. */
function doneCue(g: AvatarGeometry, t: number, squash: number, badge: (icon: BadgeIcon, dy?: number, rays?: boolean) => Overlay): Cue {
  const jump = Math.max(2, Math.min(Math.round(g.art * 0.24), g.ay - 1));
  let p: Pose = { dy: 0, sx: 0, sy: 0 };
  if (t < 120) p = pose(0, -1, jump, squash);
  else if (t < 600) {
    const f = [[-0.3, 1], [-0.65, 0.67], [-0.9, 0.33], [-1, 0], [-1, 0], [-0.9, 0], [-0.65, 0.33], [-0.3, 0.67]][Math.floor((t - 120) / 60)];
    p = pose(f[0], f[1], jump, squash);
  } else if (t < 720) p = pose(0, -1, jump, squash);
  else if (t < 1000) p = { dy: [-1, -2, -1, 0][Math.floor((t - 720) / 70)], sx: 0, sy: 0 };
  const overlays: Overlay[] = [];
  if (t >= 120 && t < 1500) {
    // Burst from just above the head; deterministic fan, falling under gravity.
    const ox = g.ax + g.art / 2;
    const oy = g.ay + 2;
    const k = t - 120;
    const u = g.art / 38;
    const n = 18;
    for (let i = 0; i < n; i++) {
      const ang = Math.PI * (1.06 + (0.88 * i) / (n - 1)); // upward fan, left to right
      const v = u * (0.026 + (0.02 * ((i * 7) % 5)) / 4);
      const x = Math.round(ox + Math.cos(ang) * v * k);
      const y = Math.round(oy + Math.sin(ang) * v * k + 0.5 * 0.00008 * u * k * k);
      const flip = (Math.floor(k / 90) + i) % 2 === 0;
      const w = u >= 0.75 ? 2 : 1;
      const h = flip ? w : 1;
      if (x < 0 || y < 0 || x + w > g.backing || y + h > g.backing) continue;
      overlays.push({ kind: "dot", x, y, w, h, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], alpha: k < 1000 ? 1 : 0.6, ink: false, behind: false });
    }
  }
  if (t >= 120) overlays.push(badge("check", p.dy, t < 900 && t % 300 < 200));
  return { face: "done", dx: 0, dy: p.dy, sx: p.sx, sy: p.sy, lean: 0, overlays };
}

/** 7x7 badge icons ('#' = foreground). */
export const ICONS: Record<BadgeIcon, string[]> = {
  bang: ["...#...", "...#...", "...#...", "...#...", ".......", "...#...", "......."],
  cross: [".......", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "......."],
  check: [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
};

/**
 * Thought-cloud fills ('#'); the drawer adds a 1px ink outline around them, so the boxes are
 * CLOUD.big (17x8 fill -> 19x10) and CLOUD.small (11x5 -> 13x7). Dots: [x, y, size] inside the fill.
 */
export const CLOUD_FILL = {
  big: ["....###...###....", "..#######.#####..", ".###############.", "#################", "#################", "#################", ".###############.", "...#####.#####..."],
  small: ["..###.####.", "###########", "###########", "###########", ".#########."],
} as const;
export const CLOUD_DOTS = {
  big: [[3, 3, 3], [7, 3, 3], [11, 3, 3]],
  small: [[2, 2, 1], [5, 2, 1], [8, 2, 1]],
} as const;

/** 4x4 and 5x5 "z" glyphs. */
export const Z_GLYPH: Record<4 | 5, string[]> = {
  4: ["####", "..#.", ".#..", "####"],
  5: ["#####", "...#.", "..#..", ".#...", "#####"],
};
