import {
  MotionGraphEngine,
  type GraphPresentation
} from "@rendered-motion/graph";
import { expect } from "vitest";

import type {
  DecoderWorkerConfigureOptions,
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import type {
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import {
  installRuntimeAssetCatalog,
  type RuntimeAssetCatalog
} from "./asset-catalog.js";
import { createIntegratedOpaqueTestAsset } from "./asset-test-fixture.js";
import type {
  IntegratedCandidateAttemptContext,
  IntegratedPlaybackSession,
  IntegratedPlaybackTickContext,
  IntegratedPlaybackTraceState,
  IntegratedPreparedContentTick
} from "./integrated-player-contracts.js";
import { createIntegratedActivationPresentation } from "./integrated-player-support.js";
import type {
  InteractionCachePreparationInput,
  InteractionCachePreparationReport
} from "./interaction-cache-preparation.js";
import type {
  OpaqueCandidateActivationInput,
  OpaqueCandidateFactoryOptions,
  OpaqueCandidatePreparedMedia,
  OpaqueCandidateReadinessSession,
  OpaqueCandidateReadinessSessionInput,
  OpaqueCandidateRendererReservation,
  OpaqueCandidateTimerHost,
  OpaqueCandidateWorker
} from "./opaque-candidate-factory.js";
import {
  OpaqueFrameRenderer,
  type OpaqueFrameRendererBackend,
  type OpaqueFrameTextureLayout,
  type OpaqueTextureKind
} from "./opaque-frame-renderer.js";
import { passingMeasurements } from "./readiness-test-fixture.js";
import type { ReadinessRunnerAdapters } from "./readiness-runner.js";
import {
  createOpaqueRenditionCandidates,
  inspectOpaqueRenditionCandidate
} from "./rendition-selection.js";

export type PhaseMode =
  | "success"
  | "configure-failure"
  | "configure-pending"
  | "renderer-failure"
  | "cache-failure"
  | "cache-pending"
  | "readiness-failure"
  | "readiness-pending"
  | "activation-failure"
  | "activation-pending";

const openCatalogs = new Set<RuntimeAssetCatalog>();

export function disposeOpaqueCandidateTestCatalogs(): void {
  for (const catalog of openCatalogs) catalog.dispose();
  openCatalogs.clear();
}

export interface CandidateContexts {
  readonly high: Readonly<IntegratedCandidateAttemptContext>;
  readonly low: Readonly<IntegratedCandidateAttemptContext>;
}

export function createContexts(hostMaxRuntimeBytes: number | null = null): CandidateContexts {
  const catalog = installRuntimeAssetCatalog(createIntegratedOpaqueTestAsset());
  openCatalogs.add(catalog);
  const graph = new MotionGraphEngine();
  graph.install(catalog.graph);
  const graphSnapshot = graph.snapshot();
  const candidates = createOpaqueRenditionCandidates(catalog.renditions.values());
  const contexts = candidates.map((candidate) => {
    const inspected = inspectOpaqueRenditionCandidate(catalog, candidate);
    if (!inspected.ok) throw new Error("test candidate inspection failed");
    return Object.freeze({
      catalog,
      candidate,
      inspection: inspected.inspection,
      graphSnapshot,
      hostMaxRuntimeBytes
    });
  });
  const high = contexts[0];
  const low = contexts[1];
  if (high === undefined || low === undefined) {
    throw new Error("integrated fixture did not produce two candidates");
  }
  return { high, low };
}

export function operationOptions(): { readonly signal: AbortSignal; readonly deadlineMs: number } {
  return { signal: new AbortController().signal, deadlineMs: 1_000 };
}

export function activationPresentation(
  context: Readonly<IntegratedCandidateAttemptContext>
): Readonly<GraphPresentation> {
  return createIntegratedActivationPresentation(
    context.catalog.graph,
    context.graphSnapshot
  );
}

export function createDependencies(
  tracker: LeakTracker,
  timers = new ManualTimers()
): { readonly options: Readonly<OpaqueCandidateFactoryOptions> } {
  return {
    options: {
      workerFactory: {
        available: true,
        create: (context) => new FakeWorker(
          tracker,
          context.candidate.rendition.id,
          tracker.mode(context.candidate.rendition.id)
        )
      },
      rendererFactory: {
        available: true,
        create: (context) => new FakeRendererReservation(
          tracker,
          context.candidate.rendition.id,
          tracker.mode(context.candidate.rendition.id)
        )
      },
      readinessFactory: {
        create: (input) => new FakeReadinessSession(
          tracker,
          input,
          tracker.mode(input.context.candidate.rendition.id)
        )
      },
      clock: { now: () => timers.now },
      timers,
      prepareCache: async (input, options) => {
        tracker.cacheInputs.push(input);
        tracker.order.push(`cache:prepare:${input.plan.rendition}`);
        const mode = tracker.mode(input.plan.rendition);
        if (mode === "cache-failure") {
          throw new Error("injected cache failure");
        }
        if (mode === "cache-pending") {
          tracker.order.push("pending:cache");
          return await never<Readonly<InteractionCachePreparationReport>>();
        }
        if (options?.signal?.aborted === true) throw options.signal.reason;
        return cacheReport(input.worker.activeGeneration ?? 1);
      }
    }
  };
}

export class LeakTracker {
  public workerAlive = 0;
  public maximumWorkersAlive = 0;
  public reservationAlive = 0;
  public rendererAlive = 0;
  public readinessAlive = 0;
  public preparedAlive = 0;
  public rendererAllocations = 0;
  public readinessDisposals = 0;
  public preparedDisposals = 0;
  public workerAborts = 0;
  public initialDraws = 0;
  public readinessWarmupCalls = 0;
  public initialRingCalls = 0;
  public readonly order: string[] = [];
  public readonly configurations: Readonly<DecoderWorkerConfigureOptions>[] = [];
  public readonly workerActivations: number[] = [];
  public readonly cacheInputs: Readonly<InteractionCachePreparationInput>[] = [];
  public readonly readinessInputs: Readonly<OpaqueCandidateReadinessSessionInput>[] = [];
  public readonly activationInputs: Readonly<OpaqueCandidateActivationInput>[] = [];
  readonly #modes: Readonly<Record<string, PhaseMode>>;

  public constructor(options: {
    readonly modes?: Readonly<Record<string, PhaseMode>>;
  } = {}) {
    this.#modes = options.modes ?? {};
  }

  public mode(rendition: string): PhaseMode {
    return this.#modes[rendition] ?? "success";
  }

  public expectZeroLeaks(): void {
    expect({
      worker: this.workerAlive,
      reservation: this.reservationAlive,
      renderer: this.rendererAlive,
      readiness: this.readinessAlive,
      prepared: this.preparedAlive
    }).toEqual({
      worker: 0,
      reservation: 0,
      renderer: 0,
      readiness: 0,
      prepared: 0
    });
  }
}

class FakeWorker implements OpaqueCandidateWorker {
  public activeGeneration: number | null = null;
  public readonly queuedFrames = 0;
  public readonly openFrames = 0;
  readonly #tracker: LeakTracker;
  readonly #rendition: string;
  readonly #mode: PhaseMode;
  #disposed = false;

  public constructor(tracker: LeakTracker, rendition: string, mode: PhaseMode) {
    this.#tracker = tracker;
    this.#rendition = rendition;
    this.#mode = mode;
    tracker.workerAlive += 1;
    tracker.maximumWorkersAlive = Math.max(
      tracker.maximumWorkersAlive,
      tracker.workerAlive
    );
    tracker.order.push(`worker:create:${rendition}`);
  }

  public async configure(options: DecoderWorkerConfigureOptions): Promise<void> {
    this.#tracker.configurations.push(options);
    this.#tracker.order.push(`worker:configure:${this.#rendition}`);
    if (this.#mode === "configure-failure") {
      throw new Error("injected configure failure");
    }
    if (this.#mode === "configure-pending") {
      this.#tracker.order.push("pending:configure");
      await never<void>();
    }
  }

  public async activateGeneration(generation: number): Promise<void> {
    this.activeGeneration = generation;
    this.#tracker.workerActivations.push(generation);
    this.#tracker.order.push(
      `worker:activate:${this.#rendition}:${String(generation)}`
    );
  }

  public async submit(
    _generation: number,
    _samples: readonly DecoderWorkerSample[]
  ): Promise<void> {}

  public async abortGeneration(generation: number): Promise<void> {
    this.#tracker.workerAborts += 1;
    if (this.activeGeneration === generation) this.activeGeneration = null;
  }

  public takeFrame(): ManagedDecoderWorkerFrame | undefined {
    return undefined;
  }

  public async waitForFrames(
    _minimum?: number,
    _options?: DecoderWorkerWaitOptions
  ): Promise<void> {}

  public async snapshotMetrics(): Promise<DecoderWorkerMetrics> {
    return workerMetrics(this.activeGeneration, this.#disposed);
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.activeGeneration = null;
    this.#tracker.workerAlive -= 1;
    this.#tracker.order.push(`worker:dispose:${this.#rendition}`);
  }
}

class FakeRendererReservation implements OpaqueCandidateRendererReservation {
  public readonly limits = Object.freeze({
    maxTextureSize: 4_096,
    maxArrayTextureLayers: 256
  });
  readonly #tracker: LeakTracker;
  readonly #rendition: string;
  readonly #mode: PhaseMode;
  #disposed = false;

  public constructor(tracker: LeakTracker, rendition: string, mode: PhaseMode) {
    this.#tracker = tracker;
    this.#rendition = rendition;
    this.#mode = mode;
    tracker.reservationAlive += 1;
    tracker.order.push(`reservation:create:${rendition}`);
  }

  public allocate(layout: Readonly<OpaqueFrameTextureLayout>): OpaqueFrameRenderer {
    this.#tracker.rendererAllocations += 1;
    if (this.#mode === "renderer-failure") {
      throw new Error("injected renderer failure");
    }
    return new OpaqueFrameRenderer(
      new FakeRendererBackend(this.#tracker, this.#rendition),
      layout
    );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tracker.reservationAlive -= 1;
    this.#tracker.order.push(`reservation:dispose:${this.#rendition}`);
  }
}

class FakeRendererBackend implements OpaqueFrameRendererBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 4_096,
    maxArrayTextureLayers: 256
  });
  readonly #tracker: LeakTracker;
  readonly #rendition: string;
  #disposed = false;

  public constructor(tracker: LeakTracker, rendition: string) {
    this.#tracker = tracker;
    this.#rendition = rendition;
    tracker.rendererAlive += 1;
    tracker.order.push(`renderer:create:${rendition}`);
  }

  public allocate(_layout: OpaqueFrameTextureLayout, _slots: number): void {}
  public upload(_kind: OpaqueTextureKind, _index: number, _pixels: Uint8Array): void {}
  public draw(_kind: OpaqueTextureKind, _index: number): void {}

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tracker.rendererAlive -= 1;
    this.#tracker.order.push(`renderer:dispose:${this.#rendition}`);
  }
}

