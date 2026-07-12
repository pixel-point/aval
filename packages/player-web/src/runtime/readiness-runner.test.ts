import { describe, expect, it } from "vitest";

import {
  runAllRoutesReadiness,
  type ReadinessRunnerAdapters
} from "./readiness-runner.js";
import {
  passingMeasurements,
  readinessFixture
} from "./readiness-test-fixture.js";

describe("injectable all-routes readiness runner", () => {
  it("drives every adapter, honors hint order, and evaluates the complete set", async () => {
    const fixture = readinessFixture();
    const calls: string[] = [];
    const result = await runAllRoutesReadiness({
      ...fixture,
      adapters: passingAdapters(calls)
    });

    expect(result.passed).toBe(true);
    expect(result.evaluation?.evaluatedEdgeIds).toEqual(
      fixture.graph.definition.edges.map(({ id }) => id)
    );
    const routeCalls = calls.filter((call) => call.startsWith("phase:"));
    expect(routeCalls.slice(0, 2)).toEqual([
      "phase:edge-cut",
      "phase:edge-locked"
    ]);
    expect(new Set(routeCalls.map((call) => call.slice(6)))).toEqual(
      new Set(fixture.graph.definition.edges.map(({ id }) => id))
    );
    expect(calls).toEqual(expect.arrayContaining([
      "warmup",
      "loop:body-idle",
      "dry:edge-finish",
      "dry:edge-locked",
      "cut:edge-cut",
      "endpoint:rev:finite",
      "endpoint:rev:held",
      "inverse:rev",
      "resource",
      "ring"
    ]));
    expect(result.evaluation?.warmupMetrics.sampleCount).toBe(24);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("turns one injected resource rejection into total candidate failure", async () => {
    const fixture = readinessFixture();
    const adapters = passingAdapters([]);
    const result = await runAllRoutesReadiness({
      ...fixture,
      adapters: {
        ...adapters,
        measureResource: () => ({
          passed: false,
          totalBytes: 2_001,
          capBytes: 2_000
        })
      }
    });

    expect(result.passed).toBe(false);
    expect(result.evaluation?.failures.map(({ code }) => code)).toContain(
      "resource-plan"
    );
    expect(result.failure).toMatchObject({ code: "readiness-failure" });
  });

  it("normalizes an adapter throw without inventing a partial report", async () => {
    const fixture = readinessFixture();
    const adapters = passingAdapters([]);
    const result = await runAllRoutesReadiness({
      ...fixture,
      adapters: {
        ...adapters,
        dryRunEdge: () => {
          throw new Error("decoder exploded");
        }
      }
    });

    expect(result.passed).toBe(false);
    expect(result.evaluation).toBeNull();
    expect(result.failure).toMatchObject({
      code: "readiness-failure",
      context: { operation: "all-routes-readiness-runner" }
    });
    expect(result.failure?.message.length).toBeLessThanOrEqual(512);
  });

  it("fails fast after upload-inclusive warmup failure", async () => {
    const fixture = readinessFixture();
    const calls: string[] = [];
    const adapters = passingAdapters(calls);
    const slowUploads = passingMeasurements("warmup", "body-idle").map(
      (measurement, index) => Object.freeze({
        ...measurement,
        uploadReadyTimeMs: 2_000 + index * 100
      })
    );
    const result = await runAllRoutesReadiness({
      ...fixture,
      adapters: {
        ...adapters,
        measureWarmup: () => {
          calls.push("warmup");
          return { measurements: slowUploads };
        }
      }
    });

    expect(result).toMatchObject({ passed: false, evaluation: null });
    expect(calls).toEqual(["warmup"]);
  });
});

function passingAdapters(calls: string[]): ReadinessRunnerAdapters {
  return {
    measureWarmup: () => {
      calls.push("warmup");
      return { measurements: passingMeasurements("warmup", "body-idle") };
    },
    measureLoop: ({ unit, ringCapacity }) => {
      calls.push(`loop:${unit.id}`);
      return {
        seamReady: true,
        availableHeadroomFrames: ringCapacity
      };
    },
    dryRunEdge: ({ edge, targetProbeFrames }) => {
      calls.push(`dry:${edge.id}`);
      const transitionFrames = edge.transition?.kind === "locked"
        ? edge.transition.frameCount
        : 0;
      return {
        measurements: passingMeasurements(`edge:${edge.id}`, edge.id),
        availableConsecutiveFrames: Math.max(2, transitionFrames + 1),
        transitionFrames,
        targetProbeFrames,
        sequenceFrameCount: transitionFrames + targetProbeFrames,
        completeSequence: true,
        deadlineSafe: true,
        withinBudget: true
      };
    },
    prepareCut: ({ edge }) => {
      calls.push(`cut:${edge.id}`);
      return {
        runwayPrepared: true,
        responseFrames: 1,
        runwayFrames: 6,
        continuationFrame: 6,
        recoveryFrames: 5,
        deadlineSafe: true,
        withinBudget: true
      };
    },
    prepareEndpoint: ({ unit, endpoint }) => {
      calls.push(`endpoint:${unit.id}:${endpoint.state}`);
      return {
        runwayPrepared: true,
        runwayFrames: endpoint.frames,
        continuationFrame: endpoint.frames,
        recoveryFrames: endpoint.frames - 1,
        deadlineSafe: true,
        withinBudget: true
      };
    },
    simulateRoutePhases: ({ edge }) => {
      calls.push(`phase:${edge.id}`);
      return {
        pendingCancellationReady: true,
        pendingReplacementReady: true,
        prospectiveTargetReady: true,
        lockedFollowOnReady: true
      };
    },
    measureActiveInverse: ({ unit }) => {
      calls.push(`inverse:${unit.id}`);
      return { responseFrames: 1, adjacentFrame: true };
    },
    measureResource: () => {
      calls.push("resource");
      return { passed: true, totalBytes: 1_000, capBytes: 2_000 };
    },
    fillInitialRing: ({ ringCapacity }) => {
      calls.push("ring");
      return { passed: true, frameCount: ringCapacity };
    }
  };
}
