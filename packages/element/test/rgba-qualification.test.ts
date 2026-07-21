import { describe, expect, it } from "vitest";

import {
  equivalentRgbaPixels,
  informativeRgbaPixels,
  resemblesZeroChromaGreen
} from "../src/rgba-qualification.js";

describe("RGBA semantic qualification", () => {
  it("allows bounded conversion rounding and ignores transparent RGB", () => {
    const reference = new Uint8Array([
      20, 80, 180, 255,
      1, 2, 3, 0
    ]);
    const rounded = new Uint8ClampedArray([
      23, 77, 182, 254,
      255, 255, 255, 0
    ]);

    expect(equivalentRgbaPixels(reference, rounded)).toBe(true);
    rounded[0] = 24;
    expect(equivalentRgbaPixels(reference, rounded)).toBe(false);
  });

  it("requires visible channel variation for an informative witness", () => {
    expect(informativeRgbaPixels(new Uint8Array([
      20, 80, 180, 255,
      30, 110, 220, 255
    ]))).toBe(true);
    expect(informativeRgbaPixels(new Uint8Array([
      20, 80, 180, 255,
      20, 80, 180, 255
    ]))).toBe(false);
  });

  it("recognizes Chromium's visible zero-chroma green signature", () => {
    expect(resemblesZeroChromaGreen(new Uint8Array([
      0, 220, 0, 255,
      0, 180, 0, 255,
      3, 140, 2, 255,
      20, 80, 180, 255
    ]))).toBe(true);
    expect(resemblesZeroChromaGreen(new Uint8Array([
      20, 80, 180, 255,
      30, 110, 220, 255
    ]))).toBe(false);
  });
});