class FakeReadinessSession implements OpaqueCandidateReadinessSession {
  public readonly adapters: Readonly<ReadinessRunnerAdapters>;
  readonly #tracker: LeakTracker;
  readonly #input: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly #mode: PhaseMode;
  #disposed = false;

  public constructor(
    tracker: LeakTracker,
    input: Readonly<OpaqueCandidateReadinessSessionInput>,
    mode: PhaseMode
  ) {
    this.#tracker = tracker;
    this.#input = input;
    this.#mode = mode;
    tracker.readinessAlive += 1;
    tracker.readinessInputs.push(input);
    tracker.order.push(
      `readiness:create:${input.context.candidate.rendition.id}`
    );
    this.adapters = this.#createAdapters();
  }

  public async prepareActivation(
    input: Readonly<OpaqueCandidateActivationInput>
  ): Promise<OpaqueCandidatePreparedMedia> {
    this.#tracker.activationInputs.push(input);
    if (this.#mode === "activation-failure") {
      throw new Error("injected activation failure");
    }
    if (this.#mode === "activation-pending") {
      this.#tracker.order.push("pending:activation");
      return await never<OpaqueCandidatePreparedMedia>();
    }
    return new FakePreparedMedia(this.#tracker, input);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tracker.readinessAlive -= 1;
    this.#tracker.readinessDisposals += 1;
  }

  #createAdapters(): Readonly<ReadinessRunnerAdapters> {
    const measurements = passingMeasurements("warmup", "idle-body");
    const adapters: ReadinessRunnerAdapters = {
      measureWarmup: async () => {
        this.#tracker.readinessWarmupCalls += 1;
        if (this.#mode === "readiness-pending") {
          this.#tracker.order.push("pending:readiness");
          return await never<{ readonly measurements: typeof measurements }>();
        }
        return { measurements };
      },
      measureLoop: ({ ringCapacity }) => ({
        seamReady: true,
        availableHeadroomFrames: ringCapacity
      }),
      dryRunEdge: ({ ringCapacity, targetProbeFrames, edge }) => ({
        measurements: passingMeasurements(edge.id, edge.transition?.unitId ?? "body"),
        availableConsecutiveFrames: ringCapacity,
        transitionFrames: edge.transition?.frameCount ?? 0,
        targetProbeFrames,
        sequenceFrameCount: (edge.transition?.frameCount ?? 0) + targetProbeFrames,
        completeSequence: true,
        deadlineSafe: true,
        withinBudget: true
      }),
      prepareCut: ({ manifestEdge }) => ({
        runwayPrepared: true,
        responseFrames: 1,
        runwayFrames: manifestEdge.targetRunwayFrames ?? 6,
        continuationFrame: manifestEdge.targetRunwayFrames ?? 6,
        recoveryFrames: (manifestEdge.targetRunwayFrames ?? 6) - 1,
        deadlineSafe: true,
        withinBudget: true
      }),
      prepareEndpoint: ({ ringCapacity }) => ({
        runwayPrepared: true,
        runwayFrames: ringCapacity,
        continuationFrame: ringCapacity,
        recoveryFrames: ringCapacity - 1,
        deadlineSafe: true,
        withinBudget: true
      }),
      simulateRoutePhases: () => ({
        pendingCancellationReady: true,
        pendingReplacementReady: true,
        prospectiveTargetReady: true,
        lockedFollowOnReady: true
      }),
      measureActiveInverse: () => ({
        responseFrames: 1,
        adjacentFrame: true
      }),
      measureResource: () => ({
        passed: true,
        totalBytes: this.#input.provisionalResourcePlan.totalBytes,
        capBytes: this.#input.provisionalResourcePlan.effectiveCapBytes
      }),
      fillInitialRing: ({ ringCapacity }) => {
        this.#tracker.initialRingCalls += 1;
        return {
          passed: this.#mode !== "readiness-failure",
          frameCount: this.#mode === "readiness-failure" ? 0 : ringCapacity
        };
      }
    };
    return Object.freeze(adapters);
  }
}

