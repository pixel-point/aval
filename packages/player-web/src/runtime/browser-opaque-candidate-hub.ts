import type { IntegratedCandidateAttemptContext } from "./integrated-player-contracts.js";
import type { ReadinessRunnerResult } from "./readiness-runner.js";
import type { AllRoutesReadinessEvidence } from "./readiness-evaluator.js";
import type { RuntimeFailure } from "./errors.js";
import type { OpaqueFrameRenderer } from "./opaque-frame-renderer.js";
import type {
  BrowserOpaqueCandidateControls,
  BrowserOpaqueCandidateSnapshot,
  BrowserOpaqueReadPixelsResult,
  BrowserOpaquePlaybackSnapshot,
  BrowserOpaqueRendererSnapshot,
  BrowserOpaqueWorkerSnapshot
} from "./browser-opaque-candidate-contracts.js";
import { RUNTIME_TRACE_CAPACITY } from "./model.js";
import type { BrowserProductionReadinessReport } from "./browser-production-readiness-evidence.js";

export interface BrowserTrackedWorker {
  settled(): Promise<void>;
  snapshot(): Readonly<BrowserOpaqueWorkerSnapshot>;
  induceFailure(): void;
}

export interface BrowserTrackedRenderer {
  readonly renderer: OpaqueFrameRenderer;
  snapshot(): Readonly<BrowserOpaqueRendererSnapshot>;
}

export interface BrowserTrackedPlayback {
  settled(): Promise<void>;
  snapshot(): Readonly<BrowserOpaquePlaybackSnapshot>;
}

