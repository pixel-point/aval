import type {
  GraphPresentation,
  MotionGraphResult,
  MotionGraphSnapshot,
  MotionGraphTickOptions
} from "@rendered-motion/graph";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import type { EffectHostEvent } from "./effect-host.js";
import type { RuntimeFailure } from "./errors.js";
import type {
  RuntimeMediaCursor,
  RuntimeMediaPresentation,
  RuntimeReadiness,
  RuntimeReadinessResult,
  RuntimeSchedulerSnapshot,
  RuntimeTraceRecord
} from "./model.js";
import type {
  RuntimeOpaqueRenditionCandidate,
  RuntimeOpaqueRenditionInspection
} from "./rendition-selection.js";
import type { RealtimeUnderflowEvent } from "./realtime-driver.js";

type SuccessfulRenditionInspection = Extract<
  RuntimeOpaqueRenditionInspection,
  { readonly ok: true }
>;

export interface IntegratedStaticSurfaceStore {
  installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  validateAll(options: { readonly signal: AbortSignal }): Promise<unknown>;
  presentState(
    state: string,
    options: { readonly signal: AbortSignal }
  ): Promise<unknown>;
  coverCurrent(): void;
  revealAnimated(): void;
  /** Resolves after every aborted decoder/presentation callback has retired. */
  settled(): Promise<void>;
  dispose(): void;
}

export interface IntegratedCandidateAttemptContext {
  readonly catalog: RuntimeAssetCatalog;
  readonly candidate: Readonly<RuntimeOpaqueRenditionCandidate>;
  readonly inspection: SuccessfulRenditionInspection["inspection"];
  readonly graphSnapshot: Readonly<MotionGraphSnapshot>;
  readonly hostMaxRuntimeBytes: number | null;
}

export interface IntegratedCandidatePrepareOptions {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export interface IntegratedCandidateActivationOptions
  extends IntegratedCandidatePrepareOptions {
  readonly graphSnapshot: Readonly<MotionGraphSnapshot>;
  readonly expectedPresentation: Readonly<GraphPresentation>;
}

/** Opaque-by-identity token backed by candidate-owned prepared draw state. */
export interface IntegratedPreparedActivation {
  readonly expectedPresentation: Readonly<GraphPresentation>;
}

export interface IntegratedCandidateAttempt {
  readonly playback: IntegratedPlaybackSession;
  prepare(options: IntegratedCandidatePrepareOptions): Promise<void>;
  prepareActivation(
    options: IntegratedCandidateActivationOptions
  ): Promise<Readonly<IntegratedPreparedActivation>>;
  /** Consumes a prepared token; implementations must not perform fallible work. */
  drawInitial(
    activation: Readonly<IntegratedPreparedActivation>,
    presentation: Readonly<GraphPresentation>
  ): void;
  dispose(): void | Promise<void>;
}

export interface IntegratedCandidateAvailability {
  readonly workerAvailable: boolean;
  readonly rendererAvailable: boolean;
}

export interface IntegratedCandidateFactory {
  readonly availability: Readonly<IntegratedCandidateAvailability>;
  create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): IntegratedCandidateAttempt;
}

export interface IntegratedContentTickContext {
  /** Frame zero is drawn during activation; live content begins at one. */
  readonly presentationOrdinal: bigint;
  readonly rationalDeadlineUs: number | null;
}

export interface IntegratedPlaybackTickContext
  extends IntegratedContentTickContext {
  readonly graphSnapshot: Readonly<MotionGraphSnapshot>;
  /** Exact, non-mutating reduction owned by the player's sole graph engine. */
  readonly previewTick: (
    options: Readonly<MotionGraphTickOptions>
  ) => Readonly<MotionGraphResult>;
}

export interface IntegratedPlaybackTraceState {
  readonly scheduler: Readonly<RuntimeSchedulerSnapshot>;
  readonly submitted: readonly Readonly<RuntimeMediaCursor>[];
  readonly selectedBoundary: string | null;
  readonly decodeLeadFrames: number | null;
}

export interface IntegratedPreparedContentTick
  extends IntegratedPlaybackTraceState {
  readonly routeReady: boolean;
  readonly media: Readonly<RuntimeMediaPresentation>;
}

/** Prepared candidate seam; concrete scheduling remains outside the player. */
export interface IntegratedPlaybackSession {
  prepareContentTick(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null;
  drawContentTick(
    prepared: Readonly<IntegratedPreparedContentTick>,
    presentation: Readonly<GraphPresentation>
  ): string | null;
  synchronizeGraph(result: Readonly<MotionGraphResult>): void;
  traceState(): Readonly<IntegratedPlaybackTraceState>;
}

export type IntegratedContentTickResult =
  | { readonly status: "advanced" }
  | { readonly status: "underflow" }
  | { readonly status: "stopped" };

export interface IntegratedTimerHost {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

export interface IntegratedRealtimeDriverOptions {
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly now?: () => number;
  readonly onUnderflow?: (
    event: Readonly<RealtimeUnderflowEvent>
  ) => void;
}

export interface IntegratedPlayerOptions {
  readonly bytes: Uint8Array;
  readonly createStaticStore: (
    catalog: RuntimeAssetCatalog
  ) => IntegratedStaticSurfaceStore;
  readonly candidateFactory: IntegratedCandidateFactory;
  readonly eventSink?: (event: Readonly<EffectHostEvent>) => void;
  readonly diagnosticsSink?: (failure: Readonly<RuntimeFailure>) => void;
  readonly hostMaxRuntimeBytes?: number;
  readonly now?: () => number;
  readonly timers?: IntegratedTimerHost;
  /** Internal M5.5 clock ownership; public pause/autoplay remains M8. */
  readonly realtime?: Readonly<IntegratedRealtimeDriverOptions>;
}

export interface IntegratedPrepareOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface IntegratedPlayerSnapshot {
  readonly readiness: RuntimeReadiness;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly selectedRendition: string | null;
  readonly preparing: boolean;
  readonly disposed: boolean;
}

export type IntegratedPlayerTrace = readonly Readonly<RuntimeTraceRecord>[];

export class PlaybackFallbackError extends Error {
  public constructor(message = "animation static fallback failed") {
    super(message);
    this.name = "PlaybackFallbackError";
  }
}

export class IntegratedPlaybackInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IntegratedPlaybackInvariantError";
  }
}

export type IntegratedPrepareResult = RuntimeReadinessResult;