class FakePreparedMedia implements OpaqueCandidatePreparedMedia {
  public readonly playback: IntegratedPlaybackSession;
  readonly #tracker: LeakTracker;
  #disposed = false;

  public constructor(
    tracker: LeakTracker,
    input: Readonly<OpaqueCandidateActivationInput>
  ) {
    this.#tracker = tracker;
    this.playback = new FakePlayback(input);
    tracker.preparedAlive += 1;
  }

  public drawInitial(): void {
    this.#tracker.initialDraws += 1;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tracker.preparedAlive -= 1;
    this.#tracker.preparedDisposals += 1;
  }
}

class FakePlayback implements IntegratedPlaybackSession {
  readonly #input: Readonly<OpaqueCandidateActivationInput>;

  public constructor(input: Readonly<OpaqueCandidateActivationInput>) {
    this.#input = input;
  }

  public prepareContentTick(
    _context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    return null;
  }

  public drawContentTick(
    _prepared: Readonly<IntegratedPreparedContentTick>,
    _presentation: Readonly<GraphPresentation>
  ): string | null {
    return null;
  }

  public synchronizeGraph(): void {}

  public traceState(): Readonly<IntegratedPlaybackTraceState> {
    return Object.freeze({
      scheduler: this.#input.scheduler.snapshot(),
      submitted: Object.freeze([]),
      selectedBoundary: null,
      decodeLeadFrames: null
    });
  }
}

