import type { CompiledManifestV01 } from "@rendered-motion/format";
import type { ValidatedMotionGraph } from "@rendered-motion/graph";

import type { ReadinessMetricsReport } from "./readiness-metrics.js";

export interface LoopReadinessEvidence {
  readonly unit: string;
  readonly seamReady: boolean;
  readonly availableHeadroomFrames: number;
}

export interface EdgeDryRunEvidence {
  readonly edge: string;
  readonly metrics: Readonly<ReadinessMetricsReport>;
  readonly availableConsecutiveFrames: number;
  readonly transitionFrames: number;
  readonly targetProbeFrames: number;
  readonly sequenceFrameCount: number;
  readonly completeSequence: boolean;
  readonly deadlineSafe: boolean;
  readonly withinBudget: boolean;
}

export interface CutReadinessEvidence {
  readonly edge: string;
  readonly runwayPrepared: boolean;
  readonly responseFrames: number;
  readonly runwayFrames: number;
  readonly continuationFrame: number;
  readonly recoveryFrames: number;
  readonly deadlineSafe: boolean;
  readonly withinBudget: boolean;
}

export interface EndpointRecoveryEvidence {
  readonly unit: string;
  readonly state: string;
  readonly port: string;
  readonly runwayPrepared: boolean;
  readonly runwayFrames: number;
  readonly continuationFrame: number;
  readonly recoveryFrames: number;
  readonly deadlineSafe: boolean;
  readonly withinBudget: boolean;
}

export interface RoutePhaseEvidence {
  readonly edge: string;
  readonly pendingCancellationReady: boolean;
  readonly pendingReplacementReady: boolean;
  readonly prospectiveTargetReady: boolean;
  readonly lockedFollowOnReady: boolean;
}

export interface InverseReadinessEvidence {
  readonly unit: string;
  readonly responseFrames: number;
  readonly adjacentFrame: boolean;
}

export interface ResourceReadinessEvidence {
  readonly passed: boolean;
  readonly totalBytes: number;
  readonly capBytes: number;
}

export interface InitialRingReadinessEvidence {
  readonly passed: boolean;
  readonly frameCount: number;
}

export interface AllRoutesReadinessEvidence {
  readonly warmupMetrics: Readonly<ReadinessMetricsReport>;
  readonly loops: readonly Readonly<LoopReadinessEvidence>[];
  readonly edgeDryRuns: readonly Readonly<EdgeDryRunEvidence>[];
  readonly cuts: readonly Readonly<CutReadinessEvidence>[];
  readonly endpoints: readonly Readonly<EndpointRecoveryEvidence>[];
  readonly phases: readonly Readonly<RoutePhaseEvidence>[];
  readonly inverses: readonly Readonly<InverseReadinessEvidence>[];
  readonly resource: Readonly<ResourceReadinessEvidence>;
  readonly initialRing: Readonly<InitialRingReadinessEvidence>;
}

export interface AllRoutesReadinessInput {
  readonly manifest: Readonly<CompiledManifestV01>;
  readonly graph: Readonly<ValidatedMotionGraph>;
  readonly evidence: Readonly<AllRoutesReadinessEvidence>;
}

export type ReadinessEvaluationFailureCode =
  | "policy"
  | "manifest-graph"
  | "warmup-metrics"
  | "missing-loop"
  | "loop-seam"
  | "loop-headroom"
  | "missing-edge-dry-run"
  | "edge-metrics"
  | "edge-sequence"
  | "edge-lead"
  | "edge-deadline"
  | "edge-budget"
  | "edge-max-wait"
  | "missing-cut"
  | "cut-runway"
  | "cut-response"
  | "cut-deadline"
  | "cut-budget"
  | "missing-endpoint"
  | "endpoint-runway"
  | "endpoint-recovery"
  | "endpoint-deadline"
  | "endpoint-budget"
  | "missing-route-phase"
  | "pending-cancellation"
  | "pending-replacement"
  | "prospective-target"
  | "locked-follow-on"
  | "missing-inverse"
  | "active-inverse"
  | "resource-plan"
  | "initial-ring"
  | "duplicate-evidence";

export interface ReadinessEvaluationFailure {
  readonly code: ReadinessEvaluationFailureCode;
  readonly message: string;
  readonly edge?: string;
  readonly unit?: string;
  readonly state?: string;
  readonly sourceFrame?: number;
}

export interface ReadinessSourceFrameReport {
  readonly frame: number;
  readonly scenarioCount: number;
  readonly maximumRequiredWaitFrames: bigint;
  readonly passed: boolean;
}

export interface ReadinessEdgeReport {
  readonly edge: string;
  readonly sourceState: string;
  readonly sourceFrames: readonly Readonly<ReadinessSourceFrameReport>[];
  readonly passed: boolean;
}

export interface AllRoutesReadinessReport {
  readonly passed: boolean;
  readonly warmupMetrics: Readonly<ReadinessMetricsReport>;
  readonly ringCapacity: number;
  readonly targetProbeFrames: number;
  readonly evaluatedEdgeIds: readonly string[];
  readonly edges: readonly Readonly<ReadinessEdgeReport>[];
  readonly failures: readonly Readonly<ReadinessEvaluationFailure>[];
}

export interface ReadinessFailureContext {
  readonly edge?: string;
  readonly unit?: string;
  readonly state?: string;
  readonly sourceFrame?: number;
}

export interface ReadinessFailureCollector {
  readonly failures: ReadinessEvaluationFailure[];
  add(
    code: ReadinessEvaluationFailureCode,
    message: string,
    context?: ReadinessFailureContext
  ): void;
}
