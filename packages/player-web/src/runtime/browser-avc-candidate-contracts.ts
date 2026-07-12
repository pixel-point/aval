import type {
  AllRoutesReadinessEvidence,
  AllRoutesReadinessReport
} from "./readiness-evaluator.js";
import type { RuntimeFailure } from "./errors.js";
import type { FrameRendererSnapshot } from "./frame-renderer.js";
import type { PathSchedulerClock, PathSchedulerSnapshot } from "./path-scheduler.js";
import type { DecoderWorkerMetrics } from "../decoder-worker/protocol.js";
import type {
  CreateDecoderWorkerClientOptions,
  OwnedDecoderWorkerPort
} from "../decoder-worker/factory.js";
import type { AvcCandidateTimerHost } from "./avc-candidate-factory.js";
import type { CutPresentationSnapshot } from "./cut-presentation-coordinator.js";
import type { ReversiblePresentationSnapshot } from "./reversible-presentation.js";
import type {
  AvcCandidateFactory,
  AvcCandidateResourceAuthority
} from "./avc-candidate-factory.js";
import type { BrowserFrameBackendOptions } from "./frame-renderer-browser.js";
import type { BrowserProductionReadinessReport } from "./browser-production-readiness-evidence.js";
import type { BrowserPresentationPlanes } from "./browser-presentation-planes.js";

export interface BrowserAvcCandidateOrderEntry {
  readonly id: string;
  /** Logical color pixels; packed alpha storage is deliberately excluded. */
  readonly area: number;
  readonly peakBitrate: number;
}

export interface BrowserAvcReadinessSnapshot {
  readonly policy: "all-routes";
  readonly passed: boolean | null;
  readonly evaluation: Readonly<AllRoutesReadinessReport> | null;
  readonly evidence: Readonly<AllRoutesReadinessEvidence> | null;
  readonly production: Readonly<BrowserProductionReadinessReport> | null;
}

export interface BrowserAvcWorkerSnapshot {
  readonly metrics: Readonly<DecoderWorkerMetrics> | null;
  readonly openFrames: number;
  readonly pendingRequests: number;
  readonly pendingWaiters: number;
  readonly alive: boolean;
}

export interface BrowserAvcRendererSnapshot {
  readonly snapshot: Readonly<FrameRendererSnapshot> | null;
  readonly backendAlive: boolean;
  readonly glResourceCount: number;
}

export interface BrowserAvcPlaybackSnapshot {
  readonly scheduler: Readonly<PathSchedulerSnapshot> | null;
  readonly cut: Readonly<CutPresentationSnapshot> | null;
  readonly reversible: Readonly<ReversiblePresentationSnapshot> | null;
  readonly pendingCallbacks: number;
  readonly pendingPromises: number;
  readonly readbackTags: readonly string[];
}

export interface BrowserAvcCleanupSnapshot {
  readonly workersAlive: number;
  readonly openFrames: number;
  readonly renderersAlive: number;
  readonly glResourceCount: number;
  readonly rendererStagingBytes: number;
  readonly sourceCopiesInFlight: number;
  readonly pendingOperations: number;
  readonly complete: boolean;
}

export interface BrowserAvcCandidateSnapshot {
  readonly candidateOrder: readonly Readonly<BrowserAvcCandidateOrderEntry>[];
  readonly activeRendition: string | null;
  readonly readiness: Readonly<BrowserAvcReadinessSnapshot>;
  readonly worker: Readonly<BrowserAvcWorkerSnapshot>;
  readonly renderer: Readonly<BrowserAvcRendererSnapshot>;
  readonly playback: Readonly<BrowserAvcPlaybackSnapshot>;
  readonly cleanup: Readonly<BrowserAvcCleanupSnapshot>;
  readonly diagnostics: readonly Readonly<RuntimeFailure>[];
}

