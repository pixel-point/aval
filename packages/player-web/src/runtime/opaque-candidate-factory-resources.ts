import { DecodeTimeline } from "./decode-timeline.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  IntegratedCandidateActivationOptions,
  IntegratedCandidateAttemptContext
} from "./integrated-player-contracts.js";
import { createInteractionCachePlan } from "./interaction-cache-plan.js";
import { createOpaqueCandidateWorkerSetup } from "./opaque-candidate-factory-config.js";
import type {
  OpaqueCandidateCachePreparer,
  OpaqueCandidateFactoryOptions,
  OpaqueCandidatePreparedMedia,
  OpaqueCandidateReadinessSession,
  OpaqueCandidateRendererReservation,
  OpaqueCandidateWorker
} from "./opaque-candidate-factory-model.js";
import {
  OpaqueCandidateOperationControl,
  raceOpaqueCandidateOperation
} from "./opaque-candidate-factory-support.js";
import {
  opaqueCandidateFailureContext,
  opaquePhaseFailure,
  requireOpaqueOwner,
  runOpaqueResourcePhase,
  stoppedOrOpaquePhaseFailure,
  validateOpaqueCandidateRenderer,
  validateOpaqueCandidateWorker,
  validateOpaquePreparedMedia,
  validateOpaqueReadinessSession,
  validateOpaqueRendererReservation
} from "./opaque-candidate-factory-validation.js";
import { OpaqueFrameRenderer } from "./opaque-frame-renderer.js";
import { PathScheduler, type PathSchedulerClock } from "./path-scheduler.js";
import { runAllRoutesReadiness } from "./readiness-runner.js";
import {
  MAX_RESOURCE_RING_CAPACITY,
  createRuntimeResourcePlan,
  type RuntimeResourcePlan
} from "./resource-plan.js";
import { WorkerSampleFactory } from "./worker-samples.js";

/** Partial-resource owner used by exactly one candidate attempt. */
export class OpaqueCandidateResources {
  readonly #context: Readonly<IntegratedCandidateAttemptContext>;
  readonly #options: Readonly<OpaqueCandidateFactoryOptions>;
  readonly #clock: PathSchedulerClock;
  readonly #prepareCache: OpaqueCandidateCachePreparer;
  readonly #acquireWorker: () => void;
  readonly #releaseWorker: () => void;

  #workerLease = false;
  #worker: OpaqueCandidateWorker | null = null;
  #reservation: OpaqueCandidateRendererReservation | null = null;
  #renderer: OpaqueFrameRenderer | null = null;
  #timeline: DecodeTimeline | null = null;
  #samples: WorkerSampleFactory | null = null;
  #readiness: OpaqueCandidateReadinessSession | null = null;
  #scheduler: PathScheduler | null = null;
  #finalResourcePlan: Readonly<RuntimeResourcePlan> | null = null;
  #preparedMedia: OpaqueCandidatePreparedMedia | null = null;
  #disposePromise: Promise<void> | null = null;

  public constructor(options: {
    readonly context: Readonly<IntegratedCandidateAttemptContext>;
    readonly factoryOptions: Readonly<OpaqueCandidateFactoryOptions>;
    readonly clock: PathSchedulerClock;
    readonly prepareCache: OpaqueCandidateCachePreparer;
    readonly acquireWorker: () => void;
    readonly releaseWorker: () => void;
  }) {
    this.#context = options.context;
    this.#options = options.factoryOptions;
    this.#clock = options.clock;
    this.#prepareCache = options.prepareCache;
    this.#acquireWorker = options.acquireWorker;
    this.#releaseWorker = options.releaseWorker;
  }