/** Shared instrumentation/control plane; it never owns candidate resources. */
export class BrowserOpaqueCandidateHub
  implements BrowserOpaqueCandidateControls {
  readonly #canvas: HTMLCanvasElement;
  readonly #diagnosticsSink: ((failure: Readonly<RuntimeFailure>) => void) | null;
  readonly #candidateOrder: Array<{
    readonly id: string;
    readonly area: number;
    readonly peakBitrate: number;
  }> = [];
  readonly #candidateIds = new Set<string>();
  readonly #workers: BrowserTrackedWorker[] = [];
  readonly #renderers: BrowserTrackedRenderer[] = [];
  readonly #diagnostics: Readonly<RuntimeFailure>[] = [];
  readonly #operations = new Set<Promise<unknown>>();

  #activeRendition: string | null = null;
  #readiness: Readonly<ReadinessRunnerResult> | null = null;
  #readinessEvidence: Readonly<AllRoutesReadinessEvidence> | null = null;
  #productionReadiness: Readonly<BrowserProductionReadinessReport> | null = null;
  #playback: BrowserTrackedPlayback | null = null;

  public constructor(
    canvas: HTMLCanvasElement,
    diagnosticsSink?: (failure: Readonly<RuntimeFailure>) => void
  ) {
    this.#canvas = canvas;
    this.#diagnosticsSink = diagnosticsSink ?? null;
  }

  public registerCandidate(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): void {
    const rendition = context.candidate.rendition;
    if (this.#candidateIds.has(rendition.id)) return;
    this.#candidateIds.add(rendition.id);
    this.#candidateOrder.push(Object.freeze({
      id: rendition.id,
      area: checkedProduct(rendition.codedWidth, rendition.codedHeight),
      peakBitrate: rendition.bitrate.peak
    }));
  }

  public registerWorker(worker: BrowserTrackedWorker): void {
    this.#pruneResources();
    this.#workers.push(worker);
  }

  public registerRenderer(renderer: BrowserTrackedRenderer): void {
    this.#pruneResources();
    this.#renderers.push(renderer);
  }

  public activate(
    rendition: string,
    playback: BrowserTrackedPlayback
  ): void {
    this.#activeRendition = rendition;
    this.#playback = playback;
  }

  public deactivate(playback: BrowserTrackedPlayback): void {
    if (this.#playback !== playback) return;
    this.#playback = null;
    this.#activeRendition = null;
  }

  public observeReadiness(result: Readonly<ReadinessRunnerResult>): void {
    this.#readiness = result;
  }

  public observeReadinessEvidence(
    evidence: Readonly<AllRoutesReadinessEvidence>
  ): void {
    this.#readinessEvidence = evidence;
  }

  public observeProductionReadiness(
    report: Readonly<BrowserProductionReadinessReport>
  ): void {
    this.#productionReadiness = report;
  }

  public diagnose(failure: Readonly<RuntimeFailure>): void {
    this.#diagnostics.push(failure);
    if (this.#diagnostics.length > RUNTIME_TRACE_CAPACITY) {
      this.#diagnostics.splice(
        0,
        this.#diagnostics.length - RUNTIME_TRACE_CAPACITY
      );
    }
    try {
      this.#diagnosticsSink?.(failure);
    } catch {
      // Diagnostics are observational and cannot break playback/recovery.
    }
  }

  public track<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  public async settled(): Promise<void> {
    for (;;) {
      const operations = [...this.#operations];
      const workers = this.#workers.map((worker) => worker.settled());
      const playback = this.#playback?.settled() ?? Promise.resolve();
      await Promise.all([...operations, ...workers, playback]);
      if (this.#operations.size === 0) {
        this.#pruneResources();
        return;
      }
    }
  }

  public induceWorkerFailure(): void {
    const worker = [...this.#workers].reverse().find((candidate) =>
      candidate.snapshot().alive
    );
    if (worker === undefined) {
      throw new Error("no live browser decoder worker can be failed");
    }
    worker.induceFailure();
  }

  public readPixels(): Readonly<BrowserOpaqueReadPixelsResult> {
    const tracked = [...this.#renderers].reverse().find(({ renderer }) =>
      renderer.snapshot().state === "active"
    );
    if (tracked === undefined) {
      throw new Error("no active browser renderer is available for readback");
    }
    return Object.freeze({
      rgba: tracked.renderer.readPixels(),
      width: this.#canvas.width,
      height: this.#canvas.height
    });
  }

  public snapshot(): Readonly<BrowserOpaqueCandidateSnapshot> {
    this.#pruneResources();
    const workerSnapshots = this.#workers.map((worker) => worker.snapshot());
    const rendererSnapshots = this.#renderers.map((renderer) =>
      renderer.snapshot()
    );
    const worker = workerSnapshots.at(-1) ?? emptyWorkerSnapshot();
    const renderer = rendererSnapshots.at(-1) ?? emptyRendererSnapshot();
    const playback = this.#playback?.snapshot() ?? emptyPlaybackSnapshot();
    const workersAlive = workerSnapshots.filter(({ alive }) => alive).length;
    const openFrames = workerSnapshots.reduce(
      (sum, value) => sum + value.openFrames,
      0
    );
    const renderersAlive = rendererSnapshots.filter(({ backendAlive }) =>
      backendAlive
    ).length;
    const glResourceCount = rendererSnapshots.reduce(
      (sum, value) => sum + value.glResourceCount,
      0
    );
    const pendingOperations = this.#operations.size +
      workerSnapshots.reduce(
        (sum, value) => sum + value.pendingRequests + value.pendingWaiters,
        0
      ) + playback.pendingPromises + playback.pendingCallbacks;
    return Object.freeze({
      candidateOrder: Object.freeze([...this.#candidateOrder]),
      activeRendition: this.#activeRendition,
      readiness: Object.freeze({
        policy: "all-routes" as const,
        passed: this.#readiness?.passed ?? null,
        evaluation: this.#readiness?.evaluation ?? null,
        evidence: this.#readinessEvidence,
        production: this.#productionReadiness
      }),
      worker,
      renderer,
      playback,
      cleanup: Object.freeze({
        workersAlive,
        openFrames,
        renderersAlive,
        glResourceCount,
        pendingOperations,
        complete:
          workersAlive === 0 &&
          openFrames === 0 &&
          renderersAlive === 0 &&
          glResourceCount === 0 &&
          pendingOperations === 0
      }),
      diagnostics: Object.freeze([...this.#diagnostics])
    });
  }

  #pruneResources(): void {
    pruneToLiveAndLatest(
      this.#workers,
      (worker) => worker.snapshot().alive
    );
    pruneToLiveAndLatest(
      this.#renderers,
      (renderer) => renderer.snapshot().backendAlive
    );
  }
}

function pruneToLiveAndLatest<T>(
  values: T[],
  isLive: (value: T) => boolean
): void {
  let latestRetired = -1;
  const live = values.map((value, index) => {
    const result = isLive(value);
    if (!result) latestRetired = index;
    return result;
  });
  const retained = values.filter((_, index) =>
    live[index] === true || index === latestRetired
  );
  values.splice(0, values.length, ...retained);
}

function emptyWorkerSnapshot(): Readonly<BrowserOpaqueWorkerSnapshot> {
  return Object.freeze({
    metrics: null,
    openFrames: 0,
    pendingRequests: 0,
    pendingWaiters: 0,
    alive: false
  });
}

function emptyRendererSnapshot(): Readonly<BrowserOpaqueRendererSnapshot> {
  return Object.freeze({
    snapshot: null,
    backendAlive: false,
    glResourceCount: 0
  });
}

function emptyPlaybackSnapshot(): Readonly<BrowserOpaquePlaybackSnapshot> {
  return Object.freeze({
    scheduler: null,
    cut: null,
    reversible: null,
    pendingCallbacks: 0,
    pendingPromises: 0,
    readbackTags: Object.freeze([])
  });
}

function checkedProduct(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("browser candidate area exceeds the safe range");
  }
  return value;
}