export interface BrowserAvcReadPixelsResult {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface BrowserAvcCandidateControls {
  settled(): Promise<void>;
  snapshot(): Readonly<BrowserAvcCandidateSnapshot>;
  induceWorkerFailure(): void;
  readPixels(): Readonly<BrowserAvcReadPixelsResult>;
}

/** Test-only constructors; production callers should omit this object. */
export interface BrowserAvcCandidateTestDependencies {
  readonly createWorkerPort?: (
    url: URL,
    options: WorkerOptions
  ) => OwnedDecoderWorkerPort;
  readonly createFrameBackend?: (
    canvas: HTMLCanvasElement
  ) => import("./frame-renderer.js").FrameRendererBackend;
  /** @deprecated Opaque-only test seam. */
  readonly createBackend?: (
    canvas: HTMLCanvasElement
  ) => import("./opaque-frame-renderer.js").OpaqueFrameRendererBackend;
}

export interface BrowserAvcCandidateCompositionOptions {
  readonly canvas: HTMLCanvasElement;
  /** Shared static/animated fit and backing owner for production presentation. */
  readonly presentationPlanes?: Pick<
    BrowserPresentationPlanes,
    | "createFrameBackend"
    | "currentCanvasBacking"
    | "reserveCanvasResources"
    | "ownsAnimatedCanvas"
  > & Partial<Pick<BrowserPresentationPlanes, "animatedContextTarget">>;
  readonly worker?: CreateDecoderWorkerClientOptions;
  readonly renderer?: Readonly<BrowserFrameBackendOptions>;
  readonly clock?: PathSchedulerClock;
  readonly timers?: AvcCandidateTimerHost;
  readonly diagnosticsSink?: (failure: Readonly<RuntimeFailure>) => void;
  /** Optional M7 page-wide byte and decoder admission authority. */
  readonly resourceAuthority?: AvcCandidateResourceAuthority;
  readonly testDependencies?: BrowserAvcCandidateTestDependencies;
}

export interface BrowserAvcCandidateComposition {
  readonly factory: AvcCandidateFactory;
  readonly controls: BrowserAvcCandidateControls;
}

/** @deprecated Use BrowserAvcCandidateOrderEntry. */
export type BrowserOpaqueCandidateOrderEntry = BrowserAvcCandidateOrderEntry;
/** @deprecated Use BrowserAvcReadinessSnapshot. */
export type BrowserOpaqueReadinessSnapshot = BrowserAvcReadinessSnapshot;
/** @deprecated Use BrowserAvcWorkerSnapshot. */
export type BrowserOpaqueWorkerSnapshot = BrowserAvcWorkerSnapshot;
/** @deprecated Use BrowserAvcRendererSnapshot. */
export type BrowserOpaqueRendererSnapshot = BrowserAvcRendererSnapshot;
/** @deprecated Use BrowserAvcPlaybackSnapshot. */
export type BrowserOpaquePlaybackSnapshot = BrowserAvcPlaybackSnapshot;
/** @deprecated Use BrowserAvcCleanupSnapshot. */
export type BrowserOpaqueCleanupSnapshot = BrowserAvcCleanupSnapshot;
/** @deprecated Use BrowserAvcCandidateSnapshot. */
export type BrowserOpaqueCandidateSnapshot = BrowserAvcCandidateSnapshot;
/** @deprecated Use BrowserAvcReadPixelsResult. */
export type BrowserOpaqueReadPixelsResult = BrowserAvcReadPixelsResult;
/** @deprecated Use BrowserAvcCandidateControls. */
export type BrowserOpaqueCandidateControls = BrowserAvcCandidateControls;
/** @deprecated Use BrowserAvcCandidateTestDependencies. */
export type BrowserOpaqueCandidateTestDependencies =
  BrowserAvcCandidateTestDependencies;
/** @deprecated Use BrowserAvcCandidateCompositionOptions. */
export type BrowserOpaqueCandidateCompositionOptions =
  BrowserAvcCandidateCompositionOptions;
/** @deprecated Use BrowserAvcCandidateComposition. */
export type BrowserOpaqueCandidateComposition = BrowserAvcCandidateComposition;
