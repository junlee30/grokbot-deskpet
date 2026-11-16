// DOM side of Grok Bot avatars: loads the imported art (public/grokbot-art/, gitignored, see
// scripts/import-grokbot-art.mjs), turns strips into tinted canvases (cached per shape/res/colour)
// and draws a frame plus its state-cue overlays. All pure logic lives in avatar.ts.
import {
  BADGE,
  ICONS,
  processStrip,
  SPINNER_DOTS,
  Z_GLYPH,
  type AvatarGeometry,
  type AvatarShape,
  type Cue,
  type Overlay,
  type Palette,
} from "./avatar.ts";

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

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export class AvatarBank {
  manifest: ArtManifest | null = null;
  private root = "grokbot-art/";
  private images = new Map<string, HTMLImageElement | null | "pending">();
  private strips = new Map<string, Strip>();

  /** Never throws: no art just means every bot uses the robot. */
  async load(root = "grokbot-art/"): Promise<void> {
    this.root = root;
    try {
      const r = await fetch(`${root}manifest.json`, { cache: "no-store" });
      if (!r.ok) return;
      const m = (await r.json()) as ArtManifest;
      if (m && typeof m === "object" && m.shapes && typeof m.shapes === "object") this.manifest = m;
    } catch {
      this.manifest = null;
    }
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
    const img = this.images.get(info.file);
    if (img === undefined) {
      this.images.set(info.file, "pending");
      void loadImage(this.root + info.file).then((i) => this.images.set(info.file, i));
      return "pending";
    }
    if (img === "pending") return "pending";
    if (img === null) return null;
    const src = document.createElement("canvas");
    src.width = img.width;
    src.height = img.height;
    const sctx = src.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(img, 0, 0);
    const p = processStrip(sctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height, hex);
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

function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function glyph(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] === "#") ctx.fillRect(x + i, y + j, 1, 1);
  });
}

/** Pixel circle rows for the badge (diameter BADGE). */
const CIRCLE: Array<[number, number]> = (() => {
  const r = BADGE / 2;
  const rows: Array<[number, number]> = [];
  for (let y = 0; y < BADGE; y++) {
    const dy = y + 0.5 - r;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const x0 = Math.round(r - half);
    rows.push([x0, BADGE - 2 * x0]);
  }
  return rows;
})();

function drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay): void {
  const ink = "rgba(10,10,14,0.85)";
  switch (o.kind) {
    case "badge": {
      // 1px dark ring, then the fill, then a 7x7 icon.
      CIRCLE.forEach(([x0, w], y) => px(ctx, ink, o.x + x0 - 1, o.y + y, w + 2, 1));
      px(ctx, ink, o.x + CIRCLE[0][0], o.y - 1, CIRCLE[0][1], 1);
      px(ctx, ink, o.x + CIRCLE[0][0], o.y + BADGE, CIRCLE[0][1], 1);
      CIRCLE.forEach(([x0, w], y) => px(ctx, o.bg, o.x + x0, o.y + y, w, 1));
      const ix = o.x + 2;
      const iy = o.y + 2;
      if (o.icon === "spinner") {
        SPINNER_DOTS.forEach(([dx, dy], i) => {
          const lag = (o.phase - i + 8) % 8;
          ctx.globalAlpha = lag === 0 ? 1 : lag === 1 ? 0.7 : lag === 2 ? 0.45 : 0.2;
          px(ctx, o.fg, ix + dx, iy + dy);
        });
        ctx.globalAlpha = 1;
      } else glyph(ctx, ICONS[o.icon], ix, iy, o.fg);
      return;
    }
    case "dots":
      for (let i = 0; i < o.n; i++) {
        px(ctx, ink, o.x + i * 4, o.y, 4, 4);
        px(ctx, "#FFFFFF", o.x + i * 4 + 1, o.y + 1, 2, 2);
      }
      return;
    case "z":
      ctx.globalAlpha = o.alpha;
      glyph(ctx, Z_GLYPH[o.size], o.x + 1, o.y + 1, ink);
      glyph(ctx, Z_GLYPH[o.size], o.x, o.y, "#8FB0FF");
      ctx.globalAlpha = 1;
      return;
    case "ball":
      px(ctx, ink, o.x - 1, o.y, 5, 3);
      px(ctx, ink, o.x, o.y - 1, 3, 5);
      px(ctx, o.color, o.x, o.y, 3, 3);
      px(ctx, "rgba(255,255,255,0.8)", o.x, o.y, 1, 1);
      return;
    case "spark":
      px(ctx, o.color, o.x - o.r, o.y, 2 * o.r + 1, 1);
      px(ctx, o.color, o.x, o.y - o.r, 1, 2 * o.r + 1);
      return;
  }
}

/** One avatar frame: overlays behind, the shape (offset by the cue's motion), overlays in front. */
export function drawAvatar(ctx: CanvasRenderingContext2D, strip: Strip, g: AvatarGeometry, slot: number, cue: Cue): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, g.backing, g.backing);
  for (const o of cue.overlays) if (o.kind === "ball" && o.behind) drawOverlay(ctx, o);
  const f = Math.max(0, Math.min(strip.frames - 1, slot));
  const s = strip.frameSize;
  // Centre whichever strip we got in the art box (a 1x fallback strip is smaller).
  const x = g.ax + Math.floor((g.art - s) / 2) + cue.dx;
  const y = g.ay + (g.art - s) + cue.dy;
  ctx.drawImage(strip.canvas, f * s, 0, s, s, x, y, s, s);
  for (const o of cue.overlays) if (!(o.kind === "ball" && o.behind)) drawOverlay(ctx, o);
}