  public async prepare(control: OpaqueCandidateOperationControl): Promise<void> {
    const setup = runOpaqueResourcePhase(
      () => createOpaqueCandidateWorkerSetup(this.#context),
      this.#context
    );
    control.throwIfStopped();

    this.#acquireWorker();
    this.#workerLease = true;
    const worker = this.#options.workerFactory.create(this.#context);
    this.#worker = worker;
    validateOpaqueCandidateWorker(worker);
    await this.#runWorkerOperation(
      () => worker.configure(setup.configure),
      control
    );

    const reservation = this.#options.rendererFactory.create(this.#context);
    this.#reservation = reservation;
    validateOpaqueRendererReservation(reservation);
    control.throwIfStopped();

    const interactionCache = runOpaqueResourcePhase(
      () => createInteractionCachePlan({
        manifest: this.#context.catalog.manifest,
        rendition: this.#context.candidate.rendition.id,
        deviceLimits: reservation.limits
      }),
      this.#context
    );
    const provisionalResourcePlan = runOpaqueResourcePhase(
      () => this.#createResourcePlan(
        interactionCache,
        MAX_RESOURCE_RING_CAPACITY
      ),
      this.#context
    );
    control.throwIfStopped();

    let renderer: OpaqueFrameRenderer;
    try {
      renderer = reservation.allocate(Object.freeze({
        codedWidth: this.#context.candidate.rendition.codedWidth,
        codedHeight: this.#context.candidate.rendition.codedHeight,
        logicalWidth: this.#context.catalog.manifest.canvas.width,
        logicalHeight: this.#context.catalog.manifest.canvas.height,
        residentLayerCount: interactionCache.layerCount
      }));
    } catch (error) {
      throw opaquePhaseFailure("renderer-failure", error, this.#context);
    }
    this.#renderer = renderer;
    validateOpaqueCandidateRenderer(renderer);

    const timeline = new DecodeTimeline(this.#context.catalog.manifest.frameRate);
    const samples = new WorkerSampleFactory({
      catalog: this.#context.catalog,
      timeline,
      rendition: this.#context.candidate.rendition.id,
      limits: setup.limits
    });
    this.#timeline = timeline;
    this.#samples = samples;
    const generation = timeline.activateNextGeneration();
    await this.#runWorkerOperation(
      () => worker.activateGeneration(generation),
      control
    );

    try {
      await raceOpaqueCandidateOperation(
        this.#prepareCache(
          {
            plan: interactionCache,
            catalog: this.#context.catalog,
            samples,
            worker,
            renderer,
            limits: setup.limits
          },
          {
            signal: control.signal,
            timeoutMs: control.remainingMs()
          }
        ),
        control.signal
      );
    } catch (error) {
      throw stoppedOrOpaquePhaseFailure(
        control,
        "worker-decode-failure",
        error,
        this.#context
      );
    }
    control.throwIfStopped();

