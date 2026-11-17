// Unit tests for the pure layout helpers: `npm test` (node:test, Node 24 strips types).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOTTOM_PAD,
  EDGE,
  LABEL_H,
  LABEL_OVERLAP,
  LABEL_OVERLAP_PX,
  layoutPets,
  layoutToast,
  maxPets,
  overlaps,
  petWindowSize,
  pickScale,
  TOAST_MAX_H,
  TOAST_OVERLAP,
  toastMaxWidth,
  type Box,
  type PetSize,
} from "../src/layout.ts";

const W = 360;
const H = 200;

function inside(b: Box, w = W, h = H): boolean {
  return b.left >= 0 && b.top >= 0 && b.left + b.width <= w && b.top + b.height <= h;
}

describe("pet layout", () => {
  it("one column per pet, inside the window, no overlap, same scale", () => {
    for (const pref of ["large", "small"] as PetSize[])
      for (let n = 1; n <= 16; n++) {
        const slots = layoutPets(n, W, H, pref);
        assert.equal(slots.length, Math.min(n, maxPets(W)));
        for (const [i, s] of slots.entries()) {
          assert.ok(s.x0 >= EDGE - 1 && s.x1 <= W - EDGE + 1, `n=${n} slot ${i} outside window`);
          assert.ok(s.spriteSize <= s.x1 - s.x0, `n=${n} sprite wider than its column`);
          assert.ok(s.spriteTop >= 0);
          assert.equal(s.scale, slots[0]!.scale);
          if (i > 0) assert.ok(s.x0 >= slots[i - 1]!.x1, "columns overlap");
        }
      }
  });

  it("scales down as pets are added and respects the size preference", () => {
    assert.equal(layoutPets(3, W, H)[0]!.scale, 3);
    assert.equal(layoutPets(4, W, H)[0]!.scale, 2);
    assert.equal(layoutPets(3, W, H, "small")[0]!.scale, 2);
    assert.equal(layoutPets(9, W, H)[0]!.scale, 1);
    assert.equal(maxPets(W), 9);
    assert.equal(layoutPets(20, W, H).length, 9);
    assert.equal(pickScale(10, "large"), 1);
  });

  it("sizes one bot's own window to fit its pet, its toast or working label, and its name", () => {
    assert.deepEqual(petWindowSize("large"), { width: 184, height: 158 });
    assert.deepEqual(petWindowSize("small"), { width: 152, height: 126 });
    for (const pref of ["large", "small"] as PetSize[]) {
      const { width, height } = petWindowSize(pref);
      const [s, ...rest] = layoutPets(1, width, height, pref);
      assert.equal(rest.length, 0);
      assert.equal(s!.scale, pref === "large" ? 3 : 2, "the preferred size fits");
      assert.ok(s!.spriteTop >= 0);
      // the name label sits under the sprite, inside the window
      assert.ok(s!.spriteTop + s!.spriteSize + LABEL_H - LABEL_OVERLAP + BOTTOM_PAD <= height);
      for (const overlap of [TOAST_OVERLAP, LABEL_OVERLAP_PX]) {
        const b = layoutToast(s!, 10_000, 10_000, width, height, overlap);
        assert.equal(b.height, TOAST_MAX_H, `${pref}: a full 2-line toast is not squeezed`);
        assert.ok(b.top >= EDGE && b.left >= EDGE && b.left + b.width <= width - EDGE, `${pref}: clipped ${JSON.stringify(b)}`);
        assert.ok(b.top + b.height <= s!.spriteTop + overlap, `${pref}: covers more of the pet than allowed`);
      }
    }
  });
});

describe("toast layout", () => {
  it("toasts never leave the window and never overlap each other (worst case: every pet has a max-size toast)", () => {
    for (const pref of ["large", "small"] as PetSize[])
      for (let n = 1; n <= 16; n++) {
        const slots = layoutPets(n, W, H, pref);
        const boxes = slots.map((s) => layoutToast(s, 10_000, 10_000, W, H));
        for (const [i, b] of boxes.entries()) {
          assert.ok(inside(b), `n=${n} toast ${i} clipped: ${JSON.stringify(b)}`);
          assert.ok(b.height <= TOAST_MAX_H);
          assert.ok(b.left >= slots[i]!.x0 && b.left + b.width <= slots[i]!.x1, "toast left its own column");
          for (let j = 0; j < i; j++) assert.ok(!overlaps(b, boxes[j]!), `n=${n}: toasts ${j} and ${i} overlap`);
        }
      }
  });

  it("sits above its own pet, centred when there is room", () => {
    const [s] = layoutPets(1, W, H);
    const b = layoutToast(s!, 80, 20, W, H);
    assert.equal(b.left + b.width / 2, s!.cx);
    assert.ok(b.top + b.height <= s!.spriteTop + 6);
    assert.ok(b.top + b.height > s!.spriteTop - 4, "rests on the pet, not floating at the top");
  });

  it("clamps short toasts inside the column instead of centring off-edge", () => {
    const slots = layoutPets(3, W, H);
    const wide = toastMaxWidth(slots[0]!);
    const b = layoutToast(slots[0]!, wide, 30, W, H);
    assert.equal(b.width, wide);
    assert.ok(b.left >= EDGE);
  });

  it("works for tiny or odd windows", () => {
    for (const [w, h] of [
      [120, 120],
      [361, 201],
      [800, 160],
    ] as const) {
      for (let n = 1; n <= 6; n++) {
        const slots = layoutPets(n, w, h);
        const boxes = slots.map((s) => layoutToast(s, 999, 999, w, h));
        boxes.forEach((b, i) => {
          assert.ok(inside(b, w, h), `${w}x${h} n=${n}: ${JSON.stringify(b)}`);
          for (let j = 0; j < i; j++) assert.ok(!overlaps(b, boxes[j]!));
        });
      }
    }
  });
});
