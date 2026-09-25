import { describe, expect, it } from "vitest";
import { validateSource } from "../src/source.js";
import type { AlphaSource } from "../src/types.js";

const source: AlphaSource = { src: "clip.webm", width: 32, height: 40, colorRect: [0, 0, 32, 16], alphaRect: [0, 24, 32, 16] };
describe("alpha source contract", () => {
  it("detaches authored rectangles and accepts different packing orientations", () => {
    const result = validateSource(source);
    expect(result).toEqual(source);
    expect(result.alphaRect).not.toBe(source.alphaRect);
    expect(validateSource({ ...source, width: 72, height: 16, alphaRect: [40, 0, 32, 16] }).width).toBe(72);
  });
  it.each([
    { src: "" }, { width: Infinity }, { height: 1.5 }, { colorRect: [0, 0, 0, 16] },
    { alphaRect: [0, 15, 32, 16] }, { alphaRect: [0, 25, 32, 16] },
    { alphaRect: [0, 24, 31, 16] }, { colorRect: [0, -1, 32, 16] }, { alphaRect: null },
    { colorRect: [0, , 32, 16] }
  ])("rejects invalid layout %j", (patch) => {
    expect(() => validateSource({ ...source, ...patch } as AlphaSource)).toThrow(/source needs/u);
  });
});
