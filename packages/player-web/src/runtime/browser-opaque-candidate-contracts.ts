import type {
  AllRoutesReadinessEvidence,
  AllRoutesReadinessReport
} from "./readiness-evaluator.js";
import type { RuntimeFailure } from "./errors.js";
import type { OpaqueFrameRendererSnapshot } from "./opaque-frame-renderer.js";
import type { PathSchedulerClock, PathSchedulerSnapshot } from "./path-scheduler.js";
import type { DecoderWorkerMetrics } from "../decoder-worker/protocol.js";
import type {
  CreateDecoderWorkerClientOptions,
  OwnedDecoderWorkerPort
} from "../decoder-worker/factory.js";
import type { OpaqueCandidateTimerHost } from "./opaque-candidate-factory.js";
import type { CutPresentationSnapshot } from "./cut-presentation-coordinator.js";
import type { ReversiblePresentationSnapshot } from "./reversible-presentation.js";
import type { OpaqueCandidateFactory } from "./opaque-candidate-factory.js";
import type { BrowserOpaqueFrameBackendOptions } from "./opaque-frame-renderer-browser.js";
import type { BrowserProductionReadinessReport } from "./browser-production-readiness-evidence.js";

export interface BrowserOpaqueCandidateOrderEntry {
  readonly id: string;
  readonly area: number;
  readonly peakBitrate: number;
}

export interface BrowserOpaqueReadinessSnapshot {
  readonly policy: "all-routes";
  readonly passed: boolean | null;
  readonly evaluation: Readonly<AllRoutesReadinessReport> | null;
  readonly evidence: Readonly<AllRoutesReadinessEvidence> | null;
  readonly production: Readonly<BrowserProductionReadinessReport> | null;
}

export interface BrowserOpaqueWorkerSnapshot {
  readonly metrics: Readonly<DecoderWorkerMetrics> | null;
  readonly openFrames: number;
  readonly pendingRequests: number;
  readonly pendingWaiters: number;
  readonly alive: boolean;
}

export interface BrowserOpaqueRendererSnapshot {
  readonly snapshot: Readonly<OpaqueFrameRendererSnapshot> | null;
  readonly backendAlive: boolean;
  readonly glResourceCount: number;
}

export interface BrowserOpaquePlaybackSnapshot {
  readonly scheduler: Readonly<PathSchedulerSnapshot> | null;
  readonly cut: Readonly<CutPresentationSnapshot> | null;
  readonly reversible: Readonly<ReversiblePresentationSnapshot> | null;
  readonly pendingCallbacks: number;
  readonly pendingPromises: number;
  readonly readbackTags: readonly string[];
}

export interface BrowserOpaqueCleanupSnapshot {
  readonly workersAlive: number;
  readonly openFrames: number;
  readonly renderersAlive: number;
  readonly glResourceCount: number;
  readonly pendingOperations: number;
  readonly complete: boolean;
}

export interface BrowserOpaqueCandidateSnapshot {
  readonly candidateOrder: readonly Readonly<BrowserOpaqueCandidateOrderEntry>[];
  readonly activeRendition: string | null;
  readonly readiness: Readonly<BrowserOpaqueReadinessSnapshot>;
  readonly worker: Readonly<BrowserOpaqueWorkerSnapshot>;
  readonly renderer: Readonly<BrowserOpaqueRendererSnapshot>;
  readonly playback: Readonly<BrowserOpaquePlaybackSnapshot>;
  readonly cleanup: Readonly<BrowserOpaqueCleanupSnapshot>;
  readonly diagnostics: readonly Readonly<RuntimeFailure>[];
}

export interface BrowserOpaqueReadPixelsResult {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface BrowserOpaqueCandidateControls {
  settled(): Promise<void>;
  snapshot(): Readonly<BrowserOpaqueCandidateSnapshot>;
  induceWorkerFailure(): void;
  readPixels(): Readonly<BrowserOpaqueReadPixelsResult>;
}

/** Test-only constructors; production callers should omit this object. */
export interface BrowserOpaqueCandidateTestDependencies {
  readonly createWorkerPort?: (
    url: URL,
    options: WorkerOptions
  ) => OwnedDecoderWorkerPort;
  readonly createBackend?: (
    canvas: HTMLCanvasElement
  ) => import("./opaque-frame-renderer.js").OpaqueFrameRendererBackend;
}

export interface BrowserOpaqueCandidateCompositionOptions {
  readonly canvas: HTMLCanvasElement;
  readonly worker?: CreateDecoderWorkerClientOptions;
  readonly renderer?: Readonly<BrowserOpaqueFrameBackendOptions>;
  readonly clock?: PathSchedulerClock;
  readonly timers?: OpaqueCandidateTimerHost;
  readonly diagnosticsSink?: (failure: Readonly<RuntimeFailure>) => void;
  readonly testDependencies?: BrowserOpaqueCandidateTestDependencies;
}

export interface BrowserOpaqueCandidateComposition {
  readonly factory: OpaqueCandidateFactory;
  readonly controls: BrowserOpaqueCandidateControls;
}
