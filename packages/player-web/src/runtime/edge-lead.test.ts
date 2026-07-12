import { describe, expect, it } from "vitest";

import {
  calculateRequiredEdgeLeadFrames,
  planEdgeLead
} from "./edge-lead.js";

describe("edge-specific consecutive lead", () => {
  it.each([
    [0, 2],
    [1, 2],
    [2, 3],
    [4, 5],
    [5, 6],
    [6, 6],
    [12, 6]
  ] as const)(
    "requires %s bridge frames plus target entry within a six-frame ring",
    (transitionFrames, required) => {
      expect(calculateRequiredEdgeLeadFrames({
        transitionFrames,
        ringCapacity: 6
      })).toBe(required);
    }
  );

  it("requires two frames for a transitionless edge", () => {
    expect(planEdgeLead({
      transitionFrames: 0,
      ringCapacity: 6,
      availableConsecutiveFrames: 1
    })).toEqual({
      transitionFrames: 0,
      targetEntryOffset: 0,
      firstPresentation: "target-body",
      requiredConsecutiveFrames: 2,
      availableConsecutiveFrames: 1,
      missingConsecutiveFrames: 1,
      ready: false
    });
  });

  it("counts a one-frame bridge and target frame zero before departure", () => {
    const plan = planEdgeLead({
      transitionFrames: 1,
      ringCapacity: 6,
      availableConsecutiveFrames: 2
    });

    expect(plan).toEqual({
      transitionFrames: 1,
      targetEntryOffset: 1,
      firstPresentation: "bridge",
      requiredConsecutiveFrames: 2,
      availableConsecutiveFrames: 2,
      missingConsecutiveFrames: 0,
      ready: true
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("uses the complete short bridge plus target and caps longer bridges", () => {
    expect(calculateRequiredEdgeLeadFrames({
      transitionFrames: 10,
      ringCapacity: 12
    })).toBe(11);
    expect(calculateRequiredEdgeLeadFrames({
      transitionFrames: 11,
      ringCapacity: 12
    })).toBe(12);
    expect(calculateRequiredEdgeLeadFrames({
      transitionFrames: 12,
      ringCapacity: 12
    })).toBe(12);
    expect(calculateRequiredEdgeLeadFrames({
      transitionFrames: 120,
      ringCapacity: 12
    })).toBe(12);
  });

  it("accepts exactly the required measured lead and rejects one less", () => {
    expect(planEdgeLead({
      transitionFrames: 4,
      ringCapacity: 6,
      availableConsecutiveFrames: 4
    })).toMatchObject({ ready: false, missingConsecutiveFrames: 1 });
    expect(planEdgeLead({
      transitionFrames: 4,
      ringCapacity: 6,
      availableConsecutiveFrames: 5
    })).toMatchObject({ ready: true, missingConsecutiveFrames: 0 });
  });

  it.each([0, 5, 13, Number.MAX_SAFE_INTEGER])(
    "rejects ring capacity %s outside 6-12",
    (ringCapacity) => {
      expect(() => calculateRequiredEdgeLeadFrames({
        transitionFrames: 0,
        ringCapacity
      })).toThrow(RangeError);
    }
  );

  it("rejects unsafe transition arithmetic and impossible measured lead", () => {
    expect(() => calculateRequiredEdgeLeadFrames({
      transitionFrames: Number.MAX_SAFE_INTEGER,
      ringCapacity: 12
    })).toThrow("safe successor");
    expect(() => planEdgeLead({
      transitionFrames: 0,
      ringCapacity: 6,
      availableConsecutiveFrames: 7
    })).toThrow("available consecutive");
    expect(() => planEdgeLead({
      transitionFrames: -1,
      ringCapacity: 6,
      availableConsecutiveFrames: 0
    })).toThrow(RangeError);
  });
});
