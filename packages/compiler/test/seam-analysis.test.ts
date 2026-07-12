import { describe, expect, it } from "vitest";

import { analyzeSeam } from "../src/compile/seam-analysis.js";

function frame(value: number, alpha = 255): Uint8Array {
  return Uint8Array.of(value, value, value, alpha);
}

describe("seam analysis", () => {
  it("passes a boundary whose change fits neighboring motion", () => {
    const result = analyzeSeam({
      width: 1,
      height: 1,
      frames: [frame(0), frame(10), frame(20), frame(30), frame(40)],
      boundaryAfter: 2
    });
    expect(result.passes).toBe(true);
    expect(result.identicalBoundary).toBe(false);
    expect(result.repeatedEndpointPause).toBe(false);
  });

  it("fails an outlier and independently measures alpha", () => {
    const result = analyzeSeam({
      width: 1,
      height: 1,
      frames: [
        frame(0, 255),
        frame(1, 250),
        frame(2, 245),
        frame(255, 240),
        frame(254, 235)
      ],
      boundaryAfter: 2
    });
    expect(result.passes).toBe(false);
    expect(result.boundaryRms).toBeGreaterThan(result.neighborP95);
    expect(result.alphaBoundaryRms).toBeGreaterThan(0);
  });

  it("detects a duplicated boundary frame", () => {
    const duplicate = frame(128);
    expect(analyzeSeam({
      width: 1,
      height: 1,
      frames: [frame(0), duplicate, duplicate, frame(255)],
      boundaryAfter: 1
    })).toMatchObject({
      identicalBoundary: true,
      repeatedEndpointPause: true
    });
  });

  it("does not reject a genuinely static loop as a repeated endpoint pause", () => {
    const still = frame(12);
    expect(analyzeSeam({
      width: 1,
      height: 1,
      frames: [still, still],
      boundaryAfter: 0
    })).toMatchObject({
      identicalBoundary: true,
      repeatedEndpointPause: false,
      passes: true
    });
  });
});
