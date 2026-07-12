import type {
  CompiledManifestV01,
  EdgeV01,
  ResidencyEndpointV01,
  UnitV01
} from "@rendered-motion/format";
import type {
  GraphEdgeDefinition,
  GraphStateDefinition,
  ValidatedMotionGraph
} from "@rendered-motion/graph";

import type { RuntimeFailure } from "./errors.js";
import type {
  AllRoutesReadinessReport,
  CutReadinessEvidence,
  EndpointRecoveryEvidence,
  InitialRingReadinessEvidence,
  InverseReadinessEvidence,
  LoopReadinessEvidence,
  ResourceReadinessEvidence,
  RoutePhaseEvidence
} from "./readiness-evaluator.js";
import type { ReadinessFrameMeasurement } from "./readiness-metrics.js";

type Awaitable<T> = T | PromiseLike<T>;
type BodyUnit = Extract<UnitV01, { readonly kind: "body" }>;
type LoopBodyUnit = BodyUnit & { readonly playback: "loop" };
type ReversibleUnit = Extract<UnitV01, { readonly kind: "reversible" }>;

export interface WarmupAdapterInput {
  readonly manifest: Readonly<CompiledManifestV01>;
  readonly graph: Readonly<ValidatedMotionGraph>;
}

export interface WarmupAdapterResult {
  readonly measurements: readonly Readonly<ReadinessFrameMeasurement>[];
}

export interface LoopAdapterInput extends WarmupAdapterInput {
  readonly unit: Readonly<LoopBodyUnit>;
  readonly states: readonly Readonly<GraphStateDefinition>[];
  readonly ringCapacity: number;
}

export type LoopAdapterResult = Omit<LoopReadinessEvidence, "unit">;

export interface EdgeAdapterInput extends WarmupAdapterInput {
  readonly edge: Readonly<GraphEdgeDefinition>;
  readonly manifestEdge: Readonly<EdgeV01>;
  readonly source: Readonly<GraphStateDefinition>;
  readonly target: Readonly<GraphStateDefinition>;
  readonly ringCapacity: number;
  readonly targetProbeFrames: number;
}

export interface EdgeDryRunAdapterResult {
  readonly measurements: readonly Readonly<ReadinessFrameMeasurement>[];
  readonly availableConsecutiveFrames: number;
  readonly transitionFrames: number;
  readonly targetProbeFrames: number;
  readonly sequenceFrameCount: number;
  readonly completeSequence: boolean;
  readonly deadlineSafe: boolean;
  readonly withinBudget: boolean;
}

export type CutAdapterResult = Omit<CutReadinessEvidence, "edge">;
export type RoutePhaseAdapterResult = Omit<RoutePhaseEvidence, "edge">;

export interface EndpointAdapterInput extends WarmupAdapterInput {
  readonly unit: Readonly<ReversibleUnit>;
  readonly endpoint: Readonly<ResidencyEndpointV01>;
  readonly ringCapacity: number;
}

export type EndpointAdapterResult = Omit<
  EndpointRecoveryEvidence,
  "unit" | "state" | "port"
>;

export interface InverseAdapterInput extends WarmupAdapterInput {
  readonly unit: Readonly<ReversibleUnit>;
  readonly ringCapacity: number;
}

export type InverseAdapterResult = Omit<InverseReadinessEvidence, "unit">;

export interface ResourceAdapterInput extends WarmupAdapterInput {
  readonly ringCapacity: number;
  readonly targetProbeFrames: number;
}

export interface InitialRingAdapterInput extends WarmupAdapterInput {
  readonly ringCapacity: number;
}

/** Adapters own effects; the runner owns only ordering and evaluation. */
export interface ReadinessRunnerAdapters {
  readonly measureWarmup: (
    input: Readonly<WarmupAdapterInput>
  ) => Awaitable<Readonly<WarmupAdapterResult>>;
  readonly measureLoop: (
    input: Readonly<LoopAdapterInput>
  ) => Awaitable<Readonly<LoopAdapterResult>>;
  readonly dryRunEdge: (
    input: Readonly<EdgeAdapterInput>
  ) => Awaitable<Readonly<EdgeDryRunAdapterResult>>;
  readonly prepareCut: (
    input: Readonly<EdgeAdapterInput>
  ) => Awaitable<Readonly<CutAdapterResult>>;
  readonly prepareEndpoint: (
    input: Readonly<EndpointAdapterInput>
  ) => Awaitable<Readonly<EndpointAdapterResult>>;
  readonly simulateRoutePhases: (
    input: Readonly<EdgeAdapterInput>
  ) => Awaitable<Readonly<RoutePhaseAdapterResult>>;
  readonly measureActiveInverse: (
    input: Readonly<InverseAdapterInput>
  ) => Awaitable<Readonly<InverseAdapterResult>>;
  readonly measureResource: (
    input: Readonly<ResourceAdapterInput>
  ) => Awaitable<Readonly<ResourceReadinessEvidence>>;
  readonly fillInitialRing: (
    input: Readonly<InitialRingAdapterInput>
  ) => Awaitable<Readonly<InitialRingReadinessEvidence>>;
}

export interface ReadinessRunnerInput extends WarmupAdapterInput {
  readonly adapters: ReadinessRunnerAdapters;
}

export interface ReadinessRunnerResult {
  readonly passed: boolean;
  readonly evaluation: Readonly<AllRoutesReadinessReport> | null;
  readonly failure: Readonly<RuntimeFailure> | null;
}
