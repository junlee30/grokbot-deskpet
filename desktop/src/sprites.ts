// Loads the spritesheets described by public/sprites/manifest.json and produces per-accent
// tinted copies: base strip + (accent strip recoloured with the bot's colour) composited once
// and cached. Rendering is always nearest-neighbour at an integer scale.

export type AnimState =
  | "idle"
  | "thinking"
  | "working"
  | "juggling"
  | "needs_you"
  | "done"
  | "error"
  | "sleeping"
  | "offline";

export interface AnimDef {
  file: string;
  accent?: string;
  frames: number;
  fps: number;
  loop: boolean;
  playOnce?: boolean;
  then?: AnimState;
}

interface Manifest {
  frameWidth: number;
  frameHeight: number;
  scale: number;
  states: Record<AnimState, AnimDef>;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export class SpriteBank {
  fw = 32;
  fh = 32;
  scale = 3;
  defs = {} as Record<AnimState, AnimDef>;
  private base = new Map<AnimState, HTMLImageElement>();
  private accent = new Map<AnimState, HTMLImageElement>();
  private tinted = new Map<string, HTMLCanvasElement>();

  async load(root = "sprites/"): Promise<void> {
    const m = (await (await fetch(`${root}manifest.json`)).json()) as Manifest;
    this.fw = m.frameWidth;
    this.fh = m.frameHeight;
    this.scale = m.scale;
    this.defs = m.states;
    await Promise.all(
      (Object.keys(m.states) as AnimState[]).map(async (s) => {
        const d = m.states[s];
        const [b, a] = await Promise.all([loadImage(root + d.file), d.accent ? loadImage(root + d.accent) : null]);
        if (b) this.base.set(s, b);
        if (a) this.accent.set(s, a);
      }),
    );
  }

  /** Base + tinted accent, composited once per (state, colour). */
  sheet(state: AnimState, colour: string): HTMLCanvasElement | null {
    const key = `${state}|${colour}`;
    const hit = this.tinted.get(key);
    if (hit) return hit;
    const b = this.base.get(state);
    if (!b) return null;
    const c = document.createElement("canvas");
    c.width = b.width;
    c.height = b.height;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(b, 0, 0);
    const a = this.accent.get(state);
    if (a) {
      const t = document.createElement("canvas");
      t.width = a.width;
      t.height = a.height;
      const tc = t.getContext("2d")!;
      tc.imageSmoothingEnabled = false;
      tc.drawImage(a, 0, 0);
      tc.globalCompositeOperation = "source-in"; // keep accent alpha, replace colour
      tc.fillStyle = colour;
      tc.fillRect(0, 0, t.width, t.height);
      ctx.drawImage(t, 0, 0);
    }
    this.tinted.set(key, c);
    return c;
  }
}

// Deterministic accent colour per agent. Known names get their signature colour; anything else
// hashes into a fixed palette, so a bot always keeps the same colour.
const NAMED: Record<string, string> = {
  jarvis: "#2dd4bf", // teal
  claude: "#f0883e", // orange
  scout: "#a78bfa", // violet
};
const PALETTE = ["#2dd4bf", "#f0883e", "#a78bfa", "#60a5fa", "#f472b6", "#facc15", "#4ade80", "#fb7185"];

export function accentFor(agentId: string, overrides: Record<string, string> = {}): string {
  const o = overrides[agentId];
  if (o && /^#[0-9a-fA-F]{6}$/.test(o)) return o;
  if (NAMED[agentId]) return NAMED[agentId];
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}
