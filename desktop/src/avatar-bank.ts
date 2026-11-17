// DOM side of Grok Bot avatars: loads the art (in the app: copied at runtime from the user's own
// Grok Bot by src-tauri/src/grokbot_art.rs and fetched over IPC; in the browser preview:
// public/grokbot-art/ from scripts/import-grokbot-art.mjs), turns strips into tinted canvases
// (cached per shape/res/colour) and draws a frame plus its state-cue overlays. All pure logic
// lives in avatar.ts.
import {
  BADGE,
  CLOUD_DOTS,
  CLOUD_FILL,
  ICONS,
  processStrip,
  warpPlan,
  Z_GLYPH,
  type AvatarGeometry,
  type AvatarShape,
  type Cue,
  type Overlay,
  type Palette,
} from "./avatar.ts";

import { inTauri, invokeCmd } from "./platform.ts";

interface StripInfo {
  file: string;
  frameSize: number;
  frames: number;
}

export interface ArtManifest {
  version: number;
  appVersion: string | null;
  shapes: Partial<Record<AvatarShape, { "2x"?: StripInfo; "1x"?: StripInfo }>>;
  palette: { source: string; file: string; colors: Palette } | null;
}

export interface Strip {
  canvas: HTMLCanvasElement;
  frameSize: number;
  frames: number;
}

/** "pending" while an image loads; null when the art isn't available (use the robot). */
export type StripResult = Strip | "pending" | null;

/** Where the art comes from: the manifest, and a loadable URL for one strip file. */
export interface ArtSource {
  manifest(): Promise<unknown>;
  imageUrl(file: string): Promise<string | null>;
}

/** The app: Rust copies the art from the user's Grok Bot and hands it over IPC. */
export const ipcSource: ArtSource = {
  manifest: () => invokeCmd<unknown>("grokbot_art_manifest"),
  async imageUrl(file) {
    const bytes = await invokeCmd<ArrayBuffer>("grokbot_art_file", { name: file });
    // A blob: URL is same-origin, so the strip can be read back for tinting.
    return bytes ? URL.createObjectURL(new Blob([bytes], { type: "image/png" })) : null;
  },
};

