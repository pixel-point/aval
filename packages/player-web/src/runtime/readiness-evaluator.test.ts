import { describe, expect, it } from "vitest";

import {
  evaluateAllRoutesReadiness,
  type AllRoutesReadinessEvidence
} from "./readiness-evaluator.js";
import {
  passingEvidence,
  readinessFixture
} from "./readiness-test-fixture.js";

describe("pure all-routes readiness evaluator", () => {
  it("enumerates every edge and every valid source-body frame", () => {
    const fixture = readinessFixture();
    const report = evaluateAllRoutesReadiness({
      ...fixture,
      evidence: passingEvidence()
    });

    expect(report.passed).toBe(true);
    expect(report.evaluatedEdgeIds).toEqual([
      "edge-cut",
      "edge-finish",
      "edge-locked",
      "edge-rev-forward",
      "edge-rev-reverse"
    ]);
    expect(fixture.manifest.readiness.immediateEdges).toEqual([
      "edge-cut",
      "edge-locked"
    ]);
    expect(report.edges.map((edge) => [
      edge.edge,
      edge.sourceFrames.length
    ])).toEqual([
      ["edge-cut", 4],
      ["edge-finish", 3],
      ["edge-locked", 4],
      ["edge-rev-forward", 3],
      ["edge-rev-reverse", 1]
    ]);
    expect(report.edges.every((edge) =>
      edge.sourceFrames.every((frame) => frame.scenarioCount >= 1)
    )).toBe(true);
    expect(report.failures).toEqual([]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.edges)).toBe(true);
    expect(Object.isFrozen(report.edges[0]?.sourceFrames)).toBe(true);
    expect(Object.isFrozen(report.evaluatedEdgeIds)).toBe(true);
    expect(Object.isFrozen(report.warmupMetrics)).toBe(true);
    expect(Object.isFrozen(report.warmupMetrics.frames)).toBe(true);
  });

  it.each([
    ["route", failRoute, "edge-sequence"],
    ["endpoint", failEndpoint, "endpoint-recovery"],
    ["cut", failCut, "cut-runway"],
    ["loop", failLoop, "loop-headroom"],
    ["resource", failResource, "resource-plan"]
  ] as const)(
    "rejects the whole candidate when exactly one %s term fails",
    (_label, mutate, expectedCode) => {
      const fixture = readinessFixture();
      const report = evaluateAllRoutesReadiness({
        ...fixture,
        evidence: mutate(passingEvidence())
      });

      expect(report.passed).toBe(false);
      expect(report.failures.map(({ code }) => code)).toContain(expectedCode);
      expect(report.evaluatedEdgeIds).toHaveLength(fixture.graph.definition.edges.length);
    }
  );

  it("rejects every incomplete phase simulation and active inverse", () => {
    const fixture = readinessFixture();
    let evidence = passingEvidence();
    evidence = replaceEvidence(evidence, {
      phases: evidence.phases.map((phase) => phase.edge === "edge-locked"
        ? Object.freeze({
            ...phase,
            pendingCancellationReady: false,
            pendingReplacementReady: false,
            prospectiveTargetReady: false,
            lockedFollowOnReady: false
          })
        : phase),
      inverses: evidence.inverses.map((inverse) => Object.freeze({
        ...inverse,
        responseFrames: 2,
        adjacentFrame: false
      }))
    });

    const report = evaluateAllRoutesReadiness({ ...fixture, evidence });
    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "pending-cancellation",
        "pending-replacement",
        "prospective-target",
        "locked-follow-on",
        "active-inverse"
      ])
    );
  });

  it("rejects missing evidence instead of reporting partial readiness", () => {
    const fixture = readinessFixture();
    const evidence = passingEvidence();
    const report = evaluateAllRoutesReadiness({
      ...fixture,
      evidence: replaceEvidence(evidence, {
        edgeDryRuns: evidence.edgeDryRuns.filter(
          ({ edge }) => edge !== "edge-finish"
        ),
        phases: evidence.phases.filter(({ edge }) => edge !== "edge-cut"),
        endpoints: evidence.endpoints.slice(1),
        cuts: []
      })
    });

    expect(report.passed).toBe(false);
    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "missing-edge-dry-run",
        "missing-route-phase",
        "missing-endpoint",
        "missing-cut"
      ])
    );
  });

  it("checks every measured sequence, runway, deadline, and budget term", () => {
    const fixture = readinessFixture();
    const evidence = passingEvidence();
    const report = evaluateAllRoutesReadiness({
      ...fixture,
      evidence: replaceEvidence(evidence, {
        loops: evidence.loops.map((loop) => Object.freeze({
          ...loop,
          seamReady: false
        })),
        edgeDryRuns: evidence.edgeDryRuns.map((edge) =>
          edge.edge === "edge-finish"
            ? Object.freeze({
                ...edge,
                metrics: Object.freeze({ ...edge.metrics, passed: false }),
                availableConsecutiveFrames: 0,
                transitionFrames: 1,
                targetProbeFrames: 7,
                sequenceFrameCount: 0,
                completeSequence: false,
                deadlineSafe: false,
                withinBudget: false
              })
            : edge
        ),
        cuts: evidence.cuts.map((cut) => Object.freeze({
          ...cut,
          runwayPrepared: false,
          responseFrames: 2,
          runwayFrames: 5,
          continuationFrame: 4,
          recoveryFrames: 6,
          deadlineSafe: false,
          withinBudget: false
        })),
        endpoints: evidence.endpoints.map((endpoint, index) => index === 0
          ? Object.freeze({
              ...endpoint,
              runwayPrepared: false,
              runwayFrames: 5,
              continuationFrame: 4,
              recoveryFrames: 6,
              deadlineSafe: false,
              withinBudget: false
            })
          : endpoint),
        phases: Object.freeze([...evidence.phases, evidence.phases[0]!]),
        initialRing: Object.freeze({ passed: false, frameCount: 0 })
      })
    });

    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "loop-seam",
        "edge-metrics",
        "edge-sequence",
        "edge-lead",
        "edge-deadline",
        "edge-budget",
        "cut-response",
        "cut-runway",
        "cut-deadline",
        "cut-budget",
        "endpoint-runway",
        "endpoint-recovery",
        "endpoint-deadline",
        "endpoint-budget",
        "duplicate-evidence",
        "initial-ring"
      ])
    );
  });

  it("requires every loop and reversible inverse measurement", () => {
    const fixture = readinessFixture();
    const evidence = passingEvidence();
    const report = evaluateAllRoutesReadiness({
      ...fixture,
      evidence: replaceEvidence(evidence, { loops: [], inverses: [] })
    });

    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["missing-loop", "missing-inverse"])
    );
  });
});

