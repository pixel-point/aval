import { describe, expect, it } from "vitest";

import { resolveDirectCanvas } from "../src/compile/direct-canvas.js";
import { CompilerError } from "../src/diagnostics.js";

describe("direct canvas selection", () => {
  it("infers the largest exact 16-aligned non-upscaled canvas", () => {
    expect(resolveDirectCanvas({ width: 1920, height: 1080 })).toEqual({
      width: 512,
      height: 288
    });
    expect(resolveDirectCanvas({ width: 32, height: 32 })).toEqual({
      width: 32,
      height: 32
    });
  });

  it("requires and validates an explicit PNG canvas", () => {
    expect(() => resolveDirectCanvas(
      { width: 64, height: 32 },
      undefined,
      true
    )).toThrow(CompilerError);
    expect(resolveDirectCanvas(
      { width: 64, height: 32 },
      [32, 16],
      true
    )).toEqual({ width: 32, height: 16 });
    expect(() => resolveDirectCanvas(
      { width: 64, height: 32 },
      [32, 32]
    )).toThrow(CompilerError);
  });
});