/** The browser preview: files under a URL (public/grokbot-art/ via vite). */
export function urlSource(root: string): ArtSource {
  return {
    manifest: async () => {
      const r = await fetch(`${root}manifest.json`, { cache: "no-store" });
      return r.ok ? r.json() : null;
    },
    imageUrl: async (file) => root + file,
  };
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** A tinted strip's pixels, kept in JS memory: canvases can lose theirs, these can't. */
interface Processed {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  frameSize: number;
  frames: number;
}

export class AvatarBank {
  manifest: ArtManifest | null = null;
  private source: ArtSource = inTauri ? ipcSource : urlSource("grokbot-art/");
  private images = new Map<string, HTMLImageElement | null | "pending">();
  private processed = new Map<string, Processed>();
  private strips = new Map<string, Strip>();
  /** Bumped on every load, so a strip that finishes loading for an older manifest is ignored. */
  private generation = 0;

  /** Never throws: no art just means every bot uses the robot. Call again when the art changes. */
  async load(source: ArtSource = this.source): Promise<void> {
    this.source = source;
    const gen = ++this.generation;
    let m: ArtManifest | null = null;
    try {
      const v = (await source.manifest()) as ArtManifest | null;
      if (v && typeof v === "object" && v.shapes && typeof v.shapes === "object") m = v;
    } catch {
      m = null;
    }
    if (gen !== this.generation) return;
    this.manifest = m;
    this.images.clear();
    this.processed.clear();
    this.strips.clear();
  }

  /**
   * Drop the tinted canvases (rebuilt from the kept pixels on next use). WebKit can discard a
   * canvas's pixels while a window is hidden or after sleep, silently; an avatar drawn from such
   * a canvas would be invisible, leaving only its name tag.
   */
  invalidate(): void {
    this.strips.clear();
  }

  get palette(): Palette | null {
    return this.manifest?.palette?.colors ?? null;
  }

  has(shape: AvatarShape): boolean {
    const s = this.manifest?.shapes[shape];
    return !!(s && (s["2x"] || s["1x"]));
  }

  /** Processed strip for (shape, res, colour). Starts loading on first ask. */
  strip(shape: AvatarShape, res: "2x" | "1x", hex: string): StripResult {
    const entry = this.manifest?.shapes[shape];
    const info = entry?.[res] ?? entry?.[res === "2x" ? "1x" : "2x"];
    if (!info || !/^bot-[a-z]+-face(@2x)?\.png$/.test(info.file)) return null;
    const key = `${info.file}|${hex}`;
    const hit = this.strips.get(key);
    if (hit) return hit;
    let p = this.processed.get(key);
    if (!p) {
      const img = this.images.get(info.file);
      if (img === undefined) {
        this.images.set(info.file, "pending");
        const gen = this.generation;
        void this.source
          .imageUrl(info.file)
          .catch(() => null)
          .then((url) => (url ? loadImage(url).finally(() => url.startsWith("blob:") && URL.revokeObjectURL(url)) : null))
          .then((i) => {
            if (gen === this.generation) this.images.set(info.file, i);
          });
        return "pending";
      }
      if (img === "pending") return "pending";
      if (img === null) return null;
      const src = document.createElement("canvas");
      src.width = img.width;
      src.height = img.height;
      const sctx = src.getContext("2d", { willReadFrequently: true })!;
      sctx.drawImage(img, 0, 0);
      const out = processStrip(sctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height, hex);
      p = { data: out.data, width: out.width, height: out.height, frameSize: out.frameSize, frames: out.frames };
      this.processed.set(key, p);
    }
    const c = document.createElement("canvas");
    c.width = p.width;
    c.height = p.height;
    c.getContext("2d")!.putImageData(new ImageData(p.data, p.width, p.height), 0, 0);
    const strip: Strip = { canvas: c, frameSize: p.frameSize, frames: p.frames };
    this.strips.set(key, strip);
    return strip;
  }
}

// ---------- drawing ----------

const INK = "rgba(10,10,14,0.85)";

function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function glyph(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] === "#") ctx.fillRect(x + i, y + j, 1, 1);
  });
}

/** Pixel circle rows (diameter d): [x0, width] per row. */
function circleRows(d: number): Array<[number, number]> {
  const r = d / 2;
  const rows: Array<[number, number]> = [];
  for (let y = 0; y < d; y++) {
    const dy = y + 0.5 - r;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const x0 = Math.round(r - half);
    rows.push([x0, d - 2 * x0]);
  }
  return rows;
}
const CIRCLE = circleRows(BADGE);

/** Fill rows plus a 1px (4-neighbour) ink outline, drawn at (x, y) = outline box top-left. */
function outlined(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, fill: string): void {
  const h = rows.length;
  const w = rows[0].length;
  const on = (i: number, j: number) => j >= 0 && j < h && i >= 0 && i < w && rows[j][i] === "#";
  ctx.fillStyle = INK;
  for (let j = -1; j <= h; j++)
    for (let i = -1; i <= w; i++)
      if (!on(i, j) && (on(i - 1, j) || on(i + 1, j) || on(i, j - 1) || on(i, j + 1))) ctx.fillRect(x + 1 + i, y + 1 + j, 1, 1);
  glyph(ctx, rows, x + 1, y + 1, fill);
}

function drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay): void {
  switch (o.kind) {
    case "badge": {
      // 1px dark ring, then the fill, then a 7x7 icon; optional pulse rays.
      CIRCLE.forEach(([x0, w], y) => px(ctx, INK, o.x + x0 - 1, o.y + y, w + 2, 1));
      px(ctx, INK, o.x + CIRCLE[0][0], o.y - 1, CIRCLE[0][1], 1);
      px(ctx, INK, o.x + CIRCLE[0][0], o.y + BADGE, CIRCLE[0][1], 1);
      CIRCLE.forEach(([x0, w], y) => px(ctx, o.bg, o.x + x0, o.y + y, w, 1));
      glyph(ctx, ICONS[o.icon], o.x + 2, o.y + 2, o.fg);
      if (o.rays) {
        const m = Math.floor(BADGE / 2);
        px(ctx, o.bg, o.x - 4, o.y + m, 2, 1); // left
        px(ctx, o.bg, o.x - 3, o.y - 2, 1, 1); // up-left
        px(ctx, o.bg, o.x - 2, o.y - 1, 1, 1);
        px(ctx, o.bg, o.x - 3, o.y + BADGE + 1, 1, 1); // down-left
        px(ctx, o.bg, o.x - 2, o.y + BADGE, 1, 1);
        px(ctx, o.bg, o.x + m, o.y + BADGE + 2, 1, 2); // down
      }
      return;
    }
    case "cloud": {
      const k = o.big ? "big" : "small";
      outlined(ctx, CLOUD_FILL[k], o.x, o.y, "#FFFFFF");
      CLOUD_DOTS[k].forEach(([x, y, s], i) => px(ctx, i < o.lit ? "#23262F" : "#C3C8D2", o.x + 1 + x, o.y + 1 + y, s, s));
      return;
    }
    case "puff": {
      const d = 2 * o.r;
      const rows = circleRows(d).map(([x0, w]) => ".".repeat(x0) + "#".repeat(w) + ".".repeat(d - x0 - w));
      outlined(ctx, rows, o.x, o.y, "#FFFFFF");
      return;
    }
    case "dot":
      // Outlines are drawn for the whole group first (drawGroup), so touching dots form one band.
      ctx.globalAlpha = o.alpha;
      px(ctx, o.color, o.x, o.y, o.w, o.h);
      ctx.globalAlpha = 1;
      return;
    case "z":
      ctx.globalAlpha = o.alpha;
      glyph(ctx, Z_GLYPH[o.size], o.x + 1, o.y + 1, INK);
      glyph(ctx, Z_GLYPH[o.size], o.x, o.y, "#8FB0FF");
      ctx.globalAlpha = 1;
      return;
    case "ball":
      px(ctx, INK, o.x - 1, o.y, 5, 3);
      px(ctx, INK, o.x, o.y - 1, 3, 5);
      px(ctx, o.color, o.x, o.y, 3, 3);
      px(ctx, "rgba(255,255,255,0.8)", o.x, o.y, 1, 1);
      return;
  }
}

const isBehind = (o: Overlay) => (o.kind === "ball" || o.kind === "dot") && o.behind;

/** Overlays in order, with the ink outlines of all inked dots laid down first. */
function drawGroup(ctx: CanvasRenderingContext2D, list: Overlay[]): void {
  for (const o of list)
    if (o.kind === "dot" && o.ink) {
      px(ctx, INK, o.x - 1, o.y, o.w + 2, o.h);
      px(ctx, INK, o.x, o.y - 1, o.w, o.h + 2);
    }
  for (const o of list) drawOverlay(ctx, o);
}

/**
 * One avatar frame: overlays behind, the shape (moved, squashed/stretched and leaned by the cue,
 * as 1:1 blocks so it stays pixel-crisp), overlays in front.
 */
export function drawAvatar(ctx: CanvasRenderingContext2D, strip: Strip, g: AvatarGeometry, slot: number, cue: Cue): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, g.backing, g.backing);
  drawGroup(ctx, cue.overlays.filter(isBehind));
  const f = Math.max(0, Math.min(strip.frames - 1, slot));
  const s = strip.frameSize;
  // Centre whichever strip we got in the art box (a 1x fallback strip is smaller); feet stay put.
  const x = g.ax + Math.floor((g.art - s) / 2) + cue.dx;
  const bottom = g.ay + g.art + cue.dy;
  const plan = warpPlan(s, cue.sx, cue.sy, cue.lean);
  const y = bottom - plan.height;
  for (const b of plan.blocks) ctx.drawImage(strip.canvas, f * s + b.sx, b.sy, b.w, b.h, x + plan.left + b.dx, y + b.dy, b.w, b.h);
  drawGroup(ctx, cue.overlays.filter((o) => !isBehind(o)));
}