export class ManualTimers implements OpaqueCandidateTimerHost {
  #next = 1;
  readonly #callbacks = new Map<
    number,
    { readonly callback: () => void; readonly dueMs: number }
  >();
  public now = 0;

  public get size(): number {
    return this.#callbacks.size;
  }

  public setTimeout(callback: () => void, milliseconds: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.#callbacks.set(handle, {
      callback,
      dueMs: this.now + milliseconds
    });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#callbacks.delete(handle);
  }

  public fireAll(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const entry of callbacks) {
      this.now = Math.max(this.now, entry.dueMs);
      entry.callback();
    }
  }
}

function workerMetrics(
  activeGeneration: number | null,
  disposed: boolean
): DecoderWorkerMetrics {
  return {
    configureCalls: 1,
    resetCalls: 0,
    flushCalls: 0,
    boundaryFlushCalls: 0,
    acceptedSamples: 0,
    submittedChunks: 0,
    outputFrames: 0,
    deliveredFrames: 0,
    releasedFrames: 0,
    staleFrames: 0,
    closedFrames: 0,
    pendingSamples: 0,
    submittedFrames: 0,
    leasedFrames: 0,
    leasedDecodedBytes: 0,
    decodeQueueSize: 0,
    activeGeneration,
    nextSubmissionOrdinal: 0,
    nextOutputOrdinal: 0,
    errors: 0,
    disposed
  };
}

function cacheReport(
  generation: number
): Readonly<InteractionCachePreparationReport> {
  return Object.freeze({
    generation,
    resourceGeneration: 1,
    unitOccurrences: 0,
    submittedFrames: 0,
    decodedFrames: 0,
    uploadedFrames: 0,
    dependencyFramesClosed: 0,
    staleFrames: 0,
    releasedFrames: 0
  });
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("test phase did not become pending");
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}
