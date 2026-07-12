import { describe, expect, it } from "vitest";

import {
  MAX_READINESS_RING_CAPACITY,
  MIN_READINESS_MEASURED_OUTPUTS,
  MIN_READINESS_THROUGHPUT_MULTIPLE,
  ReadinessMetricsRecorder,
  calculateReadinessMetrics,
  idealReadinessDeadlineMs,
  nearestRankPercentile,
  type ReadinessFrameMeasurement
} from "./readiness-metrics.js";

describe("readiness measurement statistics", () => {
  it("uses nearest-rank p99 and returns a deeply immutable report", () => {
    const measurements = measurementsWithLatencies(
      Array.from({ length: 24 }, (_, index) => index === 23 ? 40 : 4)
    );
    const report = calculateReadinessMetrics({
      frameRate: { numerator: 30, denominator: 1 },
      measurements
    });

    expect(report.sampleCount).toBe(MIN_READINESS_MEASURED_OUTPUTS);
    expect(report.p99DecodeLatencyMs).toBe(40);
    expect(report.p99UploadLatencyMs).toBe(42);
    expect(report.passed).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.frameRate)).toBe(true);
    expect(Object.isFrozen(report.frames)).toBe(true);
    expect(report.frames.every((frame) =>
      Object.isFrozen(frame) && Object.isFrozen(frame.media)
    )).toBe(true);

    measurements[0]!.media.path = "mutated";
    expect(report.frames[0]?.media.path).toBe("warmup");
  });

  it("implements the exact nearest-rank rule, including ties", () => {
    expect(nearestRankPercentile([4, 1, 4, 2], 0.5)).toBe(2);
    expect(nearestRankPercentile([4, 1, 4, 2], 0.75)).toBe(4);
    expect(nearestRankPercentile(
      Array.from({ length: 24 }, (_, index) => index),
      0.99
    )).toBe(23);
  });

  it("uses exact rational ideal deadlines for fractional frame rates", () => {
    const rate = { numerator: 30_000, denominator: 1_001 } as const;

    expect([
      idealReadinessDeadlineMs(100, 0, rate),
      idealReadinessDeadlineMs(100, 1, rate),
      idealReadinessDeadlineMs(100, 2, rate),
      idealReadinessDeadlineMs(100, 3, rate)
    ]).toEqual([100, 133.367, 166.733, 200.1]);

    const report = calculateReadinessMetrics({
      frameRate: rate,
      measurements: measurementsWithLatencies(
        Array.from({ length: 24 }, () => 5),
        rate
      )
    });
    expect(report.nominalFrameDurationMs).toBeCloseTo(1001 / 30, 12);
  });

  it("accepts zero and very fast elapsed intervals without division failure", () => {
    const zeroMeasurements = measurementsWithLatencies(
      Array.from({ length: 24 }, () => 0),
      { numerator: 30, denominator: 1 },
      { allSubmittedAtMs: 0, allOutputsAtMs: 0 }
    );
    for (const measurement of zeroMeasurements) {
      measurement.uploadReadyTimeMs = 0;
    }
    const zero = calculateReadinessMetrics({
      frameRate: { numerator: 30, denominator: 1 },
      measurements: zeroMeasurements
    });
    expect(zero.throughputMultiple).toBe(Number.POSITIVE_INFINITY);
    expect(zero.throughputPassed).toBe(true);

    const fast = calculateReadinessMetrics({
      frameRate: { numerator: 60, denominator: 1 },
      measurements: measurementsWithLatencies(
        Array.from({ length: 24 }, () => 0.001),
        { numerator: 60, denominator: 1 },
        { allSubmittedAtMs: 0 }
      )
    });
    expect(fast.throughputMultiple).toBeGreaterThan(100);
    expect(fast.throughputPassed).toBe(true);
  });

  it("passes the exact 1.5x throughput boundary and rejects below it", () => {
    const count = 24;
    const mediaDurationMs = count * 100;
    const exactElapsedMs = mediaDurationMs /
      MIN_READINESS_THROUGHPUT_MULTIPLE;
    const exact = calculateReadinessMetrics({
      frameRate: { numerator: 10, denominator: 1 },
      measurements: measurementsEndingAt(count, exactElapsedMs)
    });
    const below = calculateReadinessMetrics({
      frameRate: { numerator: 10, denominator: 1 },
      measurements: measurementsEndingAt(count, exactElapsedMs + 0.001)
    });

    expect(exact.throughputMultiple).toBe(1.5);
    expect(exact.throughputPassed).toBe(true);
    expect(below.throughputMultiple).toBeLessThan(1.5);
    expect(below.throughputPassed).toBe(false);
    expect(below.failureReasons).toContain("throughput");
  });

  it("gates throughput at upload readiness rather than decoder output", () => {
    const measurements = measurementsEndingAt(24, 100);
    for (let index = 0; index < measurements.length; index += 1) {
      measurements[index]!.uploadReadyTimeMs = 2_000 * (index + 1) / 24;
    }
    const report = calculateReadinessMetrics({
      frameRate: { numerator: 10, denominator: 1 },
      measurements
    });

    expect(measurements.at(-1)!.workerOutputTimeMs).toBe(100);
    expect(report.measuredIntervalMs).toBe(2_000);
    expect(report.throughputPassed).toBe(false);
    expect(report.failureReasons).toContain("throughput");
  });

  it("tracks upload readiness separately and computes rolling minimum lead", () => {
    const measurements = measurementsWithLatencies(
      Array.from({ length: 24 }, () => 2)
    );
    for (let index = 5; index < measurements.length; index += 1) {
      measurements[index]!.uploadReadyTimeMs = 290 + (index - 5) * 5;
    }

    const report = calculateReadinessMetrics({
      frameRate: { numerator: 30, denominator: 1 },
      measurements
    });

    expect(report.p99UploadLatencyMs).toBeGreaterThan(
      report.p99DecodeLatencyMs
    );
    expect(report.frames[5]?.uploadLeadMs).toBe(10);
    expect(report.frames[5]?.rollingMinimumUploadLeadMs).toBe(10);
    expect(report.frames[6]?.rollingMinimumUploadLeadMs).toBe(10);
    expect(report.minimumUploadLeadMs).toBe(10);
  });

  it("accepts decode lead 11 with its extra ring margin and rejects lead 12", () => {
    const eleven = calculateReadinessMetrics({
      frameRate: { numerator: 10, denominator: 1 },
      measurements: measurementsWithLatencies(
        Array.from({ length: 24 }, () => 1_000),
        { numerator: 10, denominator: 1 },
        { allSubmittedAtMs: 0 }
      )
    });
    const twelve = calculateReadinessMetrics({
      frameRate: { numerator: 10, denominator: 1 },
      measurements: measurementsWithLatencies(
        Array.from({ length: 24 }, () => 1_000.001),
        { numerator: 10, denominator: 1 },
        { allSubmittedAtMs: 0 }
      )
    });

    expect(eleven.decodeLeadFrames).toBe(11);
    expect(eleven.uploadLeadFrames).toBe(12);
    expect(eleven.recoveryLeadFrames).toBe(12);
    expect(eleven.requiredRingCapacity).toBe(12);
    expect(eleven.ringCapacity).toBe(MAX_READINESS_RING_CAPACITY);
    expect(eleven.ringPassed).toBe(true);
    expect(twelve.decodeLeadFrames).toBe(12);
    expect(twelve.requiredRingCapacity).toBe(13);
    expect(twelve.ringCapacity).toBeNull();
    expect(twelve.ringPassed).toBe(false);
    expect(twelve.failureReasons).toContain("ring-capacity");
  });

  it("reports insufficient samples instead of promoting partial readiness", () => {
    const report = calculateReadinessMetrics({
      frameRate: { numerator: 30, denominator: 1 },
      measurements: measurementsWithLatencies(
        Array.from({ length: 23 }, () => 1)
      )
    });

    expect(report.measuredOutputsPassed).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.failureReasons).toContain("measured-output-count");
  });

  it("records from an injected monotonic clock and rejects clock regression", () => {
    const times = [0, 1, 2, 1.5];
    const recorder = new ReadinessMetricsRecorder({
      frameRate: { numerator: 30, denominator: 1 },
      now: () => times.shift() ?? 0
    });

    recorder.submit({
      outputOrdinal: 7,
      media: media(0),
      idealDeadlineMs: 40
    });
    recorder.workerOutput(7);
    recorder.uploadReady(7);
    expect(() => recorder.submit({
      outputOrdinal: 8,
      media: media(1),
      idealDeadlineMs: 80
    })).toThrow("monotonic");
  });

  it("rejects invalid ordering, hostile values, and incomplete recorder data", () => {
    const invalid = measurementsWithLatencies(
      Array.from({ length: 24 }, () => 1)
    );
    invalid[1]!.outputOrdinal = invalid[0]!.outputOrdinal;
    expect(() => calculateReadinessMetrics({
      frameRate: { numerator: 30, denominator: 1 },
      measurements: invalid
    })).toThrow("output ordinals");

    const recorder = new ReadinessMetricsRecorder({
      frameRate: { numerator: 30, denominator: 1 },
      now: () => 0
    });
    recorder.submit({
      outputOrdinal: 1,
      media: media(0),
      idealDeadlineMs: 10
    });
    expect(() => recorder.report()).toThrow("incomplete");
    expect(() => nearestRankPercentile([], 0.99)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1, Number.NaN], 0.99))
      .toThrow(RangeError);
  });
});

