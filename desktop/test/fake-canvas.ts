// A tiny software stand-in for CanvasRenderingContext2D (only what avatar-bank.ts drawing uses),
// so rendering can be tested in node. It also records every call so tests can check that all
// coordinates are integers (pixel-crisp) and inside the canvas.

export interface FakeSource {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function parseColor(c: string): [number, number, number, number] {
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`unsupported colour ${c}`);
}

export class FakeCtx {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  fillStyle = "#000000";
  globalAlpha = 1;
  imageSmoothingEnabled = true;
  readonly calls: Array<{ op: string; args: number[] }> = [];

  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  private blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const da = this.data[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    this.data[i] = Math.round((r * a + this.data[i] * da * (1 - a)) / oa);
    this.data[i + 1] = Math.round((g * a + this.data[i + 1] * da * (1 - a)) / oa);
    this.data[i + 2] = Math.round((b * a + this.data[i + 2] * da * (1 - a)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ op: "clearRect", args: [x, y, w, h] });
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < this.width && j < this.height) this.data.fill(0, (j * this.width + i) * 4, (j * this.width + i) * 4 + 4);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push({ op: "fillRect", args: [x, y, w, h] });
    const [r, g, b, a] = parseColor(this.fillStyle);
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.blend(i, j, r, g, b, a * this.globalAlpha);
  }

  drawImage(src: FakeSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    this.calls.push({ op: "drawImage", args: [sx, sy, sw, sh, dx, dy, dw, dh] });
    if (sw !== dw || sh !== dh) throw new Error("FakeCtx.drawImage only supports 1:1 copies");
    for (let j = 0; j < sh; j++)
      for (let i = 0; i < sw; i++) {
        const si = ((sy + j) * src.width + sx + i) * 4;
        this.blend(dx + i, dy + j, src.data[si], src.data[si + 1], src.data[si + 2], (src.data[si + 3] / 255) * this.globalAlpha);
      }
  }

  alphaAt(x: number, y: number): number {
    return this.data[(y * this.width + x) * 4 + 3];
  }

  rgbaAt(x: number, y: number): [number, number, number, number] {
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
}
