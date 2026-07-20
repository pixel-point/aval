import { describe, expect, it } from "vitest";

import { maximumDecodedRgbaBytes } from "../src/index.js";

describe("decoded surface reserve", () => {
  it("applies the codec-owned browser allocation policy", () => {
    expect(maximumDecodedRgbaBytes("h264", 32, 32)).toBe(64 * 64 * 4);
    for (const codec of ["h265", "vp9", "av1"] as const) {
      expect(maximumDecodedRgbaBytes(codec, 32, 32)).toBe(32 * 32 * 4);
    }
  });

  it("rejects invalid dimensions, arithmetic, and codec values", () => {
    expect(() => maximumDecodedRgbaBytes("vp9", 0, 32)).toThrow(/positive/u);
    expect(() => maximumDecodedRgbaBytes(
      "av1",
      Number.MAX_SAFE_INTEGER,
      2
    )).toThrow(/safe-integer range/u);
    expect(() => maximumDecodedRgbaBytes(
      "unsupported" as "av1",
      32,
      32
    )).toThrow(/unsupported/u);
  });
});
