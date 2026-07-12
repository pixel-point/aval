import type { GraphPresentation, MotionGraphSnapshot } from "@rendered-motion/graph";

import type {
  DecoderWorkerConfigureOptions
} from "../decoder-worker/client.js";
import type { DecoderWorkerLimits } from "../decoder-worker/protocol.js";
import type {
  IntegratedCandidateAttemptContext,
  IntegratedPlaybackSession
} from "./integrated-player-contracts.js";
import type {
  InteractionCachePlan,
  InteractionCacheDeviceLimits
} from "./interaction-cache-plan.js";
import type {
  InteractionCachePreparationInput,
  InteractionCachePreparationReport,
  PrepareInteractionCacheOptions
} from "./interaction-cache-preparation.js";
import type {
  OpaqueFrameRenderer,
  OpaqueFrameTextureLayout
} from "./opaque-frame-renderer.js";
import type {
  PathScheduler,
  PathSchedulerClock,
  PathSchedulerWorkerAdapter
} from "./path-scheduler.js";
import type {
  ReadinessRunnerAdapters,
  ReadinessRunnerResult
} from "./readiness-runner.js";
import type { RuntimeResourcePlan } from "./resource-plan.js";
import type { DecodeTimeline } from "./decode-timeline.js";
import type { WorkerSampleFactory } from "./worker-samples.js";

export type Awaitable<T> = T | PromiseLike<T>;

/** The single candidate-owned decoder surface used by cache and live paths. */
export interface OpaqueCandidateWorker
  extends PathSchedulerWorkerAdapter {
  configure(options: DecoderWorkerConfigureOptions): Promise<void>;
  dispose(): Promise<void>;
}

export interface OpaqueCandidateWorkerFactory {
  readonly available: boolean;
  create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): OpaqueCandidateWorker;
}

/**
 * A probe exposes limits without allocating textures. The candidate owns both
 * the returned renderer and the probe and disposes each exactly once.
 */
export interface OpaqueCandidateRendererReservation {
  readonly limits: Readonly<InteractionCacheDeviceLimits>;
  allocate(layout: Readonly<OpaqueFrameTextureLayout>): OpaqueFrameRenderer;
  dispose(): Awaitable<void>;
}

export interface OpaqueCandidateRendererFactory {
  readonly available: boolean;
  create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): OpaqueCandidateRendererReservation;
}

export interface OpaqueCandidateReadinessSessionInput {
  readonly context: Readonly<IntegratedCandidateAttemptContext>;
  readonly worker: OpaqueCandidateWorker;
  readonly renderer: OpaqueFrameRenderer;
  readonly interactionCache: Readonly<InteractionCachePlan>;
  readonly provisionalResourcePlan: Readonly<RuntimeResourcePlan>;
  readonly timeline: DecodeTimeline;
  readonly samples: WorkerSampleFactory;
  readonly limits: Readonly<DecoderWorkerLimits>;
  readonly clock: PathSchedulerClock;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export interface OpaqueCandidateActivationInput {
  readonly graphSnapshot: Readonly<MotionGraphSnapshot>;
  readonly expectedPresentation: Readonly<GraphPresentation>;
  readonly scheduler: PathScheduler;
  readonly finalResourcePlan: Readonly<RuntimeResourcePlan>;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

/**
 * All fallible first-frame work finishes before this value is returned.
 * `drawInitial` is therefore a synchronous presentation-only operation.
 */
export interface OpaqueCandidatePreparedMedia {
  readonly playback: IntegratedPlaybackSession;
  drawInitial(): void;
  dispose(): Awaitable<void>;
}

/** Browser/media effects used by the sole all-routes readiness invocation. */
export interface OpaqueCandidateReadinessSession {
  readonly adapters: Readonly<ReadinessRunnerAdapters>;
  observeResult?(result: Readonly<ReadinessRunnerResult>): void;
  prepareActivation(
    input: Readonly<OpaqueCandidateActivationInput>
  ): Awaitable<OpaqueCandidatePreparedMedia>;
  dispose(): Awaitable<void>;
}

export interface OpaqueCandidateReadinessFactory {
  create(
    input: Readonly<OpaqueCandidateReadinessSessionInput>
  ): OpaqueCandidateReadinessSession;
}

export interface OpaqueCandidateTimerHost {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type OpaqueCandidateCachePreparer = (
  input: Readonly<InteractionCachePreparationInput>,
  options?: Readonly<PrepareInteractionCacheOptions>
) => Promise<Readonly<InteractionCachePreparationReport>>;

export interface OpaqueCandidateFactoryOptions {
  readonly workerFactory: OpaqueCandidateWorkerFactory;
  readonly rendererFactory: OpaqueCandidateRendererFactory;
  readonly readinessFactory: OpaqueCandidateReadinessFactory;
  readonly clock?: PathSchedulerClock;
  readonly timers?: OpaqueCandidateTimerHost;
  /** Test seam; production defaults to the task-10 preparation owner. */
  readonly prepareCache?: OpaqueCandidateCachePreparer;
}

export interface OpaqueCandidateWorkerSetup {
  readonly configure: Readonly<DecoderWorkerConfigureOptions>;
  readonly limits: Readonly<DecoderWorkerLimits>;
}
