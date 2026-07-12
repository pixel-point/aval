import type {
  GraphBodyDefinition,
  GraphEdgeDefinition,
  GraphStateDefinition
} from "@rendered-motion/graph";

import type {
  ReadinessFailureCollector,
  ReadinessSourceFrameReport
} from "./readiness-evaluator-types.js";
import {
  planSubmissionHorizon,
  planUnresolvedSubmissionHorizon,
  type SourceBodyCursor,
  type SubmissionHorizonDecision
} from "./submission-horizon.js";

/** Enumerate the exact source-submission scenarios accepted by playback. */
export function enumerateEdgeSourceFrames(
  allEdges: readonly Readonly<GraphEdgeDefinition>[],
  edge: Readonly<GraphEdgeDefinition>,
  source: Readonly<GraphStateDefinition>,
  ringCapacity: number,
  availableConsecutiveFrames: number,
  collector: ReadinessFailureCollector
): ReadinessSourceFrameReport[] {
  const outgoingStarts = allEdges
    .filter(({ from }) => from === source.id)
    .map(({ start }) => start);
  const reports: ReadinessSourceFrameReport[] = [];

  for (let frame = 0; frame < source.body.frameCount; frame += 1) {
    const displayed = Object.freeze({ occurrence: 0n, frame });
    const horizon = planUnresolvedSubmissionHorizon({
      body: source.body,
      displayed,
      submitted: displayed,
      outgoingStarts,
      ringCapacity
    });
    const firstAbsolute = cursorAbsolute(source.body, displayed);
    const lastAbsolute = cursorAbsolute(
      source.body,
      horizon.maximumSubmitted
    );
    let scenarioCount = 0;
    let maximumRequiredWaitFrames = 0n;
    let passed = true;

    for (
      let submittedAbsolute = firstAbsolute;
      submittedAbsolute <= lastAbsolute;
      submittedAbsolute += 1n
    ) {
      scenarioCount += 1;
      const decision = planSubmissionHorizon({
        body: source.body,
        edge,
        displayed,
        submitted: cursorFromAbsolute(source.body, submittedAbsolute),
        ringCapacity,
        availableConsecutiveEdgeFrames: availableConsecutiveFrames,
        elapsedWaitFrames: 0
      });
      maximumRequiredWaitFrames = maximumBigInt(
        maximumRequiredWaitFrames,
        decisionRequiredWait(decision)
      );
      if (decision.kind === "reject-readiness") {
        passed = false;
      }
    }

    if (!passed) {
      collector.add(
        "edge-max-wait",
        "an edge start exceeds its authored maximum wait",
        { edge: edge.id, state: source.id, sourceFrame: frame }
      );
    }
    reports.push(Object.freeze({
      frame,
      scenarioCount,
      maximumRequiredWaitFrames,
      passed
    }));
  }
  return reports;
}

function decisionRequiredWait(
  decision: Readonly<SubmissionHorizonDecision>
): bigint {
  switch (decision.kind) {
    case "reject-readiness":
      return decision.requiredWaitFrames;
    case "wait-held":
      return BigInt(
        decision.elapsedWaitFrames + decision.remainingWaitFrames
      );
    case "restart-generation":
    case "commit-edge":
    case "continue-source":
    case "select-portal":
      return BigInt(decision.totalWaitFrames);
  }
}

function cursorAbsolute(
  body: Readonly<GraphBodyDefinition>,
  cursor: Readonly<SourceBodyCursor>
): bigint {
  return cursor.occurrence * BigInt(body.frameCount) + BigInt(cursor.frame);
}

function cursorFromAbsolute(
  body: Readonly<GraphBodyDefinition>,
  absolute: bigint
): Readonly<SourceBodyCursor> {
  if (body.kind !== "loop") {
    return Object.freeze({ occurrence: 0n, frame: Number(absolute) });
  }
  const frameCount = BigInt(body.frameCount);
  return Object.freeze({
    occurrence: absolute / frameCount,
    frame: Number(absolute % frameCount)
  });
}

function maximumBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