function failRoute(evidence: AllRoutesReadinessEvidence) {
  return replaceEvidence(evidence, {
    edgeDryRuns: evidence.edgeDryRuns.map((edge) =>
      edge.edge === "edge-locked"
        ? Object.freeze({ ...edge, completeSequence: false })
        : edge
    )
  });
}

function failEndpoint(evidence: AllRoutesReadinessEvidence) {
  return replaceEvidence(evidence, {
    endpoints: evidence.endpoints.map((endpoint, index) => index === 0
      ? Object.freeze({ ...endpoint, recoveryFrames: 7 })
      : endpoint)
  });
}

function failCut(evidence: AllRoutesReadinessEvidence) {
  return replaceEvidence(evidence, {
    cuts: evidence.cuts.map((cut) =>
      Object.freeze({ ...cut, runwayPrepared: false })
    )
  });
}

function failLoop(evidence: AllRoutesReadinessEvidence) {
  return replaceEvidence(evidence, {
    loops: evidence.loops.map((loop) =>
      Object.freeze({ ...loop, availableHeadroomFrames: 5 })
    )
  });
}

function failResource(evidence: AllRoutesReadinessEvidence) {
  return replaceEvidence(evidence, {
    resource: Object.freeze({ ...evidence.resource, passed: false })
  });
}

function replaceEvidence(
  evidence: AllRoutesReadinessEvidence,
  changes: Partial<AllRoutesReadinessEvidence>
): AllRoutesReadinessEvidence {
  return Object.freeze({ ...evidence, ...changes });
}
