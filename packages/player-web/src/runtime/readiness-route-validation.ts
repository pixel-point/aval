import type { CompiledManifestV01, EdgeV01 } from "@rendered-motion/format";
import type {
  GraphEdgeDefinition,
  ValidatedMotionGraph
} from "@rendered-motion/graph";

import { planEdgeLead } from "./edge-lead.js";
import type {
  CutReadinessEvidence,
  EdgeDryRunEvidence,
  LoopReadinessEvidence,
  ReadinessFailureCollector,
  RoutePhaseEvidence
} from "./readiness-evaluator-types.js";
import {
  MAX_READINESS_RING_CAPACITY,
  MIN_READINESS_RING_CAPACITY,
  type ReadinessMetricsReport
} from "./readiness-metrics.js";

export function selectedReadinessRingCapacity(
  metrics: Readonly<ReadinessMetricsReport>
): number {
  return validReadinessRingCapacity(metrics.ringCapacity)
    ? metrics.ringCapacity
    : MAX_READINESS_RING_CAPACITY;
}

export function targetProbeFramesForMetrics(
  metrics: Readonly<ReadinessMetricsReport>
): number {
  return clamp(
    metrics.recoveryLeadFrames,
    MIN_READINESS_RING_CAPACITY,
    MAX_READINESS_RING_CAPACITY
  );
}

export function verifyWarmup(
  manifest: Readonly<CompiledManifestV01>,
  metrics: Readonly<ReadinessMetricsReport>,
  collector: ReadinessFailureCollector
): void {
  if (manifest.readiness.policy !== "all-routes") {
    collector.add("policy", "readiness policy is not all-routes");
  }
  if (!metrics.passed || !validReadinessRingCapacity(metrics.ringCapacity)) {
    collector.add(
      "warmup-metrics",
      "warm-up measurements do not establish a valid presentation ring"
    );
  }
}

export function verifyLoops(
  manifest: Readonly<CompiledManifestV01>,
  evidence: ReadonlyMap<string, Readonly<LoopReadinessEvidence>>,
  ringCapacity: number,
  collector: ReadinessFailureCollector
): void {
  for (const unit of manifest.units) {
    if (unit.kind !== "body" || unit.playback !== "loop") {
      continue;
    }
    const loop = evidence.get(unit.id);
    if (loop === undefined) {
      collector.add("missing-loop", "loop readiness evidence is missing", {
        unit: unit.id
      });
      continue;
    }
    if (!loop.seamReady) {
      collector.add("loop-seam", "loop seam was not prepared", {
        unit: unit.id
      });
    }
    if (
      !isNonNegativeSafeInteger(loop.availableHeadroomFrames) ||
      loop.availableHeadroomFrames < ringCapacity
    ) {
      collector.add(
        "loop-headroom",
        "loop headroom does not cover the presentation ring",
        { unit: unit.id }
      );
    }
  }
}

export function verifyGraphCorrespondence(
  manifest: Readonly<CompiledManifestV01>,
  graph: Readonly<ValidatedMotionGraph>,
  graphEdges: ReadonlyMap<string, Readonly<GraphEdgeDefinition>>,
  collector: ReadinessFailureCollector
): void {
  const manifestIds = new Set(manifest.edges.map(({ id }) => id));
  for (const edge of manifest.edges) {
    if (!graphEdges.has(edge.id)) {
      collector.add(
        "manifest-graph",
        "a manifest edge is absent from the validated graph",
        { edge: edge.id }
      );
    }
  }
  for (const edge of graph.definition.edges) {
    if (!manifestIds.has(edge.id)) {
      collector.add(
        "manifest-graph",
        "the validated graph contains an undeclared edge",
        { edge: edge.id }
      );
    }
  }
}

export function verifyEdgeDryRun(
  edge: Readonly<GraphEdgeDefinition>,
  dryRun: Readonly<EdgeDryRunEvidence> | undefined,
  ringCapacity: number,
  targetProbeFrames: number,
  collector: ReadinessFailureCollector
): Readonly<EdgeDryRunEvidence> | undefined {
  if (isResidentEdge(edge)) {
    return undefined;
  }
  if (dryRun === undefined) {
    collector.add(
      "missing-edge-dry-run",
      "nonresident edge dry-run evidence is missing",
      { edge: edge.id }
    );
    return undefined;
  }

  const transitionFrames = edge.transition?.kind === "locked"
    ? edge.transition.frameCount
    : 0;
  if (
    !dryRun.metrics.passed ||
    dryRun.metrics.ringCapacity === null ||
    dryRun.metrics.ringCapacity > ringCapacity
  ) {
    collector.add("edge-metrics", "edge dry-run metrics failed", {
      edge: edge.id
    });
  }
  if (
    dryRun.transitionFrames !== transitionFrames ||
    dryRun.targetProbeFrames !== targetProbeFrames ||
    dryRun.sequenceFrameCount !== transitionFrames + targetProbeFrames ||
    !dryRun.completeSequence
  ) {
    collector.add(
      "edge-sequence",
      "edge dry run did not cover the complete bridge and target probe",
      { edge: edge.id }
    );
  }
  verifyMeasuredLead(edge, dryRun, transitionFrames, ringCapacity, collector);
  if (!dryRun.deadlineSafe || dryRun.metrics.minimumUploadLeadMs < 0) {
    collector.add("edge-deadline", "edge upload deadlines were not met", {
      edge: edge.id
    });
  }
  if (!dryRun.withinBudget) {
    collector.add("edge-budget", "edge dry run exceeded its budget", {
      edge: edge.id
    });
  }
  return dryRun;
}

