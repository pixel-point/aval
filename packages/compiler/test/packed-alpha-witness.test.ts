import { describe, expect, it } from "vitest";

import {
  selectPackedAlphaWitnessCandidates,
  type PackedAlphaWitnessCandidateSelection
} from "../src/compile/packed-alpha-witness.js";
import {
  qualifyPackedAlphaWitnessCandidates
} from "../src/compile/verify-packed-alpha-witness.js";
import { CompilerError } from "../src/diagnostics.js";

describe("packed-alpha compiler witness", () => {
  it.each([
    ["transparent", [0, 0, 0, 0], 0],
    ["opaque", [255, 255, 255, 255], 255],
    ["uniform mid-alpha", [127, 127, 127, 127], 127]
  ])("selects one deterministic sample for %s content", (_, alpha, expected) => {
    const rgba = frame(alpha as number[], 2, 2);
    const before = rgba.slice();
    const selected = selectPackedAlphaWitnessCandidates({
      bootstrapUnits: ["idle.body"],
      frames: [{ unit: "idle.body", frame: 0, width: 2, height: 2, rgba }]
    });

    expect(selected).toMatchObject({
      unit: "idle.body",
      frame: 0,
      requiresSeparatedCoverage: false,
      candidates: [{ x: 0, y: 0, canonicalAlpha: expected }]
    });
    expect(selected.candidates).toHaveLength(1);
    expect(rgba).toEqual(before);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.candidates)).toBe(true);
  });

  it("orders readiness unit/frame first, then low gradient and row-major coordinates", () => {
    const selected = selectPackedAlphaWitnessCandidates({
      bootstrapUnits: ["body-b", "body-a"],
      frames: [
        { unit: "body-a", frame: 0, width: 2, height: 2, rgba: frame([255, 0, 255, 0], 2, 2) },
        { unit: "body-b", frame: 1, width: 2, height: 2, rgba: frame([255, 0, 255, 0], 2, 2) },
        { unit: "body-b", frame: 0, width: 3, height: 2, rgba: frame([0, 0, 255, 0, 0, 255], 3, 2) }
      ]
    });

    expect(selected.unit).toBe("body-b");
    expect(selected.frame).toBe(0);
    expect(selected.candidates[0]).toMatchObject({ x: 0, y: 0, gradient: 0 });
    expect(selected.candidates[1]).toMatchObject({ x: 0, y: 1, gradient: 0 });
  });

  it("keeps a nonuniform single alpha class to one representative", () => {
    const selected = selectPackedAlphaWitnessCandidates({
      bootstrapUnits: ["idle.body"],
      frames: [{
        unit: "idle.body",
        frame: 0,
        width: 3,
        height: 2,
        rgba: frame([64, 68, 72, 76, 80, 84], 3, 2)
      }]
    });

    expect(selected.requiresSeparatedCoverage).toBe(false);
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0]).toMatchObject({ x: 0, y: 0, canonicalAlpha: 64 });
  });

  it("retains a bounded unique candidate pool with separated authored coverage", () => {
    const alpha = Array.from({ length: 20 }, (_, index) => index < 10 ? 16 : 224);
    const selected = selectPackedAlphaWitnessCandidates({
      bootstrapUnits: ["idle.body"],
      frames: [{ unit: "idle.body", frame: 0, width: 10, height: 2, rgba: frame(alpha, 10, 2) }]
    });

    expect(selected.requiresSeparatedCoverage).toBe(true);
    expect(selected.candidates.length).toBeGreaterThanOrEqual(2);
    expect(selected.candidates.length).toBeLessThanOrEqual(8);
    expect(new Set(selected.candidates.map(({ x, y }) => `${x}:${y}`)).size)
      .toBe(selected.candidates.length);
    expect(selected.candidates.some((left) => selected.candidates.some((right) =>
      Math.abs(left.canonicalAlpha - right.canonicalAlpha) >= 128
    ))).toBe(true);
  });

  it("constructs exact inclusive clipped intervals from canonical and emitted values", () => {
    const selection = manualSelection([0, 128, 255]);
    const witness = qualifyPackedAlphaWitnessCandidates(selection, [10, 150, 245]);

    expect(witness.samples).toEqual([
      { x: 0, y: 0, expectedRange: [0, 42] },
      { x: 1, y: 0, expectedRange: [96, 182] },
      { x: 2, y: 0, expectedRange: [213, 255] }
    ]);
    expect(Object.isFrozen(witness)).toBe(true);
    expect(Object.isFrozen(witness.samples[0]?.expectedRange)).toBe(true);
  });

  it("rejects corrupted emitted samples beyond delta 32", () => {
    const selection = manualSelection([0, 255]);
    expect(() => qualifyPackedAlphaWitnessCandidates(selection, [128, 128]))
      .toThrowError(expect.objectContaining<Partial<CompilerError>>({
        code: "FFMPEG_FAILED",
        message: expect.stringContaining("bounded output witness")
      }));
  });

  it("rejects shared black corruption even when the low-alpha class survives", () => {
    const selection = manualSelection([16, 16, 224]);
    expect(() => qualifyPackedAlphaWitnessCandidates(selection, [0, 0, 0]))
      .toThrowError(expect.objectContaining<Partial<CompilerError>>({
        code: "FFMPEG_FAILED",
        message: expect.stringContaining("separated")
      }));
  });

  it("requires non-overlapping inclusive intervals for high-dynamic-range content", () => {
    const selection = manualSelection([64, 192]);
    expect(() => qualifyPackedAlphaWitnessCandidates(selection, [96, 160]))
      .toThrowError(expect.objectContaining<Partial<CompilerError>>({
        code: "FFMPEG_FAILED",
        message: expect.stringContaining("separated")
      }));
  });
});

function frame(alpha: number[], width: number, height: number): Uint16Array {
  expect(alpha).toHaveLength(width * height);
  const rgba = new Uint16Array(width * height * 4);
  for (let index = 0; index < alpha.length; index += 1) {
    rgba[index * 4] = 1_000 + index;
    rgba[index * 4 + 1] = 2_000 + index;
    rgba[index * 4 + 2] = 3_000 + index;
    rgba[index * 4 + 3] = alpha[index]! * 257;
  }
  return rgba;
}

function manualSelection(alpha: number[]): Readonly<PackedAlphaWitnessCandidateSelection> {
  return Object.freeze({
    unit: "idle.body",
    frame: 0,
    requiresSeparatedCoverage: Math.max(...alpha) - Math.min(...alpha) >= 128,
    candidates: Object.freeze(alpha.map((canonicalAlpha, x) => Object.freeze({
      x,
      y: 0,
      canonicalAlpha,
      gradient: 0
    })))
  });
}
