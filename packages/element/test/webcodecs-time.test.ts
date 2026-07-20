import { describe, expect, it } from "vitest";

import { webCodecsTimingForTicks } from "../src/webcodecs-time.js";

describe("webCodecsTimingForTicks", () => {
  it("converts the reordered 30 fps HEVC presentation ticks to microseconds", () => {
    const rate = { numerator: 30, denominator: 1 } as const;
    const decodeOrder = [0, 5, 3, 1, 2, 4, 7, 6];

    expect(
      decodeOrder.map((timestamp) =>
        webCodecsTimingForTicks(timestamp, 1, rate)
      )
    ).toEqual([
      { timestamp: 0, duration: 33_333 },
      { timestamp: 166_667, duration: 33_333 },
      { timestamp: 100_000, duration: 33_333 },
      { timestamp: 33_333, duration: 33_334 },
      { timestamp: 66_667, duration: 33_333 },
      { timestamp: 133_333, duration: 33_334 },
      { timestamp: 233_333, duration: 33_334 },
      { timestamp: 200_000, duration: 33_333 }
    ]);
  });

  it.each([
    {
      rate: { numerator: 24, denominator: 1 },
      timestamps: [0, 41_667, 83_333, 125_000]
    },
    {
      rate: { numerator: 60, denominator: 1 },
      timestamps: [0, 16_667, 33_333, 50_000]
    },
    {
      rate: { numerator: 60_000, denominator: 1_001 },
      timestamps: [0, 16_683, 33_367, 50_050]
    },
    {
      rate: { numerator: 30_000, denominator: 1_001 },
      timestamps: [0, 33_367, 66_733, 100_100]
    }
  ])("uses the exact $rate.numerator/$rate.denominator clock", ({
    rate,
    timestamps
  }) => {
    expect(
      timestamps.map((_, tick) =>
        webCodecsTimingForTicks(tick, 1, rate).timestamp
      )
    ).toEqual(timestamps);
  });

  it("derives every duration from adjacent absolute timestamps without drift", () => {
    const rate = { numerator: 60_000, denominator: 1_001 } as const;
    let accumulatedDuration = 0;

    for (let tick = 0; tick < 100_000; tick += 1) {
      const timing = webCodecsTimingForTicks(tick, 1, rate);
      expect(timing.timestamp).toBe(accumulatedDuration);
      accumulatedDuration += timing.duration;
    }

    expect(accumulatedDuration).toBe(
      webCodecsTimingForTicks(100_000, 0, rate).timestamp
    );
  });

  it("preserves zero-duration hidden chunks", () => {
    expect(
      webCodecsTimingForTicks(7, 0, { numerator: 30, denominator: 1 })
    ).toEqual({ timestamp: 233_333, duration: 0 });
  });

  it.each([
    [-1, 1, 30, 1],
    [0, -1, 30, 1],
    [0, 1, 0, 1],
    [0, 1, 61, 1],
    [Number.MAX_SAFE_INTEGER, 1, 1, 1]
  ])(
    "rejects invalid or unsafe timing (%s, %s, %s/%s)",
    (timestamp, duration, numerator, denominator) => {
      expect(() => webCodecsTimingForTicks(
        timestamp,
        duration,
        { numerator, denominator }
      )).toThrow(RangeError);
    }
  );
});
