// Pure layout for pets and their toasts. No DOM: unit-tested with node:test (test/layout.test.ts).
//
// Each bot has its own window (petWindowSize) with one column in it. The pet's toast lives in
// that column, above the pet, clamped to the window, so it is never clipped by the window
// edge and never covers another bot. Text is limited to TOAST_LINES lines (CSS line-clamp +
// ellipsis).

export type PetSize = "large" | "small";

export const FRAME = 32;
export const EDGE = 4; // keep this far from the window edges
export const BOTTOM_PAD = 6;
export const LABEL_H = 16;
export const LABEL_OVERLAP = 2;
export const MAX_COL_W = 176;
export const TOAST_LINES = 2;
export const TOAST_LINE_H = 16;
export const TOAST_PAD_Y = 6;
export const TOAST_PAD_X = 10;
export const TOAST_BORDER = 1;
/** Tallest a toast can be (2 lines + padding + border). */
export const TOAST_MAX_H = TOAST_LINES * TOAST_LINE_H + 2 * TOAST_PAD_Y + 2 * TOAST_BORDER;
/**
 * How far a toast's box may dip into the top of its sprite. 0: only its tail (TOAST_TAIL px,
 * CSS .bubble::after) reaches into the frame, where the head sits a few px below the top.
 */
export const TOAST_OVERLAP = 0;
/** The toast's tail hangs this far below its box, pointing at the pet. */
export const TOAST_TAIL = 6;
/** The working label sits just above the sprite: the working hop reaches the frame top. */
export const LABEL_OVERLAP_PX = 0;
const COL_GAP = 2; // toast inset inside its column

export interface Slot {
  /** Column bounds, window x coordinates. Columns never overlap. */
  x0: number;
  x1: number;
  cx: number;
  scale: number;
  spriteSize: number;
  spriteTop: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Largest integer scale (<= the preferred one) whose sprite fits the column; at least 1. */
export function pickScale(colW: number, pref: PetSize): number {
  const max = pref === "small" ? 2 : 3;
  for (let s = max; s > 1; s--) if (FRAME * s + 8 <= colW) return s;
  return 1;
}

export const MIN_COL_W = FRAME + 4;

/** How many pets fit side by side; the rest are summarised as "+N". */
export function maxPets(winW: number): number {
  return Math.max(1, Math.floor((winW - 2 * EDGE) / MIN_COL_W));
}

/**
 * One column per pet, centred as a group, all pets at the same scale. Returns at most
 * maxPets(winW) slots.
 */
export function layoutPets(count: number, winW: number, winH: number, pref: PetSize = "large"): Slot[] {
  count = Math.min(count, maxPets(winW));
  if (count <= 0) return [];
  const inner = winW - 2 * EDGE;
  const colW = Math.floor(Math.min(MAX_COL_W, inner / count));
  const scale = pickScale(colW, pref);
  const spriteSize = FRAME * scale;
  const spriteTop = winH - BOTTOM_PAD - LABEL_H + LABEL_OVERLAP - spriteSize;
  const start = Math.floor((winW - colW * count) / 2);
  const slots: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const x0 = start + i * colW;
    slots.push({ x0, x1: x0 + colW, cx: x0 + colW / 2, scale, spriteSize, spriteTop });
  }
  return slots;
}

/** Where the tail sits along a toast placed at `box`: under the pet, kept off the rounded corners. */
export function tailX(slot: Slot, box: Box): number {
  const inset = 14;
  if (box.width <= 2 * inset) return Math.round(box.width / 2);
  return Math.round(Math.max(inset, Math.min(box.width - inset, slot.cx - box.left)));
}

/** Widest a toast may be in this slot. */
export function toastMaxWidth(slot: Slot): number {
  return Math.max(1, slot.x1 - slot.x0 - 2 * COL_GAP);
}

/**
 * Place a toast of the measured size above its pet: centred on the pet, clamped to its column
 * (and so to the window), bottom resting on the pet's head, never above the top edge.
 */
export function layoutToast(slot: Slot, measuredW: number, measuredH: number, winW: number, winH: number, overlap = TOAST_OVERLAP): Box {
  const maxW = toastMaxWidth(slot);
  const width = Math.min(Math.ceil(measuredW), maxW);
  const height = Math.min(Math.ceil(measuredH), TOAST_MAX_H);
  const minLeft = Math.max(slot.x0 + COL_GAP, EDGE);
  const maxLeft = Math.min(slot.x1 - COL_GAP, winW - EDGE) - width;
  const left = Math.round(Math.max(minLeft, Math.min(slot.cx - width / 2, maxLeft)));
  const bottom = Math.min(slot.spriteTop + overlap, winH - EDGE);
  const top = Math.max(EDGE, bottom - height);
  return { left, top, width, height };
}

/** Pet window widths (logical px): room for a 2-line toast above the pet. */
export const PET_WINDOW_W: Record<PetSize, number> = { large: MAX_COL_W + 2 * EDGE, small: 152 };

/**
 * The size of one bot's own window: its toast or working label on top (never clipped), the
 * sprite (with its thought cloud, hops and badges inside the canvas) and the name label.
 * Rust opens every pet window at this size (pets_set_size).
 */
export function petWindowSize(pref: PetSize): { width: number; height: number } {
  const sprite = FRAME * pickScale(PET_WINDOW_W[pref] - 2 * EDGE, pref);
  // The working label (overlap 0) is the tallest stack: toast, sprite, name label, padding.
  return { width: PET_WINDOW_W[pref], height: EDGE + TOAST_MAX_H + LABEL_OVERLAP_PX + sprite + LABEL_H - LABEL_OVERLAP + BOTTOM_PAD };
}

/** The control window (index.html): a fixed width, as tall as its panel for the current view. */
export const CONTROL_W = 360;
export const CONTROL_MIN_H = 120;
export const CONTROL_MAX_H = 520;

export function controlWindowSize(panelH: number): { width: number; height: number } {
  const h = Number.isFinite(panelH) ? Math.ceil(panelH) : CONTROL_MIN_H;
  return { width: CONTROL_W, height: Math.max(CONTROL_MIN_H, Math.min(CONTROL_MAX_H, h)) };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}
