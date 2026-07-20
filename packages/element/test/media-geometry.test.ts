import { describe, expect, it } from "vitest";

import { sameAspectRatio } from "../src/media-geometry.js";

describe("sameAspectRatio", () => {
  it.each([
    [640, 360, 1_280, 720],
    [48, 104, 96, 208],
    [4_294_967_294, 4_294_967_292, 2_147_483_647, 2_147_483_646]
  ] as const)("accepts equivalent %i:%i and %i:%i ratios", (
    leftWidth,
    leftHeight,
    rightWidth,
    rightHeight
  ) => {
    expect(sameAspectRatio(
      leftWidth,
      leftHeight,
      rightWidth,
      rightHeight
    )).toBe(true);
  });

  it.each([
    [640, 360, 1_279, 720]
  ] as const)("rejects different %i:%i and %i:%i ratios", (
    leftWidth,
    leftHeight,
    rightWidth,
    rightHeight
  ) => {
    expect(sameAspectRatio(
      leftWidth,
      leftHeight,
      rightWidth,
      rightHeight
    )).toBe(false);
  });

  it("does not round away a one-unit cross-product difference", () => {
    const edge = 4_294_967_291;
    expect(edge * (edge - 2)).toBe((edge - 1) * (edge - 1));
    expect(sameAspectRatio(
      edge,
      edge - 1,
      edge - 1,
      edge - 2
    )).toBe(false);
  });

  it.each([
    [0, 1, 1, 1],
    [1, 0, 1, 1],
    [1, 1, 0, 1],
    [1, 1, 1, 0],
    [Number.MAX_SAFE_INTEGER + 1, 1, 1, 1],
    [1.5, 1, 1, 1]
  ] as const)("rejects invalid dimensions", (
    leftWidth,
    leftHeight,
    rightWidth,
    rightHeight
  ) => {
    expect(() => sameAspectRatio(
      leftWidth,
      leftHeight,
      rightWidth,
      rightHeight
    )).toThrowError(RangeError);
  });
});