interface MutableMeasurement extends Omit<ReadinessFrameMeasurement, "media"> {
  outputOrdinal: number;
  idealDeadlineMs: number;
  uploadReadyTimeMs: number;
  readonly media: {
    path: string;
    unit: string;
    unitInstance: number;
    localFrame: number;
  };
}

function measurementsWithLatencies(
  latencies: readonly number[],
  frameRate = { numerator: 30, denominator: 1 },
  options: {
    readonly allSubmittedAtMs?: number;
    readonly allOutputsAtMs?: number;
  } = {}
): MutableMeasurement[] {
  return latencies.map((latency, index) => {
    const submitTimeMs = options.allSubmittedAtMs ?? index * 0.01;
    const workerOutputTimeMs = options.allOutputsAtMs ??
      submitTimeMs + latency;
    return {
      outputOrdinal: 100 + index,
      media: media(index),
      submitTimeMs,
      workerOutputTimeMs,
      uploadReadyTimeMs: workerOutputTimeMs + 2,
      idealDeadlineMs: idealReadinessDeadlineMs(
        100,
        index + 1,
        frameRate
      )
    };
  });
}

function measurementsEndingAt(
  count: number,
  finalOutputTimeMs: number
): MutableMeasurement[] {
  return Array.from({ length: count }, (_, index) => {
    const workerOutputTimeMs = finalOutputTimeMs * (index + 1) / count;
    return {
      outputOrdinal: index,
      media: media(index),
      submitTimeMs: 0,
      workerOutputTimeMs,
      uploadReadyTimeMs: workerOutputTimeMs,
      idealDeadlineMs: (index + 1) * 100
    };
  });
}

function media(index: number): MutableMeasurement["media"] {
  return {
    path: "warmup",
    unit: "body",
    unitInstance: 0,
    localFrame: index
  };
}
