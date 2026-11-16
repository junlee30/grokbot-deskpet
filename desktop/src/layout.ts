// Pure layout for pets and their toasts. No DOM: unit-tested with node:test (test/layout.test.ts).
//
// The window is split into one column per pet. A pet's toast lives inside its own column,
// above its own pet, clamped to the window, so toasts can never overlap each other or get
// clipped by the window edge. Text is limited to TOAST_LINES lines (CSS line-clamp + ellipsis).

export type PetSize = "large" | "small";

export const FRAME = 32;
export const EDGE = 4; // keep this far from the window edges
export const BOTTOM_PAD = 6;
export const LABEL_H = 16;
export const LABEL_OVERLAP = 2;
export const MAX_COL_W = 176;
export const TOAST_LINES = 2;
export const TOAST_LINE_H = 14;
export const TOAST_PAD_Y = 4;
export const TOAST_PAD_X = 7;
export const TOAST_BORDER = 1;
/** Tallest a toast can be (2 lines + padding + border). */
export const TOAST_MAX_H = TOAST_LINES * TOAST_LINE_H + 2 * TOAST_PAD_Y + 2 * TOAST_BORDER;
/** How far a toast may dip into the top of its sprite (the head sits a few px below the frame top). */
export const TOAST_OVERLAP = 6;
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

/** Pets in a stable order: remembered order first, then newcomers in arrival order. */
export function orderPets(ids: string[], remembered: string[]): string[] {
  const rank = new Map(remembered.map((id, i) => [id, i]));
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => (rank.get(a.id) ?? 1e6 + a.i) - (rank.get(b.id) ?? 1e6 + b.i))
    .map((x) => x.id);
}

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}
