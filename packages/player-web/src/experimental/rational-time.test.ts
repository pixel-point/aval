import { describe, expect, it } from "vitest";

import {
  durationForFrame,
  splitVirtualFrame,
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate
} from "./rational-time.js";

describe("rational frame time", () => {
  it("produces the exact 60 fps timestamp and duration sequence", () => {
    const rate: RationalFrameRate = { numerator: 60, denominator: 1 };

    expect(sequence(7, rate)).toEqual([
      0, 16_667, 33_333, 50_000, 66_667, 83_333, 100_000
    ]);
    expect(durationSequence(6, rate)).toEqual([
      16_667, 16_666, 16_667, 16_667, 16_666, 16_667
    ]);
  });

  it("produces the exact 30,000/1,001 timestamp sequence", () => {
    const rate: RationalFrameRate = {
      numerator: 30_000,
      denominator: 1_001
    };

    expect(sequence(7, rate)).toEqual([
      0, 33_367, 66_733, 100_100, 133_467, 166_833, 200_200
    ]);
    expect(durationSequence(6, rate)).toEqual([
      33_367, 33_366, 33_367, 33_367, 33_366, 33_367
    ]);
  });

  it("rounds exact half-microsecond ties upward", () => {
    const rate: RationalFrameRate = {
      numerator: 128,
      denominator: 3
    };

    expect(timestampForFrame(1, rate)).toBe(23_438);
  });

  it("remains strictly monotonic over one million virtual frames", () => {
    const rate: RationalFrameRate = {
      numerator: 60_000,
      denominator: 1_001
    };
    let previous = timestampForFrame(0, rate);

    for (let frame = 1; frame <= 1_000_000; frame += 1) {
      const current = timestampForFrame(frame, rate);
      if (current <= previous) {
        throw new Error(`timestamp stopped advancing at frame ${frame}`);
      }
      previous = current;
    }

    expect(previous).toBe(16_683_333_333);
  });

  it("maps virtual frames to loop iterations without losing bigint range", () => {
    expect(splitVirtualFrame(0, 24)).toEqual({
      iteration: 0n,
      contentFrame: 0
    });
    expect(splitVirtualFrame(49, 24)).toEqual({
      iteration: 2n,
      contentFrame: 1
    });

    const farFrame = BigInt(Number.MAX_SAFE_INTEGER) + 123_456_789n;
    const split = splitVirtualFrame(farFrame, 24);
    expect(split.iteration * 24n + BigInt(split.contentFrame)).toBe(farFrame);
  });

  it.each([
    { numerator: 0, denominator: 1 },
    { numerator: -1, denominator: 1 },
    { numerator: 1.5, denominator: 1 },
    { numerator: Number.NaN, denominator: 1 },
    { numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 },
    { numerator: 1, denominator: 0 },
    { numerator: 1, denominator: -1 },
    { numerator: 1, denominator: 1.5 },
    { numerator: 61, denominator: 1 },
    { numerator: 60_001, denominator: 1_000 }
  ])("rejects an invalid rate: $numerator/$denominator", (rate) => {
    expect(() => validateFrameRate(rate)).toThrow(RangeError);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid numeric virtual frame %s",
    (frame) => {
      expect(() => timestampForFrame(frame, { numerator: 60, denominator: 1 }))
        .toThrow(RangeError);
    }
  );

  it("rejects negative bigint frames and unsafe timestamp results", () => {
    expect(() =>
      timestampForFrame(-1n, { numerator: 60, denominator: 1 })
    ).toThrow(RangeError);
    expect(() =>
      timestampForFrame(BigInt(Number.MAX_SAFE_INTEGER), {
        numerator: 1,
        denominator: 1
      })
    ).toThrow("safe-integer range");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid loop frame count %s",
    (count) => {
      expect(() => splitVirtualFrame(0, count)).toThrow(RangeError);
    }
  );
});

function sequence(length: number, rate: RationalFrameRate): number[] {
  return Array.from({ length }, (_, frame) =>
    timestampForFrame(frame, rate)
  );
}

function durationSequence(
  length: number,
  rate: RationalFrameRate
): number[] {
  return Array.from({ length }, (_, frame) => durationForFrame(frame, rate));
}