export function verifyRoutePhases(
  edge: Readonly<GraphEdgeDefinition>,
  phase: Readonly<RoutePhaseEvidence> | undefined,
  collector: ReadinessFailureCollector
): void {
  if (phase === undefined) {
    collector.add(
      "missing-route-phase",
      "route phase simulation is missing",
      { edge: edge.id }
    );
    return;
  }
  if (!phase.pendingCancellationReady) {
    collector.add(
      "pending-cancellation",
      "pending cancellation did not preserve a prepared presentation",
      { edge: edge.id }
    );
  }
  if (!phase.pendingReplacementReady) {
    collector.add(
      "pending-replacement",
      "pending replacement did not preserve a prepared presentation",
      { edge: edge.id }
    );
  }
  if (!phase.prospectiveTargetReady) {
    collector.add(
      "prospective-target",
      "prospective target routing did not remain prepared",
      { edge: edge.id }
    );
  }
  if (edge.transition?.kind === "locked" && !phase.lockedFollowOnReady) {
    collector.add(
      "locked-follow-on",
      "locked follow-on routing did not remain prepared",
      { edge: edge.id }
    );
  }
}

export function verifyCut(
  edge: Readonly<EdgeV01>,
  cut: Readonly<CutReadinessEvidence> | undefined,
  collector: ReadinessFailureCollector
): void {
  if (edge.start.type !== "cut") {
    return;
  }
  if (cut === undefined) {
    collector.add("missing-cut", "cut runway evidence is missing", {
      edge: edge.id
    });
    return;
  }
  if (cut.responseFrames !== 1) {
    collector.add("cut-response", "cut did not respond in one content tick", {
      edge: edge.id
    });
  }
  if (
    !cut.runwayPrepared ||
    cut.runwayFrames !== edge.targetRunwayFrames ||
    cut.continuationFrame !== cut.runwayFrames
  ) {
    collector.add("cut-runway", "cut runway is incomplete", {
      edge: edge.id
    });
  }
  if (
    !isNonNegativeSafeInteger(cut.recoveryFrames) ||
    cut.recoveryFrames >= cut.runwayFrames
  ) {
    collector.add(
      "cut-runway",
      "cut continuation did not recover within its resident runway",
      { edge: edge.id }
    );
  }
  if (!cut.deadlineSafe) {
    collector.add("cut-deadline", "cut recovery missed a deadline", {
      edge: edge.id
    });
  }
  if (!cut.withinBudget) {
    collector.add("cut-budget", "cut recovery exceeded its budget", {
      edge: edge.id
    });
  }
}

export function safePlannerLead(
  edge: Readonly<GraphEdgeDefinition>,
  dryRun: Readonly<EdgeDryRunEvidence> | undefined,
  ringCapacity: number
): number {
  if (isResidentEdge(edge)) {
    return 0;
  }
  const available = dryRun?.availableConsecutiveFrames ?? 0;
  return isNonNegativeSafeInteger(available)
    ? Math.min(available, ringCapacity)
    : 0;
}

function verifyMeasuredLead(
  edge: Readonly<GraphEdgeDefinition>,
  dryRun: Readonly<EdgeDryRunEvidence>,
  transitionFrames: number,
  ringCapacity: number,
  collector: ReadinessFailureCollector
): void {
  if (
    !isNonNegativeSafeInteger(dryRun.availableConsecutiveFrames) ||
    dryRun.availableConsecutiveFrames > ringCapacity
  ) {
    collector.add("edge-lead", "edge lead measurement is invalid", {
      edge: edge.id
    });
    return;
  }
  const lead = planEdgeLead({
    transitionFrames,
    ringCapacity,
    availableConsecutiveFrames: dryRun.availableConsecutiveFrames
  });
  if (!lead.ready) {
    collector.add("edge-lead", "edge has insufficient consecutive lead", {
      edge: edge.id
    });
  }
}

function isResidentEdge(edge: Readonly<GraphEdgeDefinition>): boolean {
  return edge.start.type === "cut" || edge.transition?.kind === "reversible";
}

function validReadinessRingCapacity(value: number | null): value is number {
  return value !== null &&
    Number.isSafeInteger(value) &&
    value >= MIN_READINESS_RING_CAPACITY &&
    value <= MAX_READINESS_RING_CAPACITY;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return maximum;
  }
  return Math.min(maximum, Math.max(minimum, Math.ceil(value)));
}