    let readiness: OpaqueCandidateReadinessSession;
    try {
      readiness = this.#options.readinessFactory.create(Object.freeze({
        context: this.#context,
        worker,
        renderer,
        interactionCache,
        provisionalResourcePlan,
        timeline,
        samples,
        limits: setup.limits,
        clock: this.#clock,
        signal: control.signal,
        deadlineMs: control.deadlineMs
      }));
    } catch (error) {
      throw opaquePhaseFailure("readiness-failure", error, this.#context);
    }
    this.#readiness = readiness;
    validateOpaqueReadinessSession(readiness);
    const result = await raceOpaqueCandidateOperation(
      runAllRoutesReadiness({
        manifest: this.#context.catalog.manifest,
        graph: this.#context.catalog.graph,
        adapters: readiness.adapters
      }),
      control.signal
    );
    readiness.observeResult?.(result);
    control.throwIfStopped();
    if (!result.passed || result.evaluation === null) {
      throw new RuntimePlaybackError(
        result.failure ?? normalizeRuntimeFailure(
          "readiness-failure",
          "all-routes readiness did not produce a passing evaluation",
          opaqueCandidateFailureContext(this.#context)
        )
      );
    }

    const ringCapacity = result.evaluation.ringCapacity;
    const finalResourcePlan = runOpaqueResourcePhase(
      () => this.#createResourcePlan(interactionCache, ringCapacity),
      this.#context
    );
    const scheduler = new PathScheduler({
      timeline,
      samples,
      worker,
      rendition: this.#context.candidate.rendition.id,
      ringCapacity,
      limits: setup.limits,
      clock: this.#clock
    });
    this.#finalResourcePlan = finalResourcePlan;
    this.#scheduler = scheduler;
    control.throwIfStopped();
  }

  public async prepareActivation(
    options: Readonly<IntegratedCandidateActivationOptions>,
    control: OpaqueCandidateOperationControl
  ): Promise<OpaqueCandidatePreparedMedia> {
    const readiness = requireOpaqueOwner(this.#readiness, "readiness session");
    const scheduler = requireOpaqueOwner(this.#scheduler, "path scheduler");
    const finalResourcePlan = requireOpaqueOwner(
      this.#finalResourcePlan,
      "final resource plan"
    );
    let prepared: OpaqueCandidatePreparedMedia;
    try {
      prepared = await raceOpaqueCandidateOperation(
        readiness.prepareActivation(Object.freeze({
          graphSnapshot: options.graphSnapshot,
          expectedPresentation: options.expectedPresentation,
          scheduler,
          finalResourcePlan,
          signal: control.signal,
          deadlineMs: control.deadlineMs
        })),
        control.signal
      );
    } catch (error) {
      throw stoppedOrOpaquePhaseFailure(
        control,
        "readiness-failure",
        error,
        this.#context
      );
    }
    this.#preparedMedia = prepared;
    validateOpaquePreparedMedia(prepared);
    control.throwIfStopped();
    return prepared;
  }

  public drawInitial(): void {
    requireOpaqueOwner(
      this.#preparedMedia,
      "prepared initial media"
    ).drawInitial();
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise === null) {
      // Assign before injected disposers can run and re-enter this owner.
      this.#disposePromise = Promise.resolve().then(
        async () => this.#disposeResources()
      );
    }
    return this.#disposePromise;
  }

  async #runWorkerOperation(
    operation: () => Promise<void>,
    control: OpaqueCandidateOperationControl
  ): Promise<void> {
    try {
      await raceOpaqueCandidateOperation(
        Promise.resolve().then(operation),
        control.signal
      );
      control.throwIfStopped();
    } catch (error) {
      throw stoppedOrOpaquePhaseFailure(
        control,
        "worker-decode-failure",
        error,
        this.#context
      );
    }
  }

  #createResourcePlan(
    interactionCache: Parameters<typeof createRuntimeResourcePlan>[0]["interactionCache"],
    ringCapacity: number
  ): Readonly<RuntimeResourcePlan> {
    return createRuntimeResourcePlan({
      catalog: this.#context.catalog,
      rendition: this.#context.candidate.rendition.id,
      interactionCache,
      ringCapacity,
      ...(this.#context.hostMaxRuntimeBytes === null
        ? {}
        : { hostMaxRuntimeBytes: this.#context.hostMaxRuntimeBytes })
    });
  }

  async #disposeResources(): Promise<void> {
    let firstError: unknown = null;
    const clean = async (operation: () => unknown): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        if (firstError === null) firstError = error;
      }
    };

    const prepared = this.#preparedMedia;
    this.#preparedMedia = null;
    if (prepared !== null && typeof prepared.dispose === "function") {
      await clean(() => prepared.dispose());
    }

    const readiness = this.#readiness;
    this.#readiness = null;
    if (readiness !== null && typeof readiness.dispose === "function") {
      await clean(() => readiness.dispose());
    }

    const scheduler = this.#scheduler;
    this.#scheduler = null;
    if (scheduler !== null) await clean(() => scheduler.dispose());

    const renderer = this.#renderer;
    this.#renderer = null;
    if (renderer !== null) {
      await clean(() => renderer.dispose());
      await clean(() => renderer.settled());
    }

    const reservation = this.#reservation;
    this.#reservation = null;
    if (reservation !== null && typeof reservation.dispose === "function") {
      await clean(() => reservation.dispose());
    }

    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null && typeof worker.dispose === "function") {
      await clean(() => worker.dispose());
    }
    if (this.#workerLease) {
      this.#workerLease = false;
      this.#releaseWorker();
    }
    this.#timeline = null;
    this.#samples = null;
    this.#finalResourcePlan = null;

    if (firstError !== null) throw firstError;
  }
}
