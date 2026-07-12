import { describe, expect, it } from "vitest";

import {
  DecodeTimeline,
  type DecodeSampleMetadata
} from "./decode-timeline.js";
import {
  timestampForFrame,
  type RationalFrameRate
} from "./rational-time.js";

describe("DecodeTimeline", () => {
  it("assigns exact 30,000/1,001 timestamps without accumulating duration", () => {
    const timeline = new DecodeTimeline({
      numerator: 30_000,
      denominator: 1_001
    });

    expect(timeline.activateNextGeneration()).toBe(1);
    const samples = timeline.allocateUnitOccurrence("body", 7);

    expect(samples.map((sample) => sample.timestamp)).toEqual([
      0, 33_367, 66_733, 100_100, 133_467, 166_833, 200_200
    ]);
    expect(samples.map((sample) => sample.duration)).toEqual([
      33_367, 33_366, 33_367, 33_367, 33_366, 33_367, 33_367
    ]);
    expect(occurrenceEnd(samples)).toBe(
      timestampForFrame(7, { numerator: 30_000, denominator: 1_001 })
    );
  });

  it.each([
    {
      rate: { numerator: 24, denominator: 1 },
      timestamps: [0, 41_667, 83_333, 125_000]
    },
    {
      rate: { numerator: 30, denominator: 1 },
      timestamps: [0, 33_333, 66_667, 100_000]
    },
    {
      rate: { numerator: 60, denominator: 1 },
      timestamps: [0, 16_667, 33_333, 50_000]
    }
  ] satisfies readonly {
    readonly rate: RationalFrameRate;
    readonly timestamps: readonly number[];
  }[])('uses the exact $rate.numerator/$rate.denominator clock', ({
    rate,
    timestamps
  }) => {
    const timeline = new DecodeTimeline(rate);
    timeline.activateNextGeneration();

    expect(
      timeline.allocateUnitOccurrence("unit", timestamps.length)
        .map((sample) => sample.timestamp)
    ).toEqual(timestamps);
  });

  it("has no long-run drift or duplicate timestamp", () => {
    const frameCount = 100_000;
    const rate = { numerator: 60_000, denominator: 1_001 } as const;
    const timeline = new DecodeTimeline(rate);
    timeline.activateNextGeneration();

    const samples = timeline.allocateUnitOccurrence("long-body", frameCount);
    let accumulatedDuration = 0;
    let previousTimestamp = -1;
    const timestamps = new Set<number>();
    for (const sample of samples) {
      expect(sample.timestamp).toBeGreaterThan(previousTimestamp);
      accumulatedDuration += sample.duration;
      previousTimestamp = sample.timestamp;
      timestamps.add(sample.timestamp);
    }

    expect(timestamps.size).toBe(frameCount);
    expect(accumulatedDuration).toBe(timestampForFrame(frameCount, rate));
    expect(occurrenceEnd(samples)).toBe(
      timestampForFrame(frameCount, rate)
    );
  });

  it("keeps ordinals global and resets only unit instances per generation", () => {
    const timeline = new DecodeTimeline({ numerator: 30, denominator: 1 });

    expect(timeline.activateNextGeneration()).toBe(1);
    const [first, second] = splitAt(
      timeline.allocateUnitOccurrences([
        { unitId: "intro", unitFrameCount: 2 },
        { unitId: "body", unitFrameCount: 3 }
      ]),
      2
    );
    expect(first.map(identity)).toEqual([
      [1, 0, "intro", 0, 0],
      [1, 1, "intro", 0, 1]
    ]);
    expect(second.map(identity)).toEqual([
      [1, 2, "body", 1, 0],
      [1, 3, "body", 1, 1],
      [1, 4, "body", 1, 2]
    ]);

    expect(timeline.activateNextGeneration()).toBe(2);
    const replacement = timeline.allocateUnitOccurrence("body", 2);
    expect(replacement.map(identity)).toEqual([
      [2, 5, "body", 0, 0],
      [2, 6, "body", 0, 1]
    ]);
    expect(replacement[0]?.timestamp).toBeGreaterThan(
      second.at(-1)?.timestamp ?? Number.MAX_SAFE_INTEGER
    );
    expect(timeline.snapshot()).toEqual({
      frameRate: { numerator: 30, denominator: 1 },
      activeGeneration: 2,
      nextOrdinal: 7,
      nextUnitInstance: 1
    });
  });

  it("returns deeply immutable sample metadata and snapshots", () => {
    const rate = { numerator: 24, denominator: 1 };
    const timeline = new DecodeTimeline(rate);
    rate.numerator = 30;
    timeline.activateNextGeneration();

    const samples = timeline.allocateUnitOccurrence("unit", 2);
    const snapshot = timeline.snapshot();

    expect(Object.isFrozen(samples)).toBe(true);
    expect(samples.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.frameRate)).toBe(true);
    expect(snapshot.frameRate).toEqual({ numerator: 24, denominator: 1 });
  });

  it("rejects unsafe timestamp successors atomically", () => {
    const timeline = new DecodeTimeline({
      numerator: 1,
      denominator: 9_007_199_254
    });
    timeline.activateNextGeneration();

    expect(() => timeline.allocateUnitOccurrence("too-long", 2)).toThrow(
      "safe-integer range"
    );
    expect(timeline.snapshot()).toMatchObject({
      activeGeneration: 1,
      nextOrdinal: 0,
      nextUnitInstance: 0
    });

    const first = timeline.allocateUnitOccurrence("last-safe", 1);
    expect(first).toHaveLength(1);
    expect(() => timeline.allocateUnitOccurrence("overflow", 1)).toThrow(
      "safe-integer range"
    );
    expect(timeline.snapshot()).toMatchObject({
      activeGeneration: 1,
      nextOrdinal: 1,
      nextUnitInstance: 1
    });
  });

  it("requires a generation and rejects invalid occurrence metadata atomically", () => {
    const timeline = new DecodeTimeline({ numerator: 30, denominator: 1 });

    expect(() => timeline.allocateUnitOccurrence("unit", 1)).toThrow(
      "active generation"
    );
    expect(timeline.snapshot()).toMatchObject({
      activeGeneration: null,
      nextOrdinal: 0,
      nextUnitInstance: 0
    });

    timeline.activateNextGeneration();
    expect(() => timeline.allocateUnitOccurrences([])).toThrow(RangeError);
    expect(() => timeline.allocateUnitOccurrences([
      { unitId: "valid-first", unitFrameCount: 2 },
      { unitId: "invalid-second", unitFrameCount: 0 }
    ])).toThrow(RangeError);
    for (const [unitId, frameCount] of [
      ["", 1],
      ["x".repeat(129), 1],
      ["unit", 0],
      ["unit", -1],
      ["unit", 1.5],
      ["unit", Number.MAX_SAFE_INTEGER + 1]
    ] as const) {
      expect(() =>
        timeline.allocateUnitOccurrence(unitId, frameCount)
      ).toThrow(RangeError);
    }
    expect(timeline.snapshot()).toMatchObject({
      activeGeneration: 1,
      nextOrdinal: 0,
      nextUnitInstance: 0
    });
  });
});

function identity(sample: DecodeSampleMetadata): readonly [
  number,
  number,
  string,
  number,
  number
] {
  return [
    sample.generation,
    sample.ordinal,
    sample.unitId,
    sample.unitInstance,
    sample.unitFrame
  ];
}

function splitAt<T>(
  values: readonly T[],
  index: number
): readonly [readonly T[], readonly T[]] {
  return [values.slice(0, index), values.slice(index)];
}

function occurrenceEnd(samples: readonly DecodeSampleMetadata[]): number {
  const finalSample = samples.at(-1);
  if (finalSample === undefined) {
    throw new Error("expected a non-empty decode occurrence");
  }
  return finalSample.timestamp + finalSample.duration;
}
