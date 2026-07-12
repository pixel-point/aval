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
  FrameRenderer,
  FrameTextureLayout
} from "./frame-renderer.js";
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
import type { RuntimeResourceAllocationSnapshot } from "./resource-plan.js";
import type {
  RuntimeCategoryBytesSnapshot,
  RuntimeDecoderTicket
} from "./model.js";
import type { DecodeTimeline } from "./decode-timeline.js";
import type {
  WorkerSampleFactory,
  WorkerSampleTransferLease
} from "./worker-samples.js";
import type { RuntimeCanvasResourceHost } from "./static-resource-plan.js";
import type { BrowserContextRecoveryEventTarget } from "./browser-context-recovery.js";

export type Awaitable<T> = T | PromiseLike<T>;

/** The single candidate-owned decoder surface used by cache and live paths. */
export interface AvcCandidateWorker
  extends PathSchedulerWorkerAdapter {
  configure(options: DecoderWorkerConfigureOptions): Promise<void>;
  dispose(): Promise<void>;
}

export interface AvcCandidateWorkerFactory {
  readonly available: boolean;
  create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): AvcCandidateWorker;
}

/**
 * A probe exposes limits without allocating textures. The candidate owns both
 * the returned renderer and the probe and disposes each exactly once.
 */
export interface AvcCandidateRendererReservation {
  readonly limits: Readonly<InteractionCacheDeviceLimits>;
  allocate(layout: Readonly<FrameTextureLayout>): FrameRenderer;
  dispose(): Awaitable<void>;
}

export interface AvcCandidateRendererFactory {
  readonly available: boolean;
  create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): AvcCandidateRendererReservation;
}

export interface AvcCandidateReadinessSessionInput {
  readonly context: Readonly<IntegratedCandidateAttemptContext>;
  readonly worker: AvcCandidateWorker;
  readonly renderer: FrameRenderer;
  readonly interactionCache: Readonly<InteractionCachePlan>;
  readonly provisionalResourcePlan: Readonly<RuntimeResourcePlan>;
  readonly timeline: DecodeTimeline;
  readonly samples: WorkerSampleFactory;
  readonly limits: Readonly<DecoderWorkerLimits>;
  readonly clock: PathSchedulerClock;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export interface AvcCandidateActivationInput {
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
export interface AvcCandidatePreparedMedia {
  readonly playback: IntegratedPlaybackSession;
  drawInitial(): void;
  dispose(): Awaitable<void>;
}

/** Browser/media effects used by the sole all-routes readiness invocation. */
export interface AvcCandidateReadinessSession {
  readonly adapters: Readonly<ReadinessRunnerAdapters>;
  observeResult?(result: Readonly<ReadinessRunnerResult>): void;
  prepareActivation(
    input: Readonly<AvcCandidateActivationInput>
  ): Awaitable<AvcCandidatePreparedMedia>;
  dispose(): Awaitable<void>;
}

export interface AvcCandidateReadinessFactory {
  create(
    input: Readonly<AvcCandidateReadinessSessionInput>
  ): AvcCandidateReadinessSession;
}

export interface AvcCandidateTimerHost {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type AvcCandidateCachePreparer = (
  input: Readonly<InteractionCachePreparationInput>,
  options?: Readonly<PrepareInteractionCacheOptions>
) => Promise<Readonly<InteractionCachePreparationReport>>;

export interface AvcCandidateResourcePlanLeaseSnapshot {
  readonly released: boolean;
  readonly totalBytes: number;
  readonly categories: readonly Readonly<RuntimeCategoryBytesSnapshot>[];
}

export interface AvcCandidateResourcePlanLease {
  snapshot(): Readonly<AvcCandidateResourcePlanLeaseSnapshot>;
  assertAllocation(
    allocation: Readonly<RuntimeResourceAllocationSnapshot>
  ): void;
  claimWorkerTransfer(byteLength: number): WorkerSampleTransferLease;
  release(): void;
}

/** Narrow page authority: byte peak admission plus decoder permission only. */
export interface AvcCandidateResourceAuthority {
  reservePlan(
    allocation: Readonly<RuntimeResourceAllocationSnapshot>
  ): AvcCandidateResourcePlanLease | PromiseLike<AvcCandidateResourcePlanLease>;
  requestDecoder(): RuntimeDecoderTicket;
}

export interface AvcCandidateFactoryOptions {
  readonly workerFactory: AvcCandidateWorkerFactory;
  readonly rendererFactory: AvcCandidateRendererFactory;
  readonly readinessFactory: AvcCandidateReadinessFactory;
  readonly resourceHost?: RuntimeCanvasResourceHost;
  readonly contextTarget?: BrowserContextRecoveryEventTarget;
  readonly resourceAuthority?: AvcCandidateResourceAuthority;
  readonly clock?: PathSchedulerClock;
  readonly timers?: AvcCandidateTimerHost;
  /** Test seam; production defaults to the task-10 preparation owner. */
  readonly prepareCache?: AvcCandidateCachePreparer;
}

export interface AvcCandidateWorkerSetup {
  readonly configure: Readonly<DecoderWorkerConfigureOptions>;
  readonly limits: Readonly<DecoderWorkerLimits>;
}

/** @deprecated Use AvcCandidateWorker. */
export type OpaqueCandidateWorker = AvcCandidateWorker;
/** @deprecated Use AvcCandidateWorkerFactory. */
export type OpaqueCandidateWorkerFactory = AvcCandidateWorkerFactory;
/** @deprecated Use AvcCandidateRendererReservation. */
export type OpaqueCandidateRendererReservation =
  AvcCandidateRendererReservation;
/** @deprecated Use AvcCandidateRendererFactory. */
export type OpaqueCandidateRendererFactory = AvcCandidateRendererFactory;
/** @deprecated Use AvcCandidateReadinessSessionInput. */
export type OpaqueCandidateReadinessSessionInput =
  AvcCandidateReadinessSessionInput;
/** @deprecated Use AvcCandidateActivationInput. */
export type OpaqueCandidateActivationInput = AvcCandidateActivationInput;
/** @deprecated Use AvcCandidatePreparedMedia. */
export type OpaqueCandidatePreparedMedia = AvcCandidatePreparedMedia;
/** @deprecated Use AvcCandidateReadinessSession. */
export type OpaqueCandidateReadinessSession = AvcCandidateReadinessSession;
/** @deprecated Use AvcCandidateReadinessFactory. */
export type OpaqueCandidateReadinessFactory = AvcCandidateReadinessFactory;
/** @deprecated Use AvcCandidateTimerHost. */
export type OpaqueCandidateTimerHost = AvcCandidateTimerHost;
/** @deprecated Use AvcCandidateCachePreparer. */
export type OpaqueCandidateCachePreparer = AvcCandidateCachePreparer;
/** @deprecated Use AvcCandidateFactoryOptions. */
export type OpaqueCandidateFactoryOptions = AvcCandidateFactoryOptions;
/** @deprecated Use AvcCandidateWorkerSetup. */
export type OpaqueCandidateWorkerSetup = AvcCandidateWorkerSetup;
