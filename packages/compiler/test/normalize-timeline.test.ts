import { describe, expect, it } from "vitest";

import { normalizeHoldTimeline } from "../src/compile/normalize-timeline.js";

describe("hold timeline normalization", () => {
  it("selects the latest source frame at each exact rational target tick", () => {
    const result = normalizeHoldTimeline([
      { index: 0, timestampTicks: 1_000_000, durationTicks: 20_000 },
      { index: 1, timestampTicks: 1_020_000, durationTicks: 50_000 },
      { index: 2, timestampTicks: 1_070_000, durationTicks: 30_000 }
    ], { numerator: 50, denominator: 1 }, {
      numerator: 1,
      denominator: 1_000_000
    });
    expect(result.sourceFrameByOutputFrame).toEqual([0, 1, 1, 1, 2]);
    expect(result.duplicatedSourceFrames).toEqual([1]);
    expect(result.droppedSourceFrames).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("reports source frames skipped by a lower target rate", () => {
    const result = normalizeHoldTimeline([
      { index: 0, timestampTicks: 0, durationTicks: 10_000 },
      { index: 1, timestampTicks: 10_000, durationTicks: 10_000 },
      { index: 2, timestampTicks: 20_000, durationTicks: 10_000 },
      { index: 3, timestampTicks: 30_000, durationTicks: 10_000 }
    ], { numerator: 25, denominator: 1 }, {
      numerator: 1,
      denominator: 1_000_000
    });
    expect(result.sourceFrameByOutputFrame).toEqual([0]);
    expect(result.droppedSourceFrames).toEqual([1, 2, 3]);
  });

  it("does not round an unsafe end-tick sum down onto an output boundary", () => {
    const ticksPerSecond = 2 ** 52;
    const result = normalizeHoldTimeline([
      {
        index: 0,
        timestampTicks: -ticksPerSecond,
        durationTicks: 1
      },
      {
        index: 1,
        timestampTicks: ticksPerSecond,
        durationTicks: 1
      }
    ], { numerator: 1, denominator: 1 }, {
      numerator: 1,
      denominator: ticksPerSecond
    });
    expect(result.sourceFrameByOutputFrame).toEqual([0, 0, 1]);
  });
});
